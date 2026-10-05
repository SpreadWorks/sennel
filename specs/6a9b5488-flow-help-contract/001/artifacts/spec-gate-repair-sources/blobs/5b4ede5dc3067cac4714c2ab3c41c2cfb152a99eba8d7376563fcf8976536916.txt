import { Envelope } from "../../lib/flow-envelope.js";
import {
  FlowContinuation,
} from "./user-action-prompt.js";
import { guardedCommand } from "./guarded-command.js";

function fallbackContinuation(state, error, binding = null) {
  if (error?.continuation) return FlowContinuation.fromStored(error.continuation);
  return new FlowContinuation({
    actionId: "REFRESH_NONBLOCKING_FLOW",
    nextAction: guardedCommand("sennel flow get next-action", state || {}, binding),
    instruction: "Refresh the guarded normal Flow action before retrying the nonblocking operation.",
    reason: error?.message || "The nonblocking operation did not complete.",
  });
}

export function nonblockingFailureEnvelope({ type, key, error, state, binding = null }) {
  const continuation = fallbackContinuation(state, error, binding);
  return Envelope.fail(
    type,
    key,
    error?.code || "NONBLOCKING_OPERATION_FAILED",
    error?.message || "The nonblocking operation did not complete.",
    {
      ...(error?.context && { nonblockingDecision: error.context }),
      ...(error?.existingDecision && { existingDecision: error.existingDecision }),
      continuation: continuation.toJSON(),
    },
  );
}
