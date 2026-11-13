import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [sourceRoot, checkout, output, mode, mainRoot = checkout, bindingPaddingBytes = "0", refusalMessageExtra = "0"] = process.argv.slice(2);
const jobRoot = path.dirname(checkout);
const load = relative => import(pathToFileURL(path.join(sourceRoot, relative)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let stage = "original source identity";
let closeSynchronousExecutionBridge;
try {
  const { currentRuntimePackage } = await load("src/lib/runtime-package.js");
  assert.equal(currentRuntimePackage().revision, "7d58bd1b4cd78f8e80129b6b7ccf8d56329123a5245bab7d275ae90ac764e833");
  const { ProcessExecutionRuntime } = await load("src/lib/process-execution-runtime.js");
  const { ProcessExecutionCanonicalAcknowledgement, ProcessExecutionControlFailure, ProcessExecutionCommunicationDiagnostic } = await load("src/lib/process-execution-values.js");
  const { NodeScriptInvocation } = await load("src/lib/command-invocation.js");
  const { executeManagedProcess } = await load("src/lib/managed-process.js");
  ({ closeSynchronousExecutionBridge } = await load("src/lib/process-execution-sync.js"));
  const { AtomicFile } = await load("src/lib/atomic-file.js");
  const { RealDirectoryAuthority } = await load("src/lib/real-directory-authority.js");
  const publicationRoot = path.join(jobRoot, "canonical-events");
  fs.mkdirSync(publicationRoot);
  const publicationAuthority = new RealDirectoryAuthority(publicationRoot);
  const publications = [];
  const writer = event => {
    const file = new AtomicFile(path.join(publicationRoot, event.eventId + ".json"), { directoryAuthority: publicationAuthority });
    const bytes = Buffer.from(JSON.stringify(event));
    file.write(bytes, { exclusive: true });
    assert.deepEqual(file.readSnapshot().bytes, bytes);
    const acknowledgement = ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
    publications.push({ relativePath: event.eventId + ".json", sha256: hash(bytes), acknowledgement: acknowledgement.toJSON() });
    return acknowledgement;
  };
  fs.mkdirSync(checkout);
  const provider = path.join(jobRoot, "parent.mjs");
  const target = path.join(jobRoot, "child.mjs");
  fs.writeFileSync(target, "process.stdout.write('child');\n", { flag: "wx" });
  fs.writeFileSync(provider, `import {spawn} from 'node:child_process';
    const [entry,target]=process.argv.slice(2);
    const child=spawn(process.execPath,[entry,'command','--',process.execPath,target],
      {cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
    const chunks=[];child.stdout.on('data',bytes=>chunks.push(bytes));
    child.stderr.on('data',bytes=>process.stderr.write(bytes));
    child.once('error',cause=>{throw cause});
    child.once('close',(code,signal)=>{if(code!==0||signal!==null)throw new Error('registered nested target failed');
      process.stdout.write('parent:'+Buffer.concat(chunks).toString('utf8'));});\n`, { flag: "wx" });
  stage = "fresh original owner";
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot: checkout, runId: "migration-nine-run", specId: "migration-nine-spec", environment: {} });
  const coordinator = runtime.control.child;
  assert.ok(coordinator);
  const binding = { purpose: "exact-evidence-migration", padding: "x".repeat(Number(bindingPaddingBytes)) };
  let parent;
  stage = "actual parent and nested public command";
  const result = await runtime.withBinding(binding, () =>
    executeManagedProcess(new NodeScriptInvocation({ script: provider, args: [path.join(sourceRoot, "src/sennel.js"), target],
      cwd: checkout, env: {}, stdio: "pipe" }), [], { runtime: ProcessExecutionRuntime.current(), timeoutMs: 10000,
      maxBuffer: 8192, encoding: "buffer", onSpawn(child) { parent = child; } }),
  { eventWriter: writer });
  assert.ok(parent);
  assert.equal(parent.exitCode, 0);
  assert.equal(parent.signalCode, null);
  assert.deepEqual(result.stdout, Buffer.from("parent:child"));
  stage = "original unlaunched reservation and injected refusal";
  await runtime.withBinding(binding, async () => {
    const scope = ProcessExecutionRuntime.current();
    const call = await scope.reserveCall({ invocation: { commandId: "never-launched-migration-reservation" } });
    await scope.recordCallControlFailure(call, new ProcessExecutionControlFailure("endpoint-unavailable", "Injected refusal before any launch permission" + "x".repeat(Number(refusalMessageExtra)), {
      executionId: scope.executionId, callId: call.callId,
      communication: new ProcessExecutionCommunicationDiagnostic({ operation: "claim-launch", budgetMs: 14000, elapsedMs: 0,
        cutoff: "refused", acceptance: "rejected", stopConfirmation: "unknown", attempts: [] }),
    }));
    await scope.revokeCall(call, { reason: "fixture-before-launch" });
  }, { eventWriter: writer });
  if (mode === "hold") {
    const release = new Promise(resolve => process.once("message", message => { if (message.event === "release") resolve(); }));
    process.send({ event: "ready", executionId: runtime.executionId });
    await release;
  }
  stage = "original normal owner release";
  await runtime.close();
  assert.equal(runtime.closed, true);
  assert.equal(coordinator.exitCode, 0);
  assert.equal(coordinator.signalCode, null);
  assert.equal(runtime.store.ownerLock.inspect(), null);
  stage = "complete closed original graph";
  const inventory = runtime.inspect();
  assert.equal(inventory.version, 9);
  assert.equal(inventory.slot, null);
  const calls = inventory.executions.flatMap(execution => {
    assert.equal(execution.status, "closed");
    assert.ok(execution.requests.every(request => request.response !== null));
    return execution.calls;
  });
  assert.equal(calls.length, 3);
  const root = calls.find(call => call.parentCallId === null && call.receipt !== null);
  const child = calls.find(call => call.parentCallId === root.callId);
  assert.ok(child);
  assert.equal(root.receipt.descendants.length, 1);
  assert.equal(root.receipt.descendants[0].closureDigest, hash(Buffer.from(JSON.stringify(child.receipt))));
  const directory = runtime.store.authority.directory;
  const records = [];
  const collect = (relative) => {
    const directoryPath = path.join(directory, relative);
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) collect(name);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const bytes = fs.readFileSync(path.join(directory, name));
        records.push({ relativePath: name, sha256: hash(bytes), bytesBase64: bytes.toString("base64") });
      }
    }
  };
  collect("");
  fs.writeFileSync(output, JSON.stringify({ status: "AUTHENTIC_CLOSED_REVISION9_GRAPH_EXPORTED",
    node: process.version, sourcePackageRevision: currentRuntimePackage().revision,
    sourceRuntimeVersion: 9, originalOwnerReleased: true, coordinatorExitCode: 0,
    parentExitCode: 0, parentExit: { pid: parent.pid, code: parent.exitCode, signal: parent.signalCode },
    coordinatorExit: { pid: coordinator.pid, code: coordinator.exitCode, signal: coordinator.signalCode },
    directory, inventory, records, publications, injectedRefusalBeforeAnyLaunchPermission: true,
    scope: "Pure source-record fixture export only. Original physical records remain retained. No copied physical ownership or migration acceptance claim." }, null, 2) + "\n", { flag: "wx" });
} catch (cause) {
  fs.writeFileSync(output + ".failure.json", JSON.stringify({ status: "FAILED_ORIGINAL_PRODUCER",
    stage, errorType: cause?.constructor?.name, errorCode: cause?.code ?? null,
    noLateCloseInspectionRecoverySignalOrCleanup: true }) + "\n", { flag: "wx" });
  if (closeSynchronousExecutionBridge !== undefined) process.removeListener("beforeExit", closeSynchronousExecutionBridge);
  process.stderr.write(String(cause?.stack ?? cause));
  process.exitCode = 1;
}
