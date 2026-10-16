import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowExecutionObservationBinding } from "../../src/lib/flow-execution-observation.js";
import { captureFlowProcessExecutionBinding } from "../../src/flow/lib/process-runtime-admission.js";

test("process capture fixes its actual starting Attempt while referencing an Outbox from a recovered Attempt", () => {
  const fixed = new FlowExecutionObservationBinding({ flowVersionId: "version", runId: "run", specId: "spec",
    nodeId: "finalize-commit", taskId: null, attemptId: "starting-attempt", attemptSequence: 2,
    executionContractId: "starting-contract", executionGeneration: 3, outboxAttemptId: "outbox-attempt" });
  const context = { specId: "spec", flowOutboxEntry: { executionBinding: fixed },
    flowManager: {
      canonicalState: () => ({ flowVersionId: "version", runId: "run", specId: "spec",
        attempt: { nodeId: "finalize-commit", id: "current-attempt", sequence: 4 } }),
      loadReadOnly: () => null,
    } };
  const captured = captureFlowProcessExecutionBinding(context, { commandId: "command", dispatchInvocationId: "dispatch" });
  assert.equal(captured.value.flowVersionId, fixed.flowVersionId);
  assert.equal(captured.value.attemptId, "current-attempt");
  assert.equal(captured.value.attemptSequence, 4);
  assert.equal(captured.value.outboxAttemptId, fixed.outboxAttemptId);
  assert.equal(captured.value.executionContractId, null);
  assert.equal(captured.value.executionGeneration, null);
  assert.equal(captured.value.commandId, "command");
  assert.equal(captured.value.dispatchInvocationId, "dispatch");
});

test("process capture refuses a foreign-Version Outbox before granting a call binding", () => {
  const fixed = new FlowExecutionObservationBinding({ flowVersionId: "foreign-version", runId: "run", specId: "spec",
    nodeId: "finalize-commit", taskId: null, attemptId: "starting-attempt", attemptSequence: 2, outboxAttemptId: "outbox-attempt" });
  const context = { specId: "spec", flowOutboxEntry: { executionBinding: fixed }, flowManager: {
    canonicalState: () => ({ flowVersionId: "version", runId: "run", specId: "spec",
      attempt: { nodeId: "finalize-commit", id: "current-attempt", sequence: 4 } }), loadReadOnly: () => null,
  } };
  assert.throws(() => captureFlowProcessExecutionBinding(context), (error) => error.code === "PROCESS_EXECUTION_BINDING_CHANGED");
});
