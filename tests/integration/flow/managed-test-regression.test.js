import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runProcessDetailed, parseArgvCommand, ParsedCommand, ChildProcessExecutionResult } from "../../../src/flow/lib/test-regression.js";
import { validate as validateConfig } from "../../../src/lib/config.js";
import RunTestExecuteCommand, { runSpecLocalTests } from "../../../src/flow/lib/run-test-execute.js";
import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";

async function runtimeFixture(t) {
  const root = createTmpDir("managed-test-regression-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  t.after(async () => { try { await runtime.close(); } finally { removeTmpDir(root); } });
  return { root, runtime };
}
function nodeCommand(source) {
  return new ParsedCommand({ argv: [process.execPath, "-e", source], source: "test.command" });
}


test("spec-local Node tests and project regression save independent managed receipts with unchanged output classification", async (t) => {
  const { root, runtime } = await runtimeFixture(t);
  const specDir = path.join(root, "specs", "fixture", "tests");
  fs.mkdirSync(specDir, { recursive: true });
  const testFile = path.join(specDir, "actual.test.cjs");
  fs.writeFileSync(testFile, "require('node:test')('R1 real subprocess',()=>require('node:assert/strict').equal(2+2,4));");
  const local = await runtime.enter(() => runSpecLocalTests({ repositoryRoot: root,
    executionRoot: root, specDir, files: [testFile], timeoutMs: 20000 }));
  assert.equal(local.result instanceof ChildProcessExecutionResult, true);
  assert.equal(local.result.kind, "passed", local.result.stderr);
  assert.match(local.result.stdout, /R1 real subprocess/);
  const command = new ParsedCommand({ argv: [process.execPath, "-e",
    "process.stdout.write(process.env.NODE_TEST_CONTEXT??'independent');process.stderr.write(process.env.PROJECT_VALUE+' ERR_ASSERTION');process.exitCode=3;"],
    source: "test.command", env: { PROJECT_VALUE: "preserved" } });
  let delivered;
  const project = await runtime.enter(() => runProcessDetailed(command, { cwd: root, timeoutMs: 20000,
    onProcessExecutionStop(receipt) { delivered = receipt; } }));
  assert.equal(project.kind, "assertion-failure");
  assert.equal(project.exitCode, 3);
  assert.equal(project.stdout, "independent");
  assert.equal(project.stderr, "preserved ERR_ASSERTION");
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.invocation.commandId), ["spec-local-tests", "test.command"]);
  assert.equal(calls.every((call) => call.receipt?.stopEvidence.confirmed), true);
  assert.deepEqual(calls[1].receipt.toJSON(), delivered.toJSON());
  await runtime.close();
  const persisted = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(persisted.executions.at(-1).calls.length, 2);
  assert.equal(persisted.executions.at(-1).calls.every((call) => call.receipt !== null), true);
});

test("managed test timeout preserves heartbeat and classifier after proved stopping; spawn errors stay spawn errors", async (t) => {
  const { root, runtime } = await runtimeFixture(t);
  let beats = 0;
  const result = await runtime.enter(() => runProcessDetailed(nodeCommand("setInterval(()=>{},1000)"), {
    cwd: root, timeoutMs: 3000, heartbeatIntervalMs: 1000, onHeartbeat() { beats++; },
  }));
  assert.equal(result.kind, "timeout");
  assert.equal(result.started, true);
  assert.ok(beats > 0);
  const missing = await runtime.enter(() => runProcessDetailed(new ParsedCommand({ argv: [path.join(root, "missing-command")], source: "test.command" }),
    { cwd: root, timeoutMs: 20000 }));
  assert.equal(missing.kind, "spawn-error");
  assert.equal(missing.started, false);
  assert.equal(missing.errorCode, "ENOENT");
  assert.equal(runtime.store.read().executions.at(-1).calls.every((call) => call.receipt !== null), true);
});

test("direct test-execute and final-regression reject a live owner before canonical admission or issue publication", async (t) => {
  const { root, runtime } = await runtimeFixture(t);
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager }).create();
  const ctx = { root, mainRoot: root, executionRoot: root, flowManager: manager, specId: flow.specId, flowState: flow.state() };
  const before = manager.canonicalState(flow.specId).toJSON();
  for (const Command of [RunTestExecuteCommand, RunFinalRegressionCommand]) {
    await assert.rejects(new Command().execute(ctx), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
    assert.deepEqual(manager.canonicalState(flow.specId).toJSON(), before);
  }
  assert.equal(runtime.store.read().executions.at(-1).calls.length, 0);
});

