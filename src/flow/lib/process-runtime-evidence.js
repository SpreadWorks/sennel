import { ProcessExecutionControlFailure, ProcessExecutionRecoveryCall, ProcessExecutionStopReceipt } from "../../lib/process-execution-values.js";
import { FlowExecutionContract } from "./flow-execution-contract.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";

/** Binding and checkout validation shared by observed exits and revoked reservations. */
class FlowProcessExecutionEvidence {
  constructor(proof) { this.proof = proof; }

  assertIdentity({ runId, specId, nodeId, attemptId, attemptSequence,
    taskId = undefined, dispatchInvocationId = undefined, workUnitId = undefined, requestDigest = undefined }) {
    const expected = { runId, specId, nodeId, attemptId, attemptSequence,
      taskId, dispatchInvocationId, workUnitId, requestDigest };
    const binding = this.proof.binding.value;
    for (const [name, value] of Object.entries(expected)) {
      if (value !== undefined && binding?.[name] !== value) {
        throw new ProcessExecutionControlFailure("stop-binding-mismatch",
          `Process execution evidence differs from the canonical execution: ${name}`);
      }
    }
    return this;
  }

  assertContract(contract, identity = {}) {
    if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Process execution evidence requires its execution contract");
    this.assertIdentity({ runId: contract.runId, specId: contract.specId,
      nodeId: contract.nodeId, attemptId: contract.attemptId,
      taskId: contract.taskId, attemptSequence: contract.attemptSequence, ...identity });
    FlowProcessExecutionBinding.forContract(contract, { baseBinding: this.proof.binding });
    return this;
  }

  assertCheckout(checkoutIdentity) {
    if (!this.proof.checkoutIdentity.matches(checkoutIdentity)) {
      throw new ProcessExecutionControlFailure("stop-checkout-mismatch",
        "Process execution evidence differs from the execution checkout");
    }
    return this;
  }

  assertRepository(repositoryIdentity) {
    if (!this.proof.checkoutIdentity.matchesRepository(repositoryIdentity)) {
      throw new ProcessExecutionControlFailure("stop-repository-mismatch",
        "Retained process execution evidence differs from its canonical repository");
    }
    return this;
  }

  toJSON() { return this.proof.toJSON(); }
}

/** Exact registered-execution stop observation; it neither completes nor retries a Flow Step. */
export class FlowProcessStopEvidence extends FlowProcessExecutionEvidence {
  constructor(receipt) {
    super(receipt instanceof ProcessExecutionStopReceipt ? receipt : new ProcessExecutionStopReceipt(receipt));
    this.receipt = this.proof;
    Object.freeze(this);
  }

  static fromStored(value) { return new this(value); }
}

/** Recovery accepts only the closure already validated by the physical inventory. */
export class FlowProcessRecoveryEvidence extends FlowProcessExecutionEvidence {
  constructor(call) {
    if (!(call instanceof ProcessExecutionRecoveryCall)) throw new TypeError("Flow recovery evidence requires a typed physical call");
    super(call.startPermitted ? call.receipt : call.revocation);
    Object.freeze(this);
  }
}

export function workerProcessStopIdentity(request) {
  return { runId: request.runId, specId: request.specId,
    nodeId: request.executionContract.nodeId,
    attemptId: request.executionContract.attemptId,
    attemptSequence: request.executionContract.attemptSequence,
    dispatchInvocationId: request.dispatchInvocationId,
    requestDigest: request.requestDigest };
}
