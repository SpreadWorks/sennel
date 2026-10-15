import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedProcessMessage, managedRequest, readManagedRecord, managedControlFailure } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { ManagedStopOperation } from "../../../src/lib/managed-stop-operation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { ManagedLauncher } from "../../../src/lib/managed-process-launcher.js";

class LauncherSocket extends EventEmitter {
  setTimeout() {}
  end(response) { this.response = ManagedProcessMessage.from(JSON.parse(response.trim())); }
}

async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await delay(10);
  }
  assert.fail(message);
}

function callIn(root) {
  return { executionId: randomUUID(), callId: randomUUID(), ownerToken: randomUUID(), capability: randomUUID(),
    ownerEpoch: 1, bindingDigest: "test-binding", endpoint: path.join(root, "control.sock"),
    helloPath: path.join(root, "hello.json"), outcomePath: path.join(root, "outcome.json") };
}

async function exchange(endpoint, request, { loseResponse = false } = {}) {
  const socket = net.createConnection(endpoint);
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(`${JSON.stringify(request)}\n`);
  if (loseResponse) { socket.destroy(); return null; }
  let input = "";
  for await (const bytes of socket) {
    input += bytes;
    const end = input.indexOf("\n");
    if (end !== -1) { socket.destroy(); return ManagedProcessMessage.from(JSON.parse(input.slice(0, end))); }
  }
  assert.fail("Authenticated launcher response was missing");
}

async function launcherFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-control-"));
  const call = callIn(root);
  const config = { call, command: process.execPath, args: ["-e", [
    "const fs=require('fs');",
    "fs.appendFileSync('starts','started\\n');",
    "process.on('SIGTERM',()=>{});",
    "setInterval(()=>{if(fs.existsSync('release'))process.exit(0)},10);",
  ].join("")], cwd: root, env: process.env, deadline: Date.now() + 30000,
  graceMs: 2000, maxBuffer: 1024, input: null, extraDescriptors: [] };
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  child = spawn(process.execPath, [new URL("../../../src/lib/managed-process-launcher.js", import.meta.url).pathname],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(JSON.stringify(config));
  await until(() => readManagedRecord(call.helloPath), "launcher did not publish its identity");
  return { root, call, child };
}

test("lost start and stop replies preserve one spawn and the first durable stop deadline", async (t) => {
  const { root, call, child } = await launcherFixture(t);
  const start = new ManagedProcessMessage(call, "start", { permit: { ...call }, environment: {} });
  await exchange(call.endpoint, start, { loseResponse: true });
  await until(() => fs.existsSync(path.join(root, "starts")), "provider did not start");
  const admitted = readManagedRecord(call.outcomePath);
  assert.equal(admitted.startRequest.requestId, start.requestId);
  assert.equal(admitted.startRequest.payloadDigest, start.payloadDigest);
  const replay = await exchange(call.endpoint, start);
  assert.equal(replay.respondsTo(start), true);
  assert.equal(replay.payload.providerIdentity.pid, admitted.providerIdentity.pid);
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "started\n");

  const differentStart = new ManagedProcessMessage(call, "start", start.payload);
  const refused = await exchange(call.endpoint, differentStart);
  assert.equal(refused.payload.error.code, "PROCESS_EXECUTION_REQUEST_MISMATCH");
  assert.equal(readManagedRecord(call.outcomePath).state, "running");

  const operation = ManagedStopOperation.begin({ reason: "abort", graceMs: 2000 });
  const stop = new ManagedProcessMessage(call, "stop", operation.toPayload(), { requestId: operation.requestId });
  await exchange(call.endpoint, stop, { loseResponse: true });
  const stopping = await until(() => {
    const record = readManagedRecord(call.outcomePath);
    return record?.state === "stopping" ? record : null;
  }, "launcher did not persist stopping");
  const duplicateStop = await exchange(call.endpoint, stop);
  assert.equal(duplicateStop.respondsTo(stop), true);
  assert.deepEqual(duplicateStop.payload.stopOperation, operation.toJSON());
  assert.deepEqual(duplicateStop.payload.stopOperation, stopping.stopOperation);
  assert.equal(duplicateStop.payload.outcome.aborted, true);
  assert.equal(duplicateStop.payload.outcome.timedOut, false);
  const exited = once(child, "exit");
  fs.writeFileSync(path.join(root, "release"), "release");
  await exited;
  assert.equal(readManagedRecord(call.outcomePath).state, "finished");
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "started\n");
});

test("unknown socket disconnection retries the identical request and recovers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-reconnect-"));
  const call = callIn(root);
  const received = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (bytes) => {
      const request = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim()));
      received.push(request);
      if (received.length === 1) socket.destroy();
      else socket.end(`${JSON.stringify(request.respond({ state: "running" }))}\n`);
    });
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listen(call.endpoint, resolve));
  const result = await managedRequest(call, "status", {}, { policy: new ManagedControlPolicy({ initialMs: 20 }) });
  assert.equal(result.state, "running");
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
});

test("response request correlation is verified before returning its payload", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-correlation-"));
  const call = callIn(root);
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      const request = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim()));
      const wrong = request.respond({ state: "running" });
      wrong.operation = "stop";
      socket.end(`${JSON.stringify(wrong)}\n`);
    });
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listen(call.endpoint, resolve));
  await assert.rejects(managedRequest(call, "status"), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.attempts.length, 1);
    return true;
  });
});

