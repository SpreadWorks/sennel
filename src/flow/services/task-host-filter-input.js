import { TaskReviewStageFacts } from "../lib/task-review-stage-transition.js";
import { ImplementationTaskFrontier } from "../lib/source-effect-values.js";
import { TaskReviewHostFilter, TaskHostFilterAuthority } from "../lib/task-review-host-filter-values.js";

/** One host decision acquired and verified outside the Service. */
export class TaskHostFilterInput {
  constructor({ facts = null, filter = null, frontier = null, authority = null }) {
    if (authority !== null) {
      if (!(authority instanceof TaskHostFilterAuthority) || facts !== null || filter !== null) throw new TypeError("Host filter request requires acquired authority only");
    } else if (!(facts instanceof TaskReviewStageFacts) || facts.binding.stage !== "triage"
      || !(frontier instanceof ImplementationTaskFrontier)
      || !(filter instanceof TaskReviewHostFilter)
      || facts.binding.taskId !== filter.binding.taskId
      || facts.binding.runId !== filter.binding.runId
      || facts.binding.specId !== filter.binding.specId
      || facts.binding.catalogFingerprint !== filter.catalogFingerprint
      || facts.binding.attemptId !== filter.attempt.id
      || facts.binding.attemptSequence !== filter.attempt.sequence
      || facts.binding.sourceFingerprint !== filter.binding.sourceFingerprint
      || facts.taskRound !== filter.binding.taskRound
      || facts.reviewResultCount !== filter.binding.reviewOrdinal) {
      throw new TypeError("Task host filter input requires its exact canonical episode and decision");
    }
    this.facts = facts;
    this.authority = authority;
    this.frontier = frontier;
    this.filter = filter;
    this.stepId = "task-triage";
    Object.freeze(this);
  }
}
