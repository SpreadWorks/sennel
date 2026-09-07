/**
 * Read-only, current-Attempt facts used by definition-owned Review routing.
 * Facts describe evidence; definition.js alone chooses a transition.
 */
import { readCatalogedSourceArtifact } from "./flow-findings.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import {
  flowReviewRouteForPhase,
  reviewPhaseForFlowStepId,
} from "./review-route.js";
import { currentTaskReviewAttemptCount } from "./task-review-attempt-accounting.js";

const SHA256 = /^[a-f0-9]{64}$/;
const VERDICTS = new Set(["PASS", "ADVISORY", "REJECTED"]);
const FINDING_DISPOSITIONS = new Set(["must-fix", "deferred", "informational"]);
const MECHANICAL = new Set([
  "tooling_failure", "parser_error", "coverage_error", "schema_error", "invalid_schema",
  "command_failure", "failed_command", "failed_test_evidence", "coverage_header_failure",
  "missing_header", "uncovered_requirement", "unknown_requirement_id", "malformed_header",
  "duplicate_requirement_id", "duplicate_header", "not_testable_in_header",
  "wrong_header_marker", "header_without_test_name", "test_name_without_header",
  "no_progress_guard", "flow_corruption", "malformed_artifact",
]);

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizedKind(value) {
  return String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
}

function nonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0) || [];
}

function sourceBlockingFindings(artifact) {
  return nonEmptyArray(
    artifact?.blocking,
    artifact?.blockingFindings,
    artifact?.findings,
    artifact?.comments,
    artifact?.proposals,
  );
}

function sourceReviewFindings(artifact) {
  return [
    ...sourceBlockingFindings(artifact),
    ...nonEmptyArray(artifact?.advisoryFindings, artifact?.nonBlockingImprovements),
  ];
}

function hasMechanicalMarker(finding) {
  return normalizedKind(finding?.origin) === "test_coverage"
    || MECHANICAL.has(normalizedKind(finding?.failureKind))
    || MECHANICAL.has(normalizedKind(finding?.failureMode));
}

function validFingerprint(value) {
  return typeof value === "string" && SHA256.test(value);
}

function validTestRevision(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === 1
    && typeof value.runId === "string"
    && value.runId.trim() !== ""
    && typeof value.specId === "string"
    && value.specId.trim() !== ""
    && value.stepId === "test"
    && validFingerprint(value.digest)
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && typeof value.finalizedAt === "string"
    && Number.isFinite(Date.parse(value.finalizedAt));
}

/** Typed evidence selected for an exhausted acceptance handoff. */
export class ReviewDeferralEvidence {
  constructor({ status, sourceFingerprints = [], reason = null } = {}) {
    if (!["available", "unavailable", "invalid"].includes(status)) {
      throw new Error("review deferral evidence status is invalid");
    }
    if (!Array.isArray(sourceFingerprints) || sourceFingerprints.some((value) => !validFingerprint(value))) {
      throw new Error("review deferral evidence fingerprints are invalid");
    }
    if (new Set(sourceFingerprints).size !== sourceFingerprints.length) {
      throw new Error("review deferral evidence fingerprints must be unique");
    }
    if ((status === "available") !== (sourceFingerprints.length > 0)) {
      throw new Error("available review deferral evidence requires source fingerprints");
    }
    if (status === "invalid" && (typeof reason !== "string" || reason.trim() === "")) {
      throw new Error("invalid review deferral evidence requires a reason");
    }
    if (status !== "invalid" && reason !== null) {
      throw new Error("valid review deferral evidence must not include an invalidity reason");
    }
    this.status = status;
    this.sourceFingerprints = Object.freeze([...sourceFingerprints]);
    this.reason = reason;
    Object.freeze(this);
  }

  get available() { return this.status === "available"; }

