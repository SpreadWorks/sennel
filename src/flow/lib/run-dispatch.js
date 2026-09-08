/**
 * Agent-independent Flow continuation dispatcher.
 *
 * The CLI cannot observe an interactive agent host emitting its final
 * response.  Instead of depending on a host lifecycle callback, this command
 * owns the non-terminal portion of the Flow: it asks for the guarded next
 * action, delegates one action to the configured provider-neutral Agent
 * service, verifies durable progress, and repeats until the Flow reaches a
 * user or terminal boundary.
 */

import fs from "node:fs";
import path from "node:path";
import { loadSpecJsonSchema } from "../../lib/spec-json.js";
import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { AgentFailure } from "../../lib/agent-failure.js";
import {
  AgentTimeout,
  AgentTimeoutDiagnostic,
  TestReviewRepairWorkerMonitor,
  TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS,
} from "../../lib/agent-timeout.js";
import { DeferredAgentInvocationMetric } from "../../lib/agent-invocation-metric.js";
import { flowCommands } from "../../lib/command-registry.js";
import { dispatch } from "../../lib/dispatcher.js";
import { FlowHandoffAuthorityLease } from "../../lib/flow-handoff-authority-lease.js";
import {
  ProcessOwnedLock,
  RealDirectoryAuthority,
} from "../../lib/process-owned-lock.js";
import {
  AbortedDirective,
  AwaitDraftQuestionDirective,
  AwaitUserDecisionDirective,
  BlockedDirective,
  CompletedDirective,
  ExecuteCommandDirective,
  ExecuteStepDirective,
  IdleDirective,
  NextActionDirective,
  RepairEvidenceDirective,
} from "./next-action-directive.js";
import { finalRegressionWorktreeFingerprint } from "./test-artifacts.js";
import GetNextActionCommand from "./get-next-action.js";
import { PRODUCT } from "../../lib/product.js";
import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  WorkerArtifactRetryExhaustedError,
  WorkerArtifactMutationAuthoritySnapshot,
  WorkerArtifactHandoffRequest,
  SpecTestBootstrapObservationAuthority,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
  workerArtifactHandoffPolicy,
} from "./worker-artifact-handoff.js";
import { TaskSourceFailureObservation } from "./task-source-failure.js";
import { sourceWorkerEffectJsonSchema } from "./source-worker-effect-schema.js";
import {
  AutoApprovedFlowDispatchAuthorization,
  ExplicitFlowDispatchAuthorization,
  FlowDispatchInvocation,
  FlowDispatchSession,
  FlowDispatchTarget,
  UnapprovedFlowDispatchAuthorization,
  flowDispatchDigest,
} from "./dispatch-invocation.js";
import { buildFlowCommandHookContext } from "./flow-context.js";
import { ConfirmAndAdvance, resolveDefinitionRoute, resolveDispatcherOwnedFlowAction } from "../definition.js";
import { CanonicalSpecApproval } from "./canonical-spec-approval.js";
import { reconcileCompletedReviewWorkUnits } from "./review-work-unit.js";
import { approvalRouteFacts } from "./definition-route-facts.js";
import {
  specRepairDeltaPayloadSchema,
  specTriageDeltaPayloadSchema,
} from "./spec-review-artifacts.js";
import { TestReviewRepairWorkerTimeout } from "./test-review-repair-timeout.js";

const DEFAULT_MAX_DISPATCHES = 256;
const DEFAULT_MAX_STALLED_DISPATCHES = 3;
const DISPATCH_LOCK_KIND = "flow-dispatch";
const RESUMABLE_DISPATCH_BOUNDARIES = new Set([
  "approval_required",
  "auto_upgrade_decision",
  "await_user_decision",
  "blocked",
]);
const DISPATCHER_OWNED_REPAIR_COMMANDS = new Set([
  "repair-plan-gate",
  "repair-test-review",
]);
const DISPATCHER_OWNED_RECOVERY_COMMANDS = new Set([
  "claim-next-action",
  "recover-finalization",
  "recover-missing-producer-artifact",
  "recover-task-execution-overrun",
  "settle-gate-transition",
  "settle-review-transition",
  "gate",
]);
const NON_REPLAYABLE_HANDOFF_ERROR_CODES = new Set([
  "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION",
  "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION",
  "FLOW_SOURCE_HANDOFF_CANONICAL_PATH_VIOLATION",
]);

function isTestReviewRepairWorker(request) {
  return request?.stepId === "test" && request.testReviewRepair !== null;
}

function testReviewRepairWorkerMonitor(request, agentConfig, factory) {
  if (!isTestReviewRepairWorker(request)) return null;
  return factory({
    handoffDirectory: request.directory,
    inactivityTimeoutMs: AgentTimeout.fromConfig(agentConfig).toMilliseconds(),
    maximumLifetimeMs: TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS * 1000,
  });
}

function hasPendingTestReviewRepairTimeout(state) {
  return (state?.currentNodeId ?? state?.current?.at(-1)) === "test"
    && TestReviewRepairWorkerTimeout.isFailureCode(state?.attempt?.failure?.code);
}

function safelyDiscardableRepairTimeout(error) {
  return error instanceof WorkerArtifactHandoffError
    && error.recoveryPossible === false
    && new Set(["missing", "invalid"]).has(error.classification);
}
/**
 * Definition-backed command invocation owned by the dispatcher.  This keeps
 * command selection as typed definition data, rather than asking a sandboxed
 * worker to re-parse and execute an instruction string against the canonical
 * Version Store.
 */
export class DispatcherOwnedFlowCommand {
  constructor(nextAction) {
    if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)) {
      throw new Error("dispatcher-owned command requires a next-action object");
    }
    const scope = nextAction.taskId == null ? "flow" : "task";
    const definition = resolveDispatcherOwnedFlowAction({ scope, stepId: nextAction.step });
    if (definition === null) {
      throw new Error(`no dispatcher-owned command is declared for ${scope}.${nextAction.step}`);
    }
    if (nextAction.action !== definition.action) {
      throw new Error(`dispatcher-owned command action mismatch for ${scope}.${nextAction.step}`);
    }
    this.command = definition.executionCommand;
    this.commandName = this.command.subcommand;
    Object.freeze(this);
  }

  static forAction(action) {
    if (!(action?.directive instanceof ExecuteStepDirective)) return null;
    const scope = action.nextAction.taskId == null ? "flow" : "task";
    return resolveDispatcherOwnedFlowAction({ scope, stepId: action.nextAction.step }) === null
      ? null
      : new DispatcherOwnedFlowCommand(action.nextAction);
  }

  argv(target, agentWorkDir = null) {
    return [
      ...this.command.runArguments().slice(1),
      ...(agentWorkDir ? ["--agent-work-dir", agentWorkDir] : []),
      ...targetGuardArguments(target),
    ];
  }

  get removesExecutionRoot() {
    return this.commandName === "finalize-cleanup";
  }
}

function targetGuardArguments(target) {
  const input = target.guardInput();
  const args = [];
  if (input.expectBinding) return ["--expect-binding", input.expectBinding];
  if (input.expectRunId) args.push("--expect-run-id", input.expectRunId);
  if (input.expectSpec) args.push("--expect-spec", input.expectSpec);
  if (input.expectIssue != null) args.push("--expect-issue", String(input.expectIssue));
  if (input.expectNoIssue === true) args.push("--expect-no-issue");
  return args;
}

function commandEnvelope(output, commandName, exitCode) {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch (cause) {
    const error = new Error(`dispatcher-owned command ${commandName} did not emit a JSON envelope`, { cause });
    error.code = "FLOW_DISPATCH_COMMAND_ENVELOPE_INVALID";
    throw error;
  }
  if (exitCode !== 0 && envelope?.ok !== false) {
    const error = new Error(`dispatcher-owned command ${commandName} exited with status ${exitCode}`);
    error.code = envelope?.errors?.find((entry) => typeof entry?.code === "string")?.code
      || "FLOW_DISPATCH_COMMAND_FAILED";
    throw error;
  }
  return envelope;
}

function commandFailed(result) {
  return (result instanceof Envelope && result.ok === false)
    || (result?.ok === false);
}

function finalizeCleanupCompletion(result) {
  if (result?.data?.status !== "done" || result?.data?.assurance == null) {
    const error = new Error("finalize cleanup did not return its canonical completion assurance");
    error.code = "FLOW_DISPATCH_FINALIZE_CLEANUP_UNCONFIRMED";
    throw error;
  }
}

function workerArtifactAgentOptions(stepId, outputSchema) {
  if (workerArtifactHandoffPolicy(stepId)?.kind === "source") {
    const sourceSchema = sourceWorkerEffectJsonSchema(stepId);
    if (JSON.stringify(outputSchema) !== JSON.stringify(sourceSchema)) {
      throw new Error(`guarded source worker output schema is not the canonical effect schema: ${stepId}`);
    }
    // Schema-capable providers receive this directly through their native
    // structured-output flag. No prompt copy is permitted: the parent uses
    // the same schema again before materializing its owned effects.json.
    return { jsonSchema: sourceSchema };
  }
  let payloadName;
  let schema;
  let label;
  if (stepId === "spec") {
    payloadName = "spec.json";
    schema = loadSpecJsonSchema();
    label = "Spec artifact";
  } else if (stepId === "spec-triage") {
    payloadName = "review.delta.json";
    schema = specTriageDeltaPayloadSchema();
    label = "Spec triage review delta";
  } else if (stepId === "spec-repair") {
    payloadName = "review.delta.json";
    schema = specRepairDeltaPayloadSchema();
    label = "Spec repair review delta";
  } else {
    return {};
  }
  const schemaGuidance = [
    `The handoff file named ${payloadName} is the canonical ${label.toLowerCase()} payload.`,
    "Write valid JSON that matches this schema exactly; do not add properties outside the schema.",
    "The CLI validates the payload before it can be sealed or published.",
    `${label} schema:`,
    JSON.stringify(schema, null, 2),
  ].join("\n");
  return {
    // The provider response is still the sealed-handoff report. The complete
    // payload schema is prompt guidance for the file the worker must write.
    jsonSchema: outputSchema,
    fmtFallback: schemaGuidance,
    promptGuidance: schemaGuidance,
  };
}

