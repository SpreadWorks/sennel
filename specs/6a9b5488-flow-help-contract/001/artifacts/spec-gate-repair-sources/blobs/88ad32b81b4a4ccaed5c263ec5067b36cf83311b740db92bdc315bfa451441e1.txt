/**
 * Canonical semantic accounting for one Task Review execution round.
 *
 * Attempt sequence is a transport/lifecycle clock: provider retries and
 * recovery can advance it without producing a Review result.  The semantic
 * Review budget instead consists only of durable `task.review` history
 * entries published after this round's implementation budget began.
 */
import {
  CurrentAttemptIdentity,
  CurrentFlowState,
} from "./current-flow-state.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskExecutionBudget } from "./task-execution-policy.js";

const MAXIMUM_TASK_REVIEW_RESULTS = 4;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function taskReviewDescriptor({ flowManager, state, taskId }) {
  const expectedPath = `steps/impl/${taskId}/review/result.json`;
  const matches = flowManager.artifactCatalog(state.specId).artifacts.filter((entry) => (
    entry.logicalKey === "task.review" && entry.relativePath === expectedPath
  ));
  if (matches.length > 1) throw new Error("Task Review has duplicate canonical result publications");
  return matches[0] ?? null;
}

function historyFromCatalog({ flowManager, state, taskId }) {
  const descriptor = taskReviewDescriptor({ flowManager, state, taskId });
  if (descriptor === null) return null;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "task.review",
    bytes: flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "task.review",
      parameters: { taskId },
      consumerNodeId: "system",
    }).bytes,
  });
  const publication = flowManager.activityLedger(state.specId)
    .find((activity) => activity.id === descriptor.activityId) ?? null;
  const current = history.current;
  if (
    publication?.nodeId !== `${taskId}-review`
    || publication.attemptId === null
    || publication.attemptId === undefined
    || publication.attemptId === ""
    || publication.sequence !== current.attempt
  ) {
    throw new Error("Task Review canonical result history is not bound to its catalog publication");
  }
  return history;
}

function currentBudget({ flowManager, state, taskId }) {
  const lineages = flowManager.taskMutationLineages({ specId: state.specId, taskId });
  const budget = lineages.at(-1)?.budget ?? null;
  if (!(budget instanceof TaskExecutionBudget)) {
    throw new Error("Task Review requires a canonical Task execution budget");
  }
  return budget;
}

/**
 * A read-only, typed view of completed semantic results and the one currently
 * executable ordinal.  It deliberately does not use Attempt consumption:
 * semantic retry accounting and Task Review's four-result contract differ.
 */
export class TaskReviewAccounting {
  constructor({ taskId, budget, history = null, activeAttempt = null, roundEndAttemptSequence = null } = {}) {
    this.taskId = text(taskId, "Task Review accounting taskId");
    this.budget = budget instanceof TaskExecutionBudget ? budget : new TaskExecutionBudget(budget);
    if (history !== null && !(history instanceof CanonicalCommandAttemptArtifactHistory)) {
      throw new Error("Task Review accounting history must be canonical");
    }
    this.history = history;
    this.activeAttempt = activeAttempt === null ? null : CurrentAttemptIdentity.from(activeAttempt);
    if (roundEndAttemptSequence !== null && (
      !Number.isSafeInteger(roundEndAttemptSequence)
      || roundEndAttemptSequence < this.budget.reviewAttemptSequenceAtStart
    )) {
      throw new Error("Task Review accounting round end is invalid");
    }
    this.roundEndAttemptSequence = roundEndAttemptSequence;
    if (this.activeAttempt !== null && this.activeAttempt.nodeId !== `${this.taskId}-review`) {
      throw new Error("Task Review accounting active Attempt does not match its Task");
    }
    const entries = (history?.attempts ?? []).filter((entry) => (
      entry.attempt > this.budget.reviewAttemptSequenceAtStart
      && (this.roundEndAttemptSequence === null || entry.attempt <= this.roundEndAttemptSequence)
    ));
    if (entries.length > MAXIMUM_TASK_REVIEW_RESULTS) {
      throw new Error("Task Review completed result count exceeds the current Task round budget");
    }
    this.completed = Object.freeze(entries.map((entry) => Object.freeze({
      attempt: entry.attempt,
      payload: entry.payload,
    })));
    this.completedReviewCount = this.completed.length;
    const publishedActive = this.activeAttempt !== null
      && this.completed.some((entry) => entry.attempt === this.activeAttempt.sequence);
    if (this.activeAttempt !== null && this.completed.some((entry) => entry.attempt > this.activeAttempt.sequence)) {
      throw new Error("Task Review accounting history is newer than its active Attempt");
    }
    this.inflightReviewOrdinal = this.activeAttempt === null || publishedActive
      ? null
      : this.completedReviewCount + 1;
    if (this.inflightReviewOrdinal !== null && this.inflightReviewOrdinal > MAXIMUM_TASK_REVIEW_RESULTS) {
      throw new Error("Task Review inflight ordinal exceeds the current Task round budget");
    }
    Object.freeze(this);
  }

  static fromCanonicalState({ flowManager, state, taskId } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new Error("Task Review accounting requires canonical Flow state");
    }
    const id = text(taskId, "Task Review accounting taskId");
    return new TaskReviewAccounting({
      taskId: id,
      budget: currentBudget({ flowManager, state, taskId: id }),
      history: historyFromCatalog({ flowManager, state, taskId: id }),
      activeAttempt: state.attempt,
    });
  }

  completedOrdinalForSequence(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Task Review completed ordinal requires an Attempt sequence");
    }
    const index = this.completed.findIndex((entry) => entry.attempt === sequence);
    return index < 0 ? null : index + 1;
  }

  requireInflightReviewOrdinal() {
    if (this.inflightReviewOrdinal === null) {
      throw new Error("Task Review has no unpublished active semantic Review ordinal");
    }
    return this.inflightReviewOrdinal;
  }
}
