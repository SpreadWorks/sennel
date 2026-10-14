import { ImplPhaseResultContract } from "./phase-result-contract.js";

export const finalizationPhaseResultContracts = Object.freeze([
  ["finalize-commit", "FinalizeCommitExecutionRequiredResult", "finalize-commit-execution-required", "loop-required"],
  ["finalize-commit", "FinalizeCommitCreatedResult", "finalize-commit-created", "completed"],
  ["finalize-commit", "FinalizeCommitUnchangedResult", "finalize-commit-unchanged", "completed"],
  ["finalize-merge", "FinalizeMergeExecutionRequiredResult", "finalize-merge-execution-required", "loop-required"],
  ["finalize-merge", "FinalizeMergeSquashedResult", "finalize-merge-squashed", "completed"],
  ["finalize-merge", "FinalizeMergePolicySkippedResult", "finalize-merge-policy-skipped", "completed"],
  ["finalize-merge", "FinalizeMergePrOpenedResult", "finalize-merge-pr-opened", "completed"],
  ["finalize-sync", "FinalizeSyncExecutionRequiredResult", "finalize-sync-execution-required", "loop-required"],
  ["finalize-sync", "FinalizeSyncBuiltResult", "finalize-sync-built", "completed"],
  ["finalize-sync", "FinalizeSyncUnchangedResult", "finalize-sync-unchanged", "completed"],
  ["finalize-sync", "FinalizeSyncSkippedWithWarningResult", "finalize-sync-skipped-with-warning", "completed"],
  ["finalize-cleanup", "FinalizeCleanupExecutionRequiredResult", "finalize-cleanup-execution-required", "loop-required"],
  ["finalize-cleanup", "FinalizeCleanupCompletedResult", "finalize-cleanup-completed", "completed"],
  ["finalize-cleanup", "FinalizeCleanupCompletedWithWarningResult", "finalize-cleanup-completed-with-warning", "completed"],
  ...["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]
    .map((id) => [id, "StepErrorResult", `${id}-error`, "error"]),
].map((entry) => new ImplPhaseResultContract(...entry, "0717")));
