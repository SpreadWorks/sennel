import {
  FinalizeCommitExecutionRequiredResult, FinalizeCommitCreatedResult, FinalizeCommitUnchangedResult,
  FinalizeMergeExecutionRequiredResult, FinalizeMergeSquashedResult, FinalizeMergePolicySkippedResult, FinalizeMergePrOpenedResult,
  FinalizeSyncExecutionRequiredResult, FinalizeSyncBuiltResult, FinalizeSyncUnchangedResult, FinalizeSyncSkippedWithWarningResult,
  FinalizeCleanupExecutionRequiredResult, FinalizeCleanupCompletedResult, FinalizeCleanupCompletedWithWarningResult,
} from "../../engine/step-result.js";

function hasWarnings(result) {
  return result.warning === true || result.outcome === "completed_with_warnings"
    || result.outcome === "skipped_with_warnings"
    || [result.warnings, result.finalizeWarnings].some((entries) => Array.isArray(entries) && entries.length > 0);
}

/** Interpret acquired command observations once, for Step selection and Store verification. */
function observedOutcome(evidence) {
  const result = evidence.commandResult;
  if (result === null) return evidence.outcome;
  if (result.ok === false) throw new TypeError("A refused finalization command is not a Step outcome");
  let outcome;
  switch (evidence.stepId) {
    case "finalize-commit":
      if (result.status === "done") outcome = "created";
      else if (result.status === "skipped") outcome = "unchanged";
      break;
    case "finalize-merge":
      if (result.strategy === "skip" && result.status === "skipped") outcome = "policy-skipped";
      else if (result.strategy === "pr" && result.status === "done") outcome = "pr-opened";
      else if (result.strategy === "squash" && result.status === "done") outcome = "squashed";
      break;
    case "finalize-sync":
      if (result.status === "done") outcome = "built";
      else if (result.status === "skipped") outcome = hasWarnings(result) ? "skipped-with-warning" : "unchanged";
      break;
    case "finalize-cleanup": {
      const data = result.data ?? result;
      if (data.status === "done") outcome = hasWarnings(result) || hasWarnings(data) ? "completed-with-warning" : "completed";
      break;
    }
  }
  if (outcome === undefined) throw new TypeError(`Unrecognized ${evidence.stepId} command observation`);
  if (evidence.outcome !== null && evidence.outcome !== outcome) {
    throw new TypeError("Finalization outcome contradicts its acquired command observation");
  }
  return outcome;
}

/** Sole semantic conversion shared by pure Steps and canonical evidence validation. */
export function finalizationResultForEvidence(evidence) {
  const outcome = observedOutcome(evidence);
  switch (evidence.stepId) {
    case "finalize-commit":
      switch (outcome) {
        case "pending": return new FinalizeCommitExecutionRequiredResult({ execution: evidence.execution });
        case "created": return new FinalizeCommitCreatedResult();
        case "unchanged": return new FinalizeCommitUnchangedResult();
      }
      break;
    case "finalize-merge":
      switch (outcome) {
        case "pending": return new FinalizeMergeExecutionRequiredResult({ execution: evidence.execution });
        case "squashed": return new FinalizeMergeSquashedResult();
        case "policy-skipped": return new FinalizeMergePolicySkippedResult();
        case "pr-opened": return new FinalizeMergePrOpenedResult();
      }
      break;
    case "finalize-sync":
      switch (outcome) {
        case "pending": return new FinalizeSyncExecutionRequiredResult({ execution: evidence.execution });
        case "built": return new FinalizeSyncBuiltResult();
        case "unchanged": return new FinalizeSyncUnchangedResult();
        case "skipped-with-warning": return new FinalizeSyncSkippedWithWarningResult();
      }
      break;
    case "finalize-cleanup":
      switch (outcome) {
        case "pending": return new FinalizeCleanupExecutionRequiredResult({ execution: evidence.execution });
        case "completed": return new FinalizeCleanupCompletedResult();
        case "completed-with-warning": return new FinalizeCleanupCompletedWithWarningResult();
      }
      break;
  }
  throw new TypeError("Finalization requires a recognized typed operation observation");
}
