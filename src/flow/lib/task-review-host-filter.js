import { CurrentTaskSourceSnapshot, TaskMutationLineageSet } from "./task-mutation-lineage.js";
import { TaskReviewHostFilter } from "./task-review-host-filter-values.js";

export { TaskReviewFindingExclusion, TaskReviewHostFilter, TaskHostFilterAuthority } from "./task-review-host-filter-values.js";

/** Rechecks the host decision under the canonical catalog transaction lock. */
export class TaskReviewHostFilterPublicationAdmission {
  constructor({ root, lineageSet, filter } = {}) {
    if (!(lineageSet instanceof TaskMutationLineageSet) || !(filter instanceof TaskReviewHostFilter)) {
      throw new Error("Task Review filter publication requires typed canonical authority");
    }
    this.root = root;
    this.lineageSet = lineageSet;
    this.filter = filter;
    Object.freeze(this);
  }

  assert(view) {
    const { filter } = this;
    const state = view.state;
    const review = view.catalog.artifacts.find((entry) => (
      entry.logicalKey === "task.review" && entry.relativePath === `steps/impl/${filter.binding.taskId}/review/result.json`
    )) ?? null;
    if (state.runId !== filter.binding.runId || state.specId !== filter.binding.specId
      || state.current?.at(-1) !== filter.attempt.nodeId
      || state.attempt?.id !== filter.attempt.id || state.attempt?.sequence !== filter.attempt.sequence
      || view.catalog.hash !== filter.catalogFingerprint
      || review?.hash !== filter.binding.review.digest
      || review?.activityId !== filter.binding.review.activityId) {
      throw new Error("Task Review filter Attempt, Review, or catalog binding changed before publication");
    }
    const source = CurrentTaskSourceSnapshot.capture({ root: this.root, lineageSet: this.lineageSet });
    if (source.fingerprint !== filter.binding.sourceFingerprint) {
      throw new Error("Task Review filter source binding changed before publication");
    }
  }
}
