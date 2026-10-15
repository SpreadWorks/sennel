import { Envelope } from "../../lib/flow-envelope.js";
import {
  FlowContinuation,
} from "./user-action-prompt.js";
import { guardedCommand } from "./guarded-command.js";
import { FlowTargetBinding } from "../../lib/flow-target-guard.js";

export function nonblockingFailureContinuation({ state, error, binding = null, targetContext = null, required = false }) {
  if (error?.continuation) return FlowContinuation.fromStored(error.continuation);
  if (!required && state?.policy?.nonblocking?.enabled !== true) return null;
  const selectedBinding = binding ?? (targetContext === null ? null : FlowTargetBinding.captureContext(targetContext, state));
  return new FlowContinuation({
    actionId: "REFRESH_NONBLOCKING_FLOW",
    nextAction: guardedCommand("sennel flow get next-action", state || {}, selectedBinding),
    instruction: "Refresh the guarded normal Flow action before retrying the nonblocking operation.",
    reason: error?.message || "The nonblocking operation did not complete.",
  });
}

export function nonblockingFailureEnvelope({ type, key, error, state, binding = null }) {
  const continuation = nonblockingFailureContinuation({ state, error, binding, required: true });
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
