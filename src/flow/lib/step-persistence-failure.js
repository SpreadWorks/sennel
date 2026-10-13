/** Shared Store failure classification and exact settlement receipt recovery. */
import { CurrentFlowStateInvariantError } from "./current-flow-state.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { StepAdmissionRefusal, isStepAdmissionRefusal } from "./step-admission-refusal.js";

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
