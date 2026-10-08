import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { TaskReviewHostFilter } from "./task-review-host-filter-values.js";
import { taskStepRegistration } from "../engine/composition/task.js";

export function executeHostFilterInput(input) {
  const registration = taskStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Host filter execution requires a registered Task Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

/** Host-owned, one-shot Task Review finding exclusion boundary. */
export default class RunFilterTaskReviewCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }

  execute(ctx) {
    try {
      const exclusions = TaskReviewHostFilter.parseExclusions(ctx.exclusions);
      const outcome = executeHostFilterInput({ ...ctx, ctx, flowManager: ctx.flowManager,
        exclusions, stepId: "task-triage" });
      const next = ctx.flowManager.canonicalState(ctx.specId);
      return Envelope.ok("run", "filter-task-review", {
        taskId: outcome.receipt.binding.stepId === "task-triage" ? next.current?.at(-2) ?? null : null,
        nextStep: next.current?.at(-1) ?? null,
        excludedFindingIds: exclusions.map((entry) => entry.findingId),
      });
    } catch (error) {
      return Envelope.fail("run", "filter-task-review", error.code || "TASK_REVIEW_FILTER_NOT_ADMITTED", error.message);
    }
  }
}
