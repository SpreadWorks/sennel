import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { DRAFT_STEP_ERROR_RECOVERY_OPERATION } from "./draft-worker-recovery.js";
const CONTINUATION_OPERATIONS = new Set(["retry_attempt", "retry_recovery_attempt", DRAFT_STEP_ERROR_RECOVERY_OPERATION]);
const ENTRY_OPERATIONS = new Set([
  "start_attempt",
  "confirm_attempt",
  "rewind",
  "rewind_test_evidence",
  "plan_gate_repair",
  "recover_attempt",
  "reopen_draft_preimplementation",
  "reopen_draft_task_addition",
  "reopen_draft_spec_correction",
  ...CONTINUATION_OPERATIONS,
]);

export class AttemptLineageError extends Error {
  constructor(message) {
    super(message);
    this.name = "AttemptLineageError";
  }
}

function entryTargetsStep(activity, targetStepId) {
  if (activity.transition?.operation === "confirm_attempt") {
    const receipt = activity.result?.draftSettlementReceipt;
    return receipt?.settlementKind === "target-connection"
      && receipt.targetStepId === targetStepId
      && activity.transition.attempt?.nodeId === targetStepId;
  }
  return activity.nodeId === targetStepId || (
    activity.transition?.operation === "plan_gate_repair"
    && activity.transition?.attempt?.nodeId === targetStepId
    && activity.result?.draftSettlementReceipt?.targetStepId === targetStepId
  );
}

function matchingEntry({ activities, attempt, targetStepId }) {
  const matches = activities.filter((activity) => (
    ENTRY_OPERATIONS.has(activity?.transition?.operation)
    && entryTargetsStep(activity, targetStepId)
    && activity.transition?.attempt?.id === attempt.id
    && activity.transition.attempt?.nodeId === targetStepId
    && activity.transition.attempt?.sequence === attempt.sequence
  ));
  if (matches.length !== 1) {
    throw new AttemptLineageError(
      `canonical Attempt lineage requires exactly one entry Activity for ${targetStepId} Attempt ${attempt.id}`,
    );
  }
  return matches[0];
}

function predecessorAttempt({ state, activities, attempt, targetStepId, entry }) {
  if (entry.transition.operation === DRAFT_STEP_ERROR_RECOVERY_OPERATION) {
    const recovery = entry.transition.draftStepErrorRecoveryReceipt;
    const binding = recovery?.binding;
    const failed = activities.find((activity) => activity.id === recovery?.failedActivityId);
    if (!binding || binding.runId !== state.runId || binding.specId !== state.specId
      || binding.stepId !== targetStepId || binding.attemptSequence !== attempt.sequence - 1
      || failed?.transition?.operation !== "fail_attempt" || failed.nodeId !== targetStepId
      || failed.attemptId !== binding.attemptId || failed.sequence !== binding.attemptSequence
      || failed.result?.draftSettlementReceipt?.id !== recovery.failureReceiptId) {
      throw new AttemptLineageError("canonical Attempt recovery lineage has no exact saved Error predecessor");
    }
    return matchingEntry({ activities, targetStepId,
      attempt: { id: binding.attemptId, sequence: binding.attemptSequence } }).transition.attempt;
  }
  const sequence = attempt.sequence - 1;
  if (sequence < 1) {
    throw new AttemptLineageError("canonical Attempt retry lineage has no predecessor sequence");
  }
  const matches = activities.filter((activity) => (
    ENTRY_OPERATIONS.has(activity?.transition?.operation)
    && entryTargetsStep(activity, targetStepId)
    && activity.transition?.attempt?.nodeId === targetStepId
    && activity.transition.attempt?.sequence === sequence
  ));
  if (matches.length !== 1) {
    throw new AttemptLineageError(
      `canonical Attempt retry lineage requires exactly one ${targetStepId} Attempt at sequence ${sequence}`,
    );
  }
  const predecessor = matches[0].transition.attempt;
  if (typeof predecessor.id !== "string" || predecessor.id === "") {
    throw new AttemptLineageError("canonical Attempt retry predecessor Attempt id is invalid");
  }
  return predecessor;
}

/**
 * Resolves the entry Activity that owns the current Attempt context.
 * Retry Activities resolve predecessors through contiguous per-node sequence.
 * Explicit Draft Step Error recovery retains its failed receipt's exact old
 * Attempt binding. Every other entry starts a new lineage.
 */
export function canonicalAttemptOwner({ state, activities, targetStepId } = {}) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || state.current?.at(-1) !== targetStepId || state.attempt == null) return null;
  if (!Array.isArray(activities)) throw new AttemptLineageError("canonical Attempt lineage requires an Activity ledger");

  let attempt = state.attempt;
  const visited = new Set();
  while (true) {
    const identity = `${attempt.id}:${attempt.sequence}`;
    if (visited.has(identity)) throw new AttemptLineageError("canonical Attempt lineage contains a retry cycle");
    visited.add(identity);

    const entry = matchingEntry({ activities, attempt, targetStepId });
    if (!CONTINUATION_OPERATIONS.has(entry.transition.operation)) return entry;
    attempt = predecessorAttempt({ state, activities, attempt, targetStepId, entry });
  }
}