function freshWorkerInvocation(invocation, nextAction) {
  const session = new FlowDispatchSession({ target: invocation.target });
  const action = session.captureAction(
    workerFacingNextAction(nextAction),
    invocation.action.repositoryFingerprint,
  );
  if (action.digest !== invocation.action.digest) {
    throw new Error("fresh worker handoff action changed before retry");
  }
  let authorization = invocation.authorization;
  if (authorization instanceof ExplicitFlowDispatchAuthorization) {
    authorization = new ExplicitFlowDispatchAuthorization({
      action,
      runId: invocation.target.runId,
      approvalToken: action.approvalToken(),
      approvedAt: authorization.approvedAt,
    });
  } else if (authorization instanceof AutoApprovedFlowDispatchAuthorization) {
    authorization = new AutoApprovedFlowDispatchAuthorization({
      action,
      choiceId: authorization.choiceId,
    });
  } else {
    authorization = new UnapprovedFlowDispatchAuthorization(action);
  }
  return new FlowDispatchInvocation({ session, action, authorization });
}

/**
 * Non-authoritative feedback for the one fresh retry of a rejected
 * handoff. It intentionally contains no Action, approval, or state data: the
 * retried worker keeps the same guarded action and only receives the parent
 * validator's exact correction signal.
 */
export class WorkerArtifactRetryFeedback {
  constructor(error, { remainingCalls = null } = {}) {
    if (!(error instanceof WorkerArtifactHandoffError) || error.retryable !== true) {
      throw new Error("worker artifact retry feedback requires a retryable handoff error");
    }
    this.code = error.code;
    this.classification = error.classification;
    this.message = error.message;
    this.bootstrapObservationAuthority = SpecTestBootstrapObservationAuthority.fromRetryable(error);
    this.remainingCalls = remainingCalls;
    Object.freeze(this);
  }

  toJSON() {
    return {
      code: this.code,
      classification: this.classification,
      message: this.message,
      ...(this.remainingCalls !== null ? { remainingCalls: this.remainingCalls } : {}),
    };
  }
}

/** Parent-owned cumulative correction evidence; never read from worker JSON. */
function errorMessages(envelope) {
  return (envelope?.errors || [])
    .flatMap((entry) => entry?.messages || [])
    .map(String);
}

function errorCode(envelope) {
  return envelope?.errors?.find((entry) => entry?.level === "fatal")?.code
    || envelope?.errors?.[0]?.code
    || "FLOW_DISPATCH_NEXT_ACTION_FAILED";
}

function targetGuardInput(target) {
  return {
    ...target.guardInput(),
    _envelopeType: "get",
    _envelopeKey: "next-action",
  };
}

async function flushDeferredMetrics(metrics) {
  for (const metric of metrics) await metric.flush();
}

function discardDeferredMetrics(metrics) {
  for (const metric of metrics) metric.discard();
}

function readFlowState(ctx) {
  try {
    return ctx.flowManager.loadReadOnly(ctx.specId);
  } catch (error) {
    if (error?.code === "ERR_MISSING_FILE" || error?.message === "no active flow (flow.json not found)") {
      return null;
    }
    throw error;
  }
}

function optionalApprovalReceiptLocation(ctx) {
  const specId = ctx.specId ?? ctx.flowState?.specId;
  const location = ctx.specLocation ?? ctx.flowManager?.specLocation?.(specId);
  if (!location?.relativeFlowStateFile || !location?.relativeActivitiesFile || !location?.relativeCatalogFile) {
    return null;
  }
  return location;
}

function approvalReceiptLocation(ctx) {
  const location = optionalApprovalReceiptLocation(ctx);
  if (location === null) {
    throw new Error("flow dispatch approval receipt requires a canonical Version location");
  }
  return location;
}

function receiptControlPaths(location) {
  return Object.freeze([
    location.relativeFlowStateFile,
    location.relativeActivitiesFile,
    location.relativeCatalogFile,
  ]);
}

function receiptControlPathspecExcludes(location) {
  return receiptControlPaths(location).map((relativePath) => `:(exclude,top,literal)${relativePath}`);
}

function runtimeViewPathspecExcludes(location) {
  return [`:(exclude,top,glob)${location.relativeDirectory}/.runtime/views/**`];
}

/**
 * Canonical Flow control records and ephemeral artifact views are owned by
 * the dispatcher/reader rather than product work. Their exact Version paths
 * are normalized in both direct and worktree execution because a
 * FlowVersionLocation is repository-relative in either mode. Keeping this
 * list narrow deliberately leaves spec.record, source, tests, and every
 * other cataloged artifact in the approval fingerprint.
 */
function dispatchFingerprintPathspecExcludes(ctx) {
  const location = optionalApprovalReceiptLocation(ctx);
  return [
    ...(location === null
      ? []
      : [...receiptControlPathspecExcludes(location), ...runtimeViewPathspecExcludes(location)]),
    ...(ctx.dispatchFingerprintPathspecExcludes ?? []),
  ];
}

function receiptControlBytes(location) {
  const files = [
    [location.relativeFlowStateFile, location.flowStateFile],
    [location.relativeActivitiesFile, location.activitiesFile],
    [location.relativeCatalogFile, location.catalogFile],
  ];
  return Object.freeze(files.map(([relativePath, absolutePath]) => ({
    relativePath,
    bytes: fs.readFileSync(absolutePath).toString("base64"),
  })));
}