  static fromArtifact({ artifact, phase }) {
    const evidence = artifact?.canonicalEvidence;
    const requiresDisposition = phase === "test" || phase === "impl";
    const sourceFindings = sourceBlockingFindings(artifact);
    const rawFindings = sourceReviewFindings(artifact);
    if (
      evidence === null
      || typeof evidence !== "object"
      || Array.isArray(evidence)
      || evidence.disposition !== "REJECTED"
      || !Array.isArray(evidence.blockingFindings)
      || !Array.isArray(evidence.advisoryFindings)
      || evidence.blockingFindings.length === 0
      || !validFingerprint(evidence?.identity?.evidenceDigest)
    ) {
      return new ReviewDeferralEvidence({ status: "invalid", reason: "canonical rejected review evidence is malformed" });
    }
    const allFindings = [...evidence.blockingFindings, ...evidence.advisoryFindings];
    const canonicalFingerprints = allFindings.map((finding) => finding?.fingerprint);
    const invalidFinding = (finding, { requireRationale }) => (
      finding === null
      || typeof finding !== "object"
      || Array.isArray(finding)
      || !validFingerprint(finding.fingerprint)
      || hasMechanicalMarker(finding)
      || (finding.disposition != null && !FINDING_DISPOSITIONS.has(finding.disposition))
      || (requiresDisposition && !FINDING_DISPOSITIONS.has(finding.disposition))
      || (requireRationale && (typeof finding.rationale !== "string" || finding.rationale.trim() === ""))
    );
    const sourceFindingByFingerprint = new Map(rawFindings.map((finding) => [finding?.fingerprint, finding]));
    if (
      new Set(canonicalFingerprints).size !== canonicalFingerprints.length
      || sourceFindingByFingerprint.size !== rawFindings.length
      || allFindings.some((finding) => invalidFinding(finding, { requireRationale: false }))
      || rawFindings.some((finding) => invalidFinding(finding, { requireRationale: requiresDisposition }))
      || allFindings.some((finding) => (
        !sourceFindingByFingerprint.has(finding.fingerprint)
        || sourceFindingByFingerprint.get(finding.fingerprint).disposition !== finding.disposition
      ))
    ) {
      return new ReviewDeferralEvidence({ status: "invalid", reason: "review finding evidence is malformed or mechanical" });
    }
    const sourceFingerprints = new Set(sourceFindings
      .map((finding) => finding?.fingerprint)
      .filter(validFingerprint));
    const selected = evidence.blockingFindings
      .filter((finding) => !requiresDisposition || finding.disposition === "must-fix" || finding.disposition === "deferred")
      .map((finding) => finding.fingerprint);
    if (selected.some((fingerprint) => !sourceFingerprints.has(fingerprint))) {
      return new ReviewDeferralEvidence({ status: "invalid", reason: "canonical finding is absent from the source review artifact" });
    }
    return selected.length === 0
      ? new ReviewDeferralEvidence({ status: "unavailable" })
      : new ReviewDeferralEvidence({ status: "available", sourceFingerprints: selected });
  }
}

/** Structural repair evidence fact; current test revision equality is checked only after route selection. */
export class ReviewRepairEvidence {
  constructor({ status, reason = null } = {}) {
    if (!["available", "unavailable", "not-applicable"].includes(status)) {
      throw new Error("review repair evidence status is invalid");
    }
    if (status === "unavailable" && (typeof reason !== "string" || reason.trim() === "")) {
      throw new Error("unavailable review repair evidence requires a reason");
    }
    if (status !== "unavailable" && reason !== null) {
      throw new Error("available review repair evidence must not include a reason");
    }
    this.status = status;
    this.reason = reason;
    Object.freeze(this);
  }

  get available() { return this.status === "available"; }

  static fromArtifact({ phase, verdict, artifact }) {
    if (phase !== "test" || verdict !== "REJECTED") {
      return new ReviewRepairEvidence({ status: "not-applicable" });
    }
    const evidence = artifact?.canonicalEvidence;
    const revision = artifact?.sourceTestArtifactRevision;
    const valid = artifact?.phase === "test"
      && evidence?.disposition === "REJECTED"
      && Array.isArray(evidence?.blockingFindings)
      && evidence.blockingFindings.length > 0
      && evidence.blockingFindings.every((finding) => (
        typeof finding?.findingId === "string"
        && finding.findingId.trim() !== ""
        && validFingerprint(finding.fingerprint)
      ))
      && validFingerprint(evidence?.identity?.evidenceDigest)
      && validTestRevision(revision);
    return valid
      ? new ReviewRepairEvidence({ status: "available" })
      : new ReviewRepairEvidence({ status: "unavailable", reason: "canonical test-review repair evidence is unavailable" });
  }
}

function taskReviewNodeId(state) {
  if (typeof state?.currentTaskId !== "string" || state.currentTaskId.trim() === "") return null;
  return `${state.currentTaskId}-review`;
}

