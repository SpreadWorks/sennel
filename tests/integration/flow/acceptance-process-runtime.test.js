import assert from "node:assert/strict";
import { test } from "node:test";
import RunAcceptanceReviewCommand from "../../../src/flow/lib/run-acceptance-review.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";

test("direct Acceptance Review owns managed provider receipts before canonical publication and reload", async (t) => {
  const flow = AcceptancePhaseScenario.create(t);
  await flow.advanceTo("acceptance-review");
  await flow.observeAcceptanceInput();
  assert.equal(ProcessExecutionRuntime.current(), null);
  const previous = new Set(ProcessExecutionRuntime.inspect({ mainRoot: flow.root }).executions.map((entry) => entry.executionId));
  const result = await new RunAcceptanceReviewCommand().execute(flow.context());
  assert.equal(result.verdict, "pass");
  assert.equal(ProcessExecutionRuntime.current(), null);
  const registry = ProcessExecutionRuntime.inspect({ mainRoot: flow.root });
  assert.equal(registry.slot, null);
  const executions = registry.executions.filter((entry) => !previous.has(entry.executionId));
  assert.equal(executions.length, 1);
  const execution = executions[0];
  assert.equal(execution.status, "closed");
  assert.ok(execution.calls.length > 0, "the actual provider must cross the managed process boundary");
  for (const call of execution.calls) {
    const receipt = new ProcessExecutionStopReceipt(call.receipt);
    assert.equal(receipt.stopEvidence.confirmed, true);
    assert.equal(receipt.binding.toJSON().nodeId, "acceptance-review");
    assert.equal(receipt.invocation.kind, "provider");
    assert.equal(receipt.checkoutIdentity.executionRoot, flow.root);
    assert.ok(receipt.invocation.promptProcessIdentity);
  }
  flow.reload();
  assert.equal(flow.current(), "final-regression");
  const persisted = flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "acceptance.review", consumerNodeId: "final-regression" });
  const history = JSON.parse(persisted.bytes.toString("utf8"));
  assert.equal(history.attempts.at(-1).artifact.payload.verdict, "pass");
});