function sameReceiptControlBytes(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDispatchActionMeaning(left, right) {
  return left.target.digest === right.target.digest
    && JSON.stringify(left.nextAction) === JSON.stringify(right.nextAction);
}

class DispatchApprovalReceiptMutationError extends Error {
  constructor({ invocation, activeAction, message }) {
    super(message);
    this.name = "DispatchApprovalReceiptMutationError";
    this.code = "FLOW_DISPATCH_AUTHORIZATION_STALE";
    this.data = Object.freeze({
      expectedActionDigest: invocation.action.digest,
      activeActionDigest: activeAction.digest,
      authorization: invocation.authorization.toJSON(),
    });
  }
}

/**
 * The explicit approval record is the one dispatcher-owned mutation permitted
 * between token validation and worker handoff.  This value object freezes its
 * exact Version bytes and independently fingerprints every other repository
 * path, so no user or worker edit can be mistaken for the receipt write.
 */
class DispatchApprovalReceiptMutation {
  constructor({ location, invocation, controlBytes, outsideFingerprint }) {
    this.location = location;
    this.invocation = invocation;
    this.controlBytes = controlBytes;
    this.outsideFingerprint = outsideFingerprint;
    Object.freeze(this);
  }

  static record({ ctx, invocation, fingerprint, record }) {
    const location = approvalReceiptLocation(ctx);
    const fingerprintOutsideReceipt = () => fingerprint({
      ...ctx,
      dispatchFingerprintPathspecExcludes: receiptControlPathspecExcludes(location),
    });
    const before = receiptControlBytes(location);
    const outsideFingerprint = fingerprintOutsideReceipt();
    record();
    const after = receiptControlBytes(location);
    if (sameReceiptControlBytes(before, after)) {
      throw new Error("flow dispatch approval receipt did not persist its canonical Version mutation");
    }
    if (fingerprintOutsideReceipt() !== outsideFingerprint) {
      throw new Error("flow dispatch approval receipt changed repository content outside its control files");
    }
    const state = readFlowState(ctx);
    const persisted = ExplicitFlowDispatchAuthorization.matching(state, invocation.action);
    if (persisted == null || persisted.approvalToken !== invocation.authorization.approvalToken) {
      throw new Error("flow dispatch approval receipt was not durably recorded for the validated action");
    }
    return new DispatchApprovalReceiptMutation({
      location,
      invocation,
      controlBytes: after,
      outsideFingerprint,
    });
  }

  assertCurrent({ ctx, fingerprint, activeAction, flowState }) {
    const currentOutsideFingerprint = fingerprint({
      ...ctx,
      dispatchFingerprintPathspecExcludes: receiptControlPathspecExcludes(this.location),
    });
    if (currentOutsideFingerprint !== this.outsideFingerprint) {
      throw new DispatchApprovalReceiptMutationError({
        invocation: this.invocation,
        activeAction,
        message: "repository content changed outside the dispatcher-owned approval receipt before worker handoff",
      });
    }
    if (!sameReceiptControlBytes(receiptControlBytes(this.location), this.controlBytes)) {
      throw new DispatchApprovalReceiptMutationError({
        invocation: this.invocation,
        activeAction,
        message: "the dispatcher-owned approval receipt changed before worker handoff",
      });
    }
    if (!sameDispatchActionMeaning(this.invocation.action, activeAction)) {
      throw new DispatchApprovalReceiptMutationError({
        invocation: this.invocation,
        activeAction,
        message: "the approved Flow target or semantic action changed before worker handoff",
      });
    }
    if (
      !this.invocation.authorization.matches(this.invocation.action)
      || !this.invocation.authorization.isGrantedBy(flowState)
    ) {
      throw new DispatchApprovalReceiptMutationError({
        invocation: this.invocation,
        activeAction,
        message: "the dispatcher-owned approval receipt no longer grants the validated action",
      });
    }
  }
}

export function dispatchRepositoryFingerprint(ctx) {
  return finalRegressionWorktreeFingerprint(ctx.executionRoot || ctx.root, {
    pathspecExcludes: dispatchFingerprintPathspecExcludes(ctx),
  });
}

function dispatchLockError(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "FlowDispatchLockError";
  error.code = status === "live"
    ? "FLOW_DISPATCH_BUSY"
    : `FLOW_DISPATCH_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockPath = lockPath;
  return error;
}

export class FlowDispatchLease {
  constructor(session) {
    if (!(session instanceof FlowDispatchSession)) {
      throw new Error("FlowDispatchLease requires a FlowDispatchSession");
    }
    this.session = session;
    const { target } = session;
    const mainRoot = target.dispatchLockRoot;
    if (!mainRoot) {
      throw new Error("FlowDispatchLease target requires captured authority");
    }
    const { runId } = target;
    const root = new RealDirectoryAuthority(mainRoot, {
      errorFactory: dispatchLockError,
    });
    const directory = new RealDirectoryAuthority(path.join(mainRoot, PRODUCT.managedDirName), {
      create: true,
      parentAuthority: root,
      errorFactory: dispatchLockError,
    });
    this.lock = new ProcessOwnedLock({
      directoryAuthority: directory,
      fileName: `.flow-dispatch-${flowDispatchDigest(runId).slice(0, 24)}.lock`,
      kind: DISPATCH_LOCK_KIND,
      authority: {
        runId,
        targetDigest: target.digest,
      },
      errorFactory: dispatchLockError,
    });
  }

  acquire() {
    // ProcessOwnedLock only reclaims locks when the recorded dispatcher
    // identity is conclusively stale. Live and indeterminate owners remain
    // exclusive, while a crashed dispatcher cannot block the Flow forever.
    return this.lock.acquire({ claimStale: true });
  }

  release() {
    this.lock.release();
  }
}

function persistDispatchApproval(ctx, invocation, fingerprint) {
  if (
    !(invocation instanceof FlowDispatchInvocation)
    || !(invocation.authorization instanceof ExplicitFlowDispatchAuthorization)
  ) {
    throw new Error("flow dispatch approval persistence requires an explicitly authorized invocation");
  }
  const { action, authorization } = invocation;
  const state = readFlowState(ctx);
  const existing = ExplicitFlowDispatchAuthorization.matching(state, action);
  if (existing) return { authorization: existing, receiptMutation: null };
  if (state?.schemaRevision !== 3 || typeof ctx.flowManager?.recordDispatchApproval !== "function") {
    throw new Error("flow dispatch approval requires the canonical Version Store receipt API");
  }
  if (state.runId !== action.target.runId) {
    throw new Error("flow dispatch approval target changed before persistence");
  }
  const receiptMutation = DispatchApprovalReceiptMutation.record({
    ctx,
    invocation,
    fingerprint,
    record: () => ctx.flowManager.recordDispatchApproval({
      specId: state.specId,
      receipt: authorization.toReceiptJSON(),
    }),
  });
  return { authorization, receiptMutation };
}

export class FlowDispatchRepositoryFingerprintError extends Error {
  constructor({ cause, nextAction, dispatchCount, phase }) {
    if (!["action-capture", "pre-handoff-validation", "post-handoff-progress"].includes(phase)) {
      throw new Error(`invalid Flow dispatch repository fingerprint phase: ${phase}`);
    }
    super(`failed to capture the Flow dispatch repository fingerprint: ${cause?.message || cause}`, {
      cause,
    });
    this.name = "FlowDispatchRepositoryFingerprintError";
    this.code = "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED";
    this.nextAction = nextAction;
    this.dispatchCount = dispatchCount;
    this.phase = phase;
  }
}

export class FlowDispatchAction {
  constructor(nextAction) {
    if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)) {
      throw new Error("Flow dispatch requires a next-action object");
    }
    this.nextAction = nextAction;
    this.directive = NextActionDirective.fromStored(nextAction.directive);
    Object.freeze(this);
  }

  get requiresApproval() {
    return this.nextAction.requires_approval === true;
  }

  get autoApproveChoiceId() {
    return this.nextAction.auto_approval_choice_id ?? null;
  }

  get isAutoApproveEligible() {
    return this.requiresApproval && this.autoApproveChoiceId === "1";
  }

  get isContinuation() {
    return this.directive instanceof ExecuteStepDirective
      || this.directive instanceof ExecuteCommandDirective
      || this.directive instanceof RepairEvidenceDirective;
  }

  get isTerminal() {
    return this.directive instanceof BlockedDirective
      || this.directive instanceof CompletedDirective
      || this.directive instanceof AbortedDirective
      || this.directive instanceof IdleDirective;
  }

  get awaitsUserDecision() {
    return this.directive instanceof AwaitUserDecisionDirective
      || this.directive instanceof AwaitDraftQuestionDirective;
  }
}

export class FlowDispatchBoundary {
  constructor({ kind, nextAction, dispatchCount, target = null, approvalToken = null, message = null }) {
    if (target != null && !(target instanceof FlowDispatchTarget)) {
      throw new Error("FlowDispatchBoundary target must be a FlowDispatchTarget");
    }
    this.kind = kind;
    this.nextAction = nextAction;
    this.dispatchCount = dispatchCount;
    this.binding = RESUMABLE_DISPATCH_BOUNDARIES.has(kind) ? target?.bindingToken ?? null : null;
    this.approvalToken = approvalToken;
    this.message = message;
    Object.freeze(this);
  }

  toJSON() {
    return {
      dispatch: {
        boundary: this.kind,
        dispatchCount: this.dispatchCount,
        ...(this.binding && { binding: this.binding }),
        ...(this.approvalToken && { approvalToken: this.approvalToken }),
        ...(this.message && { message: this.message }),
      },
      nextAction: this.nextAction,
    };
  }
}

/**
 * A user-action prompt belongs to the dispatcher boundary, not to the worker
 * that runs after the selected approval has been durably authorized. The
 * boundary retains the prompt, while worker serialization and dispatch
 * identity both use the pre-prompt continuation contract.
 */
export function workerFacingNextAction(nextAction) {
  const directive = NextActionDirective.fromStored(nextAction.directive);
  if (
    nextAction.requires_approval !== true
    || !(directive instanceof ExecuteStepDirective)
    || directive.prompt == null
  ) {
    return nextAction;
  }
  return {
    ...nextAction,
    directive: new ExecuteStepDirective({
      action: directive.action,
      ...(directive.nextAction != null && { nextAction: directive.nextAction }),
    }).toJSON(),
  };
}

export class FlowDispatchWork {
  constructor(invocation, handoffRequest = null, retryFeedback = null) {
    if (!(invocation instanceof FlowDispatchInvocation)) {
      throw new Error("FlowDispatchWork requires a FlowDispatchInvocation");
    }
    if (handoffRequest != null && !(handoffRequest instanceof WorkerArtifactHandoffRequest)) {
      throw new Error("FlowDispatchWork handoff requires a WorkerArtifactHandoffRequest");
    }
    if (retryFeedback != null && !(retryFeedback instanceof WorkerArtifactRetryFeedback)) {
      throw new Error("FlowDispatchWork retry feedback requires a WorkerArtifactRetryFeedback");
    }
    this.invocation = invocation;
    this.handoffRequest = handoffRequest;
    this.retryFeedback = retryFeedback;
    Object.freeze(this);
  }

  executionEnvironment() {
    return {
      ...this.invocation.executionEnvironment(),
      ...(this.handoffRequest?.executionEnvironment() || {}),
    };
  }

  prompt(promptGuidance = "") {
    const { action, authorization, target } = this.invocation;
    const nextAction = workerFacingNextAction(action.nextAction);
    const authorizationInstruction = authorization.workerInstruction();
    const handoffContract = this.handoffRequest?.toWorkerJSON() ?? null;
    const nonblockingRule = nextAction.nonblockingDecision
      ? [
          "",
          "A nonblockingDecision is present. Resolve and record exactly that",
          "digest-guarded decision before the ordinary directive, then let the",
          "parent dispatcher refresh authority. Do not ask the user.",
        ].join("\n")
      : "";
    const handoffInstruction = this.handoffRequest
      ? this.handoffRequest.policy.kind === "source"
        ? [
          "",
          "This action uses the source-worker handoff contract below.",
          "Treat its input snapshots as the immutable source for this action.",
          this.handoffRequest.policy.sourceMutation.mode === "forbidden"
            ? "Read the supplied source without editing any project files."
            : this.handoffRequest.policy.preservesRejectedSource
              ? "Edit only paths in this Task action's supplied source allow-list and only for its confirmed apply findings."
              : "Edit only project source and formal project tests that this action requires.",
          "Follow the guarded action's source-worker requirement-to-path claim contract exactly.",
          "Do not write effects.json, do not write a handoff submission, and do not run a seal command.",
          "Return only the structured source effect required by the guarded action output_schema.",
          "The parent dispatcher validates, materializes, seals, publishes, and completes the step.",
          "",
          "Source-worker handoff contract:",
          JSON.stringify(handoffContract, null, 2),
        ].join("\n")
        : [
          "",
          "This action uses the worker artifact handoff contract below.",
          "Treat its input snapshots as the immutable source for this action.",
          "Write every declared payload only to its exact payloadPath. Existing",
          "instructions naming canonical artifact paths are overridden for outputs.",
          "Do not mark the Flow step done. After writing all payloads, run the exact",
          "sealCommand once. The parent dispatcher alone validates, publishes, records",
          "revisions, and completes the step under canonical repository authority.",
          "Return the successful seal command data object as the worker report; it must",
          "match the guarded action output_schema but is never a completion signal.",
          "",
          "Worker artifact handoff contract:",
          JSON.stringify(handoffContract, null, 2),
        ].join("\n")
      : "";
    const retryInstruction = this.retryFeedback
      ? [
          "",
          "Fresh worker handoff retry feedback (non-authoritative):",
          "The parent dispatcher rejected the previous sealed payload before publication.",
          "Correct this exact validation failure in a new payload. This feedback does not",
          "change the guarded action, approval, input revision, or Flow state.",
          JSON.stringify(this.retryFeedback.toJSON(), null, 2),
        ].join("\n")
      : "";
    const specTestTopologyInstruction = handoffContract?.specTestTopology
      ? [
          "",
          "Spec-test topology:",
          "The logical `tests` payload is published below the canonical test root shown",
          "in the handoff contract; it is not a repository-root test directory.",
          "Resolve every static relative import from each final canonical test file, not",
          "from the transient payload directory or an assumed ordinary `tests/` layout.",
          "Use a caught dynamic import for a module that implementation must create later.",
      ].join("\n")
      : "";
    const sourceHandoff = this.handoffRequest?.policy?.kind === "source";
    const schemaPayload = handoffContract?.payloads?.some(({ logicalName }) => logicalName === "review.delta.json")
      ? "review.delta.json"
      : "spec.json";
    const schemaLabel = nextAction.step === "spec-repair"
      ? "spec-repair review delta"
      : nextAction.step === "spec-triage"
        ? "spec-triage review delta"
        : "spec artifact";
    const schemaInstruction = promptGuidance
      ? [
          "",
          "The provider may receive a separate response schema for this worker report.",
          `Use the following canonical ${schemaLabel} guidance when writing ${schemaPayload}:`,
          promptGuidance,
        ].join("\n")
      : "";
    return [
      "You are a worker owned by the sennel Flow CLI dispatcher.",
      "Execute exactly one supplied non-terminal Flow action in the current repository.",
      "Do not invoke a sennel.flow skill and do not run `sennel flow run dispatch`.",
      "Do not merely describe the work. Perform the edits and commands required by",
      sourceHandoff
        ? "the action, but do not perform a durable Flow transition: the sealed source handoff is the only completion input."
        : "the action, including its durable Flow transition or guarded refresh.",
      "Run every command in the foreground and wait for it to finish. Never start",
      "a review, gate, test, or other Flow command in parallel or in the background.",
      "Never choose a user decision. If a genuine user decision appears unexpectedly,",
      "leave it unchanged and report that fact.",
      ...(authorizationInstruction ? [
        authorizationInstruction,
        "This is an already-selected authorization, not permission to infer another choice.",
      ] : []),
      ...(target.binding ? [
        "Target-sensitive sennel commands inherit the CLI-captured Flow binding.",
        "Do not construct or append target identity arguments.",
      ] : []),
      "When the directive includes nextAction, execute that exact CLI-generated",
      "command; do not infer completion from pre-existing artifacts.",
      nonblockingRule,
      schemaInstruction,
      "",
      "Machine-readable dispatch invocation contract:",
      JSON.stringify(this.invocation.toJSON(), null, 2),
      "",
      "Guarded next action:",
      JSON.stringify(nextAction, null, 2),
      "",
      "Your response is only a worker report. The CLI ignores it as a completion",
      "signal and independently verifies the refreshed Flow and repository state.",
      handoffInstruction,
      specTestTopologyInstruction,
      retryInstruction,
    ].join("\n");
  }
}

function workerHandoffFailureData(ctx, target, error, request, dispatchCount, agentError = null) {
  const state = readFlowState(ctx);
  const stepId = request?.stepId || error.data?.stepId || state?.currentStep || "flow-dispatch";
  const actionDigest = request?.actionDigest || error.data?.actionDigest || null;
  const dispatchInvocationId = request?.dispatchInvocationId || error.data?.dispatchInvocationId || null;
  let issueLogError = null;
  // A recovery-required handoff must leave the canonical Version byte-for-byte
  // untouched so replay can inspect and recover the publication journal. The
  // diagnostic issue-log append is itself a Flow Activity/catalog mutation;
  // defer it until a non-recoverable boundary instead of partially publishing
  // alongside the interrupted handoff.
  if (state?.specId && error.recoveryPossible !== true && !request?.policy.preservesRejectedSource) {
    try {
      const entry = {
        step: stepId,
        reason: `Worker artifact handoff ${error.classification || "invalid"}: ${error.message}`,
        trigger: "Parent dispatcher rejected or could not complete a worker artifact handoff.",
        resolution: error instanceof WorkerArtifactRetryExhaustedError
          ? "One fresh worker handoff retry was consumed; correct the artifact producer before dispatching this step again."
          : error.recoveryPossible
          ? "Resume the guarded dispatcher to replay the pending publication journal."
          : "Correct the worker artifact payload and dispatch the current action again.",
        ...(error instanceof WorkerArtifactRetryExhaustedError && {
          diagnostic: {
            code: error.code,
            classification: error.classification,
            attempts: error.data.attempts,
            first: error.data.first,
            second: error.data.second,
          },
        }),
        taskId: null,
        timestamp: new Date().toISOString(),
      };
      const idempotencyKey = `worker-handoff-${actionDigest || "unknown"}-${error.classification || "invalid"}`;
      if (state.schemaRevision !== 3 || typeof ctx.flowManager?.appendIssueLog !== "function") {
        throw new Error("worker handoff diagnostics require canonical FlowManager.appendIssueLog");
      }
      ctx.flowManager.appendIssueLog({ specId: state.specId, entry, idempotencyKey });
    } catch (logError) {
      issueLogError = logError.message || String(logError);
    }
  }
  return {
    ...blockedBoundary({
      target,
      nextAction: request?.invocation?.action?.nextAction || null,
      dispatchCount,
      message: error.recoveryPossible
        ? "Canonical publication is journaled and requires deterministic dispatcher recovery."
        : "The parent dispatcher rejected the worker artifact before completing the Flow step.",
    }),
    classification: error.classification || "invalid",
    retryBudgetConsumed: false,
    recoveryPossible: error.recoveryPossible === true,
    retryable: error.retryable === true,
    ...(error instanceof WorkerArtifactRetryExhaustedError && { retryExhausted: true }),
    actionDigest,
    dispatchInvocationId,
    ...(error.data || {}),
    ...(request && {
      payload: {
        directory: request.payloadDirectory,
        requestPath: request.requestPath,
        submissionPath: request.submissionPath,
        sealed: fs.existsSync(request.submissionPath),
      },
    }),
    ...(agentError instanceof AgentFailure && {
      lastProgress: {
        dispatchCount,
        stepId,
        handoffDirectory: request?.directory ?? null,
        supervisorEvent: agentError.supervisorEvents?.at(-1) ?? null,
      },
    }),
    ...(agentError instanceof AgentFailure ? { agentFailure: agentError.toJSON() } : {}),
    ...(Array.isArray(error.agentFailures) && { agentFailures: error.agentFailures.map((failure, index) => ({
      attempt: index + 1,
      ...(failure instanceof AgentFailure ? failure.toJSON() : { unavailable: "agent failure was not capturable" }),
    })) }),
    ...(issueLogError ? { issueLogError } : {}),
  };
}

function quarantineRejectedWorkerHandoff(coordinator, request, error) {
  if (!NON_REPLAYABLE_HANDOFF_ERROR_CODES.has(error.code)) return error;
  try {
    coordinator.quarantine({ request, error });
    return error;
  } catch (cause) {
    return new WorkerArtifactHandoffError(
      "invalid",
      "FLOW_ARTIFACT_HANDOFF_QUARANTINE_REQUIRED",
      `sealed worker artifact handoff could not be quarantined: ${cause.message}`,
      {
        cause,
        retryable: false,
        recoveryPossible: false,
        data: { stepId: request.stepId, handoffDirectory: request.directory },
      },
    );
  }
}

function blockedBoundary({ target, nextAction, dispatchCount, message }) {
  if (!(target instanceof FlowDispatchTarget)) {
    throw new Error("blocked Flow dispatch boundary requires its captured target");
  }
  return new FlowDispatchBoundary({
    kind: "blocked",
    target,
    nextAction,
    dispatchCount,
    message,
  }).toJSON();
}

export default class RunDispatchCommand extends FlowCommand {
  constructor({
    nextAction = new GetNextActionCommand(),
    agent = null,
    repositoryFingerprint = dispatchRepositoryFingerprint,
    maxDispatches = DEFAULT_MAX_DISPATCHES,
    maxStalledDispatches = DEFAULT_MAX_STALLED_DISPATCHES,
    leaseFactory = (session) => new FlowDispatchLease(session),
    handoffCoordinator = new WorkerArtifactHandoffCoordinator(),
    testReviewRepairMonitorFactory = (options) => new TestReviewRepairWorkerMonitor(options),
    repairCommandRunner = null,
    commandRunner = null,
  } = {}) {
    super({ explicitTargetResolution: true });
    this.nextAction = nextAction;
    this.agent = agent;
    this.repositoryFingerprint = repositoryFingerprint;
    this.maxDispatches = maxDispatches;
    this.maxStalledDispatches = maxStalledDispatches;
    this.leaseFactory = leaseFactory;
    this.handoffCoordinator = handoffCoordinator;
    if (typeof testReviewRepairMonitorFactory !== "function") throw new Error("test-review repair monitor factory must be a function");
    this.testReviewRepairMonitorFactory = testReviewRepairMonitorFactory;
    this.repairCommandRunner = repairCommandRunner;
    this.commandRunner = commandRunner;
  }

  async fetchNextAction(target) {
    let result;
    try {
      result = await this.nextAction.run(this.container, targetGuardInput(target));
    } catch (error) {
      return Envelope.fail(
        "get",
        "next-action",
        error.code || "FLOW_NEXT_ACTION_FAILED",
        error.message || String(error),
        error.data,
      );
    }
    if (result instanceof Envelope) return result;
    try {
      return target.assertNextActionBinding(result);
    } catch (error) {
      return Envelope.fail(
        "get",
        "next-action",
        error.code || "FLOW_NEXT_ACTION_BINDING_INVALID",
        error.message || String(error),
      );
    }
  }

  captureAction(ctx, session, nextAction, dispatchCount, phase) {
    try {
      return session.captureAction(
        workerFacingNextAction(nextAction),
        this.repositoryFingerprint(ctx),
      );
    } catch (cause) {
      throw new FlowDispatchRepositoryFingerprintError({
        cause,
        nextAction,
        dispatchCount,
        phase,
      });
    }
  }

  failure(ctx, code, messages, data) {
    return Envelope.fail(
      ctx._envelopeType || "run",
      ctx._envelopeKey || "dispatch",
      code,
      messages,
      data,
    );
  }

  async runDispatcherOwnedRepair(ctx, target, action) {
    if (!(action.directive instanceof RepairEvidenceDirective)) return null;
    const match = /^sennel flow run ([a-z][a-z0-9-]*)(?:\s|$)/.exec(action.directive.nextAction);
    const commandName = match?.[1] || null;
    if (!DISPATCHER_OWNED_REPAIR_COMMANDS.has(commandName)) return null;

    if (this.repairCommandRunner) {
      return this.repairCommandRunner({ ctx, target, action, commandName });
    }

    return this.runRegisteredFlowCommand(ctx, target, commandName, []);
  }

  /**
   * Historical state reconciliation is a Store-owned transition, never a
   * worker instruction. Keep this deliberately small: unlike repair commands,
   * only no-input typed Store transitions are safe to run automatically.
   */
  async runDispatcherOwnedRecovery(ctx, target, action) {
    if (!(action.directive instanceof ExecuteCommandDirective)) return null;
    const match = /^sennel flow run ([a-z][a-z0-9-]*)(?:\s|$)/.exec(action.directive.nextAction);
    const commandName = match?.[1] || null;
    if (!DISPATCHER_OWNED_RECOVERY_COMMANDS.has(commandName)) return null;
    // `gate` is normally a worker-producing command and must never become a
    // broad dispatcher-owned capability.  Definition projects this command
    // here only for the catalog-bound publication reconciliation action; the
    // Gate command independently verifies that exact condition before it can
    // rehydrate anything.
    if (commandName === "gate" && action.directive.actionId !== "RECONCILE_GATE_PUBLICATION") return null;
    return this.runRegisteredFlowCommand(ctx, target, commandName, []);
  }

  async runRegisteredFlowCommand(ctx, target, commandName, args) {
    const entry = flowCommands.run?.[commandName];
    if (!entry?.command) {
      throw new Error(`dispatcher-owned command is not registered: ${commandName}`);
    }
    let stdout = "";
    let exitCode = 0;
    await dispatch({
      container: this.container,
      entry,
      argv: [
        ...args,
        ...(ctx.agentWorkDir ? ["--agent-work-dir", ctx.agentWorkDir] : []),
        ...targetGuardArguments(target),
      ],
      envelopeType: "run",
      envelopeKey: commandName,
      runtimeLog: true,
      stdout: (text) => { stdout += text; },
      stderr: () => {},
      setExitCode: (code) => { exitCode = code; },
      buildHookCtx: (container, input) => buildFlowCommandHookContext(container, entry, input),
    });
    return commandEnvelope(stdout.trim(), commandName, exitCode);
  }

  async runDispatcherOwnedCommand(ctx, target, action) {
    const command = DispatcherOwnedFlowCommand.forAction(action);
    if (command === null) return null;
    if (this.commandRunner) {
      return { command, result: await this.commandRunner({ ctx, target, action, command }) };
    }
    return {
      command,
      result: await this.runRegisteredFlowCommand(
        ctx,
        target,
        command.commandName,
        command.command.runArguments().slice(1),
      ),
    };
  }

  async parentCommandProgress({
    ctx,
    session,
    target,
    invocation,
    dispatchCount,
    stalledDispatches,
    owner,
  }) {
    const refreshed = await this.fetchNextAction(target);
    if (refreshed instanceof Envelope) {
      return { current: refreshed, stalledDispatches, failure: null };
    }
    const refreshedIdentity = this.captureAction(
      ctx,
      session,
      refreshed,
      dispatchCount,
      "post-handoff-progress",
    );
    const nextStalledDispatches = invocation.hasProgressedTo(refreshedIdentity)
      ? 0
      : stalledDispatches + 1;
    if (nextStalledDispatches >= this.maxStalledDispatches) {
      return {
        current: refreshed,
        stalledDispatches: nextStalledDispatches,
        failure: this.failure(
          ctx,
          "FLOW_DISPATCH_STALLED",
          `the dispatcher-owned ${owner} returned ${nextStalledDispatches} time(s) without durable progress`,
          blockedBoundary({
            target,
            nextAction: refreshed,
            dispatchCount,
            message: `The dispatcher-owned ${owner} returned successfully, but the guarded Flow and repository state did not change.`,
          }),
        ),
      };
    }
    return { current: refreshed, stalledDispatches: nextStalledDispatches, failure: null };
  }

  runApprovalContinuation(ctx, invocation) {
    if (invocation.action.nextAction.step !== "approval") return null;
    if (typeof ctx.flowManager?.approveSpecContinuation !== "function") {
      throw new Error("approval continuation requires the canonical parent Store operation");
    }
    const state = ctx.flowManager.canonicalState(ctx.specId);
    // A pending approval projection is dispatcher-owned claim work, not a
    // semantic approval boundary. Do not create route facts until the Store
    // has materialized the active Attempt that those facts are bound to.
    if (state.current?.at(-1) !== "approval" || state.attempt === null) return null;
    const spec = ctx.flowManager.readArtifact({
      specId: ctx.specId,
      logicalKey: "spec.record",
      consumerNodeId: "approval",
    });
    const plan = resolveDefinitionRoute(approvalRouteFacts({
      state,
      specDescriptor: spec.descriptor,
      spec: JSON.parse(spec.bytes.toString("utf8")),
      requestedApproval: invocation.approved === true,
    }));
    const confirmedAt = invocation.authorization instanceof ExplicitFlowDispatchAuthorization
      ? invocation.authorization.approvedAt
      : new Date().toISOString();
    return plan.apply({
      awaitApproval() { return null; },
      confirmAndAdvance(selected) {
        if (!(selected instanceof ConfirmAndAdvance)) throw new Error("Definition selected an invalid approval continuation plan");
        const recorded = selected.facts.approvalRecord;
        return ctx.flowManager.approveSpecContinuation({
          specId: ctx.specId,
          approval: new CanonicalSpecApproval(recorded === null
            ? { confirmedAt }
            : { confirmedAt: recorded.confirmed_at, notes: recorded.notes ?? null }),
          expectedSpecDigest: selected.facts.specPublicationDigest,
        });
      },
      blocked(selected) {
        throw new Error(`approval continuation is blocked: ${selected.reason}`);
      },
    });
  }

  async runWorkerAttempt(ctx, invocation, retryFeedback = null) {
    const action = new FlowDispatchAction(invocation.action.nextAction);
    let handoffRequest = null;
    let handoffAuthority = null;
    let handoffPolicy = null;
    let handoffAuthorityAcquired = false;
    try {
      const state = readFlowState(ctx);
      handoffPolicy = workerArtifactHandoffPolicy(action.nextAction.step);
      if (handoffPolicy !== null) {
        handoffAuthority = new FlowHandoffAuthorityLease({
          mainRoot: ctx.mainRoot || ctx.root,
          executionRoot: ctx.executionRoot || ctx.root,
        });
        // The authority is acquired before parent input capture. External
        // upgrades therefore cannot alter immutable handoff inputs between
        // request construction and its mutation snapshot.
        handoffAuthority.acquire({ wait: true });
        handoffAuthorityAcquired = true;
      }
      handoffRequest = this.handoffCoordinator.createRequest({
        ctx,
        state,
        invocation,
      });
    } catch (error) {
      handoffAuthority?.release();
      if (handoffPolicy !== null && !handoffAuthorityAcquired && !(error instanceof WorkerArtifactHandoffError)) {
        return {
          error: new WorkerArtifactHandoffError(
            "recovery-required",
            "FLOW_ARTIFACT_HANDOFF_AUTHORITY_LOCK_REQUIRED",
            `worker artifact handoff authority cannot be acquired: ${error.message}`,
            {
              cause: error,
              retryable: false,
              recoveryPossible: false,
              data: { stepId: action.nextAction.step },
            },
          ),
          handoffRequest: null,
          agentError: null,
        };
      }
      if (!(error instanceof WorkerArtifactHandoffError)) throw error;
      return { error, handoffRequest: null, agentError: null };
    }

    try {
      let workerArtifactAuthority = null;
      try {
        workerArtifactAuthority = handoffRequest?.policy.kind !== "source"
          ? null
          : WorkerArtifactMutationAuthoritySnapshot.capture(handoffRequest);
      } catch (error) {
        if (!(error instanceof WorkerArtifactHandoffError)) throw error;
        return { error, handoffRequest, agentError: null };
      }

      const work = new FlowDispatchWork(invocation, handoffRequest, retryFeedback);
      const holdsSpecRepairMetric = action.nextAction.step === "spec-repair";
      const deferredMetric = handoffRequest
        ? new DeferredAgentInvocationMetric({ flowManager: ctx.flowManager })
        : null;
      let agentError = null;
      let sourceResponseError = null;
      const supervisorEvents = [];
      const activityMonitor = testReviewRepairWorkerMonitor(
        handoffRequest,
        ctx.config?.agent ?? {},
        this.testReviewRepairMonitorFactory,
      );
      try {
        const agent = this.agent || (this.agent = this.container.get("agent"));
        const workerOptions = workerArtifactAgentOptions(
          action.nextAction.step,
          action.nextAction.output_schema,
        );
        const { promptGuidance, ...agentOptions } = workerOptions;
        const responseText = await agent.call(work.prompt(promptGuidance), {
          commandId: handoffRequest?.policy.preservesRejectedSource ? `flow.dispatch.${handoffRequest.stepId}` : "flow.dispatch",
          executionWorkDir: ctx.executionRoot || ctx.root,
          cacheMode: "bypass",
          retryCount: 0,
          waitForProcessTree: true,
          executionEnvironment: work.executionEnvironment(),
          deferredMetric,
          ...(activityMonitor && {
            timeoutMs: activityMonitor.maximumLifetimeMs,
            timeoutDiagnostic: new AgentTimeoutDiagnostic({
              reason: "maximum_lifetime",
              timeoutMs: activityMonitor.maximumLifetimeMs,
            }),
            activityMonitor,
          }),
          onSupervisorEvent(event) {
            supervisorEvents.push(Object.freeze({ at: new Date().toISOString(), ...event }));
          },
          ...agentOptions,
        });
        if (handoffRequest?.policy.kind === "source") {
          materializeSourceWorkerEffect({ request: handoffRequest, responseText });
          sealParentMaterializedSourceWorkerEffect({ request: handoffRequest });
        }
      } catch (error) {
        agentError = error;
        if (agentError instanceof AgentFailure) agentError.supervisorEvents = Object.freeze(supervisorEvents);
        if (handoffRequest?.policy.kind === "source") {
          sourceResponseError = error instanceof WorkerArtifactHandoffError
            ? error
            : new WorkerArtifactHandoffError(
                "invalid",
                "FLOW_SOURCE_HANDOFF_RESPONSE_UNAVAILABLE",
                `source worker did not produce a parent-materializable structured effect: ${error.message || String(error)}`,
                // Preserve the existing one-fresh-invocation transport retry
                // for provider failures. Parse and schema failures are thrown
                // above as typed handoff errors and remain terminal.
                { cause: error, retryable: error instanceof AgentFailure, data: { stepId: handoffRequest.stepId } },
              );
        }
      }

      if (!handoffRequest) return { error: null, handoffRequest: null, agentError };

      let reconciliation = null;
      try {
        if (fs.existsSync(handoffRequest.submissionPath)) activityMonitor?.observeSubmission();
        if (sourceResponseError !== null) throw sourceResponseError;
        reconciliation = this.handoffCoordinator.reconcile({
          ctx,
          request: handoffRequest,
          mutationAuthority: workerArtifactAuthority,
          bootstrapObservationAuthority: retryFeedback?.bootstrapObservationAuthority,
        });
        agentError = null;
      } catch (error) {
        const timedOutRepairWorker = isTestReviewRepairWorker(handoffRequest)
          && agentError instanceof AgentFailure
          && agentError.code === "AGENT_TIMEOUT";
        if (timedOutRepairWorker && safelyDiscardableRepairTimeout(error)) {
          const timeout = TestReviewRepairWorkerTimeout.fromAgentFailure(agentError);
          // Persist the timeout before removing transient bytes. If cleanup or
          // settlement is interrupted, the next dispatcher observes the
          // failed Attempt and cannot start this worker again in place.
          ctx.flowManager.failCurrentAttempt({
            specId: handoffRequest.specId,
            failure: {
              category: "tooling",
              code: timeout.failureCode,
              message: `test-review repair worker timed out (${timeout.reason}) without an accepted handoff`,
              retryable: false,
              retryKind: null,
            },
            result: {
              outcome: "failed",
              summary: "Test-review repair worker timed out without an accepted handoff.",
              confirmedAt: new Date().toISOString(),
              artifactRefs: [],
            },
          });
          this.handoffCoordinator.discardRejectedTimeoutHandoff(handoffRequest);
          ctx.flowManager.settleTimedOutTestReviewRepair({
            specId: handoffRequest.specId,
            references: handoffRequest.testReviewRepair.references(),
          });
          if (!holdsSpecRepairMetric) await deferredMetric.flush();
          return {
            error: null,
            handoffRequest,
            agentError: null,
            timeoutSettled: true,
            supervisorEvents,
            deferredMetric: holdsSpecRepairMetric ? deferredMetric : null,
          };
        }
        const rejectedSource = error instanceof WorkerArtifactHandoffError
          && handoffRequest !== null
          && handoffRequest.policy.kind === "source"
          && !handoffRequest.policy.preservesRejectedSource
          && workerArtifactAuthority !== null
          && !NON_REPLAYABLE_HANDOFF_ERROR_CODES.has(error.code);
        if (rejectedSource) {
          try {
            this.handoffCoordinator.rollbackRejectedSourceHandoff({
              ctx,
              request: handoffRequest,
              mutationAuthority: workerArtifactAuthority,
            });
          } catch (rollbackError) {
            await deferredMetric.flush();
            return {
              error: new WorkerArtifactHandoffError(
                "recovery-required",
                "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED",
                `rejected source handoff could not be safely restored: ${rollbackError.message}`,
                {
                  cause: rollbackError,
                  retryable: false,
                  recoveryPossible: false,
                  data: {
                    stepId: handoffRequest.stepId,
                    handoffDirectory: handoffRequest.directory,
                  },
                },
              ),
              handoffRequest,
              agentError,
            };
          }
        }
        if (handoffRequest.policy.preservesRejectedSource && error instanceof WorkerArtifactHandoffError && error.recoveryPossible !== true) {
          new TaskSourceFailureObservation({ request: handoffRequest, error, mutationAuthority: workerArtifactAuthority, agentError }).record(ctx.flowManager);
        }
        if (!holdsSpecRepairMetric) await deferredMetric.flush();
        if (!(error instanceof WorkerArtifactHandoffError)) throw error;
        const rejected = quarantineRejectedWorkerHandoff(this.handoffCoordinator, handoffRequest, error);
        const reported = agentError && rejected instanceof WorkerArtifactHandoffError
          ? new WorkerArtifactHandoffError(
              rejected.classification,
              rejected.code,
              rejected.message,
              {
                cause: new AggregateError([rejected, agentError], "worker handoff and provider failure"),
                data: rejected.data,
                retryable: rejected.retryable,
                recoveryPossible: rejected.recoveryPossible,
              },
            )
          : rejected;
        return {
          error: reported,
          handoffRequest,
          agentError,
          supervisorEvents,
          deferredMetric: holdsSpecRepairMetric ? deferredMetric : null,
        };
      }
      if (!holdsSpecRepairMetric) await deferredMetric.flush();
      return {
        error: null,
        handoffRequest,
        agentError,
        partialRepair: reconciliation?.partial === true,
        supervisorEvents,
        deferredMetric: holdsSpecRepairMetric ? deferredMetric : null,
      };
    } finally {
      handoffAuthority?.release();
    }
  }

  async execute(ctx) {
    let target;
    try {
      target = FlowDispatchTarget.captureContext(ctx);
    } catch (error) {
      return this.failure(
        ctx,
        "FLOW_DISPATCH_TARGET_REQUIRED",
        "flow dispatch requires an exact --expect-binding or --expect-run-id target",
        { cause: error.message || String(error) },
      );
    }

    const session = new FlowDispatchSession({ target });
    const lease = this.leaseFactory(session);
    try {
      lease.acquire();
    } catch (error) {
      return this.failure(
        ctx,
        error.code || "FLOW_DISPATCH_LOCK_FAILED",
        error.message || String(error),
        blockedBoundary({
          target,
          nextAction: null,
          dispatchCount: 0,
          message: error.code === "FLOW_DISPATCH_BUSY"
            ? "Another live dispatcher owns this exact Flow. Wait for it to finish; do not start a duplicate review."
            : error.code === "FLOW_DISPATCH_LOCK_STALE"
              ? "The prior dispatcher owner is gone, but its worker may still be running. Verify that process tree has ended before recovering the lease; do not start a duplicate review."
              : "The Flow dispatcher lease could not be acquired safely.",
        }),
      );
    }
    try {
      try {
        return await this.dispatchContinuation(ctx, session);
      } catch (error) {
        if (!(error instanceof FlowDispatchRepositoryFingerprintError)) throw error;
        const boundaryMessage = error.phase === "action-capture"
          ? "The repository fingerprint could not be captured. No authorization was issued and no worker was started for this action."
          : error.phase === "pre-handoff-validation"
            ? "The repository fingerprint could not be recaptured before handoff. No worker was started for this action."
            : "The worker ran, but its result was not accepted because repository progress could not be verified.";
        return this.failure(
          ctx,
          error.code,
          error.message,
          {
            ...blockedBoundary({
              target,
              nextAction: error.nextAction,
              dispatchCount: error.dispatchCount,
              message: boundaryMessage,
            }),
            cause: error.cause?.message || String(error.cause),
            fingerprintPhase: error.phase,
          },
        );
      }
    } finally {
      lease.release();
    }
  }

  async dispatchContinuation(ctx, session) {
    const { target } = session;
    let dispatchCount = 0;
    let stalledDispatches = 0;
    let suppliedApproval = ctx.approve || null;
    try {
      this.handoffCoordinator.recoverPending({ ctx });
      reconcileCompletedReviewWorkUnits({
        flowManager: ctx.flowManager,
        specId: ctx.specId ?? ctx.flowState?.specId,
        executionRoot: ctx.executionRoot || ctx.root,
      });
      const recoveredSpecId = ctx.specId ?? ctx.flowState?.specId;
      const recoveredState = typeof ctx.flowManager.canonicalState === "function"
        ? ctx.flowManager.canonicalState(recoveredSpecId)
        : ctx.flowManager.load(recoveredSpecId);
      if (hasPendingTestReviewRepairTimeout(recoveredState)) {
        ctx.flowManager.settleTimedOutTestReviewRepair({ specId: recoveredState.specId });
      }
    } catch (error) {
      if (!(error instanceof WorkerArtifactHandoffError)) throw error;
      return this.failure(
        ctx,
        error.code,
        error.message,
        workerHandoffFailureData(ctx, target, error, null, dispatchCount),
      );
    }
    let current = await this.fetchNextAction(target);

    while (dispatchCount < this.maxDispatches) {
      if (current instanceof Envelope) {
        const code = errorCode(current);
        if (code === "ACTIVE_FLOW_MISMATCH" || code === "FLOW_TARGET_NOT_FOUND") {
          return new FlowDispatchBoundary({
            kind: "target_mismatch",
            nextAction: null,
            dispatchCount,
            message: errorMessages(current).join(" "),
          }).toJSON();
        }
        return this.failure(
          ctx,
          code,
          errorMessages(current),
          blockedBoundary({
            target,
            nextAction: null,
            dispatchCount,
            message: "The guarded next action could not be resolved.",
          }),
        );
      }

      const action = new FlowDispatchAction(current);

      if (action.awaitsUserDecision) {
        if (suppliedApproval) {
          return this.failure(
            ctx,
            "FLOW_DISPATCH_APPROVAL_STALE",
            "the supplied approval token no longer targets an approval boundary",
            new FlowDispatchBoundary({
              kind: "await_user_decision",
              target,
              nextAction: current,
              dispatchCount,
            }).toJSON(),
          );
        }
        return new FlowDispatchBoundary({
          kind: "await_user_decision",
          target,
          nextAction: current,
          dispatchCount,
        }).toJSON();
      }

      if (action.isTerminal) {
        if (suppliedApproval) {
          return this.failure(
            ctx,
            "FLOW_DISPATCH_APPROVAL_STALE",
            "the supplied approval token no longer targets an active approval boundary",
            new FlowDispatchBoundary({
              kind: action.directive.kind,
              target,
              nextAction: current,
              dispatchCount,
            }).toJSON(),
          );
        }
        return new FlowDispatchBoundary({
          kind: action.directive.kind,
          target,
          nextAction: current,
          dispatchCount,
        }).toJSON();
      }

      if (!action.isContinuation) {
        return this.failure(
          ctx,
          "FLOW_DISPATCH_DIRECTIVE_INVALID",
          `flow dispatch cannot execute directive kind ${action.directive.kind}`,
          blockedBoundary({
            target,
            nextAction: current,
            dispatchCount,
            message: "The next-action directive is not dispatchable.",
          }),
        );
      }

      const actionIdentity = this.captureAction(
        ctx,
        session,
        current,
        dispatchCount,
        "action-capture",
      );
      let flowState = readFlowState(ctx);
      const storedAuthorization = action.requiresApproval
        ? ExplicitFlowDispatchAuthorization.matching(flowState, actionIdentity)
        : null;
      let invocation = new FlowDispatchInvocation({
        session,
        action: actionIdentity,
        authorization: storedAuthorization
          ?? new UnapprovedFlowDispatchAuthorization(actionIdentity),
      });
      let receiptMutation = null;
      if (action.requiresApproval) {
        const expectedApproval = invocation.approvalToken();
        if (suppliedApproval && suppliedApproval !== expectedApproval) {
          return this.failure(
            ctx,
            "FLOW_DISPATCH_APPROVAL_STALE",
            "the supplied approval token does not match the current guarded next action",
            new FlowDispatchBoundary({
              kind: "approval_required",
              target,
              nextAction: current,
              dispatchCount,
              approvalToken: expectedApproval,
            }).toJSON(),
          );
        }
        if (suppliedApproval === expectedApproval) {
          const explicitAuthorization = storedAuthorization
            ?? new ExplicitFlowDispatchAuthorization({
              action: actionIdentity,
              runId: target.runId,
              approvalToken: expectedApproval,
          });
          invocation = invocation.withAuthorization(explicitAuthorization);
          const persisted = persistDispatchApproval(ctx, invocation, this.repositoryFingerprint);
          invocation = invocation.withAuthorization(persisted.authorization);
          receiptMutation = persisted.receiptMutation;
          flowState = readFlowState(ctx);
          suppliedApproval = null;
        } else if (!invocation.approved && flowState?.autoApprove === true && action.isAutoApproveEligible) {
          invocation = invocation.withAuthorization(
            new AutoApprovedFlowDispatchAuthorization({
              action: actionIdentity,
              choiceId: action.autoApproveChoiceId,
            }),
          );
        }
        if (!invocation.approved) {
          return new FlowDispatchBoundary({
            kind: "approval_required",
            target,
            nextAction: current,
            dispatchCount,
            approvalToken: expectedApproval,
          }).toJSON();
        }
      } else if (suppliedApproval) {
        return this.failure(
          ctx,
          "FLOW_DISPATCH_APPROVAL_STALE",
          "the supplied approval token targets a different Flow action",
          blockedBoundary({
            target,
            nextAction: current,
            dispatchCount,
            message: "Refresh the approval boundary before continuing.",
          }),
        );
      }

      const validated = await this.fetchNextAction(target);
      if (validated instanceof Envelope) {
        current = validated;
        continue;
      }
      const activeAction = this.captureAction(
        ctx,
        session,
        validated,
        dispatchCount,
        "pre-handoff-validation",
      );
      try {
        const currentState = readFlowState(ctx);
        if (receiptMutation) {
          receiptMutation.assertCurrent({
            ctx,
            fingerprint: this.repositoryFingerprint,
            activeAction,
            flowState: currentState,
          });
        } else {
          invocation.assertCurrent(activeAction, currentState);
        }
      } catch (error) {
        return this.failure(
          ctx,
          error.code || "FLOW_DISPATCH_INVOCATION_STALE",
          error.message || String(error),
          {
            ...blockedBoundary({
              target,
              nextAction: validated,
              dispatchCount,
              message: "The action or repository changed before worker handoff. Refresh the guarded invocation before continuing.",
            }),
            invocation: error.data ?? invocation.toJSON(),
          },
        );
      }

      let approvalContinuation;
      try {
        approvalContinuation = this.runApprovalContinuation(ctx, invocation);
      } catch (error) {
        return this.failure(
          ctx,
          error.code || "FLOW_DISPATCH_APPROVAL_CONTINUATION_FAILED",
          error.message || String(error),
          blockedBoundary({ target, nextAction: validated, dispatchCount, message: "The parent could not commit the approved Spec continuation." }),
        );
      }
      if (approvalContinuation !== null) {
        dispatchCount += 1;
        const progressed = await this.parentCommandProgress({
          ctx, session, target, invocation, dispatchCount, stalledDispatches, owner: "approval continuation",
        });
        if (progressed.failure) return progressed.failure;
        stalledDispatches = progressed.stalledDispatches;
        current = progressed.current;
        continue;
      }

      let dispatcherOwnedRepair;
      try {
        dispatcherOwnedRepair = await this.runDispatcherOwnedRepair(ctx, target, action);
      } catch (error) {
        return this.failure(
          ctx,
          error.code || "FLOW_DISPATCH_REPAIR_COMMAND_FAILED",
          error.message || String(error),
          blockedBoundary({
            target,
            nextAction: validated,
            dispatchCount,
            message: "The dispatcher-owned repair command failed before the worker handoff could begin.",
          }),
        );
      }
      if (dispatcherOwnedRepair != null) {
        dispatchCount += 1;
        if (commandFailed(dispatcherOwnedRepair)) {
          return this.failure(
            ctx,
            errorCode(dispatcherOwnedRepair),
            errorMessages(dispatcherOwnedRepair),
            blockedBoundary({
              target,
              nextAction: validated,
              dispatchCount,
              message: "The dispatcher-owned repair command did not complete the guarded Flow transition.",
            }),
          );
        }
        const progressed = await this.parentCommandProgress({
          ctx,
          session,
          target,
          invocation,
          dispatchCount,
          stalledDispatches,
          owner: "repair command",
        });
        if (progressed.failure) return progressed.failure;
        stalledDispatches = progressed.stalledDispatches;
        current = progressed.current;
        continue;
      }

      let dispatcherOwnedRecovery;
      try {
        dispatcherOwnedRecovery = await this.runDispatcherOwnedRecovery(ctx, target, action);
      } catch (error) {
        return this.failure(
          ctx,
          error.code || "FLOW_DISPATCH_RECOVERY_COMMAND_FAILED",
          error.message || String(error),
          blockedBoundary({
            target,
            nextAction: validated,
            dispatchCount,
            message: "The dispatcher-owned missing producer artifact recovery failed before worker handoff could begin.",
          }),
        );
      }
      if (dispatcherOwnedRecovery != null) {
        dispatchCount += 1;
        if (commandFailed(dispatcherOwnedRecovery)) {
          return this.failure(
            ctx,
            errorCode(dispatcherOwnedRecovery),
            errorMessages(dispatcherOwnedRecovery),
            blockedBoundary({
              target,
              nextAction: validated,
              dispatchCount,
              message: "The dispatcher-owned missing producer artifact recovery did not complete its guarded Flow transition.",
            }),
          );
        }
        const progressed = await this.parentCommandProgress({
          ctx,
          session,
          target,
          invocation,
          dispatchCount,
          stalledDispatches,
          owner: "missing producer artifact recovery",
        });
        if (progressed.failure) return progressed.failure;
        stalledDispatches = progressed.stalledDispatches;
        current = progressed.current;
        continue;
      }

      let dispatcherOwnedCommand;
      try {
        dispatcherOwnedCommand = await this.runDispatcherOwnedCommand(ctx, target, action);
      } catch (error) {
        return this.failure(
          ctx,
          error.code || "FLOW_DISPATCH_COMMAND_FAILED",
          error.message || String(error),
          blockedBoundary({
            target,
            nextAction: validated,
            dispatchCount,
            message: "The dispatcher-owned Flow command failed before it could complete the canonical transition.",
          }),
        );
      }
      if (dispatcherOwnedCommand != null) {
        dispatchCount += 1;
        if (commandFailed(dispatcherOwnedCommand.result)) {
          return this.failure(
            ctx,
            errorCode(dispatcherOwnedCommand.result),
            errorMessages(dispatcherOwnedCommand.result),
            blockedBoundary({
              target,
              nextAction: validated,
              dispatchCount,
              message: "The dispatcher-owned Flow command did not complete the guarded Flow transition.",
            }),
          );
        }
        if (dispatcherOwnedCommand.command.removesExecutionRoot) {
          try {
            finalizeCleanupCompletion(dispatcherOwnedCommand.result);
          } catch (error) {
            return this.failure(
              ctx,
              error.code,
              error.message,
              blockedBoundary({
                target,
                nextAction: validated,
                dispatchCount,
                message: "Finalize cleanup returned without durable canonical completion evidence.",
              }),
            );
          }
          return new FlowDispatchBoundary({
            kind: "completed",
            nextAction: null,
            dispatchCount,
          }).toJSON();
        }
        const progressed = await this.parentCommandProgress({
          ctx,
          session,
          target,
          invocation,
          dispatchCount,
          stalledDispatches,
          owner: "Flow command",
        });
        if (progressed.failure) return progressed.failure;
        stalledDispatches = progressed.stalledDispatches;
        current = progressed.current;
        continue;
      }

      let attempt = await this.runWorkerAttempt(ctx, invocation);
      dispatchCount += 1;
      const deferredMetrics = attempt.deferredMetric ? [attempt.deferredMetric] : [];
      if (attempt.error) {
        if (
          attempt.error.retryable !== true
          || !attempt.handoffRequest
        ) {
          discardDeferredMetrics(deferredMetrics);
          return this.failure(
            ctx,
            attempt.error.code,
            attempt.error.message,
            workerHandoffFailureData(
              ctx,
              target,
              attempt.error,
              attempt.handoffRequest,
              dispatchCount,
              attempt.agentError,
            ),
          );
        }

        // Only malformed JSON, a missing or unreadable handoff transport, or
        // an explicitly retryable producer payload-format failure is retried
        // once with a new dispatch invocation and handoff directory. Parsed
        // semantic, identity, authority, and publication failures are terminal.
        const retryCurrent = await this.fetchNextAction(target);
        if (
          retryCurrent instanceof Envelope
          || retryCurrent.step !== invocation.action.nextAction.step
          || retryCurrent.action !== invocation.action.nextAction.action
        ) {
          discardDeferredMetrics(deferredMetrics);
          return this.failure(
            ctx,
            attempt.error.code,
            attempt.error.message,
            workerHandoffFailureData(
              ctx,
              target,
              attempt.error,
              attempt.handoffRequest,
              dispatchCount,
              attempt.agentError,
            ),
          );
        }
        const retryInvocation = freshWorkerInvocation(invocation, retryCurrent);
        const firstError = attempt.error;
        const firstRequest = attempt.handoffRequest;
        const firstAgentError = attempt.agentError;
        attempt = await this.runWorkerAttempt(
          ctx,
          retryInvocation,
          new WorkerArtifactRetryFeedback(firstError),
        );
        if (attempt.deferredMetric) deferredMetrics.push(attempt.deferredMetric);
        dispatchCount += 1;
        if (attempt.error) {
          discardDeferredMetrics(deferredMetrics);
          const exhausted = attempt.error.retryable === true
            ? new WorkerArtifactRetryExhaustedError({
                firstError,
                secondError: attempt.error,
                firstRequest,
                secondRequest: attempt.handoffRequest,
            })
            : attempt.error;
          if (exhausted instanceof WorkerArtifactHandoffError) {
            exhausted.agentFailures = Object.freeze([firstAgentError, attempt.agentError].filter(Boolean));
          }
          return this.failure(
            ctx,
            exhausted.code,
            exhausted.message,
            workerHandoffFailureData(
              ctx,
              target,
              exhausted,
              attempt.handoffRequest,
              dispatchCount,
              attempt.agentError,
            ),
          );
        }
        invocation = retryInvocation;
      }
      await flushDeferredMetrics(deferredMetrics);
      const agentError = attempt.agentError;

      if (attempt.partialRepair) stalledDispatches = 0;

      const refreshed = await this.fetchNextAction(target);
      if (refreshed instanceof Envelope) {
        current = refreshed;
        continue;
      }
      if (agentError) {
        const refreshedAction = new FlowDispatchAction(refreshed);
        if (refreshedAction.isTerminal || refreshedAction.awaitsUserDecision) {
          current = refreshed;
          continue;
        }
        const boundary = blockedBoundary({
          target,
          nextAction: refreshed,
          dispatchCount,
          message: "The worker process ended and guarded authority was refreshed. Resolve the provider failure before resuming this non-terminal action.",
        });
        return this.failure(
          ctx,
          agentError instanceof AgentFailure ? agentError.code : "FLOW_DISPATCH_AGENT_FAILED",
          `the configured Flow worker failed: ${agentError.message || agentError}`,
          agentError instanceof AgentFailure
            ? { ...boundary, agentFailure: agentError.toJSON() }
            : boundary,
        );
      }
      const refreshedIdentity = this.captureAction(
        ctx,
        session,
        refreshed,
        dispatchCount,
        "post-handoff-progress",
      );
      stalledDispatches = invocation.hasProgressedTo(refreshedIdentity)
        ? 0
        : stalledDispatches + 1;
      if (stalledDispatches >= this.maxStalledDispatches) {
        return this.failure(
          ctx,
          "FLOW_DISPATCH_STALLED",
          `the configured Flow worker returned ${stalledDispatches} time(s) without durable progress`,
          blockedBoundary({
            target,
            nextAction: refreshed,
            dispatchCount,
            message: "The worker response was not accepted as completion because the guarded Flow and repository state did not change.",
          }),
        );
      }
      current = refreshed;
    }

    return this.failure(
      ctx,
      "FLOW_DISPATCH_LIMIT_REACHED",
      `flow dispatch exceeded its ${this.maxDispatches}-action safety limit`,
      blockedBoundary({
        target,
        nextAction: current instanceof Envelope ? null : current,
        dispatchCount,
        message: "Resume after inspecting why the finite Flow exceeded the dispatcher safety limit.",
      }),
    );
  }
}
