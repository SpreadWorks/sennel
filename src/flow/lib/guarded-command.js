import { FlowExecutionCommand } from "./flow-execution-command.js";
import { guardFlagsForState, guardArgumentsForState } from "./user-action-prompt.js";
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

/** Bind semantic argv at projection time; execution uses the bound value as-is. */
export function guardedExecutionCommand(command, state, binding = null) {
  if (!(command instanceof FlowExecutionCommand)) throw new TypeError("guarded execution requires FlowExecutionCommand");
  if (binding !== null) return command.bindTarget(binding);
  return new FlowExecutionCommand({ group: command.group, subcommand: command.subcommand,
    args: [...command.args, ...guardArgumentsForState(state)] });
}
