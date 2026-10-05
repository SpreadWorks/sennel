import { FlowCommand } from "./base-command.js";
import {
  activateNonBlockingPolicy,
} from "./nonblocking.js";
import { nonblockingFailureEnvelope } from "./nonblocking-command-failure.js";
import { flowTargetBindingForContext } from "./guarded-command.js";

export default class SetPolicyCommand extends FlowCommand {
  execute(ctx) {
    if (ctx.value !== "nonblocking") throw new Error("usage: sennel flow set policy nonblocking --reason <text>");
    const binding = flowTargetBindingForContext(ctx);
    try {
      return activateNonBlockingPolicy({ root: ctx.root, flowManager: ctx.flowManager, reason: ctx.reason, binding });
    } catch (error) {
      return nonblockingFailureEnvelope({
        type: "set",
        key: "policy",
        error,
        state: ctx.flowState,
        binding,
      });
    }
  }
}
