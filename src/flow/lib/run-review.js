/**
 * src/flow/lib/run-review.js
 *
 * FlowCommand: review — wraps `flow commands/review.js` for AI code quality review.
 * Runs review as a subprocess and parses its output.
 */

import { PKG_DIR } from "../../lib/cli.js";
import { runCmd } from "../../lib/process.js";
import { VALID_REVIEW_PHASES } from "../../lib/constants.js";
import { AgentTimeout } from "../../lib/agent-timeout.js";
import { AgentRuntimeDirectorySet } from "../../lib/agent.js";
import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import {
  flowLeafIdsBetween,
} from "../definition.js";
import { flattenSteps } from "./step-tree.js";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import { runGit } from "../../lib/git-helpers.js";
import { PRODUCT } from "../../lib/product.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import {
  REVIEW_FAILURE_MARKER_PREFIX,
  ReviewFailure,
} from "./review-failure.js";
import {
  assertAuditedBroadMode,
  resolveImplReviewScope,
  taskScopeViolationMessages,
} from "./task-scope.js";
import { normalizeDraftReviewArtifactDocument } from "./draft-review-artifacts.js";
import {
  ReviewToolingOutcome,
} from "./review-convergence.js";
import { FLOW_REVIEW_ROUTES } from "./review-route.js";
import { ReviewTargetAuthority } from "./review-target-authority.js";
import {
  CanonicalReviewPromotion,
  CanonicalReviewWorkUnit,
  canonicalReviewNodeId,
} from "./canonical-review-artifacts.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
  TaskReviewUnsealedWorkUnitSet,
} from "./review-work-unit.js";
import { isCanonicalFlowState } from "./canonical-test-artifacts.js";
import { ReviewExecutionLease } from "./review-execution-lease.js";
import { resolveCurrentReviewTransition } from "./review-transition-persistence.js";
import {
  CurrentTaskSourceSnapshot,
  TaskMutationLineageSet,
  TaskReviewRepairManifest,
} from "./task-mutation-lineage.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
  SourceWorkerCanonicalObservationAdvance,
  WorkerArtifactRepositoryMutationSnapshot,
} from "./worker-artifact-handoff.js";
import { CanonicalTaskContext } from "./task-canonical-context.js";
import { ReviewFindingCycle } from "./finding-disposition-policy.js";
import {
  TaskReviewConvergenceEvidence,
  TaskReviewRecurrenceContract,
} from "./review-recurrence.js";
import { TaskReviewExecutionIdentity } from "./task-review-execution-identity.js";
import { currentTaskReviewAttemptCount } from "./task-review-attempt-accounting.js";
import {
  readRetryRecoveryReceiptChain,
  retryReceiptArtifact,
  retryEvidenceRouteForNode,
} from "./retry-recovery.js";

const IMPL_REVIEW_PHASE = "impl";
const REVIEW_VERDICT_VALUES = Object.freeze(["PASS", "ADVISORY", "REJECTED"]);
const REVIEW_VERDICT_PATTERN = new RegExp(`verdict=(${REVIEW_VERDICT_VALUES.join("|")})`);
const REVIEW_TOOLING_OUTCOME_PATTERN = /outcome=TOOLING_ERROR/;
const MAX_IMPL_DOWNSTREAM_RESET_STEPS = 20;
// Review proposals invalidate all implementation leaves from fresh test
// execution through finalize cleanup; both endpoints are intentionally reset.
const IMPL_REVIEW_DOWNSTREAM_STEP_IDS = flowLeafIdsBetween("test-execute", "finalize-cleanup");
if (IMPL_REVIEW_DOWNSTREAM_STEP_IDS.length > MAX_IMPL_DOWNSTREAM_RESET_STEPS) {
  throw new Error(`impl downstream reset leaf count exceeds max ${MAX_IMPL_DOWNSTREAM_RESET_STEPS}`);
}

// Review execution phase metadata. Retry authority lives in definition.js.

const REVIEW_NODE_ID_BY_PHASE = Object.freeze(Object.fromEntries(
  FLOW_REVIEW_ROUTES.map((route) => [route.phase, route.reviewStepId]),
));

const REVIEW_PHASE_KEYS = Object.freeze(Object.keys(REVIEW_NODE_ID_BY_PHASE));

/** Validate recurrence claims against only canonical prior Task Review history. */
function assertTaskReviewRecurrenceExplanation({ artifact, flowManager, state, taskId }) {
  const cycle = ReviewFindingCycle.fromActivityLedger({
    runId: state.runId,
    activities: flowManager.activityLedger(state.specId),
  });
  const recurrence = new TaskReviewConvergenceEvidence({ flowManager, state, cycle })
    .recurrenceHistory(taskId);
  new TaskReviewRecurrenceContract({ history: recurrence }).validate([
    ...(artifact.blockingFindings || []),
    ...(artifact.nonBlockingImprovements || []),
  ]);
}

function persistedPhaseKey(ctxPhase) {
  return ctxPhase == null ? IMPL_REVIEW_PHASE : ctxPhase;
}

function isImplementationReviewPhase(phase) {
  return phase == null || phase === IMPL_REVIEW_PHASE;
}

function taskCursorRequiredReviewFailure(decision, state) {
  return Envelope.fail(
    "run",
    "review",
    "TASK_CURSOR_REQUIRED",
    taskScopeViolationMessages(decision, "impl-review"),
    { currentTaskId: state?.currentTaskId ?? null },
  );
}

function invalidReviewScopeFailure(decision, state) {
  return Envelope.fail(
    "run",
    "review",
    "REVIEW_SCOPE_INVALID",
    [`implementation review scope is invalid: ${decision.reason}`],
    {
      currentTaskId: state?.currentTaskId ?? null,
      reason: decision.reason,
    },
  );
}

function resolveDraftReviewPhaseKey(flowState = {}) {
  const steps = Array.isArray(flowState.steps) ? flattenSteps(flowState.steps) : [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.get("draft-coverage-review")?.status === "in_progress") return "draft-coverage";
  if (byId.get("draft-questions-review")?.status === "in_progress") return "draft-questions";
  return "draft-questions";
}

function reviewPhaseKeyForCtx(ctx, phase) {
  if (phase !== "draft") return persistedPhaseKey(phase);
  return resolveDraftReviewPhaseKey(ctx?.flowState || {});
}

export { REVIEW_PHASE_KEYS, assertTaskReviewRecurrenceExplanation };

const PHASE_REVIEW_PARSERS = {
  test:  { countPattern: /blocking=(\d+)/,   countKey: "blockingCount",   countWord: "blocking finding(s)",   label: "Test review", commandId: "flow.test.review" },
  spec:  { countPattern: /proposalCount=(\d+)/, countKey: "proposalCount", countWord: "proposal(s)", label: "Spec review", commandId: "flow.spec.review.propose" },
  draft: { countPattern: /(questions|findings|issues)=(\d+)/, countKey: "issueCount", countWord: "issue(s)", label: "Draft review", commandId: "flow.draft.review" },
};

function parseToolingOutcome(stderr) {
  if (!REVIEW_TOOLING_OUTCOME_PATTERN.test(stderr)) return null;
  const stage = stderr.match(/stage=([a-z_]+)/)?.[1] || "communication";
  const attempt = Number(stderr.match(/attempt=(\d+)/)?.[1] || 1);
  const maxAttempts = Number(stderr.match(/maxAttempts=(\d+)/)?.[1] || 1);
  const toolingKind = stderr.match(/toolingKind=([a-z_]+)/)?.[1] || `${stage}_error`;
  return new ReviewToolingOutcome({
    stage,
    attempt,
    maxAttempts,
    reason: toolingKind,
    permissionRelated: /permission|EACCES|EPERM|sandbox/i.test(stderr),
  });
}

