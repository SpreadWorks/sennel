import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";

/** What the external provider actually observes, without adapting control faults. */
export class RegisteredCommandOutcome {
  constructor(code, errorCode, receipt) {
    if (!(receipt instanceof ProcessExecutionStopReceipt) || !receipt.stopEvidence.confirmed) {
      throw new TypeError("Registered command outcome requires its exact confirmed receipt");
    }
    if (code !== receipt.observation.code || ![null, "ABORT_ERR"].includes(errorCode)) {
      throw new TypeError("Registered command outcome differs from its observed exit or abort");
    }
    this.code = code;
    this.errorCode = errorCode;
    this.processExecutionStopReceipt = receipt;
    Object.freeze(this);
  }

  static async execute(invocation, options) {
    try {
      const result = await executeManagedProcess(invocation, [], options);
      return new this(result.code, null, result.processExecutionStopReceipt);
    } catch (error) {
      if (error instanceof ProcessExecutionControlFailure || error.code !== "ABORT_ERR"
        || !(error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt)
        || !error.processExecutionStopReceipt.stopEvidence.confirmed) throw error;
      const receipt = error.processExecutionStopReceipt;
      return new this(receipt.observation.code, "ABORT_ERR", receipt);
    }
  }

  toJSON() {
    return { code: this.code, errorCode: this.errorCode, receipt: this.processExecutionStopReceipt.toJSON() };
  }
}
