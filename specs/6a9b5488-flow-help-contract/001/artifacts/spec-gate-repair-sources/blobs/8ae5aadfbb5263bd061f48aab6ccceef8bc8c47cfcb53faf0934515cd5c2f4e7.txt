/**
 * src/flow/lib/run-resume.js
 *
 * Resume command — return context for a registered active flow.
 */

import { FlowCommand } from "./base-command.js";
import { buildResolvedFlowContext } from "./resolve-context-envelope.js";

export default class RunResumeCommand extends FlowCommand {
  constructor() {
    super({
      requiresFlow: false,
      explicitTargetResolution: true,
      specOptionAsTarget: true,
    });
  }

  execute(ctx) {
    // A bound worktree state is execution provenance, not resume authority.
    // Normal resume must select from the active-flow registry.
    const resolved = ctx.flowManager.resolveActiveFlow(null, {
      selectSpecId: ctx.spec || undefined,
    });
    if (!resolved) throw new Error("no active flow found");
    const base = buildResolvedFlowContext({ ...ctx, flowState: resolved.state });
    return {
      ...base,
      runId: resolved.state.runId || null,
    };
  }
}