test("the receiver permits an authenticated request after more than two seconds of input inactivity", async (t) => {
  const { call } = await launcherFixture(t);
  const socket = net.createConnection(call.endpoint);
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  // This is the protocol's inactivity boundary under test, not coordination.
  await delay(2100);
  assert.equal(socket.destroyed, false);
  const request = new ManagedProcessMessage(call, "status");
  socket.write(`${JSON.stringify(request)}\n`);
  const [bytes] = await once(socket, "data");
  const response = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim()));
  assert.equal(response.respondsTo(request), true);
  assert.equal(response.payload.state, "waiting");
});

for (const first of ["coordinator", "launcher"]) {
  test(`the ${first}'s stop decision is shared and later receiver admission is persisted`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-stop-race-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals = [];
    t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); });
    const call = callIn(root);
    const launcher = new ManagedLauncher({ call, maxBuffer: 64, graceMs: 2000 });
    launcher.child = {};
    launcher.capture = () => null;
    const coordinator = new ManagedStopOperationStore(call);
    let shared;
    if (first === "coordinator") {
      shared = coordinator.claim({ reason: "abort", graceMs: 2000 });
      launcher.stop("timeout");
    } else {
      launcher.stop("timeout");
      shared = coordinator.claim({ reason: "abort", graceMs: 2000 });
    }
    assert.deepEqual(launcher.stopOperation.toJSON(), shared.toJSON());
    assert.equal(launcher.outcome.aborted, first === "coordinator");
    assert.equal(launcher.outcome.timedOut, first === "launcher");
    assert.equal(readManagedRecord(call.outcomePath).stopRequest, null);
    const request = new ManagedProcessMessage(call, "stop", shared.toPayload(), { requestId: shared.requestId });
    const socket = new LauncherSocket();
    launcher.connect(socket);
    socket.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
    assert.equal(socket.response.respondsTo(request), true);
    assert.equal(socket.response.payload.state, "stopping");
    const saved = readManagedRecord(call.outcomePath);
    assert.deepEqual(saved.stopOperation, shared.toJSON());
    assert.deepEqual(saved.stopRequest, { requestId: request.requestId, payloadDigest: request.payloadDigest });
    assert.deepEqual(signals, [{ pid: -process.pid, signal: "SIGTERM" }]);
  });
}

test("a queued stop received after its deadline persists refusal without sending TERM or KILL", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-expired-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(process.hrtime, "bigint", () => 3000n * 1000000n);
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); });
  const call = callIn(root);
  const launcher = new ManagedLauncher({ call, maxBuffer: 64, graceMs: 20 });
  launcher.child = {};
  launcher.capture = () => ({ isStopped: () => false,
    stopFailure: () => managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Provider is still alive at the stop deadline") });
  const operation = new ManagedStopOperationStore(call).claim(ManagedStopOperation.begin({ reason: "abort", graceMs: 20, now: 100 }));
  const request = new ManagedProcessMessage(call, "stop", operation.toPayload(), { requestId: operation.requestId });
  const socket = new LauncherSocket();
  launcher.connect(socket);
  socket.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  t.mock.timers.tick(10000);
  assert.deepEqual(signals, []);
  const saved = readManagedRecord(call.outcomePath);
  assert.equal(saved.state, "control-failed");
  assert.equal(saved.controlFailure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  assert.equal(saved.outcome.finalAction, null);
  assert.deepEqual(saved.stopOperation, operation.toJSON());
  assert.deepEqual(saved.stopRequest, { requestId: request.requestId, payloadDigest: request.payloadDigest });
});

test("a KILL timer delayed beyond the stop deadline records refusal without another signal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-late-kill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let currentMs = 1000;
  t.mock.method(process.hrtime, "bigint", () => BigInt(currentMs) * 1000000n);
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); });
  const call = callIn(root);
  const launcher = new ManagedLauncher({ call, maxBuffer: 64, graceMs: 20 });
  launcher.child = {};
  launcher.capture = () => ({ isStopped: () => false,
    stopFailure: () => managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Provider remained alive past the delayed KILL timer") });
  launcher.stop("timeout");
  const operation = readManagedRecord(call.outcomePath).stopOperation;
  currentMs = operation.deadline + 1;
  t.mock.timers.tick(20);
  assert.deepEqual(signals, [{ pid: -process.pid, signal: "SIGTERM" }]);
  const saved = readManagedRecord(call.outcomePath);
  assert.equal(saved.state, "control-failed");
  assert.equal(saved.controlFailure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  assert.equal(saved.outcome.finalAction, "SIGTERM");
  assert.deepEqual(saved.stopOperation, operation);
});

for (const overdueSignal of ["SIGTERM", "SIGKILL"]) {
  test(`stop observation crossing the deadline does not send ${overdueSignal}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-stop-observation-overrun-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let currentMs = 1000;
    t.mock.method(process.hrtime, "bigint", () => BigInt(currentMs) * 1000000n);
    const signals = [];
    t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); });
    const call = callIn(root);
    const launcher = new ManagedLauncher({ call, maxBuffer: 64, graceMs: 20 });
    launcher.child = {};
    let captures = 0;
    launcher.capture = () => {
      if (++captures === (overdueSignal === "SIGTERM" ? 1 : 2)) currentMs = launcher.stopOperation.deadline + 1;
      return { isStopped: () => false,
        stopFailure: () => managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Stop observation crossed the deadline") };
    };
    launcher.stop("timeout");
    t.mock.timers.tick(20);
    assert.deepEqual(signals, overdueSignal === "SIGTERM" ? [] : [{ pid: -process.pid, signal: "SIGTERM" }]);
    const saved = readManagedRecord(call.outcomePath);
    assert.equal(saved.controlFailure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
    assert.equal(saved.outcome.finalAction, overdueSignal === "SIGTERM" ? null : "SIGTERM");
  });
}
