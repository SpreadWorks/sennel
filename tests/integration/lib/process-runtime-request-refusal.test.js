import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionBinding, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

test("a rejected binding persists its exact refusal, replays without mutation and preserves lawful admission", async (t) => {
  const root = createTmpDir("runtime-request-refusal-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, runId: "original-run" });
  t.after(async () => {
    try { if (!runtime.closed) await runtime.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  const grant = runtime.remoteGrant();
  const binding = new ProcessExecutionBinding({ runId: "foreign-run" });
  const requestId = randomUUID();
  const payload = { grant, data: { binding: binding.toJSON() } };
  const refuse = () => managedRequest(grant, "bind", payload, { requestId });
  await assert.rejects(refuse(), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
  const inventory = runtime.inspect();
  const execution = inventory.executions.find((entry) => entry.executionId === runtime.executionId);
  assert.equal(execution.runId, "original-run");
  assert.equal(execution.status, "active");
  assert.equal(execution.accepting, true);
  assert.equal(execution.calls.length, 0);
  assert.equal(execution.events.length, 0);
  const saved = execution.requests.find((entry) => entry.requestId === requestId);
  assert.equal(saved.operation, "bind");
  assert.equal(saved.response.ok, false);
  const failure = ProcessExecutionControlFailure.fromStored(saved.response.error);
  assert.equal(failure.code, "PROCESS_EXECUTION_BINDING_MISMATCH");
  const beforeReplay = executionValueDigest(inventory);
  await assert.rejects(refuse(), { code: failure.code });
  assert.equal(executionValueDigest(runtime.inspect()), beforeReplay);
  let admitted = false;
  await runtime.withBinding({ runId: "original-run" }, () => { admitted = true; });
  assert.equal(admitted, true);
  await runtime.close();
  assert.equal(runtime.closed, true);
  const closed = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(closed.slot, null);
  const history = closed.executions.find((entry) => entry.executionId === runtime.executionId);
  assert.equal(history.status, "closed");
  assert.equal(executionValueDigest(history.requests.find((entry) => entry.requestId === requestId).response),
    executionValueDigest(saved.response));
  assert.equal(runtime.store.ownerLock.inspect(), null);
});
