import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { prepareTaskReviewReconciliation, applyTaskReviewReconciliation } from "./task-review-reconciliation.js";

export default class RunReconcileTaskReviewCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }
  execute(ctx) {
    try {
      const specId = ctx.specId ?? ctx.flowState?.specId;
      const state = ctx.flowManager.canonicalState(specId);
      if (ctx.expectRunId !== state.runId || ctx.expectSpec !== state.specId
        || (state.issue === null ? ctx.expectNoIssue !== true : Number(ctx.expectIssue) !== state.issue)) {
        throw new Error("Task Review reconciliation requires explicit matching run, spec, and issue guards");
      }
      const input = { flowManager: ctx.flowManager, specId, root: ctx.executionRoot || ctx.root };
      if (ctx.dryRun === true) {
        const proposal = prepareTaskReviewReconciliation(input);
        return Envelope.ok("run", "reconcile-task-review", {
          dryRun: true, digest: proposal.digest, taskId: proposal.taskId, attempt: proposal.previousAttempt,
          archivedWorkUnits: proposal.workUnits.length, semantics: "adopt current input as unreviewed; preserve failed evidence; grant one reevaluation",
        });
      }
      const result = applyTaskReviewReconciliation({ ...input, expectDigest: ctx.expectDigest, reason: ctx.reason, yes: ctx.yes });
      return Envelope.ok("run", "reconcile-task-review", { prepared: true, current: result.current, attempt: result.attempt, workerStarted: false });
    } catch (error) {
      return Envelope.fail("run", "reconcile-task-review", "TASK_REVIEW_RECONCILIATION_NOT_ADMITTED", error.message);
    }
  }
}
