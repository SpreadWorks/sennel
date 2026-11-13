import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandExecution } from "../../../src/lib/process.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { completeManagedOperation, completeManagedOperationSync, retainExecutionCompletion } from "../../../src/lib/process-execution-completion.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function reportingFailure(result) {
  const receipt = result.processExecutionStopReceipt;
  const failure = new ProcessExecutionControlFailure("receipt-delivery-failed", "Reporting failed after actual completion", {
    executionId: receipt.executionId, callId: receipt.callId,
  });
  retainExecutionCompletion(failure, result);
  return failure;
}

test("sync and async completion preserve the selected real child receipt without borrowing a sibling receipt", async t => {
  const root = createTmpDir("process-completion-receipt-");
  t.after(() => removeTmpDir(root));
  const results = CommandExecution.runTogether(["first", "second"].map(text =>
    new CommandExecution(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`], { cwd: root, readOnly: true })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.stdout, index === 0 ? "first" : "second");
    assert.ok(result.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(result.processExecutionStopReceipt.stopEvidence.status, "confirmed");
  }
  const firstReceipt = results[0].processExecutionStopReceipt;
  const secondReceipt = results[1].processExecutionStopReceipt;
  assert.notEqual(firstReceipt.callId, secondReceipt.callId);
  const ordinaryCompletedBody = new Error("Generic reporting failure after the first child");
  retainExecutionCompletion(ordinaryCompletedBody, results[0]);
  const cases = [
    [reportingFailure(results[0]), new Error("Cleanup failed"), 0, firstReceipt],
    [new Error("Body failed"), reportingFailure(results[1]), 1, secondReceipt],
    [reportingFailure(results[0]), reportingFailure(results[1]), 0, firstReceipt],
    [new ProcessExecutionControlFailure("reply-unavailable", "Primary completion is unknown"), reportingFailure(results[1]), 0, undefined],
    [ordinaryCompletedBody, new ProcessExecutionControlFailure("stop-unconfirmed", "Cleanup completion is unknown"), 1, undefined],
    [ordinaryCompletedBody, reportingFailure(results[1]), 1, secondReceipt],
  ];
  for (const [primary, cleanup, selectedIndex, receipt] of cases) {
    const selected = selectedIndex === 0 ? primary : cleanup;
    const check = error => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.deepEqual(error.toJSON(), selected.toJSON());
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [primary, cleanup]);
      assert.equal(error.cause.cause, primary);
      assert.equal(error.processExecutionStopReceipt, receipt);
      assert.equal(error.stopEvidence, receipt?.stopEvidence);
      if (receipt !== undefined) {
        assert.equal(error.stdout, selected.stdout);
        assert.equal(error.stderr, selected.stderr);
        assert.equal(error.signal, selected.signal);
        assert.equal(error.killed, selected.killed);
      }
      return true;
    };
    assert.throws(() => completeManagedOperationSync(() => { throw primary; }, () => { throw cleanup; }), check);
    await assert.rejects(completeManagedOperation(async () => { throw primary; }, async () => { throw cleanup; }), check);
  }
});