function parsePhaseReviewOutput(res, stdout, stderr, { phase, countPattern, countKey, countWord, label }) {
  const verdictMatch = stderr.match(REVIEW_VERDICT_PATTERN);
  const toolingOutcome = parseToolingOutcome(stderr);
  const countMatch = stderr.match(countPattern);
  const reviewPathMatch = stderr.match(/Results saved to (\S+)/);
  const jsonPathMatch = stderr.match(/JSON saved to (\S+)/);
  const retryPhaseMatch = stderr.match(/retryPhase=([a-z-]+)/);
  const retryPhase = retryPhaseMatch ? retryPhaseMatch[1] : null;

  const verdict = verdictMatch ? verdictMatch[1] : (res.ok ? "PASS" : "REJECTED");
  const count = countMatch ? parseInt(countMatch[countMatch.length - 1], 10) : null;

  const changed = [];
  if (reviewPathMatch) changed.push(reviewPathMatch[1]);
  if (jsonPathMatch) changed.push(jsonPathMatch[1]);

  if (toolingOutcome) {
    const artifacts = { phase, toolingOutcome: toolingOutcome.toJSON(), [countKey]: count ?? 0 };
    if (retryPhase) artifacts.retryPhase = retryPhase;
    return {
      result: "tooling-error",
      changed,
      artifacts,
      output: stdout,
    };
  }

  if (!res.ok) {
    const detail = count === 0
      ? `${label} subprocess error (0 ${countWord} reported but process exited with error)`
      : count !== null
        ? `${label} FAIL: ${count} ${countWord} remaining`
        : `${label} failed (subprocess error)`;
    throw new Error(
      [detail, ...(stderr ? [stderr] : []), ...(stdout ? [stdout] : [])].join("\n"),
    );
  }

  const artifacts = { phase, verdict, [countKey]: count ?? 0 };
  if (retryPhase) artifacts.retryPhase = retryPhase;

  return {
    result: "ok",
    changed,
    artifacts,
    output: stdout,
  };
}

function parseTestReviewOutput(res, stdout, stderr) {
  const parsed = parsePhaseReviewOutput(res, stdout, stderr, { phase: "test", ...PHASE_REVIEW_PARSERS.test });
  const advisoryMatch = stderr.match(/advisory=(\d+)/);
  if (advisoryMatch) parsed.artifacts.advisoryCount = parseInt(advisoryMatch[1], 10);
  return parsed;
}

function parseSpecReviewOutput(res, stdout, stderr) {
  return parsePhaseReviewOutput(res, stdout, stderr, { phase: "spec", ...PHASE_REVIEW_PARSERS.spec });
}

function parseProposalReviewOutput(res, stdout, stderr) {
  return parsePhaseReviewOutput(res, stdout, stderr, { phase: "draft", ...PHASE_REVIEW_PARSERS.draft });
}

function parseImplReviewOutput(res, stdout, stderr, opts = {}) {
  const verdictMatch = stderr.match(REVIEW_VERDICT_PATTERN);
  const toolingOutcome = parseToolingOutcome(stderr);
  const blockingMatch = stderr.match(/blocking=(\d+)/);
  const nonBlockingMatch = stderr.match(/nonBlocking=(\d+)/);
  const reviewPathMatch = stderr.match(/Results saved to (\S+)/);
  const jsonPathMatch = stderr.match(/JSON saved to (\S+)/);
  const taskIdMatch = stderr.match(/taskId=(\S+)/);
  const targetMatch = stderr.match(/target=(\S+)/);

  const changed = [];
  if (reviewPathMatch) changed.push(reviewPathMatch[1]);
  if (jsonPathMatch) changed.push(jsonPathMatch[1]);

  if (toolingOutcome) {
    return {
      result: "tooling-error",
      changed,
      artifacts: {
        phase: "impl",
        toolingOutcome: toolingOutcome.toJSON(),
        blockingCount: 0,
        nonBlockingCount: 0,
      },
      output: stdout,
    };
  }

  if (!res.ok) {
    throw new Error(
      ["Impl review failed", ...(stderr ? [stderr] : []), ...(stdout ? [stdout] : [])].join("\n"),
    );
  }

  let artifactData = null;
  if (opts.root && jsonPathMatch) {
    const artifactPath = path.resolve(opts.root, jsonPathMatch[1]);
    try {
      artifactData = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    } catch (err) {
      throw new Error(`failed to read impl-review.json artifact: ${err.message}`);
    }
  }

  const verdict = artifactData?.verdict || (verdictMatch ? verdictMatch[1] : "PASS");
  const blockingCount = artifactData?.summary?.blocking ?? (blockingMatch ? parseInt(blockingMatch[1], 10) : 0);
  const nonBlockingCount = artifactData?.summary?.nonBlocking ?? (nonBlockingMatch ? parseInt(nonBlockingMatch[1], 10) : 0);

  const artifacts = {
    phase: "impl",
    verdict,
    blockingCount,
    nonBlockingCount,
  };
  if (taskIdMatch) artifacts.taskId = taskIdMatch[1];
  if (targetMatch) artifacts.target = targetMatch[1];

  return {
    result: "ok",
    changed,
    artifacts,
    output: stdout,
  };
}

function normalizeImplReviewSubprocessResult(result = {}) {
  const verdict = result.verdict || "PASS";
  return {
    verdict,
    failureKind: result.failureKind || null,
    retryable: result.retryable ?? null,
    reviewRetryConsumed: false,
    artifacts: result.artifacts || [],
    message: result.message || "",
  };
}

export { PHASE_REVIEW_PARSERS, parseTestReviewOutput, parseSpecReviewOutput, parseProposalReviewOutput, parseImplReviewOutput, normalizeImplReviewSubprocessResult };

export function appendIssueLogFromTestReviewToolingFailure(ctx, result) {
  void ctx;
  void result;
}

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;
const MAX_REVIEW_SUBPROCESS_RETRIES = 2;
const MAX_REVIEW_SUBPROCESS_RETRY_DELAY_MS = 30_000;

export function normalizeReviewSubprocessRetryCount(value) {
  const parsed = Number(value ?? DEFAULT_RETRY_COUNT);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRY_COUNT;
  return Math.min(MAX_REVIEW_SUBPROCESS_RETRIES, Math.max(0, Math.trunc(parsed)));
}

