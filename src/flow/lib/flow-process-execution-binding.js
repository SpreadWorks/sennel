import { ProcessExecutionBinding, ProcessExecutionControlFailure } from "../../lib/process-execution-values.js";
import { FlowExecutionContract } from "./flow-execution-contract.js";

/** Pure process ownership binding; it never selects a Flow route. */
export class FlowProcessExecutionBinding extends ProcessExecutionBinding {
  static forEpisode(contract, { flowVersionId = null, outboxAttemptId = null } = {}) {
    if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Process binding requires its execution contract");
    return new this({ runId: contract.runId, specId: contract.specId, nodeId: contract.nodeId,
      taskId: contract.taskId, attemptId: contract.attemptId, attemptSequence: contract.attemptSequence,
      ...(flowVersionId === null ? {} : { flowVersionId }),
      ...(outboxAttemptId === null ? {} : { outboxAttemptId }) });
  }
  static forContract(contract, { baseBinding = null, flowVersionId = null, outboxAttemptId = null } = {}) {
    if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Process binding requires its execution contract");
    const expected = { ...this.forEpisode(contract, {
      flowVersionId: flowVersionId ?? baseBinding?.value?.flowVersionId ?? null,
      outboxAttemptId: outboxAttemptId ?? baseBinding?.value?.outboxAttemptId ?? null,
    }).toJSON(),
      executionContractId: contract.id, executionGeneration: contract.generation };
    if (baseBinding === null) return new this(expected);
    if (!(baseBinding instanceof ProcessExecutionBinding)) throw new TypeError("Base process execution binding must be typed");
    for (const [name, value] of Object.entries(expected)) {
      if (baseBinding.value?.[name] !== value) {
        throw new ProcessExecutionControlFailure("stop-binding-mismatch",
          `Process binding differs from the canonical execution: ${name}`);
      }
    }
    return new this(baseBinding);
  }
}
