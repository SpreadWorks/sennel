/**
 * src/flow/lib/get-resolve-context.js
 *
 * Resolve worktree/repo paths and active flow for context recovery
 * after compaction.
 */

import { FlowCommand } from "./base-command.js";
import { buildResolvedFlowContext } from "./resolve-context-envelope.js";

export default class GetResolveContextCommand extends FlowCommand {
  execute(ctx) {
    return buildResolvedFlowContext(ctx);
  }
}