export function normalizeReviewSubprocessRetryDelayMs(value) {
  const parsed = Number(value ?? DEFAULT_RETRY_DELAY_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(MAX_REVIEW_SUBPROCESS_RETRY_DELAY_MS, Math.max(0, Math.trunc(parsed)));
}

/**
 * Run a command function with mechanical subprocess retry logic.
 * This does not consume the step retry budget; review verdict REJECTED is handled separately.
 *
 * @param {function} cmdFn - Function that returns { ok, status, stdout, stderr, signal, killed }
 * @param {Object} [opts]
 * @param {number} [opts.retryCount=2] - Number of retries for ordinary subprocess failures (schema failures are capped at two total attempts)
 * @param {number} [opts.retryDelayMs=3000] - Delay between retries in milliseconds
 * @param {boolean} [opts.retrySchema=true] - Whether this caller delegates schema retries to the outer subprocess boundary
 * @returns {Promise<{ ok: boolean, status: number, stdout: string, stderr: string, signal: string|null, killed: boolean }>}
 */
export async function runCmdWithRetry(cmdFn, opts = {}) {
  const retryCount = normalizeReviewSubprocessRetryCount(opts.retryCount);
  const retryDelayMs = normalizeReviewSubprocessRetryDelayMs(opts.retryDelayMs);
  const retrySchema = opts.retrySchema !== false;

  let lastRes;
  for (let attempt = 0; ; attempt++) {
    lastRes = cmdFn();
    if (lastRes.ok) return lastRes;
    const failure = ReviewFailure.fromSubprocessResult({
      phase: opts.phase || "impl",
      result: lastRes,
    });
    const maximumAttempts = failure.classification === "schema_failure" && retrySchema
      ? 2
      : retryCount + 1;
    const failureForAttempt = failure.withAttempts({
      currentAttempt: attempt + 1,
      maximumAttempts,
    });
    if (failureForAttempt !== failure) {
      const marker = failureForAttempt.toMarkerLine();
      const lines = String(lastRes.stderr || "").split(/\r?\n/);
      const markerIndex = lines.findIndex((line) => line.trim().startsWith(REVIEW_FAILURE_MARKER_PREFIX));
      if (markerIndex >= 0) lines[markerIndex] = marker;
      else lines.unshift(marker);
      lastRes = { ...lastRes, stderr: lines.join("\n") };
    }

    if (attempt + 1 >= maximumAttempts || !failureForAttempt.shouldRetrySubprocess({
      attempt: attempt + 1,
      maxAttempts: maximumAttempts,
    })) {
      return lastRes;
    }
    const next = attempt + 2;
    process.stderr.write(`[review] retry ${next}/${maximumAttempts} after ${retryDelayMs}ms...\n`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
}

const DRAFT_REPAIR_TARGET_PHASES = new Set(["draft-questions", "draft-coverage"]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalFindingFallbackId(phase, bucket, index) {
  return `${phase}-${bucket}-${String(index + 1).padStart(3, "0")}`;
}

class CanonicalReviewFindingRegistry {
  constructor() {
    this.findingIds = new Map();
    this.fingerprints = new Map();
  }

  uniqueFindingId(candidate, fallback, identity) {
    if (!this.findingIds.has(candidate) || this.findingIds.get(candidate) === identity) {
      return candidate;
    }
    let suffix = 1;
    let normalized = fallback;
    while (this.findingIds.has(normalized)) {
      suffix += 1;
      normalized = `${fallback}-${suffix}`;
    }
    return normalized;
  }

  uniqueFingerprint(candidate, identity) {
    if (!this.fingerprints.has(candidate) || this.fingerprints.get(candidate) === identity) {
      return candidate;
    }
    let suffix = 1;
    let normalized = sha256Hex(`${identity}:${suffix}`);
    while (this.fingerprints.has(normalized)) {
      suffix += 1;
      normalized = sha256Hex(`${identity}:${suffix}`);
    }
    return normalized;
  }

  register(input, { phase, bucket, index }) {
    const identity = stableStringify(input);
    const fallbackFindingId = canonicalFindingFallbackId(phase, bucket, index);
    const requestedFindingId = String(
      input.findingId || input.id || input.proposalId || input.findingKey || fallbackFindingId,
    ).trim();
    const requestedFingerprint = typeof input.fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.fingerprint)
      ? input.fingerprint
      : sha256Hex(identity);
    const findingId = this.uniqueFindingId(requestedFindingId, fallbackFindingId, identity);
    const fingerprint = this.uniqueFingerprint(requestedFingerprint, identity);
    this.findingIds.set(findingId, identity);
    this.fingerprints.set(fingerprint, identity);
    return { findingId, fingerprint };
  }
}

function canonicalFinding(input, artifactName, { findingId, fingerprint }) {
  const summary = String(
    input.summary || input.title || input.issue || input.improvement || input.rationale || "Review finding.",
  ).trim();
  return {
    findingId,
    summary,
    fingerprint,
    evidenceRefs: [`${artifactName}#${findingId}`],
    ...(input.disposition == null ? {} : { disposition: input.disposition }),
  };
}

export function reviewArtifactFindingLists(artifact, phase) {
  const blocking = [
    artifact.blockingFindings,
    artifact.blocking,
    artifact.findings,
    artifact.comments,
    artifact.proposals,
    artifact.questions,
    artifact.issues,
  ].find(Array.isArray) || [];
  const advisory = [
    artifact.advisoryFindings,
    artifact.nonBlockingImprovements,
    artifact.improvements,
  ].find(Array.isArray) || [];
  const repairTargets = DRAFT_REPAIR_TARGET_PHASES.has(phase) && Array.isArray(artifact.repairTargets)
    ? artifact.repairTargets
    : [];
  return { blocking, advisory: [...advisory, ...repairTargets] };
}

function canonicalFindingList(findings, { phase, bucket, artifactName, registry }) {
  return findings.map((finding, index) => canonicalFinding(
    finding,
    artifactName,
    registry.register(finding, { phase, bucket, index }),
  ));
}

export function canonicalReviewArtifactFindings(artifact, phase, artifactName) {
  const { blocking, advisory } = reviewArtifactFindingLists(artifact, phase);
  const registry = new CanonicalReviewFindingRegistry();
  return {
    blockingFindings: canonicalFindingList(blocking, {
      phase,
      bucket: "blocking",
      artifactName,
      registry,
    }),
    advisoryFindings: canonicalFindingList(advisory, {
      phase,
      bucket: "advisory",
      artifactName,
      registry,
    }),
  };
}

function resolveCurrentReviewTreeSha(ctx) {
  return ReviewTargetAuthority.fromContext(ctx).resolveTreeSha();
}

function resolveCurrentReviewTargetState(ctx, phase = reviewPhaseKeyForCtx(ctx, ctx?.phase || null)) {
  return ReviewTargetAuthority.fromContext(ctx).captureTargetStateForPhase(phase);
}

function resolveCurrentReviewRepairFingerprint(
  ctx,
  phase = reviewPhaseKeyForCtx(ctx, ctx?.phase || null),
) {
  return resolveCurrentReviewTargetState(ctx, phase).digest;
}

/** Definition-owned admission: this command may execute only when no other Review transition is selected. */
function reviewExecutionAdmission(ctx, { persistedPhase, executionRoot }) {
  const specId = ctx.specId ?? ctx.flowState.specId;
  const flowState = ctx.flowManager.loadReadOnly(specId);
  const currentState = ctx.flowManager.canonicalState(specId);
  const currentTaskId = persistedPhase === IMPL_REVIEW_PHASE
    ? flowState.currentTaskId ?? null
    : null;
  if (currentTaskId !== null) {
    try {
      CanonicalTaskContext.capture({
        root: executionRoot,
        flowManager: ctx.flowManager,
        state: flowState,
        taskId: currentTaskId,
      });
    } catch (error) {
      return Envelope.fail(
        "run",
        "review",
        "TASK_CONTEXT_INVALID",
        `canonical Task context is invalid: ${error.message}`,
        { taskId: currentTaskId },
      );
    }
  }
  const scope = currentTaskId === null ? "flow" : "task";
  const stepId = scope === "task"
    ? "task-review"
    : canonicalReviewNodeId({ phase: persistedPhase, taskId: currentTaskId });
  const selection = resolveCurrentReviewTransition({
    flowManager: ctx.flowManager,
    flowState,
    typedState: currentState,
    scope,
    stepId,
  });
  if (selection.disposition === null) return null;
  return Envelope.fail(
    "run",
    "review",
    "REVIEW_DEFINITION_ACTION_REQUIRED",
    "the definition selected a non-review transition for the current canonical evidence; refresh next-action and follow it before starting another Review worker",
    {
      phase: persistedPhase,
      operation: selection.disposition.operation,
      nextActionRequired: true,
      reviewDisposition: selection.disposition.toJSON(),
    },
  );
}

function taskReviewTransientDirectories(executionRoot, workUnit) {
  const reviewDirectory = path.relative(executionRoot, workUnit.workUnit.directory).split(path.sep).join("/");
  if (reviewDirectory === "" || reviewDirectory.startsWith("../") || path.posix.isAbsolute(reviewDirectory)) {
    throw new Error("Task Review work unit is outside its execution checkout");
  }
  // Child output is contractually confined to its work unit. Canonical spec
  // and task evidence remain source effects even in direct execution mode.
  return [reviewDirectory];
}

function taskReviewAgentRuntimeDirectories(executionRoot, agent = null) {
  const runtimeDirectories = agent?.runtimeDirectories?.();
  if (runtimeDirectories == null) return [];
  if (!(runtimeDirectories instanceof AgentRuntimeDirectorySet)) {
    throw new Error("Task Review agent runtime directories must use AgentRuntimeDirectorySet");
  }
  return runtimeDirectories.toArray().map((candidate) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error("Task Review agent runtime directory must be absolute");
    }
    const relative = path.relative(executionRoot, candidate).split(path.sep).join("/");
    if (relative === "" || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new Error("Task Review agent runtime directory escapes its execution checkout");
    }
    return relative;
  });
}

function taskReviewValidatedMetricMetadataPaths(executionRoot, workUnit) {
  const versionDirectory = path.relative(
    executionRoot,
    workUnit.flowManager.specLocation(workUnit.state.specId).directory,
  ).split(path.sep).join("/");
  if (versionDirectory === "" || versionDirectory.startsWith("../") || path.posix.isAbsolute(versionDirectory)) {
    return [];
  }
  // Deferred Agent metrics settle only after child source comparison. The
  // Store records that one observation atomically, rewriting its state,
  // ledger, and catalog metadata together. Callers must pair this narrow
  // exclusion with TaskReviewCanonicalObservationBoundary: it proves the
  // complete advance is an append-only record_metric transaction, so this
  // list can never turn a provider's direct canonical mutation into a repair.
  return ["flow.state", "flow.activities", "artifact.catalog"].map((logicalKey) => (
    path.posix.join(
      versionDirectory,
      FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey).relativePath,
    )
  ));
}

