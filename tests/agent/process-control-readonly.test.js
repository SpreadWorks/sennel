import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NativeExecutableInvocation } from "../../src/lib/command-invocation.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt } from "../../src/lib/process-execution-runtime.js";
import { ProcessExecutionControlEndpoint } from "../../src/lib/process-execution-endpoint.js";
import { ManagedProcessMessage } from "../../src/lib/managed-process-protocol.js";
import { ReadOnlyProcessRuntimeStorage } from "../../src/lib/readonly-invocation-workspace.js";
import { executeManagedProcess } from "../../src/lib/managed-process.js";
import { createTmpDir } from "../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../support/infrastructure/runtime-fixture-cleanup.js";
import { testTemporaryRoot } from "../test-environment.js";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sennelEntry = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));

test("a read-only sandbox can authenticate through owned mailbox scratch without writing its project", { timeout: 180000 }, async (t) => {
  const root = createTmpDir("agent-readonly-mailbox-");
  let runtime;
  t.after(async () => {
    let closeError = null;
    try {
      if (runtime !== undefined && !runtime.closed) await runtime.close();
    } catch (error) {
      testTemporaryRoot().retainOnUnconfirmedExecution();
      closeError = error;
    }
    if (runtime?.closed !== true) testTemporaryRoot().retainOnUnconfirmedExecution();
    removeQuiescentRuntimeFixture({ mainRoot: root });
    if (closeError !== null) throw closeError;
  });

  const marker = Buffer.from("readonly sandbox: 日本語検証資料確\n", "utf8");
  assert.equal(marker.length, 43);
  const markerFile = path.join(root, "readonly-marker.txt");
  fs.writeFileSync(markerFile, marker, { flag: "wx", mode: 0o600 });
  const markerSha256 = sha256(marker);
  const readerFile = path.join(root, "readonly-control-reader.mjs");
  fs.writeFileSync(readerFile, `
import crypto from "node:crypto";
import fs from "node:fs";
const [markerFile, resultFile, projectProbe, expectedSha256] = process.argv.slice(2);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const marker = fs.readFileSync(markerFile);
const markerSha256 = sha256(marker);
if (markerSha256 !== expectedSha256) throw new Error("readonly marker digest mismatch");
let projectWriteCode = null;
let projectWriteDenied = false;
try {
  const fd = fs.openSync(projectProbe, "wx", 0o600);
  try { fs.writeFileSync(fd, "unexpected project write"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
} catch (error) {
  projectWriteCode = typeof error?.code === "string" ? error.code : "UNKNOWN";
  projectWriteDenied = ["EROFS", "EACCES"].includes(projectWriteCode);
}
const result = Buffer.from(JSON.stringify({ schemaVersion: 1, markerLength: marker.length,
  markerSha256, projectWriteDenied, projectWriteCode }) + "\\n", "utf8");
const output = fs.openSync(resultFile, "wx", 0o600);
try { fs.writeFileSync(output, result); fs.fsyncSync(output); }
finally { fs.closeSync(output); }
if (!projectWriteDenied) process.exitCode = 2;
`);

  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root });
  const grant = runtime.remoteGrant();
  const controlDirectory = ReadOnlyProcessRuntimeStorage.fromGrant(grant.endpoint.storage).directory;
  const resultFile = path.join(controlDirectory, `readonly-sandbox-result-${crypto.randomUUID()}.json`);
  const projectProbe = path.join(root, "readonly-project-write-probe.txt");
  const profile = "sennel-readonly-control-scratch";
  const filesystemRule = `permissions.${profile}.filesystem={${JSON.stringify(controlDirectory)}="write"}`;
  const sandboxArgs = [
    "sandbox", "--permission-profile", profile, "--cd", root,
    "--config", `permissions.${profile}.extends=":read-only"`,
    "--config", filesystemRule,
    "--config", `permissions.${profile}.network.enabled=false`,
    "--", process.execPath, sennelEntry, "command", "--",
    process.execPath, readerFile, markerFile, resultFile, projectProbe, markerSha256,
  ];
  const outer = await runtime.enter(() => executeManagedProcess(new NativeExecutableInvocation({
    executable: "codex", args: sandboxArgs, cwd: root,
  }), [], { runtime, timeoutMs: 30000 }));

  assert.equal(outer.code, 0, outer.stderr);
  assert.equal(fs.existsSync(resultFile), true, "the real wrapped reader must persist its observation in authorized control storage");
  const document = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.match(document.projectWriteCode, /^(EROFS|EACCES)$/);
  assert.deepEqual(document, {
    schemaVersion: 1,
    markerLength: marker.length,
    markerSha256,
    projectWriteDenied: true,
    projectWriteCode: document.projectWriteCode,
  });
  assert.equal(fs.existsSync(projectProbe), false, "the sandbox must not create a project file");
  assert.equal(fs.statSync(resultFile).mode & 0o777, 0o600);

  const inventory = runtime.inspect();
  const execution = inventory.executions.find((entry) => entry.executionId === runtime.executionId && entry.ownerEpoch === runtime.ownerEpoch);
  assert.ok(execution);
  assert.equal(execution.calls.length, 2, "the sandbox and its wrapped reader are both registered children");
  const endpoint = new ProcessExecutionControlEndpoint(grant.endpoint);
  const requestDirectory = endpoint.requestAuthority().directory;
  const responseDirectory = endpoint.responseAuthority().directory;
  const snapshotRequests = fs.readdirSync(requestDirectory).filter((name) => name.endsWith(".json"))
    .map((name) => ManagedProcessMessage.from(JSON.parse(fs.readFileSync(path.join(requestDirectory, name), "utf8"))))
    .filter((message) => message.operation === "runtime-snapshot");
  assert.ok(snapshotRequests.length > 0, "the wrapped command must request an authenticated runtime snapshot");
  const snapshotResponses = fs.readdirSync(responseDirectory).filter((name) => name.endsWith(".json"));
  for (const request of snapshotRequests) {
    const responseName = `${request.requestId}.json`;
    assert.ok(snapshotResponses.includes(responseName), "the coordinator must publish the mailbox response for the request");
    const response = ManagedProcessMessage.from(JSON.parse(fs.readFileSync(path.join(responseDirectory, responseName), "utf8")));
    assert.equal(response.respondsTo(request), true);
    assert.equal(response.payload.ok, true);
    assert.ok(response.payload.value);
  }
  const [outerCall, readerCall] = execution.calls;
  assert.equal(outerCall.parentCallId, null);
  assert.equal(outerCall.invocation.actualCommand.executable, "codex");
  assert.deepEqual(outerCall.receipt, new ProcessExecutionStopReceipt(outerCall.receipt).toJSON());
  assert.equal(outerCall.receipt.callId, outerCall.callId);
  assert.equal(outerCall.receipt.executionId, execution.executionId);
  assert.equal(outerCall.receipt.ownerEpoch, execution.ownerEpoch);
  assert.equal(outerCall.receipt.observation.code, 0);
  assert.equal(outerCall.receipt.observation.signal, null);
  assert.equal(outerCall.receipt.output.completion, "complete");
  assert.equal(new ProcessExecutionStopReceipt(outerCall.receipt).stopEvidence.confirmed, true);
  assert.equal(readerCall.parentCallId, outerCall.callId);
  assert.equal(readerCall.invocation.actualCommand.executable, process.execPath);
  assert.ok(readerCall.invocation.actualCommand.args.includes(readerFile));
  assert.deepEqual(readerCall.receipt, new ProcessExecutionStopReceipt(readerCall.receipt).toJSON());
  assert.equal(readerCall.receipt.callId, readerCall.callId);
  assert.equal(readerCall.receipt.executionId, execution.executionId);
  assert.equal(readerCall.receipt.ownerEpoch, execution.ownerEpoch);
  assert.equal(readerCall.receipt.observation.code, 0);
  assert.equal(readerCall.receipt.observation.signal, null);
  assert.equal(readerCall.receipt.output.completion, "complete");
  assert.equal(new ProcessExecutionStopReceipt(readerCall.receipt).stopEvidence.confirmed, true);

  await runtime.close();
  assert.equal(runtime.closed, true);
  assert.equal(runtime.control.child.exitCode, 0, "the owned coordinator must exit normally after closure");
  const closed = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  const closedExecution = closed.executions.find((entry) => entry.executionId === runtime.executionId && entry.ownerEpoch === runtime.ownerEpoch);
  assert.ok(closedExecution);
  assert.equal(closedExecution.status, "closed");
  assert.deepEqual(closedExecution.calls.map((call) => call.receipt.callId), [outerCall.callId, readerCall.callId]);
});
