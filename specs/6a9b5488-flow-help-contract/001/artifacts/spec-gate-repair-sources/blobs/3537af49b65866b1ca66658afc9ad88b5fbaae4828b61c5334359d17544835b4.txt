import { FlowCommand } from "./base-command.js";
import { recordNonBlockingDecision } from "./nonblocking.js";
import { nonblockingFailureEnvelope } from "./nonblocking-command-failure.js";
import { flowTargetBindingForContext } from "./guarded-command.js";

export default class SetNonBlockingDecisionCommand extends FlowCommand {
  execute(ctx) {
    const binding = flowTargetBindingForContext(ctx);
    try {
      return recordNonBlockingDecision({
        root: ctx.root,
        flowManager: ctx.flowManager,
        choice: ctx.choice,
        reason: ctx.reason,
        expectEvidenceDigest: ctx.expectEvidenceDigest,
        remainingRisk: ctx.remainingRisk,
        binding,
      });
    } catch (error) {
      return nonblockingFailureEnvelope({
        type: "set",
        key: "nonblocking-decision",
        error,
        state: ctx.flowState,
        binding,
      });
    }
  }
}