/**
 * Parent-owned proof for the one canonical advance permitted while a Task
 * Review child is running.  The child settles its deferred Agent metric only
 * after its own before/after source observation.  That settlement rewrites
 * the Version's three root metadata files.  We validate the Store-level
 * transaction before excluding those exact paths from the Task repair
 * manifest; all other canonical source remains subject to the repair policy.
 */
export class TaskReviewCanonicalObservationBoundary {
  constructor({ flowManager, specId, observationAdvance, canonicalSnapshot } = {}) {
    if (flowManager === null || typeof flowManager !== "object"
      || typeof flowManager.specLocation !== "function"
      || typeof flowManager.load !== "function"
      || typeof flowManager.activityLedger !== "function") {
      throw new Error("Task Review canonical observation boundary requires a FlowManager");
    }
    if (typeof specId !== "string" || specId.trim() === "") {
      throw new Error("Task Review canonical observation boundary requires a specId");
    }
    if (!(observationAdvance instanceof SourceWorkerCanonicalObservationAdvance)) {
      throw new Error("Task Review canonical observation boundary requires an observation advance");
    }
    if (!(canonicalSnapshot instanceof WorkerArtifactRepositoryMutationSnapshot)) {
      throw new Error("Task Review canonical observation boundary requires a canonical snapshot");
    }
    this.flowManager = flowManager;
    this.specId = specId.trim();
    this.observationAdvance = observationAdvance;
    this.canonicalSnapshot = canonicalSnapshot;
    Object.freeze(this);
  }

  static capture({ flowManager, specId } = {}) {
    const location = flowManager?.specLocation?.(specId);
    if (location === null || typeof location?.directory !== "string" || location.directory === "") {
      throw new Error("Task Review canonical observation boundary cannot locate the Version");
    }
    return new TaskReviewCanonicalObservationBoundary({
      flowManager,
      specId,
      observationAdvance: SourceWorkerCanonicalObservationAdvance.capture({ flowManager, specId }),
      canonicalSnapshot: WorkerArtifactRepositoryMutationSnapshot.capture({
        root: location.directory,
        authorities: ["canonical"],
      }),
    });
  }

  assertMetricSettlementOnly() {
    return this.observationAdvance.assertAllowed({
      flowManager: this.flowManager,
      specId: this.specId,
      canonicalSnapshot: this.canonicalSnapshot,
    });
  }
}

/** Parent-side source surface for a Task Review provider invocation. */
export function taskReviewRepairIgnoredDirectories(executionRoot, workUnit, agent = null) {
  return [...new Set([
    ...taskReviewTransientDirectories(executionRoot, workUnit),
    path.posix.join(PRODUCT.managedDirName, "agent-cache"),
    path.posix.join(PRODUCT.managedDirName, "review-execution-locks"),
    ...taskReviewAgentRuntimeDirectories(executionRoot, agent),
    ...taskReviewValidatedMetricMetadataPaths(executionRoot, workUnit),
  ])];
}

/**
 * Re-entry comparison excludes only the three files written by the parent's
 * fail-attempt transaction in direct mode.  The snapshot utility accepts
 * exact path entries as well as subtree entries, so this must never broaden
 * to the enclosing canonical Version directory: provider changes to spec or
 * evidence artifacts remain observable across Attempts.
 */
export function taskReviewRecoveryIgnoredDirectories(executionRoot, workUnit, agent = null) {
  const directories = [
    ...taskReviewRepairIgnoredDirectories(executionRoot, workUnit, agent),
  ];
  return [...new Set(directories)];
}