test("final-regression preserves typed control refusal before raw log, failure result, or budget publication", async (t) => {
  const command = { kind: "native", executable: "node", args: ["project-tests/smoke.test.js"] };
  const defaultConfig = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } };
  validateConfig({ ...defaultConfig, test: { command, timeout: 20 } });
  assert.deepEqual(parseArgvCommand(command).argv, ["node", "project-tests/smoke.test.js"]);
  const scenario = AcceptancePhaseScenario.create(t);
  let completed = false;
  let envelope = null;
  const close = scenario.close.bind(scenario);
  scenario.close = () => {
    const diagnosticPath = process.env.SENNEL_TEST_RETAIN_FAILURE_LOG;
    const retainRoot = !completed && Boolean(diagnosticPath);
    try {
      if (retainRoot) fs.writeFileSync(diagnosticPath, JSON.stringify({ root: scenario.root,
        specId: scenario.specId, envelope }, null, 2));
    } finally { close({ retainRoot }); }
  };
  await scenario.advanceTo("final-regression");
  const { root, manager, specId } = scenario;
  const ctx = scenario.context();
  const configPath = path.join(root, ".sennel", "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : defaultConfig;
  assert.equal(fs.existsSync(path.join(root, "project-tests", "smoke.test.js")), true);
  fs.writeFileSync(configPath, JSON.stringify(validateConfig({ ...config, test: { ...config.test,
    command, timeout: 20 } })));
  const store = new CanonicalTestArtifactStore({ flowManager: manager, state: ctx.flowState });
  const original = ProcessExecutionRuntime.prototype.finishCall;
  let checkpoint;
  let refusal;
  t.mock.method(ProcessExecutionRuntime.prototype, "finishCall", async function (...args) {
    const receipt = await original.apply(this, args);
    if (receipt.checkoutIdentity.mainRoot !== root) return receipt;
    checkpoint = manager.canonicalState(ctx.specId).toJSON();
    refusal = new ProcessExecutionControlFailure("test-receipt-refusal", "injected stop receipt consumer refusal", {
      executionId: receipt.executionId, callId: receipt.callId,
    });
    throw refusal;
  });
  envelope = await scenario.runRegistered("final-regression");
  assert.ok(checkpoint, JSON.stringify(envelope));
  const restored = ProcessExecutionControlFailure.fromEnvelope(envelope);
  assert.equal(restored instanceof ProcessExecutionControlFailure, true);
  assert.deepEqual(restored.toJSON(), refusal.toJSON());
  assert.equal(restored.retryable, false);
  assert.deepEqual(manager.canonicalState(ctx.specId).toJSON(), checkpoint);
  assert.equal(fs.existsSync(path.join(root, store.location.relativeArtifact("final.regression.raw-log", { attempt: String(checkpoint.attempt.sequence).padStart(3, "0") }))), false);
  const inventory = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(new ProcessExecutionStopReceipt(inventory.executions.at(-1).calls[0].receipt).stopEvidence.confirmed, true);
  completed = true;
});

test("managed regression output overflow remains a typed control refusal instead of a classifier result", async (t) => {
  const root = createTmpDir("managed-test-overflow-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  t.after(async () => { await runtime.close(); removeTmpDir(root); });
  let delivered = false;
  await assert.rejects(runtime.enter(() => runProcessDetailed(nodeCommand("process.stdout.write('x'.repeat(4096));"), {
    cwd: root, timeoutMs: 20000, maxBuffer: 1024, onProcessExecutionStop() { delivered = true; },
  })), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_OUTPUT_LIMIT");
  assert.equal(delivered, true, "exit proof is independent of whether captured output is complete");
  const call = runtime.store.read().executions.at(-1).calls[0];
  assert.equal(call.receipt.scope, "registered-executions");
  assert.equal(call.receipt.output.completion, "truncated");
  assert.equal(call.receipt.observation.kind, "exited");
  assert.equal(call.controlFailure.code, "PROCESS_EXECUTION_OUTPUT_LIMIT");
});
