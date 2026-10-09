/**
 * Exact-attempt failure recording for definition-owned parent commands.
 *
 * A command and its registry hooks may each update canonical state.  The
 * dispatcher therefore binds the active Attempt before the first hook and
 * records a tooling failure only if that exact Attempt remains unmodified
 * after the failed boundary.  This keeps a post-hook error from stranding an
 * Attempt, without overwriting a command's own semantic outcome or recovery
 * transition.
 */

import {
  CurrentAttemptIdentity,
  CurrentFlowStateInvariantError,
} from "./current-flow-state.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { DefinitionFailureOwnership } from "./definition-failure-ownership.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { attachedCanonicalReviewWorkUnit } from "./canonical-review-artifacts.js";
import { TaskReviewAbortedWorkUnit } from "./task-review-aborted-work-unit.js";
import { StepAdmissionRefusal, isStepAdmissionRefusal } from "./step-admission-refusal.js";
import { AgentResponseProtocolEvidence } from "../../lib/agent-response-protocol.js";

export const STEP_RESULT_ERROR_PERSISTENCE_FAILURE_CODE = "STEP_RESULT_ERROR_PERSISTENCE_FAILED";

/**
 * A failed Store commit has no Step result to record.  This explicit error
 * crosses the command boundary so dispatcher fallback can stop without
 * manufacturing a second failure for the still-current Attempt.
 */
export class StepPersistenceFailure extends Error {
  constructor(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "StepPersistenceFailure";
    this.code = STEP_RESULT_ERROR_PERSISTENCE_FAILURE_CODE;
  }
}

const originalStepPersistenceFailures = new WeakSet();

export function isStepPersistenceFailure(error) {
  return originalStepPersistenceFailures.has(error)
    || error instanceof StepPersistenceFailure
    || error?.code === STEP_RESULT_ERROR_PERSISTENCE_FAILURE_CODE
    || error?.data?.failureKind === "step-persistence";
}

/** Preserve a command adapter's original IO error without losing no-fallback classification. */
export function rethrowOriginalStepPersistenceFailure(error) {
  if (error instanceof StepPersistenceFailure && error.cause instanceof Error) {
    originalStepPersistenceFailures.add(error.cause);
    throw error.cause;
  }
  throw error;
}

/** Read one exact committed settlement after an uncertain Store response. */
export function findCommittedStepSettlementReceipt(flowManager, input) {
  try {
    return flowManager.findStepSettlementReceipt(input);
  } catch {
    return null;
  }
}

function definitiveStepSettlementFailure(error) {
  if (isStepAdmissionRefusal(error)) return error;
  if (error instanceof CurrentFlowStateConflictError) {
    return new StepAdmissionRefusal(error.message, error);
  }
  if (error instanceof CurrentFlowStateInvariantError) return error;
  return null;
}

/** Preserve admission and invariant failures; classify an uncommitted write failure. */
export function rethrowStepSettlementFailure(error) {
  const definitive = definitiveStepSettlementFailure(error);
  if (definitive !== null) throw definitive;
  throw error instanceof StepPersistenceFailure ? error : new StepPersistenceFailure(error);
}

/** Recover only the exact receipt, otherwise preserve the original write failure. */
export function recoverStepSettlementReceipt(flowManager, input, error) {
  // An older exact receipt cannot overturn a Store rejection of a stale generation.
  const definitive = definitiveStepSettlementFailure(error);
  if (definitive !== null) throw definitive;
  const receipt = findCommittedStepSettlementReceipt(flowManager, input);
  if (receipt !== null) return receipt;
  rethrowStepSettlementFailure(error);
}

function nonEmptyText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function commandNameFromExecutionCommand(value) {
  if (typeof value !== "string") return null;
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 4 || tokens[0] !== "sennel" || tokens[1] !== "flow" || tokens[2] !== "run") return null;
  return tokens[3] || null;
}

function lifecycleActionFor(state) {
  if (!state || state.current === null || state.attempt === null) return null;
  const nodeId = state.current.at(-1);
  const node = state.findNode(nodeId);
  if (node?.status !== "in_progress" || state.attempt.failure !== null) return null;
  const action = state.definition.actionFor(nodeId, state.root);
  const commandName = commandNameFromExecutionCommand(action.executionCommand);
  if (commandName === null) return null;
  return { nodeId, action, commandName };
}

function failureFacts(error, fallbackCode) {
  const responseProtocolEvidence = error?.data?.responseProtocolEvidence == null
    ? null
    : AgentResponseProtocolEvidence.from(error.data.responseProtocolEvidence);
  if (error?.errors && Array.isArray(error.errors)) {
    const fatal = error.errors.find((entry) => entry?.level === "fatal") || error.errors[0];
    if (fatal) {
      const messages = Array.isArray(fatal.messages) ? fatal.messages : [fatal.messages];
      return {
        code: nonEmptyText(fatal.code || fallbackCode, "lifecycle failure code"),
        message: nonEmptyText(messages.filter((message) => typeof message === "string").join("; ") || String(error), "lifecycle failure message"),
        responseProtocolEvidence,
      };
    }
  }
  return {
    code: nonEmptyText(error?.code || fallbackCode, "lifecycle failure code"),
    message: nonEmptyText(error?.message || String(error), "lifecycle failure message"),
    responseProtocolEvidence,
  };
}

