import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isConditionalDraftWorkerStep } from "./draft-conditional-worker.js";

export const DRAFT_WORKER_RECOVERY_OPERATION = "recover_draft_worker_execution";

const document = (value) => value?.toJSON?.() ?? value;

export class DraftWorkerRecoveryRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftWorkerRecoveryRefusal";
    this.code = "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE";
  }
}

/** The retained, unpublished execution lineage authorizing an explicit recovery. */
export class DraftWorkerRecoveryDecision {
  constructor({ state, activities }) {
    const stepId = state.current?.at(-1);
    const attempt = document(state.attempt);
    if (!isConditionalDraftWorkerStep(stepId) || attempt?.nodeId !== stepId
      || (attempt.failure !== null && (attempt.failure?.category !== "tooling"
        || attempt.failure.code !== "FLOW_DRAFT_EXECUTION_INPUT_STALE"
        || attempt.failure.retryable !== false))
      || state.lifecycle.state !== "active"
      || state.history?.execution === "dormant") {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires an active conditional Attempt with no failure or its retained INPUT_STALE failure");
    }
    const history = activities.map(document).filter((entry) => entry.nodeId === stepId
      && entry.attemptId === attempt.id && entry.sequence === attempt.sequence);
    const executions = history.filter((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle != null);
    const checkpointActivity = executions.at(-1);
    const claimActivity = executions.at(-2);
    const checkpointReceipt = checkpointActivity?.result.draftSettlementReceipt;
    const claimedReceipt = claimActivity?.result.draftSettlementReceipt;
    const checkpoint = checkpointReceipt?.executionLifecycle;
    const claimed = claimedReceipt?.executionLifecycle;
    if (checkpoint?.phase !== "checkpoint" || checkpoint.binding.kind !== "worker"
      || checkpoint.claim !== null || claimed?.phase !== "claimed"
      || claimed.binding.kind !== "worker" || claimed.claim?.kind !== "worker"
      || checkpoint.binding.executionGeneration !== claimed.binding.executionGeneration + 1
      || checkpoint.binding.inputDigest !== claimed.binding.inputDigest
      || checkpoint.binding.inputRevision !== claimed.binding.inputRevision
      || checkpointReceipt.settlementKind !== "execution"
      || !isDeepStrictEqual(checkpointReceipt.binding, claimedReceipt.binding)
      || !isDeepStrictEqual(checkpointActivity.result.stepResult, claimActivity.result.stepResult)) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires an unpublished rejected claim and its exact legacy checkpoint");
    }
    const binding = checkpointReceipt.binding;
    if (binding.runId !== state.runId || binding.specId !== state.specId
      || binding.stepId !== stepId || binding.attemptId !== attempt.id
      || binding.attemptSequence !== attempt.sequence) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery lineage belongs to another Flow or Attempt");
    }
    const failures = history.filter((entry) => entry.transition.operation === "fail_attempt");
    const failureMatches = attempt.failure === null ? failures.length === 0
      : failures.length === 1 && failures[0].confirmationOrder > checkpointActivity.confirmationOrder
        && isDeepStrictEqual(failures[0].failure, attempt.failure);
    if (!failureMatches
      || history.some((entry) => entry.transition.operation === DRAFT_WORKER_RECOVERY_OPERATION)) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires its retained checkpoint with no failure or exactly its subsequent stale failure");
    }
    this.stepId = stepId;
    this.checkpointReceipt = Object.freeze(structuredClone(checkpointReceipt));
    this.claim = Object.freeze(structuredClone(claimed.claim));
    this.activityId = `draft-worker-recovery-${createHash("sha256").update(JSON.stringify([
      state.runId, state.specId, attempt.id, attempt.sequence,
      checkpointActivity.id, claimActivity.id, failures[0]?.id ?? null,
    ])).digest("hex")}`;
    Object.freeze(this);
  }

  assertTransition({ activityId, previousAttempt, attempt, receipt }) {
    const lifecycle = receipt?.executionLifecycle;
    const old = this.checkpointReceipt;
    const { id: priorId, executionLifecycle: priorLifecycle, ...priorSelection } = old;
    const { id: nextId, executionLifecycle: nextLifecycle, ...nextSelection } = document(receipt) ?? {};
    if (activityId !== this.activityId
      || !isDeepStrictEqual(document(attempt), { ...document(previousAttempt), failure: null })
      || !isDeepStrictEqual(nextSelection, priorSelection)
      || lifecycle?.phase !== "checkpoint" || lifecycle.claim !== null
      || lifecycle.binding.kind !== "conditional-worker"
      || lifecycle.binding.executionGeneration !== old.executionLifecycle.binding.executionGeneration + 1
      || lifecycle.binding.inputDigest !== old.executionLifecycle.binding.inputDigest
      || lifecycle.binding.inputRevision !== old.executionLifecycle.binding.inputRevision) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery must preserve its exact Attempt and migrate only the proven checkpoint");
    }
  }
}

export function resolveDraftWorkerRecovery(facts) {
  return new DraftWorkerRecoveryDecision(facts);
}