/** Restored parent-owned source checkpoint from a sealed or unsealed unit. */
class TaskReviewPersistedSourceBaseline {
  constructor({ workUnit, executionRoot, logicalKey } = {}) {
    if (!(workUnit instanceof ReviewWorkUnit)) throw new Error("Task Review persisted baseline requires a work unit");
    if (!path.isAbsolute(executionRoot)) throw new Error("Task Review persisted baseline requires an absolute execution root");
    const key = typeof logicalKey === "string" && logicalKey !== "" ? logicalKey : null;
    if (key === null) throw new Error("Task Review persisted baseline requires a logical key");
    const input = workUnit.manifestDocument.inputs.find((entry) => entry.logicalKey === key) ?? null;
    if (input === null) throw new Error(`Task Review work unit is missing its ${key} baseline`);
    let bytes;
    try {
      bytes = input.assertSnapshot(workUnit.root).bytes;
      this.baseline = SourceMutationBaseline.fromStored(
        JSON.parse(bytes.toString("utf8")),
        { root: executionRoot },
      );
    } catch (cause) {
      throw new Error(`Task Review ${key} baseline is unreadable: ${cause.message}`);
    }
    if (this.baseline.attempt.id !== workUnit.manifestDocument.attemptId
      || this.baseline.attempt.nodeId !== workUnit.manifestDocument.nodeId) {
      throw new Error(`Task Review ${key} baseline does not bind its manifest Attempt`);
    }
    this.logicalKey = key;
    this.logicalPath = input.logicalPath;
    this.bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
}

function taskReviewBaselineInput(checkpoint) {
  if (!(checkpoint instanceof TaskReviewPersistedSourceBaseline)) {
    throw new Error("Task Review baseline input requires a persisted checkpoint");
  }
  return {
    logicalKey: checkpoint.logicalKey,
    logicalPath: checkpoint.logicalPath,
    bytes: checkpoint.bytes,
    mediaType: "application/json",
  };
}

function newTaskReviewBaselineInput({ logicalKey, logicalPath, baseline }) {
  if (!(baseline instanceof SourceMutationBaseline)) throw new Error("Task Review baseline input requires a source baseline");
  return {
    logicalKey,
    logicalPath,
    bytes: Buffer.from(`${JSON.stringify(baseline.toJSON(), null, 2)}\n`, "utf8"),
    mediaType: "application/json",
  };
}

/** Typed restoration of the immutable Task source supplied to one worker. */
class TaskReviewPersistedSourceSnapshot {
  constructor({ workUnit, lineageSet, executionRoot } = {}) {
    if (!(workUnit instanceof ReviewWorkUnit)) throw new Error("Task Review source checkpoint requires a recovered work unit");
    if (!(lineageSet instanceof TaskMutationLineageSet)) throw new Error("Task Review source checkpoint requires canonical lineage");
    if (!path.isAbsolute(executionRoot)) throw new Error("Task Review source checkpoint requires an absolute execution root");
    const input = workUnit.manifestDocument.inputs.find((entry) => entry.logicalKey === "task.source") ?? null;
    if (input === null) throw new Error("unsealed Task Review work unit is missing its task source checkpoint");
    let document;
    try {
      document = JSON.parse(input.assertSnapshot(workUnit.root).bytes.toString("utf8"));
    } catch (cause) {
      throw new Error(`unsealed Task Review source checkpoint is unreadable: ${cause.message}`);
    }
    try {
      this.snapshot = new CurrentTaskSourceSnapshot({ lineageSet, entries: document.entries });
    } catch (cause) {
      throw new Error(`unsealed Task Review source checkpoint cannot be restored against canonical lineage: ${cause.message}`);
    }
    if (
      document.fingerprint !== this.snapshot.fingerprint
      || document.runId !== this.snapshot.runId
      || document.specId !== this.snapshot.specId
      || document.taskId !== this.snapshot.taskId
      || JSON.stringify(document.lineageFingerprints) !== JSON.stringify(this.snapshot.lineageFingerprints)
    ) {
      throw new Error("unsealed Task Review source checkpoint does not match canonical lineage");
    }
    this.workUnit = workUnit;
    Object.freeze(this);
  }
}

/** Typed restoration of one retained, unsealed Task Review checkpoint. */
class TaskReviewUnsealedSourceCheckpoint {
  constructor({ workUnit, lineageSet, executionRoot } = {}) {
    const persisted = new TaskReviewPersistedSourceSnapshot({ workUnit, lineageSet, executionRoot });
    this.workUnit = persisted.workUnit;
    this.snapshot = persisted.snapshot;
    this.baseline = new TaskReviewPersistedSourceBaseline({
      workUnit,
      executionRoot,
      logicalKey: "task.source-effect-baseline",
    }).baseline;
    Object.freeze(this);
  }

  differsFrom(current) {
    if (!(current instanceof CurrentTaskSourceSnapshot)) throw new Error("Task Review source checkpoint comparison requires current source");
    return current.fingerprint !== this.snapshot.fingerprint;
  }

  observedSourceEffect() {
    const manifest = SourceMutationManifest.capture({ baseline: this.baseline });
    return manifest.mutations.length > 0;
  }

  changedRepositoryPaths() {
    const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({
      root: this.baseline.snapshot.root,
      authorities: this.baseline.snapshot.authorities,
      ignoredDirectories: this.baseline.snapshot.ignoredDirectories,
      runtimeLocks: this.baseline.snapshot.runtimeLocks,
    });
    return this.baseline.snapshot.allChangedPaths(snapshot);
  }
}

/** Safe diagnostic facts from a retained, partially-effected Task Review unit. */
class TaskReviewPartialEffectEvidence {
  constructor({ workUnit = null, checkpointSourceFingerprint = null, currentSourceFingerprint = null } = {}) {
    if (workUnit !== null && (typeof workUnit !== "string" || !path.isAbsolute(workUnit))) {
      throw new Error("Task Review partial-effect work unit must be an absolute path or null");
    }
    for (const [name, value] of [
      ["checkpoint source fingerprint", checkpointSourceFingerprint],
      ["current source fingerprint", currentSourceFingerprint],
    ]) {
      if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error(`Task Review partial-effect ${name} is invalid`);
      }
    }
    this.workUnit = workUnit;
    this.checkpointSourceFingerprint = checkpointSourceFingerprint;
    this.currentSourceFingerprint = currentSourceFingerprint;
    Object.freeze(this);
  }
}

/** Failure-only projection; success artifact contracts remain untouched. */
class ReviewExecutionFailureEnvelopeData {
  constructor({ error, executionRoot } = {}) {
    this.failureCode = typeof error?.code === "string" && error.code !== ""
      ? error.code
      : "REVIEW_EXECUTION_FAILED";
    this.retryable = error?.retryable ?? true;
    const evidence = error?.data instanceof TaskReviewPartialEffectEvidence ? error.data : null;
    const root = typeof executionRoot === "string" && path.isAbsolute(executionRoot)
      ? path.resolve(executionRoot)
      : null;
    const relativeWorkUnit = evidence?.workUnit === null || evidence === null || root === null
      ? null
      : path.relative(root, evidence.workUnit).split(path.sep).join("/");
    this.workUnit = relativeWorkUnit !== null
      && relativeWorkUnit !== ""
      && !relativeWorkUnit.startsWith("../")
      && !path.posix.isAbsolute(relativeWorkUnit)
      ? relativeWorkUnit
      : null;
    this.checkpointSourceFingerprint = evidence?.checkpointSourceFingerprint ?? null;
    this.currentSourceFingerprint = evidence?.currentSourceFingerprint ?? null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      failureCode: this.failureCode,
      retryable: this.retryable,
      workUnit: this.workUnit,
      checkpointSourceFingerprint: this.checkpointSourceFingerprint,
      currentSourceFingerprint: this.currentSourceFingerprint,
    };
  }
}

function partialTaskReviewEffectFailure({ message, workUnit = null, checkpoint = null, current = null, cause = null } = {}) {
  const error = new Error(message);
  error.code = "TASK_REVIEW_PARTIAL_EFFECT";
  error.retryable = false;
  error.data = new TaskReviewPartialEffectEvidence({
    workUnit: workUnit?.root ?? null,
    checkpointSourceFingerprint: checkpoint?.snapshot?.fingerprint ?? null,
    currentSourceFingerprint: current?.fingerprint ?? null,
  });
  if (cause !== null) error.cause = cause;
  return error;
}

