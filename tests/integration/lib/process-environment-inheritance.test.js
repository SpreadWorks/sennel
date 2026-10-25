import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CommandInvocation, CommandLaunchDescriptor, NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt, PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { runCmd, runCmdAsync } from "../../../src/lib/process.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

const keys = ["SENNEL_TEST_INHERITED_CHANGED", "SENNEL_TEST_INHERITED_DELETED", "SENNEL_TEST_INHERITED_EMPTY"];

async function fixture(t) {
  const root = createTmpDir("process-environment-");
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  const script = path.join(root, "read-environment.cjs");
  fs.writeFileSync(script, `
    const keys = ${JSON.stringify(keys)};
    const grant = JSON.parse(process.env.${PROCESS_EXECUTION_SCOPE_ENV});
    process.stdout.write(JSON.stringify({
      values: Object.fromEntries(keys.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])),
      callId: grant.callId, executionId: grant.executionId
    }));
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  return { root, runtime, script };
}

function replaceEnvironment(t, values) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  for (const key of keys) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
}

function assertChild(result, values) {
  assert.equal(result.ok, true, result.stderr);
  const receipt = result.processExecutionStopReceipt;
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  assert.equal(receipt.observation.kind, "exited");
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.output.completion, "complete");
  assert.deepEqual(JSON.parse(result.stdout), { values, callId: receipt.callId, executionId: receipt.executionId });
}

function assertSavedCall(inventory, result, invocation, values) {
  const receipt = result.processExecutionStopReceipt;
  const call = inventory.executions.flatMap((entry) => entry.calls).find((entry) => entry.callId === receipt.callId);
  assert.deepEqual(call.invocation.actualCommand, invocation.toJSON());
  const launch = CommandLaunchDescriptor.fromStored(call.invocation.launch);
  assert.deepEqual(Object.fromEntries(keys.filter((key) => Object.hasOwn(launch.env, key)).map((key) => [key, launch.env[key]])), values);
  assert.equal(Object.keys(launch.env).some((key) => key.toUpperCase() === PROCESS_EXECUTION_SCOPE_ENV), false);
  assert.deepEqual(new ProcessExecutionStopReceipt(call.receipt).toJSON(), receipt.toJSON());
}

test("persistent synchronous execution inherits each caller environment change, deletion and empty value with durable launch proof", async (t) => {
  const before = Object.fromEntries(keys.map((key) => [key, "before"]));
  replaceEnvironment(t, before);
  const { root, runtime, script } = await fixture(t);
  const invocation = new NodeScriptInvocation({ script, cwd: root });
  const first = runtime.enter(() => runCmd(invocation, [], { timeout: 5000 }));
  assertChild(first, before);

  const after = { [keys[0]]: "after", [keys[2]]: "" };
  process.env[keys[0]] = after[keys[0]];
  delete process.env[keys[1]];
  process.env[keys[2]] = "";
  const second = runtime.enter(() => runCmd(invocation, [], { timeout: 5000 }));
  const asynchronous = await runtime.enter(() => runCmdAsync(invocation, [], { timeout: 5000 }));
  assertChild(second, after);
  assertChild(asynchronous, after);
  assert.equal(invocation.env, null);

  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
  assertSavedCall(inventory, first, invocation, before);
  assertSavedCall(inventory, second, invocation, after);
  assertSavedCall(inventory, asynchronous, invocation, after);
});

test("explicit stored environment stays immutable and replaces inherited values while downstream authenticates delegation", async (t) => {
  replaceEnvironment(t, Object.fromEntries(keys.map((key) => [key, "ambient"])));
  const { root, runtime, script } = await fixture(t);
  const values = { [keys[0]]: "configured", [keys[2]]: "" };
  const environment = { ...values, [PROCESS_EXECUTION_SCOPE_ENV]: "untrusted caller value" };
  const original = new NodeScriptInvocation({ script, cwd: root, env: environment });
  const configFile = path.join(root, "invocation.json");
  fs.writeFileSync(configFile, JSON.stringify(original));
  const invocation = CommandInvocation.fromStored(JSON.parse(fs.readFileSync(configFile, "utf8")));
  environment[keys[0]] = "mutated source";
  environment[keys[1]] = "added source";
  assert.ok(Object.isFrozen(invocation.env));
  assert.equal(original.env[keys[0]], "configured");

  const synchronous = runtime.enter(() => runCmd(invocation, [], { timeout: 5000 }));
  process.env[keys[0]] = "changed ambient";
  const asynchronous = await runtime.enter(() => runCmdAsync(invocation, [], { timeout: 5000 }));
  assertChild(synchronous, values);
  assertChild(asynchronous, values);

  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
  assertSavedCall(inventory, synchronous, invocation, values);
  assertSavedCall(inventory, asynchronous, invocation, values);
});
