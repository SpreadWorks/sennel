import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const runtimeURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
const bootstrapURL = pathToFileURL(path.resolve("src/sennel.js")).href;
const managedURL = pathToFileURL(path.resolve("src/lib/managed-process.js")).href;
function fixture(t) {
  const mainRoot = createTmpDir("runtime-retained-", { parent: path.resolve(".tmp/c2f6/runtime-retained-fixtures") });
  const executionRoot = path.join(mainRoot, "original-checkout"); fs.mkdirSync(executionRoot);
  t.after(() => removeTmpDir(mainRoot));
  return { mainRoot, executionRoot, runId: "retained-run", specId: "retained-spec" };
}
async function provider(runtime, executionRoot) {
  return runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('retained-proof')"],
    { cwd: executionRoot, timeoutMs: 30000, graceMs: 100, maxBuffer: 1024 }));
}
async function sealed(t, options) {
  const runtime = await ProcessExecutionRuntime.acquire(options);
  t.after(async () => { if (!runtime.closed && fs.existsSync(options.executionRoot)) await runtime.close(); });
  const result = await provider(runtime, options.executionRoot);
  const reservation = await runtime.sealForCheckoutHandoff(); t.after(() => reservation.release());
  return { runtime, result, reservation };
}
async function freshRead(options) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime} from ${JSON.stringify(runtimeURL)};
    process.stdout.write(JSON.stringify(ProcessExecutionRuntime.inspectRetainedClosedCheckout(${JSON.stringify(options)})));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit"); assert.equal(code, 0, stderr); assert.equal(signal, null);
  return JSON.parse(stdout);
}
function files(directory) {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    return fs.lstatSync(file).isDirectory() ? files(file) : [[file, fs.readFileSync(file).toString("base64")]];
  });
}

test("a fresh coordinator reads exact closed receipts after checkout removal and owner crash without mutating retained records", { timeout: 90000 }, async (t) => {
  const options = fixture(t);
  const child = spawn(process.execPath, ["--import", bootstrapURL, "--input-type=module", "-e", `
    import {ProcessExecutionRuntime} from ${JSON.stringify(runtimeURL)};
    import {executeManagedProcess} from ${JSON.stringify(managedURL)};
    const options=${JSON.stringify(options)},runtime=await ProcessExecutionRuntime.acquire(options);
    const result=await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',"process.stdout.write('actual-before-removal')"],
      {cwd:options.executionRoot,timeoutMs:30000,graceMs:100,maxBuffer:1024}));
    const reservation=await runtime.sealForCheckoutHandoff();
    process.send({executionId:runtime.executionId,receipt:result.processExecutionStopReceipt.toJSON()});
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; }
  });
  const saved = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code, signal) => reject(new Error(`Coordinator exited before sealed readback: ${code}/${signal}: ${stderr}`)));
  });
  assert.equal(saved.receipt.stopEvidence.status, "confirmed", stderr);
  fs.rmSync(options.executionRoot, { recursive: true });
  assert.throws(() => ProcessExecutionRuntime.inspect(options), ProcessExecutionControlFailure);
  assert.throws(() => ProcessExecutionRuntime.inspectRetainedClosedCheckout(options), { code: "PROCESS_EXECUTION_BUSY" });
  const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
  const before = files(path.join(options.mainRoot, ".sennel", "process-runtime"));
  const readback = await freshRead(options);
  assert.equal(readback.slot, null); assert.equal(readback.executions.length, 1);
  assert.equal(readback.executions[0].executionId, saved.executionId); assert.equal(readback.executions[0].status, "closed");
  assert.deepEqual(readback.executions[0].calls[0].receipt, saved.receipt);
  assert.equal(readback.checkout.executionRoot, options.executionRoot);
  assert.deepEqual(files(path.join(options.mainRoot, ".sennel", "process-runtime")), before);
  assert.throws(() => ProcessExecutionRuntime.inspectRetainedClosedCheckout({ ...options, runId: "foreign-run" }), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
});

test("released ownership permits retained closed readback but a recreated checkout cannot inherit the removed checkout identity", async (t) => {
  const options = fixture(t), value = await sealed(t, options); value.reservation.release();
  const saved = value.runtime.inspect();
  fs.renameSync(options.executionRoot, path.join(options.mainRoot, "retired-inode"));
  const retained = await freshRead(options); assert.deepEqual(retained, saved);
  fs.mkdirSync(options.executionRoot);
  assert.notEqual(fs.statSync(options.executionRoot).ino, saved.checkout.checkoutInode);
  assert.throws(() => ProcessExecutionRuntime.inspectRetainedClosedCheckout(options), { code: "PROCESS_EXECUTION_AUTHORITY_MISMATCH" });
});

test("a removed checkout with an unfinished physical intent cannot be treated as retained closed ownership", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  await provider(runtime, options.executionRoot); const call = await runtime.reserveCall();
  const registry = fs.readFileSync(runtime.store.file.filePath);
  fs.rmSync(options.executionRoot, { recursive: true });
  assert.throws(() => ProcessExecutionRuntime.inspectRetainedClosedCheckout(options), { code: "PROCESS_EXECUTION_STOP_UNCONFIRMED" });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), registry);
  assert.equal(call.executionId, runtime.executionId); assert.equal(runtime.closed, false);
});

for (const artifact of ["anchor", "archive"]) {
  test(`retained checkout inspection refuses a missing ${artifact} instead of authorizing cleanup`, async (t) => {
    const options = fixture(t), value = await sealed(t, options); value.reservation.release();
    const archive = path.join(value.runtime.store.archivesAuthority.directory, `${value.runtime.executionId}.json`);
    fs.rmSync(options.executionRoot, { recursive: true });
    fs.unlinkSync(artifact === "anchor" ? value.runtime.store.anchor.filePath : archive);
    const before = files(path.join(options.mainRoot, ".sennel", "process-runtime"));
    assert.throws(() => ProcessExecutionRuntime.inspectRetainedClosedCheckout(options), { code: "PROCESS_EXECUTION_RECORD_MISSING" });
    assert.deepEqual(files(path.join(options.mainRoot, ".sennel", "process-runtime")), before);
  });
}
