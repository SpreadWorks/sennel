import { guardFlagsForState } from "./user-action-prompt.js";
import { FlowTargetBinding } from "../../lib/flow-target-guard.js";

const MAX_COMMAND_LENGTH = 4000;

function requireCommand(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("command must be a non-empty string");
  }
  const command = value.trim();
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`);
  }
  return command;
}

export function guardedCommand(command, state, binding = null) {
  const normalized = requireCommand(command);
  if (binding) return binding.guardCommand(normalized);
  const guards = guardFlagsForState(state);
  return `${normalized}${guards ? ` ${guards}` : ""}`;
}

export function flowTargetBindingForContext(ctx) {
  if (ctx?.flowCommandBoundary !== true) return null;
  return FlowTargetBinding.captureContext(ctx);
}
