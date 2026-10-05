import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/set-files.js
 *
 * Record file-to-requirement mapping: flow set files <reqId> <path...>
 * Appends paths to file-map.json with deduplication.
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";

export default class SetFilesCommand extends FlowCommand {
  execute(ctx) {
    const { reqId, paths } = ctx;

    if (!reqId || !paths || paths.length === 0) {
      return Envelope.fail("set", "files", "INVALID_USAGE", "usage: flow set files <reqId> <path...>");
    }

    let map;
    try {
      if (ctx.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowManager?.updateFileMap !== "function") {
        throw new Error("canonical FlowManager.updateFileMap is required");
      }
      map = ctx.flowManager.updateFileMap({
        specId: ctx.flowState.specId,
        requirementId: reqId,
        paths,
      });
    } catch (err) {
      if (err.code === "INVALID_REQ_ID" || err.message.startsWith("requirement id not found:")) {
        return Envelope.fail("set", "files", "INVALID_REQ_ID", err.message);
      }
      throw err;
    }

    return { reqId, paths, map };
  }
}
