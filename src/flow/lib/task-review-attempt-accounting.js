import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskExecutionBudget } from "./task-execution-policy.js";

export const MAX_TASK_REVIEW_ATTEMPTS = 4;

function assertCount(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TASK_REVIEW_ATTEMPTS) {
    throw new Error("accepted Task Review count is outside the current Task round");
  }
  return count;
}

/** Count accepted semantic Review results without charging tooling retries. */
export function currentTaskReviewAttemptCount({ attempt, includesCurrentResult = false } = {}) {
  const semanticRetries = attempt?.consumption?.semantic;
  if (!Number.isSafeInteger(semanticRetries) || semanticRetries < 0) {
    throw new Error("Task Review Attempt has invalid semantic retry accounting");
  }
  return assertCount(semanticRetries + (includesCurrentResult ? 1 : 0));
}

function acceptedAttemptSequences(history, budget) {
  if (!(history instanceof CanonicalCommandAttemptArtifactHistory)) {
    throw new Error("Task Review attempt accounting requires canonical Attempt history");
  }
  if (!(budget instanceof TaskExecutionBudget)) {
    throw new Error("Task Review attempt accounting requires a Task execution budget");
  }
  return history.attempts
    .map((entry) => entry.attempt)
    .filter((sequence) => sequence > budget.reviewAttemptSequenceAtStart);
}

/** Count cataloged Review results in the current Task execution round. */
export function completedTaskReviewAttemptCount({ history, budget } = {}) {
  return assertCount(acceptedAttemptSequences(history, budget).length);
}

/** Resolve one cataloged Review result's semantic ordinal within its Task round. */
export function taskReviewAttemptNumber({ history, budget, attemptSequence } = {}) {
  if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 1) {
    throw new Error("Task Review attempt sequence is invalid");
  }
  const accepted = acceptedAttemptSequences(history, budget);
  const index = accepted.indexOf(attemptSequence);
  if (index < 0) throw new Error("Task Review result is outside its Task execution round");
  // A caller inspecting an older round may also see later-round artifacts.
  // Return their ordinal so that the caller can exclude values above its
  // definition-owned limit without confusing an Attempt sequence gap with a
  // semantic Review count.
  return index + 1;
}