function taskReviewRound(state, flowManager) {
  const current = flowManager.taskMutationLineages({ specId: state.specId, taskId: state.currentTaskId }).at(-1) ?? null;
  if (current === null) throw new Error("Task Review requires a canonical Task execution budget");
  return current.budget.round;
}

function currentAttemptArtifact({ flowManager, source, logicalKey, typedState }) {
  if (source === null || typedState?.attempt == null) return null;
  const publication = flowManager.activityLedger(typedState.specId)
    .find((activity) => activity.id === source.descriptor.activityId) ?? null;
  if (
    publication?.attemptId !== typedState.attempt.id
    || publication?.sequence !== typedState.attempt.sequence
  ) return null;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: source.bytes });
  if (history.current.attempt !== typedState.attempt.sequence) return null;
  return history.current.payload;
}

export class ReviewTransitionFacts {
  constructor({
    scope,
    phase,
    verdict = null,
    toolingOutcome = null,
    artifact = null,
    sourceArtifact = null,
    attemptCount = null,
    taskRound = null,
    deferralEvidence = null,
    repairEvidence = null,
  } = {}) {
    if (!["flow", "task"].includes(scope)) throw new Error("review transition scope is invalid");
    if (flowReviewRouteForPhase(phase) === null) throw new Error("review transition phase is invalid");
    if (verdict !== null && !VERDICTS.has(verdict)) throw new Error("review transition verdict is invalid");
    if (toolingOutcome !== null && (typeof toolingOutcome !== "object" || Array.isArray(toolingOutcome))) {
      throw new Error("review transition tooling outcome is invalid");
    }
    if (sourceArtifact !== null) required(sourceArtifact, "review transition source artifact");
    if (attemptCount !== null && (!Number.isSafeInteger(attemptCount) || attemptCount < 0)) {
      throw new Error("review transition attempt count is invalid");
    }
    if (taskRound !== null && (!Number.isSafeInteger(taskRound) || taskRound < 1 || taskRound > 2)) {
      throw new Error("review transition Task round is invalid");
    }
    this.scope = scope;
    this.phase = phase;
    this.verdict = verdict;
    this.toolingOutcome = toolingOutcome;
    this.artifact = artifact === null ? null : Object.freeze(structuredClone(artifact));
    this.sourceArtifact = sourceArtifact;
    this.attemptCount = attemptCount;
    this.taskRound = taskRound;
    this.deferralEvidence = deferralEvidence instanceof ReviewDeferralEvidence
      ? deferralEvidence
      : verdict === "REJECTED" && toolingOutcome === null
        ? ReviewDeferralEvidence.fromArtifact({ artifact, phase })
        : new ReviewDeferralEvidence({ status: "unavailable" });
    this.repairEvidence = repairEvidence instanceof ReviewRepairEvidence
      ? repairEvidence
      : ReviewRepairEvidence.fromArtifact({ phase, verdict, artifact });
    Object.freeze(this);
  }

  static forCurrentAttempt({ flowManager, flowState, typedState = null, scope, phase }) {
    const route = flowReviewRouteForPhase(phase);
    if (!route) throw new Error("review transition phase is invalid");
    const nodeId = scope === "task" ? taskReviewNodeId(flowState) : route.reviewStepId;
    const taskRound = scope === "task" ? taskReviewRound(flowState, flowManager) : null;
    if (nodeId === null || flowState?.currentNodeId !== nodeId) {
      return new ReviewTransitionFacts({
        scope,
        phase,
        attemptCount: null,
        taskRound,
      });
    }
    const sourceArtifact = scope === "task" ? "task.review" : route.logicalKey;
    const source = readCatalogedSourceArtifact({ flowManager, flowState, nodeId, sourceArtifact });
    const current = typedState ?? flowManager.canonicalState(flowState.specId);
    const artifact = currentAttemptArtifact({ flowManager, source, logicalKey: sourceArtifact, typedState: current });
    return new ReviewTransitionFacts({
      scope,
      phase,
      verdict: artifact?.verdict ?? null,
      toolingOutcome: artifact?.toolingOutcome ?? null,
      artifact,
      sourceArtifact,
      attemptCount: scope === "task" ? currentTaskReviewAttemptCount({
        attempt: current.attempt,
        includesCurrentResult: artifact !== null,
      }) : null,
      taskRound,
    });
  }
}

export function reviewPhaseForStep(stepId) {
  return reviewPhaseForFlowStepId(stepId);
}