function reconcileUnsealedTaskReviewSources({ workUnit, state, flowManager, taskId, executionRoot, expectedNodeId }) {
  const lineageSet = new TaskMutationLineageSet({
    runId: state.runId,
    specId: state.specId,
    taskId,
    lineages: flowManager.taskMutationLineages({ specId: state.specId, taskId }),
  });
  let retained;
  const acceptedAttemptIds = new Set();
  if (state.attempt?.nodeId === expectedNodeId && typeof state.attempt.id === "string" && state.attempt.id !== "") {
    acceptedAttemptIds.add(state.attempt.id);
  }
  for (const activity of flowManager.activityLedger(state.specId)) {
    if (activity?.nodeId === expectedNodeId && typeof activity.attemptId === "string" && activity.attemptId !== "") {
      acceptedAttemptIds.add(activity.attemptId);
    }
  }
  try {
    retained = TaskReviewUnsealedWorkUnitSet.recover({
      executionRoot,
      runId: state.runId,
      specId: state.specId,
      taskId,
      nodeId: expectedNodeId,
      acceptedAttemptIds,
    });
  } catch (cause) {
    throw partialTaskReviewEffectFailure({
      message: `unsealed Task Review evidence cannot be identity-verified: ${cause.message}`,
      cause,
    });
  }
  const recoveryRoute = retryEvidenceRouteForNode(state, expectedNodeId);
  const recoveryReceipts = recoveryRoute === null
    ? []
    : readRetryRecoveryReceiptChain(flowManager, state, recoveryRoute);
  const recoveryReceiptPaths = new Set(recoveryReceipts.map((receipt) => path.relative(
    executionRoot,
    path.join(flowManager.specLocation(state.specId).directory, retryReceiptArtifact(receipt).artifact.relativePath),
  ).split(path.sep).join("/")));
  const currentWorkUnitDirectory = path.relative(
    executionRoot,
    workUnit.workUnit.directory,
  ).split(path.sep).join("/");
  const workUnitNamespace = path.posix.dirname(currentWorkUnitDirectory);
  for (const recovered of retained.workUnits) {
    let checkpoint;
    let current;
    try {
      checkpoint = new TaskReviewUnsealedSourceCheckpoint({ workUnit: recovered, lineageSet, executionRoot });
      current = workUnit.captureCurrentTaskSource();
    } catch (cause) {
      throw partialTaskReviewEffectFailure({
        message: `unsealed Task Review evidence cannot be restored: ${cause.message}`,
        workUnit: recovered,
        cause,
      });
    }
    if (checkpoint.differsFrom(current)) {
      throw partialTaskReviewEffectFailure({
        message: "unsealed Task Review work unit has source effects after an interrupted provider call",
        workUnit: recovered,
        checkpoint,
        current,
      });
    }
    try {
      if (checkpoint.observedSourceEffect()) {
        throw partialTaskReviewEffectFailure({
          message: "unsealed Task Review work unit has repository effects after an interrupted provider call",
          workUnit: recovered,
          checkpoint,
          current,
        });
      }
    } catch (cause) {
      if (cause?.code === "TASK_REVIEW_PARTIAL_EFFECT") throw cause;
      const authorizedRecovery = recoveryReceipts.some((receipt) => (
        receipt.previous.attemptId === checkpoint.baseline.attempt.id
        && receipt.previous.attempt === checkpoint.baseline.attempt.sequence
      ));
      const changedPaths = authorizedRecovery ? checkpoint.changedRepositoryPaths() : [];
      const authorizedCommittedAdvance = cause?.code === "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION"
        && changedPaths.length > 0
        && changedPaths.every((entry) => (
          entry === "<HEAD>"
          || entry === "<index>"
          || recoveryReceiptPaths.has(entry)
          || entry === workUnitNamespace
          || entry.startsWith(`${workUnitNamespace}/`)
        ));
      if (authorizedRecovery && authorizedCommittedAdvance) {
        recovered.cleanup();
        continue;
      }
      throw partialTaskReviewEffectFailure({
        message: `unsealed Task Review source-effect baseline cannot be compared: ${cause.message}`,
        workUnit: recovered,
        checkpoint,
        current,
        cause,
      });
    }
    recovered.cleanup();
  }
}

export class RunReviewCommand extends FlowCommand {
  constructor({
    resolveScope = resolveImplReviewScope,
    resolveTreeSha = resolveCurrentReviewTreeSha,
    resolveTargetStateDigest = resolveCurrentReviewRepairFingerprint,
    runCommand = runCmd,
  } = {}) {
    super();
    this.resolveScope = resolveScope;
    this.resolveTreeSha = resolveTreeSha;
    this.resolveTargetStateDigest = resolveTargetStateDigest;
    this.runCommand = runCommand;
  }

