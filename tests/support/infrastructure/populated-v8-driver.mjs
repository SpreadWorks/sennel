import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectedOutput } from "../../fixtures/process-runtime-record-v8/populated-output.mjs";

const [packageRoot, targetRoot, factsPath, mode, mainRoot] = process.argv.slice(2);
let stage = "old bootstrap proof";
let closeSynchronousExecutionBridge;
const load = relative => import(pathToFileURL(path.join(packageRoot, relative)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  assert.equal(mode, "closed"); assert.equal(mainRoot, targetRoot);
  const { currentRuntimePackage } = await load("src/lib/runtime-package.js");
  const sourcePackageRevision = currentRuntimePackage().revision;
  assert.equal(sourcePackageRevision, "1f06da0d3a4426ad41cf2980bee7693bf8362149142e4759db1ded65240cf20a");
  const { ProcessExecutionRuntime } = await load("src/lib/process-execution-runtime.js");
  const { ProcessExecutionRuntimeOnlyDisposition } = await load("src/lib/process-execution-values.js");
  const { NativeExecutableInvocation } = await load("src/lib/command-invocation.js");
  const { executeManagedProcess } = await load("src/lib/managed-process.js");
  ({ closeSynchronousExecutionBridge } = await load("src/lib/process-execution-sync.js"));
  stage = "fresh old-source owner allocation";
  fs.mkdirSync(targetRoot);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: targetRoot, environment: {} });
  const coordinatorChild = runtime.control.child;
  assert.ok(coordinatorChild);
  const script = fileURLToPath(new URL("../../fixtures/process-runtime-record-v8/populated-output.mjs", import.meta.url));
  const command = new NativeExecutableInvocation({ executable: process.execPath, args: [script], cwd: targetRoot, env: {}, stdio: "pipe" });
  let businessChild;
  let result;
  stage = "actual registered binary child";
  await runtime.withBinding({ purpose: "populated-record-migration" }, async scope => {
    result = await executeManagedProcess(command, [], { runtime: scope, timeoutMs: 5000, maxBuffer: 8192, encoding: "buffer",
      onSpawn(child) { businessChild = child; } });
  }, { eventWriter: event => ProcessExecutionRuntimeOnlyDisposition.fromEvent(event) });
  stage = "actual child and receipt readback";
  const expected = expectedOutput();
  assert.ok(businessChild); assert.equal(businessChild.exitCode, 0); assert.equal(businessChild.signalCode, null);
  assert.ok(Buffer.isBuffer(result.stdout) && result.stdout.equals(expected.stdout));
  assert.ok(Buffer.isBuffer(result.stderr) && result.stderr.equals(expected.stderr));
  assert.equal(result.processExecutionStopReceipt.observation.code, 0);
  assert.equal(result.processExecutionStopReceipt.observation.signal, null);
  assert.equal(result.processExecutionStopReceipt.output.stdoutBytes, expected.stdout.length);
  assert.equal(result.processExecutionStopReceipt.output.stderrBytes, expected.stderr.length);
  const receiptText = JSON.stringify(result.processExecutionStopReceipt.toJSON());
  stage = "normal original owner close";
  await runtime.close();
  assert.equal(runtime.closed, true);
  assert.equal(coordinatorChild.exitCode, 0); assert.equal(coordinatorChild.signalCode, null);
  assert.equal(runtime.store.ownerLock.inspect(), null);
  stage = "closed source8 history and private artifacts";
  const originalInventory = runtime.inspect();
  assert.equal(originalInventory.version, 8); assert.equal(originalInventory.slot, null);
  assert.equal(originalInventory.executions.length, 1);
  const execution = originalInventory.executions[0];
  assert.equal(execution.status, "closed"); assert.equal(execution.closure.recovery, false);
  assert.equal(execution.calls.length, 1);
  const call = execution.calls[0];
  assert.ok(JSON.stringify(call.receipt) === receiptText);
  assert.ok(call.outcome !== null);
  assert.deepEqual(call.invocation.actualCommand.env, {});
  assert.deepEqual(call.invocation.launch.env, {});
  assert.equal(execution.events.length, 4);
  assert.equal(execution.runtimeOnlyDispositions.length, 4);
  assert.ok(execution.requests.length > 0 && execution.requests.every(request => request.response !== null));
  for (const operation of ["reserve", "observe", "finish", "close"]) assert.ok(execution.requests.some(request => request.operation === operation));
  const directory = runtime.store.authority.directory;
  const callDirectory = path.join(directory, "calls", call.callId);
  const artifacts = fs.readdirSync(callDirectory).sort().map(name => {
    const file = path.join(callDirectory, name), stat = fs.lstatSync(file, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, 1n);
    const bytes = fs.readFileSync(file);
    return { relativePath: `calls/${call.callId}/${name}`, bytesBase64: bytes.toString("base64"), digest: hash(bytes),
      nativeGeneration: Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])])) };
  });
  for (const [name, bytes] of [["stdout.bin", expected.stdout], ["stderr.bin", expected.stderr]]) {
    const artifact = artifacts.find(entry => entry.relativePath.endsWith(`/${name}`));
    assert.ok(artifact && Buffer.from(artifact.bytesBase64, "base64").equals(bytes));
  }
  const outcome = artifacts.find(entry => entry.relativePath.endsWith("/outcome.json"));
  assert.ok(outcome);
  const privateOutcome = JSON.parse(Buffer.from(outcome.bytesBase64, "base64"));
  assert.ok(JSON.stringify(privateOutcome.outcome) === JSON.stringify(call.outcome));
  assert.ok(JSON.stringify(privateOutcome.receipt) === receiptText);
  fs.writeFileSync(factsPath, JSON.stringify({ sourcePackageRevision, producerRoute: "actual-public-registered-child-and-normal-owner-close",
    directory, originalInventory, receiptText, artifacts, actualCommandEnvironmentKeys: Object.keys(call.invocation.actualCommand.env),
    launchEnvironmentKeys: Object.keys(call.invocation.launch.env),
    businessExit: { pid: businessChild.pid, code: businessChild.exitCode, signal: businessChild.signalCode },
    coordinatorExit: { pid: coordinatorChild.pid, code: coordinatorChild.exitCode, signal: coordinatorChild.signalCode },
    originalOwnerLockReleased: true }) + "\n", { flag: "wx", mode: 0o600 });
} catch (cause) {
  fs.writeFileSync(`${factsPath}.failure.json`, JSON.stringify({ status: "FAIL", stage,
    errorType: cause?.constructor?.name ?? null, errorCode: typeof cause?.code === "string" ? cause.code : null,
    originalFailureRetained: true, noLateCloseInspectRecoveryOrSignal: true }) + "\n", { flag: "wx", mode: 0o600 });
  if (closeSynchronousExecutionBridge !== undefined) process.removeListener("beforeExit", closeSynchronousExecutionBridge);
  process.exitCode = 1;
}
