const RETRY_OPERATIONS = new Set(["retry_attempt", "retry_recovery_attempt"]);
const ENTRY_OPERATIONS = new Set([
  "start_attempt",
  "rewind",
  "rewind_test_evidence",
  "plan_gate_repair",
  "recover_attempt",
  ...RETRY_OPERATIONS,
]);

export class RepairAttemptLineageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepairAttemptLineageError";
  }
}

function entryTargetsStep(activity, targetStepId) {
  return activity.nodeId === targetStepId;
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
    throw new RepairAttemptLineageError(
      `canonical repair lineage requires exactly one entry Activity for ${targetStepId} Attempt ${attempt.id}`,
    );
  }
  return matches[0];
}

function predecessorAttempt({ activities, attempt, targetStepId }) {
  const sequence = attempt.sequence - 1;
  if (sequence < 1) {
    throw new RepairAttemptLineageError("canonical repair retry lineage has no predecessor sequence");
  }
  const matches = activities.filter((activity) => (
    ENTRY_OPERATIONS.has(activity?.transition?.operation)
    && entryTargetsStep(activity, targetStepId)
    && activity.transition?.attempt?.nodeId === targetStepId
    && activity.transition.attempt?.sequence === sequence
  ));
  if (matches.length !== 1) {
    throw new RepairAttemptLineageError(
      `canonical repair retry lineage requires exactly one ${targetStepId} Attempt at sequence ${sequence}`,
    );
  }
  const predecessor = matches[0].transition.attempt;
  if (typeof predecessor.id !== "string" || predecessor.id === "") {
    throw new RepairAttemptLineageError("canonical repair retry predecessor Attempt id is invalid");
  }
  return predecessor;
}

/**
 * Resolves the recovery Activity that owns the current worker Attempt.
 * Retry Activities introduce new Attempt identities. Their Activity attempt
 * fields differ between retry forms, so the predecessor is resolved solely
 * through the ledger's contiguous per-node Attempt sequence. Every other
 * entry starts a new lineage.
 */
export function canonicalRepairAttemptOwner({ state, activities, targetStepId } = {}) {
  if (state?.schemaRevision !== 3 || state.current?.at(-1) !== targetStepId || state.attempt == null) return null;
  if (!Array.isArray(activities)) throw new RepairAttemptLineageError("canonical repair lineage requires an Activity ledger");

  let attempt = state.attempt;
  const visited = new Set();
  while (true) {
    const identity = `${attempt.id}:${attempt.sequence}`;
    if (visited.has(identity)) throw new RepairAttemptLineageError("canonical repair lineage contains a retry cycle");
    visited.add(identity);

    const entry = matchingEntry({ activities, attempt, targetStepId });
    if (!RETRY_OPERATIONS.has(entry.transition.operation)) return entry;
    attempt = predecessorAttempt({ activities, attempt, targetStepId });
  }
}
