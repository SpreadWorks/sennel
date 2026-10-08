import { TaskStepIdentity } from "./task-step-identity.js";
import { TaskReviewStageFacts, TaskReviewStageMeaning } from "./task-review-stage-transition.js";
import { ImplementationTaskFrontier } from "./source-effect-values.js";

/** Canonical evidence interpreted by one Task Step; carries no selected route. */
export class TaskStageResultEvidence {
  #meaning;
  constructor({ facts, frontier }) {
    if (!(facts instanceof TaskReviewStageFacts) || !(frontier instanceof ImplementationTaskFrontier)
      || !frontier.entries.some((entry) => entry.taskId.toString() === facts.binding.taskId)) {
      throw new TypeError("Task stage Result evidence requires canonical stage facts");
    }
    this.#meaning = new TaskReviewStageMeaning(facts);
    this.facts = facts;
    this.frontier = frontier;
    this.taskIdentity = new TaskStepIdentity({ taskId: facts.binding.taskId, role: facts.binding.stage });
    this.taskId = this.taskIdentity.taskId;
    this.taskRound = facts.taskRound;
    this.reviewOrdinal = facts.reviewResultCount;
    this.sourceFingerprint = facts.binding.sourceFingerprint;
    Object.freeze(this);
  }

  get resultKind() { return this.#meaning.resultKind; }
  assertResultKind(kind) { this.#meaning.assertResultKind(kind); return this; }

  toJSON() { return { version: 1, facts: this.facts.toJSON(), frontier: this.frontier.toJSON() }; }

  static fromJSON(value) {
    if (value?.version !== 1 || Object.keys(value).length !== 3) throw new TypeError("invalid Task stage Result evidence");
    return new TaskStageResultEvidence({ facts: new TaskReviewStageFacts(value.facts),
      frontier: ImplementationTaskFrontier.fromJSON(value.frontier) });
  }
}
