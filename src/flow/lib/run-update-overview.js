import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/run-update-overview.js
 *
 * Validate one task overview contribution and publish it through the
 * canonical Version Store.
 */

import { validateAdditions } from "./overview-merge.js";
import { FlowCommand } from "./base-command.js";
import { FlowManager } from "../../lib/flow-manager.js";
import { Envelope } from "../../lib/flow-envelope.js";

/**
 * Parse and validate the raw `--json` argument for `flow run update-overview`.
 *
 * Returns a tagged result so the command can map errors directly to envelope
 * failure codes without mixing parsing concerns with orchestration.
 *
 * @param {string | undefined | null} raw
 * @returns {{ok: true, value: object} | {ok: false, code: string, message: string}}
 */
export function validateOverviewAdditions(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { ok: false, code: "MISSING_JSON", message: "--json <additions-json> is required" };
  }

  let additions;
  try {
    additions = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, code: "INVALID_JSON", message: `failed to parse --json: ${err.message}` };
  }

  const shapeErrors = validateAdditions(additions);
  if (shapeErrors.length > 0) {
    return {
      ok: false,
      code: "INVALID_SHAPE",
      message: `invalid additions: ${shapeErrors.join("; ")}`,
    };
  }

  return { ok: true, value: additions };
}

/**
 * FlowCommand: `sennel flow run update-overview --json <additions>`.
 *
 * Spec 226: The task-scope `update-overview` step has been removed; its
 * functionality is now invoked from the impl step via this CLI (production
 * caller of the typed `FlowManager.updateTaskOverview` operation).
 *
 * The AI-emitted additions JSON is passed via `--json` option. The active
 * flow's current task id is auto-detected for the `added_by_task` stamp.
 */
export class RunUpdateOverviewCommand extends FlowCommand {
  async execute(ctx) {
    const parsed = validateOverviewAdditions(ctx.json);
    if (!parsed.ok) {
      return Envelope.fail("run", "update-overview", parsed.code, parsed.message);
    }
    const additions = parsed.value;

    const { root } = ctx;
    const fm = ctx.flowManager || new FlowManager({ root, mainRoot: root, inWorktree: false });
    const state = ctx.flowState || fm.load();
    if (!state) {
      return Envelope.fail("run", "update-overview", "NO_ACTIVE_FLOW", "no active flow found");
    }

    const taskId = state.currentTaskId || null;

    try {
      if (state.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof fm.updateTaskOverview !== "function") {
        throw new Error("update-overview requires an active canonical Flow");
      }
      const outcome = fm.updateTaskOverview({
        specId: state.specId,
        taskId,
        additions,
      });
      return Envelope.ok("run", "update-overview", {
        specJsonPath: fm.specLocation(state.specId).specFile,
        taskId,
        applied: outcome.applied,
      });
    } catch (err) {
      return Envelope.fail("run", "update-overview", "PERSIST_FAILED", err.message);
    }
  }
}

export default RunUpdateOverviewCommand;