  /**
   * Version-1 review execution has a deliberately narrow boundary: the
   * established child command writes only a transient work unit, then this
   * parent returns a Store-attached result.  Registry lifecycle confirmation
   * commits the result history, immutable evidence, Activity, and state in
   * one journaled operation.
   */
  async executeCanonical(ctx, { phase, dryRun, executionRoot, admissionChecked = false }) {
    const persistedPhase = reviewPhaseKeyForCtx(ctx, phase);
    const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
    if (state === null) {
      throw new Error("canonical review requires a loaded Version-1 Flow");
    }
    const currentNodeId = state.current?.at(-1) ?? null;
    const taskId = persistedPhase === IMPL_REVIEW_PHASE
      ? ctx.flowState.currentTaskId ?? null
      : null;
    const expectedNodeId = canonicalReviewNodeId({ phase: persistedPhase, taskId });
    if (currentNodeId !== expectedNodeId) {
      throw new Error(`canonical review requires active ${expectedNodeId}, found ${currentNodeId ?? "none"}`);
    }
    if (state.attempt?.failure !== null && state.attempt?.failure !== undefined) {
      const disposition = state.failureDisposition();
      return Envelope.fail(
        "run",
        "review",
        "REVIEW_RETRY_REQUIRED",
        "the current review Attempt has failed; refresh next-action and follow its definition-owned retry or recovery route",
        {
          phase: persistedPhase,
          operation: disposition?.operation ?? "blocked",
          retryKind: disposition?.retryKind ?? null,
          remaining: disposition?.remaining ?? 0,
          nextActionRequired: true,
          failureDisposition: disposition?.toJSON?.() ?? null,
        },
      );
    }
    const taskReviewExecution = taskId === null
      ? null
      : TaskReviewExecutionIdentity.fromCanonicalState({ state, taskId });
    if (!admissionChecked) {
      const admissionFailure = reviewExecutionAdmission(ctx, { persistedPhase, executionRoot });
      if (admissionFailure !== null) return admissionFailure;
    }
    if (dryRun) {
      return Envelope.fail(
        "run",
        "review",
        "CANONICAL_REVIEW_DRY_RUN_REQUIRES_PREVIEW_BOUNDARY",
        "Version-1 review dry-run does not create a durable Attempt or worker work unit.",
      );
    }

    const treeSha = this.resolveTreeSha(ctx);
    const targetStateDigest = this.resolveTargetStateDigest(ctx, persistedPhase);
    const workUnit = new CanonicalReviewWorkUnit({
      flowManager: ctx.flowManager,
      state,
      phase: persistedPhase,
      taskId,
      executionRoot,
      treeSha,
      targetStateDigest,
    });
    let taskRepairBaseline = null;
    let taskRecoveryBaseline = null;
    const taskReviewAgent = taskId === null || !this.container?.has?.("agent")
      ? null
      : this.container.get("agent");
    let taskRepairBaselineInput = null;
    let taskRecoveryBaselineInput = null;
    let sealedWorkUnit;
    try {
      // Reconstruct the parent-owned input contract before inspecting any
      // worker state. A recovered manifest must match this exact declaration.
      const existing = taskId !== null && fs.existsSync(workUnit.workUnit.manifestPath)
        ? ReviewWorkUnit.fromEnvironment(
          { [REVIEW_WORK_UNIT_MANIFEST_ENV]: workUnit.workUnit.manifestPath },
          { expectedDirectory: workUnit.workUnit.directory },
        )
        : null;
      if (existing !== null) {
        const persistedSource = new TaskReviewPersistedSourceSnapshot({
          workUnit: existing,
          executionRoot,
          lineageSet: new TaskMutationLineageSet({
            runId: state.runId,
            specId: state.specId,
            taskId,
            lineages: ctx.flowManager.taskMutationLineages({ specId: state.specId, taskId }),
          }),
        });
        workUnit.restoreTaskWorkerProjection(persistedSource.snapshot);
        const repairCheckpoint = new TaskReviewPersistedSourceBaseline({
          workUnit: existing,
          executionRoot,
          logicalKey: "task.source-repair-baseline",
        });
        const recoveryCheckpoint = new TaskReviewPersistedSourceBaseline({
          workUnit: existing,
          executionRoot,
          logicalKey: "task.source-effect-baseline",
        });
        taskRepairBaseline = repairCheckpoint.baseline;
        taskRecoveryBaseline = recoveryCheckpoint.baseline;
        taskRepairBaselineInput = taskReviewBaselineInput(repairCheckpoint);
        taskRecoveryBaselineInput = taskReviewBaselineInput(recoveryCheckpoint);
      }
      workUnit.declareCanonicalInputs();
      if (taskId !== null) {
        if (existing === null) {
          taskRepairBaseline = SourceMutationBaseline.capture({
            root: executionRoot,
            attempt: taskReviewExecution.attempt,
            ignoredDirectories: taskReviewRepairIgnoredDirectories(executionRoot, workUnit, taskReviewAgent),
          });
          taskRecoveryBaseline = SourceMutationBaseline.capture({
            root: executionRoot,
            attempt: taskReviewExecution.attempt,
            ignoredDirectories: taskReviewRecoveryIgnoredDirectories(executionRoot, workUnit, taskReviewAgent),
          });
          taskRepairBaselineInput = newTaskReviewBaselineInput({
            logicalKey: "task.source-repair-baseline",
            logicalPath: "task-source-repair-baseline.json",
            baseline: taskRepairBaseline,
          });
          taskRecoveryBaselineInput = newTaskReviewBaselineInput({
            logicalKey: "task.source-effect-baseline",
            logicalPath: "task-source-effect-baseline.json",
            baseline: taskRecoveryBaseline,
          });
        }
        workUnit.workUnit.declareInput(taskRepairBaselineInput);
        workUnit.workUnit.declareInput(taskRecoveryBaselineInput);
        reconcileUnsealedTaskReviewSources({
          workUnit,
          state,
          flowManager: ctx.flowManager,
          taskId,
          executionRoot,
          expectedNodeId,
        });
      }
      sealedWorkUnit = workUnit.workUnit.recoverSealed();
    } catch (error) {
      return this.#canonicalFailure(ctx, persistedPhase, error);
    }
    if (sealedWorkUnit === null) {
      const prepared = workUnit.prepare();
      if (taskId !== null) {
        workUnit.workUnit.writeInput(taskRepairBaselineInput);
        workUnit.workUnit.writeInput(taskRecoveryBaselineInput);
      }
      const specSource = workUnit.materializeSpecRecord();
      const specReviewInput = workUnit.materializeSpecReview();
      const fileMapSource = workUnit.materializeFileMap();
      const draftSource = workUnit.materializeDraft();
      const testSources = workUnit.materializeTestSources(prepared.directory);
      const taskSpec = workUnit.materializeTaskSpec();
      const taskInputs = workUnit.materializeTaskContextAndSource();
      const surface = workUnit.finalize();
      const scriptPath = path.join(PKG_DIR, "flow", "commands", "review.js");
      const args = [];
      if (phase && phase !== IMPL_REVIEW_PHASE) args.push("--phase", phase);
      if (taskSpec !== null) args.push("--task-spec", taskSpec.logicalPath);
      if (ctx.skipConfirm) args.push("--skip-confirm");
      // The worker's Agent owns a provider process tree.  Leave it enough
      // time to terminate that tree before this outer subprocess timeout can
      // kill the worker and release its review-execution lease prematurely.
      const timeoutMs = AgentTimeout.fromConfig(ctx.config?.agent).toOuterProcessMilliseconds();
      const env = {
        ...process.env,
        [PRODUCT.env("REVIEW_OUTPUT_DIR")]: surface.directory,
        [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath,
        [PRODUCT.env("REVIEW_SPEC_SOURCE")]: JSON.stringify(specSource),
        ...(specReviewInput === null ? {} : {
          [PRODUCT.env("REVIEW_SPEC_REVIEW_SOURCE")]: JSON.stringify(specReviewInput.toJSON()),
        }),
        ...(fileMapSource === null ? {} : {
          [PRODUCT.env("REVIEW_FILE_MAP_SOURCE")]: JSON.stringify(fileMapSource),
        }),
        ...(draftSource === null ? {} : {
          [PRODUCT.env("REVIEW_DRAFT_SOURCE")]: JSON.stringify(draftSource),
        }),
        ...(testSources === null ? {} : {
          [PRODUCT.env("REVIEW_TEST_SOURCE_DIR")]: testSources.directory,
          [PRODUCT.env("REVIEW_TEST_ARTIFACT_REVISION")]: JSON.stringify(testSources.revision),
          [PRODUCT.env("REVIEW_TEST_TOPOLOGY")]: JSON.stringify(testSources.topology),
        }),
        ...(taskSpec === null ? {} : {
          [PRODUCT.env("REVIEW_TASK_SPEC_SOURCE")]: JSON.stringify({
            logicalPath: taskSpec.logicalPath,
            sourcePath: taskSpec.sourcePath,
          }),
          [PRODUCT.env("REVIEW_TASK_CONTEXT_SOURCE")]: JSON.stringify(taskInputs.context),
          [PRODUCT.env("REVIEW_TASK_CURRENT_SOURCE")]: JSON.stringify(taskInputs.source),
          [PRODUCT.env("REVIEW_TASK_EXECUTION_IDENTITY")]: JSON.stringify(taskReviewExecution.toJSON()),
        }),
      };

      const canonicalObservationBoundary = taskId === null
        ? null
        : TaskReviewCanonicalObservationBoundary.capture({
            flowManager: ctx.flowManager,
            specId: state.specId,
          });
      let res;
      try {
        res = await runCmdWithRetry(
          () => this.runCommand("node", [scriptPath, ...args], { cwd: executionRoot, timeout: timeoutMs, env }),
          {
            phase: persistedPhase,
            retryCount: 0,
            // Task Review's protocol boundary owns the only safe retry
            // decision because it observes provider source effects.
            retrySchema: taskId === null,
          },
        );
      } catch (error) {
        try {
          canonicalObservationBoundary?.assertMetricSettlementOnly();
        } catch (observationError) {
          return this.#canonicalFailure(ctx, persistedPhase, observationError);
        }
        return this.#canonicalFailure(ctx, persistedPhase, error);
      }
      try {
        canonicalObservationBoundary?.assertMetricSettlementOnly();
      } catch (error) {
        return this.#canonicalFailure(ctx, persistedPhase, error);
      }
      if (!res.ok) {
        const failure = ReviewFailure.fromSubprocessResult({ phase: persistedPhase, result: res });
        const error = new Error(failure.reason || "review subprocess failed");
        error.code = failure.toEnvelopeCode();
        error.retryable = failure.retryable;
        return this.#canonicalFailure(ctx, persistedPhase, error);
      }
      try {
        sealedWorkUnit = ReviewWorkUnit.fromEnvironment(
          { [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath },
          { expectedManifest: surface.manifest, expectedDirectory: surface.directory },
        );
        sealedWorkUnit.readSealedOutput();
      } catch (error) {
        return this.#canonicalFailure(ctx, persistedPhase, error);
      }
    }
    if (taskId !== null && taskRepairBaseline === null) {
      taskRepairBaseline = SourceMutationBaseline.capture({
        root: executionRoot,
        attempt: taskReviewExecution.attempt,
        ignoredDirectories: taskReviewRepairIgnoredDirectories(executionRoot, workUnit, taskReviewAgent),
      });
    }
    let promotion;
    let taskRepair = null;
    let taskMutationLineage = null;
    let resultingTaskLineageSet = null;
    let resultingTaskSource = workUnit.taskSource;
    try {
      promotion = new CanonicalReviewPromotion({
        workUnit: sealedWorkUnit,
        phase: persistedPhase,
        taskId,
        treeSha,
        targetStateDigest,
        specReviewSource: workUnit.specReviewSource,
        taskSource: workUnit.taskSource,
      });
      if (taskId !== null) {
        assertTaskReviewRecurrenceExplanation({
          artifact: promotion.sealedArtifact().artifact,
          flowManager: ctx.flowManager,
          state,
          taskId,
        });
        const lineageSet = new TaskMutationLineageSet({
          runId: state.runId,
          specId: state.specId,
          taskId,
          lineages: ctx.flowManager.taskMutationLineages({ specId: state.specId, taskId }),
        });
        const manifest = SourceMutationManifest.capture({ baseline: taskRepairBaseline });
        taskRepair = new TaskReviewRepairManifest({
          lineageSet,
          baseline: taskRepairBaseline,
          manifest,
          artifact: promotion.sealedArtifact().artifact,
          attemptCount: currentTaskReviewAttemptCount({ attempt: state.attempt, includesCurrentResult: true }),
        });
        taskMutationLineage = taskRepair.lineage({ attempt: state.attempt });
        resultingTaskLineageSet = new TaskMutationLineageSet({
          runId: state.runId,
          specId: state.specId,
          taskId,
          lineages: [...lineageSet.lineages, taskMutationLineage],
        });
        resultingTaskSource = CurrentTaskSourceSnapshot.capture({
          root: executionRoot,
          lineageSet: resultingTaskLineageSet,
        });
      }
    } catch (error) {
      return this.#canonicalFailure(ctx, persistedPhase, error);
    }
    const currentTreeSha = this.resolveTreeSha(ctx);
    const currentTargetStateDigest = this.resolveTargetStateDigest(ctx, persistedPhase);
    const currentTaskSource = resultingTaskLineageSet === null
      ? workUnit.captureCurrentTaskSource()
      : CurrentTaskSourceSnapshot.capture({ root: executionRoot, lineageSet: resultingTaskLineageSet });
    const acceptedTaskRepair = taskRepair !== null && taskRepair.mutationCount > 0;
    const expectedTaskSource = taskId === null ? workUnit.taskSource : resultingTaskSource;
    const staleTaskSource = currentTaskSource !== null
      && currentTaskSource.fingerprint !== expectedTaskSource?.fingerprint;
    if ((!acceptedTaskRepair && currentTreeSha !== treeSha)
      || (!acceptedTaskRepair && currentTargetStateDigest !== targetStateDigest)
      || staleTaskSource) {
      return Envelope.fail(
        "run",
        "review",
        "STALE_REVIEW_TARGET",
        "the review target tree changed before canonical evidence promotion",
        {
          expectedTreeSha: treeSha,
          currentTreeSha,
          expectedTargetStateDigest: targetStateDigest,
          currentTargetStateDigest,
          expectedTaskSourceFingerprint: expectedTaskSource?.fingerprint ?? null,
          currentTaskSourceFingerprint: currentTaskSource?.fingerprint ?? null,
        },
      );
    }

    try {
      promotion = new CanonicalReviewPromotion({
        workUnit: sealedWorkUnit,
        phase: persistedPhase,
        taskId,
        treeSha,
        targetStateDigest,
        specReviewSource: workUnit.specReviewSource,
        taskSource: resultingTaskSource,
        taskMutationLineage,
        reviewRepairComplete: taskRepair?.complete ?? false,
      });
      const result = promotion.resultFromSealedArtifact();
      promotion.promote(result);
      return result;
    } catch (error) {
      return this.#canonicalFailure(ctx, persistedPhase, error);
    }
  }

  #canonicalFailure(ctx, phase, error) {
    const message = String(error?.message || error);
    const failureData = new ReviewExecutionFailureEnvelopeData({
      error,
      executionRoot: ctx.executionRoot || ctx.root,
    });
    try {
      ctx.flowManager.failCurrentAttempt({
        specId: ctx.specId ?? ctx.flowState.specId,
        failure: {
          category: "tooling",
          code: error?.code || "REVIEW_EXECUTION_FAILED",
          message,
          retryable: error?.retryable ?? true,
          retryKind: "tooling",
        },
        result: {
          outcome: "failed",
          summary: message,
          confirmedAt: new Date().toISOString(),
          artifactRefs: [],
        },
      });
    } catch (failureError) {
      return Envelope.fail(
        "run",
        "review",
        "REVIEW_FAILURE_RECORDING_FAILED",
        `${message}; unable to record the canonical Attempt failure: ${failureError.message}`,
      );
    }
    return Envelope.fail(
      "run",
      "review",
      "REVIEW_TOOLING_ERROR",
      `review tooling error for ${phase}: ${message}`,
      failureData.toJSON(),
    );
  }

  async execute(ctx) {
    const { root } = ctx;
    const executionRoot = ctx.executionRoot || root;
    const phase = ctx.phase || null;
    const dryRun = ctx.dryRun === true;

    if (phase && !VALID_REVIEW_PHASES.includes(phase)) {
      // spec 253 R8: return Envelope.fail with UNKNOWN_REVIEW_PHASE for unknown
      // CLI phase values (uniform fail-closed contract — no throw, no max-attempts
      // bypass via unknown phase).
      return Envelope.fail("run", "review", "UNKNOWN_REVIEW_PHASE",
        [`invalid phase: ${phase} (valid: ${VALID_REVIEW_PHASES.join(", ")})`],
        { phase });
    }

    if (!isCanonicalFlowState(ctx.flowState)) {
      return Envelope.fail(
        "run",
        "review",
        "CANONICAL_REVIEW_REQUIRED",
        "review execution requires a Version-1 Flow Activity and catalog authority.",
      );
    }
    const persistedPhase = reviewPhaseKeyForCtx(ctx, phase);
    const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
    const taskId = persistedPhase === IMPL_REVIEW_PHASE ? ctx.flowState.currentTaskId ?? null : null;
    const expectedNodeId = canonicalReviewNodeId({ phase: persistedPhase, taskId });
    if (state?.current?.at(-1) !== expectedNodeId || state.attempt === null) {
      // executeCanonical returns the detailed canonical target error and
      // remains the single state-validation path.
      return this.executeCanonical(ctx, { phase, dryRun, executionRoot });
    }
    if (state.attempt.failure !== null) {
      return this.executeCanonical(ctx, { phase, dryRun, executionRoot });
    }
    const admissionFailure = reviewExecutionAdmission(ctx, { persistedPhase, executionRoot });
    if (admissionFailure !== null) return admissionFailure;
    const lease = new ReviewExecutionLease({
      mainRoot: ctx.mainRoot || executionRoot,
      runId: state.runId,
      nodeId: expectedNodeId,
      attemptId: state.attempt.id,
    });
    try {
      lease.acquire();
    } catch (error) {
      return Envelope.fail(
        "run",
        "review",
        error.code || "REVIEW_EXECUTION_LOCK_FAILED",
        error.message,
      );
    }
    try {
      return await this.executeCanonical(ctx, { phase, dryRun, executionRoot, admissionChecked: true });
    } finally {
      lease.release();
    }

  }
}

export default RunReviewCommand;