function hasPublishedCurrentTaskGateResult(flowManager, state, expectedAttempt) {
  const nodeId = state.current?.at(-1) ?? null;
  const taskStep = TaskStepIdentity.fromStateNode(
    flowManager.loadReadOnly(state.specId),
    nodeId,
  );
  if (taskStep?.definitionId !== "task-gate" || !expectedAttempt.matches(state)) return false;
  const source = flowManager.readProducerArtifact({
    specId: state.specId,
    nodeId,
    logicalKey: "task.gate",
    parameters: { taskId: taskStep.taskId },
    optional: true,
  });
  if (source === null) return false;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "task.gate",
    bytes: source.bytes,
  });
  return history.current.attempt === expectedAttempt.sequence;
}

/** One exact definition-owned command attempt, captured before pre hooks. */
export class DefinitionLifecycleAttemptBinding {
  constructor({ specId, runId, commandName, attempt, state, flowManager } = {}) {
    this.specId = nonEmptyText(specId, "definition lifecycle binding.specId");
    this.runId = nonEmptyText(runId, "definition lifecycle binding.runId");
    this.commandName = nonEmptyText(commandName, "definition lifecycle binding.commandName");
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.state = state;
    this.flowManager = flowManager;
    Object.freeze(this);
  }

  static capture({ hookCtx, envelopeType, envelopeKey, registryFailureOwnership = null } = {}) {
    if (
      envelopeType !== "run"
      || !hookCtx?.flowManager
      || typeof hookCtx.flowManager.canonicalState !== "function"
      || typeof hookCtx.flowManager.failCurrentAttemptIfCurrent !== "function"
      || !hookCtx?.specId
      || !(registryFailureOwnership instanceof DefinitionFailureOwnership)
      || !registryFailureOwnership.allowsDispatcherFallback()
    ) return null;
    const state = hookCtx.flowManager.canonicalState(hookCtx.specId);
    const action = lifecycleActionFor(state);
    if (
      action === null
      || action.commandName !== envelopeKey
      || !registryFailureOwnership.equals(action.action.failureOwnership)
    ) return null;
    return new DefinitionLifecycleAttemptBinding({
      specId: state.specId,
      runId: state.runId,
      commandName: action.commandName,
      attempt: state.attempt,
      state,
      flowManager: hookCtx.flowManager,
    });
  }

  toolingFailure(error, fallbackCode, commandResult = null) {
    if (isStepPersistenceFailure(error) || isStepAdmissionRefusal(error)) return false;
    const facts = failureFacts(error, fallbackCode);
    const state = this.flowManager.canonicalState(this.specId);
    if (state === null || state.runId !== this.runId || !this.attempt.matches(state)) return false;
    // A published Task Gate result has crossed the producer boundary. Its
    // Definition-owned settlement must resume from catalog evidence; a
    // dispatcher fallback may not overwrite it as a tooling failure.
    if (hasPublishedCurrentTaskGateResult(this.flowManager, state, this.attempt)) return false;
    const action = lifecycleActionFor(state);
    if (action === null || action.nodeId !== this.attempt.nodeId) return false;
    const taskStep = TaskStepIdentity.fromStateNode(
      this.flowManager.loadReadOnly(this.specId),
      action.nodeId,
    );
    const contract = state.definition.contractFor(this.attempt.nodeId, state.root);
    const retryable = ["retry", "retry-block"].includes(action.action.failurePolicy.value)
      && contract.remainingRetries(state.attempt.consumption, "tooling") > 0;
    let taskReviewAbortedWorkUnit = null;
    if (taskStep?.definitionId === "task-review") {
      const worker = attachedCanonicalReviewWorkUnit(commandResult);
      if (worker !== null) taskReviewAbortedWorkUnit = TaskReviewAbortedWorkUnit.forAttempt(worker, state.attempt);
    }
    return this.flowManager.failCurrentAttemptIfCurrent({
      specId: this.specId,
      expectedRunId: this.runId,
      expectedAttempt: this.attempt,
      failure: {
        category: "tooling",
        code: facts.code,
        message: facts.message,
        retryable,
        retryKind: retryable ? "tooling" : null,
        ...(facts.responseProtocolEvidence === null ? {} : {
          responseProtocolEvidence: facts.responseProtocolEvidence,
        }),
      },
      result: {
        outcome: "failed",
        summary: facts.message,
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      ...(taskReviewAbortedWorkUnit === null ? {} : { taskReviewAbortedWorkUnit }),
      ...(taskStep?.definitionId === "task-gate" ? {
          taskGateFallback: {
            nodeId: action.nodeId,
            taskId: taskStep.taskId,
          },
        } : {}),
    });
  }

}
