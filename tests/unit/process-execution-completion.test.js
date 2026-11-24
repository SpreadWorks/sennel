import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic, ProcessExecutionCommunicationDiagnostic } from "../../src/lib/process-execution-values.js";
import { completeManagedOperation, completeManagedOperationSync, processExecutionPublicationFailure } from "../../src/lib/process-execution-completion.js";

test("typed completion refusal remains visible after a generic operation failure", async () => {
  const primary = new Error("operation failed before completion");
  const closure = new ProcessExecutionControlFailure("stop-unconfirmed", "Completion lacks confirmed closure");
  await assert.rejects(completeManagedOperation(() => { throw primary; }, () => { throw closure; }), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, closure.code);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [primary, closure]);
    return true;
  });
});

test("synchronous operation returns its exact value after successful mandatory completion", () => {
  const result = { value: "observed" }; const order = [];
  assert.equal(completeManagedOperationSync(() => { order.push("body"); return result; }, (successful) => {
    assert.equal(successful, true); order.push("completion");
  }), result);
  assert.deepEqual(order, ["body", "completion"]);
});

test("synchronous completion retains typed closure failure after the original body failure", () => {
  const primary = new Error("original synchronous operation failure");
  const closure = new ProcessExecutionControlFailure("stop-unconfirmed", "Actual closure is unconfirmed");
  assert.throws(() => completeManagedOperationSync(() => { throw primary; }, (successful) => {
    assert.equal(successful, false); throw closure;
  }), (error) => {
    assert.equal(error.code, closure.code);
    assert.deepEqual(error.cause.errors, [primary, closure]);
    return true;
  });
});

test("synchronous thenable refusal still performs failed-operation completion", () => {
  let completed = false;
  assert.throws(() => completeManagedOperationSync(() => Promise.resolve("asynchronous"), (successful) => {
    assert.equal(successful, false); completed = true;
  }), TypeError);
  assert.equal(completed, true);
});

test("synchronous completion accepts an ordinary data field named then", () => {
  const result = { then: "stored data" };
  let completed = false;
  assert.equal(completeManagedOperationSync(() => result, successful => {
    assert.equal(successful, true);
    completed = true;
  }), result);
  assert.equal(completed, true);
});

test("asynchronous disposal is refused without masking the synchronous body failure", () => {
  const primary = new Error("body failed first");
  assert.throws(() => completeManagedOperationSync(() => { throw primary; }, () => Promise.resolve()), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.ok(error.errors[1] instanceof TypeError);
    return true;
  });
});

test("publication failure preserves the first typed failure metadata and both ordered causes", () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const callId = "22222222-2222-4222-8222-222222222222";
  const primaryCause = { code: "PROCESS_EXECUTION_PRODUCER_REFUSED", message: "Producer refused output." };
  const primary = new ProcessExecutionControlFailure("producer-refused", primaryCause.message, { executionId, callId,
    diagnostic: new ProcessExecutionFailureDiagnostic({ executionId, callId, operation: "consume-output",
      role: "executor", phase: "running", primaryCause,
      executor: { executorId: "33333333-3333-4333-8333-333333333333", executorSession: "44444444-4444-4444-8444-444444444444" } }),
    communication: new ProcessExecutionCommunicationDiagnostic({ operation: "consume-output", budgetMs: 0,
      elapsedMs: 0, cutoff: "refused", acceptance: "rejected", attempts: [] }),
  });
  for (const publication of [new Error("Canonical save failed."),
    new ProcessExecutionControlFailure("observation-save-failed", "Canonical acknowledgement refused.", { executionId, callId })]) {
    const result = processExecutionPublicationFailure(publication, primary);
    assert.equal(result.code, publication instanceof ProcessExecutionControlFailure ? publication.code : "PROCESS_EXECUTION_ACTIVITY_PENDING");
    assert.deepEqual(result.primaryCause.toJSON(), primary.primaryCause.toJSON());
    assert.deepEqual(result.diagnostic.toJSON(), primary.diagnostic.toJSON());
    assert.deepEqual(result.communication.toJSON(), primary.communication.toJSON());
    assert.ok(result.cause instanceof AggregateError);
    assert.deepEqual(result.cause.errors, [primary, publication]);
    assert.equal(result.processExecutionStopReceipt, undefined, "failure metadata cannot manufacture child completion");
  }
  const foreignPublication = new ProcessExecutionControlFailure("observation-save-failed", "Another call's acknowledgement refused.", {
    executionId: "55555555-5555-4555-8555-555555555555", callId: "66666666-6666-4666-8666-666666666666",
  });
  const foreign = processExecutionPublicationFailure(foreignPublication, primary);
  assert.equal(foreign.code, foreignPublication.code);
  assert.deepEqual(foreign.primaryCause.toJSON(), foreignPublication.primaryCause.toJSON());
  assert.equal(foreign.diagnostic, null);
  assert.equal(foreign.communication, null);
  assert.ok(foreign.cause instanceof AggregateError);
  assert.deepEqual(foreign.cause.errors, [primary, foreignPublication]);
});
