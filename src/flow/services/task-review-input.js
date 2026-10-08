import { ReviewStepFailureObservation } from "../lib/review-step-failure-values.js";
import { TaskReviewStageFacts } from "../lib/task-review-stage-transition.js";
import { ReviewWorkUnitManifest, ReviewWorkUnitOutput } from "../lib/review-work-unit-values.js";
import { ImplementationTaskFrontier } from "../lib/source-effect-values.js";
import { TaskStepIdentity } from "../lib/task-step-identity.js";

/** Acquired canonical Task Review observations or one exact immutable work unit. */
export class TaskReviewInput {
  constructor({ facts = null, manifest = null, frontier = null, failure = null }) {
    if (failure !== null) {
      if (!(failure instanceof ReviewStepFailureObservation) || failure.stepId !== "task-review" || facts !== null || manifest !== null) throw new TypeError("Task Review requires its acquired failure observation");
    } else if (manifest === null
      ? !(facts instanceof TaskReviewStageFacts) || facts.binding.stage !== "review" || !(frontier instanceof ImplementationTaskFrontier)
      : facts !== null || !(manifest instanceof ReviewWorkUnitManifest) || manifest.taskId === null
        || manifest.phase !== "impl"
        || !manifest.output.equals(ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: manifest.taskId }))
        || ["spec.record", "task.spec", "task.context", "task.source", "task.source-effect-baseline", "task.canonical-observation"]
          .some((key) => !manifest.inputs.some((input) => input.logicalKey === key))
        || !new TaskStepIdentity({ taskId: manifest.taskId, role: "review" }).matchesNode(manifest.nodeId)) {
      throw new TypeError("Task Review input requires canonical stage evidence or an exact Task work unit");
    }
    this.failure = failure;
    this.facts = facts;
    this.frontier = frontier;
    this.manifest = manifest;
    this.stepId = "task-review";
    Object.freeze(this);
  }
}
