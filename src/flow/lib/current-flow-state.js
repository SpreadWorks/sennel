/**
 * The next-generation Flow state foundation.
 *
 * This module deliberately has no dependency on the retired root-level
 * retired mutable state storage. Production callers enter through CurrentFlowVersionStore (or
 * CanonicalFlowRuntime), which owns the canonical Version-1 root and this
 * schema-bound state machine.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtomicFile } from "../../lib/atomic-file.js";
import { isGitSnapshot } from "../../lib/git-snapshot.js";
import { FileLock } from "../../lib/file-lock.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";
import { AuthoritativeSpecRecord, FlowActivityId, FlowArtifactCatalog, FlowArtifactCatalogStore, FlowArtifactDescriptor, FlowId, FlowRunId, FlowSpecIdentity, FlowSpecRevision, FlowVersionId, FlowVersionLocation, FlowVersionMigrationOutput, FlowVersionMigrationOutputBuilder, FlowVersionMigrationOutputSet, FlowVersionRuntimeLockLocation, FlowVersionSemanticValidator } from "../../lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactActivityEvidence, FlowArtifactUpdater } from "../../lib/flow-artifact-contract.js";
import { CanonicalSpecReview, initialCanonicalSpecReview } from "./spec-review-artifacts.js";
import {
  artifactPublicationClaimForStep,
  requiresWorkerSourceHandoff,
  sourceWorkerUpgradePublicationClaimForStep,
} from "./flow-artifact-authority.js";
import {
  isPlanGateRepairEligibleFailure,
  planGateRepairRouteForTargetStep,
} from "./plan-gate-repair.js";
import { DefinitionFailureOwnership } from "./definition-failure-ownership.js";
import { validateUpgradeResultArtifact } from "./upgrade-result-artifact.js";
import { StepConnectionReceipt as DraftStepConnectionReceipt } from "./draft-completion-connector.js";
import { TestReviewRepairWorkerTimeout } from "./test-review-repair-timeout.js";
import {
  TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION,
  TaskGateClassificationRecoveryIdentity,
} from "./task-gate-classification-recovery.js";
import {
  TaskReviewStageTransitionPlan,
  taskReviewStagePlanFromJSON,
} from "./task-review-stage-transition.js";
import { TaskStepIdentity } from "./task-step-identity.js";

/**
 * The production Flow Version 1 record.  This is deliberately independent
 * from result-format versions and from the definition that supplies runtime
 * behaviour.  `flow.json` is the sole persisted identity authority.
 */
export const CURRENT_FLOW_SCHEMA_REVISION = 3;
// `version` is the result-generation version persisted in flow.json.  It is
// intentionally independent from the structural schemaRevision above.
export const CURRENT_FLOW_RESULT_VERSION = 1;

const NODE_KINDS = new Set(["flow", "step", "task"]);
const NODE_STATUSES = new Set(["pending", "in_progress", "done", "skipped", "failed", "invalidated", "archived"]);
const EXECUTION_MODES = new Set(["direct", "branch", "worktree"]);
const LIFECYCLE_STATES = new Set(["active", "parked", "finalized"]);
const RESULT_OUTCOMES = new Set(["passed", "failed", "skipped", "incomplete"]);
const RETRY_KINDS = new Set(["semantic", "tooling"]);
const FAILURE_POLICIES = new Set(["retry", "retry-block", "record", "amend-spec", "block", "step-definition", "test-chain-retry", "test-chain-repair"]);
const RECORDING_FAILURE_POLICIES = new Set(["retry", "record", "step-definition"]);
const ATTEMPT_TYPES = new Set([
  "flow_created",
  "task_added",
  "attempt_started",
  "attempt_retried",
  "attempt_recovered",
  "attempt_updated",
  "attempt_failed",
  "failure_recorded",
  "result_confirmed",
  "recovery",
  "flow_parked",
  "flow_resumed",
  "flow_finalized",
  "policy_updated",
  "artifacts_published",
  "spec_record_updated",
  "outbox_started",
  "outbox_reopened",
  "outbox_completed",
  "outbox_failed",
  "dispatch_approval_recorded",
  "metric_recorded",
  "note_recorded",
  "nonblocking_recorded",
  "failure_accepted",
  "finalization_downstream_updated",
]);
const TRANSITION_ATTEMPT_OPERATIONS = new Set([
  "recover_interrupted_finalize_sync",
  "start_attempt",
  "retry_attempt",
  "retry_gate_attempt",
  "retry_recovery_attempt",
  "update_attempt",
  TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION,
  "rewind",
  "rewind_test_evidence",
  "repair_test_review",
  "settle_test_review_repair_timeout",
  "repair_scenario_validity",
  "repair_implementation",
  "triage_implementation_for_repair",
  "triage_implementation_no_repair",
  "repair_acceptance_review",
  "preimplementation_bootstrap",
  "recover_existing_implementation",
  "reopen_draft_preimplementation",
  "reopen_draft_task_addition",
  "reopen_draft_spec_correction",
  "plan_gate_repair",
  "recover_attempt",
  "recover_missing_producer_artifact",
  "recover_task_execution_overrun",
  "accept_final_regression_failure",
  "defer_failed_review",
  "defer_failed_gate",
  "advance_task_review_stage",
]);
const DRAFT_COMPLETION_TRANSITION_OPERATION = "complete_draft_completion";
const TASK_REVIEW_STAGE_TRANSITION_OPERATION = "complete_task_review_stage";
const REPLACEMENT_ATTEMPT_OPERATIONS = new Set(["repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "recover_missing_producer_artifact", "defer_failed_review", "defer_failed_gate", "advance_task_review_stage"]);
const SOURCE_WORKER_COMPLETION_OPERATIONS = new Set([
  "confirm_attempt",
  "repair_implementation",
  "triage_implementation_for_repair",
  "triage_implementation_no_repair",
]);
const FLOW_CREATION_TRANSITION_OPERATION = "create_flow";
const FLOW_CREATION_ACTIVITY_TYPE = "flow_created";
const LIFECYCLE_TRANSITION_OPERATIONS = new Set(["park_flow", "resume_flow", "finalize_flow"]);
// Policy is authoritative flow state.  Its mutations use the same journal as
// lifecycle and Attempt transitions; a command must never patch flow.json.
const POLICY_TRANSITION_OPERATIONS = new Set(["set_policy"]);
// Publishing a producer-owned durable artifact is an Activity in its own
// right. It does not alter the lifecycle tree, but it must share the state
// journal and catalog transaction with the descriptor that makes the bytes
// consumable. `update_spec_record` is deliberately separate from generic
// artifact publication: its bytes are validated by CurrentFlowSpecRecord and
// may only be produced by the dedicated typed Store API.
const ARTIFACT_PUBLICATION_TRANSITION_OPERATIONS = new Set([
  "publish_artifacts",
  "publish_plugin_artifacts",
  "publish_upgrade_result",
  "update_spec_record",
]);
// flow.json retains only outstanding side effects. Their successful and
// failed outcomes belong to the append-only Activity ledger, so a restart
// cannot mistake historical work for another active operation.
const OUTBOX_TRANSITION_OPERATIONS = new Set(["begin_outbox", "reopen_outbox", "complete_outbox", "fail_outbox"]);
const INTERRUPTED_FINALIZE_SYNC_OPERATION = "recover_interrupted_finalize_sync";
const ATTEMPT_INTRODUCTION_OPERATIONS = new Set(["start_attempt", "retry_attempt", "retry_gate_attempt", "retry_recovery_attempt", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "advance_task_review_stage", INTERRUPTED_FINALIZE_SYNC_OPERATION]);
// Explicit dispatch approval is a durable authorization fact, not a mutable
// field on flow.json.  Its append-only Activity can be replayed and checked
// against the exact action digest on a later dispatcher process.
const DISPATCH_APPROVAL_TRANSITION_OPERATIONS = new Set(["record_dispatch_approval"]);
// A normal Task insertion closes as soon as the definition-owned suffix is
// invalidated.  Approval continuation is the sole exception: its dedicated
// Activity may replay Task admission after one of these definition-owned
// planning recovery routes.  The Activity operation is itself durable, while
// the preceding recovery Activity supplies the route authority.
const APPROVAL_TASK_ADMISSION_RECOVERY_OPERATIONS = new Set([
  "plan_gate_repair",
  "reopen_draft_preimplementation",
  "reopen_draft_task_addition",
  "reopen_draft_spec_correction",
]);
const FLOW_SUFFIX_INVALIDATION_OPERATIONS = new Set([
  "rewind",
  "rewind_test_evidence",
  "repair_scenario_validity",
  "repair_test_review",
  "repair_implementation",
  "repair_acceptance_review",
  ...APPROVAL_TASK_ADMISSION_RECOVERY_OPERATIONS,
  "recover_missing_producer_artifact",
]);
// Metrics and notes are durable observations, not fields on flow.json.  Their
// append-only home is the same Activity ledger that records every state
// transition, which preserves a single recovery and ordering mechanism.
const OBSERVATION_TRANSITION_OPERATIONS = new Set(["record_metric", "record_note"]);
// Advisory policy evidence is a first-class ledger fact.  It deliberately
// stays out of flow.json so a resumed Flow replays the same immutable
// observation/decision history rather than a mutable side-channel.
const NONBLOCKING_TRANSITION_OPERATIONS = new Set(["record_nonblocking", "continue_nonblocking"]);
const FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS = new Set(["skip_finalize_downstream", "reset_finalize_downstream"]);
const STATE_CHANGING_TRANSITION_OPERATIONS = new Set([
  "create_flow", "complete_draft_completion", "add_task", "add_approval_task", "start_attempt",
  "retry_attempt", "retry_gate_attempt", "retry_recovery_attempt", "update_attempt", "fail_attempt",
  "record_failure", "confirm_attempt", "complete_acceptance_decision_noop", "rewind", "rewind_test_evidence",
  "repair_test_review", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair",
  "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap",
  "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition",
  "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact",
  "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "recover_interrupted_finalize_sync",
  "park_flow", "resume_flow", "finalize_flow", "set_policy", "publish_artifacts", "publish_plugin_artifacts",
  "publish_upgrade_result", "update_spec_record", "begin_outbox", "reopen_outbox", "complete_outbox",
  "fail_outbox", "record_dispatch_approval", "skip_finalize_downstream", "reset_finalize_downstream",
  "continue_nonblocking",
]);
export const AGGREGATE_METRIC_PROVENANCE = Object.freeze({
  activityCount: "confirmed-activity-prefix",
  artifactCount: "canonical-artifact-catalog",
  stepCount: "canonical-state",
  taskCount: "canonical-state",
  durationMs: "activity-timing-durationMs",
  inputTokens: "activity-usage-inputTokens",
  outputTokens: "activity-usage-outputTokens",
  cacheReadTokens: "activity-usage-cacheReadTokens",
  cost: "activity-usage-cost",
});

function resolvedArtifact(logicalKey, parameters = {}) {
  return FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
}

function descriptorFor(location, logicalKey, mediaType, activityId = null, parameters = {}) {
  const artifact = resolvedArtifact(logicalKey, parameters);
  return FlowArtifactDescriptor.fromFile({ location, ...artifact.publication({ mediaType, activityId }) });
}

function publicationFor(logicalKey, mediaType, { updater = null, activityId = null } = {}) {
  return resolvedArtifact(logicalKey).publication({ mediaType, updater, activityId });
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * One durable payload that is committed with its owning Activity and catalog
 * descriptor.  Commands pass this value object to the Version Store instead
 * of guessing a path under a Spec directory.  The Store supplies the updater
 * from the Activity node, so producers cannot claim another Step's slot.
 */
export class CanonicalFlowArtifactWrite {
  constructor({ logicalKey, parameters = {}, mediaType, bytes } = {}) {
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical artifact parameters must be an object");
    }
    this.artifact = resolvedArtifact(requireString(logicalKey, "canonical artifact logicalKey"), parameters);
    if (["flow.state", "flow.activities", "artifact.catalog"].includes(this.artifact.logicalKey)) {
      throw new CurrentFlowStateInvariantError("canonical state and catalog authorities are Store-owned");
    }
    if (!this.artifact.contract.cataloged) {
      throw new CurrentFlowStateInvariantError(
        "transient artifacts must use CanonicalFlowRuntimeArtifactWrite rather than the cataloged Store boundary",
      );
    }
    this.mediaType = requireString(mediaType, "canonical artifact mediaType");
    if (typeof bytes === "string") this.bytes = Buffer.from(bytes, "utf8");
    else if (Buffer.isBuffer(bytes)) this.bytes = Buffer.from(bytes);
    else throw new CurrentFlowStateInvariantError("canonical artifact bytes must be a string or Buffer");
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof CanonicalFlowArtifactWrite
      || value instanceof CanonicalFlowReviewEvidenceWrite
      || value instanceof CanonicalFlowActivityEvidenceWrite) {
      return value;
    }
    if (value?.logicalKey === "review.evidence") return new CanonicalFlowReviewEvidenceWrite(value);
    if (value?.logicalKey === "activity.evidence") return new CanonicalFlowActivityEvidenceWrite(value);
    return new CanonicalFlowArtifactWrite(value);
  }

  publication(activity) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("canonical artifact publication requires a typed FlowActivity");
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString();
    return this.artifact.publication({
      mediaType: this.mediaType,
      updater,
      activityId: FlowActivityId.from(activity.id),
    });
  }

  write(location) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical artifact write requires a FlowVersionLocation");
    }
    const target = location.resolve(this.artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    return new AtomicFile(target, { phaseNamespace: "canonical-flow-artifact" }).write(this.bytes);
  }
}

/**
 * The catalog value observed for one artifact before a canonical transition
 * is persisted. The Version Store compares it while holding the catalog
 * publication lock, so unrelated artifacts may change while the observed
 * artifact retains compare-and-swap semantics.
 */
export class CanonicalFlowArtifactBaseline {
  constructor({ logicalKey, parameters = {}, digest = null, byteLength = 0 } = {}) {
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline parameters must be an object");
    }
    this.artifact = resolvedArtifact(requireString(logicalKey, "canonical artifact baseline logicalKey"), parameters);
    if (["flow.state", "flow.activities", "artifact.catalog"].includes(this.artifact.logicalKey)) {
      throw new CurrentFlowStateInvariantError("canonical Store authorities cannot be artifact baselines");
    }
    if (!this.artifact.contract.cataloged) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline must target cataloged storage");
    }
    if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline digest must be null or a SHA-256 digest");
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || (digest === null && byteLength !== 0)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline byteLength is invalid");
    }
    this.digest = digest;
    this.byteLength = byteLength;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalFlowArtifactBaseline
      ? value
      : new CanonicalFlowArtifactBaseline(value);
  }

  assertCatalog(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline requires a FlowArtifactCatalog");
    }
    const actual = catalog.artifacts.find((entry) => entry.relativePath === this.artifact.relativePath) ?? null;
    const unchanged = this.digest === null
      ? actual === null
      : actual !== null
        && actual.logicalKey === this.artifact.logicalKey
        && actual.hash === this.digest
        && actual.size === this.byteLength;
    if (!unchanged) {
      throw new CurrentFlowStateConflictError(
        `canonical artifact changed after baseline capture: ${this.artifact.relativePath}`,
      );
    }
  }
}

/**
 * The dispatcher-owned publication of source-worker upgrade evidence.  The
 * bytes originate in a sealed handoff payload, but the only Store route that
 * accepts this value is a source Attempt confirmation.
 */
export class CanonicalSourceWorkerUpgradeResult {
  constructor({ bytes } = {}) {
    if (!Buffer.isBuffer(bytes)) {
      throw new CurrentFlowStateInvariantError("source worker upgrade result bytes must be a Buffer");
    }
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`source worker upgrade result must be JSON: ${cause.message}`);
    }
    const validation = validateUpgradeResultArtifact(document);
    if (!validation.ok) {
      throw new CurrentFlowStateInvariantError(`source worker upgrade result is invalid: ${validation.reason}`);
    }
    if (document.dryRun === true) {
      throw new CurrentFlowStateInvariantError("source worker upgrade result must record a materialized upgrade");
    }
    this.artifact = resolvedArtifact("upgrade.result");
    this.mediaType = "application/json";
    this.bytes = Buffer.from(bytes);
    Object.freeze(this);
  }

  publication(activity) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("source worker upgrade publication requires a typed FlowActivity");
    }
    // `upgrade.result` remains system-owned in the contract. The specialized
    // parent claim below authorizes this exact mixed-source transaction.
    return this.artifact.publication({
      mediaType: this.mediaType,
      activityId: FlowActivityId.from(activity.id),
    });
  }

  write(location) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("source worker upgrade write requires a FlowVersionLocation");
    }
    const target = location.resolve(this.artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    return new AtomicFile(target, { phaseNamespace: "source-worker-upgrade-result" }).write(this.bytes);
  }
}

/**
 * A typed removal from the one worker-owned test-source collection.  Test
 * handoff replaces a complete declared test tree, so retaining catalog
 * descriptors for files omitted from the new tree would create false
 * consumer authority.  Other durable artifacts are never removed through
 * this narrow production operation.
 */
export class CanonicalFlowArtifactRemoval {
  constructor({ logicalKey, parameters = {} } = {}) {
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical artifact removal parameters must be an object");
    }
    this.artifact = resolvedArtifact(requireString(logicalKey, "canonical artifact removal logicalKey"), parameters);
    if (this.artifact.logicalKey !== "tests.source") {
      throw new CurrentFlowStateInvariantError("canonical artifact removal supports only worker-owned test sources");
    }
    if (!this.artifact.contract.cataloged) {
      throw new CurrentFlowStateInvariantError("canonical artifact removal requires a cataloged artifact");
    }
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalFlowArtifactRemoval
      ? value
      : new CanonicalFlowArtifactRemoval(value);
  }

  removal(activity) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("canonical artifact removal requires a typed FlowActivity");
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString();
    if (updater !== "test") {
      throw new CurrentFlowStateInvariantError("only the test Step may remove worker-owned test sources");
    }
    return Object.freeze({
      logicalKey: this.artifact.logicalKey,
      relativePath: this.artifact.relativePath,
    });
  }

  remove(location) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical artifact removal requires a FlowVersionLocation");
    }
    const target = location.resolve(this.artifact.relativePath);
    return new AtomicFile(target, { phaseNamespace: "canonical-flow-artifact-removal" }).remove();
  }
}

/**
 * The catalog snapshot guarded by a complete worker test-tree replacement.
 *
 * Test handoff is the sole producer that replaces a collection rather than
 * one named artifact.  Keeping its precondition as a value object at the
 * Store boundary makes the check part of the same catalog lock that writes
 * the next tree and removes stale members; callers cannot race a separately
 * read directory or silently turn a full replacement into a partial merge.
 */
export class CanonicalFlowTestSourceBaseline {
  constructor(entries = []) {
    if (!Array.isArray(entries)) {
      throw new CurrentFlowStateInvariantError("canonical test-source baseline must be an array");
    }
    this.entries = Object.freeze(entries.map((entry) => {
      if (!isPlainObject(entry)) {
        throw new CurrentFlowStateInvariantError("canonical test-source baseline entry must be an object");
      }
      const workerPath = requireString(entry.targetRelativePath, "canonical test-source baseline targetRelativePath")
        .replaceAll("\\", "/");
      if (
        !workerPath.startsWith("tests/")
        || workerPath.length === "tests/".length
        || path.posix.normalize(workerPath) !== workerPath
        || workerPath.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new CurrentFlowStateInvariantError("canonical test-source baseline target must be below tests/");
      }
      const artifact = resolvedArtifact("tests.source", { testPath: workerPath.slice("tests/".length) });
      const hash = requireString(entry.digest, "canonical test-source baseline digest");
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        throw new CurrentFlowStateInvariantError("canonical test-source baseline digest must be a SHA-256 digest");
      }
      const size = requirePositiveInteger(entry.byteLength, "canonical test-source baseline byteLength", { allowZero: true });
      return Object.freeze({ relativePath: artifact.relativePath, hash, size });
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
    if (new Set(this.entries.map((entry) => entry.relativePath)).size !== this.entries.length) {
      throw new CurrentFlowStateInvariantError("canonical test-source baseline must not duplicate a source");
    }
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalFlowTestSourceBaseline
      ? value
      : new CanonicalFlowTestSourceBaseline(value);
  }

  /** Assert that the requested writes/removals really describe one full tree. */
  assertReplacement(activity, writes, removals) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("canonical test-source baseline requires a typed FlowActivity");
    }
    if (FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString() !== "test") {
      throw new CurrentFlowStateInvariantError("only the test Step may replace the worker-owned test-source collection");
    }
    const written = new Set(writes
      .filter((entry) => entry.artifact.logicalKey === "tests.source")
      .map((entry) => entry.artifact.relativePath));
    const removed = new Set(removals.map((entry) => entry.artifact.relativePath));
    for (const entry of this.entries) {
      if (!written.has(entry.relativePath) && !removed.has(entry.relativePath)) {
        throw new CurrentFlowStateInvariantError(
          `canonical test-source replacement omits baseline source: ${entry.relativePath}`,
        );
      }
    }
    for (const relativePath of removed) {
      if (!this.entries.some((entry) => entry.relativePath === relativePath)) {
        throw new CurrentFlowStateInvariantError(
          `canonical test-source replacement removes a source absent from its baseline: ${relativePath}`,
        );
      }
    }
  }

  /** Compare the complete collection while FlowArtifactCatalogStore holds its lock. */
  assertCatalog(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new CurrentFlowStateInvariantError("canonical test-source baseline requires a FlowArtifactCatalog");
    }
    const actual = catalog.artifacts
      .filter((entry) => entry.logicalKey === "tests.source")
      .map((entry) => Object.freeze({ relativePath: entry.relativePath, hash: entry.hash, size: entry.size }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (
      actual.length !== this.entries.length
      || actual.some((entry, index) => (
        entry.relativePath !== this.entries[index].relativePath
        || entry.hash !== this.entries[index].hash
        || entry.size !== this.entries[index].size
      ))
    ) {
      throw new CurrentFlowStateConflictError("canonical worker test-source collection changed after handoff capture");
    }
  }
}

/**
 * Immutable review evidence has a typed owner+digest address rather than the
 * generic parameterized artifact spelling.  Keeping it separate prevents a
 * review step from publishing evidence below another producer's directory.
 */
export class CanonicalFlowReviewEvidenceWrite {
  constructor({ logicalKey, reviewStep = null, taskId = null, digest, mediaType, bytes } = {}) {
    if (logicalKey !== "review.evidence") {
      throw new CurrentFlowStateInvariantError("canonical review evidence logicalKey must be review.evidence");
    }
    this.artifact = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep, taskId, digest });
    this.mediaType = requireString(mediaType, "canonical review evidence mediaType");
    if (typeof bytes === "string") this.bytes = Buffer.from(bytes, "utf8");
    else if (Buffer.isBuffer(bytes)) this.bytes = Buffer.from(bytes);
    else throw new CurrentFlowStateInvariantError("canonical review evidence bytes must be a string or Buffer");
    Object.freeze(this);
  }

  publication(activity) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("canonical review evidence publication requires a typed FlowActivity");
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString();
    if (updater !== this.artifact.publicationStep()) {
      throw new CurrentFlowStateInvariantError(
        `canonical review evidence producer does not own this evidence path: ${updater}`,
      );
    }
    return this.artifact.publication({
      mediaType: this.mediaType,
      updater,
      activityId: FlowActivityId.from(activity.id),
    });
  }

  write(location) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical review evidence write requires a FlowVersionLocation");
    }
    const target = location.resolve(this.artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    return new AtomicFile(target, { phaseNamespace: "canonical-review-evidence" }).write(this.bytes);
  }
}

/**
 * An immutable, non-review observation published under the exact owner of a
 * Flow Activity.  This is a normal Store artifact write, not a migration
 * escape hatch: callers supply a typed document whose id/node identity is
 * checked again by the catalog when the ledger is read.
 */
export class CanonicalFlowActivityEvidenceWrite {
  constructor({ artifact, mediaType, bytes } = {}) {
    if (!(artifact instanceof FlowArtifactActivityEvidence)) {
      throw new CurrentFlowStateInvariantError("canonical activity evidence requires a typed Activity evidence artifact");
    }
    this.artifact = artifact;
    this.mediaType = requireString(mediaType, "canonical activity evidence mediaType");
    if (typeof bytes === "string") this.bytes = Buffer.from(bytes, "utf8");
    else if (Buffer.isBuffer(bytes)) this.bytes = Buffer.from(bytes);
    else throw new CurrentFlowStateInvariantError("canonical activity evidence bytes must be a string or Buffer");
    // Parse at the public boundary so malformed evidence never reaches a
    // state journal or a partially published catalog tree.
    this.document = this.artifact.contract.contentContract.parse(this.bytes);
    Object.freeze(this);
  }

  publication(activity) {
    if (!(activity instanceof FlowActivity)) {
      throw new CurrentFlowStateInvariantError("canonical activity evidence publication requires a typed FlowActivity");
    }
    if (activity.nodeId !== this.artifact.owner.nodeId
      || activity.nodeKey !== this.document.owner.nodeKey
      || this.document.owner.nodeId !== activity.nodeId
      || this.document.activityId !== activity.id) {
      throw new CurrentFlowStateInvariantError("canonical activity evidence document must bind its owning Activity identity");
    }
    return this.artifact.publication({
      mediaType: this.mediaType,
      updater: this.artifact.owner.publicationStep,
      activityId: FlowActivityId.from(activity.id),
    });
  }

  write(location) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical activity evidence write requires a FlowVersionLocation");
    }
    const target = location.resolve(this.artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    return new AtomicFile(target, { phaseNamespace: "canonical-flow-activity-evidence" }).write(this.bytes);
  }
}

/**
 * A typed, non-authoritative runtime payload.  It is intentionally absent
 * from artifact-catalog.json, but a typed consumer may use its bytes as a
 * transient diagnostic observation.  The Version Store serializes those
 * observations with catalog publication, so a decision cannot race a raw
 * replacement between its admission and settlement.  The contract still
 * determines its path and producer, so callers never reconstruct `.runtime`
 * paths themselves.
 */
export class CanonicalFlowRuntimeArtifactWrite {
  constructor({ logicalKey, parameters = {}, mediaType, bytes } = {}) {
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact parameters must be an object");
    }
    this.artifact = resolvedArtifact(requireString(logicalKey, "canonical runtime artifact logicalKey"), parameters);
    if (this.artifact.contract.cataloged || this.artifact.contract.retention.toString() !== "transient") {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact must use a transient non-catalog contract");
    }
    this.mediaType = requireString(mediaType, "canonical runtime artifact mediaType");
    if (typeof bytes === "string") this.bytes = Buffer.from(bytes, "utf8");
    else if (Buffer.isBuffer(bytes)) this.bytes = Buffer.from(bytes);
    else throw new CurrentFlowStateInvariantError("canonical runtime artifact bytes must be a string or Buffer");
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalFlowRuntimeArtifactWrite
      ? value
      : new CanonicalFlowRuntimeArtifactWrite(value);
  }

  /** Raw evidence participates in a Definition decision and must remain Attempt-bound. */
  get requiresActiveAttempt() {
    return [
      "scenario-validity-log",
      "test-execute-log",
      "final-regression-log",
      "test-requirement-summary",
    ].includes(this.artifact.contract.authoritySlot.kind);
  }

  write(location, nodeId) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact write requires a FlowVersionLocation");
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(requireString(nodeId, "runtime artifact nodeId")).toString();
    const publication = this.artifact.publication({ mediaType: this.mediaType, updater });
    const target = location.resolve(this.artifact.relativePath);
    this.artifact.contract.assertPublicationRole({
      exists: fs.existsSync(target),
      publicationStep: publication.authoritySlot.publicationStep,
    });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    new AtomicFile(target, { phaseNamespace: "canonical-flow-runtime-artifact" }).write(this.bytes);
    return target;
  }
}

/** Immutable bytes read from one transient runtime contract. */
export class CanonicalFlowRuntimeArtifactObservation {
  constructor({ artifact, bytes } = {}) {
    if (artifact === null || typeof artifact !== "object" || !artifact.contract) {
      throw new CurrentFlowStateInvariantError("canonical runtime observation requires a resolved artifact contract");
    }
    if (!Buffer.isBuffer(bytes)) {
      throw new CurrentFlowStateInvariantError("canonical runtime observation requires bytes");
    }
    this.logicalKey = artifact.logicalKey;
    this.relativePath = artifact.relativePath;
    this.mediaType = artifact.contract.authoritySlot.kind === "test-execute-log"
      ? "text/plain"
      : "application/octet-stream";
    this.bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
}

/**
 * Shared runtime-reader boundary for public consumers and lock-scoped
 * transition views. The resolved contract owns path, retention, authority,
 * and consumer authorization; callers supply no filesystem path.
 */
export class CanonicalFlowRuntimeArtifactRead {
  constructor({ location, logicalKey, parameters = {}, consumerNodeId, optional = false } = {}) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact read requires a FlowVersionLocation");
    }
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact read parameters must be an object");
    }
    if (optional !== true && optional !== false) {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact optional must be boolean");
    }
    this.location = location;
    this.artifact = resolvedArtifact(requireString(logicalKey, "canonical runtime artifact logicalKey"), parameters);
    if (this.artifact.contract.cataloged || this.artifact.contract.retention.toString() !== "transient") {
      throw new CurrentFlowStateInvariantError("canonical runtime artifact read requires a transient non-catalog contract");
    }
    this.consumer = FlowArtifactUpdater.fromActivityNodeId(
      requireString(consumerNodeId, "canonical runtime artifact consumer nodeId"),
    ).toString();
    if (!this.artifact.contract.ownership.consumers.includes(this.consumer)) {
      throw new CurrentFlowStateInvariantError(
        `canonical runtime artifact consumer is not authorized: ${this.consumer}/${this.artifact.logicalKey}`,
      );
    }
    this.optional = optional;
    Object.freeze(this);
  }

  read() {
    const target = this.location.resolve(this.artifact.relativePath);
    if (!fs.existsSync(target)) {
      if (this.optional) return null;
      throw new CurrentFlowStateInvariantError(`canonical runtime artifact is absent: ${this.artifact.relativePath}`);
    }
    this.location.assertAuthority(this.artifact.relativePath, { mustExist: true });
    return new CanonicalFlowRuntimeArtifactObservation({
      artifact: this.artifact,
      bytes: Buffer.from(fs.readFileSync(target)),
    });
  }
}
const TERMINAL_NODE_STATUSES = new Set(["done", "skipped", "failed"]);
const AUTHORITATIVE_NODE_STATUSES = new Set(["done", "skipped"]);
const EXECUTABLE_NODE_STATUSES = new Set(["pending", "invalidated"]);
const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  "currentTaskId",
  "childId",
  "runtimeLog",
  "metrics",
  "notes",
  "stepAttempts",
  "workerArtifactReceipts",
  "reviewConvergence",
  "reviewRecoveryBaselines",
  "testReviewRepairHistory",
  "expandedPluginHooks",
  "hooks",
]);
const STATE_FIELDS = new Set([
  "schemaRevision",
  "flowId",
  "flowVersionId",
  "runId",
  "specId",
  "issue",
  "request",
  "version",
  "lifecycle",
  "execution",
  "policy",
  "kind",
  "id",
  "key",
  "status",
  "result",
  "attemptSequence",
  "steps",
  "current",
  "attempt",
  "confirmationOrder",
  "artifacts",
  "outbox",
  "context",
  "history",
]);
const NODE_FIELDS = new Set(["kind", "id", "key", "status", "result", "attemptSequence", "steps"]);
const JOURNAL_WRITER_AUTHORITY = Symbol("current-flow-state-store-writer");

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CurrentFlowStateInvariantError(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CurrentFlowStateInvariantError(`${field} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function nullableIssue(value, field) {
  if (value === null) return null;
  return requirePositiveInteger(value, field);
}

function requireIso(value, field) {
  requireString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new CurrentFlowStateInvariantError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function requireExactFields(value, fields, label) {
  if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError(`${label} must be an object`);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new CurrentFlowStateInvariantError(`${label}.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new CurrentFlowStateInvariantError(`${label} contains unsupported field: ${field}`);
  }
}

function rootNodeValue(value) {
  return Object.fromEntries([...NODE_FIELDS].map((field) => [field, value[field]]));
}

/**
 * Re-materialize the only state that may be persisted before any Activity.
 *
 * The definition owns the step graph, while the flow record owns its identity
 * and command-level inputs.  Keeping this in one place is important for
 * journal replay: reconstructing a fresh state must never silently invent a
 * second identity, request, or execution policy.
 */
function freshStateLike(state, definition) {
  if (!(state instanceof CurrentFlowState)) {
    throw new CurrentFlowStateInvariantError("fresh state reconstruction requires CurrentFlowState");
  }
  if (!(definition instanceof CurrentFlowDefinition)) {
    throw new CurrentFlowStateInvariantError("fresh state reconstruction requires CurrentFlowDefinition");
  }
  return CurrentFlowState.create({
    definition,
    execution: state.execution.toJSON(),
    version: state.version,
    ...state.identity.toJSON(),
    request: state.request,
    // Every journal starts from a live, unmodified Flow. Lifecycle changes
    // are Activities, so retaining the current lifecycle here would replay a
    // park/finalize transition twice.
    lifecycle: { state: "active" },
    policy: state.policy.toJSON(),
    artifacts: state.artifacts.toJSON(),
    outbox: state.outbox.toJSON(),
    context: state.context.toJSON(),
  });
}

function applyCanonicalActivity(state, activity, priorActivities = []) {
  const node = state.findNode(activity.nodeId);
  if (!node || node.key !== activity.nodeKey) {
    throw new CurrentFlowStateInvariantError("Activity must reference a current-state node by stable id and semantic key");
  }
  return activity.transition.apply(state, activity, { priorActivities }).withConfirmationOrder(activity.confirmationOrder);
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireStringList(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new CurrentFlowStateInvariantError(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new CurrentFlowStateInvariantError(`${field} must not contain duplicates`);
  }
  return Object.freeze([...value]);
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function nodeFromJSON(value) {
  requireExactFields(value, NODE_FIELDS, "node");
  if (!NODE_KINDS.has(value.kind)) throw new CurrentFlowStateInvariantError(`node.kind is invalid: ${value.kind}`);
  const Node = value.kind === "task" ? TaskNode : value.kind === "flow" ? FlowRootNode : StepNode;
  return new Node(value);
}

function replaceNode(root, nodeId, replacement) {
  if (root.id === nodeId) return replacement;
  const nextSteps = root.steps.map((step) => replaceNode(step, nodeId, replacement));
  if (nextSteps.every((step, index) => step === root.steps[index])) return root;
  return root.withSteps(nextSteps);
}

function transitionNode(node, status, definition, changes = {}) {
  if (node.status !== status && !definition.contractForNode(node).permits(node.status, status)) {
    throw new CurrentFlowStateInvariantError(
      `definition forbids transition ${node.status}:${status} for ${node.id}`,
    );
  }
  return node.with({ ...changes, status });
}

function reconcileInvalidatedParents(node, definition) {
  if (node.steps.length === 0) return node;
  const steps = node.steps.map((step) => reconcileInvalidatedParents(step, definition));
  const hasInvalidatedChild = steps.some((step) => step.status === "invalidated");
  if (hasInvalidatedChild) {
    return transitionNode(node, "invalidated", definition, { result: null, steps });
  }
  return node.withSteps(steps);
}

function reconcileCompletedParents(node, definition) {
  if (node.steps.length === 0) return node;
  const steps = node.steps.map((step) => reconcileCompletedParents(step, definition));
  if (
    definition.contractForNode(node).completion === "all_children_terminal"
    && steps.every((step) => TERMINAL_NODE_STATUSES.has(step.status))
  ) {
    const result = [...steps].reverse().find((step) => step.result != null)?.result ?? null;
    return transitionNode(node, "done", definition, { result, steps });
  }
  if (steps.some((step) => step.status === "in_progress")) {
    return transitionNode(node, "in_progress", definition, { steps });
  }
  return node.withSteps(steps);
}

function collectNodes(root, result = []) {
  result.push(root);
  for (const step of root.steps) collectNodes(step, result);
  return result;
}

function nodeAtPath(root, pathIds) {
  let current = root;
  if (pathIds[0] !== root.id) throw new CurrentFlowStateInvariantError("current.path must begin with root stable id");
  for (const id of pathIds.slice(1)) {
    current = current.steps.find((candidate) => candidate.id === id);
    if (!current) throw new CurrentFlowStateInvariantError("current.path must be a root-to-leaf parent-child path");
  }
  return current;
}

export class CurrentFlowStateInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "CurrentFlowStateInvariantError";
    this.code = "CURRENT_FLOW_STATE_INVARIANT_INVALID";
  }
}

export class CurrentFlowStateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "CurrentFlowStateConflictError";
    this.code = "CURRENT_FLOW_STATE_CONFLICT";
  }
}

/**
 * Typed catalog-lock admission for the approval-only Task insertion route.
 * It is intentionally separate from generic Task insertion: callers must
 * name this authority, and the resulting `add_approval_task` Activity is
 * replayed against the same recovery history before it can change state.
 */
function canonicalApprovalTaskDocument(value) {
  if (!isPlainObject(value)) {
    throw new CurrentFlowStateInvariantError("approval Task admission source Task must be an object");
  }
  const document = structuredClone(value);
  const id = requireString(document.id, "approval Task admission source Task.id");
  requireString(document.key ?? id, "approval Task admission source Task.key");
  delete document.key;
  document.id = id;
  document.parent ??= null;
  return Object.freeze(document);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function canonicalJsonDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

class ApprovalTaskSourceBinding {
  constructor(value = {}) {
    requireExactFields(
      value,
      new Set(["specRecordHash", "specRecordActivityId", "taskDigest", "taskKey", "taskDocument"]),
      "approval Task source",
    );
    const { specRecordHash, specRecordActivityId, taskDigest, taskKey, taskDocument } = value;
    for (const [field, value] of Object.entries({ specRecordHash, taskDigest })) {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new CurrentFlowStateInvariantError(`approval Task source ${field} must be a SHA-256 digest`);
      }
    }
    this.specRecordHash = specRecordHash;
    this.specRecordActivityId = requireString(
      specRecordActivityId,
      "approval Task source specRecordActivityId",
    );
    this.taskKey = requireString(taskKey, "approval Task source taskKey");
    this.taskDocument = canonicalApprovalTaskDocument(taskDocument);
    if (taskDigest !== canonicalJsonDigest(this.taskDocument)) {
      throw new CurrentFlowStateInvariantError("approval Task source digest does not match its Task document");
    }
    this.taskDigest = taskDigest;
    Object.freeze(this);
  }

  assertPriorActivities(activities) {
    if (!activities.some((activity) => activity.id === this.specRecordActivityId)) {
      throw new CurrentFlowStateInvariantError("approval Task source Activity is absent from the prior ledger");
    }
  }

  toJSON() {
    return {
      specRecordHash: this.specRecordHash,
      specRecordActivityId: this.specRecordActivityId,
      taskDigest: this.taskDigest,
      taskKey: this.taskKey,
      taskDocument: structuredClone(this.taskDocument),
    };
  }
}

export class ApprovalTaskAdmission {
  constructor({ sourceDescriptor, sourceTask } = {}) {
    this.sourceDescriptor = sourceDescriptor instanceof FlowArtifactDescriptor
      ? sourceDescriptor
      : new FlowArtifactDescriptor(sourceDescriptor);
    if (this.sourceDescriptor.logicalKey !== "spec.record") {
      throw new CurrentFlowStateInvariantError("approval Task admission source must be canonical spec.record");
    }
    this.canonicalTask = canonicalApprovalTaskDocument(sourceTask);
    this.sourceTask = Object.freeze(structuredClone(sourceTask));
    this.taskId = this.canonicalTask.id;
    this.taskKey = requireString(sourceTask.key ?? sourceTask.id, "approval Task admission source Task.key");
    this.activitySource = new ApprovalTaskSourceBinding({
      specRecordHash: this.sourceDescriptor.hash,
      specRecordActivityId: this.sourceDescriptor.activityId,
      taskDigest: canonicalJsonDigest(this.canonicalTask),
      taskKey: this.taskKey,
      taskDocument: this.canonicalTask,
    });
    Object.freeze(this);
  }

  assertTask({ task, taskSpec }) {
    if (!(task instanceof ActivityTask) || !isPlainObject(taskSpec)) {
      throw new CurrentFlowStateInvariantError("approval Task admission requires typed Activity and Spec Tasks");
    }
    if (task.id !== this.taskId || task.key !== this.taskKey
      || taskSpec.id !== this.taskId || (taskSpec.key ?? taskSpec.id) !== this.taskKey) {
      throw new CurrentFlowStateInvariantError("approval Task admission does not match its bound Spec Task");
    }
    if (!(task.approvalSource instanceof ApprovalTaskSourceBinding)
      || !isDeepStrictEqual(task.approvalSource.toJSON(), this.activitySource.toJSON())
      || !isDeepStrictEqual(canonicalApprovalTaskDocument(taskSpec), this.canonicalTask)) {
      throw new CurrentFlowStateInvariantError("approval Task admission Task document does not match its durable source binding");
    }
  }

  assert({ state, catalog, activities, readCatalogedArtifact }) {
    approvalTaskAdmissionRoute(state, activities);
    if (!(catalog instanceof FlowArtifactCatalog) || typeof readCatalogedArtifact !== "function") {
      throw new CurrentFlowStateInvariantError("approval Task admission requires the canonical artifact catalog");
    }
    const current = catalog.resolve(this.sourceDescriptor.relativePath);
    if (!isDeepStrictEqual(current.toJSON(), this.sourceDescriptor.toJSON())) {
      throw new CurrentFlowStateInvariantError("approval Task admission spec.record descriptor changed");
    }
    let specRecord;
    try {
      specRecord = CurrentFlowSpecRecord.from(
        JSON.parse(readCatalogedArtifact(current).toString("utf8")),
        { specId: state.specId },
      );
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`approval Task admission spec.record is invalid: ${cause.message}`);
    }
    const source = specRecord.task(this.taskId);
    if (source === null || !isDeepStrictEqual(source.document, this.sourceTask)) {
      throw new CurrentFlowStateInvariantError("approval Task admission source Task changed");
    }
  }
}

function approvalTaskAdmissionRoute(state, priorActivities) {
  if (!(state instanceof CurrentFlowState)) {
    throw new CurrentFlowStateInvariantError("approval Task admission requires a current Flow state");
  }
  if (!Array.isArray(priorActivities)) {
    throw new CurrentFlowStateInvariantError("approval Task admission requires an Activity ledger prefix");
  }
  if (state.current?.at(-1) !== "approval" || state.attempt === null) {
    throw new CurrentFlowStateInvariantError("approval Task admission requires the active approval Attempt");
  }
  if (state.definition.canAddTask(state.root)) return "fresh";
  const container = state.findNode(state.definition.dynamicTaskContainerId);
  if (container === null) throw new CurrentFlowStateInvariantError("dynamic Task container is missing");
  const insertionIndex = state.definition.taskInsertionIndex(container);
  const suffixLeaves = container.steps.slice(insertionIndex)
    .flatMap((node) => collectNodes(node).filter((candidate) => candidate.steps.length === 0));
  if (suffixLeaves.length === 0 || suffixLeaves.some((leaf) => leaf.status !== "invalidated")) {
    throw new CurrentFlowStateInvariantError("approval Task admission requires a pending or wholly invalidated definition-owned suffix");
  }
  const invalidation = [...priorActivities].reverse().find((activity) => (
    FLOW_SUFFIX_INVALIDATION_OPERATIONS.has(activity.transition.operation)
  )) ?? null;
  if (invalidation === null || !APPROVAL_TASK_ADMISSION_RECOVERY_OPERATIONS.has(invalidation.transition.operation)) {
    throw new CurrentFlowStateInvariantError("approval Task admission requires a definition-owned plan recovery route");
  }
  return invalidation.transition.operation;
}

/**
 * Immutable identity embedded in the canonical `flow.json` record.  Keeping
 * it here, rather than in a sibling identity file, makes every state read a
 * single-authority read and gives migration code the same serializer as the
 * normal runtime.
 */
export class CurrentFlowIdentity {
  constructor({ flowId, flowVersionId, runId, specId, issue = null } = {}) {
    this.flowId = FlowId.from(flowId);
    this.flowVersionId = FlowVersionId.from(flowVersionId);
    this.runId = FlowRunId.from(runId);
    this.specId = FlowSpecIdentity.from(specId);
    // The Issue number selects a Flow just like runId/specId.  The immutable
    // Issue body remains `issue.md`; retaining this nullable identity scalar
    // lets target selection survive restart without deriving identity from a
    // human-readable snapshot.
    this.issue = nullableIssue(issue, "issue");
    Object.freeze(this);
  }

  toJSON() {
    return {
      flowId: this.flowId.toJSON(),
      flowVersionId: this.flowVersionId.toJSON(),
      runId: this.runId.toJSON(),
      specId: this.specId.toJSON(),
      issue: this.issue,
    };
  }

  matchesLocation(location) {
    return location instanceof FlowVersionLocation
      && this.specId.equals(location.specId)
      && location.version.value === 1;
  }
}

function flowCreatedActivityId(identity) {
  if (!(identity instanceof CurrentFlowIdentity)) {
    throw new CurrentFlowStateInvariantError("flow creation Activity requires a typed Flow identity");
  }
  const identityDigest = crypto.createHash("sha256")
    .update(JSON.stringify(identity.toJSON()), "utf8")
    .digest("hex");
  return `flow-created-${identityDigest}`;
}

/** A narrow lifecycle value; completed state is not inferred from a path. */
export class CurrentFlowLifecycle {
  constructor(value) {
    requireExactFields(value, new Set(["state"]), "lifecycle");
    if (!LIFECYCLE_STATES.has(value.state)) {
      throw new CurrentFlowStateInvariantError(`lifecycle.state is invalid: ${value.state}`);
    }
    this.state = value.state;
    Object.freeze(this);
  }

  toJSON() { return { state: this.state }; }
}

/** Policy records user-selected execution policy only; definition policy stays external. */
export class CurrentFlowPolicy {
  constructor(value) {
    requireExactFields(value, new Set(["autoApprove", "nonblocking"]), "policy");
    if (typeof value.autoApprove !== "boolean") {
      throw new CurrentFlowStateInvariantError("policy.autoApprove must be boolean");
    }
    this.autoApprove = value.autoApprove;
    this.nonblocking = value.nonblocking == null
      ? null
      : new CurrentFlowNonBlockingPolicy(value.nonblocking);
    Object.freeze(this);
  }

  toJSON() { return { autoApprove: this.autoApprove, nonblocking: this.nonblocking?.toJSON() ?? null }; }
}

/** One-way advisory policy fact owned by the policy Activity. */
export class CurrentFlowNonBlockingPolicy {
  constructor(value) {
    requireExactFields(value, new Set(["enabled", "activatedAt", "activatedStep", "reason"]), "policy.nonblocking");
    if (value.enabled !== true) throw new CurrentFlowStateInvariantError("policy.nonblocking must be enabled");
    this.enabled = true;
    this.activatedAt = requireString(value.activatedAt, "policy.nonblocking.activatedAt");
    this.activatedStep = requireString(value.activatedStep, "policy.nonblocking.activatedStep");
    this.reason = requireString(value.reason, "policy.nonblocking.reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      enabled: true,
      activatedAt: this.activatedAt,
      activatedStep: this.activatedStep,
      reason: this.reason,
    };
  }
}

/**
 * Flow-level artifact references are catalog keys, never filesystem guesses.
 * Runtime-specific records remain in their dedicated artifacts or `.runtime`
 * namespaces and are not accumulated in flow.json history.
 */
export class CurrentFlowArtifacts {
  constructor(value) {
    if (!Array.isArray(value)) throw new CurrentFlowStateInvariantError("artifacts must be an array");
    this.values = Object.freeze(value.map((entry) => entry instanceof ArtifactReference ? entry : new ArtifactReference(entry)));
    const keys = this.values.map((entry) => `${entry.kind}\u0000${entry.id}`);
    if (new Set(keys).size !== keys.length) {
      throw new CurrentFlowStateInvariantError("artifacts must not contain duplicate catalog references");
    }
    Object.freeze(this);
  }

  toJSON() { return this.values.map((entry) => entry.toJSON()); }
}

/**
 * Only unfinished operation descriptors live in the state.  The actual
 * operation history belongs to the append-only Activity ledger.
 */
export class CurrentFlowOutbox {
  constructor(value) {
    if (!Array.isArray(value)) throw new CurrentFlowStateInvariantError("outbox must be an array");
    this.values = Object.freeze(value.map((entry) => (
      entry instanceof CurrentFlowOutboxEntry ? entry : new CurrentFlowOutboxEntry(entry)
    )));
    const ids = this.values.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) throw new CurrentFlowStateInvariantError("outbox entry ids must be unique");
    Object.freeze(this);
  }

  find(id) { return this.values.find((entry) => entry.id === id) ?? null; }

  begin(entry) {
    const next = entry instanceof CurrentFlowOutboxEntry ? entry : new CurrentFlowOutboxEntry(entry);
    const existing = this.find(next.id);
    if (existing !== null) {
      if (existing.operation !== next.operation) {
        throw new CurrentFlowStateInvariantError("outbox id cannot change its operation");
      }
      return this;
    }
    return new CurrentFlowOutbox([...this.values, next]);
  }

  settle(entry) {
    const expected = entry instanceof CurrentFlowOutboxEntry ? entry : new CurrentFlowOutboxEntry(entry);
    const existing = this.find(expected.id);
    if (existing === null) {
      throw new CurrentFlowStateInvariantError("outbox settlement requires an outstanding operation");
    }
    if (existing.operation !== expected.operation) {
      throw new CurrentFlowStateInvariantError("outbox settlement operation does not match its outstanding operation");
    }
    return new CurrentFlowOutbox(this.values.filter((candidate) => candidate.id !== expected.id));
  }

  toJSON() { return this.values.map((entry) => entry.toJSON()); }
}

/** The current-state representation of one unfinished side effect. */
export class CurrentFlowOutboxEntry {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("outbox entry must be an object");
    requireExactFields(value, new Set(["id", "operation"]), "outbox entry");
    this.id = requireString(value.id, "outbox entry.id");
    this.operation = requireString(value.operation, "outbox entry.operation");
    Object.freeze(this);
  }

  toJSON() { return { id: this.id, operation: this.operation }; }
}

/** Activity-owned facts for an outbox operation and its terminal outcome. */
export class ActivityOutbox {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("activity.outbox must be an object");
    requireExactFields(value, new Set([
      "id", "operation", "attempt", "result", "failure", "failureCode", "recovery", "exactRecoveryReceipt",
    ]), "activity.outbox");
    this.entry = new CurrentFlowOutboxEntry({ id: value.id, operation: value.operation });
    this.attempt = requirePositiveInteger(value.attempt, "activity.outbox.attempt");
    this.result = value.result === null ? null : new ActivityOutboxResult(value.result);
    if (value.failure !== null) requireString(value.failure, "activity.outbox.failure");
    this.failure = value.failure;
    if (value.failureCode !== null) {
      requireString(value.failureCode, "activity.outbox.failureCode");
      if (!/^[A-Z][A-Z0-9_]{2,199}$/.test(value.failureCode)) {
        throw new CurrentFlowStateInvariantError("activity.outbox.failureCode is invalid");
      }
    }
    this.failureCode = value.failureCode;
    this.recovery = value.recovery === null ? null : new ActivityOutboxRecovery(value.recovery);
    this.exactRecoveryReceipt = value.exactRecoveryReceipt === null
      ? null
      : new ActivityOutboxRecoveryReceipt(value.exactRecoveryReceipt);
    Object.freeze(this);
  }

  get id() { return this.entry.id; }
  get operation() { return this.entry.operation; }
  toEntry() { return this.entry; }
  toJSON() {
    return {
      ...this.entry.toJSON(),
      attempt: this.attempt,
      result: this.result?.toJSON() ?? null,
      failure: this.failure,
      failureCode: this.failureCode,
      recovery: this.recovery?.toJSON() ?? null,
      exactRecoveryReceipt: this.exactRecoveryReceipt?.toJSON() ?? null,
    };
  }
}

/** JSON command result retained by a terminal outbox Activity for restart-safe recovery. */
export class ActivityOutboxResult {
  constructor(value) {
    if (!isPlainObject(value)) {
      throw new CurrentFlowStateInvariantError("activity.outbox.result must be an object or null");
    }
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new CurrentFlowStateInvariantError(`activity.outbox.result must be JSON-serializable: ${error.message}`);
    }
    if (serialized === undefined) {
      throw new CurrentFlowStateInvariantError("activity.outbox.result must be JSON-serializable");
    }
    this.value = Object.freeze(JSON.parse(serialized));
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.value); }
}

/** Immutable merge pre-sync recovery evidence retained with an outbox failure. */
export class ActivityOutboxRecovery {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("activity.outbox.recovery must be an object");
    requireExactFields(value, new Set(["baseRef", "baseHead"]), "activity.outbox.recovery");
    this.baseRef = requireString(value.baseRef, "activity.outbox.recovery.baseRef");
    this.baseHead = requireString(value.baseHead, "activity.outbox.recovery.baseHead");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(this.baseHead)) {
      throw new CurrentFlowStateInvariantError("activity.outbox.recovery.baseHead must be a Git object id");
    }
    Object.freeze(this);
  }

  toJSON() { return { baseRef: this.baseRef, baseHead: this.baseHead }; }
}

/** The one recovery claim consumed when a failed outbox side effect reopens. */
export class ActivityOutboxRecoveryReceipt {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("activity.outbox.exactRecoveryReceipt must be an object");
    requireExactFields(value, new Set(["idempotencyKey", "attempt", "failure", "recoveryKey"]), "activity.outbox.exactRecoveryReceipt");
    this.idempotencyKey = requireString(value.idempotencyKey, "activity.outbox.exactRecoveryReceipt.idempotencyKey");
    this.attempt = requirePositiveInteger(value.attempt, "activity.outbox.exactRecoveryReceipt.attempt");
    this.failure = requireString(value.failure, "activity.outbox.exactRecoveryReceipt.failure");
    this.recoveryKey = value.recoveryKey === null
      ? null
      : requireString(value.recoveryKey, "activity.outbox.exactRecoveryReceipt.recoveryKey");
    Object.freeze(this);
  }

  toJSON() {
    return {
      idempotencyKey: this.idempotencyKey,
      attempt: this.attempt,
      failure: this.failure,
      recoveryKey: this.recoveryKey,
    };
  }
}

/** Immutable receipt for one explicit user authorization of a dispatch action. */
export class ActivityDispatchApproval {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("activity.dispatchApproval must be an object");
    requireExactFields(value, new Set(["version", "runId", "actionDigest", "approvalToken", "approvedAt"]), "activity.dispatchApproval");
    if (value.version !== 1) {
      throw new CurrentFlowStateInvariantError("activity.dispatchApproval.version must be exactly 1");
    }
    this.version = value.version;
    this.runId = requireString(value.runId, "activity.dispatchApproval.runId");
    for (const field of ["actionDigest", "approvalToken"]) {
      this[field] = requireString(value[field], `activity.dispatchApproval.${field}`);
      if (!/^[a-f0-9]{64}$/.test(this[field])) {
        throw new CurrentFlowStateInvariantError(`activity.dispatchApproval.${field} must be SHA-256`);
      }
    }
    this.approvedAt = requireIso(value.approvedAt, "activity.dispatchApproval.approvedAt");
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      actionDigest: this.actionDigest,
      approvalToken: this.approvalToken,
      approvedAt: this.approvedAt,
    };
  }
}

/**
 * Context is intentionally bounded to resumable command authority.  It is
 * nullable so a fresh Flow does not invent an execution context.
 */
export class CurrentFlowContext {
  constructor(value) {
    if (value !== null) {
      const fields = new Set(["operation", "resumeToken", "gitSnapshot"]);
      if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("context must be an object");
      const hasResumeContext = Object.hasOwn(value, "operation") || Object.hasOwn(value, "resumeToken");
      if (hasResumeContext && (!Object.hasOwn(value, "operation") || !Object.hasOwn(value, "resumeToken"))) {
        throw new CurrentFlowStateInvariantError("context.operation and context.resumeToken are required together");
      }
      for (const field of Object.keys(value)) {
        if (!fields.has(field)) throw new CurrentFlowStateInvariantError(`context contains unsupported field: ${field}`);
      }
      if (hasResumeContext) {
        requireString(value.operation, "context.operation");
        requireString(value.resumeToken, "context.resumeToken");
      }
      if (Object.hasOwn(value, "gitSnapshot")) {
        if (!isGitSnapshot(value.gitSnapshot)) {
          throw new CurrentFlowStateInvariantError("context.gitSnapshot must contain a valid Git availability and object id pair");
        }
      }
    }
    this.value = value === null ? null : Object.freeze({
      ...(Object.hasOwn(value, "operation") ? { operation: value.operation, resumeToken: value.resumeToken } : {}),
      ...(Object.hasOwn(value, "gitSnapshot") ? { gitSnapshot: Object.freeze({ ...value.gitSnapshot }) } : {}),
    });
    Object.freeze(this);
  }

  toJSON() { return this.value === null ? null : { ...this.value }; }
}

/** Immutable evidence for whether creation can be represented by flow_created. */
export class CurrentFlowCreationAuthority {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("history.creation must be an object");
    if (value.status === "available") {
      requireExactFields(value, new Set(["status", "source"]), "history.creation");
      if (!isPlainObject(value.source)) throw new CurrentFlowStateInvariantError("history.creation.source must be an object");
      requireExactFields(value.source, new Set(["path", "pointer", "hash", "timestamp"]), "history.creation.source");
      this.status = "available";
      this.source = Object.freeze({
        path: requireString(value.source.path, "history.creation.source.path"),
        pointer: requireString(value.source.pointer, "history.creation.source.pointer"),
        hash: requireString(value.source.hash, "history.creation.source.hash"),
        timestamp: requireIso(value.source.timestamp, "history.creation.source.timestamp"),
      });
      if (!/^[a-f0-9]{64}$/.test(this.source.hash)) {
        throw new CurrentFlowStateInvariantError("history.creation.source.hash must be SHA-256");
      }
      this.reason = null;
    } else if (value.status === "unavailable") {
      requireExactFields(value, new Set(["status", "reason"]), "history.creation");
      this.status = "unavailable";
      this.source = null;
      this.reason = requireString(value.reason, "history.creation.reason");
    } else {
      throw new CurrentFlowStateInvariantError("history.creation.status is invalid");
    }
    Object.freeze(this);
  }

  toJSON() {
    return this.status === "available"
      ? { status: this.status, source: { ...this.source } }
      : { status: this.status, reason: this.reason };
  }
}

/** Immutable boundary between imported provenance and native continuation. */
export class CurrentFlowHistoricalContinuation {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("history.continuation must be an object or null");
    requireExactFields(value, new Set(["nodeId", "attemptId", "attemptSequence", "confirmationOrder", "unexecutedSkipLeafIds"]), "history.continuation");
    this.nodeId = requireString(value.nodeId, "history.continuation.nodeId");
    this.attemptId = requireString(value.attemptId, "history.continuation.attemptId");
    this.attemptSequence = requirePositiveInteger(value.attemptSequence, "history.continuation.attemptSequence");
    this.confirmationOrder = requirePositiveInteger(value.confirmationOrder, "history.continuation.confirmationOrder");
    this.unexecutedSkipLeafIds = Object.freeze(requireStringList(
      value.unexecutedSkipLeafIds,
      "history.continuation.unexecutedSkipLeafIds",
    ));
    Object.freeze(this);
  }

  toJSON() {
    return {
      nodeId: this.nodeId,
      attemptId: this.attemptId,
      attemptSequence: this.attemptSequence,
      confirmationOrder: this.confirmationOrder,
      unexecutedSkipLeafIds: [...this.unexecutedSkipLeafIds],
    };
  }
}

/**
 * Production provenance for a faithfully imported historical Flow. Dormant
 * imports retain partial evidence without becoming executable by readback.
 * A Definition-authorized Attempt records the exact frontier where native
 * continuation begins; the imported prefix remains provenance, not replay.
 */
export class CurrentFlowHistory {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("history must be an object or null");
    requireExactFields(value, new Set(["kind", "execution", "ledger", "creation", "continuation"]), "history");
    if (value.kind !== "historical") throw new CurrentFlowStateInvariantError("history.kind must be historical");
    if (!["dormant", "resumed"].includes(value.execution)) {
      throw new CurrentFlowStateInvariantError("history.execution must be dormant or resumed");
    }
    if (value.ledger !== "partial") throw new CurrentFlowStateInvariantError("history.ledger must be partial");
    this.kind = "historical";
    this.execution = value.execution;
    this.ledger = "partial";
    this.creation = value.creation instanceof CurrentFlowCreationAuthority
      ? value.creation
      : new CurrentFlowCreationAuthority(value.creation);
    this.continuation = value.continuation === null
      ? null
      : value.continuation instanceof CurrentFlowHistoricalContinuation
        ? value.continuation
        : new CurrentFlowHistoricalContinuation(value.continuation);
    if (this.execution === "dormant" && this.continuation !== null) {
      throw new CurrentFlowStateInvariantError("dormant historical Flow must not retain a continuation boundary");
    }
    if (this.execution === "resumed" && this.continuation === null) {
      throw new CurrentFlowStateInvariantError("resumed historical Flow requires a continuation boundary");
    }
    Object.freeze(this);
  }

  get resumed() { return this.execution === "resumed"; }

  resume(continuation) {
    if (this.resumed) return this;
    return new CurrentFlowHistory({ ...this.toJSON(), execution: "resumed", continuation });
  }

  toJSON() {
    return {
      kind: this.kind,
      execution: this.execution,
      ledger: this.ledger,
      creation: this.creation.toJSON(),
      continuation: this.continuation?.toJSON() ?? null,
    };
  }
}

/**
 * The canonical Spec record for Flow Version 1.  Task instructions belong
 * here, never in flow.json or in a task-local runtime copy.  The document is
 * otherwise intentionally open so product-specific Spec fields remain owned
 * by the Spec schema rather than by persistence plumbing.
 */
export class CurrentFlowSpecRecord {
  constructor(document, { specId = null } = {}) {
    if (!isPlainObject(document)) {
      throw new CurrentFlowStateInvariantError("canonical spec.json must be an object");
    }
    const identity = document.id ?? document.specId ?? specId;
    this.record = new AuthoritativeSpecRecord({ ...document, id: identity });
    // The identity belongs to flow.json/location authority.  Existing Spec
    // schemas need not carry a duplicate `id` field merely for persistence.
    this.document = Object.freeze(structuredClone(document));
    this.specId = this.record.specId;
    if (!Array.isArray(document.tasks)) {
      throw new CurrentFlowStateInvariantError("canonical spec.json.tasks must be an array");
    }
    const ids = new Set();
    this.tasks = Object.freeze(document.tasks.map((task, index) => {
      if (!isPlainObject(task)) {
        throw new CurrentFlowStateInvariantError(`canonical spec.json.tasks[${index}] must be an object`);
      }
      const id = requireString(task.id, `canonical spec.json.tasks[${index}].id`);
      // `key` is runtime semantic identity. Existing Spec task documents are
      // authoritative without needing a persistence-only duplicate field.
      const key = requireString(task.key ?? id, `canonical spec.json.tasks[${index}].key`);
      if (ids.has(id)) {
        throw new CurrentFlowStateInvariantError(`canonical spec.json.tasks duplicates id: ${id}`);
      }
      ids.add(id);
      return Object.freeze({ id, key, document: Object.freeze(structuredClone(task)) });
    }));
    Object.freeze(this);
  }

  static from(value, options = {}) {
    if (value instanceof CurrentFlowSpecRecord) return value;
    if (value instanceof AuthoritativeSpecRecord) return new CurrentFlowSpecRecord(value.toJSON(), options);
    return new CurrentFlowSpecRecord(value, options);
  }

  toJSON() { return structuredClone(this.document); }
  get canonicalText() { return `${JSON.stringify(this.document, null, 2)}\n`; }

  withTask(task) {
    if (!isPlainObject(task)) {
      throw new CurrentFlowStateInvariantError("canonical Task specification must be an object");
    }
    const id = requireString(task.id, "canonical Task specification.id");
    const key = requireString(task.key ?? id, "canonical Task specification.key");
    const existing = this.tasks.find((entry) => entry.id === id) ?? null;
    if (existing !== null) {
      if (existing.key !== key) {
        throw new CurrentFlowStateInvariantError(`canonical spec.json Task key does not match existing Task: ${id}`);
      }
      return this;
    }
    const mapped = (Array.isArray(this.document.requirements) ? this.document.requirements : [])
      .some((requirement) => Array.isArray(requirement?.task_ids) && requirement.task_ids.includes(id));
    if (!mapped) {
      throw new CurrentFlowStateInvariantError(`canonical Spec Task admission has no mapped Requirement: ${id}`);
    }
    const next = this.toJSON();
    const document = structuredClone(task);
    delete document.key;
    next.tasks = [...next.tasks, { ...document, id }];
    return new CurrentFlowSpecRecord(next, { specId: this.specId.toString() });
  }

  task(id) {
    const stableId = requireString(id, "canonical Task id");
    return this.tasks.find((entry) => entry.id === stableId) ?? null;
  }
}

/**
 * Boundary serializer for the unchanged worker `spec.json` output contract.
 *
 * Only the initial Spec producer and its definition-authorized repair may
 * propose `tasks`. The Version Store retains that proposal in spec.json, then
 * approval admits each Task through its own Activity. Later definition-owned
 * Spec publications may append proposals and correct Task prose, but cannot
 * rewrite the admitted Task topology.
 */
/** Typed merge policy for a spec worker's append-only Task proposal. */
export class CanonicalWorkerTaskProposal {
  constructor(tasks) {
    if (!Array.isArray(tasks)) throw new CurrentFlowStateInvariantError("canonical worker Task proposal must be an array");
    this.tasks = Object.freeze(tasks.map((task, index) => {
      if (!isPlainObject(task)) throw new CurrentFlowStateInvariantError(`canonical worker Task proposal[${index}] must be an object`);
      return Object.freeze(structuredClone(task));
    }));
    Object.freeze(this);
  }

  merge(previous, admittedTaskIds) {
    if (!(previous instanceof CurrentFlowSpecRecord)) {
      throw new CurrentFlowStateInvariantError("canonical worker Task proposal requires the current typed Spec record");
    }
    if (!Array.isArray(admittedTaskIds)) {
      throw new CurrentFlowStateInvariantError("canonical worker Task proposal admitted Task ids must be an array");
    }
    const admittedIds = new Set(admittedTaskIds.map((id, index) => (
      requireString(id, `canonical worker Task proposal admitted Task ids[${index}]`)
    )));
    if (admittedIds.size !== admittedTaskIds.length) {
      throw new CurrentFlowStateInvariantError("canonical worker Task proposal admitted Task ids must not duplicate");
    }
    const previousById = new Map(previous.tasks.map((task) => [task.id, task]));
    const admitted = previous.tasks.filter((task) => admittedIds.has(task.id));
    if (admitted.length !== admittedIds.size) {
      const missing = [...admittedIds].find((id) => !previousById.has(id));
      throw new CurrentFlowStateInvariantError(`admitted Task is absent from canonical spec.json: ${missing}`);
    }
    const previousTasks = admitted.map((task) => structuredClone(task.document));
    if (this.tasks.length < previousTasks.length) {
      throw new CurrentFlowStateInvariantError("worker Task proposal must not delete admitted Tasks");
    }
    const merged = previousTasks.map((existing, index) => {
      const proposed = this.tasks[index];
      if (proposed.id !== existing.id) {
        throw new CurrentFlowStateInvariantError("worker Task proposal must preserve admitted Task order and identity");
      }
      const candidate = structuredClone(existing);
      for (const field of ["title", "goal"]) {
        if (Object.hasOwn(proposed, field)) candidate[field] = proposed[field];
      }
      if (!jsonEqual(candidate, proposed)) {
        throw new CurrentFlowStateInvariantError("worker Task proposal may only correct admitted Task title or goal");
      }
      return candidate;
    });
    const additions = this.tasks.slice(previousTasks.length).map((task) => structuredClone(task));
    const expectedRound = previousTasks.reduce(
      (round, task) => Math.max(round, task.added_round),
      -1,
    ) + 1;
    for (const task of additions) {
      if (task.added_round !== expectedRound) {
        throw new CurrentFlowStateInvariantError(
          `worker Task proposal new Task added_round must be ${expectedRound}: ${task.id}`,
        );
      }
    }
    return Object.freeze([...merged, ...additions]);
  }
}

export class CanonicalWorkerSpecPublication {
  constructor(document) {
    if (!isPlainObject(document)) {
      throw new CurrentFlowStateInvariantError("canonical worker spec publication must be an object");
    }
    if (Object.hasOwn(document, "tasks") && !Array.isArray(document.tasks)) {
      throw new CurrentFlowStateInvariantError("canonical worker Spec task proposal must be an array");
    }
    this.document = Object.freeze(structuredClone(document));
    this.taskProposal = Object.hasOwn(document, "tasks")
      ? new CanonicalWorkerTaskProposal(document.tasks)
      : null;
    this.hasTaskProposal = this.taskProposal !== null;
    Object.freeze(this);
  }

  materialize(previous, { specId, admittedTaskIds } = {}) {
    if (!(previous instanceof CurrentFlowSpecRecord)) {
      throw new CurrentFlowStateInvariantError("canonical worker spec publication requires the current typed Spec record");
    }
    const proposedTasks = this.taskProposal?.merge(previous, admittedTaskIds) ?? null;
    return new CurrentFlowSpecRecord({
      ...structuredClone(this.document),
      tasks: proposedTasks !== null
        ? proposedTasks
        : previous.tasks.map((task) => structuredClone(task.document)),
    }, { specId });
  }
}

/** Trusted parent-only replacement emitted by validated source handoff effects. */
export class CanonicalSourceWorkerSpecCompletion {
  constructor(document) {
    if (!isPlainObject(document)) throw new CurrentFlowStateInvariantError("source worker Spec completion must be an object");
    this.document = Object.freeze(structuredClone(document));
    Object.freeze(this);
  }
  materialize(previous, { specId } = {}) {
    if (!(previous instanceof CurrentFlowSpecRecord)) {
      throw new CurrentFlowStateInvariantError("source worker Spec completion requires the current typed Spec record");
    }
    const next = new CurrentFlowSpecRecord(this.document, { specId });
    if (!jsonEqual(next.toJSON().tasks, previous.toJSON().tasks)) {
      throw new CurrentFlowStateInvariantError("source worker Spec completion must not mutate runtime-owned Tasks");
    }
    return next;
  }
}

export class ArtifactReference {
  constructor(value) {
    requireExactFields(value, new Set(["kind", "id"]), "artifact reference");
    this.kind = requireString(value.kind, "artifact reference.kind");
    this.id = requireString(value.id, "artifact reference.id");
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind, id: this.id }; }
}

export class NodeResult {
  constructor(value) {
    requireExactFields(value, new Set(["outcome", "summary", "confirmedAt", "artifactRefs"]), "result");
    const { outcome, summary, confirmedAt, artifactRefs } = value;
    if (!RESULT_OUTCOMES.has(outcome)) {
      throw new CurrentFlowStateInvariantError(`result.outcome is invalid: ${outcome}`);
    }
    this.outcome = outcome;
    this.summary = requireString(summary, "result.summary");
    this.confirmedAt = requireIso(confirmedAt, "result.confirmedAt");
    if (!Array.isArray(artifactRefs)) throw new CurrentFlowStateInvariantError("result.artifactRefs must be an array");
    this.artifactRefs = Object.freeze(artifactRefs.map((ref) => ref instanceof ArtifactReference ? ref : new ArtifactReference(ref)));
    if (new Set(this.artifactRefs.map((ref) => ref.kind)).size !== this.artifactRefs.length) {
      throw new CurrentFlowStateInvariantError("result.artifactRefs must contain at most one artifact per resource kind");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      outcome: this.outcome,
      summary: this.summary,
      confirmedAt: this.confirmedAt,
      artifactRefs: this.artifactRefs.map((ref) => ref.toJSON()),
    };
  }
}

/** Schema-bound Activity receipt for the one Definition-owned draft connector. */
export class ActivityStepConnectionReceipt {
  constructor(value) {
    requireExactFields(value, new Set([
      "kind", "id", "source", "sourceStepId", "targetStepId", "sourceAttempt",
      "draftInput", "draftOutput", "lineage", "decisionEvidence",
    ]), "activity.stepConnectionReceipt");
    for (const field of ["kind", "id", "source", "sourceStepId", "targetStepId"]) requireString(value[field], `activity Step connection receipt.${field}`);
    if (!/^[a-f0-9]{64}$/.test(value.id)) {
      throw new CurrentFlowStateInvariantError("activity Step connection receipt.id must be SHA-256");
    }
    requireExactFields(value.sourceAttempt, new Set(["id", "sequence"]), "activity Step connection receipt.sourceAttempt");
    for (const [field, revision] of [["draftInput", value.draftInput], ["draftOutput", value.draftOutput]]) {
      requireExactFields(revision, new Set(["digest", "byteLength"]), `activity Step connection receipt.${field}`);
      if (!/^[a-f0-9]{64}$/.test(revision.digest ?? "")) {
        throw new CurrentFlowStateInvariantError(`activity Step connection receipt.${field}.digest must be SHA-256`);
      }
      requirePositiveInteger(revision.byteLength, `activity Step connection receipt.${field}.byteLength`, { allowZero: true });
    }
    if (!isPlainObject(value.lineage) || !isPlainObject(value.decisionEvidence)) {
      throw new CurrentFlowStateInvariantError("activity Step connection receipt evidence is invalid");
    }
    const { id, ...content } = value;
    if (id !== canonicalJsonDigest(content)) {
      throw new CurrentFlowStateInvariantError("activity Step connection receipt content digest is invalid");
    }
    try {
      DraftStepConnectionReceipt.fromJSON(value);
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`activity Step connection receipt schema is invalid: ${cause.message}`);
    }
    this.kind = value.kind; this.id = value.id; this.source = value.source; this.sourceStepId = value.sourceStepId; this.targetStepId = value.targetStepId;
    this.sourceAttempt = Object.freeze({ id: requireString(value.sourceAttempt.id, "activity Step connection receipt.sourceAttempt.id"), sequence: requirePositiveInteger(value.sourceAttempt.sequence, "activity Step connection receipt.sourceAttempt.sequence") });
    this.draftInput = immutableSnapshotValue(structuredClone(value.draftInput));
    this.draftOutput = immutableSnapshotValue(structuredClone(value.draftOutput));
    this.lineage = immutableSnapshotValue(structuredClone(value.lineage));
    this.decisionEvidence = immutableSnapshotValue(structuredClone(value.decisionEvidence));
    Object.freeze(this);
  }
  toJSON() { return { kind: this.kind, id: this.id, source: this.source, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId, sourceAttempt: { ...this.sourceAttempt }, draftInput: structuredClone(this.draftInput), draftOutput: structuredClone(this.draftOutput), lineage: structuredClone(this.lineage), decisionEvidence: structuredClone(this.decisionEvidence) }; }
}

export class AttemptConsumption {
  constructor(value) {
    requireExactFields(value, new Set(["semantic", "tooling"]), "attempt.consumption");
    const { semantic, tooling } = value;
    this.semantic = requirePositiveInteger(semantic, "attempt.consumption.semantic", { allowZero: true });
    this.tooling = requirePositiveInteger(tooling, "attempt.consumption.tooling", { allowZero: true });
    Object.freeze(this);
  }

  toJSON() { return { semantic: this.semantic, tooling: this.tooling }; }
}

export class AttemptBlocker {
  constructor(value) {
    requireExactFields(value, new Set(["code", "message"]), "attempt.blocker");
    const { code, message } = value;
    this.code = requireString(code, "attempt.blocker.code");
    this.message = requireString(message, "attempt.blocker.message");
    Object.freeze(this);
  }

  toJSON() { return { code: this.code, message: this.message }; }
}

export class AttemptIncompleteClaim {
  constructor(value) {
    requireExactFields(value, new Set(["code", "message", "operation", "resources"]), "attempt.incompleteClaim");
    const { code, message, operation, resources } = value;
    this.code = requireString(code, "attempt.incompleteClaim.code");
    this.message = requireString(message, "attempt.incompleteClaim.message");
    if (operation !== null) requireString(operation, "attempt.incompleteClaim.operation");
    this.operation = operation;
    this.resources = requireStringList(resources, "attempt.incompleteClaim.resources");
    if (this.resources.length > 0 && this.operation === null) {
      throw new CurrentFlowStateInvariantError("attempt.incompleteClaim.resources requires an operation");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      operation: this.operation,
      resources: [...this.resources],
    };
  }
}

export class AttemptOperationClaim {
  constructor(value) {
    requireExactFields(value, new Set(["operation", "resources"]), "attempt.operationClaim");
    const { operation, resources } = value;
    this.operation = requireString(operation, "attempt.operationClaim.operation");
    this.resources = requireStringList(resources, "attempt.operationClaim.resources");
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, resources: [...this.resources] }; }
}

export class ActivityFailure {
  constructor(value) {
    requireExactFields(value, new Set(["category", "code", "message", "retryable", "retryKind"]), "activity.failure");
    const { category, code, message, retryable, retryKind } = value;
    this.category = requireString(category, "activity.failure.category");
    this.code = requireString(code, "activity.failure.code");
    this.message = requireString(message, "activity.failure.message");
    if (typeof retryable !== "boolean") throw new CurrentFlowStateInvariantError("activity.failure.retryable must be boolean");
    if (retryKind !== null && !RETRY_KINDS.has(retryKind)) {
      throw new CurrentFlowStateInvariantError("activity.failure.retryKind is invalid");
    }
    if (retryable && retryKind === null) {
      throw new CurrentFlowStateInvariantError("retryable failure requires a retry accounting kind");
    }
    this.retryable = retryable;
    this.retryKind = retryKind;
    Object.freeze(this);
  }

  toJSON() {
    return {
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryKind: this.retryKind,
    };
  }
}

export class CurrentAttempt {
  constructor(value) {
    requireExactFields(value, new Set(["id", "nodeId", "sequence", "startedAt", "consumption", "failure", "blocker", "incomplete", "operationClaims"]), "attempt");
    const { id, nodeId, sequence, startedAt, consumption, failure, blocker, incomplete, operationClaims } = value;
    this.id = requireString(id, "attempt.id");
    this.nodeId = requireString(nodeId, "attempt.nodeId");
    this.sequence = requirePositiveInteger(sequence, "attempt.sequence");
    this.startedAt = requireIso(startedAt, "attempt.startedAt");
    this.consumption = consumption instanceof AttemptConsumption ? consumption : new AttemptConsumption(consumption);
    if (this.consumption.semantic + this.consumption.tooling >= this.sequence) {
      throw new CurrentFlowStateInvariantError("attempt retry consumption must be lower than its per-node sequence");
    }
    this.failure = failure == null ? null : failure instanceof ActivityFailure ? failure : new ActivityFailure(failure);
    this.blocker = blocker == null ? null : blocker instanceof AttemptBlocker ? blocker : new AttemptBlocker(blocker);
    if (!Array.isArray(incomplete)) throw new CurrentFlowStateInvariantError("attempt.incomplete must be an array");
    this.incomplete = Object.freeze(incomplete.map((claim) => claim instanceof AttemptIncompleteClaim ? claim : new AttemptIncompleteClaim(claim)));
    if (!Array.isArray(operationClaims)) throw new CurrentFlowStateInvariantError("attempt.operationClaims must be an array");
    this.operationClaims = Object.freeze(operationClaims.map((claim) => claim instanceof AttemptOperationClaim ? claim : new AttemptOperationClaim(claim)));
    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      nodeId: this.nodeId,
      sequence: this.sequence,
      startedAt: this.startedAt,
      consumption: this.consumption.toJSON(),
      failure: this.failure?.toJSON() ?? null,
      blocker: this.blocker?.toJSON() ?? null,
      incomplete: this.incomplete.map((claim) => claim.toJSON()),
      operationClaims: this.operationClaims.map((claim) => claim.toJSON()),
    };
  }

  replaceFacts({ failure = this.failure, blocker = this.blocker, incomplete = this.incomplete, operationClaims = this.operationClaims } = {}) {
    return new CurrentAttempt({
      id: this.id,
      nodeId: this.nodeId,
      sequence: this.sequence,
      startedAt: this.startedAt,
      consumption: this.consumption,
      failure,
      blocker,
      incomplete,
      operationClaims,
    });
  }
}

/**
 * Immutable identity of one currently executing Attempt.
 *
 * Commands that may run lifecycle hooks after their producer has changed the
 * Flow bind this value before execution.  A later Store mutation may then
 * prove that it still addresses precisely the Attempt it observed, rather
 * than accidentally recording a failure against a retry or replacement.
 */
export class CurrentAttemptIdentity {
  constructor({ id, nodeId, sequence } = {}) {
    this.id = requireString(id, "current Attempt identity.id");
    this.nodeId = requireString(nodeId, "current Attempt identity.nodeId");
    this.sequence = requirePositiveInteger(sequence, "current Attempt identity.sequence");
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof CurrentAttemptIdentity) return value;
    if (value instanceof CurrentAttempt) {
      return new CurrentAttemptIdentity({ id: value.id, nodeId: value.nodeId, sequence: value.sequence });
    }
    return new CurrentAttemptIdentity(value);
  }

  matches(state) {
    if (!(state instanceof CurrentFlowState)) return false;
    const nodeId = state.current?.at(-1) ?? null;
    const attempt = state.attempt;
    const node = nodeId === null ? null : state.findNode(nodeId);
    return nodeId === this.nodeId
      && node?.status === "in_progress"
      && attempt !== null
      && attempt.id === this.id
      && attempt.nodeId === this.nodeId
      && attempt.sequence === this.sequence
      && attempt.failure === null;
  }

  matchesFailed(state) {
    if (!(state instanceof CurrentFlowState)) return false;
    const nodeId = state.current?.at(-1) ?? null;
    const attempt = state.attempt;
    const node = nodeId === null ? null : state.findNode(nodeId);
    return nodeId === this.nodeId
      && node?.status === "in_progress"
      && attempt !== null
      && attempt.id === this.id
      && attempt.nodeId === this.nodeId
      && attempt.sequence === this.sequence
      && attempt.failure !== null;
  }

  toJSON() {
    return { id: this.id, nodeId: this.nodeId, sequence: this.sequence };
  }
}

export class CurrentFlowNode {
  constructor(value) {
    requireExactFields(value, NODE_FIELDS, "node");
    const { kind, id, key, status, result, attemptSequence, steps } = value;
    if (!NODE_KINDS.has(kind)) throw new CurrentFlowStateInvariantError(`node.kind is invalid: ${kind}`);
    this.kind = kind;
    this.id = requireString(id, "node.id");
    this.key = requireString(key, "node.key");
    if (!NODE_STATUSES.has(status)) throw new CurrentFlowStateInvariantError(`node.status is invalid: ${status}`);
    this.status = status;
    this.result = result == null ? null : result instanceof NodeResult ? result : new NodeResult(result);
    this.attemptSequence = requirePositiveInteger(attemptSequence, "node.attemptSequence", { allowZero: true });
    if (!Array.isArray(steps)) throw new CurrentFlowStateInvariantError("node.steps must be an array");
    this.steps = Object.freeze(steps.map((step) => step instanceof CurrentFlowNode ? step : nodeFromJSON(step)));
    Object.freeze(this);
  }

  with({ status = this.status, result = this.result, attemptSequence = this.attemptSequence, steps = this.steps } = {}) {
    return new this.constructor({
      kind: this.kind,
      id: this.id,
      key: this.key,
      status,
      result,
      attemptSequence,
      steps,
    });
  }

  withSteps(steps) {
    return this.with({ steps });
  }

  toJSON() {
    return {
      kind: this.kind,
      id: this.id,
      key: this.key,
      status: this.status,
      result: this.result?.toJSON() ?? null,
      attemptSequence: this.attemptSequence,
      steps: this.steps.map((step) => step.toJSON()),
    };
  }
}

export class FlowRootNode extends CurrentFlowNode {
  constructor(value) {
    if (value?.kind !== "flow") throw new CurrentFlowStateInvariantError("FlowRootNode.kind must be flow");
    super(value);
  }
}

export class StepNode extends CurrentFlowNode {
  constructor(value) {
    if (value?.kind !== "step") throw new CurrentFlowStateInvariantError("StepNode.kind must be step");
    super(value);
  }
}

export class TaskNode extends CurrentFlowNode {
  constructor(value) {
    if (value?.kind !== "task") throw new CurrentFlowStateInvariantError("TaskNode.kind must be task");
    super(value);
  }
}

export class ResourceContract {
  constructor({ required = [], authority = "definition" } = {}) {
    this.required = requireStringList(required, "resourceContract.required");
    if (authority !== "definition") {
      throw new CurrentFlowStateInvariantError("resourceContract.authority must be definition");
    }
    this.authority = authority;
    Object.freeze(this);
  }

  assertClaims(operationClaims, incompleteClaims, nodeId) {
    const coverage = new Map();
    const record = (resource, source) => {
      if (!this.required.includes(resource)) {
        throw new CurrentFlowStateInvariantError(`attempt resource claim exceeds definition contract for ${nodeId}`);
      }
      if (coverage.has(resource)) {
        throw new CurrentFlowStateInvariantError(`attempt resource claim duplicates or conflicts for ${nodeId}: ${resource}`);
      }
      coverage.set(resource, source);
    };
    for (const claim of operationClaims) {
      for (const resource of claim.resources) {
        record(resource, "claimed");
      }
    }
    for (const incomplete of incompleteClaims) {
      for (const resource of incomplete.resources) {
        record(resource, "incomplete");
      }
    }
    const missing = this.required.filter((resource) => !coverage.has(resource));
    if (missing.length > 0) {
      throw new CurrentFlowStateInvariantError(`Attempt does not cover required definition resources for ${nodeId}: ${missing.join(", ")}`);
    }
  }
}

export class DefinitionAction {
  constructor({
    action,
    instructionsKey,
    contextKinds = [],
    outputSchemaRef = null,
    requiresApproval = false,
    autoApproveChoiceId = null,
    maxAttempts = 1,
    sideEffects = null,
    failurePolicy = null,
    executionCommand = null,
    failureOwnership = null,
    artifactAuthority = {},
  }) {
    if (action !== null) requireString(action, "definition.action.action");
    this.action = action;
    if (instructionsKey !== null) requireString(instructionsKey, "definition.action.instructionsKey");
    this.instructionsKey = instructionsKey;
    this.contextKinds = requireStringList(contextKinds, "definition.action.contextKinds");
    if (outputSchemaRef !== null) requireString(outputSchemaRef, "definition.action.outputSchemaRef");
    this.outputSchemaRef = outputSchemaRef;
    if (typeof requiresApproval !== "boolean") {
      throw new CurrentFlowStateInvariantError("definition.action.requiresApproval must be boolean");
    }
    this.requiresApproval = requiresApproval;
    if (autoApproveChoiceId !== null) requireString(autoApproveChoiceId, "definition.action.autoApproveChoiceId");
    if (autoApproveChoiceId !== null && requiresApproval !== true) {
      throw new CurrentFlowStateInvariantError("definition.action.autoApproveChoiceId requires approval");
    }
    this.autoApproveChoiceId = autoApproveChoiceId;
    this.maxAttempts = requirePositiveInteger(maxAttempts, "definition.action.maxAttempts");
    if (sideEffects !== null) requireStringList(sideEffects, "definition.action.sideEffects");
    this.sideEffects = sideEffects === null ? null : Object.freeze([...sideEffects]);
    this.failurePolicy = failurePolicy === null
      ? null
      : DefinitionFailurePolicy.from(failurePolicy);
    if (executionCommand !== null) requireString(executionCommand, "definition.action.executionCommand");
    this.executionCommand = executionCommand;
    try {
      this.failureOwnership = failureOwnership === null
        ? null
        : DefinitionFailureOwnership.from(failureOwnership);
    } catch (error) {
      throw new CurrentFlowStateInvariantError(`definition.action.failureOwnership is invalid: ${error.message}`);
    }
    if (executionCommand !== null && failureOwnership === null) {
      throw new CurrentFlowStateInvariantError("definition.action.executionCommand requires failureOwnership");
    }
    if (executionCommand === null && failureOwnership !== null) {
      throw new CurrentFlowStateInvariantError("definition.action.failureOwnership requires executionCommand");
    }
    this.artifactAuthority = artifactAuthority instanceof ArtifactAuthorityPolicy
      ? artifactAuthority
      : new ArtifactAuthorityPolicy(artifactAuthority);
    Object.freeze(this);
  }

  toJSON() {
    return {
      action: this.action,
      instructionsKey: this.instructionsKey,
      contextKinds: [...this.contextKinds],
      outputSchemaRef: this.outputSchemaRef,
      requiresApproval: this.requiresApproval,
      autoApproveChoiceId: this.autoApproveChoiceId,
      maxAttempts: this.maxAttempts,
      sideEffects: this.sideEffects === null ? null : [...this.sideEffects],
      failurePolicy: this.failurePolicy?.toJSON() ?? null,
      executionCommand: this.executionCommand,
      failureOwnership: this.failureOwnership?.toJSON() ?? null,
      artifactAuthority: this.artifactAuthority.toJSON(),
    };
  }
}

export class DefinitionFailurePolicy {
  constructor(value, { targetNodeId = null } = {}) {
    if (!FAILURE_POLICIES.has(value)) {
      throw new CurrentFlowStateInvariantError(`definition.action.failurePolicy is invalid: ${value}`);
    }
    if (targetNodeId !== null) requireString(targetNodeId, "definition.action.failurePolicy.targetNodeId");
    if (["amend-spec", "test-chain-repair"].includes(value) !== (targetNodeId !== null)) {
      throw new CurrentFlowStateInvariantError(
        "targeted failure policy requires exactly one definition-owned target node",
      );
    }
    this.value = value;
    this.targetNodeId = targetNodeId;
    Object.freeze(this);
  }

  decide({ failure, consumption, contract }) {
    if (!(failure instanceof ActivityFailure)) {
      throw new CurrentFlowStateInvariantError("failure policy decision requires a typed failure");
    }
    if (!(consumption instanceof AttemptConsumption) || !(contract instanceof NodeContract)) {
      throw new CurrentFlowStateInvariantError("failure policy decision requires typed retry accounting");
    }
    const remaining = failure.retryKind === null
      ? 0
      : Math.max(0, contract.remainingRetries(consumption, failure.retryKind));
    // An unaccepted source mutation is not evidence of a completed Review or
    // an exhausted tooling budget. Neither retry nor record-and-advance may
    // adopt it as the next Attempt's source baseline.
    if (failure.category === "source-integrity") {
      return new DefinitionFailureDecision({
        policy: this, operation: "blocked", retryKind: null, remaining: 0, targetNodeId: null,
        reason: "unaccepted source effects require explicit reconciliation before execution can continue",
      });
    }
    // This marker deliberately selects no lifecycle route.  Some Steps need
    // cataloged artifacts in addition to state before their dedicated
    // Definition can decide; CurrentFlowState therefore exposes only this
    // route-neutral cursor and never substitutes a generic block/record.
    if (this.value === "step-definition") {
      return new DefinitionFailureDecision({
        policy: this,
        operation: "resolve-step-definition",
        retryKind: null,
        remaining: 0,
        targetNodeId: null,
        reason: "the active Step Definition must resolve this failure from canonical facts",
      });
    }
    if (this.value === "test-chain-retry") {
      if (failure.code === "TEST_CHAIN_REJECTED" && failure.retryable && remaining > 0) {
        return new DefinitionFailureDecision({
          policy: this, operation: "retry", retryKind: failure.retryKind, remaining, targetNodeId: null,
          reason: `the Definition-selected test-chain retry has ${remaining} remaining`,
        });
      }
      return new DefinitionFailureDecision({
        policy: this, operation: "blocked", retryKind: null, remaining: 0, targetNodeId: null,
        reason: "the Definition-selected test-chain failure is terminal",
      });
    }
    if (this.value === "test-chain-repair") {
      if (failure.code === "SCENARIO_VALIDITY_REJECTED") {
        return new DefinitionFailureDecision({
          policy: this, operation: "rewind", retryKind: null, remaining: 0, targetNodeId: this.targetNodeId,
          reason: "the Definition-selected scenario repair rewinds to the test handoff",
        });
      }
      return new DefinitionFailureDecision({
        policy: this, operation: "blocked", retryKind: null, remaining: 0, targetNodeId: null,
        reason: "the Definition-selected scenario tooling failure is terminal",
      });
    }
    if (["retry", "retry-block"].includes(this.value) && failure.retryable && remaining > 0) {
      return new DefinitionFailureDecision({
        policy: this,
        operation: "retry",
        retryKind: failure.retryKind,
        remaining,
        targetNodeId: null,
        reason: `the definition authorizes a ${failure.retryKind} retry with ${remaining} remaining`,
      });
    }
    if (this.value === "retry-block") {
      return new DefinitionFailureDecision({
        policy: this,
        operation: "blocked",
        retryKind: null,
        remaining: 0,
        targetNodeId: null,
        reason: "the definition exhausted the bounded retry policy without a completed producer result",
      });
    }
    if (this.value === "retry" || this.value === "record") {
      return new DefinitionFailureDecision({
        policy: this,
        operation: "record",
        retryKind: null,
        remaining: 0,
        targetNodeId: null,
        reason: this.value === "retry"
          ? "the definition records the exhausted or non-retryable failure before continuing"
          : "the definition records this terminal failure before continuing",
      });
    }
    if (this.value === "amend-spec") {
      return new DefinitionFailureDecision({
        policy: this,
        operation: "rewind",
        retryKind: null,
        remaining: 0,
        targetNodeId: this.targetNodeId,
        reason: "the definition rewinds to its specification amendment target",
      });
    }
    return new DefinitionFailureDecision({
      policy: this,
      operation: "blocked",
      retryKind: null,
      remaining: 0,
      targetNodeId: null,
      reason: "the definition blocks after this terminal failure",
    });
  }

  static from(value) {
    if (value instanceof DefinitionFailurePolicy) return value;
    if (typeof value === "string") return new DefinitionFailurePolicy(value);
    requireExactFields(value, new Set(["kind", "targetNodeId"]), "definition.action.failurePolicy");
    return new DefinitionFailurePolicy(value.kind, { targetNodeId: value.targetNodeId });
  }

  toJSON() { return { kind: this.value, targetNodeId: this.targetNodeId }; }
}

export class DefinitionFailureDecision {
  constructor({ policy, operation, retryKind, remaining, targetNodeId, reason }) {
    if (!(policy instanceof DefinitionFailurePolicy)) {
      throw new CurrentFlowStateInvariantError("failure decision requires a definition-owned policy");
    }
    if (!["retry", "record", "rewind", "blocked", "resolve-step-definition"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("failure decision operation is invalid");
    }
    if (retryKind !== null && !RETRY_KINDS.has(retryKind)) {
      throw new CurrentFlowStateInvariantError("failure decision retryKind is invalid");
    }
    requirePositiveInteger(remaining, "failure decision remaining", { allowZero: true });
    if ((operation === "retry") !== (retryKind !== null && remaining > 0)) {
      throw new CurrentFlowStateInvariantError("only a retry decision may expose retry accounting");
    }
    if ((operation === "rewind") !== (targetNodeId !== null)) {
      throw new CurrentFlowStateInvariantError("only a rewind decision may identify a target node");
    }
    this.policy = policy;
    this.operation = operation;
    this.retryKind = retryKind;
    this.remaining = remaining;
    this.targetNodeId = targetNodeId;
    this.reason = requireString(reason, "failure decision reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      policy: this.policy.toJSON(),
      operation: this.operation,
      retryKind: this.retryKind,
      remaining: this.remaining,
      targetNodeId: this.targetNodeId,
      reason: this.reason,
    };
  }
}

export class ArtifactAuthorityPolicy {
  constructor({ sourceScopes = ["same_task", "flow"], selection = "latest_upstream" } = {}) {
    this.sourceScopes = requireStringList(sourceScopes, "definition.action.artifactAuthority.sourceScopes");
    if (this.sourceScopes.some((scope) => !["same_task", "flow", "all_tasks"].includes(scope))) {
      throw new CurrentFlowStateInvariantError("definition action artifact authority contains an invalid source scope");
    }
    if (selection !== "latest_upstream") {
      throw new CurrentFlowStateInvariantError("definition action artifact authority selection is invalid");
    }
    this.selection = selection;
    Object.freeze(this);
  }

  toJSON() { return { sourceScopes: [...this.sourceScopes], selection: this.selection }; }
}

export class NodeContract {
  constructor({ semanticRetryLimit = 0, toolingRetryLimit = null, transitions = ["pending:in_progress", "in_progress:done", "done:in_progress", "skipped:in_progress", "invalidated:in_progress", "pending:invalidated", "in_progress:invalidated", "done:invalidated", "skipped:invalidated"], resourceContract = {}, completion = "all_children_terminal" } = {}) {
    // These are retry budgets, not total-attempt limits.  `null` means no
    // tooling retries are defined (equivalent to a fixed budget of zero), not
    // an unbounded fallback. Attempt sequence is a separate per-node cursor;
    // these counters describe only retry budget consumption in this episode.
    this.semanticRetryLimit = requirePositiveInteger(semanticRetryLimit, "contract.semanticRetryLimit", { allowZero: true });
    if (toolingRetryLimit !== null) requirePositiveInteger(toolingRetryLimit, "contract.toolingRetryLimit", { allowZero: true });
    this.toolingRetryLimit = toolingRetryLimit;
    if (!Array.isArray(transitions) || transitions.some((value) => typeof value !== "string" || !/^[a-z_]+:[a-z_]+$/.test(value))) {
      throw new CurrentFlowStateInvariantError("contract.transitions must be transition strings");
    }
    if (new Set(transitions).size !== transitions.length) {
      throw new CurrentFlowStateInvariantError("contract.transitions must not contain duplicates");
    }
    if (transitions.some((transition) => transition.split(":").some((status) => !NODE_STATUSES.has(status)))) {
      throw new CurrentFlowStateInvariantError("contract.transitions must use known node statuses");
    }
    this.transitions = Object.freeze([...transitions]);
    this.resourceContract = resourceContract instanceof ResourceContract
      ? resourceContract
      : new ResourceContract(resourceContract);
    if (completion !== "all_children_terminal") {
      throw new CurrentFlowStateInvariantError("contract.completion is invalid");
    }
    this.completion = completion;
    Object.freeze(this);
  }

  permits(from, to) {
    return this.transitions.includes(`${from}:${to}`);
  }

  permitsStatus(status) {
    if (!NODE_STATUSES.has(status)) return false;
    if (status === "pending") return true;
    return this.transitions.some((transition) => transition.endsWith(`:${status}`));
  }

  remainingRetries(consumption, kind) {
    if (!(consumption instanceof AttemptConsumption) || !RETRY_KINDS.has(kind)) {
      throw new CurrentFlowStateInvariantError("retry budget lookup requires typed consumption and retry kind");
    }
    const limit = kind === "semantic" ? this.semanticRetryLimit : this.toolingRetryLimit ?? 0;
    return limit - consumption[kind];
  }

}

export class FlowDefinitionNode {
  constructor({ kind = "step", id, key, steps = [], contract = {}, action = null }) {
    if (!NODE_KINDS.has(kind)) throw new CurrentFlowStateInvariantError(`definition.kind is invalid: ${kind}`);
    this.kind = kind;
    this.id = requireString(id, "definition.id");
    this.key = requireString(key, "definition.key");
    if (!Array.isArray(steps)) throw new CurrentFlowStateInvariantError("definition.steps must be an array");
    this.steps = Object.freeze(steps.map((step) => step instanceof FlowDefinitionNode ? step : new FlowDefinitionNode(step)));
    this.contract = contract instanceof NodeContract ? contract : new NodeContract(contract);
    this.action = action == null ? null : action instanceof DefinitionAction ? action : new DefinitionAction(action);
    if (this.steps.length === 0 && this.action === null) {
      throw new CurrentFlowStateInvariantError(`definition leaf requires action metadata: ${this.id}`);
    }
    if (this.steps.length === 0 && this.action.failurePolicy === null) {
      throw new CurrentFlowStateInvariantError(`definition leaf requires an explicit failure policy: ${this.id}`);
    }
    if (this.steps.length > 0 && this.action !== null) {
      throw new CurrentFlowStateInvariantError(`definition branch must not carry action metadata: ${this.id}`);
    }
    if (this.steps.length > 0 && this.contract.transitions.some((transition) => transition.endsWith(":failed"))) {
      throw new CurrentFlowStateInvariantError(`definition branch cannot transition to failed: ${this.id}`);
    }
    if (
      this.steps.length === 0
      && RECORDING_FAILURE_POLICIES.has(this.action.failurePolicy.value)
      && !this.contract.permits("in_progress", "failed")
    ) {
      throw new CurrentFlowStateInvariantError(
        `recording failure policy requires an in_progress:failed transition: ${this.id}`,
      );
    }
    if (
      this.steps.length === 0
      && !RECORDING_FAILURE_POLICIES.has(this.action.failurePolicy.value)
      && this.contract.permits("in_progress", "failed")
    ) {
      throw new CurrentFlowStateInvariantError(
        `non-recording failure policy forbids an in_progress:failed transition: ${this.id}`,
      );
    }
    if (this.steps.length === 0 && this.action.maxAttempts !== this.contract.semanticRetryLimit + 1) {
      throw new CurrentFlowStateInvariantError(
        `definition action maxAttempts must equal semanticRetryLimit + 1: ${this.id}`,
      );
    }
    if (
      this.steps.length === 0
      && !jsonEqual([...this.action.contextKinds], [...this.contract.resourceContract.required])
    ) {
      throw new CurrentFlowStateInvariantError(
        `definition action contextKinds must equal required resource contract: ${this.id}`,
      );
    }
    Object.freeze(this);
  }

  materialize() {
    const Node = this.kind === "flow" ? FlowRootNode : this.kind === "task" ? TaskNode : StepNode;
    return new Node({
      kind: this.kind,
      id: this.id,
      key: this.key,
      status: "pending",
      result: null,
      attemptSequence: 0,
      steps: this.steps.map((step) => step.materialize()),
    });
  }
}

/**
 * Defines static flow nodes and the repeatable Task template.  `impl` is the
 * sole dynamic container. Tasks are inserted at the definition-owned point
 * after `dynamicTaskInsertionAfterId`, and each Task receives a materialized
 * `Task.steps[]` template.
 */
export class CurrentFlowDefinition {
  #staticNodesById;
  #taskTemplateNodesByKey;
  #dynamicContainer;
  constructor({ root, taskTemplate, dynamicTaskContainerId = "impl", dynamicTaskInsertionAfterId = "implement" }) {
    this.root = root instanceof FlowDefinitionNode ? root : new FlowDefinitionNode(root);
    if (this.root.kind !== "flow") throw new CurrentFlowStateInvariantError("definition.root.kind must be flow");
    this.taskTemplate = taskTemplate instanceof FlowDefinitionNode ? taskTemplate : new FlowDefinitionNode(taskTemplate);
    if (this.taskTemplate.kind !== "task") throw new CurrentFlowStateInvariantError("definition.taskTemplate.kind must be task");
    this.dynamicTaskContainerId = requireString(dynamicTaskContainerId, "definition.dynamicTaskContainerId");
    this.dynamicTaskInsertionAfterId = requireString(dynamicTaskInsertionAfterId, "definition.dynamicTaskInsertionAfterId");
    const ids = new Set();
    for (const node of collectDefinitionNodes(this.root)) {
      if (ids.has(node.id)) throw new CurrentFlowStateInvariantError(`definition duplicates stable id: ${node.id}`);
      ids.add(node.id);
    }
    const taskTemplateNodes = collectDefinitionNodes(this.taskTemplate);
    const taskTemplateIds = new Set();
    const taskTemplateKeys = new Set();
    for (const node of taskTemplateNodes) {
      if (taskTemplateIds.has(node.id)) {
        throw new CurrentFlowStateInvariantError(`definition task template duplicates relative id: ${node.id}`);
      }
      if (taskTemplateKeys.has(node.key)) {
        throw new CurrentFlowStateInvariantError(`definition task template duplicates semantic key: ${node.key}`);
      }
      if (node !== this.taskTemplate && node.kind !== "step") {
        throw new CurrentFlowStateInvariantError("definition Task descendants must be Step nodes");
      }
      taskTemplateIds.add(node.id);
      taskTemplateKeys.add(node.key);
    }
    const dynamicContainer = collectDefinitionNodes(this.root).find((node) => node.id === this.dynamicTaskContainerId);
    if (!dynamicContainer) {
      throw new CurrentFlowStateInvariantError("definition.dynamicTaskContainerId must identify a static node");
    }
    if (!dynamicContainer.steps.some((node) => node.id === this.dynamicTaskInsertionAfterId)) {
      throw new CurrentFlowStateInvariantError("definition.dynamicTaskInsertionAfterId must identify a direct dynamic-container child");
    }
    const staticNodes = collectDefinitionNodes(this.root);
    const staticLeaves = staticNodes.filter((node) => node.steps.length === 0);
    const insertionAnchor = dynamicContainer.steps.find((node) => node.id === this.dynamicTaskInsertionAfterId);
    const insertionAnchorLeaves = collectDefinitionNodes(insertionAnchor).filter((node) => node.steps.length === 0);
    const insertionPosition = staticLeaves.indexOf(insertionAnchorLeaves.at(-1)) + 0.5;
    for (const source of [...staticNodes, ...taskTemplateNodes]) {
      const targetId = source.action?.failurePolicy?.targetNodeId ?? null;
      if (targetId === null) continue;
      const target = staticLeaves.find((candidate) => candidate.id === targetId);
      if (!target || target.steps.length !== 0) {
        throw new CurrentFlowStateInvariantError(
          `definition failure policy target must identify a static leaf: ${targetId}`,
        );
      }
      const sourcePosition = staticNodes.includes(source)
        ? staticLeaves.indexOf(source)
        : insertionPosition;
      const targetPosition = staticLeaves.indexOf(target);
      if (targetPosition >= sourcePosition || !target.contract.permits("done", "in_progress")) {
        throw new CurrentFlowStateInvariantError(
          `definition failure policy target must be an earlier rewindable leaf: ${targetId}`,
        );
      }
    }
    this.#staticNodesById = new Map(staticNodes.map((node) => [node.id, node]));
    this.#taskTemplateNodesByKey = new Map(taskTemplateNodes.map((node) => [node.key, node]));
    this.#dynamicContainer = dynamicContainer;
    Object.freeze(this);
  }

  materializeRoot() {
    return this.root.materialize();
  }

  // A persisted state does not carry definition semantics. Every authority
  // boundary therefore discards the caller's binding and reconstructs the
  // value under the definition that owns that boundary.
  bindState(value) {
    const serialized = value instanceof CurrentFlowState
      ? CurrentFlowState.prototype.toJSON.call(value)
      : value;
    return new CurrentFlowState(serialized, { definition: this });
  }

  taskFrom({ id, key }) {
    const taskId = requireString(id, "task.id");
    return new TaskNode({
      kind: "task",
      id: taskId,
      key,
      status: "pending",
      result: null,
      attemptSequence: 0,
      steps: this.taskTemplate.steps.map((step) => materializeTaskStep(step, taskId)),
    });
  }

  contractFor(nodeId, root) {
    return this.contractForNode(findNodeInRoot(root, nodeId));
  }

  contractForNode(node) {
    return this.definitionNodeFor(node).contract;
  }

  actionFor(nodeId, root) {
    const node = findNodeInRoot(root, nodeId);
    if (!node) throw new CurrentFlowStateInvariantError(`definition action lookup requires a current-state node: ${nodeId}`);
    const action = this.definitionNodeFor(node).action;
    if (action === null) throw new CurrentFlowStateInvariantError(`definition action lookup requires a leaf node: ${nodeId}`);
    return action;
  }

  definitionNodeFor(node) {
    if (!node) throw new CurrentFlowStateInvariantError("definition lookup requires a current-state node");
    const staticNode = this.#staticNodesById.get(node.id);
    if (staticNode) return staticNode;
    if (node instanceof TaskNode) return this.taskTemplate;
    const template = this.#taskTemplateNodesByKey.get(node.key);
    if (template) return template;
    throw new CurrentFlowStateInvariantError(`definition has no node for current state: ${node.id}`);
  }

  isDynamicTaskNode(node) {
    return node instanceof TaskNode || this.#taskTemplateNodesByKey.has(node?.key);
  }

  pathFor(root, nodeId) {
    const pathIds = findPathInRoot(root, nodeId);
    if (pathIds === null) throw new CurrentFlowStateInvariantError(`definition path lookup requires a current-state node: ${nodeId}`);
    return Object.freeze(pathIds);
  }

  orderedLeaves(root) {
    this.assertStateShape(root);
    return Object.freeze(collectNodes(root).filter((node) => node.steps.length === 0));
  }

  nextExecutableLeaf(root) {
    return this.orderedLeaves(root).find((node) => EXECUTABLE_NODE_STATUSES.has(node.status)) ?? null;
  }

  taskInsertionIndex(container) {
    const staticContainer = this.#dynamicContainer;
    const anchor = staticContainer.steps.findIndex((node) => node.id === this.dynamicTaskInsertionAfterId);
    let index = anchor + 1;
    while (container.steps[index] instanceof TaskNode) index += 1;
    return index;
  }

  canAddTask(root) {
    const container = findNodeInRoot(root, this.dynamicTaskContainerId);
    const insertionIndex = this.taskInsertionIndex(container);
    return container.steps.slice(insertionIndex).every((node) => (
      collectNodes(node).filter((candidate) => candidate.steps.length === 0)
        .every((leaf) => leaf.status === "pending")
    ));
  }

  assertStateShape(root) {
    if (!(root instanceof FlowRootNode)) throw new CurrentFlowStateInvariantError("state.root must be a FlowRootNode");
    assertStaticShape(
      this.root,
      root,
      this.dynamicTaskContainerId,
      this.taskTemplate,
      this.dynamicTaskInsertionAfterId,
    );
  }
}

function collectDefinitionNodes(root, result = []) {
  result.push(root);
  for (const step of root.steps) collectDefinitionNodes(step, result);
  return result;
}

function assertStaticShape(definition, state, dynamicContainerId, taskTemplate, insertionAfterId) {
  if (definition.kind !== state.kind || definition.id !== state.id || definition.key !== state.key) {
    throw new CurrentFlowStateInvariantError(`state node does not match definition: ${definition.id}`);
  }
  if (definition.id === dynamicContainerId) {
    if (state.steps.length < definition.steps.length) {
      throw new CurrentFlowStateInvariantError("dynamic container is missing static definition nodes");
    }
    const anchorIndex = definition.steps.findIndex((node) => node.id === insertionAfterId);
    const taskStart = anchorIndex + 1;
    const taskCount = state.steps.length - definition.steps.length;
    for (const [index, staticNode] of definition.steps.slice(0, taskStart).entries()) {
      assertStaticShape(staticNode, state.steps[index], dynamicContainerId, taskTemplate, insertionAfterId);
    }
    for (const task of state.steps.slice(taskStart, taskStart + taskCount)) {
      if (!(task instanceof TaskNode)) throw new CurrentFlowStateInvariantError("dynamic container may contain Task nodes only");
      if (task.steps.length !== taskTemplate.steps.length) throw new CurrentFlowStateInvariantError("Task.steps does not match task template");
      for (const [index, step] of task.steps.entries()) {
        assertTaskStepShape(taskTemplate.steps[index], step, task.id);
      }
    }
    for (const [offset, staticNode] of definition.steps.slice(taskStart).entries()) {
      assertStaticShape(
        staticNode,
        state.steps[taskStart + taskCount + offset],
        dynamicContainerId,
        taskTemplate,
        insertionAfterId,
      );
    }
    return;
  }
  if (definition.steps.length !== state.steps.length) throw new CurrentFlowStateInvariantError(`state children do not match definition: ${definition.id}`);
  for (const [index, child] of state.steps.entries()) {
    assertStaticShape(definition.steps[index], child, dynamicContainerId, taskTemplate, insertionAfterId);
  }
}

function materializedTaskStepId(parentId, definitionId) {
  const suffix = definitionId.startsWith("task-") ? definitionId.slice("task-".length) : definitionId;
  return `${parentId}-${suffix}`;
}

function materializeTaskStep(definition, parentId) {
  const id = materializedTaskStepId(parentId, definition.id);
  return new StepNode({
    kind: "step",
    id,
    key: definition.key,
    status: "pending",
    result: null,
    attemptSequence: 0,
    steps: definition.steps.map((child) => materializeTaskStep(child, id)),
  });
}

function assertTaskStepShape(definition, state, parentId) {
  if (
    !(state instanceof StepNode)
    || state.id !== materializedTaskStepId(parentId, definition.id)
    || state.key !== definition.key
    || state.steps.length !== definition.steps.length
  ) {
    throw new CurrentFlowStateInvariantError("Task.steps does not match task template");
  }
  for (const [index, child] of state.steps.entries()) {
    assertTaskStepShape(definition.steps[index], child, state.id);
  }
}

function findNodeInRoot(root, nodeId) {
  return collectNodes(root).find((node) => node.id === nodeId) ?? null;
}

function findPathInRoot(root, nodeId, trail = []) {
  const pathIds = [...trail, root.id];
  if (root.id === nodeId) return pathIds;
  for (const step of root.steps) {
    const found = findPathInRoot(step, nodeId, pathIds);
    if (found !== null) return found;
  }
  return null;
}

export class FlowExecution {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("execution must be an object");
    const allowed = new Set(["mode", "baseBranch", "featureBranch"]);
    for (const field of Object.keys(value)) {
      if (!allowed.has(field)) throw new CurrentFlowStateInvariantError(`execution contains unsupported field: ${field}`);
    }
    if (!Object.hasOwn(value, "mode")) throw new CurrentFlowStateInvariantError("execution.mode is required");
    const { mode } = value;
    if (!EXECUTION_MODES.has(mode)) {
      throw new CurrentFlowStateInvariantError(`execution.mode is invalid: ${mode}`);
    }
    for (const field of ["baseBranch", "featureBranch"]) {
      if (value[field] !== undefined && value[field] !== null) requireString(value[field], `execution.${field}`);
    }
    this.mode = mode;
    this.baseBranch = value.baseBranch ?? null;
    this.featureBranch = value.featureBranch ?? null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      mode: this.mode,
      baseBranch: this.baseBranch,
      featureBranch: this.featureBranch,
    };
  }
}

export class CurrentCursor {
  constructor({ path: currentPath, attempt }) {
    if (!Array.isArray(currentPath) || currentPath.length === 0) {
      throw new CurrentFlowStateInvariantError("current.path must be a non-empty stable-id array");
    }
    this.path = Object.freeze(currentPath.map((id) => requireString(id, "current.path id")));
    this.attempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    Object.freeze(this);
  }

  toJSON() { return { path: [...this.path], attempt: this.attempt.toJSON() }; }
}

export class CurrentFailureDisposition {
  constructor({ attempt, decision, outcome, targetPath = null }) {
    if (!(attempt instanceof CurrentAttempt) || attempt.failure === null) {
      throw new CurrentFlowStateInvariantError("failure disposition requires a failed current Attempt");
    }
    if (!(decision instanceof DefinitionFailureDecision)) {
      throw new CurrentFlowStateInvariantError("failure disposition requires a definition-owned decision");
    }
    if (!["failed", "incomplete"].includes(outcome)) {
      throw new CurrentFlowStateInvariantError("failure disposition outcome must be failed or incomplete");
    }
    if (targetPath !== null && (!Array.isArray(targetPath) || targetPath.length === 0)) {
      throw new CurrentFlowStateInvariantError("failure disposition target path must be null or a stable-id path");
    }
    if ((decision.operation === "rewind") !== (targetPath !== null)) {
      throw new CurrentFlowStateInvariantError("rewind failure disposition requires exactly one target path");
    }
    if (targetPath !== null && targetPath.at(-1) !== decision.targetNodeId) {
      throw new CurrentFlowStateInvariantError("failure disposition path must end at the definition target node");
    }
    this.attemptId = attempt.id;
    this.sequence = attempt.sequence;
    this.policy = decision.policy;
    this.operation = decision.operation;
    this.outcome = outcome;
    this.retryKind = decision.retryKind;
    this.remaining = decision.remaining;
    this.targetPath = targetPath === null ? null : Object.freeze([...targetPath]);
    this.reason = decision.reason;
    Object.freeze(this);
  }

  toJSON() {
    return {
      attemptId: this.attemptId,
      sequence: this.sequence,
      policy: this.policy.toJSON(),
      operation: this.operation,
      outcome: this.outcome,
      retryKind: this.retryKind,
      remaining: this.remaining,
      targetPath: this.targetPath === null ? null : [...this.targetPath],
      reason: this.reason,
    };
  }
}

/** A definition-owned review continuation projected from persisted facts. */
export class DefinitionReviewDisposition {
  constructor({ operation, phase = null, attempts = null, maxAttempts = null, sourceFingerprints = [] } = {}) {
    if (!["repair-test-review", "repair-evidence-blocked", "retry", "defer", "external-blocked", "blocked"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("review disposition operation is invalid");
    }
    this.operation = operation;
    this.phase = phase == null ? null : requireString(phase, "review disposition phase");
    if (["blocked", "defer"].includes(operation)) {
      if (!Number.isSafeInteger(attempts) || attempts < 0) {
        throw new CurrentFlowStateInvariantError("bounded review disposition attempts must be non-negative");
      }
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new CurrentFlowStateInvariantError("bounded review disposition maxAttempts must be positive");
      }
    } else if (attempts !== null || maxAttempts !== null) {
      throw new CurrentFlowStateInvariantError("non-exhausted review disposition must not include retry accounting");
    }
    if (!Array.isArray(sourceFingerprints) || sourceFingerprints.some((value) => (
      typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)
    )) || new Set(sourceFingerprints).size !== sourceFingerprints.length) {
      throw new CurrentFlowStateInvariantError("review disposition source fingerprints are invalid");
    }
    if ((operation === "defer") !== (sourceFingerprints.length > 0)) {
      throw new CurrentFlowStateInvariantError("deferred review disposition requires source fingerprints");
    }
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
    this.sourceFingerprints = Object.freeze([...sourceFingerprints]);
    Object.freeze(this);
  }

  toJSON() {
    return {
      operation: this.operation,
      phase: this.phase,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      ...(this.sourceFingerprints.length === 0 ? {} : { sourceFingerprints: [...this.sourceFingerprints] }),
    };
  }
}

/** A definition-owned decision at the manual draft question boundary. */
export class DefinitionDraftDisposition {
  constructor({ operation, questionId = null, question = null, questionRevision = null } = {}) {
    if (!["execute-refine", "await-user-answer"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("draft disposition operation is invalid");
    }
    if (operation === "await-user-answer") {
      this.questionId = requireString(questionId, "draft disposition questionId");
      this.question = requireString(question, "draft disposition question");
      if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) {
        throw new CurrentFlowStateInvariantError("draft disposition questionRevision is invalid");
      }
      this.questionRevision = questionRevision;
    } else {
      if (questionId !== null || question !== null || questionRevision !== null) {
        throw new CurrentFlowStateInvariantError("execute draft disposition must not include a question");
      }
      this.questionId = null;
      this.question = null;
      this.questionRevision = null;
    }
    this.operation = operation;
    Object.freeze(this);
  }

  toJSON() {
    return {
      operation: this.operation,
      ...(this.questionId === null ? {} : {
        questionId: this.questionId,
        question: this.question,
        questionRevision: this.questionRevision,
      }),
    };
  }
}

/**
 * Read-only canonical snapshot for Definition-owned transition facts.
 * It deliberately contains only persisted Version Store values; callers may
 * use it to construct Step facts but may not mutate it into a route choice.
 */
function immutableSnapshotValue(value) {
  if (value === null || typeof value !== "object") return value;
  for (const entry of Object.values(value)) immutableSnapshotValue(entry);
  return Object.freeze(value);
}

export class CurrentFlowTransitionSnapshot {
  constructor({ state, revision, activities, catalog } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("canonical transition snapshot requires a current Flow state");
    }
    if (!Array.isArray(state.current) || state.current.length === 0 || state.attempt === null) {
      throw new CurrentFlowStateInvariantError("canonical transition snapshot requires an active Attempt");
    }
    if (!Array.isArray(activities)) throw new CurrentFlowStateInvariantError("canonical transition snapshot activities are required");
    if (typeof revision !== "string" || revision.length === 0) {
      throw new CurrentFlowStateInvariantError("canonical transition snapshot revision is required");
    }
    if (!Array.isArray(catalog)) throw new CurrentFlowStateInvariantError("canonical transition snapshot catalog is required");
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = state.current.at(-1);
    this.revision = revision;
    // CurrentFlowState is immutable by construction.  Preserve the typed
    // Version Store value rather than leaking a mutable JSON reconstruction.
    this.state = state;
    this.attempt = Object.freeze({
      id: state.attempt.id,
      sequence: state.attempt.sequence,
      consumption: Object.freeze(state.attempt.consumption.toJSON()),
    });
    this.activities = Object.freeze(activities.map((activity) => Object.freeze({
      id: activity.id,
      attemptId: activity.attemptId,
      sequence: activity.sequence,
      nodeId: activity.nodeId,
      transition: activity.transition == null ? null : immutableSnapshotValue(structuredClone(activity.transition)),
    })));
    this.catalog = Object.freeze(catalog.map((descriptor) => immutableSnapshotValue(structuredClone(descriptor))));
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      revision: this.revision,
      state: this.state.toJSON(),
      attempt: { ...this.attempt, consumption: { ...this.attempt.consumption } },
      activities: this.activities.map((activity) => structuredClone(activity)),
      catalog: this.catalog.map((descriptor) => structuredClone(descriptor)),
    };
  }
}

export class CurrentNextActionDescriptor {
  constructor({
    path: currentPath,
    node,
    operation,
    action,
    failureDisposition = null,
    reviewDisposition = null,
    draftDisposition = null,
  }) {
    if (!Array.isArray(currentPath) || currentPath.length === 0) {
      throw new CurrentFlowStateInvariantError("next action path must be a non-empty stable-id array");
    }
    if (!(node instanceof CurrentFlowNode)) {
      throw new CurrentFlowStateInvariantError("next action requires a current-state node");
    }
    if (!["start", "recover", "resume", "retry", "record", "rewind", "blocked", "resolve-step-definition"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("next action operation is invalid");
    }
    if (!(action instanceof DefinitionAction)) {
      throw new CurrentFlowStateInvariantError("next action requires definition-owned action metadata");
    }
    if (failureDisposition !== null && !(failureDisposition instanceof CurrentFailureDisposition)) {
      throw new CurrentFlowStateInvariantError("next action failure disposition is invalid");
    }
    if (["retry", "record", "rewind", "blocked", "resolve-step-definition"].includes(operation) !== (failureDisposition !== null)) {
      throw new CurrentFlowStateInvariantError("failed next action requires exactly one typed failure disposition");
    }
    if (reviewDisposition !== null && !(reviewDisposition instanceof DefinitionReviewDisposition)) {
      throw new CurrentFlowStateInvariantError("next action review disposition is invalid");
    }
    if (reviewDisposition !== null && (
      !node.id.endsWith("review")
      || !["resume", "retry", "record", "blocked"].includes(operation)
    )) {
      throw new CurrentFlowStateInvariantError("review disposition requires an active review descriptor");
    }
    if (draftDisposition !== null && !(draftDisposition instanceof DefinitionDraftDisposition)) {
      throw new CurrentFlowStateInvariantError("next action draft disposition is invalid");
    }
    if (draftDisposition !== null && (
      node.id !== "draft-refine"
      || !["start", "recover", "resume", "retry"].includes(operation)
    )) {
      throw new CurrentFlowStateInvariantError("draft disposition requires an executable draft-refine descriptor");
    }
    this.path = Object.freeze([...currentPath]);
    this.node = node;
    this.nodeId = node.id;
    this.nodeKey = node.key;
    this.status = node.status;
    this.operation = operation;
    this.action = action;
    this.failureDisposition = failureDisposition;
    this.reviewDisposition = reviewDisposition;
    this.draftDisposition = draftDisposition;
    Object.freeze(this);
  }

  withReviewDisposition(reviewDisposition) {
    if (reviewDisposition === null) return this;
    return new CurrentNextActionDescriptor({
      path: this.path,
      node: this.node,
      operation: this.operation,
      action: this.action,
      failureDisposition: this.failureDisposition,
      reviewDisposition,
      draftDisposition: this.draftDisposition,
    });
  }

  withDraftDisposition(draftDisposition) {
    if (draftDisposition === null) return this;
    return new CurrentNextActionDescriptor({
      path: this.path,
      node: this.node,
      operation: this.operation,
      action: this.action,
      failureDisposition: this.failureDisposition,
      reviewDisposition: this.reviewDisposition,
      draftDisposition,
    });
  }

  /** Whether this descriptor may materialize a fresh canonical Attempt. */
  get executable() {
    return ["start", "recover"].includes(this.operation);
  }

  /**
   * Keep the executable-frontier rule with the descriptor that selected it.
   * Callers must not duplicate the start/recover distinction when they only
   * need to prove that a passive successor may later be claimed.
   */
  assertPassiveExecutableTarget(nodeId) {
    if (!this.executable || this.nodeId !== requireString(nodeId, "passive executable target nodeId")) {
      throw new CurrentFlowStateInvariantError("target is not the canonical passive executable next action");
    }
    return this;
  }

  claim(attempt) {
    if (!this.executable) {
      throw new CurrentFlowStateInvariantError("only a canonical start or recover action may claim an Attempt");
    }
    return new ExecutableStepClaim({
      path: this.path,
      node: this.node,
      operation: this.operation,
      attempt,
      origin: this.operation,
    });
  }

  toJSON() {
    return {
      path: [...this.path],
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      status: this.status,
      operation: this.operation,
      action: this.action.toJSON(),
      failureDisposition: this.failureDisposition?.toJSON() ?? null,
      ...(this.reviewDisposition === null ? {} : { reviewDisposition: this.reviewDisposition.toJSON() }),
      ...(this.draftDisposition === null ? {} : { draftDisposition: this.draftDisposition.toJSON() }),
    };
  }
}

/**
 * A definition-authorized executable leaf and its exact Attempt episode.
 *
 * This is deliberately richer than a node id: a synthetic connector and a
 * normal command-context claim must agree on the same path, lifecycle
 * operation, Attempt identity, and activation origin before either can alter
 * the state tree.  `active` identifies an already materialized source;
 * `start` and `recover` identify the only passive operations that may be
 * materialized.
 */
export class ExecutableStepClaim {
  constructor({ path: currentPath, node, operation, attempt, origin } = {}) {
    if (!Array.isArray(currentPath) || currentPath.length === 0 || currentPath.at(-1) !== node?.id) {
      throw new CurrentFlowStateInvariantError("executable Step claim path must terminate at its node");
    }
    if (!(node instanceof CurrentFlowNode)) {
      throw new CurrentFlowStateInvariantError("executable Step claim requires a current-state node");
    }
    if (!["active", "start", "recover"].includes(operation) || operation !== origin) {
      throw new CurrentFlowStateInvariantError("executable Step claim operation and origin are invalid");
    }
    const currentAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (currentAttempt.nodeId !== node.id) {
      throw new CurrentFlowStateInvariantError("executable Step claim Attempt does not belong to its node");
    }
    const expectedSequence = operation === "active" ? node.attemptSequence : node.attemptSequence + 1;
    if (currentAttempt.sequence !== expectedSequence) {
      throw new CurrentFlowStateInvariantError("executable Step claim Attempt sequence is not canonical");
    }
    const expectedStatus = operation === "active"
      ? "in_progress"
      : operation === "start" ? "pending" : "invalidated";
    if (node.status !== expectedStatus) {
      throw new CurrentFlowStateInvariantError("executable Step claim lifecycle status is not canonical");
    }
    if (currentAttempt.failure !== null || currentAttempt.blocker !== null || currentAttempt.incomplete.length !== 0) {
      throw new CurrentFlowStateInvariantError("executable Step claim requires a runnable Attempt");
    }
    this.path = Object.freeze([...currentPath]);
    this.node = node;
    this.nodeId = node.id;
    this.operation = operation;
    this.origin = origin;
    this.attempt = currentAttempt;
    this.identity = new CurrentAttemptIdentity(currentAttempt);
    Object.freeze(this);
  }

  static active({ path: currentPath, node, attempt } = {}) {
    return new ExecutableStepClaim({
      path: currentPath,
      node,
      operation: "active",
      attempt,
      origin: "active",
    });
  }

  materialize(state) {
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("executable Step claim materialization requires CurrentFlowState");
    }
    if (this.operation === "active") return state;
    return this.operation === "recover"
      ? state.recover({ path: this.path, attempt: this.attempt })
      : state.startAttempt({ path: this.path, attempt: this.attempt });
  }

  toJSON() {
    return {
      path: [...this.path],
      nodeId: this.nodeId,
      operation: this.operation,
      origin: this.origin,
      attempt: this.identity.toJSON(),
    };
  }
}

export class CurrentRetryEligibility {
  constructor({ path, attempt, semanticRemaining, toolingRemaining }) {
    if (path !== null && (!Array.isArray(path) || path.length === 0)) {
      throw new CurrentFlowStateInvariantError("retry eligibility path must be null or a non-empty stable-id array");
    }
    if (attempt !== null && !(attempt instanceof CurrentAttempt)) {
      throw new CurrentFlowStateInvariantError("retry eligibility Attempt is invalid");
    }
    if (semanticRemaining !== null) requirePositiveInteger(semanticRemaining, "retry eligibility semanticRemaining", { allowZero: true });
    if (toolingRemaining !== null) requirePositiveInteger(toolingRemaining, "retry eligibility toolingRemaining", { allowZero: true });
    this.path = path === null ? null : Object.freeze([...path]);
    this.attempt = attempt;
    this.semanticRemaining = semanticRemaining;
    this.toolingRemaining = toolingRemaining;
    Object.freeze(this);
  }

  get active() { return this.attempt !== null; }
  get semantic() { return this.semanticRemaining !== null && this.semanticRemaining > 0; }
  get tooling() { return this.toolingRemaining !== null && this.toolingRemaining > 0; }

  toJSON() {
    return {
      path: this.path === null ? null : [...this.path],
      attemptId: this.attempt?.id ?? null,
      semantic: this.semantic,
      tooling: this.tooling,
      semanticRemaining: this.semanticRemaining,
      toolingRemaining: this.toolingRemaining,
    };
  }
}

export class CurrentRecoveryTarget {
  constructor({ path: currentPath, node, operation, legal, reason }) {
    if (!Array.isArray(currentPath) || currentPath.length === 0) {
      throw new CurrentFlowStateInvariantError("recovery target path must be a non-empty stable-id array");
    }
    if (!(node instanceof CurrentFlowNode)) {
      throw new CurrentFlowStateInvariantError("recovery target requires a current-state node");
    }
    if (!["rewind", "recover", "unavailable"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("recovery target operation is invalid");
    }
    if (typeof legal !== "boolean") throw new CurrentFlowStateInvariantError("recovery target legality must be boolean");
    this.path = Object.freeze([...currentPath]);
    this.nodeId = node.id;
    this.nodeKey = node.key;
    this.status = node.status;
    this.operation = operation;
    this.legal = legal;
    this.reason = requireString(reason, "recovery target reason");
    Object.freeze(this);
  }

  assertLegal() {
    if (!this.legal) throw new CurrentFlowStateInvariantError(`recovery target is not legal: ${this.reason}`);
    return this;
  }

  toJSON() {
    return {
      path: [...this.path],
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      status: this.status,
      operation: this.operation,
      legal: this.legal,
      reason: this.reason,
    };
  }
}

export class CurrentArtifactSource {
  constructor({ path: currentPath, node, artifact }) {
    if (!Array.isArray(currentPath) || currentPath.length === 0) {
      throw new CurrentFlowStateInvariantError("artifact source path must be a non-empty stable-id array");
    }
    if (!(node instanceof CurrentFlowNode)) throw new CurrentFlowStateInvariantError("artifact source requires a current-state node");
    if (!(artifact instanceof ArtifactReference)) throw new CurrentFlowStateInvariantError("artifact source requires a typed artifact reference");
    this.path = Object.freeze([...currentPath]);
    this.nodeId = node.id;
    this.nodeKey = node.key;
    this.artifact = artifact;
    Object.freeze(this);
  }

  toJSON() {
    return {
      path: [...this.path],
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      artifact: this.artifact.toJSON(),
    };
  }
}

export class CurrentArtifactResolution {
  constructor({ resourceKind, source = null }) {
    this.resourceKind = requireString(resourceKind, "artifact resolution resourceKind");
    if (source !== null && !(source instanceof CurrentArtifactSource)) {
      throw new CurrentFlowStateInvariantError("artifact resolution source must be typed or null");
    }
    this.source = source;
    Object.freeze(this);
  }

  get missing() { return this.source === null; }

  toJSON() {
    return {
      resourceKind: this.resourceKind,
      missing: this.missing,
      source: this.source?.toJSON() ?? null,
    };
  }
}

export class CurrentArtifactAuthority {
  constructor({ path: currentPath, node, execution, action, resolutions }) {
    if (!Array.isArray(currentPath) || currentPath.length === 0) {
      throw new CurrentFlowStateInvariantError("artifact authority path must be a non-empty stable-id array");
    }
    if (!(node instanceof CurrentFlowNode)) throw new CurrentFlowStateInvariantError("artifact authority requires a current-state node");
    if (!(execution instanceof FlowExecution)) throw new CurrentFlowStateInvariantError("artifact authority requires execution mode");
    if (!(action instanceof DefinitionAction)) throw new CurrentFlowStateInvariantError("artifact authority requires definition action metadata");
    if (!Array.isArray(resolutions) || resolutions.some((resolution) => !(resolution instanceof CurrentArtifactResolution))) {
      throw new CurrentFlowStateInvariantError("artifact authority requires typed resource resolutions");
    }
    this.path = Object.freeze([...currentPath]);
    this.nodeId = node.id;
    this.nodeKey = node.key;
    this.executionMode = execution.mode;
    this.requiredResources = Object.freeze([...action.contextKinds]);
    this.resolutions = Object.freeze([...resolutions]);
    Object.freeze(this);
  }

  toJSON() {
    return {
      path: [...this.path],
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      executionMode: this.executionMode,
      requiredResources: [...this.requiredResources],
      resolutions: this.resolutions.map((resolution) => resolution.toJSON()),
    };
  }
}

function assertLeafLifecycle(node, { allowsUnexecutedHistoricalSkip = () => false } = {}) {
  if (node.status === "pending" && node.attemptSequence !== 0) {
    throw new CurrentFlowStateInvariantError(`pending leaf must have a zero Attempt sequence cursor: ${node.id}`);
  }
  const unexecutedHistoricalSkip = allowsUnexecutedHistoricalSkip(node);
  if (unexecutedHistoricalSkip
    && (node.status !== "skipped" || node.attemptSequence !== 0 || node.result !== null)) {
    throw new CurrentFlowStateInvariantError(`historical unexecuted skip must be skipped with no Attempt or result: ${node.id}`);
  }
  if (unexecutedHistoricalSkip) return;
  if (TERMINAL_NODE_STATUSES.has(node.status) && node.attemptSequence === 0 && !unexecutedHistoricalSkip) {
    throw new CurrentFlowStateInvariantError(`terminal leaf requires an Attempt sequence cursor: ${node.id}`);
  }
  if (node.status === "done" && node.result?.outcome !== "passed") {
    throw new CurrentFlowStateInvariantError(`done leaf requires a passed result: ${node.id}`);
  }
  if (node.status === "skipped" && node.result?.outcome !== "skipped") {
    throw new CurrentFlowStateInvariantError(`skipped leaf requires a skipped result: ${node.id}`);
  }
  if (node.status === "failed" && !["failed", "incomplete"].includes(node.result?.outcome)) {
    throw new CurrentFlowStateInvariantError(`failed leaf requires a failed or incomplete result: ${node.id}`);
  }
  if (["pending", "in_progress", "invalidated"].includes(node.status) && node.result !== null) {
    throw new CurrentFlowStateInvariantError(`${node.status} leaf must not retain a result: ${node.id}`);
  }
}

function assertBranchLifecycle(node, options) {
  if (node.attemptSequence !== 0) {
    throw new CurrentFlowStateInvariantError(`branch node must not carry an Attempt sequence cursor: ${node.id}`);
  }
  for (const child of node.steps) assertNodeLifecycle(child, options);
  const childStatuses = node.steps.map((child) => child.status);
  const allTerminal = childStatuses.every((status) => TERMINAL_NODE_STATUSES.has(status));
  const allSkipped = childStatuses.every((status) => status === "skipped");
  const completionResult = [...node.steps].reverse().find((child) => child.result !== null)?.result ?? null;
  if (node.status === "pending") {
    if (node.result !== null || !childStatuses.every((status) => status === "pending")) {
      throw new CurrentFlowStateInvariantError(`pending branch must contain only pending children: ${node.id}`);
    }
    return;
  }
  if (node.status === "done") {
    if (!allTerminal || completionResult === null || !jsonEqual(node.result?.toJSON(), completionResult.toJSON())) {
      throw new CurrentFlowStateInvariantError(`done branch requires terminal children and the definition completion result: ${node.id}`);
    }
    return;
  }
  if (node.status === "skipped") {
    if (!allSkipped || completionResult === null || !jsonEqual(node.result?.toJSON(), completionResult.toJSON())) {
      throw new CurrentFlowStateInvariantError(`skipped branch requires skipped children and the definition completion result: ${node.id}`);
    }
    return;
  }
  if (node.status === "invalidated") {
    if (node.result !== null || !childStatuses.includes("invalidated")) {
      throw new CurrentFlowStateInvariantError(`invalidated branch requires an invalidated child and no result: ${node.id}`);
    }
    return;
  }
  if (node.status !== "in_progress") {
    throw new CurrentFlowStateInvariantError(`branch status is incompatible with completion lifecycle: ${node.id}`);
  }
  if (allTerminal) {
    throw new CurrentFlowStateInvariantError(`in_progress branch cannot retain an all-terminal child set: ${node.id}`);
  }
  if (!childStatuses.some((status) => status !== "pending")) {
    throw new CurrentFlowStateInvariantError(`in_progress branch requires progressed child state: ${node.id}`);
  }
}

function assertNodeLifecycle(node, options = {}) {
  if (node.steps.length === 0) {
    assertLeafLifecycle(node, options);
  } else {
    assertBranchLifecycle(node, options);
  }
}

function assertExecutionFrontier(leaves, currentPath, nodes) {
  const taskIdByLeafId = new Map();
  const fullyPendingTaskIds = new Set();
  for (const node of nodes) {
    if (!(node instanceof TaskNode)) continue;
    const taskLeaves = collectNodes(node).filter((candidate) => candidate.steps.length === 0);
    if (taskLeaves.every((leaf) => leaf.status === "pending")) fullyPendingTaskIds.add(node.id);
    for (const leaf of taskLeaves) taskIdByLeafId.set(leaf.id, node.id);
  }
  const finalizationDownstreamRoute = currentPath?.at(-1) === "finalize-merge";
  let frontier = null;
  let suffixStatus = null;
  let taskGateRepairPendingSuffix = false;
  for (const [index, leaf] of leaves.entries()) {
    if (TERMINAL_NODE_STATUSES.has(leaf.status)) {
      if (frontier !== null) {
        if (finalizationDownstreamRoute
          && leaf.status === "skipped"
          && ["finalize-sync", "finalize-cleanup"].includes(leaf.id)) {
          continue;
        }
        throw new CurrentFlowStateInvariantError(`execution frontier cannot contain terminal ${leaf.id} after unfinished work`);
      }
      continue;
    }
    if (frontier === null) {
      frontier = { index, status: leaf.status };
      if (leaf.status !== "in_progress") suffixStatus = leaf.status;
      continue;
    }
    if (frontier.status === "in_progress" && index === frontier.index) continue;
    if (taskGateRepairPendingSuffix) {
      if (leaf.status !== "pending") {
        throw new CurrentFlowStateInvariantError("execution frontier must have one active leaf and a uniform pending or invalidated suffix");
      }
      continue;
    }
    if (suffixStatus === null) suffixStatus = leaf.status;
    // A dedicated add_approval_task Activity may insert pending dynamic Tasks
    // into an invalidated definition-owned suffix. Those Tasks remain valid
    // after approval confirms and while the earlier invalidated leaves recover.
    // Generic add_task cannot create this shape because its guard is unchanged;
    // the Activity journal proves the dedicated admission route.
    const leafTaskId = taskIdByLeafId.get(leaf.id) ?? null;
    const frontierTaskId = taskIdByLeafId.get(leaves[frontier.index].id) ?? null;
    const approvalRecoveryTask = suffixStatus === "invalidated"
      && leaf.status === "pending"
      && leafTaskId !== null
      && fullyPendingTaskIds.has(leafTaskId);
    // A sealed Task Gate repair leaves the current Task's unfinished suffix
    // invalidated while later Task/Flow leaves stay pending. The mixed suffix
    // remains valid between its impl, Review, and Gate Attempts; the typed
    // repair transition is the only operation that can create this shape.
    const taskGateRepairSuffix = suffixStatus === "invalidated"
      && leaf.status === "pending"
      && frontierTaskId !== null
      && leafTaskId !== frontierTaskId;
    if (taskGateRepairSuffix) {
      taskGateRepairPendingSuffix = true;
      continue;
    }
    if (approvalRecoveryTask) continue;
    if (!EXECUTABLE_NODE_STATUSES.has(suffixStatus) || leaf.status !== suffixStatus) {
      throw new CurrentFlowStateInvariantError("execution frontier must have one active leaf and a uniform pending or invalidated suffix");
    }
  }
  if (frontier?.status === "in_progress") {
    if (currentPath === null || leaves[frontier.index].id !== currentPath.at(-1)) {
      throw new CurrentFlowStateInvariantError("execution frontier active leaf must match current path");
    }
  } else if (currentPath !== null) {
    throw new CurrentFlowStateInvariantError("current path requires the execution frontier active leaf");
  }
}

export class CurrentFlowState {
  #nodes;
  #leaves;

  constructor(value, { definition }) {
    if (!(definition instanceof CurrentFlowDefinition)) {
      throw new CurrentFlowStateInvariantError("CurrentFlowState requires a CurrentFlowDefinition");
    }
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("flow state must be an object");
    for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
      if (Object.hasOwn(value, field)) throw new CurrentFlowStateInvariantError(`flow state must not contain ${field}`);
    }
    requireExactFields(value, STATE_FIELDS, "flow state");
    if (value.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
      throw new CurrentFlowStateInvariantError(`unsupported schemaRevision: ${value.schemaRevision}`);
    }
    if (value.version !== 1) throw new CurrentFlowStateInvariantError("flow Version must be exactly 1");
    this.schemaRevision = value.schemaRevision;
    this.identity = new CurrentFlowIdentity(value);
    this.flowId = this.identity.flowId.toString();
    this.flowVersionId = this.identity.flowVersionId.toString();
    this.runId = this.identity.runId.toString();
    this.specId = this.identity.specId.toString();
    this.issue = this.identity.issue;
    if (typeof value.request !== "string") {
      throw new CurrentFlowStateInvariantError("request must be a string");
    }
    this.request = value.request;
    this.version = value.version;
    this.lifecycle = value.lifecycle instanceof CurrentFlowLifecycle
      ? value.lifecycle
      : new CurrentFlowLifecycle(value.lifecycle);
    this.execution = value.execution instanceof FlowExecution ? value.execution : new FlowExecution(value.execution);
    this.policy = value.policy instanceof CurrentFlowPolicy ? value.policy : new CurrentFlowPolicy(value.policy);
    this.root = new FlowRootNode(rootNodeValue(value));
    this.definition = definition;
    this.history = value.history === null
      ? null
      : value.history instanceof CurrentFlowHistory ? value.history : new CurrentFlowHistory(value.history);
    this.#nodes = Object.freeze(collectNodes(this.root));
    this.#leaves = Object.freeze(this.#nodes.filter((node) => node.steps.length === 0));
    if (value.current !== null && typeof value.current !== "string") {
      throw new CurrentFlowStateInvariantError("current must be a stable node id or null");
    }
    this.current = value.current == null
      ? null
      : this.history === null
        ? this.definitionPathForCurrent(value.current)
        : this.historicalPathForCurrent(value.current);
    this.attempt = value.attempt == null ? null : value.attempt instanceof CurrentAttempt ? value.attempt : new CurrentAttempt(value.attempt);
    this.confirmationOrder = requirePositiveInteger(value.confirmationOrder, "confirmationOrder", { allowZero: true });
    this.artifacts = value.artifacts instanceof CurrentFlowArtifacts ? value.artifacts : new CurrentFlowArtifacts(value.artifacts);
    this.outbox = value.outbox instanceof CurrentFlowOutbox ? value.outbox : new CurrentFlowOutbox(value.outbox);
    this.context = value.context instanceof CurrentFlowContext ? value.context : new CurrentFlowContext(value.context);
    this.#assertCurrent();
    Object.freeze(this);
  }

  static create({
    definition,
    execution = { mode: "direct" },
    version = CURRENT_FLOW_RESULT_VERSION,
    flowId = "flow",
    flowVersionId = "flow-v1",
    runId = "run",
    specId = "spec",
    issue = null,
    request = "",
    lifecycle = { state: "active" },
    policy = { autoApprove: false, nonblocking: null },
    artifacts = [],
    outbox = [],
    context = null,
    history = null,
  }) {
    if (!(definition instanceof CurrentFlowDefinition)) {
      throw new CurrentFlowStateInvariantError("CurrentFlowState.create requires a CurrentFlowDefinition");
    }
    const root = definition.materializeRoot();
    return new CurrentFlowState({
      schemaRevision: CURRENT_FLOW_SCHEMA_REVISION,
      flowId,
      flowVersionId,
      runId,
      specId,
      issue,
      request,
      version,
      lifecycle,
      execution,
      policy,
      ...root.toJSON(),
      current: null,
      attempt: null,
      confirmationOrder: 0,
      artifacts,
      outbox,
      context,
      history,
    }, { definition });
  }

  definitionPathForCurrent(currentId) {
    const id = requireString(currentId, "current id");
    const pathFor = this.definition?.pathFor?.(this.root, id);
    if (!pathFor) throw new CurrentFlowStateInvariantError("current must identify a state node");
    return Object.freeze([...pathFor]);
  }

  historicalPathForCurrent(currentId) {
    const id = requireString(currentId, "current id");
    const pathFor = findPathInRoot(this.root, id);
    if (pathFor === null) throw new CurrentFlowStateInvariantError("current must identify a historical state node");
    return Object.freeze([...pathFor]);
  }

  #assertCurrent() {
    if (this.history !== null) {
      this.#assertHistorical();
      return;
    }
    this.#assertDefinitionCurrent();
  }

  /** Shared current-state invariants for fresh and resumed historical Flows. */
  #assertDefinitionCurrent() {
    this.#assertDefinitionStateShapeAndStatuses();
    assertNodeLifecycle(this.root);
    this.#assertDefinitionExecutionCurrent();
  }

  #assertDefinitionStateShapeAndStatuses() {
    this.definition.assertStateShape(this.root);
    const all = this.#nodes;
    const ids = new Set();
    for (const node of all) {
      if (ids.has(node.id)) throw new CurrentFlowStateInvariantError(`state duplicates stable id: ${node.id}`);
      ids.add(node.id);
      if (!this.definition.contractForNode(node).permitsStatus(node.status)) {
        throw new CurrentFlowStateInvariantError(
          `state status is unreachable in the definition transition graph for ${node.id}: ${node.status}`,
        );
      }
    }
  }

  #assertDefinitionExecutionCurrent() {
    const all = this.#nodes;
    assertExecutionFrontier(this.#leaves, this.current, this.#nodes);
    if (this.lifecycle.state === "finalized") {
      if (this.current !== null || this.attempt !== null) {
        throw new CurrentFlowStateInvariantError("finalized Flow must not retain an active Attempt");
      }
      if (this.outbox.values.length !== 0) {
        throw new CurrentFlowStateInvariantError("finalized Flow must not retain unfinished outbox operations");
      }
      if (all.some((node) => node.steps.length === 0 && !TERMINAL_NODE_STATUSES.has(node.status))) {
        throw new CurrentFlowStateInvariantError("finalized Flow requires every leaf to be terminal");
      }
    }
    const activeLeaves = all.filter((node) => node.steps.length === 0 && node.status === "in_progress");
    if (this.current == null) {
      if (this.attempt !== null) throw new CurrentFlowStateInvariantError("attempt requires a current path");
      if (activeLeaves.length !== 0) throw new CurrentFlowStateInvariantError("an in-progress leaf requires current path and attempt");
      return;
    }
    if (this.attempt == null) throw new CurrentFlowStateInvariantError("current path requires an active Attempt");
    const leaf = nodeAtPath(this.root, this.current);
    if (leaf.steps.length !== 0) throw new CurrentFlowStateInvariantError("current.path must end at a leaf");
    if (leaf.status !== "in_progress") throw new CurrentFlowStateInvariantError("current leaf must be in_progress");
    if (leaf.attemptSequence !== this.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("current Attempt sequence must match the active leaf cursor");
    }
    if (this.attempt.nodeId !== leaf.id) {
      throw new CurrentFlowStateInvariantError("current Attempt nodeId must match the active leaf cursor");
    }
    this.#assertAttemptContractForLeaf(leaf, this.attempt);
    if (activeLeaves.length !== 1 || activeLeaves[0].id !== leaf.id) {
      throw new CurrentFlowStateInvariantError("current path must identify the sole active leaf");
    }
    for (const id of this.current.slice(0, -1)) {
      if (findNodeInRoot(this.root, id).status !== "in_progress") {
        throw new CurrentFlowStateInvariantError("every current path ancestor must be in_progress");
      }
    }
  }

  #assertHistorical() {
    const nodes = this.#nodes;
    const ids = new Set();
    for (const node of nodes) {
      if (ids.has(node.id)) throw new CurrentFlowStateInvariantError(`historical state duplicates stable id: ${node.id}`);
      ids.add(node.id);
    }
    if (this.history.resumed) {
      this.#assertHistoricalContinuation();
      return;
    }
    if (this.current === null && this.attempt !== null) {
      throw new CurrentFlowStateInvariantError("historical Attempt requires a saved current path");
    }
    if (this.attempt !== null) {
      const leaf = nodeAtPath(this.root, this.current);
      if (leaf.steps.length !== 0 || leaf.status !== "in_progress") {
        throw new CurrentFlowStateInvariantError("historical live Attempt requires an in-progress saved leaf");
      }
      if (this.attempt.nodeId !== leaf.id || this.attempt.sequence !== leaf.attemptSequence) {
        throw new CurrentFlowStateInvariantError("historical live Attempt must match its saved leaf cursor");
      }
      this.assertTransitionHandler(leaf.id);
      this.#assertAttemptContractForLeaf(leaf, this.attempt);
    }
    this.#assertHistoricalCreationAuthority();
  }

  #assertHistoricalContinuation() {
    this.#assertDefinitionStateShapeAndStatuses();
    const continuation = this.history.continuation;
    const boundaryIndex = this.#leaves.findIndex((leaf) => leaf.id === continuation.nodeId);
    if (boundaryIndex < 0 || this.#leaves[boundaryIndex].attemptSequence < continuation.attemptSequence) {
      throw new CurrentFlowStateInvariantError("historical continuation boundary is absent or predates its admitted Attempt");
    }
    if (this.confirmationOrder + 1 < continuation.confirmationOrder) {
      throw new CurrentFlowStateInvariantError("historical continuation boundary is ahead of its admitted Activity order");
    }
    const prefix = this.#leaves.slice(0, boundaryIndex);
    const actualUnexecutedSkips = prefix
      .filter((leaf) => leaf.status === "skipped" && leaf.attemptSequence === 0 && leaf.result === null)
      .map((leaf) => leaf.id);
    const admitted = new Set(continuation.unexecutedSkipLeafIds);
    if (continuation.unexecutedSkipLeafIds.some((id) => !prefix.some((leaf) => leaf.id === id))) {
      throw new CurrentFlowStateInvariantError("historical continuation prefix no longer contains an admitted unexecuted skip");
    }
    if (actualUnexecutedSkips.some((id) => !admitted.has(id))) {
      throw new CurrentFlowStateInvariantError("historical continuation has an unadmitted unexecuted skip");
    }
    assertNodeLifecycle(this.root, {
      allowsUnexecutedHistoricalSkip: (leaf) => admitted.has(leaf.id)
        && leaf.status === "skipped"
        && leaf.attemptSequence === 0
        && leaf.result === null,
    });
    this.#assertDefinitionExecutionCurrent();
    this.#assertHistoricalCreationAuthority();
  }

  #assertHistoricalCreationAuthority() {
    if (this.history.creation.status === "available" && this.confirmationOrder < 1) {
      throw new CurrentFlowStateInvariantError("historical Flow with creation authority requires its first confirmed Activity order");
    }
  }

  /** Preconditions for admitting a saved dormant cursor into a new Attempt. */
  #assertHistoricalContinuationPrefix() {
    this.#assertDefinitionStateShapeAndStatuses();
    const boundaryIndex = this.current === null
      ? -1
      : this.#leaves.findIndex((leaf) => leaf.id === this.current.at(-1));
    if (boundaryIndex < 0) {
      throw new CurrentFlowStateInvariantError("historical continuation requires a production leaf cursor");
    }
    const allowed = new Set(this.#leaves.slice(0, boundaryIndex)
      .filter((leaf) => leaf.status === "skipped" && leaf.attemptSequence === 0 && leaf.result === null)
      .map((leaf) => leaf.id));
    assertNodeLifecycle(this.root, { allowsUnexecutedHistoricalSkip: (leaf) => allowed.has(leaf.id) });
    assertExecutionFrontier(this.#leaves, this.current, this.#nodes);
  }

  #canResumeHistoricalContinuation() {
    try {
      this.#assertHistoricalContinuationPrefix();
      return true;
    } catch (error) {
      if (error instanceof CurrentFlowStateInvariantError) return false;
      throw error;
    }
  }

  /**
   * Imported history can contain retired nodes. A new Activity is allowed
   * only when its saved target is still owned by the production definition.
   * This runs before journal append; historical state has no separate
   * read-only lifecycle.
   */
  assertTransitionHandler(nodeId = this.current?.at(-1) ?? this.root.id) {
    const node = this.findNode(requireString(nodeId, "transition handler nodeId"));
    if (node === null) {
      throw new CurrentFlowStateInvariantError("transition handler requires a saved state node");
    }
    try {
      this.definition.definitionNodeFor(node);
      if (node.id !== this.root.id && node.steps.length === 0) this.definition.actionFor(node.id, this.root);
    } catch (error) {
      throw new CurrentFlowStateInvariantError(
        `current Flow definition has no handler for historical node ${node.id}: ${error.message}`,
      );
    }
    return this;
  }

  findNode(id) {
    return findNodeInRoot(this.root, id);
  }

  park() {
    this.assertTransitionHandler(this.root.id);
    if (this.lifecycle.state !== "active") {
      throw new CurrentFlowStateInvariantError("only an active Flow may be parked");
    }
    return this.#replaceLifecycle("parked");
  }

  resume() {
    this.assertTransitionHandler(this.root.id);
    if (this.lifecycle.state !== "parked") {
      throw new CurrentFlowStateInvariantError("only a parked Flow may be resumed");
    }
    return this.#replaceLifecycle("active");
  }

  withPolicy(policy) {
    this.assertTransitionHandler(this.root.id);
    if (this.lifecycle.state === "finalized") {
      throw new CurrentFlowStateInvariantError("finalized Flow policy is immutable");
    }
    const next = policy instanceof CurrentFlowPolicy ? policy : new CurrentFlowPolicy(policy);
    return new CurrentFlowState({
      ...this.toJSON(),
      policy: next.toJSON(),
    }, { definition: this.definition });
  }

  withOutbox(outbox) {
    this.assertTransitionHandler(this.root.id);
    if (this.lifecycle.state === "finalized") {
      throw new CurrentFlowStateInvariantError("finalized Flow outbox is immutable");
    }
    const next = outbox instanceof CurrentFlowOutbox ? outbox : new CurrentFlowOutbox(outbox);
    return new CurrentFlowState({
      ...this.toJSON(),
      outbox: next.toJSON(),
    }, { definition: this.definition });
  }

  /** One atomic recovery: settle sync's pending outbox, skip sync, claim cleanup. */
  recoverInterruptedFinalizeSync({ outbox, cleanupAttempt, confirmedAt }) {
    this.#assertExecutionActive();
    if (this.current?.at(-1) !== "finalize-sync" || this.attempt === null) {
      throw new CurrentFlowStateInvariantError("interrupted finalize-sync recovery requires the active sync Attempt");
    }
    const sync = this.findNode("finalize-sync");
    const cleanup = this.findNode("finalize-cleanup");
    if (sync?.status !== "in_progress" || cleanup?.status !== "pending") throw new CurrentFlowStateInvariantError("interrupted finalize-sync recovery has an invalid step boundary");
    if (outbox.operation !== "finalize-sync" || this.outbox.find(outbox.id) === null) throw new CurrentFlowStateInvariantError("interrupted finalize-sync recovery requires its pending outbox identity");
    const settled = this.withOutbox(this.outbox.settle(outbox.toEntry()));
    const skippedRoot = reconcileCompletedParents(replaceNode(settled.root, "finalize-sync", sync.with({
      status: "skipped", attemptSequence: sync.attemptSequence,
      result: new NodeResult({ outcome: "skipped", summary: "interrupted finalize-sync settled", confirmedAt, artifactRefs: [] }),
    })), settled.definition);
    const skipped = settled.#replaceRoot(skippedRoot, null, null);
    const expected = skipped.definition.nextExecutableLeaf(skipped.root);
    if (expected?.id !== "finalize-cleanup") throw new CurrentFlowStateInvariantError("interrupted finalize-sync recovery must claim cleanup next");
    return skipped.startAttempt({ path: skipped.definition.pathFor(skipped.root, "finalize-cleanup"), attempt: cleanupAttempt });
  }

  /**
   * Apply the definition-authorized finalization suffix transition while the
   * finalize-merge Attempt remains active.  This is one journaled operation,
   * not a sequence of foreign Step patches that would violate Attempt owner
   * authority.
   */
  finalizeDownstream({ stepIds, status, confirmedAt }) {
    this.#assertExecutionActive();
    if (this.current?.at(-1) !== "finalize-merge") {
      throw new CurrentFlowStateInvariantError("finalization downstream transition requires the active finalize-merge Attempt");
    }
    if (!Array.isArray(stepIds) || stepIds.length === 0 || !["skipped", "pending"].includes(status)) {
      throw new CurrentFlowStateInvariantError("finalization downstream transition is invalid");
    }
    if (status === "skipped") requireIso(confirmedAt, "finalization downstream confirmedAt");
    let root = this.root;
    for (const stepId of stepIds) {
      const node = findNodeInRoot(root, stepId);
      if (node === null) throw new CurrentFlowStateInvariantError(`finalization downstream Step is absent: ${stepId}`);
      if (!["finalize-sync", "finalize-cleanup"].includes(stepId)) {
        throw new CurrentFlowStateInvariantError(`finalization downstream Step is not authorized: ${stepId}`);
      }
      const allowed = status === "skipped" ? ["pending"] : ["skipped"];
      if (!allowed.includes(node.status)) {
        throw new CurrentFlowStateInvariantError(`finalization downstream ${stepId} must be ${allowed[0]}, got ${node.status}`);
      }
      // This pair is a definition-owned finalization route, not an ordinary
      // worker result transition.  Its dedicated Activity is the authority
      // that permits the otherwise-illegal pending↔skipped recovery pair.
      root = replaceNode(root, stepId, status === "skipped"
        ? node.with({
            status,
            attemptSequence: node.attemptSequence + 1,
            result: new NodeResult({
              outcome: "skipped",
              summary: "finalize-merge downstream route skipped",
              confirmedAt,
              artifactRefs: [],
            }),
          })
        : node.with({ status, attemptSequence: 0, result: null }));
    }
    return this.#replaceRoot(reconcileCompletedParents(root, this.definition), this.current, this.attempt);
  }

  finalize() {
    if (this.lifecycle.state !== "active") {
      throw new CurrentFlowStateInvariantError("only an active Flow may be finalized");
    }
    if (this.current !== null || this.attempt !== null) {
      throw new CurrentFlowStateInvariantError("cannot finalize a Flow with an active Attempt");
    }
    if (this.#leaves.some((node) => !TERMINAL_NODE_STATUSES.has(node.status))) {
      throw new CurrentFlowStateInvariantError("cannot finalize a Flow with unfinished leaves");
    }
    return this.#replaceLifecycle("finalized");
  }

  addTask({ id, key }) {
    this.#assertExecutionActive();
    const container = this.findNode(this.definition.dynamicTaskContainerId);
    if (!container) throw new CurrentFlowStateInvariantError("dynamic Task container is missing");
    if (this.findNode(id)) throw new CurrentFlowStateInvariantError(`dynamic Task duplicates stable id: ${id}`);
    if (!this.definition.canAddTask(this.root)) {
      throw new CurrentFlowStateInvariantError("dynamic Task insertion is closed after the definition-owned flow suffix begins");
    }
    if (this.current !== null && this.current.at(-1) !== "approval") {
      throw new CurrentFlowStateInvariantError("dynamic Task insertion requires no active Attempt outside approval");
    }
    return this.#insertTask(container, { id, key });
  }

  /**
   * Replay the one parent-owned Task admission route that is available while
   * an approval Attempt is active.  Its Activity carries the durable intent;
   * the preceding recovery Activity is verified before this transition is
   * committed and again while the journal is replayed.
   */
  admitApprovalTask(task, { priorActivities = [] } = {}) {
    const { id, key, approvalSource } = task;
    this.#assertExecutionActive();
    const container = this.findNode(this.definition.dynamicTaskContainerId);
    if (!container) throw new CurrentFlowStateInvariantError("dynamic Task container is missing");
    if (this.findNode(id)) throw new CurrentFlowStateInvariantError(`dynamic Task duplicates stable id: ${id}`);
    approvalTaskAdmissionRoute(this, priorActivities);
    if (!(approvalSource instanceof ApprovalTaskSourceBinding)) {
      throw new CurrentFlowStateInvariantError("approval Task admission requires its durable source binding");
    }
    approvalSource.assertPriorActivities(priorActivities);
    return this.#insertTask(container, { id, key });
  }

  #insertTask(container, { id, key }) {
    const task = this.definition.taskFrom({ id, key });
    const insertionIndex = this.definition.taskInsertionIndex(container);
    return this.#replaceRoot(replaceNode(this.root, container.id, container.withSteps([
      ...container.steps.slice(0, insertionIndex),
      task,
      ...container.steps.slice(insertionIndex),
    ])));
  }

  startAttempt({ path: currentPath, attempt }) {
    const dormantHistoricalCursor = this.history !== null
      && this.current !== null
      && this.attempt === null
      && jsonEqual(this.current, currentPath);
    if (dormantHistoricalCursor) {
      const target = nodeAtPath(this.root, currentPath);
      this.assertTransitionHandler(target.id);
      if (target.status !== "in_progress") {
        throw new CurrentFlowStateInvariantError("dormant historical cursor must retain an in-progress leaf before it can start an Attempt");
      }
      return this.#activateAttempt({
        path: currentPath,
        attempt,
        allowedLeafStatuses: ["in_progress"],
        initial: true,
        operation: "startAttempt",
      });
    }
    const expected = this.definition.nextExecutableLeaf(this.root);
    if (!expected || expected.id !== currentPath?.at(-1) || expected.status !== "pending") {
      throw new CurrentFlowStateInvariantError("startAttempt must target the definition-owned next executable leaf");
    }
    return this.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["pending"],
      initial: true,
      operation: "startAttempt",
    });
  }

  retryCurrentAttempt({ attempt, kind }) {
    this.#assertExecutionActive();
    if (this.current == null || this.attempt == null) {
      throw new CurrentFlowStateInvariantError("retryCurrentAttempt requires an active Attempt");
    }
    if (this.attempt.failure === null || !this.attempt.failure.retryable) {
      throw new CurrentFlowStateInvariantError("retryCurrentAttempt requires a retryable failed active Attempt");
    }
    if (this.failureDisposition().operation !== "retry") {
      throw new CurrentFlowStateInvariantError("the definition failure policy does not authorize retry");
    }
    return this.#replaceFailedAttemptForRetry({ attempt, kind });
  }

  /** Gate retry is admitted by definition.js, not the generic failure policy. */
  retryGateAttempt({ attempt }) {
    this.#assertExecutionActive();
    const leaf = this.current === null ? null : nodeAtPath(this.root, this.current);
    const task = this.current === null ? null : this.findNode(this.current.at(-2));
    const taskGate = task instanceof TaskNode && leaf?.id === `${task.id}-gate`;
    if (leaf === null || (!new Set(["draft-gate", "spec-gate", "impl-gate"]).has(leaf.id) && !taskGate)
      || this.attempt?.failure?.category !== "semantic") {
      throw new CurrentFlowStateInvariantError("definition-owned Gate retry requires a failed semantic Gate Attempt");
    }
    return this.#replaceFailedAttemptForRetry({ attempt, kind: "semantic" });
  }

  /** Replay the repair episode already admitted by the typed Step Definition. */
  retryFinalRegressionAttempt({ attempt }) {
    const leaf = this.current === null ? null : nodeAtPath(this.root, this.current);
    if (leaf?.id !== "final-regression"
      || this.attempt?.failure?.category !== "caused_by_current_change"
      || this.attempt.failure.retryKind !== "semantic") {
      throw new CurrentFlowStateInvariantError("final-regression repair requires a current-change failed Attempt");
    }
    return this.#replaceFailedAttemptForRetry({ attempt, kind: "semantic" });
  }

  #replaceFailedAttemptForRetry({ attempt, kind }) {
    this.#assertExecutionActive();
    if (this.current == null || this.attempt == null) {
      throw new CurrentFlowStateInvariantError("retryCurrentAttempt requires an active Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    const next = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (this.attempt.failure === null || !this.attempt.failure.retryable) {
      throw new CurrentFlowStateInvariantError("retryCurrentAttempt requires a retryable failed active Attempt");
    }
    if (kind !== this.attempt.failure.retryKind) {
      throw new CurrentFlowStateInvariantError("retry kind must match the active Attempt failure decision");
    }
    if (next.nodeId !== leaf.id) {
      throw new CurrentFlowStateInvariantError("retry Attempt nodeId must match the active leaf");
    }
    this.#assertAttemptForLeaf(leaf, next, { previous: this.attempt, kind });
    const root = replaceNode(this.root, leaf.id, leaf.with({ attemptSequence: next.sequence }));
    return this.#resumeHistoricalContinuation({ root, current: this.current, attempt: next });
  }

  failCurrentAttempt({ failure, result }) {
    this.#assertExecutionActive();
    if (this.current == null || this.attempt == null) {
      throw new CurrentFlowStateInvariantError("failCurrentAttempt requires an active Attempt");
    }
    if (this.attempt.failure !== null) {
      throw new CurrentFlowStateInvariantError("active Attempt failure is already recorded");
    }
    const recorded = failure instanceof ActivityFailure ? failure : new ActivityFailure(failure);
    const completed = result instanceof NodeResult ? result : new NodeResult(result);
    if (!["failed", "incomplete"].includes(completed.outcome)) {
      throw new CurrentFlowStateInvariantError("failed Attempt result must be failed or incomplete");
    }
    const hasIncompleteWork = this.attempt.incomplete.length > 0;
    if ((completed.outcome === "incomplete") !== hasIncompleteWork) {
      throw new CurrentFlowStateInvariantError(
        "incomplete Attempt result and typed incomplete operation/resource claims must agree",
      );
    }
    const leaf = nodeAtPath(this.root, this.current);
    const replacement = this.attempt.replaceFacts({ failure: recorded });
    this.#assertAttemptContractForLeaf(leaf, replacement);
    return this.#replaceRoot(this.root, this.current, replacement);
  }

  recordCurrentFailure({ result }) {
    this.#assertExecutionActive();
    if (this.current === null || this.attempt === null || this.attempt.failure === null) {
      throw new CurrentFlowStateInvariantError("recordCurrentFailure requires a failed active Attempt");
    }
    const disposition = this.failureDisposition();
    if (disposition.operation !== "record") {
      throw new CurrentFlowStateInvariantError("the definition failure policy does not authorize recording this failure");
    }
    const recorded = result instanceof NodeResult ? result : new NodeResult(result);
    if (recorded.outcome !== disposition.outcome) {
      throw new CurrentFlowStateInvariantError("recorded failure result must match the active failure outcome");
    }
    const leafId = this.current.at(-1);
    const leaf = this.findNode(leafId);
    const root = reconcileCompletedParents(
      replaceNode(this.root, leafId, transitionNode(leaf, "failed", this.definition, { result: recorded })),
      this.definition,
    );
    return this.#replaceRoot(root, null, null);
  }

  replaceCurrentAttempt({ attempt }) {
    this.#assertExecutionActive();
    if (this.current == null || this.attempt == null) {
      throw new CurrentFlowStateInvariantError("replaceCurrentAttempt requires an active Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    const replacement = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (this.attempt.failure !== null) {
      throw new CurrentFlowStateInvariantError("failed Attempt facts are immutable; retry or recovery is required");
    }
    if (
      replacement.id !== this.attempt.id
      || replacement.nodeId !== this.attempt.nodeId
      || replacement.sequence !== this.attempt.sequence
      || replacement.startedAt !== this.attempt.startedAt
      || replacement.consumption.semantic !== this.attempt.consumption.semantic
      || replacement.consumption.tooling !== this.attempt.consumption.tooling
      || !jsonEqual(replacement.failure?.toJSON() ?? null, this.attempt.failure?.toJSON() ?? null)
    ) {
      throw new CurrentFlowStateInvariantError("active Attempt replacement must preserve attempt identity and retry consumption");
    }
    this.#assertAttemptContractForLeaf(leaf, replacement);
    return this.#replaceRoot(this.root, this.current, replacement);
  }

  recoverTaskGateClassification({ attempt, priorActivities, activityId }) {
    this.#assertExecutionActive();
    if (this.current == null || this.attempt == null || this.attempt.failure?.category !== "tooling") {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery requires a tooling-failed active Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    const taskId = this.current.at(-2) ?? null;
    const task = taskId === null ? null : this.findNode(taskId);
    if (task?.kind !== "task" || leaf.id !== `${task.id}-gate`) {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery requires the active Task Gate");
    }
    const replacement = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    const expectedReplacement = { ...this.attempt.toJSON(), failure: null };
    if (!isDeepStrictEqual(replacement.toJSON(), expectedReplacement)) {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery must preserve the exact Attempt except its tooling failure");
    }
    const history = priorActivities.filter((activity) => (
      activity.nodeId === leaf.id
      && activity.attemptId === this.attempt.id
      && activity.sequence === this.attempt.sequence
    ));
    const publications = history.filter((activity) => activity.transition.operation === "publish_artifacts");
    const failures = history.filter((activity) => activity.transition.operation === "fail_attempt");
    const recoveries = history.filter((activity) => activity.transition.operation === TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION);
    if (publications.length !== 1 || failures.length !== 1 || recoveries.length !== 0
      || publications[0].confirmationOrder >= failures[0].confirmationOrder
      || !isDeepStrictEqual(failures[0].failure?.toJSON?.() ?? failures[0].failure, this.attempt.failure.toJSON())) {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery requires one published result followed by its tooling failure");
    }
    const identity = new TaskGateClassificationRecoveryIdentity({
      publicationActivityId: publications[0].id,
      failedActivityId: failures[0].id,
      attempt: this.attempt,
    });
    if (activityId !== identity.activityId) {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery Activity identity is invalid");
    }
    return this.#resumeHistoricalContinuation({ root: this.root, current: this.current, attempt: replacement });
  }

  /** Start the single audited reevaluation granted by a durable receipt. */
  retryExhaustedAttempt({ attempt }) {
    this.#assertExecutionActive();
    if (this.current === null || this.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError("exhausted retry requires a failed active Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    const next = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    const contract = this.definition.contractForNode(leaf);
    if (next.nodeId !== leaf.id || next.sequence !== this.attempt.sequence + 1 || next.failure !== null) {
      throw new CurrentFlowStateInvariantError("exhausted retry Attempt identity is invalid");
    }
    const toolingRecovery = this.attempt.failure.retryKind === "tooling"
      || this.attempt.failure.category === "tooling"
      || this.attempt.failure.category === "provider";
    if (!toolingRecovery || next.consumption.tooling !== (contract.toolingRetryLimit ?? 0)) {
      throw new CurrentFlowStateInvariantError("exhausted retry recovery requires a fully consumed tooling budget");
    }
    this.#assertAttemptContractForLeaf(leaf, next);
    return this.#resumeHistoricalContinuation({
      root: replaceNode(this.root, leaf.id, leaf.with({ attemptSequence: next.sequence })),
      current: this.current,
      attempt: next,
    });
  }

  /**
   * Restore the failed producer cursor when an older build recorded it and
   * illegally claimed its consumer without publishing the required cataloged
   * result.  This is intentionally not a generic status patch: the caller
   * supplies the original failed Attempt. A claimed consumer is invalidated
   * with its suffix; a record-to-claim crash has no consumer Attempt and
   * instead restores only the failed producer cursor.
   */
  recoverMissingProducerArtifact({ path: producerPath, attempt }) {
    this.#assertExecutionActive();
    const producer = nodeAtPath(this.root, producerPath);
    const restored = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (producer.steps.length !== 0 || producer.id !== restored.nodeId) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery must restore its exact producer leaf");
    }
    if (producer.status !== "failed" || producer.attemptSequence !== restored.sequence || restored.failure === null) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery requires the recorded failed producer Attempt");
    }
    const consumer = this.current?.at(-1) ?? null;
    if ((consumer === null) !== (this.attempt === null)) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery has an invalid active cursor");
    }
    const leaves = this.#leaves;
    const producerIndex = leaves.findIndex((node) => node.id === producer.id);
    if (producerIndex < 0) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery requires a definition producer leaf");
    }
    if (consumer === null) {
      if (leaves.slice(producerIndex + 1).some((node) => !["pending", "invalidated"].includes(node.status))) {
        throw new CurrentFlowStateInvariantError("missing producer artifact recovery cannot cross a completed downstream leaf");
      }
      let root = replaceNode(
        this.root,
        producer.id,
        transitionNode(producer, "in_progress", this.definition, { result: null }),
      );
      root = reconcileInvalidatedParents(root, this.definition);
      for (const id of producerPath) {
        const node = findNodeInRoot(root, id);
        if (node.status !== "in_progress") {
          root = replaceNode(root, id, transitionNode(node, "in_progress", this.definition, { result: null }));
        }
      }
      return this.#resumeHistoricalContinuation({ root, current: producerPath, attempt: restored });
    }
    const consumerIndex = leaves.findIndex((node) => node.id === consumer);
    if (consumerIndex <= producerIndex) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery requires a downstream consumer");
    }
    let root = this.root;
    for (const id of leaves.slice(producerIndex + 1).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    const source = findNodeInRoot(root, producer.id);
    root = replaceNode(root, source.id, transitionNode(source, "in_progress", this.definition, { result: null }));
    root = reconcileInvalidatedParents(root, this.definition);
    for (const id of producerPath) {
      const node = findNodeInRoot(root, id);
      if (node.status !== "in_progress") {
        root = replaceNode(root, id, transitionNode(node, "in_progress", this.definition, { result: null }));
      }
    }
    return this.#resumeHistoricalContinuation({ root, current: producerPath, attempt: restored });
  }

  #assertTaskGateLifecycle({ leafId, gateTaskLifecycle, operation }) {
    const container = this.findNode(this.definition.dynamicTaskContainerId);
    const tasks = container?.steps.filter((node) => node instanceof TaskNode) ?? [];
    const taskIndex = tasks.findIndex((task) => task.steps.some((step) => step.id === leafId));
    if (taskIndex < 0) {
      if (gateTaskLifecycle !== null) {
        throw new CurrentFlowStateInvariantError("non-Task Gate transition cannot carry a Task lifecycle effect");
      }
      return null;
    }
    const task = tasks[taskIndex];
    const expectedStepIds = ["impl", "review", "triage", "repair", "gate"].map((role) => `${task.id}-${role}`);
    if (leafId !== expectedStepIds[4]) {
      if (gateTaskLifecycle !== null) {
        throw new CurrentFlowStateInvariantError("Task lifecycle effects may target only a materialized Task Gate");
      }
      return null;
    }
    if (task.steps.length !== expectedStepIds.length
      || task.steps.some((step, index) => step.id !== expectedStepIds[index])) {
      throw new CurrentFlowStateInvariantError("Task Gate lifecycle requires its exact materialized Task Step identity");
    }
    if (gateTaskLifecycle === null || typeof gateTaskLifecycle !== "object"
      || gateTaskLifecycle.operation !== operation
      || gateTaskLifecycle.taskId !== task.id
      || !Array.isArray(gateTaskLifecycle.resetStepIds)
      || gateTaskLifecycle.resetStepIds.length !== 0) {
      throw new CurrentFlowStateInvariantError("Task Gate transition requires its exact sealed lifecycle effect");
    }
    const leaves = this.definition.orderedLeaves(this.root);
    const gateIndex = leaves.findIndex((candidate) => candidate.id === leafId);
    const successorStepId = gateIndex < 0 ? null : leaves.slice(gateIndex + 1)
      .find((candidate) => candidate.status === "pending" || candidate.status === "invalidated")?.id ?? null;
    if (successorStepId === null) {
      throw new CurrentFlowStateInvariantError("Task Gate lifecycle has no canonical executable successor");
    }
    if (gateTaskLifecycle.successorStepId !== successorStepId) {
      throw new CurrentFlowStateInvariantError("Task Gate lifecycle successor does not match the persisted Task frontier");
    }
    return Object.freeze({ taskId: task.id, successorStepId });
  }

  #assertTaskGateSuccessor(next, lifecycle) {
    if (lifecycle === null) return;
    const task = next.findNode(lifecycle.taskId);
    if (!(task instanceof TaskNode) || task.status !== "done") {
      throw new CurrentFlowStateInvariantError("Task Gate lifecycle did not complete its Task atomically");
    }
    const successor = next.nextAction();
    if (successor?.nodeId !== lifecycle.successorStepId) {
      throw new CurrentFlowStateInvariantError("Task Gate lifecycle did not reach its sealed successor");
    }
  }

  assertAttemptConfirmable() {
    this.#assertExecutionActive();
    if (this.current == null) throw new CurrentFlowStateInvariantError("confirmCurrentAttempt requires an active Attempt");
    if (this.attempt.failure !== null) {
      throw new CurrentFlowStateInvariantError("a failed Attempt cannot be confirmed without a new retry Attempt");
    }
    if (this.attempt.blocker !== null || this.attempt.incomplete.length > 0) {
      throw new CurrentFlowStateInvariantError("a blocked or incomplete Attempt cannot be confirmed");
    }
    return this;
  }

  confirmCurrentAttempt({ result, status = "done", gateTaskLifecycle = null }) {
    this.assertAttemptConfirmable();
    if (!NODE_STATUSES.has(status) || !["done", "skipped"].includes(status)) {
      throw new CurrentFlowStateInvariantError("confirmed current Attempt status must be done or skipped");
    }
    const confirmed = result instanceof NodeResult ? result : new NodeResult(result);
    if (status === "done" && confirmed.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("done confirmation requires a passed result");
    }
    if (status === "skipped" && confirmed.outcome !== "skipped") {
      throw new CurrentFlowStateInvariantError("skipped confirmation requires a skipped result");
    }
    const leafId = this.current.at(-1);
    const lifecycle = this.#assertTaskGateLifecycle({
      leafId,
      gateTaskLifecycle,
      operation: "complete-and-advance",
    });
    const leaf = this.findNode(leafId);
    const root = reconcileCompletedParents(
      replaceNode(this.root, leafId, transitionNode(leaf, status, this.definition, { result: confirmed })),
      this.definition,
    );
    const next = this.#replaceRoot(root, null, null);
    this.#assertTaskGateSuccessor(next, lifecycle);
    return next;
  }

  /** Apply one sealed Task review/triage/repair connector as a single state change. */
  completeTaskReviewStage({ result, plan, targetAttempt = null }) {
    this.assertAttemptConfirmable();
    if (!(plan instanceof TaskReviewStageTransitionPlan)) {
      throw new CurrentFlowStateInvariantError("Task Review stage completion requires a sealed Definition plan");
    }
    const binding = plan.facts.binding;
    if (binding.runId !== this.runId || binding.specId !== this.specId
      || this.current?.at(-1) !== binding.sourceStepId || this.attempt === null
      || this.attempt.id !== binding.attemptId || this.attempt.sequence !== binding.attemptSequence) {
      throw new CurrentFlowStateInvariantError("Task Review stage plan does not bind the active canonical Attempt");
    }
    const task = this.findNode(binding.taskId);
    const expectedStepIds = ["impl", "review", "triage", "repair", "gate"]
      .map((role) => `${binding.taskId}-${role}`);
    if (!(task instanceof TaskNode)
      || task.steps.length !== expectedStepIds.length
      || task.steps.some((step, index) => step.id !== expectedStepIds[index])) {
      throw new CurrentFlowStateInvariantError("Task Review stage plan requires the canonical five-Step Task shape");
    }
    const completed = result instanceof NodeResult ? result : new NodeResult(result);
    if (completed.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("Task Review stage completion requires a passed producer result");
    }
    if (plan.operation === "task-rounds-exhausted") {
      if (plan.effects.length !== 0 || plan.terminalReason === null) {
        throw new CurrentFlowStateInvariantError("Task round exhaustion must retain its active stage with a reason");
      }
      return this.failCurrentAttempt({
        failure: {
          category: "semantic",
          code: "TASK_ROUNDS_EXHAUSTED",
          message: plan.terminalReason,
          retryable: false,
          retryKind: null,
        },
        result: {
          outcome: "failed",
          summary: plan.terminalReason,
          confirmedAt: completed.confirmedAt,
          artifactRefs: [],
        },
      });
    }
    const seen = new Set();
    let root = this.root;
    for (const effect of plan.effects) {
      if (!expectedStepIds.includes(effect.stepId) || seen.has(effect.stepId)) {
        throw new CurrentFlowStateInvariantError("Task Review stage plan effects must uniquely target the bound Task");
      }
      seen.add(effect.stepId);
      const node = findNodeInRoot(root, effect.stepId);
      if (effect.status === "done") {
        if (effect.stepId !== binding.sourceStepId) {
          throw new CurrentFlowStateInvariantError("Task Review stage plan may complete only its source Step");
        }
        root = replaceNode(root, node.id, transitionNode(node, "done", this.definition, { result: completed }));
      } else if (effect.status === "skipped") {
        root = replaceNode(root, node.id, transitionNode(node, "skipped", this.definition, {
          attemptSequence: node.attemptSequence + 1,
          result: new NodeResult({
            outcome: "skipped",
            summary: effect.reason,
            confirmedAt: completed.confirmedAt,
            artifactRefs: [],
          }),
        }));
      } else {
        root = replaceNode(root, node.id, transitionNode(node, "invalidated", this.definition, { result: null }));
      }
    }
    if (!seen.has(binding.sourceStepId)) {
      throw new CurrentFlowStateInvariantError("Task Review stage plan must settle or invalidate its source Step");
    }
    root = reconcileCompletedParents(root, this.definition);
    root = reconcileInvalidatedParents(root, this.definition);
    const next = this.#replaceRoot(root, null, null);
    const selected = next.nextAction()?.nodeId ?? null;
    if (plan.targetStepId !== null && selected !== plan.targetStepId) {
      throw new CurrentFlowStateInvariantError("Task Review stage plan did not expose its selected target");
    }
    if (plan.targetStepId === null && plan.operation !== "review-no-change-complete"
      && plan.operation !== "triage-no-change-complete") {
      throw new CurrentFlowStateInvariantError("Task Review stage plan has no selected target");
    }
    if (plan.targetStepId === null) {
      if (targetAttempt !== null) throw new CurrentFlowStateInvariantError("terminal Task Review stage plan forbids a target Attempt");
      return next;
    }
    if (targetAttempt === null) throw new CurrentFlowStateInvariantError("advancing Task Review stage plan requires a target Attempt");
    const targetPath = next.definition.pathFor(next.root, plan.targetStepId);
    if (targetPath === null) throw new CurrentFlowStateInvariantError("Task Review stage target is absent");
    return next.#activateAttempt({
      path: targetPath,
      attempt: targetAttempt,
      allowedLeafStatuses: [next.findNode(plan.targetStepId).status],
      initial: true,
      operation: "completeTaskReviewStage",
    });
  }

  completeAcceptanceDecisionNoOp({ result }) {
    if (this.current?.at(-1) !== "acceptance-decision" || this.attempt === null) {
      throw new CurrentFlowStateInvariantError("acceptance decision no-op requires its active Attempt");
    }
    return this.confirmCurrentAttempt({ result, status: "done" });
  }

  /** Complete the source and atomically expose the Definition-selected successor. */
  completeDraftCompletion({ result, receipt }) {
    this.#assertExecutionActive();
    const connection = receipt instanceof ActivityStepConnectionReceipt ? receipt : new ActivityStepConnectionReceipt(receipt);
    if (connection.sourceStepId !== "draft-coverage-repair" || connection.targetStepId !== "draft-gate") {
      throw new CurrentFlowStateInvariantError("draft completion receipt has an invalid connector route");
    }
    const completed = result instanceof NodeResult ? result : new NodeResult(result);
    const source = this.findNode(connection.sourceStepId);
    const activeSource = this.current?.at(-1) === connection.sourceStepId;
    let sourceClaim;
    if (activeSource) {
      if (this.attempt === null || this.attempt.id !== connection.sourceAttempt.id || this.attempt.sequence !== connection.sourceAttempt.sequence) {
        throw new CurrentFlowStateInvariantError("draft completion receipt source Attempt is stale");
      }
      sourceClaim = this.executableStepClaim({
        nodeId: connection.sourceStepId,
        attempt: this.attempt,
      });
    } else {
      if (this.current !== null) {
        throw new CurrentFlowStateInvariantError("draft completion has no definition-authorized source Attempt");
      }
      const requiredResources = this.definition.contractForNode(source).resourceContract.required;
      const sourceAttempt = new CurrentAttempt({
        id: connection.sourceAttempt.id, nodeId: source.id, sequence: connection.sourceAttempt.sequence,
        startedAt: completed.confirmedAt, consumption: { semantic: 0, tooling: 0 },
        failure: null, blocker: null, incomplete: [],
        operationClaims: requiredResources.length === 0 ? [] : [{ operation: "resolve-command-context", resources: requiredResources }],
      });
      sourceClaim = this.executableStepClaim({ nodeId: source.id, attempt: sourceAttempt });
    }
    if (sourceClaim.operation !== "active") {
      return sourceClaim.materialize(this).completeDraftCompletion({ result: completed, receipt: connection });
    }
    const root = reconcileCompletedParents(
      replaceNode(this.root, source.id, transitionNode(source, "done", this.definition, {
        result: completed, attemptSequence: connection.sourceAttempt.sequence,
      })),
      this.definition,
    );
    const settled = this.#replaceRoot(root, null, null);
    settled.assertPassiveExecutableTarget(connection.targetStepId);
    return settled;
  }

  /**
   * Complete final-regression from an explicit, evidence-bound operator
   * acceptance.  The accepted result is a new Attempt episode so the failed
   * producer Attempt and its immutable artifact history are never rewritten.
   */
  acceptFinalRegressionFailure({ attempt, result }) {
    this.#assertExecutionActive();
    if (this.current === null || this.current.at(-1) !== "final-regression" || this.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError(
        "final-regression acceptance requires its failed active Attempt",
      );
    }
    const leaf = nodeAtPath(this.root, this.current);
    const acceptedAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (
      acceptedAttempt.nodeId !== leaf.id
      || acceptedAttempt.sequence !== this.attempt.sequence + 1
      || acceptedAttempt.sequence !== leaf.attemptSequence + 1
      || acceptedAttempt.id === this.attempt.id
      || acceptedAttempt.failure !== null
      || acceptedAttempt.consumption.semantic !== 0
      || acceptedAttempt.consumption.tooling !== 0
    ) {
      throw new CurrentFlowStateInvariantError("final-regression acceptance Attempt identity is invalid");
    }
    this.#assertAttemptContractForLeaf(leaf, acceptedAttempt);
    const accepted = result instanceof NodeResult ? result : new NodeResult(result);
    if (accepted.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("final-regression acceptance requires a passed lifecycle result");
    }
    const root = reconcileCompletedParents(
      replaceNode(this.root, leaf.id, transitionNode(leaf, "done", this.definition, {
        attemptSequence: acceptedAttempt.sequence,
        result: accepted,
      })),
      this.definition,
    );
    return this.#replaceRoot(root, null, null);
  }

  /** Complete a failed Task Review through a distinct deferred settlement Attempt. */
  deferFailedReview({ attempt, result }) {
    this.#assertExecutionActive();
    if (this.current === null || this.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError("Review deferral requires a failed active Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    if (!leaf.id.endsWith("-review")) {
      throw new CurrentFlowStateInvariantError("Review deferral requires an active Review leaf");
    }
    const settlementAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (
      settlementAttempt.nodeId !== leaf.id
      || settlementAttempt.sequence !== this.attempt.sequence + 1
      || settlementAttempt.sequence !== leaf.attemptSequence + 1
      || settlementAttempt.id === this.attempt.id
      || settlementAttempt.failure !== null
      || settlementAttempt.consumption.semantic !== 0
      || settlementAttempt.consumption.tooling !== 0
    ) {
      throw new CurrentFlowStateInvariantError("Review deferral settlement Attempt identity is invalid");
    }
    this.#assertAttemptContractForLeaf(leaf, settlementAttempt);
    const settled = result instanceof NodeResult ? result : new NodeResult(result);
    if (settled.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("Review deferral requires a passed lifecycle result");
    }
    const root = reconcileCompletedParents(
      replaceNode(this.root, leaf.id, transitionNode(leaf, "done", this.definition, {
        attemptSequence: settlementAttempt.sequence,
        result: settled,
      })),
      this.definition,
    );
    return this.#replaceRoot(root, null, null);
  }

  /** Settle an exhausted Gate with its finding in the same Store transaction. */
  deferFailedGate({ attempt, result, gateTaskLifecycle = null }) {
    this.#assertExecutionActive();
    const leaf = this.current === null ? null : nodeAtPath(this.root, this.current);
    const lifecycle = leaf === null ? null : this.#assertTaskGateLifecycle({
      leafId: leaf.id,
      gateTaskLifecycle,
      operation: "defer-and-advance",
    });
    if (leaf === null || (!new Set(["draft-gate", "spec-gate", "impl-gate"]).has(leaf.id) && lifecycle === null)
      || this.attempt?.failure?.category !== "semantic") {
      throw new CurrentFlowStateInvariantError("Gate deferral requires a failed semantic Gate Attempt");
    }
    const settlementAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (settlementAttempt.nodeId !== leaf.id || settlementAttempt.sequence !== this.attempt.sequence + 1
      || settlementAttempt.sequence !== leaf.attemptSequence + 1 || settlementAttempt.id === this.attempt.id
      || settlementAttempt.failure !== null || settlementAttempt.consumption.semantic !== 0
      || settlementAttempt.consumption.tooling !== 0) {
      throw new CurrentFlowStateInvariantError("Gate deferral settlement Attempt identity is invalid");
    }
    this.#assertAttemptContractForLeaf(leaf, settlementAttempt);
    const settled = result instanceof NodeResult ? result : new NodeResult(result);
    if (settled.outcome !== "passed") throw new CurrentFlowStateInvariantError("Gate deferral requires a passed lifecycle result");
    const root = reconcileCompletedParents(
      replaceNode(this.root, leaf.id, transitionNode(leaf, "done", this.definition, {
        attemptSequence: settlementAttempt.sequence, result: settled,
      })), this.definition,
    );
    const next = this.#replaceRoot(root, null, null);
    this.#assertTaskGateSuccessor(next, lifecycle);
    return next;
  }

  /** Restore the exact failed Task Gate frontier before an extra repair ran. */
  recoverTaskExecutionOverrun({ attempt, priorActivities = [], references = null }) {
    this.#assertExecutionActive();
    const currentId = this.current?.at(-1) ?? null;
    const taskId = this.current?.at(-2) ?? null;
    if (typeof taskId !== "string" || currentId !== `${taskId}-impl` || this.attempt === null) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires the active Task implementation Attempt");
    }
    if (attempt?.id !== this.attempt.id || attempt?.sequence !== this.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery Attempt changed before settlement");
    }
    const task = this.findNode(taskId);
    const stepIds = ["impl", "review", "triage", "repair", "gate"].map((role) => `${taskId}-${role}`);
    if (!(task instanceof TaskNode) || !Array.isArray(task.steps) || task.steps.length !== stepIds.length
      || task.steps.some((step, index) => step.id !== stepIds[index])) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires canonical materialized Task Steps");
    }
    const repairReferences = references?.repairs?.filter((reference) => (
      reference.label === "stale plan-gate-repair Activity"
    )) ?? [];
    if (repairReferences.length !== 1) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires exactly one referenced plan_gate_repair Activity");
    }
    const repair = priorActivities.find((entry) => entry.id === repairReferences[0].id) ?? null;
    if (repair?.transition?.operation !== "plan_gate_repair"
      || repair.nodeId !== currentId
      || repair.attemptId !== this.attempt.id
      || repair.sequence !== this.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires the untouched preceding plan_gate_repair Activity");
    }
    const triageId = `${taskId}-triage`;
    const repairId = `${taskId}-repair`;
    const gateId = `${taskId}-gate`;
    if (references?.evaluations?.length !== 1) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires exactly one referenced Gate failure Activity");
    }
    const failureReference = references.evaluations[0];
    const failure = priorActivities.find((entry) => entry.id === failureReference.id) ?? null;
    if (failure?.transition?.operation !== "fail_attempt" || failure.nodeId !== gateId
      || failure.failure?.category !== "semantic" || failureReference.label !== failure.failure.code) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery Gate failure reference is invalid");
    }
    if (failure === null) throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires the prior semantic Gate failure");
    let prior = freshStateLike(this, this.definition);
    const replayed = [];
    for (const entry of priorActivities) {
      if (entry.confirmationOrder >= repair.confirmationOrder) break;
      prior = applyCanonicalActivity(prior, entry, replayed);
      replayed.push(entry);
    }
    if (prior.current?.at(-1) !== gateId
      || prior.attempt?.id !== failure.attemptId
      || prior.attempt?.sequence !== failure.sequence
      || prior.attempt?.failure?.code !== failure.failure.code) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires the exact prior failed Gate frontier");
    }
    let root = this.root;
    for (const stepId of stepIds) {
      const former = prior.findNode(stepId);
      const current = findNodeInRoot(root, stepId);
      root = replaceNode(root, stepId, transitionNode(current, former.status, this.definition, { result: former.result }));
    }
    root = reconcileCompletedParents(root, this.definition);
    const restoredAttempt = prior.attempt;
    const path = this.definition.pathFor(root, gateId);
    if (path === null) throw new CurrentFlowStateInvariantError("Task execution overrun recovery Gate path is absent");
    return this.#resumeHistoricalContinuation({ root, current: path, attempt: restoredAttempt });
  }

  /** Apply the route-specific skips authorized by an immutable advisory decision. */
  continueNonblockingAttempt({ result, skippedNodeIds }) {
    const continuationResult = result instanceof NodeResult ? result : new NodeResult(result);
    const confirmed = this.confirmCurrentAttempt({ result: continuationResult, status: "done" });
    if (!Array.isArray(skippedNodeIds)) {
      throw new CurrentFlowStateInvariantError("nonblocking continuation skipped nodes must be an array");
    }
    let root = confirmed.root;
    for (const id of skippedNodeIds) {
      const node = findNodeInRoot(root, requireString(id, "nonblocking continuation skipped nodeId"));
      if (node === null || node.steps.length !== 0 || node.status !== "pending") {
        throw new CurrentFlowStateInvariantError("nonblocking continuation may skip only pending route leaves");
      }
      root = replaceNode(root, node.id, node.with({
        status: "skipped",
        attemptSequence: node.attemptSequence + 1,
        result: new NodeResult({
          outcome: "skipped",
          summary: "explicit nonblocking continuation",
          confirmedAt: continuationResult.confirmedAt,
          artifactRefs: [],
        }),
      }));
    }
    return confirmed.#replaceRoot(reconcileCompletedParents(root, confirmed.definition), null, null);
  }

  rewind({ path: currentPath, attempt }) {
    this.#assertExecutionActive();
    const recovery = this.recoveryTarget(currentPath).assertLegal();
    if (recovery.operation !== "rewind") {
      throw new CurrentFlowStateInvariantError("rewind requires a terminal recovery target");
    }
    const target = nodeAtPath(this.root, currentPath);
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === target.id);
    const downstreamIds = new Set(leaves.slice(targetIndex + 1).map((node) => node.id));
    let root = this.root;
    for (const id of downstreamIds) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["done", "skipped", "failed", "invalidated"],
      initial: true,
      operation: "rewind",
    });
  }

  /**
   * One Definition-selected scenario repair settles the rejected producer
   * Attempt and opens the governed test handoff in the same Activity.  The
   * durable Activity retains the failure facts while the new episode starts
   * with fresh retry consumption.
   */
  repairScenarioValidity({ path: currentPath, attempt, failure, result }) {
    this.#assertExecutionActive();
    if (this.current?.at(-1) !== "scenario-validity" || this.attempt === null) {
      throw new CurrentFlowStateInvariantError("scenario repair requires its active scenario-validity Attempt");
    }
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "test") {
      throw new CurrentFlowStateInvariantError("scenario repair must reopen the governed test handoff");
    }
    const recordedFailure = failure instanceof ActivityFailure ? failure : new ActivityFailure(failure);
    if (recordedFailure.code !== "SCENARIO_VALIDITY_REJECTED" || recordedFailure.category !== "semantic") {
      throw new CurrentFlowStateInvariantError("scenario repair requires the Definition-selected semantic rejection");
    }
    const failed = this.failCurrentAttempt({ failure: recordedFailure, result });
    return failed.rewind({ path: currentPath, attempt });
  }

  /**
   * Replace stale test evidence at the integration gate or retro. This route
   * is fixed by the definition: callers cannot use it as a generic state
   * mutator.
   * Historical producer artifacts remain in the catalog; the replacement
   * test-execute Attempt publishes the current evidence on its own history.
   */
  rewindTestEvidence({ path: currentPath, attempt }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "test-execute") {
      throw new CurrentFlowStateInvariantError("test evidence rewind target must be test-execute");
    }
    const sourceId = this.current?.at(-1) ?? null;
    if (this.current === null || this.attempt === null || !new Set(["impl-gate", "retro"]).has(sourceId)) {
      throw new CurrentFlowStateInvariantError("test evidence rewind requires an active impl-gate or retro Attempt");
    }
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === target.id);
    const sourceIndex = leaves.findIndex((node) => node.id === sourceId);
    if (targetIndex < 0 || sourceIndex < targetIndex) {
      throw new CurrentFlowStateInvariantError("test evidence rewind route is absent from the Flow definition");
    }
    let root = this.root;
    for (const id of leaves.slice(targetIndex).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: "rewindTestEvidence",
    });
  }

  /**
   * Re-open the test-design worker from a rejected test-review Attempt.  The
   * route is fixed and invalidates the definition suffix so the execution
   * frontier remains a single active leaf followed by one uniform state.
   */
  repairTestReview({ path: currentPath, attempt }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "test") {
      throw new CurrentFlowStateInvariantError("test-review repair target must be test");
    }
    if (this.current === null || this.attempt === null || this.current.at(-1) !== "test-review") {
      throw new CurrentFlowStateInvariantError("test-review repair requires an active test-review Attempt");
    }
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === "test");
    const sourceIndex = leaves.findIndex((node) => node.id === "test-review");
    if (targetIndex < 0 || sourceIndex < targetIndex) {
      throw new CurrentFlowStateInvariantError("test-review repair route is absent from the Flow definition");
    }
    let root = this.root;
    for (const id of leaves.slice(targetIndex).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    return this.#replaceRoot(root, null, null).#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: "repairTestReview",
    });
  }

  /** Settle an unaccepted test-review repair timeout without repair evidence. */
  settleTimedOutTestReviewRepair({ attempt, result }) {
    this.#assertExecutionActive();
    if (this.current?.at(-1) !== "test"
      || !TestReviewRepairWorkerTimeout.isFailureCode(this.attempt?.failure?.code)) {
      throw new CurrentFlowStateInvariantError("test-review repair timeout settlement requires its failed test Attempt");
    }
    const leaf = nodeAtPath(this.root, this.current);
    const settlement = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    if (settlement.nodeId !== "test" || settlement.sequence !== this.attempt.sequence + 1
      || settlement.sequence !== leaf.attemptSequence + 1 || settlement.id === this.attempt.id
      || settlement.failure !== null || settlement.consumption.semantic !== 0 || settlement.consumption.tooling !== 0) {
      throw new CurrentFlowStateInvariantError("test-review repair timeout settlement Attempt identity is invalid");
    }
    this.#assertAttemptContractForLeaf(leaf, settlement);
    const settled = result instanceof NodeResult ? result : new NodeResult(result);
    if (settled.outcome !== "passed") throw new CurrentFlowStateInvariantError("test-review repair timeout settlement requires a passed lifecycle result");
    const root = reconcileCompletedParents(
      replaceNode(this.root, leaf.id, transitionNode(leaf, "done", this.definition, {
        attemptSequence: settlement.sequence,
        result: settled,
      })),
      this.definition,
    );
    return this.#replaceRoot(root, null, null);
  }

  /**
   * A material implementation repair records its producer result in the
   * Activity ledger while invalidating stale test evidence and starting one
   * replacement test-execute Attempt.  This is deliberately one transition:
   * no generic completion may be interleaved with the invalidation route.
   */
  repairImplementation({ path: currentPath, attempt, result }) {
    this.#assertExecutionActive();
    const source = nodeAtPath(this.root, currentPath);
    if (source.id !== "impl-repair" || this.current?.at(-1) !== "impl-repair") {
      throw new CurrentFlowStateInvariantError("implementation repair requires active impl-repair Attempt");
    }
    if (!(result instanceof NodeResult) || result.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("implementation repair requires a passed producer result");
    }
    const targetPath = this.definition.pathFor(this.root, "test-execute");
    if (targetPath === null) throw new CurrentFlowStateInvariantError("implementation repair route requires test-execute");
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === "test-execute");
    if (targetIndex < 0) throw new CurrentFlowStateInvariantError("implementation repair route is absent from the Flow definition");
    let root = this.root;
    for (const id of leaves.slice(targetIndex).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    return this.#replaceRoot(root, null, null).#activateAttempt({
      path: targetPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: "repairImplementation",
    });
  }

  /** Complete an applying implementation triage and start its fixed repair Attempt. */
  triageImplementationForRepair({ path: currentPath, attempt, result }) {
    this.#assertExecutionActive();
    const source = nodeAtPath(this.root, currentPath);
    if (source.id !== "impl-triage" || this.current?.at(-1) !== "impl-triage") {
      throw new CurrentFlowStateInvariantError("implementation repair route requires active impl-triage Attempt");
    }
    if (!(result instanceof NodeResult) || result.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("implementation repair route requires a passed triage result");
    }
    const repairPath = this.definition.pathFor(this.root, "impl-repair");
    const repair = this.findNode("impl-repair");
    if (repairPath === null || repair === null || !["pending", "invalidated"].includes(repair.status)) {
      throw new CurrentFlowStateInvariantError("implementation repair route requires pending or invalidated impl-repair");
    }
    let root = replaceNode(this.root, source.id, transitionNode(source, "done", this.definition, { result }));
    root = reconcileCompletedParents(root, this.definition);
    return this.#replaceRoot(root, null, null).#activateAttempt({
      path: repairPath,
      attempt,
      allowedLeafStatuses: [repair.status],
      initial: true,
      operation: "triageImplementationForRepair",
    });
  }

  /** Complete an all-reject implementation triage without invoking repair. */
  triageImplementationNoRepair({ path: currentPath, attempt, result }) {
    this.#assertExecutionActive();
    const source = nodeAtPath(this.root, currentPath);
    if (source.id !== "impl-triage" || this.current?.at(-1) !== "impl-triage") {
      throw new CurrentFlowStateInvariantError("no-repair route requires active impl-triage Attempt");
    }
    if (!(result instanceof NodeResult) || result.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("no-repair route requires a passed triage result");
    }
    const gatePath = this.definition.pathFor(this.root, "impl-gate");
    const repair = this.findNode("impl-repair");
    if (gatePath === null || repair === null || !["pending", "invalidated"].includes(repair.status)) {
      throw new CurrentFlowStateInvariantError("no-repair route requires pending or invalidated impl-repair and impl-gate");
    }
    const skipped = new NodeResult({
      outcome: "skipped",
      summary: "implementation triage rejected every finding",
      confirmedAt: result.confirmedAt,
      artifactRefs: [],
    });
    let root = replaceNode(this.root, source.id, transitionNode(source, "done", this.definition, { result }));
    const currentRepair = findNodeInRoot(root, repair.id);
    root = replaceNode(root, repair.id, transitionNode(currentRepair, "skipped", this.definition, {
      result: skipped,
      // A typed no-repair decision consumes the bypassed repair leaf's
      // lifecycle slot even though no worker Attempt is started for it.
      attemptSequence: currentRepair.attemptSequence + 1,
    }));
    root = reconcileCompletedParents(root, this.definition);
    const exposed = this.#replaceRoot(root, null, null);
    return exposed.executableStepClaim({ nodeId: "impl-gate", attempt }).materialize(exposed);
  }

  repairAcceptanceReview({ path: currentPath, attempt, result }) {
    this.#assertExecutionActive();
    const source = nodeAtPath(this.root, currentPath);
    if (source.id !== "acceptance-review" || this.current?.at(-1) !== "acceptance-review") {
      throw new CurrentFlowStateInvariantError("acceptance repair requires active acceptance-review Attempt");
    }
    if (!(result instanceof NodeResult) || result.outcome !== "passed") {
      throw new CurrentFlowStateInvariantError("acceptance repair requires a passed acceptance result");
    }
    const targetPath = this.definition.pathFor(this.root, "impl-triage");
    if (targetPath === null) throw new CurrentFlowStateInvariantError("acceptance repair route requires impl-triage");
    const leaves = this.#leaves;
    const index = leaves.findIndex((node) => node.id === "impl-triage");
    // The acceptance result is retained by the producer Activity and its
    // catalog publication.  This fixed repair route reopens implementation,
    // so keeping acceptance-review terminal would leave a completed leaf
    // after invalidated work and violate the execution frontier.
    let root = replaceNode(this.root, source.id, transitionNode(source, "invalidated", this.definition, { result: null }));
    for (const id of leaves.slice(index).map((node) => node.id).filter((id) => id !== source.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    return this.#replaceRoot(root, null, null).#activateAttempt({
      path: targetPath, attempt, allowedLeafStatuses: ["invalidated"], initial: true, operation: "repairAcceptanceReview",
    });
  }

  /**
   * Enter implementation after scenario-validity classified existing
   * implementation changes.  The fixed route keeps this exception out of a
   * generic status-patching surface and preserves its source artifact in the
   * producer Attempt history.
   */
  preimplementationBootstrap({ path: currentPath, attempt, confirmedAt }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "implement") {
      throw new CurrentFlowStateInvariantError("preimplementation bootstrap target must be implement");
    }
    if (this.current === null || this.attempt === null || this.current.at(-1) !== "scenario-validity") {
      throw new CurrentFlowStateInvariantError("preimplementation bootstrap requires an active scenario-validity Attempt");
    }
    const scenario = this.findNode("scenario-validity");
    const testReview = this.findNode("test-review");
    if (scenario?.status !== "in_progress" || testReview?.status !== "pending" || target.status !== "pending") {
      throw new CurrentFlowStateInvariantError(
        "preimplementation bootstrap requires scenario-validity=in_progress, test-review=pending, implement=pending",
      );
    }
    const now = requireIso(confirmedAt, "preimplementation bootstrap confirmedAt");
    const skippedResult = (stepId) => new NodeResult({
      outcome: "skipped",
      summary: `preimplementation bootstrap bypassed ${stepId}`,
      confirmedAt: now,
      artifactRefs: [],
    });
    let root = replaceNode(this.root, scenario.id, transitionNode(scenario, "skipped", this.definition, {
      result: skippedResult(scenario.id),
    }));
    const pendingReview = findNodeInRoot(root, testReview.id);
    root = replaceNode(root, pendingReview.id, transitionNode(pendingReview, "skipped", this.definition, {
      attemptSequence: pendingReview.attemptSequence + 1,
      result: skippedResult(pendingReview.id),
    }));
    root = reconcileCompletedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["pending"],
      initial: true,
      operation: "preimplementationBootstrap",
    });
  }

  /**
   * Revalidate implementation that already exists after scenario-validity
   * recorded it as a preflight block.  This fixed route cannot be repurposed
   * as a generic completion or skip operation.
   */
  recoverExistingImplementation({ path: currentPath, attempt, confirmedAt }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "test-execute") {
      throw new CurrentFlowStateInvariantError("existing implementation recovery target must be test-execute");
    }
    if (this.current === null || this.attempt === null || this.current.at(-1) !== "scenario-validity") {
      throw new CurrentFlowStateInvariantError("existing implementation recovery requires an active scenario-validity Attempt");
    }
    const scenario = this.findNode("scenario-validity");
    const testReview = this.findNode("test-review");
    const implementation = this.findNode("implement");
    if (
      scenario?.status !== "in_progress"
      || testReview?.status !== "pending"
      || implementation?.status !== "pending"
      || target.status !== "pending"
    ) {
      throw new CurrentFlowStateInvariantError(
        "existing implementation recovery requires scenario-validity=in_progress, test-review=pending, implement=pending, test-execute=pending",
      );
    }
    const now = requireIso(confirmedAt, "existing implementation recovery confirmedAt");
    const skippedResult = (stepId) => new NodeResult({
      outcome: "skipped",
      summary: `existing implementation recovery bypassed ${stepId}`,
      confirmedAt: now,
      artifactRefs: [],
    });
    const completedImplementation = new NodeResult({
      outcome: "passed",
      summary: "existing implementation revalidated from scenario-validity preflight evidence",
      confirmedAt: now,
      artifactRefs: [],
    });
    let root = replaceNode(this.root, scenario.id, transitionNode(scenario, "skipped", this.definition, {
      result: skippedResult(scenario.id),
    }));
    const pendingReview = findNodeInRoot(root, testReview.id);
    root = replaceNode(root, pendingReview.id, transitionNode(pendingReview, "skipped", this.definition, {
      attemptSequence: pendingReview.attemptSequence + 1,
      result: skippedResult(pendingReview.id),
    }));
    const pendingImplementation = findNodeInRoot(root, implementation.id);
    root = replaceNode(root, pendingImplementation.id, transitionNode(pendingImplementation, "done", this.definition, {
      attemptSequence: pendingImplementation.attemptSequence + 1,
      result: completedImplementation,
    }));
    const implementationBranch = findNodeInRoot(root, "impl");
    root = replaceNode(root, implementationBranch.id, transitionNode(
      implementationBranch,
      "in_progress",
      this.definition,
      { steps: implementationBranch.steps },
    ));
    root = reconcileCompletedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["pending"],
      initial: true,
      operation: "recoverExistingImplementation",
    });
  }

  /** Definition-owned replacement of all planning and implementation leaves. */
  reopenDraft({ path: currentPath, attempt, route }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    if (target.id !== "draft") throw new CurrentFlowStateInvariantError("draft reopen target must be draft");
    if (this.current === null || this.attempt === null || this.current.at(-1) === "draft") {
      throw new CurrentFlowStateInvariantError("draft reopen requires a later active Attempt");
    }
    if (!new Set(["preimplementation", "task-addition", "spec-correction"]).has(route)) {
      throw new CurrentFlowStateInvariantError("draft reopen route is invalid");
    }
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === "draft");
    if (targetIndex < 0) throw new CurrentFlowStateInvariantError("draft reopen route is absent from the Flow definition");
    let root = this.root;
    for (const id of leaves.slice(targetIndex).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: `reopenDraft:${route}`,
    });
  }

  /**
   * The guarded plan-gate route is an explicit recovery transition, not a
   * mutable status patch.  It may leave an active gate only after the route
   * has recorded blocking evidence in the same Version Store operation.
   */
  repairPlanGate({ path: currentPath, attempt, taskLifecycle = null }) {
    this.#assertExecutionActive();
    const target = nodeAtPath(this.root, currentPath);
    const route = planGateRepairRouteForTargetStep(target.id);
    if (route === null) {
      throw new CurrentFlowStateInvariantError(`plan gate repair has no route for ${target.id}`);
    }
    if (this.current === null || this.attempt === null || this.current.at(-1) !== route.gateStepId) {
      throw new CurrentFlowStateInvariantError("plan gate repair requires its mapped active gate Attempt");
    }
    if (!isPlanGateRepairEligibleFailure(this, route)) {
      throw new CurrentFlowStateInvariantError("plan gate repair requires its mapped blocked semantic gate failure");
    }
    if (route.phase === "task-impl") {
      if (taskLifecycle === null || taskLifecycle.operation !== "repair-task-impl") {
        throw new CurrentFlowStateInvariantError("Task Gate repair requires its sealed lifecycle effect");
      }
      const taskId = taskLifecycle.taskId;
      if (taskLifecycle.successorStepId !== currentPath.at(-1)
        || JSON.stringify(taskLifecycle.resetStepIds) !== JSON.stringify(route.resetStepIds)) {
        throw new CurrentFlowStateInvariantError("Task Gate repair lifecycle effect does not match its sealed route");
      }
      const task = this.findNode(taskId);
      if (!(task instanceof TaskNode) || !this.current.includes(taskId)) {
        throw new CurrentFlowStateInvariantError("Task Gate repair requires the current materialized Task");
      }
      for (const stepId of taskLifecycle.resetStepIds) {
        const node = this.findNode(stepId);
        const role = TaskStepIdentity.fromTaskNode(task, stepId)?.role ?? null;
        const expectedStatuses = role === "gate"
          ? ["in_progress"]
          : ["triage", "repair"].includes(role)
            ? ["done", "skipped"]
            : ["done"];
        if (!expectedStatuses.includes(node?.status)) {
          throw new CurrentFlowStateInvariantError(`Task Gate repair requires ${stepId}=${expectedStatuses.join("|")}, got ${node?.status ?? "absent"}`);
        }
      }
      let root = this.root;
      for (const stepId of taskLifecycle.resetStepIds) {
        const node = findNodeInRoot(root, stepId);
        root = replaceNode(root, stepId, transitionNode(node, "invalidated", this.definition, { result: null }));
      }
      root = reconcileInvalidatedParents(root, this.definition);
      return this.#activateAttemptFromRoot({
        root, path: currentPath, attempt, allowedLeafStatuses: ["invalidated"], initial: true, operation: "repairTaskGate",
      });
    }
    for (const stepId of route.resetStepIds) {
      const node = this.findNode(stepId);
      if (node === null) throw new CurrentFlowStateInvariantError(`plan gate repair route node is missing: ${stepId}`);
      const expected = stepId === route.gateStepId ? "in_progress" : "done";
      if (node.status !== expected) {
        throw new CurrentFlowStateInvariantError(
          `plan gate repair requires ${stepId}=${expected}, got ${node.status}`,
        );
      }
    }
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((node) => node.id === target.id);
    if (targetIndex < 0) throw new CurrentFlowStateInvariantError("plan gate repair target is not a Flow leaf");
    let root = this.root;
    for (const id of leaves.slice(targetIndex).map((node) => node.id)) {
      const node = findNodeInRoot(root, id);
      root = replaceNode(root, id, transitionNode(node, "invalidated", this.definition, { result: null }));
    }
    root = reconcileInvalidatedParents(root, this.definition);
    const state = this.#replaceRoot(root, null, null);
    return state.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: "planGateRepair",
    });
  }

  recover({ path: currentPath, attempt }) {
    this.#assertExecutionActive();
    const recovery = this.recoveryTarget(currentPath).assertLegal();
    if (recovery.operation !== "recover") {
      throw new CurrentFlowStateInvariantError("recover requires the next invalidated recovery target");
    }
    return this.#activateAttempt({
      path: currentPath,
      attempt,
      allowedLeafStatuses: ["invalidated"],
      initial: true,
      operation: "recover",
    });
  }

  withConfirmationOrder(confirmationOrder) {
    return new CurrentFlowState({ ...this.toJSON(), confirmationOrder }, { definition: this.definition });
  }

  get cursor() {
    return this.current == null ? null : new CurrentCursor({ path: this.current, attempt: this.attempt });
  }

  /**
   * Resolve the one canonical attempt claim for either an active source or
   * the passive Definition-selected executable frontier.  Store callers and
   * synthetic connectors use this same authority; neither may recreate the
   * start/recover policy from lifecycle status checks.
   */
  executableStepClaim({ nodeId, attempt } = {}) {
    this.#assertExecutionActive();
    const targetId = requireString(nodeId, "executable Step claim nodeId");
    if (this.current !== null) {
      const active = nodeAtPath(this.root, this.current);
      if (active.id !== targetId || this.attempt === null) {
        throw new CurrentFlowStateInvariantError("executable Step claim does not own the active Attempt");
      }
      const provided = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
      if (provided.id !== this.attempt.id || provided.sequence !== this.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("executable Step claim Attempt identity is stale");
      }
      return ExecutableStepClaim.active({ path: this.current, node: active, attempt: this.attempt });
    }
    const descriptor = this.nextAction();
    if (descriptor === null) {
      throw new CurrentFlowStateInvariantError("Flow has no canonical executable next action");
    }
    descriptor.assertPassiveExecutableTarget(targetId);
    return descriptor.claim(attempt);
  }

  /** Verify, without materializing it, a passive canonical successor. */
  assertPassiveExecutableTarget(nodeId) {
    if (this.current !== null) {
      throw new CurrentFlowStateInvariantError("an active Attempt has no passive executable successor");
    }
    const descriptor = this.nextAction();
    if (descriptor === null) {
      throw new CurrentFlowStateInvariantError("Flow has no canonical passive successor");
    }
    descriptor.assertPassiveExecutableTarget(nodeId);
    return descriptor;
  }

  nextAction() {
    if (this.current !== null) {
      const currentNode = nodeAtPath(this.root, this.current);
      this.assertTransitionHandler(currentNode.id);
      if (this.history !== null && !this.history.resumed && this.attempt !== null && this.attempt.failure === null) {
        return null;
      }
      if (this.history !== null && this.attempt === null) {
        if (!this.history.resumed && !this.#canResumeHistoricalContinuation()) return null;
        if (currentNode.steps.length !== 0 || currentNode.status !== "in_progress") {
          throw new CurrentFlowStateInvariantError("historical current cursor has no production-resumable leaf handler");
        }
        return new CurrentNextActionDescriptor({
          path: this.current,
          node: currentNode,
          operation: "start",
          action: this.definition.actionFor(currentNode.id, this.root),
        });
      }
      const failureDisposition = this.failureDisposition();
      const descriptorPath = failureDisposition?.targetPath ?? this.current;
      const node = nodeAtPath(this.root, descriptorPath);
      return new CurrentNextActionDescriptor({
        path: descriptorPath,
        node,
        operation: failureDisposition?.operation ?? "resume",
        action: this.definition.actionFor(node.id, this.root),
        failureDisposition,
      });
    }
    if (this.history !== null && !this.history.resumed) return null;
    const node = this.definition.nextExecutableLeaf(this.root);
    if (node === null) return null;
    this.assertTransitionHandler(node.id);
    return new CurrentNextActionDescriptor({
      path: this.definition.pathFor(this.root, node.id),
      node,
      operation: node.status === "invalidated" ? "recover" : "start",
      action: this.definition.actionFor(node.id, this.root),
    });
  }

  resumeDescriptor() {
    return this.nextAction();
  }

  failureDisposition() {
    if (this.current === null || this.attempt === null || this.attempt.failure === null) return null;
    const leaf = nodeAtPath(this.root, this.current);
    const action = this.definition.actionFor(leaf.id, this.root);
    const failure = this.attempt.failure;
    const policy = action.failurePolicy;
    const decision = policy.decide({
      failure,
      consumption: this.attempt.consumption,
      contract: this.definition.contractForNode(leaf),
    });
    const targetPath = decision.targetNodeId === null
      ? null
      : this.definition.pathFor(this.root, decision.targetNodeId);
    return new CurrentFailureDisposition({
      attempt: this.attempt,
      decision,
      outcome: this.attempt.incomplete.length > 0 ? "incomplete" : "failed",
      targetPath,
    });
  }

  retryEligibility() {
    if (this.current === null || this.attempt === null) {
      return new CurrentRetryEligibility({
        path: null,
        attempt: null,
        semanticRemaining: null,
        toolingRemaining: null,
      });
    }
    const leaf = nodeAtPath(this.root, this.current);
    const contract = this.definition.contractFor(leaf.id, this.root);
    const failure = this.attempt.failure;
    const decision = failure === null
      ? null
      : this.definition.actionFor(leaf.id, this.root).failurePolicy.decide({
        failure,
        consumption: this.attempt.consumption,
        contract,
      });
    return new CurrentRetryEligibility({
      path: this.current,
      attempt: this.attempt,
      semanticRemaining: decision?.operation === "retry" && decision.retryKind === "semantic"
        ? decision.remaining
        : 0,
      toolingRemaining: decision?.operation === "retry" && decision.retryKind === "tooling"
        ? decision.remaining
        : 0,
    });
  }

  recoveryTarget(currentPath) {
    const target = nodeAtPath(this.root, currentPath);
    const contract = this.definition.contractFor(target.id, this.root);
    if (this.current !== null) {
      const disposition = this.failureDisposition();
      const policyRewind = disposition?.operation === "rewind"
        && jsonEqual(disposition.targetPath, currentPath);
      const legal = policyRewind
        && target.steps.length === 0
        && TERMINAL_NODE_STATUSES.has(target.status)
        && contract.permits(target.status, "in_progress");
      return new CurrentRecoveryTarget({
        path: currentPath,
        node: target,
        operation: legal ? "rewind" : "unavailable",
        legal,
        reason: legal
          ? "the active failure policy authorizes rewind to this definition target"
          : "an active Attempt permits only its definition-owned failure recovery target",
      });
    }
    const next = this.definition.nextExecutableLeaf(this.root);
    const terminal = target.steps.length === 0 && TERMINAL_NODE_STATUSES.has(target.status);
    const invalidated = target.steps.length === 0
      && target.status === "invalidated"
      && next?.id === target.id;
    const legal = (terminal || invalidated) && contract.permits(target.status, "in_progress");
    return new CurrentRecoveryTarget({
      path: currentPath,
      node: target,
      operation: terminal ? "rewind" : invalidated ? "recover" : "unavailable",
      legal,
      reason: legal
        ? terminal ? "terminal leaf may be rewound" : "next invalidated leaf may be recovered"
        : "recovery requires a transition-authorized terminal leaf or next invalidated leaf",
    });
  }

  artifactAuthority() {
    const descriptor = this.nextAction();
    if (descriptor === null) return null;
    const node = this.findNode(descriptor.nodeId);
    const leaves = this.#leaves;
    const targetIndex = leaves.findIndex((leaf) => leaf.id === node.id);
    const targetTask = descriptor.path
      .map((id) => this.findNode(id))
      .find((candidate) => candidate instanceof TaskNode) ?? null;
    const candidates = leaves.slice(0, targetIndex)
      .filter((leaf) => AUTHORITATIVE_NODE_STATUSES.has(leaf.status) && leaf.result !== null)
      .map((leaf) => {
        const sourcePath = this.definition.pathFor(this.root, leaf.id);
        const sourceTask = sourcePath.map((id) => this.findNode(id)).find((candidate) => candidate instanceof TaskNode) ?? null;
        const scope = sourceTask === null
          ? "flow"
          : targetTask !== null && sourceTask.id === targetTask.id ? "same_task" : "all_tasks";
        return { leaf, sourcePath, scope };
      });
    const resolutions = descriptor.action.contextKinds.map((resourceKind) => {
      let source = null;
      for (const scope of descriptor.action.artifactAuthority.sourceScopes) {
        const matching = candidates.filter((candidate) => (
          candidate.scope === scope
          && candidate.leaf.result.artifactRefs.some((artifact) => artifact.kind === resourceKind)
        ));
        if (matching.length === 0) continue;
        const selected = matching.at(-1);
        const artifact = [...selected.leaf.result.artifactRefs].reverse()
          .find((reference) => reference.kind === resourceKind);
        source = new CurrentArtifactSource({
          path: selected.sourcePath,
          node: selected.leaf,
          artifact,
        });
        break;
      }
      return new CurrentArtifactResolution({ resourceKind, source });
    });
    return new CurrentArtifactAuthority({
      path: descriptor.path,
      node,
      execution: this.execution,
      action: descriptor.action,
      resolutions,
    });
  }

  #activateAttempt({ path: currentPath, attempt, allowedLeafStatuses, initial, operation }) {
    this.#assertExecutionActive();
    const dormantHistoricalCursor = this.history !== null
      && this.current !== null
      && this.attempt === null
      && jsonEqual(this.current, currentPath)
      && initial === true;
    if (this.current != null && !dormantHistoricalCursor) throw new CurrentFlowStateInvariantError("a current Attempt is already active");
    const leaf = nodeAtPath(this.root, currentPath);
    this.assertTransitionHandler(leaf.id);
    if (leaf.steps.length !== 0) throw new CurrentFlowStateInvariantError("Attempt target must be a leaf");
    if (!allowedLeafStatuses.includes(leaf.status)) {
      throw new CurrentFlowStateInvariantError(`${operation} may target only a ${allowedLeafStatuses.join(" or ")} leaf`);
    }
    const parsedAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    this.#assertAttemptForLeaf(leaf, parsedAttempt, { initial });
    let root = this.root;
    for (const id of currentPath) {
      const node = findNodeInRoot(root, id);
      if (node.status !== "in_progress" || (id === leaf.id && node.attemptSequence !== parsedAttempt.sequence)) {
        root = replaceNode(root, id, transitionNode(node, "in_progress", this.definition, {
          result: id === leaf.id ? null : node.result,
          attemptSequence: id === leaf.id ? parsedAttempt.sequence : node.attemptSequence,
        }));
      }
    }
    return this.#resumeHistoricalContinuation({ root, current: currentPath, attempt: parsedAttempt });
  }

  /** Activate a replacement Attempt without persisting an invalidated intermediate frontier. */
  #activateAttemptFromRoot({ root, path: currentPath, attempt, allowedLeafStatuses, initial, operation }) {
    const leaf = nodeAtPath(root, currentPath);
    this.assertTransitionHandler(leaf.id);
    if (leaf.steps.length !== 0 || !allowedLeafStatuses.includes(leaf.status)) {
      throw new CurrentFlowStateInvariantError(`${operation} may target only a ${allowedLeafStatuses.join(" or ")} leaf`);
    }
    const parsedAttempt = attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    this.#assertAttemptForLeaf(leaf, parsedAttempt, { initial });
    let activated = root;
    for (const id of currentPath) {
      const node = findNodeInRoot(activated, id);
      if (node.status !== "in_progress" || (id === leaf.id && node.attemptSequence !== parsedAttempt.sequence)) {
        activated = replaceNode(activated, id, transitionNode(node, "in_progress", this.definition, {
          result: id === leaf.id ? null : node.result,
          attemptSequence: id === leaf.id ? parsedAttempt.sequence : node.attemptSequence,
        }));
      }
    }
    return this.#resumeHistoricalContinuation({ root: activated, current: currentPath, attempt: parsedAttempt });
  }

  #assertAttemptForLeaf(leaf, next, { initial = false, previous = null, kind = null } = {}) {
    if (next.nodeId !== leaf.id) {
      throw new CurrentFlowStateInvariantError("Attempt nodeId must match its target leaf");
    }
    this.#assertAttemptContractForLeaf(leaf, next);
    if (initial) {
      if (next.sequence !== leaf.attemptSequence + 1 || next.consumption.semantic !== 0 || next.consumption.tooling !== 0) {
        throw new CurrentFlowStateInvariantError("a new Attempt episode must advance the node sequence and reset retry consumption");
      }
      if (next.failure !== null) throw new CurrentFlowStateInvariantError("a new Attempt must not begin failed");
      return;
    }
    if (!(previous instanceof CurrentAttempt)) {
      throw new CurrentFlowStateInvariantError("retry Attempt requires the previous active Attempt");
    }
    if (!RETRY_KINDS.has(kind)) {
      throw new CurrentFlowStateInvariantError("retry Attempt kind must be semantic or tooling");
    }
    if (next.sequence !== previous.sequence + 1 || next.sequence !== leaf.attemptSequence + 1) {
      throw new CurrentFlowStateInvariantError("retry Attempt sequence must immediately follow the active Attempt and node cursor");
    }
    if (next.id === previous.id) {
      throw new CurrentFlowStateInvariantError("retry Attempt must have a new stable id");
    }
    if (next.failure !== null) throw new CurrentFlowStateInvariantError("a retry Attempt must not begin failed");
    if (kind === "semantic") {
      if (
        next.consumption.semantic !== previous.consumption.semantic + 1
        || next.consumption.tooling !== previous.consumption.tooling
      ) {
        throw new CurrentFlowStateInvariantError("semantic retry must increment only semantic consumption by one");
      }
    } else if (
      next.consumption.semantic !== previous.consumption.semantic
      || next.consumption.tooling !== previous.consumption.tooling + 1
    ) {
      throw new CurrentFlowStateInvariantError("tooling retry must increment only tooling consumption by one");
    }
  }

  #assertAttemptContractForLeaf(leaf, next) {
    const contract = this.definition.contractFor(leaf.id, this.root);
    if (next.consumption.semantic > contract.semanticRetryLimit) {
      throw new CurrentFlowStateInvariantError(`attempt semantic consumption exceeds definition semanticRetryLimit for ${leaf.id}`);
    }
    if (contract.toolingRetryLimit === null && next.consumption.tooling !== 0) {
      throw new CurrentFlowStateInvariantError(`attempt tooling consumption is not authorized for ${leaf.id}`);
    }
    if (contract.toolingRetryLimit !== null && next.consumption.tooling > contract.toolingRetryLimit) {
      throw new CurrentFlowStateInvariantError(`attempt tooling consumption exceeds definition toolingRetryLimit for ${leaf.id}`);
    }
    contract.resourceContract.assertClaims(next.operationClaims, next.incomplete, leaf.id);
  }

  /** Persist the one capability that admits Definition-owned continuation. */
  #resumeHistoricalContinuation({ root, current, attempt }) {
    if (this.history === null || this.history.resumed) {
      return this.#replaceRoot(root, current, attempt, this.history);
    }
    const leaves = collectNodes(root).filter((node) => node.steps.length === 0);
    const boundaryIndex = leaves.findIndex((leaf) => leaf.id === attempt.nodeId);
    if (boundaryIndex < 0) throw new CurrentFlowStateInvariantError("historical continuation Attempt must target a Flow leaf");
    const continuation = new CurrentFlowHistoricalContinuation({
      nodeId: attempt.nodeId,
      attemptId: attempt.id,
      attemptSequence: attempt.sequence,
      confirmationOrder: this.confirmationOrder + 1,
      unexecutedSkipLeafIds: leaves.slice(0, boundaryIndex)
        .filter((leaf) => leaf.status === "skipped" && leaf.attemptSequence === 0 && leaf.result === null)
        .map((leaf) => leaf.id),
    });
    return this.#replaceRoot(root, current, attempt, this.history.resume(continuation.toJSON()));
  }

  #replaceRoot(root, current = this.current, attempt = this.attempt, history = this.history) {
    return new CurrentFlowState({
      ...this.toJSON(),
      ...root.toJSON(),
      current: current == null ? null : current.at(-1),
      attempt: attempt?.toJSON?.() ?? attempt,
      history: history?.toJSON() ?? null,
    }, { definition: this.definition });
  }

  #replaceLifecycle(state) {
    return new CurrentFlowState({
      ...this.toJSON(),
      lifecycle: new CurrentFlowLifecycle({ state }).toJSON(),
    }, { definition: this.definition });
  }

  #assertExecutionActive() {
    this.assertTransitionHandler(this.current?.at(-1) ?? this.root.id);
    if (this.lifecycle.state !== "active") {
      throw new CurrentFlowStateInvariantError("step transitions require an active Flow lifecycle");
    }
  }

  toJSON() {
    return {
      schemaRevision: this.schemaRevision,
      ...this.identity.toJSON(),
      request: this.request,
      version: this.version,
      lifecycle: this.lifecycle.toJSON(),
      execution: this.execution.toJSON(),
      policy: this.policy.toJSON(),
      ...this.root.toJSON(),
      current: this.current == null ? null : this.current.at(-1),
      attempt: this.attempt?.toJSON() ?? null,
      confirmationOrder: this.confirmationOrder,
      artifacts: this.artifacts.toJSON(),
      outbox: this.outbox.toJSON(),
      context: this.context.toJSON(),
      history: this.history?.toJSON() ?? null,
    };
  }
}

/**
 * The schema boundary for canonical flow.json.  Callers never deserialize
 * through a generic JSON helper: the validator is definition-bound so state
 * shape and lifecycle semantics are checked together.
 */
export class CurrentFlowStateValidator {
  constructor({ definition } = {}) {
    if (!(definition instanceof CurrentFlowDefinition)) {
      throw new CurrentFlowStateInvariantError("CurrentFlowStateValidator requires a CurrentFlowDefinition");
    }
    this.definition = definition;
    Object.freeze(this);
  }

  validate(value) {
    const serialized = value instanceof CurrentFlowState
      ? CurrentFlowState.prototype.toJSON.call(value)
      : value;
    return new CurrentFlowState(serialized, { definition: this.definition });
  }
}

/**
 * Canonical serializer paired with CurrentFlowStateValidator.  It intentionally
 * emits every field, including nullable fields, so schema revision 3 has one
 * exact wire representation instead of an implicit optional-field dialect.
 */
export class CurrentFlowStateSerializer {
  constructor({ validator } = {}) {
    if (!(validator instanceof CurrentFlowStateValidator)) {
      throw new CurrentFlowStateInvariantError("CurrentFlowStateSerializer requires a CurrentFlowStateValidator");
    }
    this.validator = validator;
    Object.freeze(this);
  }

  deserialize(value) {
    return this.validator.validate(value);
  }

  serialize(state) {
    return this.validator.validate(state).toJSON();
  }

  bytes(state) {
    return Buffer.from(`${JSON.stringify(this.serialize(state), null, 2)}\n`, "utf8");
  }
}

export class ActivityReference {
  constructor(value) {
    if (new.target === ActivityReference) {
      throw new CurrentFlowStateInvariantError("activity reference requires a concrete reference type");
    }
    requireExactFields(value, new Set(["id", "label"]), "activity reference");
    const { id, label } = value;
    this.id = requireString(id, "activity reference.id");
    if (label !== null) requireString(label, "activity reference.label");
    this.label = label;
    Object.freeze(this);
  }

  toJSON() { return { id: this.id, label: this.label }; }
}

export class ActivityEvaluationReference extends ActivityReference {}
export class ActivityFindingReference extends ActivityReference {}
export class ActivityRepairReference extends ActivityReference {}
export class ActivityArtifactReference extends ActivityReference {}

export class ActivityReferences {
  constructor(value) {
    requireExactFields(value, new Set(["evaluations", "findings", "repairs", "artifacts"]), "activity.references");
    const { evaluations, findings, repairs, artifacts } = value;
    const referenceTypes = {
      evaluations: ActivityEvaluationReference,
      findings: ActivityFindingReference,
      repairs: ActivityRepairReference,
      artifacts: ActivityArtifactReference,
    };
    for (const [field, values] of Object.entries({ evaluations, findings, repairs, artifacts })) {
      if (!Array.isArray(values)) throw new CurrentFlowStateInvariantError(`activity.references.${field} must be an array`);
      const Reference = referenceTypes[field];
      this[field] = Object.freeze(values.map((value) => value instanceof Reference ? value : new Reference(value)));
    }
    Object.freeze(this);
  }

  toJSON() {
    return Object.fromEntries(
      ["evaluations", "findings", "repairs", "artifacts"].map((field) => [field, this[field].map((entry) => entry.toJSON())]),
    );
  }
}

export class ActivityTask {
  constructor(value) {
    const hasApprovalSource = isPlainObject(value) && Object.hasOwn(value, "approvalSource");
    requireExactFields(value, new Set(hasApprovalSource ? ["id", "key", "approvalSource"] : ["id", "key"]), "activity.task");
    const { id, key, approvalSource = null } = value;
    this.id = requireString(id, "activity.task.id");
    this.key = requireString(key, "activity.task.key");
    this.approvalSource = approvalSource === null
      ? null
      : approvalSource instanceof ApprovalTaskSourceBinding
        ? approvalSource
        : new ApprovalTaskSourceBinding(approvalSource);
    if (this.approvalSource !== null
      && (this.approvalSource.taskDocument.id !== this.id || this.approvalSource.taskKey !== this.key)) {
      throw new CurrentFlowStateInvariantError("approval Task source binding does not match its Activity Task");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      key: this.key,
      ...(this.approvalSource === null ? {} : { approvalSource: this.approvalSource.toJSON() }),
    };
  }
}

/**
 * A structured metric observation carried by an Activity rather than a
 * mutable `flow.json.metrics` array.  The shape intentionally mirrors the
 * public metric view so existing reports can derive that view from the ledger
 * without making it another persistence authority.
 */
export class ActivityMetric {
  constructor(value) {
    requireExactFields(value, new Set([
      "phase", "counter", "delta", "reset", "kind", "provider", "profileKey",
      "callCount", "responseChars", "durationMs", "model", "tokens", "cost",
      "cachedResponse", "costIncomplete",
    ]), "activity.metric");
    this.phase = requireString(value.phase, "activity.metric.phase");
    if (value.counter !== null) requireString(value.counter, "activity.metric.counter");
    this.counter = value.counter;
    if (value.delta !== null) {
      this.delta = requirePositiveInteger(value.delta, "activity.metric.delta", { allowZero: true });
    } else {
      this.delta = null;
    }
    if (typeof value.reset !== "boolean") throw new CurrentFlowStateInvariantError("activity.metric.reset must be boolean");
    this.reset = value.reset;
    for (const field of ["kind", "provider", "profileKey", "model"]) {
      if (value[field] !== null) requireString(value[field], `activity.metric.${field}`);
      this[field] = value[field];
    }
    for (const field of ["callCount", "responseChars", "durationMs"]) {
      if (value[field] !== null) {
        this[field] = requirePositiveInteger(value[field], `activity.metric.${field}`, { allowZero: true });
      } else {
        this[field] = null;
      }
    }
    if (value.tokens !== null) {
      requireExactFields(value.tokens, new Set(["input", "output", "cacheRead", "cacheCreation"]), "activity.metric.tokens");
      this.tokens = Object.freeze(Object.fromEntries(
        ["input", "output", "cacheRead", "cacheCreation"].map((field) => [
          field,
          requirePositiveInteger(value.tokens[field], `activity.metric.tokens.${field}`, { allowZero: true }),
        ]),
      ));
    } else {
      this.tokens = null;
    }
    if (value.cost !== null && (typeof value.cost !== "number" || !Number.isFinite(value.cost) || value.cost < 0)) {
      throw new CurrentFlowStateInvariantError("activity.metric.cost must be a non-negative number or null");
    }
    this.cost = value.cost;
    for (const field of ["cachedResponse", "costIncomplete"]) {
      if (typeof value[field] !== "boolean") {
        throw new CurrentFlowStateInvariantError(`activity.metric.${field} must be boolean`);
      }
      this[field] = value[field];
    }
    if (this.counter === null && this.kind === null) {
      throw new CurrentFlowStateInvariantError("activity.metric requires a counter or kind");
    }
    if (this.counter !== null && this.delta === null) {
      throw new CurrentFlowStateInvariantError("activity.metric counter requires delta");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      counter: this.counter,
      delta: this.delta,
      reset: this.reset,
      kind: this.kind,
      provider: this.provider,
      profileKey: this.profileKey,
      callCount: this.callCount,
      responseChars: this.responseChars,
      durationMs: this.durationMs,
      model: this.model,
      tokens: this.tokens === null ? null : { ...this.tokens },
      cost: this.cost,
      cachedResponse: this.cachedResponse,
      costIncomplete: this.costIncomplete,
    };
  }

  /** Rehydrate the historical command-view shape from its canonical ledger value. */
  toMetricEntry({ taskId, timestamp }) {
    return {
      phase: this.phase,
      ...(this.counter === null ? {} : { counter: this.counter, delta: this.delta }),
      ...(this.reset ? { reset: true } : {}),
      ...(this.kind === null ? {} : { kind: this.kind }),
      ...(this.provider === null ? {} : { provider: this.provider }),
      ...(this.profileKey === null ? {} : { profileKey: this.profileKey }),
      ...(this.callCount === null ? {} : { callCount: this.callCount }),
      ...(this.responseChars === null ? {} : { responseChars: this.responseChars }),
      ...(this.durationMs === null ? {} : { durationMs: this.durationMs }),
      ...(this.model === null ? {} : { model: this.model }),
      ...(this.tokens === null ? {} : { tokens: { ...this.tokens } }),
      ...(this.cost === null ? {} : { cost: this.cost }),
      ...(this.cachedResponse ? { cachedResponse: true } : {}),
      ...(this.costIncomplete ? { costIncomplete: true } : {}),
      taskId,
      ts: timestamp,
    };
  }
}

/** A durable human note with the same Activity-owned ordering as metrics. */
export class ActivityNote {
  constructor(value) {
    requireExactFields(value, new Set(["text"]), "activity.note");
    this.text = requireString(value.text, "activity.note.text");
    Object.freeze(this);
  }

  toJSON() { return { text: this.text }; }

  toNoteEntry({ taskId, timestamp }) {
    return { text: this.text, taskId, ts: timestamp };
  }
}

/** Immutable advisory evidence fact recorded in the canonical Activity ledger. */
export class ActivityNonBlockingRecord {
  constructor(value) {
    requireExactFields(value, new Set([
      "kind", "sourceStep", "sourceAttempt", "evidenceRef", "evidenceDigest", "resultKind",
      "action", "rationale", "remainingRisk",
    ]), "activity.nonblocking");
    if (!["observation", "decision"].includes(value.kind)) {
      throw new CurrentFlowStateInvariantError("activity.nonblocking.kind is invalid");
    }
    this.kind = value.kind;
    this.sourceStep = requireString(value.sourceStep, "activity.nonblocking.sourceStep");
    this.sourceAttempt = requirePositiveInteger(value.sourceAttempt, "activity.nonblocking.sourceAttempt");
    this.evidenceRef = requireString(value.evidenceRef, "activity.nonblocking.evidenceRef");
    if (!/^[a-f0-9]{64}$/.test(value.evidenceDigest || "")) {
      throw new CurrentFlowStateInvariantError("activity.nonblocking.evidenceDigest must be SHA-256");
    }
    this.evidenceDigest = value.evidenceDigest;
    if (!["quality", "tooling", "unavailable"].includes(value.resultKind)) {
      throw new CurrentFlowStateInvariantError("activity.nonblocking.resultKind is invalid");
    }
    this.resultKind = value.resultKind;
    if (this.kind === "observation") {
      if (value.action !== null || value.rationale !== null || value.remainingRisk !== null) {
        throw new CurrentFlowStateInvariantError("nonblocking observation cannot carry a decision");
      }
      this.action = null;
      this.rationale = null;
      this.remainingRisk = null;
    } else {
      if (!["repair", "retry", "continue"].includes(value.action)) {
        throw new CurrentFlowStateInvariantError("activity.nonblocking decision action is invalid");
      }
      this.action = value.action;
      this.rationale = requireString(value.rationale, "activity.nonblocking.rationale");
      this.remainingRisk = value.remainingRisk == null ? null : requireString(value.remainingRisk, "activity.nonblocking.remainingRisk");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      sourceStep: this.sourceStep,
      sourceAttempt: this.sourceAttempt,
      evidenceRef: this.evidenceRef,
      evidenceDigest: this.evidenceDigest,
      resultKind: this.resultKind,
      action: this.action,
      rationale: this.rationale,
      remainingRisk: this.remainingRisk,
    };
  }
}

/** Immutable serialized Task Gate lifecycle carried by one journal Activity. */
export class ActivityGateTaskLifecycle {
  constructor(value) {
    if (!isPlainObject(value)) throw new CurrentFlowStateInvariantError("activity Gate Task lifecycle is invalid");
    requireExactFields(value, new Set(["operation", "taskId", "successorStepId", "resetStepIds"]), "activity.gateTaskLifecycle");
    this.operation = requireString(value.operation, "activity Gate Task lifecycle operation");
    if (!new Set(["complete-and-advance", "repair-task-impl", "defer-and-advance"]).has(this.operation)) {
      throw new CurrentFlowStateInvariantError("activity Gate Task lifecycle operation is invalid");
    }
    this.taskId = requireString(value.taskId, "activity Gate Task lifecycle taskId");
    this.successorStepId = requireString(value.successorStepId, "activity Gate Task lifecycle successor");
    if (!Array.isArray(value.resetStepIds) || value.resetStepIds.some((stepId) => typeof stepId !== "string" || stepId === "")) {
      throw new CurrentFlowStateInvariantError("activity Gate Task lifecycle reset Steps are invalid");
    }
    this.resetStepIds = Object.freeze([...value.resetStepIds]);
    const expectedReset = [`${this.taskId}-impl`, `${this.taskId}-review`, `${this.taskId}-triage`, `${this.taskId}-repair`, `${this.taskId}-gate`];
    if ((this.operation === "repair-task-impl" && JSON.stringify(this.resetStepIds) !== JSON.stringify(expectedReset))
      || (this.operation !== "repair-task-impl" && this.resetStepIds.length !== 0)) {
      throw new CurrentFlowStateInvariantError("activity Gate Task lifecycle reset Steps do not match its operation");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      operation: this.operation,
      taskId: this.taskId,
      successorStepId: this.successorStepId,
      resetStepIds: [...this.resetStepIds],
    };
  }
}

const ACTIVITY_TRANSITION_FIELDS = new Set([
  "operation", "nodeId", "task", "attempt", "status", "policy", "outbox", "approval",
  "nonblocking", "finalizeSteps", "gateTaskLifecycle", "stepConnectionReceipt", "taskReviewStagePlan",
]);

export class ActivityTransition {
  constructor(value) {
    const normalized = isPlainObject(value) && (!Object.hasOwn(value, "finalizeSteps") || !Object.hasOwn(value, "gateTaskLifecycle") || !Object.hasOwn(value, "stepConnectionReceipt") || !Object.hasOwn(value, "taskReviewStagePlan"))
      ? { ...value, finalizeSteps: value.finalizeSteps ?? null, gateTaskLifecycle: value.gateTaskLifecycle ?? null, stepConnectionReceipt: value.stepConnectionReceipt ?? null, taskReviewStagePlan: value.taskReviewStagePlan ?? null }
      : value;
    requireExactFields(normalized, ACTIVITY_TRANSITION_FIELDS, "activity.transition");
    const { operation, nodeId, task, attempt, status, policy, outbox, approval, nonblocking, finalizeSteps, gateTaskLifecycle, stepConnectionReceipt, taskReviewStagePlan } = normalized;
    if (![FLOW_CREATION_TRANSITION_OPERATION, DRAFT_COMPLETION_TRANSITION_OPERATION, TASK_REVIEW_STAGE_TRANSITION_OPERATION, "advance_task_review_stage", "add_task", "add_approval_task", "start_attempt", "retry_attempt", "retry_gate_attempt", "retry_recovery_attempt", "update_attempt", TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION, "fail_attempt", "record_failure", "confirm_attempt", "complete_acceptance_decision_noop", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact", "recover_task_execution_overrun", "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", INTERRUPTED_FINALIZE_SYNC_OPERATION, ...LIFECYCLE_TRANSITION_OPERATIONS, ...POLICY_TRANSITION_OPERATIONS, ...OUTBOX_TRANSITION_OPERATIONS, ...ARTIFACT_PUBLICATION_TRANSITION_OPERATIONS, ...DISPATCH_APPROVAL_TRANSITION_OPERATIONS, ...OBSERVATION_TRANSITION_OPERATIONS, ...NONBLOCKING_TRANSITION_OPERATIONS, ...FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS].includes(operation)) {
      throw new CurrentFlowStateInvariantError(`activity.transition.operation is invalid: ${operation}`);
    }
    this.operation = operation;
    this.nodeId = requireString(nodeId, "activity.transition.nodeId");
    this.task = task == null ? null : task instanceof ActivityTask ? task : new ActivityTask(task);
    this.attempt = attempt == null ? null : attempt instanceof CurrentAttempt ? attempt : new CurrentAttempt(attempt);
    this.stepConnectionReceipt = stepConnectionReceipt === null ? null : stepConnectionReceipt instanceof ActivityStepConnectionReceipt ? stepConnectionReceipt : new ActivityStepConnectionReceipt(stepConnectionReceipt);
    if ((operation === DRAFT_COMPLETION_TRANSITION_OPERATION) !== (this.stepConnectionReceipt !== null)) {
      throw new CurrentFlowStateInvariantError("only draft completion transition carries a Step connection receipt");
    }
    this.taskReviewStagePlan = taskReviewStagePlan === null
      ? null
      : taskReviewStagePlan instanceof TaskReviewStageTransitionPlan
        ? taskReviewStagePlan
        : taskReviewStagePlanFromJSON(taskReviewStagePlan);
    if ([TASK_REVIEW_STAGE_TRANSITION_OPERATION, "advance_task_review_stage"].includes(operation) !== (this.taskReviewStagePlan !== null)) {
      throw new CurrentFlowStateInvariantError("only Task Review stage completion carries its sealed plan");
    }
    const taskRequired = ["add_task", "add_approval_task"].includes(operation);
    if (taskRequired !== (this.task !== null)) {
      throw new CurrentFlowStateInvariantError(this.task === null
        ? "Task admission transitions require a Task payload"
        : "add_task is the only transition that requires a Task payload outside approval continuation");
    }
    const approvalSourceRequired = operation === "add_approval_task";
    if (taskRequired && approvalSourceRequired !== (this.task.approvalSource !== null)) {
      throw new CurrentFlowStateInvariantError(
        "only add_approval_task requires a durable approval Task source binding",
      );
    }
    this.policy = policy == null ? null : policy instanceof CurrentFlowPolicy ? policy : new CurrentFlowPolicy(policy);
    const policyRequired = operation === "set_policy";
    if (policyRequired !== (this.policy !== null)) {
      throw new CurrentFlowStateInvariantError("set_policy is the only transition that requires a policy payload");
    }
    this.outbox = outbox == null ? null : outbox instanceof ActivityOutbox ? outbox : new ActivityOutbox(outbox);
    const outboxRequired = OUTBOX_TRANSITION_OPERATIONS.has(operation) || operation === INTERRUPTED_FINALIZE_SYNC_OPERATION;
    if (outboxRequired !== (this.outbox !== null)) {
      throw new CurrentFlowStateInvariantError(
        outboxRequired
          ? `activity.transition ${operation} requires an outbox payload`
          : `activity.transition ${operation} forbids an outbox payload`,
      );
    }
    if (this.outbox !== null) {
      if (operation === "fail_outbox" && this.outbox.failure === null) {
        throw new CurrentFlowStateInvariantError("fail_outbox requires its failure fact in the Activity ledger");
      }
      if (!["fail_outbox", INTERRUPTED_FINALIZE_SYNC_OPERATION].includes(operation) && this.outbox.failure !== null) {
        throw new CurrentFlowStateInvariantError("only fail_outbox may carry an outbox failure fact");
      }
      if (operation !== "complete_outbox" && this.outbox.result !== null) {
        throw new CurrentFlowStateInvariantError("only complete_outbox may carry an outbox result");
      }
      if (!["fail_outbox", INTERRUPTED_FINALIZE_SYNC_OPERATION].includes(operation) && (this.outbox.failureCode !== null || this.outbox.recovery !== null)) {
        throw new CurrentFlowStateInvariantError("only fail_outbox may carry outbox failure recovery facts");
      }
      if (this.outbox.recovery !== null && this.outbox.failureCode !== "MERGE_PRE_SYNC_CONFLICT") {
        throw new CurrentFlowStateInvariantError("outbox pre-sync recovery requires MERGE_PRE_SYNC_CONFLICT");
      }
      if (operation === "reopen_outbox" && this.outbox.exactRecoveryReceipt === null) {
        throw new CurrentFlowStateInvariantError("reopen_outbox requires an exact recovery receipt");
      }
      if (operation === "begin_outbox" && this.outbox.exactRecoveryReceipt !== null) {
        throw new CurrentFlowStateInvariantError("begin_outbox cannot consume an exact recovery receipt");
      }
      if (this.outbox.exactRecoveryReceipt !== null) {
        const receipt = this.outbox.exactRecoveryReceipt;
        if (receipt.idempotencyKey !== this.outbox.id || receipt.attempt !== this.outbox.attempt) {
          throw new CurrentFlowStateInvariantError("outbox exact recovery receipt must bind this outbox identity and attempt");
        }
      }
    }
    this.approval = approval == null ? null : (
      approval instanceof ActivityDispatchApproval ? approval : new ActivityDispatchApproval(approval)
    );
    const approvalRequired = DISPATCH_APPROVAL_TRANSITION_OPERATIONS.has(operation);
    if (approvalRequired !== (this.approval !== null)) {
      throw new CurrentFlowStateInvariantError(
        approvalRequired
          ? `activity.transition ${operation} requires an approval receipt`
          : `activity.transition ${operation} forbids an approval receipt`,
      );
    }
    this.nonblocking = nonblocking == null
      ? null
      : nonblocking instanceof ActivityNonBlockingRecord
        ? nonblocking
        : new ActivityNonBlockingRecord(nonblocking);
    const nonblockingRequired = NONBLOCKING_TRANSITION_OPERATIONS.has(operation);
    if (nonblockingRequired !== (this.nonblocking !== null)) {
      throw new CurrentFlowStateInvariantError(
        nonblockingRequired
          ? "record_nonblocking requires a nonblocking ledger fact"
          : `activity.transition ${operation} forbids a nonblocking ledger fact`,
      );
    }
    const finalizationRequired = FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS.has(operation);
    if (finalizationRequired) {
      if (!Array.isArray(finalizeSteps) || finalizeSteps.length === 0 || finalizeSteps.some((step) => typeof step !== "string" || step === "")) {
        throw new CurrentFlowStateInvariantError(`${operation} requires non-empty finalize Steps`);
      }
      this.finalizeSteps = Object.freeze([...new Set(finalizeSteps)]);
    } else if (finalizeSteps !== null) {
      throw new CurrentFlowStateInvariantError(`${operation} forbids finalize Steps`);
    } else {
      this.finalizeSteps = null;
    }
    const lifecycle = gateTaskLifecycle === null ? null : new ActivityGateTaskLifecycle(gateTaskLifecycle);
    const requiredTaskLifecycleOperation = operation === "plan_gate_repair"
      ? "repair-task-impl"
      : operation === "confirm_attempt"
        ? "complete-and-advance"
        : operation === "defer_failed_gate"
          ? "defer-and-advance"
          : null;
    if (lifecycle !== null && lifecycle.operation !== requiredTaskLifecycleOperation) {
      throw new CurrentFlowStateInvariantError("Activity Gate Task lifecycle effect does not match its transition operation");
    }
    this.gateTaskLifecycle = lifecycle;
    const attemptRequired = TRANSITION_ATTEMPT_OPERATIONS.has(operation);
    if (attemptRequired !== (this.attempt !== null)) {
      throw new CurrentFlowStateInvariantError(
        attemptRequired
          ? `activity.transition ${operation} requires an Attempt payload`
          : `activity.transition ${operation} forbids an Attempt payload`,
      );
    }
    if ((operation === FLOW_CREATION_TRANSITION_OPERATION || LIFECYCLE_TRANSITION_OPERATIONS.has(operation) || POLICY_TRANSITION_OPERATIONS.has(operation) || OUTBOX_TRANSITION_OPERATIONS.has(operation) || DISPATCH_APPROVAL_TRANSITION_OPERATIONS.has(operation) || FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS.has(operation) || ["publish_plugin_artifacts", "publish_upgrade_result"].includes(operation)) && this.nodeId !== "flow") {
      throw new CurrentFlowStateInvariantError("Flow lifecycle, policy, outbox, and dispatch approval transitions must target only the Flow root id");
    }
    if (operation === "complete_acceptance_decision_noop" && status !== "done") {
      throw new CurrentFlowStateInvariantError("acceptance decision no-op transition requires done status");
    }
    if (["confirm_attempt", "complete_acceptance_decision_noop", DRAFT_COMPLETION_TRANSITION_OPERATION].includes(operation)) {
      if (!["done", "skipped"].includes(status)) {
        throw new CurrentFlowStateInvariantError("confirm_attempt transition requires done or skipped status");
      }
    } else if (status !== null) {
      throw new CurrentFlowStateInvariantError("only confirmation transitions may specify status");
    }
    this.status = status;
    Object.freeze(this);
  }

  apply(state, activity, { priorActivities = [] } = {}) {
    const targetId = this.nodeId;
    if (activity.nodeId !== targetId) throw new CurrentFlowStateInvariantError("Activity nodeId must match transition nodeId");
    if (this.operation !== FLOW_CREATION_TRANSITION_OPERATION) state.assertTransitionHandler(targetId);
    const currentPath = state.definition.pathFor(state.root, targetId);
    if (currentPath === null) throw new CurrentFlowStateInvariantError("Activity transition nodeId must identify a current-state node");
    const target = nodeAtPath(state.root, currentPath);
    if (state.lifecycle.state === "finalized") {
      throw new CurrentFlowStateInvariantError("finalized Flow rejects subsequent Activities");
    }
    if (this.operation === FLOW_CREATION_TRANSITION_OPERATION) {
      if (target.id !== state.root.id) {
        throw new CurrentFlowStateInvariantError("flow_created Activity must target the Flow root");
      }
      if (activity.confirmationOrder !== 1 || state.confirmationOrder !== 0 || state.current !== null || state.attempt !== null) {
        throw new CurrentFlowStateInvariantError("flow_created Activity must be the first fresh Flow Activity");
      }
      const fresh = freshStateLike(state, state.definition);
      if (!jsonEqual(state.toJSON(), fresh.toJSON())) {
        throw new CurrentFlowStateInvariantError("flow_created Activity requires the definition's fresh materialized state");
      }
      if (activity.id !== flowCreatedActivityId(state.identity)) {
        throw new CurrentFlowStateInvariantError("flow_created Activity id must be derived from the Flow identity");
      }
      return state;
    }
    if (LIFECYCLE_TRANSITION_OPERATIONS.has(this.operation)) {
      if (target.id !== state.root.id) {
        throw new CurrentFlowStateInvariantError("Flow lifecycle transition must target the Flow root");
      }
      if (this.operation === "park_flow") return state.park();
      if (this.operation === "resume_flow") return state.resume();
      return state.finalize();
    }
    if (POLICY_TRANSITION_OPERATIONS.has(this.operation)) {
      if (target.id !== state.root.id) {
        throw new CurrentFlowStateInvariantError("Flow policy transition must target the Flow root");
      }
      return state.withPolicy(this.policy);
    }
    if (this.operation === INTERRUPTED_FINALIZE_SYNC_OPERATION) {
      if (target.id !== "finalize-cleanup") throw new CurrentFlowStateInvariantError("interrupted finalize-sync Activity must target cleanup");
      return state.recoverInterruptedFinalizeSync({ outbox: this.outbox, cleanupAttempt: this.attempt, confirmedAt: activity.timing?.finishedAt });
    }
    if (OUTBOX_TRANSITION_OPERATIONS.has(this.operation)) {
      if (target.id !== state.root.id) {
        throw new CurrentFlowStateInvariantError("Flow outbox transition must target the Flow root");
      }
      return ["begin_outbox", "reopen_outbox"].includes(this.operation)
        ? state.withOutbox(state.outbox.begin(this.outbox.toEntry()))
        : state.withOutbox(state.outbox.settle(this.outbox.toEntry()));
    }
    if (FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS.has(this.operation)) {
      return state.finalizeDownstream({
        stepIds: this.finalizeSteps,
        status: this.operation === "skip_finalize_downstream" ? "skipped" : "pending",
        confirmedAt: activity.timing?.finishedAt ?? null,
      });
    }
    if (OBSERVATION_TRANSITION_OPERATIONS.has(this.operation)
      || this.operation === "record_nonblocking"
      || ARTIFACT_PUBLICATION_TRANSITION_OPERATIONS.has(this.operation)
      || DISPATCH_APPROVAL_TRANSITION_OPERATIONS.has(this.operation)) {
      // Observations and producer artifact publications deliberately do not
      // alter the state tree.  Their confirmation order still advances
      // through the same journal, so a crash cannot reorder durable evidence
      // around a lifecycle transition.
      if (this.operation === "publish_artifacts"
        && state.current?.at(-1) !== target.id) {
        throw new CurrentFlowStateInvariantError("artifact publication Activity must target the active current leaf");
      }
      if (this.operation === "publish_artifacts" && activity.attemptId !== null
        && (activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence)) {
        throw new CurrentFlowStateInvariantError("artifact publication Activity Attempt does not match the active producer Attempt");
      }
      return state;
    }
    if (this.operation === "continue_nonblocking") {
      if (this.nonblocking?.kind !== "decision" || this.nonblocking.action !== "continue") {
        throw new CurrentFlowStateInvariantError("continue_nonblocking requires a continue decision");
      }
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("continue_nonblocking Activity must target the active current leaf");
      }
      if (activity.result == null) throw new CurrentFlowStateInvariantError("continue_nonblocking Activity requires a result");
      return state.continueNonblockingAttempt({
        result: activity.result,
        skippedNodeIds: activity.references.repairs.map((reference) => reference.id),
      });
    }
    if (this.operation === "accept_final_regression_failure") {
      if (!REPLACEMENT_ATTEMPT_OPERATIONS.has(this.operation) && (activity.attemptId !== this.attempt.id || activity.sequence !== this.attempt.sequence)) {
        throw new CurrentFlowStateInvariantError(
          "accept_final_regression_failure Activity must identify its acceptance Attempt",
        );
      }
      if (activity.result == null) {
        throw new CurrentFlowStateInvariantError("accept_final_regression_failure Activity requires a result");
      }
      return state.acceptFinalRegressionFailure({ attempt: this.attempt, result: activity.result });
    }
    if (this.operation === "defer_failed_review") {
      if (activity.result == null) {
        throw new CurrentFlowStateInvariantError("defer_failed_review Activity requires a result");
      }
      return state.deferFailedReview({ attempt: this.attempt, result: activity.result });
    }
    if (this.operation === "defer_failed_gate") {
      if (activity.result == null) throw new CurrentFlowStateInvariantError("defer_failed_gate Activity requires a result");
      return state.deferFailedGate({
        attempt: this.attempt,
        result: activity.result,
        gateTaskLifecycle: this.gateTaskLifecycle,
      });
    }
    if (this.operation === "recover_task_execution_overrun") {
      return state.recoverTaskExecutionOverrun({
        attempt: this.attempt,
        priorActivities,
        references: activity.references,
      });
    }
    if (["add_task", "add_approval_task"].includes(this.operation)) {
      if (target.id !== state.definition.dynamicTaskContainerId) {
        throw new CurrentFlowStateInvariantError("Task admission Activity must target the definition dynamic Task container");
      }
      return this.operation === "add_task"
        ? state.addTask(this.task)
        : state.admitApprovalTask(this.task, { priorActivities });
    }
    if (["start_attempt", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact", "recover_task_execution_overrun"].includes(this.operation)) {
      if (!REPLACEMENT_ATTEMPT_OPERATIONS.has(this.operation) && (activity.attemptId !== this.attempt.id || activity.sequence !== this.attempt.sequence)) {
        throw new CurrentFlowStateInvariantError("Activity attemptId/sequence must match its transition Attempt");
      }
      if (this.operation === "start_attempt") {
        return state.startAttempt({ path: currentPath, attempt: this.attempt });
      }
      if (this.operation === "rewind") return state.rewind({ path: currentPath, attempt: this.attempt });
      if (this.operation === "rewind_test_evidence") {
        return state.rewindTestEvidence({ path: currentPath, attempt: this.attempt });
      }
      if (this.operation === "repair_test_review") {
        return state.repairTestReview({ path: currentPath, attempt: this.attempt });
      }
      if (this.operation === "settle_test_review_repair_timeout") {
        if (activity.result === null) throw new CurrentFlowStateInvariantError("test-review repair timeout settlement requires a result");
        return state.settleTimedOutTestReviewRepair({ attempt: this.attempt, result: activity.result });
      }
      if (this.operation === "repair_scenario_validity") {
        if (activity.failure === null || activity.result === null) {
          throw new CurrentFlowStateInvariantError("scenario repair Activity requires its semantic failure and result");
        }
        if (state.current?.at(-1) !== "scenario-validity"
          || activity.attemptId !== state.attempt?.id
          || activity.sequence !== state.attempt?.sequence) {
          throw new CurrentFlowStateInvariantError("scenario repair Activity must retain its active scenario Attempt identity");
        }
        const targetPath = state.definition.pathFor(state.root, this.attempt.nodeId);
        if (targetPath === null) throw new CurrentFlowStateInvariantError("scenario repair target is absent from the Flow definition");
        return state.repairScenarioValidity({
          path: targetPath, attempt: this.attempt, failure: activity.failure, result: activity.result,
        });
      }
      if (this.operation === "repair_implementation") {
        if (activity.result == null) throw new CurrentFlowStateInvariantError("repair_implementation Activity requires a result");
        if (this.attempt.nodeId !== "test-execute") throw new CurrentFlowStateInvariantError("repair_implementation must introduce test-execute");
        if (activity.attemptId !== state.attempt?.id || activity.sequence !== state.attempt?.sequence) {
          throw new CurrentFlowStateInvariantError("repair_implementation Activity must retain the active impl-repair Attempt identity");
        }
        return state.repairImplementation({ path: currentPath, attempt: this.attempt, result: activity.result });
      }
      if (this.operation === "triage_implementation_for_repair") {
        if (activity.result == null) throw new CurrentFlowStateInvariantError("triage_implementation_for_repair Activity requires a result");
        if (this.attempt.nodeId !== "impl-repair") throw new CurrentFlowStateInvariantError("triage_implementation_for_repair must introduce impl-repair");
        if (activity.attemptId !== state.attempt?.id || activity.sequence !== state.attempt?.sequence) {
          throw new CurrentFlowStateInvariantError("triage_implementation_for_repair Activity must retain the active impl-triage Attempt identity");
        }
        return state.triageImplementationForRepair({ path: currentPath, attempt: this.attempt, result: activity.result });
      }
      if (this.operation === "triage_implementation_no_repair") {
        if (activity.result == null) throw new CurrentFlowStateInvariantError("triage_implementation_no_repair Activity requires a result");
        if (this.attempt.nodeId !== "impl-gate") throw new CurrentFlowStateInvariantError("triage_implementation_no_repair must introduce impl-gate");
        if (activity.attemptId !== state.attempt?.id || activity.sequence !== state.attempt?.sequence) {
          throw new CurrentFlowStateInvariantError("triage_implementation_no_repair Activity must retain the active impl-triage Attempt identity");
        }
        return state.triageImplementationNoRepair({ path: currentPath, attempt: this.attempt, result: activity.result });
      }
      if (this.operation === "repair_acceptance_review") {
        if (activity.result == null || this.attempt.nodeId !== "impl-triage") throw new CurrentFlowStateInvariantError("repair_acceptance_review must introduce impl-triage with a result");
        if (activity.attemptId !== state.attempt?.id || activity.sequence !== state.attempt?.sequence) throw new CurrentFlowStateInvariantError("repair_acceptance_review must retain acceptance-review Attempt identity");
        return state.repairAcceptanceReview({ path: currentPath, attempt: this.attempt, result: activity.result });
      }
      if (this.operation === "preimplementation_bootstrap") {
        return state.preimplementationBootstrap({
          path: currentPath,
          attempt: this.attempt,
          confirmedAt: activity.timing?.finishedAt,
        });
      }
      if (this.operation === "recover_existing_implementation") {
        return state.recoverExistingImplementation({
          path: currentPath,
          attempt: this.attempt,
          confirmedAt: activity.timing?.finishedAt,
        });
      }
      if (this.operation.startsWith("reopen_draft_")) {
        return state.reopenDraft({
          path: currentPath,
          attempt: this.attempt,
          route: this.operation === "reopen_draft_task_addition"
            ? "task-addition"
            : this.operation === "reopen_draft_spec_correction"
              ? "spec-correction"
              : this.operation.slice("reopen_draft_".length),
        });
      }
      if (this.operation === "plan_gate_repair") {
        return state.repairPlanGate({ path: currentPath, attempt: this.attempt, taskLifecycle: this.gateTaskLifecycle });
      }
      if (this.operation === "recover_missing_producer_artifact") {
        return state.recoverMissingProducerArtifact({ path: currentPath, attempt: this.attempt });
      }
      return state.recover({ path: currentPath, attempt: this.attempt });
    }
    if (this.operation === "retry_recovery_attempt") {
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("exhausted retry target is not the active current leaf");
      }
      return state.retryExhaustedAttempt({ attempt: this.attempt });
    }
    if (this.operation === "retry_gate_attempt") {
      if (state.current == null || state.current.at(-1) !== targetId
        || activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("retry_gate_attempt Activity must identify the active Gate Attempt");
      }
      return state.retryGateAttempt({ attempt: this.attempt });
    }
    if (this.operation === "retry_attempt") {
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("retry_attempt Activity must target the active current leaf");
      }
      if (activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("retry_attempt Activity must identify the active Attempt being replaced");
      }
      return targetId === "final-regression"
        ? state.retryFinalRegressionAttempt({ attempt: this.attempt })
        : state.retryCurrentAttempt({ attempt: this.attempt, kind: state.attempt.failure.retryKind });
    }
    if (this.operation === "update_attempt") {
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("update_attempt Activity must target the active current leaf");
      }
      if (activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("update_attempt Activity must identify the active Attempt being replaced");
      }
      return state.replaceCurrentAttempt({ attempt: this.attempt });
    }
    if (this.operation === TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION) {
      return state.recoverTaskGateClassification({
        attempt: this.attempt,
        priorActivities,
        activityId: activity.id,
      });
    }
    if (this.operation === "fail_attempt") {
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("fail_attempt Activity must target the active current leaf");
      }
      if (activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("fail_attempt Activity must identify the active Attempt");
      }
      return state.failCurrentAttempt({ failure: activity.failure, result: activity.result });
    }
    if (this.operation === "record_failure") {
      if (state.current == null || state.current.at(-1) !== targetId) {
        throw new CurrentFlowStateInvariantError("record_failure Activity must target the active current leaf");
      }
      if (activity.attemptId !== state.attempt.id || activity.sequence !== state.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("record_failure Activity must identify the active failed Attempt");
      }
      if (activity.result == null) throw new CurrentFlowStateInvariantError("record_failure Activity requires a result");
      return state.recordCurrentFailure({ result: activity.result });
    }
    if (this.operation === DRAFT_COMPLETION_TRANSITION_OPERATION) {
      if (activity.result == null) throw new CurrentFlowStateInvariantError("draft completion Activity requires a result");
      if (activity.attemptId !== this.stepConnectionReceipt.sourceAttempt.id
        || activity.sequence !== this.stepConnectionReceipt.sourceAttempt.sequence) {
        throw new CurrentFlowStateInvariantError("draft completion Activity must bind its source Attempt receipt");
      }
      return state.completeDraftCompletion({ result: activity.result, receipt: this.stepConnectionReceipt });
    }
    if (this.operation === TASK_REVIEW_STAGE_TRANSITION_OPERATION) {
      if (activity.result == null) throw new CurrentFlowStateInvariantError("Task Review stage completion requires a result");
      return state.completeTaskReviewStage({ result: activity.result, plan: this.taskReviewStagePlan });
    }
    if (this.operation === "advance_task_review_stage") {
      if (activity.result == null) throw new CurrentFlowStateInvariantError("Task Review stage advancement requires a result");
      return state.completeTaskReviewStage({
        result: activity.result,
        plan: this.taskReviewStagePlan,
        targetAttempt: this.attempt,
      });
    }
    if (state.current == null || state.current.at(-1) !== targetId) {
      throw new CurrentFlowStateInvariantError("confirm_attempt Activity must target the active current leaf");
    }
    if (activity.attemptId !== state.attempt.id) {
      throw new CurrentFlowStateInvariantError("confirm_attempt Activity attemptId must match the current Attempt");
    }
    if (activity.sequence !== state.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("confirm_attempt Activity sequence must match the current Attempt sequence");
    }
    if (activity.result == null) throw new CurrentFlowStateInvariantError("confirm_attempt Activity requires a result");
    if (this.operation === "complete_acceptance_decision_noop") {
      return state.completeAcceptanceDecisionNoOp({ result: activity.result });
    }
    return state.confirmCurrentAttempt({
      result: activity.result,
      status: this.status,
      gateTaskLifecycle: this.gateTaskLifecycle?.toJSON() ?? null,
    });
  }

  toJSON() {
    return {
      operation: this.operation,
      nodeId: this.nodeId,
      task: this.task?.toJSON() ?? null,
      attempt: this.attempt?.toJSON() ?? null,
      status: this.status,
      policy: this.policy?.toJSON() ?? null,
      outbox: this.outbox?.toJSON() ?? null,
      approval: this.approval?.toJSON() ?? null,
      nonblocking: this.nonblocking?.toJSON() ?? null,
      finalizeSteps: this.finalizeSteps,
      gateTaskLifecycle: this.gateTaskLifecycle?.toJSON() ?? null,
      stepConnectionReceipt: this.stepConnectionReceipt?.toJSON() ?? null,
      taskReviewStagePlan: this.taskReviewStagePlan?.toJSON() ?? null,
    };
  }
}

export class FlowActivity {
  constructor(value) {
    requireExactFields(value, new Set([
      "id", "nodeId", "nodeKey", "attemptId", "sequence", "confirmationOrder", "type", "transition",
      "result", "timing", "failure", "provider", "model", "effort", "usage", "references", "metric", "note",
      "reviewPublication",
    ]), "activity");
    const {
      id, nodeId, nodeKey, attemptId, sequence, confirmationOrder, type, transition,
      result, timing, failure, provider, model, effort, usage, references, metric, note, reviewPublication,
    } = value;
    this.id = requireString(id, "activity.id");
    this.nodeId = requireString(nodeId, "activity.nodeId");
    this.nodeKey = requireString(nodeKey, "activity.nodeKey");
    if (attemptId !== null) requireString(attemptId, "activity.attemptId");
    this.attemptId = attemptId;
    if (sequence !== null) requirePositiveInteger(sequence, "activity.sequence");
    this.sequence = sequence;
    this.confirmationOrder = requirePositiveInteger(confirmationOrder, "activity.confirmationOrder");
    if (!ATTEMPT_TYPES.has(type)) throw new CurrentFlowStateInvariantError(`activity.type is invalid: ${type}`);
    this.type = type;
    this.transition = transition instanceof ActivityTransition ? transition : new ActivityTransition(transition);
    const typeForOperation = {
      [FLOW_CREATION_TRANSITION_OPERATION]: FLOW_CREATION_ACTIVITY_TYPE,
      add_task: "task_added",
      add_approval_task: "task_added",
      start_attempt: "attempt_started",
      retry_attempt: "attempt_retried",
      retry_gate_attempt: "attempt_retried",
      retry_recovery_attempt: "attempt_recovered",
      update_attempt: "attempt_updated",
      [TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION]: "recovery",
      fail_attempt: "attempt_failed",
      record_failure: "failure_recorded",
      confirm_attempt: "result_confirmed",
      [DRAFT_COMPLETION_TRANSITION_OPERATION]: "result_confirmed",
      [TASK_REVIEW_STAGE_TRANSITION_OPERATION]: "result_confirmed",
      advance_task_review_stage: "result_confirmed",
      complete_acceptance_decision_noop: "result_confirmed",
      rewind: "recovery",
      rewind_test_evidence: "recovery",
      repair_test_review: "recovery",
      settle_test_review_repair_timeout: "result_confirmed",
      repair_scenario_validity: "recovery",
      repair_implementation: "recovery",
      triage_implementation_for_repair: "recovery",
      triage_implementation_no_repair: "recovery",
      repair_acceptance_review: "recovery",
      preimplementation_bootstrap: "recovery",
      recover_existing_implementation: "recovery",
      reopen_draft_preimplementation: "recovery",
      reopen_draft_task_addition: "recovery",
      reopen_draft_spec_correction: "recovery",
      plan_gate_repair: "recovery",
      recover_attempt: "recovery",
      recover_missing_producer_artifact: "recovery",
      recover_task_execution_overrun: "recovery",
      park_flow: "flow_parked",
      resume_flow: "flow_resumed",
      finalize_flow: "flow_finalized",
      set_policy: "policy_updated",
      publish_artifacts: "artifacts_published",
      publish_plugin_artifacts: "artifacts_published",
      publish_upgrade_result: "artifacts_published",
      update_spec_record: "spec_record_updated",
      begin_outbox: "outbox_started",
      reopen_outbox: "outbox_reopened",
      complete_outbox: "outbox_completed",
      fail_outbox: "outbox_failed",
      record_dispatch_approval: "dispatch_approval_recorded",
      record_metric: "metric_recorded",
      record_note: "note_recorded",
      record_nonblocking: "nonblocking_recorded",
      continue_nonblocking: "nonblocking_recorded",
      accept_final_regression_failure: "failure_accepted",
      defer_failed_review: "failure_accepted",
      defer_failed_gate: "failure_accepted",
      skip_finalize_downstream: "finalization_downstream_updated",
      reset_finalize_downstream: "finalization_downstream_updated",
      recover_interrupted_finalize_sync: "recovery",
    };
    if (typeForOperation[this.transition.operation] !== this.type) {
      throw new CurrentFlowStateInvariantError("activity.type must match its deterministic transition operation");
    }
    if (this.transition.nodeId !== this.nodeId) {
      throw new CurrentFlowStateInvariantError("Activity nodeId must match transition nodeId");
    }
    const flowCreated = this.transition.operation === FLOW_CREATION_TRANSITION_OPERATION;
    if (flowCreated && (
      this.confirmationOrder !== 1
      || !/^flow-created-[a-f0-9]{64}$/.test(this.id)
    )) {
      throw new CurrentFlowStateInvariantError("flow_created Activity requires its deterministic first-Activity identity");
    }
    this.result = result == null ? null : result instanceof NodeResult ? result : new NodeResult(result);
    if (["confirm_attempt", DRAFT_COMPLETION_TRANSITION_OPERATION, TASK_REVIEW_STAGE_TRANSITION_OPERATION, "advance_task_review_stage", "complete_acceptance_decision_noop", "fail_attempt", "record_failure", "continue_nonblocking", "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "settle_test_review_repair_timeout"].includes(this.transition.operation) && this.result == null) {
      throw new CurrentFlowStateInvariantError("completed Attempt Activity requires a result");
    }
    if (!["confirm_attempt", DRAFT_COMPLETION_TRANSITION_OPERATION, TASK_REVIEW_STAGE_TRANSITION_OPERATION, "advance_task_review_stage", "complete_acceptance_decision_noop", "fail_attempt", "record_failure", "continue_nonblocking", "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "settle_test_review_repair_timeout"].includes(this.transition.operation) && this.result !== null) {
      throw new CurrentFlowStateInvariantError("only completed Attempt Activity may carry a result");
    }
    if (["fail_attempt", "record_failure", "repair_scenario_validity"].includes(this.transition.operation) && !["failed", "incomplete"].includes(this.result.outcome)) {
      throw new CurrentFlowStateInvariantError(`${this.transition.operation} Activity result must be failed or incomplete`);
    }
    if (
      flowCreated
      || ["add_task", "add_approval_task"].includes(this.transition.operation)
      || LIFECYCLE_TRANSITION_OPERATIONS.has(this.transition.operation)
      || POLICY_TRANSITION_OPERATIONS.has(this.transition.operation)
      || (ARTIFACT_PUBLICATION_TRANSITION_OPERATIONS.has(this.transition.operation)
        && this.transition.operation !== "publish_artifacts")
      || OUTBOX_TRANSITION_OPERATIONS.has(this.transition.operation)
      || FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS.has(this.transition.operation)
      || DISPATCH_APPROVAL_TRANSITION_OPERATIONS.has(this.transition.operation)
      || OBSERVATION_TRANSITION_OPERATIONS.has(this.transition.operation)
      || this.transition.operation === "record_nonblocking"
    ) {
      if (this.attemptId !== null || this.sequence !== null) {
        throw new CurrentFlowStateInvariantError("Task, Flow lifecycle/policy/outbox/dispatch approval, artifact publication, and observation Activities must not carry Attempt identity or sequence");
      }
    } else if (this.transition.operation === "publish_artifacts") {
      if ((this.attemptId === null) !== (this.sequence === null)) {
        throw new CurrentFlowStateInvariantError("producer artifact publication Activity Attempt identity and sequence must both be present or absent");
      }
    } else if (this.attemptId === null || this.sequence === null) {
      throw new CurrentFlowStateInvariantError("Attempt Activity requires Attempt identity and sequence");
    }
    if (["start_attempt", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact", "recover_task_execution_overrun", "retry_recovery_attempt", "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", INTERRUPTED_FINALIZE_SYNC_OPERATION].includes(this.transition.operation)) {
      if (!REPLACEMENT_ATTEMPT_OPERATIONS.has(this.transition.operation) && (this.attemptId !== this.transition.attempt.id || this.sequence !== this.transition.attempt.sequence)) {
        throw new CurrentFlowStateInvariantError("Activity attemptId/sequence must match its transition Attempt");
      }
      if (this.transition.attempt.nodeId !== this.nodeId && !REPLACEMENT_ATTEMPT_OPERATIONS.has(this.transition.operation)) {
        throw new CurrentFlowStateInvariantError("Activity transition Attempt nodeId must match the Activity nodeId");
      }
    }
    if (["update_attempt", TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION].includes(this.transition.operation)) {
      if (this.attemptId !== this.transition.attempt.id || this.sequence !== this.transition.attempt.sequence) {
        throw new CurrentFlowStateInvariantError("Attempt replacement Activity identity must match its replacement Attempt");
      }
      if (this.transition.attempt.nodeId !== this.nodeId) {
        throw new CurrentFlowStateInvariantError("replacement Attempt nodeId must match the Activity nodeId");
      }
    }
    this.timing = timing == null ? null : new ActivityTiming(timing);
    this.failure = failure == null ? null : new ActivityFailure(failure);
    if (["fail_attempt", "repair_scenario_validity"].includes(this.transition.operation)) {
      if (this.failure == null) {
        throw new CurrentFlowStateInvariantError(`${this.transition.operation} Activity requires failure facts`);
      }
    } else if (this.failure !== null) {
      throw new CurrentFlowStateInvariantError("only failure settlement Activities may carry failure facts");
    }
    for (const [field, value] of Object.entries({ provider, model, effort })) {
      if (value !== null) requireString(value, `activity.${field}`);
    }
    this.provider = provider;
    this.model = model;
    this.effort = effort;
    this.usage = usage == null ? null : new ActivityUsage(usage);
    this.references = references instanceof ActivityReferences ? references : new ActivityReferences(references);
    this.metric = metric == null ? null : metric instanceof ActivityMetric ? metric : new ActivityMetric(metric);
    this.note = note == null ? null : note instanceof ActivityNote ? note : new ActivityNote(note);
    this.reviewPublication = reviewPublication === null
      ? null
      : reviewPublication instanceof ActivityReviewPublication
        ? reviewPublication
        : new ActivityReviewPublication(reviewPublication);
    if (this.reviewPublication !== null) {
      const expectedStage = REVIEW_PUBLICATION_STAGE_BY_NODE.get(this.nodeId) ?? null;
      if (expectedStage === null
        || this.transition.operation !== "confirm_attempt"
        || this.type !== "result_confirmed"
        || this.reviewPublication.stage !== expectedStage) {
        throw new CurrentFlowStateInvariantError("review publication facts are reserved for confirmed canonical Spec review stages");
      }
    }
    if (this.transition.operation === "record_metric") {
      if (this.metric === null || this.note !== null || this.timing === null) {
        throw new CurrentFlowStateInvariantError("record_metric Activity requires metric facts and timing only");
      }
    } else if (this.transition.operation === "record_note") {
      if (this.note === null || this.metric !== null || this.timing === null) {
        throw new CurrentFlowStateInvariantError("record_note Activity requires note facts and timing only");
      }
    } else if (this.metric !== null || this.note !== null) {
      throw new CurrentFlowStateInvariantError("only observation Activities may carry metric or note facts");
    }
    if (flowCreated) {
      const references = this.references.toJSON();
      const nonArtifactReferencesEmpty = [references.evaluations, references.findings, references.repairs]
        .every((entries) => entries.length === 0);
      const creationEvidence = references.artifacts.map((reference) => {
        const contract = FLOW_ARTIFACT_CONTRACTS.classify(reference.id);
        if (contract.logicalKey.toString() !== "activity.evidence") {
          throw new CurrentFlowStateInvariantError("flow_created Activity may reference only immutable Activity evidence");
        }
        return FlowArtifactActivityEvidence.fromCanonicalPath(contract, reference.id);
      });
      if (creationEvidence.length > 1 || creationEvidence.some((entry) => entry.owner.nodeId !== this.nodeId)) {
        throw new CurrentFlowStateInvariantError("flow_created Activity evidence must be owned by the Flow root");
      }
      if (
        this.result !== null
        || this.timing === null
        || this.timing.startedAt !== this.timing.finishedAt
        || this.timing.durationMs !== 0
        || this.failure !== null
        || this.provider !== null
        || this.model !== null
        || this.effort !== null
        || this.usage !== null
        || !nonArtifactReferencesEmpty
      ) {
        throw new CurrentFlowStateInvariantError("flow_created Activity records only its exact creation timing");
      }
    }
    Object.freeze(this);
  }

  startsAttempt({ nodeId, id, sequence }) {
    const attempt = this.transition.attempt;
    return ATTEMPT_INTRODUCTION_OPERATIONS.has(this.transition.operation)
      && attempt?.nodeId === nodeId && attempt.id === id && attempt.sequence === sequence
      && (this.nodeId === nodeId || this.transition.taskReviewStagePlan?.targetStepId === nodeId);
  }

  static canonical(value) {
    const serialized = value instanceof FlowActivity
      ? FlowActivity.prototype.toJSON.call(value)
      : value;
    return FlowActivity.fromSerialized(serialized);
  }

  /** Parse the current durable Activity format without accepting omitted fields. */
  static fromSerialized(value) {
    if (!Object.hasOwn(value ?? {}, "reviewPublication")) {
      throw new CurrentFlowStateInvariantError("durable Activity must declare reviewPublication");
    }
    requireExactFields(value?.transition, ACTIVITY_TRANSITION_FIELDS, "activity.transition");
    return new FlowActivity(value);
  }

  static flowCreated(state, createdAt, { artifactReferences = [] } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("flow_created Activity requires a typed fresh Flow state");
    }
    const timestamp = requireIso(createdAt, "flow_created Activity timestamp");
    return new FlowActivity({
      id: flowCreatedActivityId(state.identity),
      nodeId: state.root.id,
      nodeKey: state.root.key,
      attemptId: null,
      sequence: null,
      confirmationOrder: 1,
      type: FLOW_CREATION_ACTIVITY_TYPE,
      transition: {
        operation: FLOW_CREATION_TRANSITION_OPERATION,
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        policy: null,
        outbox: null,
        approval: null,
        nonblocking: null,
        finalizeSteps: null,
        gateTaskLifecycle: null,
      },
      result: null,
      timing: { startedAt: timestamp, finishedAt: timestamp, durationMs: 0 },
      failure: null,
      provider: null,
      model: null,
      effort: null,
      usage: null,
      references: { evaluations: [], findings: [], repairs: [], artifacts: artifactReferences },
      metric: null,
      note: null,
      reviewPublication: null,
    });
  }

  withReviewPublication(reviewPublication) {
    return new FlowActivity({ ...this.toJSON(), reviewPublication });
  }

  toJSON() {
    return {
      id: this.id,
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      attemptId: this.attemptId,
      sequence: this.sequence,
      confirmationOrder: this.confirmationOrder,
      type: this.type,
      transition: this.transition.toJSON(),
      result: this.result?.toJSON() ?? null,
      timing: this.timing?.toJSON() ?? null,
      failure: this.failure?.toJSON() ?? null,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
      usage: this.usage?.toJSON() ?? null,
      references: this.references.toJSON(),
      metric: this.metric?.toJSON() ?? null,
      note: this.note?.toJSON() ?? null,
      reviewPublication: this.reviewPublication?.toJSON() ?? null,
    };
  }
}

const REVIEW_PUBLICATION_STAGE_BY_NODE = new Map([
  ["spec-review", "spec-review"],
  ["spec-triage", "spec-triage"],
  ["spec-repair", "spec-repair"],
]);

/** Exact immutable Spec identity recorded beside a canonical review publication. */
export class ActivityReviewPublicationIdentity {
  constructor(value) {
    requireExactFields(value, new Set(["specId", "revision", "digest", "byteLength"]), "activity.reviewPublication.identity");
    this.specId = requireString(value.specId, "activity.reviewPublication.identity.specId");
    this.revision = requirePositiveInteger(value.revision, "activity.reviewPublication.identity.revision");
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) {
      throw new CurrentFlowStateInvariantError("activity.reviewPublication.identity.digest must be a SHA-256 digest");
    }
    this.digest = value.digest;
    this.byteLength = requirePositiveInteger(value.byteLength, "activity.reviewPublication.identity.byteLength", { allowZero: true });
    Object.freeze(this);
  }

  matches(identity) {
    return identity?.specId === this.specId
      && identity?.revision?.value === this.revision
      && identity?.digest === this.digest
      && identity?.byteLength === this.byteLength;
  }

  toJSON() {
    return {
      specId: this.specId,
      revision: this.revision,
      digest: this.digest,
      byteLength: this.byteLength,
    };
  }
}

/** Parent-derived receipt tying one confirmation Activity to exact review bytes. */
export class ActivityReviewPublication {
  constructor(value) {
    requireExactFields(value, new Set(["generation", "identity", "reviewDigest", "relation", "stage", "outcome"]), "activity.reviewPublication");
    this.generation = requirePositiveInteger(value.generation, "activity.reviewPublication.generation");
    this.identity = value.identity instanceof ActivityReviewPublicationIdentity
      ? value.identity
      : new ActivityReviewPublicationIdentity(value.identity);
    if (typeof value.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.reviewDigest)) {
      throw new CurrentFlowStateInvariantError("activity.reviewPublication.reviewDigest must be a SHA-256 digest");
    }
    this.reviewDigest = value.reviewDigest;
    if (value.relation !== "revision-scoped-canonical-review") {
      throw new CurrentFlowStateInvariantError("activity.reviewPublication relation is invalid");
    }
    this.relation = value.relation;
    if (!REVIEW_PUBLICATION_STAGE_BY_NODE.has(value.stage)) {
      throw new CurrentFlowStateInvariantError("activity.reviewPublication stage is invalid");
    }
    this.stage = value.stage;
    if (!new Set(["replaced", "merged", "no-op"]).has(value.outcome)) {
      throw new CurrentFlowStateInvariantError("activity.reviewPublication outcome is invalid");
    }
    this.outcome = value.outcome;
    Object.freeze(this);
  }

  assertReview(review, { specId, revision, bytes } = {}) {
    if (!(review instanceof CanonicalSpecReview)
      || !Buffer.isBuffer(bytes)
      || this.generation !== review.generation
      || this.identity.specId !== specId
      || this.identity.revision !== revision
      || !this.identity.matches(review.identity)
      || review.digest !== this.reviewDigest
      || review.digest !== sha256Bytes(bytes)) {
      throw new CurrentFlowStateInvariantError("Activity review publication fact does not match canonical review bytes");
    }
    const audit = review.audit.at(-1) ?? null;
    if (audit === null
      || audit.stage !== this.stage
      || audit.relation !== this.relation
      || audit.outcome !== this.outcome) {
      throw new CurrentFlowStateInvariantError("Activity review publication fact does not match canonical review audit");
    }
    return review;
  }

  toJSON() {
    return {
      generation: this.generation,
      identity: this.identity.toJSON(),
      reviewDigest: this.reviewDigest,
      relation: this.relation,
      stage: this.stage,
      outcome: this.outcome,
    };
  }
}

export class ActivityTiming {
  constructor(value) {
    requireExactFields(value, new Set(["startedAt", "finishedAt", "durationMs"]), "activity.timing");
    const { startedAt, finishedAt, durationMs } = value;
    this.startedAt = requireIso(startedAt, "activity.timing.startedAt");
    this.finishedAt = requireIso(finishedAt, "activity.timing.finishedAt");
    if (Date.parse(this.finishedAt) < Date.parse(this.startedAt)) throw new CurrentFlowStateInvariantError("activity.timing cannot finish before it starts");
    if (durationMs !== null) requirePositiveInteger(durationMs, "activity.timing.durationMs", { allowZero: true });
    this.durationMs = durationMs;
    Object.freeze(this);
  }

  toJSON() { return { startedAt: this.startedAt, finishedAt: this.finishedAt, durationMs: this.durationMs }; }
}

export class ActivityUsage {
  constructor(value) {
    requireExactFields(value, new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cost"]), "activity.usage");
    const { inputTokens, outputTokens, cacheReadTokens, cost } = value;
    this.inputTokens = requirePositiveInteger(inputTokens, "activity.usage.inputTokens", { allowZero: true });
    this.outputTokens = requirePositiveInteger(outputTokens, "activity.usage.outputTokens", { allowZero: true });
    this.cacheReadTokens = requirePositiveInteger(cacheReadTokens, "activity.usage.cacheReadTokens", { allowZero: true });
    if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
      throw new CurrentFlowStateInvariantError("activity.usage.cost must be a non-negative number or null");
    }
    this.cost = cost;
    Object.freeze(this);
  }

  toJSON() { return { inputTokens: this.inputTokens, outputTokens: this.outputTokens, cacheReadTokens: this.cacheReadTokens, cost: this.cost }; }
}

/**
 * Derived read views owned by the canonical state and Activity model.
 * Consumers may choose their own public projection, but timestamp and metric
 * authority must remain defined here beside the records that carry the facts.
 */
export class CurrentFlowActivitySummary {
  constructor(activities) {
    if (!Array.isArray(activities) || activities.some((entry) => !(entry instanceof FlowActivity))) {
      throw new CurrentFlowStateInvariantError("Activity summary requires typed Activities");
    }
    this.activities = Object.freeze([...activities]);
    Object.freeze(this);
  }

  timestamps() {
    const created = this.activities.find((entry) => (
      entry.transition.operation === FLOW_CREATION_TRANSITION_OPERATION
      && entry.type === FLOW_CREATION_ACTIVITY_TYPE
    )) ?? null;
    const updated = this.activities
      .filter((entry) => STATE_CHANGING_TRANSITION_OPERATIONS.has(entry.transition.operation))
      .at(-1) ?? null;
    const finalized = this.activities
      .filter((entry) => entry.transition.operation === "finalize_flow")
      .at(-1) ?? null;
    const timestamp = (value, reason) => value === null
      ? { value: null, availability: "unavailable", reason, provenance: "confirmed-activity-prefix" }
      : { value, availability: "available", reason: null, provenance: "activity-timing.finishedAt" };
    return {
      createdAt: timestamp(created?.timing?.finishedAt ?? null, "creation evidence is unavailable"),
      updatedAt: timestamp(updated?.timing?.finishedAt ?? null, "state-changing Activity evidence is unavailable"),
      finalizedAt: timestamp(finalized?.timing?.finishedAt ?? null, "finalize_flow Activity evidence is unavailable"),
    };
  }

  metricCounterTotals() {
    const totals = new Map();
    for (const activity of this.activities) {
      const metric = activity.metric;
      if (metric === null || metric.counter === null) continue;
      const key = [metric.phase, metric.counter, metric.provider, metric.profileKey].join("\u0000");
      if (metric.reset) totals.set(key, 0);
      const previous = totals.get(key) ?? 0;
      const next = previous + metric.delta;
      if (!Number.isSafeInteger(next)) {
        throw new CurrentFlowStateInvariantError("Activity metric counter aggregate exceeds its numeric limit");
      }
      totals.set(key, next);
    }
    return Object.freeze(Object.fromEntries(totals));
  }

  metrics({ artifactCount, stepCount, taskCount } = {}) {
    for (const [field, value] of Object.entries({ artifactCount, stepCount, taskCount })) {
      requirePositiveInteger(value, `Activity summary.${field}`, { allowZero: true });
    }
    const totals = { durationMs: [], inputTokens: [], outputTokens: [], cacheReadTokens: [], cost: [] };
    const add = (field, value) => {
      if (value !== null && value !== undefined) totals[field].push(value);
    };
    for (const activity of this.activities) {
      // Aggregate metrics are sourced only from confirmed Activity timing and
      // ActivityUsage. record_metric observations are a separate ledger view,
      // not another usage authority.
      add("durationMs", activity.timing?.durationMs);
      if (activity.usage !== null && activity.usage !== undefined) {
        add("inputTokens", activity.usage.inputTokens);
        add("outputTokens", activity.usage.outputTokens);
        add("cacheReadTokens", activity.usage.cacheReadTokens);
        add("cost", activity.usage.cost);
      }
    }
    const sum = (values, field) => {
      if (values.length === 0) return null;
      const total = values.reduce((current, value) => {
        const next = current + value;
        if (!Number.isFinite(next) || (field !== "cost" && !Number.isSafeInteger(next))) {
          throw new CurrentFlowStateInvariantError(`Activity summary metric ${field} exceeds its numeric limit`);
        }
        return next;
      }, 0);
      return total;
    };
    const result = {
      activityCount: this.activities.length,
      artifactCount,
      stepCount,
      taskCount,
      durationMs: sum(totals.durationMs, "durationMs"),
      inputTokens: sum(totals.inputTokens, "inputTokens"),
      outputTokens: sum(totals.outputTokens, "outputTokens"),
      cacheReadTokens: sum(totals.cacheReadTokens, "cacheReadTokens"),
      cost: sum(totals.cost, "cost"),
      provenance: AGGREGATE_METRIC_PROVENANCE,
    };
    // Counter observations are a separate reset-aware stream. Keep their
    // accounting available to canonical consumers without widening the exact
    // AggregateMetrics response or mixing them into usage totals.
    Object.defineProperty(result, "metricCounters", {
      value: this.metricCounterTotals(),
      enumerable: false,
    });
    return result;
  }
}

function assertJournalAttemptIdentities(entries) {
  const identities = new Map();
  const lastSequenceByNode = new Map();
  const lastActivityByAttempt = new Map();
  const registerIdentity = (attemptId, sequence, nodeId) => {
    const previous = identities.get(attemptId);
    if (previous && (previous.sequence !== sequence || previous.nodeId !== nodeId)) {
      throw new CurrentFlowStateInvariantError(`Attempt id ${attemptId} is reused for a different node or sequence`);
    }
    identities.set(attemptId, { sequence, nodeId });
  };
  for (const entry of entries) {
    if (entry.transition.operation === DRAFT_COMPLETION_TRANSITION_OPERATION) {
      const receipt = entry.transition.stepConnectionReceipt;
      for (const [attempt, nodeId] of [[receipt.sourceAttempt, receipt.sourceStepId]]) {
        const known = identities.get(attempt.id);
        if (known !== undefined) {
          registerIdentity(attempt.id, attempt.sequence, nodeId);
          continue;
        }
        const previousSequence = lastSequenceByNode.get(nodeId);
        if (previousSequence !== undefined && attempt.sequence !== previousSequence + 1) {
          throw new CurrentFlowStateInvariantError(`Attempt sequence must be contiguous for node ${nodeId}`);
        }
        registerIdentity(attempt.id, attempt.sequence, nodeId);
        lastSequenceByNode.set(nodeId, attempt.sequence);
      }
    }
    if (entry.transition.operation === "record_failure") {
      const failureActivity = lastActivityByAttempt.get(entry.attemptId);
      if (
        failureActivity?.transition.operation !== "fail_attempt"
        || !jsonEqual(failureActivity.result.toJSON(), entry.result.toJSON())
      ) {
        throw new CurrentFlowStateInvariantError(
          "record_failure Activity must immediately preserve the failed Attempt result",
        );
      }
    }
    if (entry.transition.operation === "recover_missing_producer_artifact") {
      const restored = entry.transition.attempt;
      const producer = identities.get(restored.id);
      const latest = lastActivityByAttempt.get(restored.id);
      if (
        !producer
        || producer.nodeId !== restored.nodeId
        || producer.sequence !== restored.sequence
        || restored.failure === null
        || latest?.transition.operation !== "record_failure"
      ) {
        throw new CurrentFlowStateInvariantError(
          "missing producer artifact recovery must restore a previously recorded failed Attempt",
        );
      }
    }
    if (ATTEMPT_INTRODUCTION_OPERATIONS.has(entry.transition.operation)) {
      const introduced = entry.transition.attempt;
      const replacement = REPLACEMENT_ATTEMPT_OPERATIONS.has(entry.transition.operation);
      if (introduced.nodeId !== entry.nodeId && !replacement) {
        throw new CurrentFlowStateInvariantError("introduced Attempt nodeId must match its Activity nodeId");
      }
      const previousSequence = lastSequenceByNode.get(introduced.nodeId);
      // A journal's first visible Attempt need not be a Flow's first Attempt:
      // historical state can retain a direct, pre-journal cursor. The state
      // transition remains the authority for that first visible sequence;
      // subsequent journal introductions must still be contiguous here.
      if (previousSequence !== undefined && introduced.sequence !== previousSequence + 1) {
        throw new CurrentFlowStateInvariantError(`Attempt sequence must be contiguous for node ${introduced.nodeId}`);
      }
      registerIdentity(introduced.id, introduced.sequence, introduced.nodeId);
      lastSequenceByNode.set(introduced.nodeId, introduced.sequence);
    }
    if (entry.attemptId !== null) {
      const known = identities.get(entry.attemptId);
      if (!known) {
        throw new CurrentFlowStateInvariantError(`Activity references an unknown Attempt id: ${entry.attemptId}`);
      }
      if (known.nodeId !== entry.nodeId && !REPLACEMENT_ATTEMPT_OPERATIONS.has(entry.transition.operation)) {
        throw new CurrentFlowStateInvariantError("Activity Attempt identity does not match its node");
      }
      registerIdentity(entry.attemptId, entry.sequence, known.nodeId);
    }
    if (["update_attempt", TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION].includes(entry.transition.operation)) {
      if (entry.transition.attempt.nodeId !== entry.nodeId) {
        throw new CurrentFlowStateInvariantError("updated Attempt nodeId must match its Activity nodeId");
      }
      registerIdentity(entry.transition.attempt.id, entry.transition.attempt.sequence, entry.nodeId);
    }
    if (entry.attemptId !== null) lastActivityByAttempt.set(entry.attemptId, entry);
  }
}

class FlowActivityJournalRevision {
  constructor(stat) {
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || !Number.isSafeInteger(stat.dev)
      || !Number.isSafeInteger(stat.ino)
      || !Number.isSafeInteger(stat.size)
      || stat.size < 0
      || !Number.isFinite(stat.mtimeMs)
      || !Number.isFinite(stat.ctimeMs)
    ) {
      throw new CurrentFlowStateInvariantError("Activity journal authority changed while opening");
    }
    this.dev = stat.dev;
    this.ino = stat.ino;
    this.size = stat.size;
    this.mtimeMs = stat.mtimeMs;
    this.ctimeMs = stat.ctimeMs;
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof FlowActivityJournalRevision
      && this.dev === other.dev
      && this.ino === other.ino
      && this.size === other.size
      && this.mtimeMs === other.mtimeMs
      && this.ctimeMs === other.ctimeMs;
  }
}

class FlowActivityJournalPrefix {
  constructor({ entryCount, bytes } = {}) {
    if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
      throw new CurrentFlowStateInvariantError("activity journal prefix entry count must be a non-negative integer");
    }
    if (!Buffer.isBuffer(bytes)) throw new CurrentFlowStateInvariantError("activity journal prefix requires exact bytes");
    this.entryCount = entryCount;
    // The prefix is a view over a private immutable snapshot buffer. Keeping
    // that view avoids copying the complete confirmed journal merely to make
    // an exact comparison with the next secure read.
    this.bytes = bytes;
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof FlowActivityJournalPrefix
      && this.entryCount === other.entryCount
      && this.bytes.equals(other.bytes);
  }
}

class FlowActivityJournalSnapshot {
  constructor({ entries, revision = null, bytes = Buffer.alloc(0), entryEndOffsets = [] }) {
    if (!Array.isArray(entries) || entries.some((entry) => !(entry instanceof FlowActivity))) {
      throw new CurrentFlowStateInvariantError("activity journal snapshot requires typed Activities");
    }
    if (revision !== null && !(revision instanceof FlowActivityJournalRevision)) {
      throw new CurrentFlowStateInvariantError("activity journal snapshot requires a typed file revision or null");
    }
    if (!Buffer.isBuffer(bytes)) {
      throw new CurrentFlowStateInvariantError("activity journal snapshot requires exact journal bytes");
    }
    if (!Array.isArray(entryEndOffsets) || entryEndOffsets.length !== entries.length) {
      throw new CurrentFlowStateInvariantError("activity journal snapshot requires one byte offset per Activity");
    }
    if (entryEndOffsets.some((offset, index) => (
      !Number.isSafeInteger(offset)
      || offset < 1
      || offset > bytes.length
      || (index > 0 && offset <= entryEndOffsets[index - 1])
    ))) {
      throw new CurrentFlowStateInvariantError("activity journal snapshot Activity byte offsets must be ordered within its bytes");
    }
    this.entries = Object.freeze([...entries]);
    this.revision = revision;
    this.bytes = Buffer.from(bytes);
    this.entryEndOffsets = Object.freeze([...entryEndOffsets]);
    Object.freeze(this);
  }

  prefix(confirmationOrder) {
    if (!Number.isSafeInteger(confirmationOrder) || confirmationOrder < 0 || confirmationOrder > this.entries.length) {
      throw new CurrentFlowStateInvariantError("activity journal prefix confirmation order is outside the parsed journal");
    }
    const byteLength = confirmationOrder === 0 ? 0 : this.entryEndOffsets[confirmationOrder - 1];
    return new FlowActivityJournalPrefix({
      entryCount: confirmationOrder,
      bytes: this.bytes.subarray(0, byteLength),
    });
  }
}

class FlowActivityJournalParseCache {
  constructor(snapshot) {
    if (!(snapshot instanceof FlowActivityJournalSnapshot)) {
      throw new CurrentFlowStateInvariantError("activity journal parse cache requires a typed snapshot");
    }
    this.entries = snapshot.entries;
    this.bytes = Buffer.from(snapshot.bytes);
    this.entryEndOffsets = snapshot.entryEndOffsets;
    Object.freeze(this);
  }

  matchesPrefix(bytes) {
    return Buffer.isBuffer(bytes)
      && bytes.length >= this.bytes.length
      && bytes.subarray(0, this.bytes.length).equals(this.bytes);
  }
}

export class FlowActivityJournal {
  #parseCache = null;

  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.directoryAuthority = new RealDirectoryAuthority(path.dirname(this.filePath));
    Object.freeze(this);
  }

  read() {
    return this.readSnapshot().entries;
  }

  readSnapshot() {
    const opened = this.#openExisting(fs.constants.O_RDONLY);
    if (opened === null) return new FlowActivityJournalSnapshot({ entries: [] });
    let bytes;
    try {
      bytes = fs.readFileSync(opened.descriptor);
    } finally {
      fs.closeSync(opened.descriptor);
    }
    this.#assertVisibleIdentity(opened.identity);
    const snapshot = this.#parseSnapshot(bytes, opened.revision);
    this.#parseCache = new FlowActivityJournalParseCache(snapshot);
    return snapshot;
  }

  #parseSnapshot(bytes, revision) {
    const cached = this.#parseCache;
    if (cached !== null && cached.matchesPrefix(bytes)) {
      const tail = this.#parseEntries(
        bytes.subarray(cached.bytes.length),
        cached.entries.length,
        cached.bytes.length,
      );
      const entries = [...cached.entries, ...tail.entries];
      this.#assertEntries(entries);
      return new FlowActivityJournalSnapshot({
        entries,
        revision,
        bytes,
        entryEndOffsets: [...cached.entryEndOffsets, ...tail.entryEndOffsets],
      });
    }
    const parsed = this.#parseEntries(bytes, 0, 0);
    this.#assertEntries(parsed.entries);
    return new FlowActivityJournalSnapshot({
      entries: parsed.entries,
      revision,
      bytes,
      entryEndOffsets: parsed.entryEndOffsets,
    });
  }

  #parseEntries(bytes, entryOffset, byteOffset) {
    const content = bytes.toString("utf8");
    if (content === "") return { entries: [], entryEndOffsets: [] };
    if (!content.endsWith("\n")) {
      throw new CurrentFlowStateInvariantError("activities.jsonl ends with a partial line");
    }
    const lines = content.trimEnd().split("\n");
    const entries = lines.map((line, index) => {
      try { return FlowActivity.fromSerialized(JSON.parse(line)); } catch (error) {
        throw new CurrentFlowStateInvariantError(`invalid activities.jsonl line ${entryOffset + index + 1}: ${error.message}`);
      }
    });
    let offset = byteOffset;
    const entryEndOffsets = lines.map((line) => {
      offset += Buffer.byteLength(line, "utf8") + 1;
      return offset;
    });
    return { entries, entryEndOffsets };
  }

  #assertEntries(entries) {
    const ids = new Set();
    let order = 0;
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new CurrentFlowStateInvariantError(`activities duplicate id: ${entry.id}`);
      if (entry.confirmationOrder !== order + 1) throw new CurrentFlowStateInvariantError("activities confirmationOrder must be contiguous");
      ids.add(entry.id);
      order = entry.confirmationOrder;
    }
    assertJournalAttemptIdentities(entries);
  }

  append(activity, writerAuthority, snapshot = null) {
    if (writerAuthority !== JOURNAL_WRITER_AUTHORITY) {
      throw new CurrentFlowStateInvariantError("activities.jsonl may be appended only by CurrentFlowStateStore");
    }
    if (snapshot !== null && !(snapshot instanceof FlowActivityJournalSnapshot)) {
      throw new CurrentFlowStateInvariantError("activity journal append snapshot must be typed");
    }
    const verifiedSnapshot = snapshot ?? this.readSnapshot();
    const { entries } = verifiedSnapshot;
    const next = FlowActivity.canonical(activity);
    const existing = entries.find((entry) => entry.id === next.id);
    if (existing) {
      if (!jsonEqual(existing.toJSON(), next.toJSON())) {
        throw new CurrentFlowStateConflictError(`activity id ${next.id} was already appended with a different payload`);
      }
      const opened = this.#openAppend(verifiedSnapshot.revision);
      fs.closeSync(opened.descriptor);
      return { appended: false, activity: existing };
    }
    const expectedOrder = entries.length + 1;
    if (next.confirmationOrder !== expectedOrder) {
      throw new CurrentFlowStateConflictError("new Activity confirmationOrder must follow the append-only journal");
    }
    assertJournalAttemptIdentities([...entries, next]);
    const opened = this.#openAppend(verifiedSnapshot.revision);
    try {
      fs.writeFileSync(opened.descriptor, `${JSON.stringify(next.toJSON())}\n`, "utf8");
      fs.fsyncSync(opened.descriptor);
    } finally {
      fs.closeSync(opened.descriptor);
    }
    this.#assertVisibleIdentity(opened.identity);
    if (opened.created) fsyncDirectory(path.dirname(this.filePath));
    return { appended: true, activity: next };
  }

  #openExisting(flags) {
    this.directoryAuthority.assertStable();
    let visible;
    try {
      visible = fs.lstatSync(this.filePath);
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
    this.#assertRegularRealFile(visible);
    const descriptor = fs.openSync(this.filePath, flags | (fs.constants.O_NOFOLLOW || 0));
    return { descriptor, ...this.#openedFile(descriptor, visible) };
  }

  #openAppend(expectedRevision) {
    const existing = this.#openExisting(fs.constants.O_WRONLY | fs.constants.O_APPEND);
    if (expectedRevision !== null) {
      if (existing === null || !expectedRevision.matches(existing.revision)) {
        if (existing !== null) fs.closeSync(existing.descriptor);
        throw new CurrentFlowStateInvariantError("Activity journal changed between read and append");
      }
      return { ...existing, created: false };
    }
    if (existing !== null) {
      fs.closeSync(existing.descriptor);
      throw new CurrentFlowStateInvariantError("Activity journal authority appeared between read and append");
    }
    this.directoryAuthority.assertStable();
    const descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_APPEND
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o644,
    );
    return { descriptor, ...this.#openedFile(descriptor), created: true };
  }

  #openedFile(descriptor, expected = null) {
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || (expected !== null && !sameFileIdentity(expected, opened))
      ) {
        throw new CurrentFlowStateInvariantError("Activity journal authority changed while opening");
      }
      return {
        identity: { dev: opened.dev, ino: opened.ino },
        revision: new FlowActivityJournalRevision(opened),
      };
    } catch (cause) {
      fs.closeSync(descriptor);
      throw cause;
    }
  }

  #assertVisibleIdentity(identity) {
    this.directoryAuthority.assertStable();
    let visible;
    try {
      visible = fs.lstatSync(this.filePath);
    } catch (cause) {
      throw new CurrentFlowStateInvariantError("Activity journal authority disappeared", { cause });
    }
    this.#assertRegularRealFile(visible);
    if (!sameFileIdentity(visible, identity)) {
      throw new CurrentFlowStateInvariantError("Activity journal authority changed during access");
    }
  }

  #assertRegularRealFile(stat) {
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || fs.realpathSync(this.filePath) !== this.filePath
    ) {
      throw new CurrentFlowStateInvariantError("Activity journal authority must be a regular real file");
    }
  }
}

export class CurrentFlowStateSnapshot {
  constructor({ state, revision, activities = [] }) {
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("flow state snapshot requires a typed current state");
    }
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new CurrentFlowStateInvariantError("flow state snapshot revision must be a SHA-256 digest");
    }
    this.state = state;
    this.revision = revision;
    if (!Array.isArray(activities) || activities.some((entry) => !(entry instanceof FlowActivity))) {
      throw new CurrentFlowStateInvariantError("flow state snapshot activities must be typed Activities");
    }
    // A journal-first crash can leave one pending Activity after flow.json.
    // Exposing only the confirmed prefix makes read views match the sole
    // state authority until recovery replays that pending Activity.
    this.activities = Object.freeze(activities.slice(0, state.confirmationOrder));
    Object.freeze(this);
  }
}

/**
 * Process-local memo of one completely replayed state/journal pair. It is a
 * performance hint only: every caller still reads and parses both authorities
 * before this may be used, and any byte, semantic, or journal-prefix change
 * rejects the memo.
 */
class CurrentFlowStateValidationCache {
  constructor({ state, stateBytes, journalPrefix } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("validated current Flow cache requires a typed state");
    }
    if (!Buffer.isBuffer(stateBytes)) {
      throw new CurrentFlowStateInvariantError("validated current Flow cache requires exact state bytes");
    }
    if (!(journalPrefix instanceof FlowActivityJournalPrefix)) {
      throw new CurrentFlowStateInvariantError("validated current Flow cache requires an exact journal prefix");
    }
    if (journalPrefix.entryCount !== state.confirmationOrder) {
      throw new CurrentFlowStateInvariantError("validated current Flow cache journal prefix must end at state confirmation");
    }
    this.state = state;
    this.stateBytes = Buffer.from(stateBytes);
    this.journalPrefix = journalPrefix;
    Object.freeze(this);
  }

  matches(state, stateBytes, journalSnapshot) {
    if (!(state instanceof CurrentFlowState) || !Buffer.isBuffer(stateBytes) || !(journalSnapshot instanceof FlowActivityJournalSnapshot)) {
      return false;
    }
    if (!stateBytes.equals(this.stateBytes)) return false;
    return this.journalPrefix.matches(journalSnapshot.prefix(state.confirmationOrder));
  }

  stateFor(stateBytes) {
    return Buffer.isBuffer(stateBytes) && stateBytes.equals(this.stateBytes)
      ? this.state
      : null;
  }

  replayBaseFor(state, journalSnapshot) {
    if (
      !(state instanceof CurrentFlowState)
      || state.history !== null
      || this.state.history !== null
      || !(journalSnapshot instanceof FlowActivityJournalSnapshot)
      || state.confirmationOrder < this.state.confirmationOrder
    ) {
      return null;
    }
    return this.journalPrefix.matches(journalSnapshot.prefix(this.state.confirmationOrder))
      ? this.state
      : null;
  }
}

/**
 * The only persistence API for the new flow.json contract.  The journal is
 * appended before the state CAS.  A crash in that window is resolved by
 * reapplying the same Activity id/order; a conflicting duplicate is rejected.
 */
export class CurrentFlowStateStore {
  #validatedState = null;

  constructor({ directory, definition, faultInjector = () => {}, processIdentitySource, runtimeLockLocation = null } = {}) {
    this.directory = path.resolve(requireString(directory, "store.directory"));
    if (!(definition instanceof CurrentFlowDefinition)) throw new CurrentFlowStateInvariantError("store requires a CurrentFlowDefinition");
    if (typeof faultInjector !== "function") throw new CurrentFlowStateInvariantError("store.faultInjector must be a function");
    if (runtimeLockLocation !== null && !(runtimeLockLocation instanceof FlowVersionRuntimeLockLocation)) {
      throw new CurrentFlowStateInvariantError("current flow state runtime lock requires a typed Version lock location");
    }
    if (runtimeLockLocation !== null && (
      runtimeLockLocation.logicalKey !== "runtime.lock.current-flow-state"
      || runtimeLockLocation.location.directory !== this.directory
    )) {
      throw new CurrentFlowStateInvariantError("current flow state runtime lock must belong to this Version directory");
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o755 });
    const lockErrorFactory = (status, message, { lockPath, cause } = {}) => {
      const error = new CurrentFlowStateConflictError(message);
      error.code = status === "live" || status === "timeout"
        ? "FLOW_STATE_ATOMIC_BUSY"
        : `CURRENT_FLOW_STATE_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
      error.lockPath = lockPath;
      if (cause) error.cause = cause;
      return error;
    };
    this.definition = definition;
    this.validator = new CurrentFlowStateValidator({ definition });
    this.serializer = new CurrentFlowStateSerializer({ validator: this.validator });
    this.faultInjector = faultInjector;
    this.runtimeLockLocation = runtimeLockLocation;
    this.statePath = path.join(this.directory, "flow.json");
    this.journal = new FlowActivityJournal(path.join(this.directory, "activities.jsonl"));
    // Runtime state is deliberately a real, non-authoritative subtree.  Create
    // it before capturing lock directory identities so nested authorities do
    // not have a creation race with their parent directory.
    const runtimeDirectory = runtimeLockLocation?.runtimeDirectory ?? path.join(this.directory, ".runtime");
    const lockDirectory = runtimeLockLocation?.directory ?? path.join(runtimeDirectory, "locks");
    const lockFileName = runtimeLockLocation?.fileName ?? "current-flow-state.lock";
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o755 });
    this.directoryAuthority = new RealDirectoryAuthority(this.directory, { errorFactory: lockErrorFactory });
    this.runtimeAuthority = new RealDirectoryAuthority(runtimeDirectory, {
      create: true,
      parentAuthority: this.directoryAuthority,
      errorFactory: lockErrorFactory,
    });
    this.lockDirectoryAuthority = new RealDirectoryAuthority(lockDirectory, {
      create: true,
      parentAuthority: this.runtimeAuthority,
      errorFactory: lockErrorFactory,
    });
    this.lock = new FileLock({
      directoryAuthority: this.lockDirectoryAuthority,
      fileName: lockFileName,
      kind: "current-flow-state",
      authority: {
        directory: this.directory,
        runtimeDirectory,
        statePath: this.statePath,
        activityPath: this.journal.filePath,
      },
      ...(processIdentitySource && { processIdentitySource }),
      errorFactory: lockErrorFactory,
    });
    Object.freeze(this);
  }

  create(state) {
    const next = this.serializer.deserialize(state);
    return this.#withLock(() => {
      this.#assertFreshCreationState(next);
      const journalSnapshot = this.journal.readSnapshot();
      const entries = journalSnapshot.entries;
      let created;
      if (entries.length === 0) {
        created = FlowActivity.flowCreated(next, new Date().toISOString());
      } else if (entries.length === 1 && entries[0].transition.operation === FLOW_CREATION_TRANSITION_OPERATION) {
        // A journal-first interruption has already committed the complete
        // creation fact. Its timestamp and payload are immutable authority
        // for the state-write recovery; never synthesize a second variant.
        created = entries[0];
      } else {
        throw new CurrentFlowStateConflictError("current flow creation requires an empty or sole flow_created Activity journal");
      }
      const materialized = this.#applyActivity(next, created, []);
      this.faultInjector({ phase: "activity-ready-to-append", activity: created, state: next });
      const appended = this.journal.append(created, JOURNAL_WRITER_AUTHORITY, journalSnapshot);
      if (appended.appended) {
        this.faultInjector({ phase: "activity-appended", activity: created, state: next });
      }
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o755 });
      this.#write(materialized, null);
      this.faultInjector({ phase: "state-written", activity: created, state: materialized });
      return materialized;
    });
  }

  load() {
    return this.loadSnapshot()?.state ?? null;
  }

  loadSnapshot() {
    return this.#withLock(() => this.#loadSnapshotUnlocked());
  }
  #loadSnapshotUnlocked() {
    const bytes = this.#readStateBytes();
    if (bytes === null) {
      const entries = this.journal.read();
      if (entries.length !== 0) {
        throw new CurrentFlowStateConflictError("Activity journal exists without flow state");
      }
      return null;
    }
    const state = this.#validatedState?.stateFor(bytes) ?? this.#parse(bytes);
    const journalSnapshot = this.journal.readSnapshot();
    const activities = journalSnapshot.entries;
    this.#assertJournalConsistency(state, activities, { stateBytes: bytes, journalSnapshot });
    return new CurrentFlowStateSnapshot({ state, revision: digest(bytes), activities });
  }

  /**
   * Probe the authoritative writer lock without changing Flow state.  Cleanup
   * uses this before it begins any destructive repository action, so a live
   * Version writer is surfaced while every teardown side effect is still
   * avoidable.
   */
  assertWritable() {
    try {
      this.#withLock(() => undefined);
    } catch (error) {
      if (error?.lockStatus === "live" || error?.lockStatus === "timeout") {
        const busy = new Error(error.message, { cause: error });
        busy.name = "FlowStateAtomicSaveError";
        busy.code = "FLOW_STATE_ATOMIC_BUSY";
        busy.lockStatus = error.lockStatus;
        busy.lockPath = error.lockPath;
        busy.owner = error.owner;
        if (error.waitedMs !== undefined) busy.waitedMs = error.waitedMs;
        if (error.retryable !== undefined) busy.retryable = error.retryable;
        throw busy;
      }
      throw error;
    }
    return this.statePath;
  }

  apply({ activity, expectedRevision = null, assertCurrentState = null }) {
    const proposed = FlowActivity.canonical(activity);
    if (assertCurrentState !== null && typeof assertCurrentState !== "function") {
      throw new CurrentFlowStateInvariantError("current flow state assertion must be a function or null");
    }
    return this.#withLock(() => {
      const originalBytes = this.#readStateBytes();
      if (originalBytes === null) {
        throw new CurrentFlowStateConflictError("current flow state does not exist");
      }
      const original = this.#validatedState?.stateFor(originalBytes) ?? this.#parse(originalBytes);
      if (expectedRevision !== null && expectedRevision !== digest(originalBytes)) {
        throw new CurrentFlowStateConflictError("flow state changed before update");
      }
      const journalSnapshot = this.journal.readSnapshot();
      const entries = journalSnapshot.entries;
      this.#assertJournalConsistency(original, entries, {
        stateBytes: originalBytes,
        journalSnapshot,
      });
      assertCurrentState?.(original);
      const existing = entries.find((entry) => entry.id === proposed.id);
      if (existing && !jsonEqual(existing.toJSON(), proposed.toJSON())) {
        throw new CurrentFlowStateConflictError(`activity id ${proposed.id} was already appended with a different payload`);
      }
      if (original.confirmationOrder >= proposed.confirmationOrder) {
        if (!existing) throw new CurrentFlowStateConflictError("state confirmation order is ahead of its Activity journal");
        return original;
      }
      if (original.lifecycle.state === "finalized") {
        throw new CurrentFlowStateInvariantError("finalized Flow rejects subsequent Activities");
      }
      if (proposed.confirmationOrder !== original.confirmationOrder + 1) {
        throw new CurrentFlowStateConflictError("Activity confirmationOrder must immediately follow current state");
      }
      // The update is carried by the Activity itself.  This is important for
      // journal-first crash recovery: a replay cannot silently substitute a
      // different callback for a persisted Activity id/order.
      const next = this.#applyActivity(original, proposed, entries.slice(0, original.confirmationOrder));
      this.faultInjector({ phase: "activity-ready-to-append", activity: proposed, state: original });
      this.journal.append(proposed, JOURNAL_WRITER_AUTHORITY, journalSnapshot);
      this.faultInjector({ phase: "activity-appended", activity: proposed, state: original });
      this.#write(next, originalBytes);
      this.faultInjector({ phase: "state-written", activity: proposed, state: next });
      return next;
    });
  }

  #parse(bytes) {
    try { return this.serializer.deserialize(JSON.parse(bytes.toString("utf8"))); } catch (error) {
      if (error instanceof CurrentFlowStateInvariantError) throw error;
      throw new CurrentFlowStateInvariantError(`invalid flow.json: ${error.message}`);
    }
  }

  #assertFreshCreationState(next) {
    if (fs.existsSync(this.statePath)) throw new CurrentFlowStateConflictError("current flow state already exists");
    if (next.confirmationOrder !== 0 || next.current !== null || next.attempt !== null) {
      throw new CurrentFlowStateInvariantError("current flow store creation requires a fresh state without Activity progress");
    }
    const fresh = freshStateLike(next, this.definition);
    if (!jsonEqual(next.toJSON(), fresh.toJSON())) {
      throw new CurrentFlowStateInvariantError("current flow store creation requires the definition's fresh materialized state");
    }
  }

  #assertJournalConsistency(state, entries, { stateBytes = null, journalSnapshot = null } = {}) {
    const cacheEligible = stateBytes !== null && journalSnapshot instanceof FlowActivityJournalSnapshot;
    if (cacheEligible && this.#validatedState?.matches(state, stateBytes, journalSnapshot)) {
      // A cache entry is recorded only for a fully confirmed journal. If a
      // journal-first crash or append is visible, its changed prefix or extra
      // entry takes the full replay path below.
      if (entries.length === state.confirmationOrder) return;
    }
    if (state.history !== null) {
      const orders = entries.map((entry) => entry.confirmationOrder);
      const expected = Array.from({ length: entries.length }, (_, index) => index + 1);
      if (JSON.stringify(orders) !== JSON.stringify(expected)) {
        throw new CurrentFlowStateConflictError("historical Flow Activity ledger must be a complete contiguous confirmed prefix");
      }
      if (state.history.creation.status === "available") {
        const created = entries[0] ?? null;
        if (created === null || created.transition.operation !== FLOW_CREATION_TRANSITION_OPERATION
          || created.id !== flowCreatedActivityId(state.identity)
          || created.timing?.startedAt !== state.history.creation.source.timestamp) {
          throw new CurrentFlowStateConflictError("historical creation authority does not match its flow_created Activity");
        }
      } else if (entries.some((entry) => entry.transition.operation === FLOW_CREATION_TRANSITION_OPERATION)) {
        throw new CurrentFlowStateConflictError("historical Flow without creation authority cannot claim a flow_created Activity");
      }
      const journalOrder = entries.at(-1)?.confirmationOrder ?? 0;
      if (!state.history.resumed) {
        if (state.confirmationOrder === journalOrder) {
          this.#rememberValidatedState(state, entries, stateBytes, journalSnapshot);
          return;
        }
        if (journalOrder !== state.confirmationOrder + 1) {
          throw new CurrentFlowStateConflictError("historical Flow Activity ledger must be a complete contiguous confirmed prefix");
        }
        let pending;
        try {
          pending = this.#applyActivity(state, entries.at(-1), entries.slice(0, state.confirmationOrder));
        } catch (error) {
          throw new CurrentFlowStateConflictError(`pending Activity cannot admit historical continuation: ${error.message}`);
        }
        if (!pending.history?.resumed
          || pending.history.continuation.confirmationOrder !== entries.at(-1).confirmationOrder
          || !entries.at(-1).startsAttempt({
            nodeId: pending.history.continuation.nodeId,
            id: pending.history.continuation.attemptId,
            sequence: pending.history.continuation.attemptSequence,
          })) {
          throw new CurrentFlowStateConflictError("pending Activity does not durably admit historical continuation");
        }
        return;
      }
      const boundaryOrder = state.history.continuation.confirmationOrder;
      if (state.confirmationOrder < boundaryOrder || entries.length < boundaryOrder) {
        throw new CurrentFlowStateConflictError("resumed historical Flow lacks its admitted continuation Activity");
      }
      const boundary = entries[boundaryOrder - 1] ?? null;
      if (!boundary?.startsAttempt({
        nodeId: state.history.continuation.nodeId,
        id: state.history.continuation.attemptId,
        sequence: state.history.continuation.attemptSequence,
      })) {
        throw new CurrentFlowStateConflictError("resumed historical Flow continuation boundary does not match its admitted Attempt");
      }
      if (journalOrder < state.confirmationOrder) {
        throw new CurrentFlowStateConflictError("historical Flow state confirmation order is ahead of its Activity journal");
      }
      if (journalOrder > state.confirmationOrder + 1) {
        throw new CurrentFlowStateConflictError("historical Flow Activity journal is more than one transition ahead of flow state");
      }
      if (journalOrder === state.confirmationOrder + 1) {
        try {
          this.#applyActivity(state, entries.at(-1), entries.slice(0, state.confirmationOrder));
        } catch (error) {
          throw new CurrentFlowStateConflictError(`pending Activity cannot advance resumed historical Flow: ${error.message}`);
        }
      }
      this.#rememberValidatedState(state, entries, stateBytes, journalSnapshot);
      return;
    }
    const journalOrder = entries.at(-1)?.confirmationOrder ?? 0;
    if (journalOrder < state.confirmationOrder) {
      throw new CurrentFlowStateConflictError("flow state confirmation order is ahead of its Activity journal");
    }
    if (journalOrder > state.confirmationOrder + 1) {
      throw new CurrentFlowStateConflictError("Activity journal is more than one transition ahead of flow state");
    }
    const cachedBase = cacheEligible
      ? this.#validatedState?.replayBaseFor(state, journalSnapshot) ?? null
      : null;
    let replayed = cachedBase ?? freshStateLike(state, this.definition);
    const replayStart = cachedBase?.confirmationOrder ?? 0;
    try {
      const priorActivities = entries.slice(0, replayStart);
      for (let index = replayStart; index < state.confirmationOrder; index += 1) {
        replayed = this.#applyActivity(replayed, entries[index], priorActivities);
        priorActivities.push(entries[index]);
      }
    } catch (error) {
      throw new CurrentFlowStateConflictError(`Activity journal cannot reproduce flow state: ${error.message}`);
    }
    if (!jsonEqual(replayed.toJSON(), state.toJSON())) {
      throw new CurrentFlowStateConflictError("flow state content conflicts with its Activity journal");
    }
    if (journalOrder === state.confirmationOrder + 1) {
      try {
        this.#applyActivity(replayed, entries.at(-1), entries.slice(0, state.confirmationOrder));
      } catch (error) {
        throw new CurrentFlowStateConflictError(`pending Activity cannot advance flow state: ${error.message}`);
      }
    }
    this.#rememberValidatedState(state, entries, stateBytes, journalSnapshot);
  }

  #rememberValidatedState(state, entries, stateBytes, journalSnapshot) {
    if (
      !Buffer.isBuffer(stateBytes)
      || !(journalSnapshot instanceof FlowActivityJournalSnapshot)
      || state.history !== null
      || entries.length !== state.confirmationOrder
    ) {
      return;
    }
    this.#validatedState = new CurrentFlowStateValidationCache({
      state,
      stateBytes,
      journalPrefix: journalSnapshot.prefix(state.confirmationOrder),
    });
  }

  #applyActivity(state, activity, priorActivities = []) {
    return applyCanonicalActivity(state, activity, priorActivities);
  }

  #write(state, expectedBytes) {
    const content = this.serializer.bytes(state);
    const file = new AtomicFile(this.statePath, {
      phaseNamespace: "current-flow-state",
      faultInjector: this.faultInjector,
      commitGuard: () => {
        if (expectedBytes === null) {
          if (this.#readStateBytes() !== null) throw new CurrentFlowStateConflictError("current flow state already exists");
          return;
        }
        const visible = this.#readStateBytes();
        if (visible === null) throw new CurrentFlowStateConflictError("current flow state disappeared during update");
        if (!visible.equals(expectedBytes)) throw new CurrentFlowStateConflictError("flow state changed during update");
      },
    });
    file.write(content);
  }

  #readStateBytes() {
    const bytes = new AtomicFile(this.statePath, { phaseNamespace: "current-flow-state-read" }).read(null);
    if (bytes === null) return null;
    const visible = fs.lstatSync(this.statePath);
    if (
      !visible.isFile()
      || visible.isSymbolicLink()
      || visible.nlink !== 1
      || fs.realpathSync(this.statePath) !== this.statePath
    ) {
      throw new CurrentFlowStateInvariantError("flow state authority must be a single-link regular real file");
    }
    return bytes;
  }

  #withLock(operation) {
    return this.lock.runExclusive(operation);
  }
}

export class CurrentFlowStateAdoptionBoundary {
  constructor({ definition }) {
    if (!(definition instanceof CurrentFlowDefinition)) {
      throw new CurrentFlowStateInvariantError("adoption boundary requires a fixed CurrentFlowDefinition");
    }
    this.definition = definition;
    Object.freeze(this);
  }

  createFresh(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new CurrentFlowStateInvariantError("fresh Flow options must be an object");
    }
    return CurrentFlowState.create({ definition: this.definition, ...options });
  }

  openStore({ directory, faultInjector, processIdentitySource } = {}) {
    return new CurrentFlowStateStore({
      directory,
      definition: this.definition,
      ...(faultInjector && { faultInjector }),
      ...(processIdentitySource && { processIdentitySource }),
    });
  }

  openVersionStore({ location, faultInjector, processIdentitySource } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new CurrentFlowStateInvariantError("FlowVersionLocation is required for Version storage");
    return new CurrentFlowVersionStore({ location, definition: this.definition, ...(faultInjector && { faultInjector }), ...(processIdentitySource && { processIdentitySource }) });
  }

}

/**
 * A lock-scoped, typed read authority for decisions which consume both
 * cataloged evidence and transient runtime observations.  Its methods must
 * only be used inside the callback that received this instance: the enclosing
 * catalog publication lock defines the lifetime of the coherent view.
 */
class CanonicalTransitionView {
  constructor({ location, snapshot, catalog } = {}) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new CurrentFlowStateInvariantError("canonical transition view requires a Version location");
    }
    if (snapshot === null || typeof snapshot !== "object" || !(snapshot.state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateConflictError("canonical transition view requires persisted Flow state");
    }
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new CurrentFlowStateInvariantError("canonical transition view requires a typed artifact catalog");
    }
    if (typeof snapshot.revision !== "string" || snapshot.revision === "" || !Array.isArray(snapshot.activities)) {
      throw new CurrentFlowStateInvariantError("canonical transition view requires a persisted state revision and Activities");
    }
    this.location = location;
    this.state = snapshot.state;
    this.revision = snapshot.revision;
    this.activities = snapshot.activities;
    this.catalog = catalog;
    // Existing admissions receive the read capability by destructuring it
    // from the view. Keep that capability bound to this lock-scoped catalog
    // instead of requiring every admission to know the concrete view type.
    this.readCatalogedArtifact = this.readCatalogedArtifact.bind(this);
    this.readRuntimeArtifact = this.readRuntimeArtifact.bind(this);
    Object.freeze(this);
  }

  readCatalogedArtifact(descriptor) {
    if (descriptor === null || typeof descriptor !== "object" || typeof descriptor.relativePath !== "string") {
      throw new CurrentFlowStateInvariantError("canonical transition view requires an artifact descriptor");
    }
    const current = this.catalog.resolve(descriptor.relativePath);
    if (current.hash !== descriptor.hash || current.activityId !== descriptor.activityId) {
      throw new CurrentFlowStateInvariantError("canonical transition view artifact descriptor changed");
    }
    current.verify(this.location);
    return Buffer.from(fs.readFileSync(this.location.resolve(current.relativePath)));
  }

  readRuntimeArtifact({ logicalKey } = {}) {
    const consumerNodeId = this.state.current?.at(-1);
    if (typeof consumerNodeId !== "string" || consumerNodeId === "") {
      throw new CurrentFlowStateConflictError("canonical transition view has no active runtime consumer");
    }
    return new CanonicalFlowRuntimeArtifactRead({
      location: this.location,
      logicalKey,
      consumerNodeId,
      optional: true,
    }).read();
  }
}

/** Version-1-only persistence facade. It has no legacy-layout lookup. */
export class CurrentFlowVersionStore {
  #stateStore = null;
  constructor({ location, definition, faultInjector, processIdentitySource, allowStaging = false } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new CurrentFlowStateInvariantError("Current Flow Version store requires a FlowVersionLocation");
    location.requireScope("canonical");
    if (location.isStaging && allowStaging !== true) {
      throw new CurrentFlowStateInvariantError("staging Version locations are internal to atomic creation");
    }
    if (location.version.value !== 1) {
      throw new CurrentFlowStateInvariantError("Current Flow Version store supports Version 1 only");
    }
    if (!(definition instanceof CurrentFlowDefinition)) throw new CurrentFlowStateInvariantError("Current Flow Version store requires a CurrentFlowDefinition");
    this.location = location;
    this.definition = definition;
    this.faultInjector = faultInjector;
    this.processIdentitySource = processIdentitySource;
    this.allowStaging = allowStaging === true;
    this.catalogStore = new FlowArtifactCatalogStore({
      location,
      ...(faultInjector && { faultInjector }),
    });
    Object.freeze(this);
  }
  /** Create one fresh canonical Version root without exposing a partial tree. */
  createFresh({
    flowId,
    flowVersionId,
    runId,
    request,
    issue = null,
    execution = { mode: "direct" },
    lifecycle = { state: "active" },
    policy = { autoApprove: false, nonblocking: null },
    specRecord,
    issueSnapshot = null,
    context = null,
  } = {}) {
    return this.create(CurrentFlowState.create({
      definition: this.definition,
      flowId,
      flowVersionId,
      runId,
      specId: this.location.specId.toString(),
      issue,
      request,
      execution,
      lifecycle,
      policy,
      context,
    }), { specRecord, issueSnapshot });
  }

  create(state, { specRecord, issueSnapshot = null } = {}) {
    const canonical = this.definition.bindState(state);
    if (canonical.version !== 1 || canonical.version !== this.location.version.value) throw new CurrentFlowStateInvariantError("current Flow state version must match Version 1 storage");
    if (!canonical.identity.matchesLocation(this.location)) {
      throw new CurrentFlowStateInvariantError("flow.json identity must match its Version location");
    }
    const canonicalSpec = CurrentFlowSpecRecord.from(specRecord);
    if (!canonicalSpec.specId.equals(this.location.specId)) {
      throw new CurrentFlowStateInvariantError("Version spec record must match its Version location specId");
    }
    if ((canonical.identity.issue === null) !== (issueSnapshot === null)) {
      throw new CurrentFlowStateInvariantError(
        "canonical Flow Issue identity and immutable issue.md snapshot must be present together",
      );
    }
    this.location.assertAuthority();
    if (fs.existsSync(this.location.directory)) throw new CurrentFlowStateConflictError("Current Flow Version root must be absent before creation");
    const parentDirectory = path.dirname(this.location.directory);
    fs.mkdirSync(parentDirectory, { recursive: true, mode: 0o755 });
    const staging = this.location.stagingSibling(crypto.randomBytes(12).toString("hex"));
    let published = false;
    try {
      const stagingStore = new CurrentFlowVersionStore({
        location: staging,
        definition: this.definition,
        ...(this.faultInjector && { faultInjector: this.faultInjector }),
        ...(this.processIdentitySource && { processIdentitySource: this.processIdentitySource }),
        allowStaging: true,
      });
      stagingStore.#createMaterialized(canonical, canonicalSpec, issueSnapshot);
      if (fs.existsSync(this.location.directory)) {
        throw new CurrentFlowStateConflictError("Current Flow Version root appeared during atomic creation");
      }
      fs.renameSync(staging.directory, this.location.directory);
      fsyncDirectory(parentDirectory);
      published = true;
      return this.load();
    } catch (error) {
      if (published) throw error;
      try {
        fs.rmSync(staging.directory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Current Flow Version staging cleanup failed", { cause: error });
      }
      throw error;
    }
  }
  #createMaterialized(canonical, specRecord, issueSnapshot) {
    if (!this.allowStaging) {
      throw new CurrentFlowStateInvariantError("only an atomic staging store may materialize a Version root");
    }
    if (issueSnapshot !== null && typeof issueSnapshot !== "string") {
      throw new CurrentFlowStateInvariantError("linked Issue snapshot must be a string or null");
    }
    let ownsVersionRoot = false;
    try {
      fs.mkdirSync(path.dirname(this.location.directory), { recursive: true, mode: 0o755 });
      fs.mkdirSync(this.location.directory, { recursive: false, mode: 0o755 });
      ownsVersionRoot = true;
      fs.mkdirSync(this.location.resolve("steps"), { recursive: true, mode: 0o755 });
      fs.mkdirSync(this.location.resolve("artifacts/tests"), { recursive: true, mode: 0o755 });
      fs.writeFileSync(this.location.specFile, specRecord.canonicalText, { flag: "wx", mode: 0o600 });
      const initialRevision = 1;
      const revisionParameters = { revision: new FlowSpecRevision(initialRevision).pathSegment };
      const specBytes = Buffer.from(specRecord.canonicalText, "utf8");
      const snapshotFile = this.location.artifact("spec.snapshot", revisionParameters);
      fs.mkdirSync(path.dirname(snapshotFile), { recursive: true, mode: 0o755 });
      fs.writeFileSync(snapshotFile, specBytes, { flag: "wx", mode: 0o600 });
      fs.writeFileSync(this.location.activitiesFile, "", { flag: "wx", mode: 0o600 });
      if (issueSnapshot !== null) {
        fs.writeFileSync(
          this.location.issueSnapshotFile,
          issueSnapshot.endsWith("\n") ? issueSnapshot : `${issueSnapshot}\n`,
          { flag: "wx", mode: 0o600 },
        );
      }
      const created = this.#store().create(canonical);
      const creationActivityId = FlowActivityId.from(flowCreatedActivityId(canonical.identity));
      const artifacts = [
        descriptorFor(this.location, "flow.state", "application/json", creationActivityId),
        descriptorFor(this.location, "flow.activities", "application/x-ndjson", creationActivityId),
        descriptorFor(this.location, "spec.record", "application/json", creationActivityId),
        descriptorFor(this.location, "spec.snapshot", "application/json", creationActivityId, revisionParameters),
      ];
      if (issueSnapshot !== null) artifacts.push(descriptorFor(this.location, "issue.snapshot", "text/markdown", creationActivityId));
      this.catalogStore.initialize(new FlowArtifactCatalog({ artifacts }));
      return created;
    } catch (error) {
      this.#stateStore = null;
      if (!ownsVersionRoot) throw error;
      try {
        fs.rmSync(this.location.directory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Current Flow Version creation authority corrupted during cleanup", { cause: error });
      }
      throw error;
    }
  }
  load() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => {
        this.#assertSpecRevisionAuthority(catalog);
        return this.#assertPersistedIdentity(this.#store().load());
      },
    });
  }
  loadSnapshot() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => {
        this.#assertSpecRevisionAuthority(catalog);
        const snapshot = this.#store().loadSnapshot();
        if (snapshot === null) return null;
        this.#assertPersistedIdentity(snapshot.state);
        return snapshot;
      },
    });
  }
  /** Read a persisted current review, or null before spec-review publishes it. */
  readCurrentSpecReview() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => {
        const authority = this.#assertSpecRevisionAuthority(catalog);
        const descriptor = authority.reviewDescriptor;
        if (descriptor === null) return null;
        const bytes = fs.readFileSync(this.location.resolve(descriptor.relativePath));
        const review = new CanonicalSpecReview(JSON.parse(bytes.toString("utf8")));
        if (review.digest !== descriptor.hash) throw new CurrentFlowStateInvariantError("current canonical review serialization does not match its catalog descriptor");
        return Object.freeze({ revision: authority.revision, descriptor, bytes, review });
      },
    });
  }
  /** Derive the immutable generation-zero review seed for a spec-review worker.
   * It has no descriptor until the worker's confirmation transaction publishes it. */
  readCurrentSpecReviewInput() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => {
        const authority = this.#assertSpecRevisionAuthority(catalog);
        if (authority.reviewDescriptor !== null) {
          const bytes = fs.readFileSync(this.location.resolve(authority.reviewDescriptor.relativePath));
          return Object.freeze({
            revision: authority.revision,
            descriptor: authority.reviewDescriptor,
            bytes,
            review: new CanonicalSpecReview(JSON.parse(bytes.toString("utf8"))),
            persisted: true,
          });
        }
        const review = initialCanonicalSpecReview({
          specId: this.location.specId.toString(), revision: authority.revision, bytes: authority.snapshotBytes,
        });
        return Object.freeze({
          revision: authority.revision,
          descriptor: null,
          bytes: Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`, "utf8"),
          review,
          persisted: false,
        });
      },
    });
  }
  /** Read state, Activity prefix, revision and catalog under one catalog lock. */
  loadTransitionSnapshot() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => {
        const snapshot = this.#store().loadSnapshot();
        if (snapshot === null) return null;
        this.#assertPersistedIdentity(snapshot.state);
        return Object.freeze({
          state: snapshot.state,
          revision: snapshot.revision,
          activities: snapshot.activities,
          catalog: Object.freeze(catalog.artifacts.map((entry) => entry.toJSON())),
        });
      },
    });
  }

  /**
   * Run a typed consumer read against one catalog-lock snapshot.  This is the
   * only view that combines persisted state, Activities, catalog entries, and
   * transient runtime observations for a decision that consumes raw evidence.
   */
  readCanonicalTransitionView(read) {
    if (typeof read !== "function") {
      throw new CurrentFlowStateInvariantError("canonical transition view requires a reader");
    }
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => read(this.#canonicalTransitionView(catalog)),
    });
  }

  /**
   * Serialize a typed transient observation with catalog publication.  The
   * payload remains uncataloged, while test-chain admission can safely read it
   * under this same lock beside its durable facts.
   */
  writeRuntimeArtifact({ nodeId, artifact, expectedAttempt = null } = {}) {
    const target = requireString(nodeId, "canonical runtime artifact nodeId");
    const runtimeArtifact = CanonicalFlowRuntimeArtifactWrite.from(artifact);
    const expected = expectedAttempt === null ? null : CurrentAttemptIdentity.from(expectedAttempt);
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: () => {
        const state = this.#assertPersistedIdentity(this.#store().load());
        if (state.findNode(target) === null) {
          throw new CurrentFlowStateInvariantError(`canonical runtime artifact node is absent: ${target}`);
        }
        if ((runtimeArtifact.requiresActiveAttempt || expected !== null)
          && (state.current?.at(-1) !== target || state.attempt === null)) {
          throw new CurrentFlowStateInvariantError("canonical runtime artifact producer does not own the active Attempt");
        }
        if (expected !== null && !expected.matches(state)) {
          throw new CurrentFlowStateConflictError("canonical runtime artifact Attempt changed before write");
        }
        return runtimeArtifact.write(this.location, target);
      },
    });
  }

  /** Verify that the Version-authoritative Flow state can be updated now. */
  assertWritable() {
    return this.#store().assertWritable();
  }
  /**
   * Read the committed Activity prefix paired with the current state.  This
   * avoids exposing a journal-first pending line as a completed metric/note
   * before its state confirmation is durable.
   */
  activities() {
    const snapshot = this.loadSnapshot();
    return snapshot === null ? Object.freeze([]) : snapshot.activities;
  }
  apply(input) {
    let activity = FlowActivity.canonical(input?.activity);
    if (activity.reviewPublication !== null) {
      throw new CurrentFlowStateInvariantError("review publication Activity facts are derived only by the canonical Version Store");
    }
    const artifactWrites = this.#artifactWrites(input?.artifactWrites, activity);
    this.#assertRequestedRevisionArtifacts(activity, artifactWrites);
    const sourceWorkerUpgrade = this.#sourceWorkerUpgrade(
      input?.sourceWorkerUpgrade,
      activity,
      artifactWrites,
    );
    const artifactRemovals = this.#artifactRemovals(input?.artifactRemovals, activity);
    const testSourceBaseline = this.#testSourceBaseline(
      input?.testSourceBaseline,
      activity,
      artifactWrites,
      artifactRemovals,
    );
    const admission = input?.admission ?? null;
    if (admission !== null && typeof admission.assert !== "function") {
      throw new CurrentFlowStateInvariantError("canonical admission must provide assert()");
    }
    const approvalTaskAddition = activity.transition.operation === "add_approval_task";
    if (approvalTaskAddition && !(admission instanceof ApprovalTaskAdmission)) {
      throw new CurrentFlowStateInvariantError("approval Task Activity requires typed approval admission");
    }
    if (approvalTaskAddition) {
      admission.assertTask({ task: activity.transition.task, taskSpec: input?.taskSpec });
    }
    const taskAddition = ["add_task", "add_approval_task"].includes(activity.transition.operation);
    if (taskAddition) this.#assertPersistedIdentity(this.#store().load());
    const taskSpec = taskAddition
      ? this.#nextTaskSpec(activity, input?.taskSpec)
      : null;
    if (!taskAddition && input?.taskSpec !== undefined) {
      throw new CurrentFlowStateInvariantError("only Task admission Activities may update canonical spec.json.tasks");
    }
    const replacementSpec = this.#replacementSpec(input?.specRecord, activity, taskAddition);
    const nextSpecRecord = replacementSpec ?? taskSpec;
    const specRevisionPlan = nextSpecRecord === null ? null : this.#specRevisionWrites(nextSpecRecord, activity, artifactWrites);
    const specRevisionWrites = specRevisionPlan === null ? Object.freeze([]) : specRevisionPlan.writes;
    const reviewPublication = this.#reviewPublicationFact(activity, artifactWrites, specRevisionPlan);
    if (reviewPublication !== null) activity = activity.withReviewPublication(reviewPublication);
    const activityId = FlowActivityId.from(activity.id);
    const allArtifactWrites = Object.freeze([...artifactWrites, ...specRevisionWrites]);
    const artifactBaselines = this.#artifactBaselines(input?.artifactBaselines);
    const systemActivity = LIFECYCLE_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || POLICY_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || ["publish_plugin_artifacts", "publish_upgrade_result"].includes(activity.transition.operation)
      || OUTBOX_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || FINALIZE_DOWNSTREAM_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || DISPATCH_APPROVAL_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || OBSERVATION_TRANSITION_OPERATIONS.has(activity.transition.operation)
      || taskAddition;
    const stateArtifacts = systemActivity
      ? [
          publicationFor("flow.state", "application/json", { activityId }),
          publicationFor("flow.activities", "application/x-ndjson", { activityId }),
          ...(taskSpec === null ? [] : [publicationFor("spec.record", "application/json", { activityId })]),
        ]
      : (() => {
          const updater = FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString();
          return [
            publicationFor("flow.state", "application/json", { updater, activityId }),
          publicationFor("flow.activities", "application/x-ndjson", { updater, activityId }),
        ];
      })();
    const artifacts = [
      ...stateArtifacts,
      ...(replacementSpec === null
        ? []
        : [publicationFor("spec.record", "application/json", {
            updater: FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString(),
            activityId,
          })]),
      ...allArtifactWrites.map((artifact) => artifact.publication(activity)),
    ];
    const removals = artifactRemovals.map((artifact) => artifact.removal(activity));
    const paths = new Set([
      ...artifacts.map((artifact) => artifact.relativePath),
      ...removals.map((artifact) => artifact.relativePath),
    ]);
    if (paths.size !== artifacts.length + removals.length) {
      throw new CurrentFlowStateInvariantError("canonical Activity cannot write and remove the same artifact path");
    }
    const options = {
      artifacts,
      precondition: (catalog) => {
        const taskReviewStagePlan = activity.transition.taskReviewStagePlan;
        if (taskReviewStagePlan !== null) {
          const binding = taskReviewStagePlan.facts.binding;
          if (binding.catalogFingerprint !== catalog.hash) {
            throw new CurrentFlowStateConflictError("Task Review stage catalog changed before connector publication");
          }
          const logicalKey = `task.${binding.stage}`;
          const stageWrite = artifactWrites.find((write) => (
            write.artifact.logicalKey === logicalKey
            && write.artifact.relativePath === resolvedArtifact(logicalKey, { taskId: binding.taskId }).relativePath
          )) ?? null;
          if (stageWrite === null || sha256Bytes(stageWrite.bytes) !== binding.artifactDigest) {
            throw new CurrentFlowStateInvariantError("Task Review stage plan does not bind its producer artifact bytes");
          }
        }
        if (specRevisionPlan !== null) {
          const current = this.#assertSpecRevisionAuthority(catalog);
          if (current.fingerprint !== specRevisionPlan.authority.fingerprint) {
            throw new CurrentFlowStateConflictError("canonical Spec revision authority changed before publication");
          }
        }
        if (reviewPublication !== null) {
          this.#assertReviewPublicationFact({
            activity,
            reviewPublication,
            artifactWrites,
            specRevisionPlan,
            catalog,
          });
        }
        // The catalog lock encloses this check and the subsequent state
        // Activity.  A producer cannot disappear between validation and a
        // consumer claim, and no caller can defer this failure downstream.
        if (admission !== null) {
          admission.assert(this.#canonicalTransitionView(catalog));
        }
        for (const baseline of artifactBaselines) baseline.assertCatalog(catalog);
        testSourceBaseline?.assertCatalog(catalog);
      },
      write: () => {
        if (taskSpec !== null) this.#materializeTaskWorkspace(activity.transition.task);
        const result = this.#store().apply({
          ...input,
          activity,
          assertCurrentState: (state) => this.#assertPersistedIdentity(state),
        });
        if (taskSpec !== null) {
          this.#writeSpecRecord(taskSpec);
        }
        if (replacementSpec !== null) this.#writeSpecRecord(replacementSpec);
        for (const artifact of allArtifactWrites) artifact.write(this.location);
        for (const artifact of artifactRemovals) artifact.remove(this.location);
        return result;
      },
      removals,
    };
    const publication = systemActivity
      ? this.catalogStore.publishManySystem(options)
      : this.catalogStore.publishMany({
          ...options,
          publicationClaim: sourceWorkerUpgrade
            ? sourceWorkerUpgradePublicationClaimForStep(
                FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString(),
              )
            : artifactPublicationClaimForStep(FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString()),
        });
    return publication.result;
  }
  catalog() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: (catalog) => { this.#assertPersistedIdentity(this.#store().load()); return catalog; },
    });
  }
  flowIdentity() {
    return this.catalogStore.read({
      relativePaths: [resolvedArtifact("flow.state").relativePath],
      read: () => this.#assertPersistedIdentity(this.#store().load()).identity,
    });
  }
  #assertPersistedIdentity(state) {
    if (!(state instanceof CurrentFlowState) || !state.identity.matchesLocation(this.location)) {
      throw new CurrentFlowStateInvariantError("persisted flow.json identity does not match the opened Version location");
    }
    return state;
  }
  #canonicalTransitionView(catalog) {
    const snapshot = this.#store().loadSnapshot();
    if (snapshot === null) throw new CurrentFlowStateConflictError("current Flow state does not exist");
    this.#assertPersistedIdentity(snapshot.state);
    return new CanonicalTransitionView({ location: this.location, snapshot, catalog });
  }
  #nextTaskSpec(activity, supplied) {
    const task = activity.transition.task;
    const nextTask = supplied == null
      ? { id: task.id, key: task.key }
      : supplied;
    if (!isPlainObject(nextTask)) {
      throw new CurrentFlowStateInvariantError("Task admission canonical Task specification must be an object");
    }
    if (nextTask.id !== task.id || (nextTask.key != null && nextTask.key !== task.key)) {
      throw new CurrentFlowStateInvariantError("Task admission canonical Task specification must match the Activity Task id and key");
    }
    return this.#readSpecRecord().withTask(nextTask);
  }
  #replacementSpec(value, activity, taskAddition) {
    if (value === undefined) {
      if (activity.transition.operation === "update_spec_record") {
        throw new CurrentFlowStateInvariantError("canonical overview update requires a replacement spec.json");
      }
      return null;
    }
    if (taskAddition) {
      throw new CurrentFlowStateInvariantError("Task admission cannot replace canonical spec.json");
    }
    const isTypedSpecUpdate = activity.transition.operation === "update_spec_record";
    const sourceCompletion = value instanceof CanonicalSourceWorkerSpecCompletion;
    const workerProposal = value instanceof CanonicalWorkerSpecPublication && value.hasTaskProposal;
    const sourceActive = activity.nodeId === "implement" || this.#isActiveTaskImplementation(activity);
    if (!isTypedSpecUpdate && !sourceCompletion && !["spec", "spec-repair", "approval"].includes(activity.nodeId)) {
      throw new CurrentFlowStateInvariantError("only spec, spec-repair, and approval Activities may replace canonical spec.json");
    }
    if (sourceCompletion && (!sourceActive || activity.transition.operation !== "confirm_attempt")) {
      throw new CurrentFlowStateInvariantError("source worker Spec completion must target active implement or Task implementation confirmation");
    }
    if (workerProposal && !["spec", "spec-repair"].includes(activity.nodeId)) {
      throw new CurrentFlowStateInvariantError("only initial Spec and Spec repair workers may propose Tasks");
    }
    if (isTypedSpecUpdate && !this.#isActiveTaskImplementation(activity) && activity.nodeId !== "approval") {
      throw new CurrentFlowStateInvariantError("canonical Spec update must target approval or the active Task implementation Step");
    }
    const previous = this.#readSpecRecord();
    const next = value instanceof CanonicalWorkerSpecPublication || value instanceof CanonicalSourceWorkerSpecCompletion
      ? value.materialize(previous, {
          specId: this.location.specId.toString(),
          ...(workerProposal && { admittedTaskIds: this.#admittedTaskIds(previous) }),
        })
      : CurrentFlowSpecRecord.from(value, { specId: this.location.specId.toString() });
    if (!next.specId.equals(this.location.specId)) {
      throw new CurrentFlowStateInvariantError("canonical replacement spec.json must match the Version specId");
    }
    return next;
  }
  #isActiveTaskImplementation(activity) {
    const state = this.#assertPersistedIdentity(this.#store().load());
    if (state.current?.at(-1) !== activity.nodeId) return false;
    const nodePath = state.definition.pathFor(state.root, activity.nodeId);
    if (nodePath === null) return false;
    const task = nodePath
      .map((id) => state.findNode(id))
      .find((node) => node instanceof TaskNode) ?? null;
    return task !== null && activity.nodeId === `${task.id}-impl`;
  }
  #admittedTaskIds(specRecord) {
    if (!(specRecord instanceof CurrentFlowSpecRecord)) {
      throw new CurrentFlowStateInvariantError("admitted Task lookup requires the current typed Spec record");
    }
    // TaskNodes are the rehydrated projection of confirmed Task-admission Activities.
    // The State Store has already checked that its journal and flow.json agree,
    // so traversing the journal again would duplicate that validation and make
    // every worker publication scale with the complete Flow history.
    const persisted = this.#store().load();
    if (persisted === null) throw new CurrentFlowStateInvariantError("admitted Task lookup requires persisted Flow state");
    const state = this.#assertPersistedIdentity(persisted);
    const container = state.findNode(state.definition.dynamicTaskContainerId);
    if (container === null) throw new CurrentFlowStateInvariantError("admitted Task lookup requires the dynamic Task container");
    const tasksById = new Map(specRecord.tasks.map((task) => [task.id, task]));
    const ids = [];
    for (const node of container.steps) {
      if (!(node instanceof TaskNode)) continue;
      const task = tasksById.get(node.id);
      if (task === undefined || task.key !== node.key) {
        throw new CurrentFlowStateInvariantError(`admitted Flow Task does not match canonical spec.json: ${node.id}`);
      }
      ids.push(node.id);
    }
    return Object.freeze(ids);
  }
  #artifactWrites(value, activity) {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) {
      throw new CurrentFlowStateInvariantError("canonical artifactWrites must be an array");
    }
    const writes = value.map((entry) => (
      entry instanceof CanonicalSourceWorkerUpgradeResult
        ? entry
        : CanonicalFlowArtifactWrite.from(entry)
    ));
    const paths = new Set(writes.map((entry) => entry.artifact.relativePath));
    if (paths.size !== writes.length) {
      throw new CurrentFlowStateInvariantError("canonical artifactWrites must not duplicate a path");
    }
    // `spec.json` is a root authority with a separate typed serializer.  It
    // changes only through the dedicated Task/spec APIs, never an arbitrary
    // byte payload smuggled through a worker completion.
    if (writes.some((entry) => entry.artifact.logicalKey === "spec.record")) {
      throw new CurrentFlowStateInvariantError("spec.record requires the typed canonical Spec writer");
    }
    if (writes.some((entry) => entry.artifact.logicalKey === "spec.snapshot")) {
      throw new CurrentFlowStateInvariantError("spec.snapshot artifacts are generated only by the canonical Spec revision Store");
    }
    // Resolve publication eagerly, before the state journal changes. This
    // makes an unauthorized producer fail closed without appending an
    // Activity that cannot be cataloged.
    for (const write of writes) write.publication(activity);
    return Object.freeze(writes);
  }
  #assertRequestedRevisionArtifacts(activity, writes) {
    const reviews = writes.filter((write) => write.artifact.logicalKey === "spec.review");
    if (reviews.length === 0) return;
    const expectedStage = REVIEW_PUBLICATION_STAGE_BY_NODE.get(activity.nodeId) ?? null;
    if (reviews.length !== 1 || expectedStage === null || activity.transition.operation !== "confirm_attempt") {
      throw new CurrentFlowStateInvariantError("spec.review artifacts require one confirmed canonical Spec review stage");
    }
    const authority = this.catalogStore.read({
      relativePaths: [resolvedArtifact("spec.record").relativePath],
      read: (catalog) => this.#assertSpecRevisionAuthority(catalog),
    });
    const write = reviews[0];
    const expectedPath = resolvedArtifact("spec.review", authority.parameters).relativePath;
    if (write.artifact.relativePath !== expectedPath) {
      throw new CurrentFlowStateInvariantError("spec.review artifacts must target the verified current Spec revision");
    }
    let review;
    try {
      review = new CanonicalSpecReview(JSON.parse(write.bytes.toString("utf8")));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`canonical review publication bytes are invalid: ${cause.message}`);
    }
    if (review.digest !== sha256Bytes(write.bytes)
      || review.identity.specId !== this.location.specId.toString()
      || review.identity.revision.value !== authority.revision
      || review.identity.digest !== sha256Bytes(authority.snapshotBytes)
      || review.identity.byteLength !== authority.snapshotBytes.length) {
      throw new CurrentFlowStateInvariantError("spec.review artifact does not bind the verified current Spec revision");
    }
    const audit = review.audit.at(-1) ?? null;
    if (audit === null || audit.stage !== expectedStage) {
      throw new CurrentFlowStateInvariantError("spec.review artifact must append the owning canonical review stage audit");
    }
  }
  #artifactBaselines(value) {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) {
      throw new CurrentFlowStateInvariantError("canonical artifactBaselines must be an array");
    }
    const baselines = value.map((entry) => CanonicalFlowArtifactBaseline.from(entry));
    const paths = new Set(baselines.map((entry) => entry.artifact.relativePath));
    if (paths.size !== baselines.length) {
      throw new CurrentFlowStateInvariantError("canonical artifactBaselines must not duplicate a path");
    }
    return Object.freeze(baselines);
  }
  #sourceWorkerUpgrade(value, activity, writes) {
    const upgrades = writes.filter((write) => write instanceof CanonicalSourceWorkerUpgradeResult);
    if (value === undefined) {
      if (upgrades.length > 0) {
        throw new CurrentFlowStateInvariantError("source worker upgrade evidence requires the sealed source handoff transaction");
      }
      return false;
    }
    if (value !== true || upgrades.length !== 1) {
      throw new CurrentFlowStateInvariantError("source worker upgrade transaction requires exactly one typed upgrade result");
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(activity.nodeId).toString();
    if (!requiresWorkerSourceHandoff(updater)) {
      throw new CurrentFlowStateInvariantError("source worker upgrade evidence requires a source handoff Step");
    }
    if (!SOURCE_WORKER_COMPLETION_OPERATIONS.has(activity.transition.operation)) {
      throw new CurrentFlowStateInvariantError("source worker upgrade evidence requires a source completion Activity");
    }
    return true;
  }
  #artifactRemovals(value, activity) {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) {
      throw new CurrentFlowStateInvariantError("canonical artifactRemovals must be an array");
    }
    const removals = value.map((entry) => CanonicalFlowArtifactRemoval.from(entry));
    const paths = new Set(removals.map((entry) => entry.artifact.relativePath));
    if (paths.size !== removals.length) {
      throw new CurrentFlowStateInvariantError("canonical artifactRemovals must not duplicate a path");
    }
    for (const removal of removals) removal.removal(activity);
    return Object.freeze(removals);
  }
  #testSourceBaseline(value, activity, writes, removals) {
    if (value === undefined) {
      if (removals.length > 0) {
        throw new CurrentFlowStateInvariantError(
          "canonical artifact removals require a complete test-source catalog baseline",
        );
      }
      return null;
    }
    const baseline = CanonicalFlowTestSourceBaseline.from(value);
    baseline.assertReplacement(activity, writes, removals);
    return baseline;
  }
  #reviewPublicationFact(activity, requestedWrites, specRevisionPlan) {
    const reviewWrites = requestedWrites.filter((write) => write.artifact.logicalKey === "spec.review");
    if (reviewWrites.length === 0) return null;
    if (reviewWrites.length !== 1) {
      throw new CurrentFlowStateInvariantError("canonical review publication requires exactly one requested spec.review artifact");
    }
    const expectedStage = REVIEW_PUBLICATION_STAGE_BY_NODE.get(activity.nodeId) ?? null;
    if (expectedStage === null || activity.transition.operation !== "confirm_attempt") {
      throw new CurrentFlowStateInvariantError("spec.review artifacts may be published only by confirmed canonical Spec review stages");
    }
    const reviewWrite = specRevisionPlan?.writes.find((write) => write.artifact.logicalKey === "spec.review")
      ?? reviewWrites[0];
    if (reviewWrite === null) {
      throw new CurrentFlowStateInvariantError("canonical review publication has no destination revision artifact");
    }
    let review;
    try {
      review = new CanonicalSpecReview(JSON.parse(reviewWrite.bytes.toString("utf8")));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`canonical review publication bytes are invalid: ${cause.message}`);
    }
    const audit = review.audit.at(-1) ?? null;
    if (audit === null || audit.stage !== expectedStage) {
      throw new CurrentFlowStateInvariantError("canonical review publication must append an audit entry for its confirmed stage");
    }
    const fact = new ActivityReviewPublication({
      generation: review.generation,
      identity: review.identity.toJSON(),
      reviewDigest: review.digest,
      relation: audit.relation,
      stage: audit.stage,
      outcome: audit.outcome,
    });
    fact.assertReview(review, {
      specId: this.location.specId.toString(),
      revision: review.identity.revision.value,
      bytes: reviewWrite.bytes,
    });
    return fact;
  }
  #assertReviewPublicationFact({ activity, reviewPublication, artifactWrites, specRevisionPlan, catalog }) {
    if (!(activity instanceof FlowActivity) || !(reviewPublication instanceof ActivityReviewPublication)) {
      throw new CurrentFlowStateInvariantError("canonical review publication validation requires typed Activity facts");
    }
    const requested = artifactWrites.filter((write) => write.artifact.logicalKey === "spec.review");
    const destination = specRevisionPlan?.writes.find((write) => write.artifact.logicalKey === "spec.review")
      ?? requested[0]
      ?? null;
    if (requested.length !== 1 || destination === null) {
      throw new CurrentFlowStateInvariantError("canonical review publication destination is ambiguous");
    }
    const publication = destination.publication(activity);
    const destinationMatch = destination.artifact.relativePath.match(/^revisions\/(\d+)\/review\.json$/);
    const revision = destinationMatch === null ? NaN : Number(destinationMatch[1]);
    if (!Number.isSafeInteger(revision)
      || publication.relativePath !== destination.artifact.relativePath
      || reviewPublication.identity.revision !== revision) {
      throw new CurrentFlowStateInvariantError("Activity review publication fact does not match its catalog destination");
    }
    let review;
    try {
      review = new CanonicalSpecReview(JSON.parse(destination.bytes.toString("utf8")));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`canonical review destination bytes are invalid: ${cause.message}`);
    }
    reviewPublication.assertReview(review, {
      specId: this.location.specId.toString(),
      revision,
      bytes: destination.bytes,
    });
    // The catalog lock makes this descriptor publication and the Activity
    // journal atomic. Validate the exact current authority now as the CAS
    // guard, rather than accepting a review fact based on an unverified path.
    const authority = this.#assertSpecRevisionAuthority(catalog);
    const sourceMatch = requested[0].artifact.relativePath.match(/^revisions\/(\d+)\/review\.json$/);
    const expectedSourceRevision = sourceMatch?.[1] ?? null;
    if (authority.parameters.revision !== expectedSourceRevision) {
      throw new CurrentFlowStateConflictError("canonical review publication source revision changed before confirmation");
    }
  }
  #readSpecRecord() {
    try {
      return new CurrentFlowSpecRecord(
        JSON.parse(fs.readFileSync(this.location.specFile, "utf8")),
        { specId: this.location.specId.toString() },
      );
    } catch (error) {
      if (error instanceof CurrentFlowStateInvariantError) throw error;
      throw new CurrentFlowStateInvariantError(`invalid canonical spec.json: ${error.message}`);
    }
  }
  #assertSpecRevisionAuthority(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new CurrentFlowStateInvariantError("canonical Spec revision authority requires the catalog snapshot");
    }
    const revisionsDirectory = this.location.resolve("revisions");
    if (!fs.existsSync(revisionsDirectory) || !fs.lstatSync(revisionsDirectory).isDirectory()) {
      throw new CurrentFlowStateInvariantError("canonical Spec revision history is required; run sennel migrate specs --to 2");
    }
    const revisionDirectories = fs.readdirSync(revisionsDirectory, { withFileTypes: true });
    if (revisionDirectories.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9]{3,}$/.test(entry.name))) {
      throw new CurrentFlowStateInvariantError("canonical Spec revision history contains an unsafe or non-normalized revision entry");
    }
    const snapshots = new Map(); const reviews = new Map();
    for (const descriptor of catalog.artifacts) {
      const snapshot = descriptor.relativePath.match(/^revisions\/(\d+)\/spec\.json$/);
      const review = descriptor.relativePath.match(/^revisions\/(\d+)\/review\.json$/);
      if (descriptor.logicalKey === "spec.snapshot") {
        if (snapshot === null) throw new CurrentFlowStateInvariantError("canonical Spec snapshot descriptor path is invalid");
        snapshots.set(snapshot[1], descriptor);
      } else if (descriptor.logicalKey === "spec.review") {
        if (review === null) throw new CurrentFlowStateInvariantError("canonical Spec review descriptor path is invalid");
        reviews.set(review[1], descriptor);
      } else if (snapshot !== null || review !== null) {
        throw new CurrentFlowStateInvariantError("canonical Spec revision path has an invalid catalog descriptor");
      }
    }
    const directoryRevisions = revisionDirectories.map((entry) => entry.name).sort();
    if (directoryRevisions.some((name) => {
      const value = Number(name);
      try {
        return new FlowSpecRevision(value).pathSegment !== name;
      } catch {
        return true;
      }
    })) throw new CurrentFlowStateInvariantError("canonical Spec revision directory is not normalized");
    if (directoryRevisions.length === 0 || snapshots.size !== directoryRevisions.length
      || directoryRevisions.some((revision) => !snapshots.has(revision))
      || [...reviews.keys()].some((revision) => !snapshots.has(revision))) {
      throw new CurrentFlowStateInvariantError("canonical Spec revision snapshots and optional reviews do not match the catalog authority");
    }
    const revision = Math.max(...directoryRevisions.map(Number));
    if (directoryRevisions.length !== revision || directoryRevisions.some((name, index) => Number(name) !== index + 1)) {
      throw new CurrentFlowStateInvariantError("canonical Spec revision collection must be contiguous from revision 1");
    }
    const parameters = { revision: new FlowSpecRevision(revision).pathSegment };
    const snapshotDescriptor = snapshots.get(parameters.revision);
    const reviewDescriptor = reviews.get(parameters.revision) ?? null;
    if (snapshotDescriptor === undefined) throw new CurrentFlowStateInvariantError("current canonical Spec revision snapshot is absent from the catalog");
    const snapshot = this.location.resolve(snapshotDescriptor.relativePath);
    const rootBytes = fs.readFileSync(this.location.specFile);
    const rootDescriptor = catalog.resolve("spec.json");
    if (rootDescriptor.logicalKey !== "spec.record" || rootDescriptor.hash !== sha256Bytes(rootBytes) || rootDescriptor.size !== rootBytes.length) {
      throw new CurrentFlowStateInvariantError("root canonical spec.json descriptor does not match its authority bytes");
    }
    const snapshotBytes = fs.readFileSync(snapshot);
    if (!rootBytes.equals(snapshotBytes)) {
      throw new CurrentFlowStateInvariantError("root canonical spec.json does not match its current immutable revision snapshot");
    }
    if (snapshotDescriptor.hash !== sha256Bytes(snapshotBytes) || snapshotDescriptor.size !== snapshotBytes.length) {
      throw new CurrentFlowStateInvariantError("current canonical Spec snapshot descriptor does not match its bytes");
    }
    if (reviewDescriptor !== null) {
      const review = this.location.resolve(reviewDescriptor.relativePath);
      let document;
      try { document = new CanonicalSpecReview(JSON.parse(fs.readFileSync(review, "utf8"))); } catch (cause) {
        throw new CurrentFlowStateInvariantError(`current canonical review is invalid: ${cause.message}`);
      }
      const reviewBytes = fs.readFileSync(review);
      if (reviewDescriptor.hash !== sha256Bytes(reviewBytes) || reviewDescriptor.size !== reviewBytes.length
        || document.digest !== reviewDescriptor.hash
        || document.identity.specId !== this.location.specId.toString()
        || document.identity.revision.value !== revision || document.identity.digest !== sha256Bytes(rootBytes)
        || document.identity.byteLength !== rootBytes.length) {
        throw new CurrentFlowStateInvariantError("current canonical review identity does not match the root Spec revision");
      }
    }
    return Object.freeze({
      revision, parameters, snapshotBytes, reviewDescriptor,
      fingerprint: JSON.stringify({ revision, root: rootDescriptor.toJSON(), snapshot: snapshotDescriptor.toJSON(), review: reviewDescriptor?.toJSON() ?? null }),
    });
  }
  #specRevisionWrites(next, activity, requestedArtifactWrites = []) {
    const currentBytes = fs.readFileSync(this.location.specFile);
    const nextBytes = Buffer.from(next.canonicalText, "utf8");
    const current = this.catalogStore.read({
      relativePaths: [resolvedArtifact("spec.record").relativePath],
      read: (catalog) => {
        // Identity is the outer authority boundary.  Check it before reading
        // revision members so a foreign, internally coherent Version cannot
        // be reported as a local revision defect.
        this.#assertPersistedIdentity(this.#store().load());
        return this.#assertSpecRevisionAuthority(catalog);
      },
    });
    if (currentBytes.equals(nextBytes)) return Object.freeze({ authority: current, writes: Object.freeze([]) });
    const revision = current.revision + 1;
    const parameters = { revision: new FlowSpecRevision(revision).pathSegment };
    if (!current.snapshotBytes.equals(currentBytes)) {
      throw new CurrentFlowStateInvariantError("root canonical spec.json does not match its current immutable revision snapshot");
    }
    const sourceReviewWrite = requestedArtifactWrites.find((write) => (
      write.artifact.logicalKey === "spec.review"
      && write.artifact.relativePath === resolvedArtifact("spec.review", current.parameters).relativePath
    )) ?? null;
    const review = sourceReviewWrite === null ? null : new CanonicalSpecReview({
          ...new CanonicalSpecReview(JSON.parse(sourceReviewWrite.bytes.toString("utf8"))).toJSON(),
          identity: {
            specId: this.location.specId.toString(), revision,
            digest: sha256Bytes(nextBytes), byteLength: nextBytes.length,
          },
        });
    const writes = [new CanonicalFlowArtifactWrite({ logicalKey: "spec.snapshot", parameters, mediaType: "application/json", bytes: nextBytes })];
    if (review !== null) {
      writes.push(new CanonicalFlowArtifactWrite({
        logicalKey: "spec.review", parameters, mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`, "utf8"),
      }));
    }
    return Object.freeze({ authority: current, writes: Object.freeze(writes) });
  }
  #writeSpecRecord(specRecord) {
    if (!(specRecord instanceof CurrentFlowSpecRecord)) {
      throw new CurrentFlowStateInvariantError("canonical spec.json writer requires CurrentFlowSpecRecord");
    }
    new AtomicFile(this.location.specFile, { phaseNamespace: "current-flow-spec" })
      .write(Buffer.from(specRecord.canonicalText, "utf8"));
  }
  #materializeTaskWorkspace(task) {
    if (!(task instanceof ActivityTask)) {
      throw new CurrentFlowStateInvariantError("Task workspace requires the typed Task-admission payload");
    }
    // Task result files are produced and cataloged by their owning Steps.
    // Creation reserves only the canonical directory topology; it never
    // creates empty result/file-map authorities that a later producer could
    // mistake for evidence.
    const taskLocation = this.location.taskArtifactLocation(task.id);
    for (const directory of [taskLocation.implDirectory, taskLocation.reviewDirectory, taskLocation.triageDirectory, taskLocation.repairDirectory, taskLocation.gateDirectory]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    }
  }
  #store() {
    if (!fs.existsSync(this.location.directory)) throw new CurrentFlowStateConflictError("Current Flow Version root does not exist");
    if (this.#stateStore === null) {
      this.#stateStore = new CurrentFlowStateStore({
        directory: this.location.directory,
        definition: this.definition,
        runtimeLockLocation: this.location.runtimeLock("runtime.lock.current-flow-state"),
        ...(this.faultInjector && { faultInjector: this.faultInjector }),
        ...(this.processIdentitySource && { processIdentitySource: this.processIdentitySource }),
      });
    }
    return this.#stateStore;
  }
}

export class CurrentFlowVersionSemanticValidator extends FlowVersionSemanticValidator {
  constructor({ definition } = {}) {
    super();
    if (!(definition instanceof CurrentFlowDefinition)) throw new CurrentFlowStateInvariantError("CurrentFlowDefinition is required for Version semantic validation");
    this.definition = definition;
    this.stateValidator = new CurrentFlowStateValidator({ definition });
    this.stateSerializer = new CurrentFlowStateSerializer({ validator: this.stateValidator });
    Object.freeze(this);
  }
  validateState(state) {
    if (!(state instanceof CurrentFlowState)) throw new CurrentFlowStateInvariantError("a validated complete CurrentFlowState is required for migration");
    return this.stateSerializer.serialize(state);
  }
  serializeState(state) {
    return this.stateSerializer.bytes(state);
  }
  openStore(location) {
    return new CurrentFlowVersionStore({ location, definition: this.definition });
  }
  /**
   * Test-only legacy-materialization adapter.  The generic migration fixture
   * still proves source inventory and mapping contracts, but the durable
   * target is created through the same revision-aware Store as production.
   */
  materializeCurrentFixture({ location, state, spec } = {}) {
    if (!(location instanceof FlowVersionLocation) || !(spec instanceof AuthoritativeSpecRecord)) {
      throw new CurrentFlowStateInvariantError("current migration fixture requires typed location and Spec record");
    }
    const store = this.openStore(location);
    store.create(state, {
      specRecord: CurrentFlowSpecRecord.from(spec.schemaPayload().toJSON(), { specId: spec.specId }),
    });
    return store.catalog();
  }
  validateMaterialized({ location, spec } = {}) {
    if (
      !(location instanceof FlowVersionLocation)
      || (!(spec instanceof AuthoritativeSpecRecord) && !(spec instanceof CurrentFlowSpecRecord))
    ) {
      throw new CurrentFlowStateInvariantError("Version semantic validation requires typed location and Spec record");
    }
    const canonicalSpec = spec instanceof CurrentFlowSpecRecord
      ? spec
      : CurrentFlowSpecRecord.from(spec.toJSON());
    const store = this.openStore(location);
    const state = store.load();
    if (!state.specId || !canonicalSpec.specId.equals(new FlowSpecIdentity(state.specId))) {
      throw new CurrentFlowStateInvariantError("Version semantic Spec identity mismatch");
    }
    store.loadSnapshot();
    return store;
  }
}

export class CurrentFlowVersionMigrationOutputBuilder extends FlowVersionMigrationOutputBuilder {
  constructor({ semanticValidator } = {}) {
    super();
    if (!(semanticValidator instanceof CurrentFlowVersionSemanticValidator)) {
      throw new CurrentFlowStateInvariantError("migration output builder requires the production CurrentFlowVersionSemanticValidator");
    }
    this.semanticValidator = semanticValidator;
    Object.freeze(this);
  }
  build({ plan, state, spec } = {}) {
    const outputs = [];
    for (const artifact of plan.artifacts.filter((entry) => entry.operation.value === "transform")) {
      let bytes;
      if (artifact.outputKey === "current-flow-state") bytes = this.semanticValidator.serializeState(state);
      else if (artifact.outputKey === "authoritative-spec-record") {
        bytes = Buffer.from(spec.schemaPayload().canonicalText, "utf8");
      }
      else throw new CurrentFlowStateInvariantError(`unsupported Current Flow migration transform: ${artifact.outputKey}`);
      outputs.push(new FlowVersionMigrationOutput({
        outputKey: artifact.outputKey, targetPath: artifact.targetPath, operation: artifact.operation,
        bytes, mediaType: artifact.mediaType, authoritySlot: artifact.authoritySlot,
        retention: artifact.retention, activityId: artifact.activityId,
      }));
    }
    for (const artifact of plan.generatedArtifacts) {
      let bytes;
      if (artifact.outputKey === "activity-ledger") bytes = Buffer.alloc(0);
      else throw new CurrentFlowStateInvariantError(`unsupported Current Flow generated output: ${artifact.outputKey}`);
      outputs.push(new FlowVersionMigrationOutput({
        outputKey: artifact.outputKey, targetPath: artifact.targetPath, operation: artifact.operation,
        bytes, mediaType: artifact.mediaType, authoritySlot: artifact.authoritySlot,
        retention: artifact.retention, activityId: artifact.activityId,
      }));
    }
    return new FlowVersionMigrationOutputSet(outputs);
  }
}
