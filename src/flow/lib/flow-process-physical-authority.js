import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionBinding } from "../../lib/process-execution-values.js";

/** The canonical cleanup receipt or its authenticated journal proves source removal. */
export class FlowProcessCheckoutRemoval {
  constructor({ sourceRoot, cleanupReceiptId }) {
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)
      || !/^[a-f0-9]{64}$/.test(cleanupReceiptId)) throw new TypeError("Checkout removal requires its exact cleanup receipt");
    Object.assign(this, { sourceRoot, cleanupReceiptId });
    Object.freeze(this);
  }
}

/** A selected Flow operation's physical checkout, independent of its semantic target. */
export class FlowProcessPhysicalAuthority {
  constructor({ mainRoot, sourceRoot, executionRoot, contextRoot, runId, specId, selection, sourceRemoval = null }) {
    for (const value of [mainRoot, sourceRoot, executionRoot, contextRoot]) {
      if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
        throw new TypeError("Flow process authority requires absolute checkout paths");
      }
    }
    if (typeof runId !== "string" || runId === "" || typeof specId !== "string" || specId === ""
      || !(selection instanceof ProcessExecutionBinding)) {
      throw new TypeError("Flow process authority requires an exact selected Flow operation");
    }
    if (sourceRemoval !== null && (!(sourceRemoval instanceof FlowProcessCheckoutRemoval)
      || sourceRemoval.sourceRoot !== sourceRoot)) throw new TypeError("Checkout removal belongs to another source");
    Object.assign(this, { mainRoot, sourceRoot, executionRoot, contextRoot, runId, specId,
      selection, sourceRemoval });
    Object.freeze(this);
  }
  matches(other) { return other instanceof FlowProcessPhysicalAuthority && isDeepStrictEqual(this, other); }
}
