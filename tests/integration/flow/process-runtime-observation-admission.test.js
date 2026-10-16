import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { ProcessExecutionRuntime, ProcessExecutionCallAdmission } from "../../../src/lib/process-execution-runtime.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";

function fixture(t) {
  const root = createTmpDir("lazy-process-observation-");
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root);
  const manager = makeFlowManager(root);
  const specId = "001-lazy-process";
  new FreshFlowFixture({ flowManager: manager, specId, runId: "lazy-process-run", execution: { mode: "direct" } }).create().registerActive();
  manager.beginNextAction(specId);
  return { root, manager, specId, context: { root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId) } };
}

function bytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory() ? bytes(path.join(directory, entry.name))
      : fs.readFileSync(path.join(directory, entry.name)).toString("base64")]);
}

test("Flow command admission and domain refusal leave canonical state unchanged until an actual managed reservation", async (t) => {
  const { manager, specId, context } = fixture(t);
  const directory = manager.specLocation(specId).directory;
  const before = bytes(directory);
  const refusal = new Error("domain admission refused");
  await assert.rejects(withFlowProcessRuntime(context, () => { throw refusal; }, { commandId: "refused-command" }), error => error === refusal);
  assert.deepEqual(bytes(directory), before);
  await withFlowProcessRuntime(context, () => undefined, { commandId: "read-only-command" });
  assert.deepEqual(bytes(directory), before);
  assert.equal((await manager.readExecutionObservations({ specId })).manifests.length, 0);
});

test("a managed-only command registers its exact source lazily through inherited binding scope and remains queryable", async (t) => {
  const { root, manager, specId, context } = fixture(t);
  const starting = manager.canonicalState(specId);
  await withFlowProcessRuntime(context, () => {
    const runtime = ProcessExecutionRuntime.current();
    return runtime.withBinding({ ...runtime.binding.toJSON(), commandId: "actual-managed-command" }, async () => {
      const result = await runManagedCmdAsync(process.execPath, ["-e", "process.stdout.write('managed-only')"], { cwd: root, timeout: 20000 });
      assert.equal(result.stdout, "managed-only");
    });
  }, { commandId: "managed-command-boundary" });
  const observations = await manager.readExecutionObservations({ specId });
  assert.equal(observations.manifests.length, 1);
  assert.equal(observations.facts.length, 0);
  assert.notEqual(observations.manifests[0].runtimeSourceId, null);
  const before = bytes(manager.specLocation(specId).directory);
  const request = new QueryRequest({ resource: "executions", condition: { specId }, page: { limit: 100, after: null } });
  const captured = await new CanonicalFlowVersionReader({ repositoryRoot: root }).read(request.specId, request.flowVersion, request);
  if (captured.version.projectionError) throw captured.version.projectionError;
  const response = captured.version.response;
  assert.deepEqual(validateFlowQueryResponse(response), []);
  const calls = response.items.filter(item => item.kind === "process-call");
  assert.equal(calls.length, 1);
  assert.equal(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions[0].calls[0].binding.commandId, "actual-managed-command");
  assert.equal(calls[0].binding.flowVersionId, starting.flowVersionId);
  assert.equal(calls[0].binding.stepAttemptId, starting.attempt.id);
  assert.equal(calls[0].stopVerification, "verified");
  assert.equal(response.summary.logicalInvocationCount, 0);
  assert.deepEqual(bytes(manager.specLocation(specId).directory), before);
});

test("a rejected managed producer admission cannot reserve or start its external program", async (t) => {
  const { root, manager, context } = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root });
  t.after(async () => { if (!runtime.closed) await runtime.close(); });
  const effect = path.join(root, "must-not-start");
  let admitted = 0;
  const admission = new ProcessExecutionCallAdmission({ admit() { admitted += 1; throw new Error("source publication failed"); } });
  await assert.rejects(runtime.enter(() => runtime.withBinding({ commandId: "blocked-call" },
    () => runManagedCmdAsync(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'started')`], { cwd: root, timeout: 20000 }),
    { callAdmission: admission })));
  assert.equal(admitted, 1);
  assert.equal(fs.existsSync(effect), false);
  assert.equal(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions[0].calls.length, 0);
  await runtime.close();
  t.mock.method(manager, "prepareExecutionObservationSession", () => null);
  await assert.rejects(withFlowProcessRuntime(context,
    () => runManagedCmdAsync(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'started')`],
      { cwd: root, timeout: 20000 }), { commandId: "missing-exact-observation-source" }),
  error => error.code === "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
  assert.equal(fs.existsSync(effect), false);
  assert.equal(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.every(execution => execution.calls.length === 0), true);
});
