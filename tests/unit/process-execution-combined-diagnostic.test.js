import assert from "node:assert/strict";
import { test } from "node:test";
import { completeManagedOperation, completeManagedOperationSync } from "../../src/lib/process-execution-completion.js";

function assertCombinedDiagnostic(error, primary, completion) {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.deepEqual(error.errors, [primary, completion]);
  assert.ok(error.message.includes(primary.message), "the public diagnostic retains the original operation message");
  assert.ok(error.message.includes(completion.message), "the public diagnostic also retains the completion message");
  return true;
}

test("combined synchronous failures retain both messages at the public error boundary", () => {
  const primary = new Error("original operation diagnostic"), completion = new Error("mandatory completion diagnostic");
  assert.throws(() => completeManagedOperationSync(() => { throw primary; }, () => { throw completion; }),
    error => assertCombinedDiagnostic(error, primary, completion));
});

test("combined asynchronous failures retain both messages at the public error boundary", async () => {
  const primary = new Error("original async operation diagnostic"), completion = new Error("mandatory async completion diagnostic");
  await assert.rejects(completeManagedOperation(async () => { throw primary; }, async () => { throw completion; }),
    error => assertCombinedDiagnostic(error, primary, completion));
});
