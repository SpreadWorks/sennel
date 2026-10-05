/**
 * Enable audited broad implementation mode for task-decomposed flows.
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { createBroadModeRecord } from "./task-scope.js";

export default class SetBroadCommand extends FlowCommand {
  async execute(ctx) {
    const action = String(ctx.action || "").trim();
    if (action !== "on") {
      return Envelope.fail(
        "set",
        "broad",
        "INVALID_USAGE",
        "usage: flow set broad on --step <implement|impl-review|impl-gate> --reason <text>",
      );
    }

    let record;
    try {
      record = createBroadModeRecord(ctx.flowState, ctx.step, ctx.reason);
    } catch (err) {
      return Envelope.fail("set", "broad", "INVALID_BROAD_MODE", err.message);
    }

    if (typeof ctx.flowManager?.addNote !== "function") {
      throw new Error("set broad requires the canonical Activity note Store API");
    }
    ctx.flowManager.addNote(record.toActivityText(), { specId: ctx.flowState.specId });

    return { broadMode: record.toJSON() };
  }
}
