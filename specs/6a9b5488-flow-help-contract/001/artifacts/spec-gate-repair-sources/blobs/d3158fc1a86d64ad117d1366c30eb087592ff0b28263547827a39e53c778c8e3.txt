/**
 * src/flow/lib/run-report-show.js
 *
 * `sennel flow report show` — stream the most recent finalize Report text
 * to stdout.
 *
 * Source of truth is the cataloged `report` artifact in Version 1 (generated from validated
 * test-execute-result.json v2 and test-result-review.json artifacts by the
 * finalize post-commit hook and merged into the base branch). `finalize` writes the
 * specId of the latest finalized spec to
 * `.sennel/last-finalized-spec` in the main repo; this command reads that
 * pointer and echoes the report's `text` field.
 */

import fs from "node:fs";
import path from "node:path";
import { Command } from "../../lib/command.js";
import { PRODUCT } from "../../lib/product.js";
import { DEFAULT_FLOW_SPEC_DIR } from "../../lib/flow-workspace.js";
import { FlowManager } from "../../lib/flow-manager.js";

export const POINTER_REL_PATH = PRODUCT.managedPath("last-finalized-spec");

function reportShowError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Catalog-authoritative projection of the report selected by the repository
 * pointer.  Bytes and path are resolved by one Store read so consumers cannot
 * validate a descriptor and then reopen a different filesystem value.
 */
export class CanonicalLatestReport {
  #bytes;

  constructor({ specId, relativePath, path: reportPath, bytes } = {}) {
    if (typeof specId !== "string" || specId === "") throw new Error("canonical report specId is required");
    if (typeof relativePath !== "string" || relativePath === "") throw new Error("canonical report relativePath is required");
    if (typeof reportPath !== "string" || !path.isAbsolute(reportPath)) throw new Error("canonical report path must be absolute");
    if (!Buffer.isBuffer(bytes)) throw new Error("canonical report bytes are required");
    this.specId = specId;
    this.relativePath = relativePath;
    this.path = reportPath;
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }

  static read({
    mainRoot,
    specRoot = DEFAULT_FLOW_SPEC_DIR,
    flowManager = null,
    consumerNodeId = "report",
  } = {}) {
    if (typeof consumerNodeId !== "string" || consumerNodeId === "") {
      throw new Error("canonical report consumerNodeId is required");
    }
    const pointerPath = path.join(mainRoot, POINTER_REL_PATH);
    if (!fs.existsSync(pointerPath)) {
      throw reportShowError("NO_POINTER", `pointer not found: ${POINTER_REL_PATH} (run finalize first)`);
    }
    const specId = fs.readFileSync(pointerPath, "utf8").trim();
    if (!specId) throw reportShowError("EMPTY_POINTER", `pointer is empty: ${POINTER_REL_PATH}`);
    let manager;
    try {
      manager = flowManager ?? new FlowManager({
        root: mainRoot,
        mainRoot,
        inWorktree: false,
        specRoot,
        specId,
      });
    } catch {
      throw reportShowError("INVALID_POINTER", `pointer has an invalid specId: ${specId}`);
    }
    let resolved;
    try {
      resolved = manager.readArtifact({
        specId,
        logicalKey: "report",
        consumerNodeId,
      });
    } catch (error) {
      throw reportShowError("NO_REPORT", `cataloged report is unavailable for ${specId}: ${error.message}`);
    }
    return new CanonicalLatestReport({
      specId,
      relativePath: resolved.relativePath,
      path: manager.specLocation(specId).resolve(resolved.relativePath),
      bytes: resolved.bytes,
    });
  }

  text() {
    let json;
    try {
      json = JSON.parse(this.#bytes.toString("utf8"));
    } catch (error) {
      throw reportShowError("PARSE_ERROR", `failed to parse ${path.basename(this.path)}: ${error.message}`);
    }
    if (typeof json.text !== "string") {
      throw reportShowError("NO_TEXT", `${path.basename(this.path)} has no 'text' string field`);
    }
    const tests = json.data?.tests;
    if (tests && (typeof tests !== "object" || !("projectRegression" in tests))) {
      throw reportShowError("NO_PROJECT_REGRESSION", `${path.basename(this.path)} has test data without projectRegression`);
    }
    return json.text;
  }
}

export default class RunReportShowCommand extends Command {
  static outputMode = "raw";

  async execute() {
    const mainRoot = this.container.get("mainRoot");
    const report = CanonicalLatestReport.read({
      mainRoot,
      specRoot: this.container.get("flowSpecRoot"),
      flowManager: this.container.get("flowManager"),
    });
    process.stdout.write(report.text());
  }
}
