import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../lib/process-execution-values.js";
import { FlowExecutionContract } from "./flow-execution-contract.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";

/** Exact OS-stop observation; it neither completes nor retries a Flow Step. */
export class FlowProcessStopEvidence {
  constructor(receipt) {
    this.receipt = receipt instanceof ProcessExecutionStopReceipt ? receipt
      : new ProcessExecutionStopReceipt(receipt);
    Object.freeze(this);
  }

  assertIdentity({ runId, specId, nodeId, attemptId, attemptSequence,
    taskId = undefined, dispatchInvocationId = undefined, workUnitId = undefined, requestDigest = undefined }) {
    const expected = { runId, specId, nodeId, attemptId, attemptSequence,
      taskId, dispatchInvocationId, workUnitId, requestDigest };
    const binding = this.receipt.binding.value;
    for (const [name, value] of Object.entries(expected)) {
      if (value !== undefined && binding?.[name] !== value) {
        throw new ProcessExecutionControlFailure("stop-binding-mismatch",
          `Process stop receipt differs from the canonical execution: ${name}`);
      }
    }
    return this;
  }

  assertContract(contract, identity = {}) {
    if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Process stop evidence requires its execution contract");
    this.assertIdentity({ runId: contract.runId, specId: contract.specId,
      nodeId: contract.nodeId, attemptId: contract.attemptId,
      taskId: contract.taskId, attemptSequence: contract.attemptSequence, ...identity });
    FlowProcessExecutionBinding.forContract(contract, { baseBinding: this.receipt.binding });
    return this;
  }

  assertCheckout(checkoutIdentity) {
    if (!this.receipt.checkoutIdentity.matches(checkoutIdentity)) {
      throw new ProcessExecutionControlFailure("stop-checkout-mismatch",
        "Process stop receipt differs from the execution checkout");
    }
    return this;
  }

  assertRepository(repositoryIdentity) {
    if (!this.receipt.checkoutIdentity.matchesRepository(repositoryIdentity)) {
      throw new ProcessExecutionControlFailure("stop-repository-mismatch",
        "Retained process stop receipt differs from its canonical repository");
    }
    return this;
  }

  toJSON() { return this.receipt.toJSON(); }

  static fromStored(value) { return new this(value); }
}


export function workerProcessStopIdentity(request) {
  return { runId: request.runId, specId: request.specId,
    nodeId: request.executionContract.nodeId,
    attemptId: request.executionContract.attemptId,
    attemptSequence: request.executionContract.attemptSequence,
    dispatchInvocationId: request.dispatchInvocationId,
    requestDigest: request.requestDigest };
}
