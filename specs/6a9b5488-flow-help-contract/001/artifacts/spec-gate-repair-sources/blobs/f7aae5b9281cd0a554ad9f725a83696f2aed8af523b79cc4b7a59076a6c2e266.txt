/**
 * src/flow/lib/set-note.js
 *
 * Append a note observation.
 *
 * Dual-mode operation (same pattern as set-auto.js):
 *   - Active Version-1 flow: append a typed note Activity. The command view
 *     derives state.notes from the Activity ledger.
 *   - Preparing flow (.active-flow.<runId>): mutate the preparing state so
 *     prelude choices are available to the prepare command input.
 *
 * ctx.text    — note text (required)
 * ctx.taskId  — optional explicit taskId (overrides active-task inference)
 * ctx.runId   — preparing-flow target (required in preparing mode)
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { resolveCommandRouteOptions } from "../../lib/flow-options.js";
import { resolvePreparingRunId } from "./resolve-preparing-run-id.js";

export default class SetNoteCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  execute(ctx) {
    const { text } = ctx;

    if (!text) {
      return Envelope.fail(
        "set",
        "note",
        "INVALID_USAGE",
        'usage: flow set note "<text>" [--task-id <id>] [--run-id <id>]',
      );
    }

    const { flowManager, flowState } = ctx;
    const preparingMode = !flowState;

    if (preparingMode) {
      const resolved = resolvePreparingRunId(flowManager, ctx.runId, {
        type: "set",
        key: "note",
        zeroPreparingAsFail: true,
      });
      if (resolved.fail) return resolved.fail;

      flowManager.mutatePreparingFlow(resolved.runId, (s) => {
        if (!Array.isArray(s.notes)) s.notes = [];
        s.notes.push({ text, taskId: null, ts: new Date().toISOString() });
      });

      return { note: text, runId: resolved.runId };
    }

    ctx.flowManager.addNote(text, resolveCommandRouteOptions(ctx));
    return { note: text };
  }
}
