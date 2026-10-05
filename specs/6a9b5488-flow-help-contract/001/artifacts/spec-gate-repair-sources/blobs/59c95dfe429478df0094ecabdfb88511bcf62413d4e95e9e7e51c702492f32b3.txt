import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { TaskReviewHostFilter } from "./task-review-host-filter.js";

/** Host-owned, one-shot Task Review finding exclusion boundary. */
export default class RunFilterTaskReviewCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }

  execute(ctx) {
    try {
      const exclusions = TaskReviewHostFilter.parseExclusions(ctx.exclusions);
      const next = ctx.flowManager.confirmTaskReviewHostFilter({
        specId: ctx.specId,
        exclusions,
        expectAttemptId: ctx.expectAttemptId,
        expectReviewDigest: ctx.expectReviewDigest,
        expectSourceFingerprint: ctx.expectSourceFingerprint,
        expectCatalogFingerprint: ctx.expectCatalogFingerprint,
      });
      return Envelope.ok("run", "filter-task-review", {
        taskId: next.current?.at(-2) ?? null,
        nextStep: next.current?.at(-1) ?? null,
        excludedFindingIds: exclusions.map((entry) => entry.findingId),
      });
    } catch (error) {
      return Envelope.fail(
        "run", "filter-task-review", error.code || "TASK_REVIEW_FILTER_NOT_ADMITTED", error.message,
      );
    }
  }
}
