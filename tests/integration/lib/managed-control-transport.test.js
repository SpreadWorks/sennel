import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { ManagedProcessMessage, managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function callIn() {
  return { executionId: randomUUID(), callId: randomUUID(), ownerToken: randomUUID(), capability: randomUUID() };
}

async function listen(server, call) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  call.endpoint = { host: "127.0.0.1", port: server.address().port };
}

test("unknown socket disconnection retries the identical request and recovers", async (t) => {
  const root = createTmpDir("managed-reconnect-");
  const call = callIn();
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
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); removeTmpDir(root); });
  await listen(server, call);
  const result = await managedRequest(call, "status", {}, { policy: new ManagedControlPolicy({ initialMs: 20 }) });
  assert.equal(result.state, "running");
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
});

test("response request correlation is verified before returning its payload", async (t) => {
  const root = createTmpDir("managed-correlation-");
  const call = callIn();
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      const request = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim()));
      const wrong = request.respond({ state: "running" });
      wrong.operation = "stop";
      socket.end(`${JSON.stringify(wrong)}\n`);
    });
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); removeTmpDir(root); });
  await listen(server, call);
  await assert.rejects(managedRequest(call, "status"), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.attempts.length, 1);
    return true;
  });
});

test("a completed response to the same published mailbox request is observed while a later TCP attempt waits", { timeout: 20000 }, async (t) => {
  const root = createTmpDir("managed-completed-mailbox-");
  t.after(() => removeTmpDir(root));
  const requests = path.join(root, "requests"), responses = path.join(root, "responses");
  fs.mkdirSync(requests); fs.mkdirSync(responses);
  const call = { ...callIn(), endpoint: { host: "127.0.0.1", port: 1, mailbox: { requests, responses } } };
  const requestId = randomUUID();
  const payload = { literal: "same operation 日本語 $HOME&value" };
  const expected = new ManagedProcessMessage(call, "read-control", payload, { requestId });
  const requestFile = new AtomicFile(path.join(requests, `${requestId}.json`));
  const responseFile = new AtomicFile(path.join(responses, `${requestId}.json`));
  const policy = new ManagedControlPolicy();
  let connections = 0, published = false, savedRequest = null, firstSlotDeadline = null;
  const sockets = [];
  t.mock.method(net, "createConnection", () => {
    const socket = new net.Socket();
    sockets.push(socket);
    if (++connections === 1) queueMicrotask(() => socket.destroy(Object.assign(new Error("Fixture connection disconnected"), { code: "ECONNRESET" })));
    return socket;
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const started = performance.now();
  const result = await managedRequest(call, "read-control", payload, { requestId, policy, onWait(deadline) {
    // The initial settlement check receives the whole operation deadline.
    firstSlotDeadline ??= deadline - policy.budgetMs + policy.responseDeadlineMs(1);
    if (published || connections < 2 || performance.now() < firstSlotDeadline) return;
    savedRequest = requestFile.read();
    assert.ok(savedRequest, "the original fallback must publish its request before a response exists");
    const request = ManagedProcessMessage.from(JSON.parse(savedRequest));
    request.assertPayload();
    assert.equal(request.matches(call), true);
    assert.deepEqual(request, expected);
    responseFile.write(JSON.stringify(request.respond({ state: "running" })), { exclusive: true });
    published = true;
  } });
  const elapsedMs = performance.now() - started;
  assert.ok(connections >= 2, "the response must become available during a later real transport attempt");
  assert.equal(published, true);
  assert.deepEqual(result, { state: "running" });
  assert.ok(elapsedMs < policy.responseDeadlineMs(2), `completed mailbox acknowledgement must be observed before the second response deadline: ${elapsedMs}ms`);
  assert.deepEqual(requestFile.read(), savedRequest);
  assert.equal(ManagedProcessMessage.from(JSON.parse(responseFile.read())).respondsTo(expected), true);
});

test("an authenticated mailbox response without a published request cannot satisfy TCP settlement", async (t) => {
  const root = createTmpDir("managed-unsent-mailbox-");
  const requests = path.join(root, "requests"), responses = path.join(root, "responses");
  fs.mkdirSync(requests); fs.mkdirSync(responses);
  const call = callIn();
  const requestId = randomUUID();
  const payload = { literal: "unsent mailbox 日本語" };
  let received = null, connected = null, scheduled = false;
  const server = net.createServer((socket) => {
    connected = socket;
    socket.once("data", (bytes) => { received = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim())); });
  });
  t.after(async () => {
    connected?.destroy();
    await new Promise((resolve) => server.close(resolve));
    removeTmpDir(root);
  });
  await listen(server, call);
  call.endpoint.mailbox = { requests, responses };
  const expected = new ManagedProcessMessage(call, "read-control", payload, { requestId });
  const requestFile = new AtomicFile(path.join(requests, `${requestId}.json`));
  const responseFile = new AtomicFile(path.join(responses, `${requestId}.json`));
  const unsentResponse = Buffer.from(JSON.stringify(expected.respond({ state: "mailbox-without-request" })));
  responseFile.write(unsentResponse, { exclusive: true });
  const result = await managedRequest(call, "read-control", payload, { requestId, onWait() {
    if (received === null || scheduled) return;
    scheduled = true;
    // Let this settlement poll inspect the existing mailbox before TCP replies.
    setImmediate(() => connected.end(`${JSON.stringify(received.respond({ state: "tcp" }))}\n`));
  } });
  assert.equal(scheduled, true);
  assert.deepEqual(received, expected);
  assert.deepEqual(result, { state: "tcp" });
  assert.equal(requestFile.read(), null);
  assert.deepEqual(responseFile.read(), unsentResponse);
});

async function assertHealthyTcpWithUnavailableMailbox(t, code, boundary) {
    const root = createTmpDir("managed-inaccessible-mailbox-");
    const requests = path.join(root, "requests"), responses = path.join(root, "responses");
    fs.mkdirSync(requests); fs.mkdirSync(responses);
    const call = callIn();
    const requestId = randomUUID();
    const requestPath = path.join(requests, `${requestId}.json`);
    let received = null, connected = null, scheduled = false, writes = 0;
    const server = net.createServer((socket) => {
      connected = socket;
      socket.once("data", (bytes) => { received = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim())); });
    });
    t.after(async () => {
      connected?.destroy();
      await new Promise((resolve) => server.close(resolve));
      removeTmpDir(root);
    });
    await listen(server, call);
    call.endpoint.mailbox = { requests, responses };
    const read = AtomicFile.prototype.read, write = AtomicFile.prototype.write;
    t.mock.method(AtomicFile.prototype, "read", function (...args) {
      if (boundary === "request-read" && this.filePath === requestPath) throw Object.assign(new Error("Owned optional mailbox permission boundary"), { code });
      return read.apply(this, args);
    });
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", function (file, ...args) {
      if (boundary === "directory-stat" && file === requests) throw Object.assign(new Error("Owned optional mailbox directory permission boundary"), { code });
      return lstat.call(this, file, ...args);
    });
    t.mock.method(AtomicFile.prototype, "write", function (...args) {
      if (this.filePath === requestPath) writes++;
      return write.apply(this, args);
    });
    const result = await managedRequest(call, "read-control", { literal: "healthy TCP" }, { requestId, onWait() {
      if (received === null || scheduled) return;
      scheduled = true;
      setImmediate(() => connected.end(`${JSON.stringify(received.respond({ state: "tcp" }))}\n`));
    } });
    assert.equal(scheduled, true);
    assert.deepEqual(result, { state: "tcp" });
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(requestPath), false);
}

test("a healthy TCP response does not require permission to inspect its optional mailbox", async (t) => {
  for (const code of ["EACCES", "EPERM"]) await t.test(code, (t) => assertHealthyTcpWithUnavailableMailbox(t, code, "request-read"));
});

test("a healthy TCP response does not require permission to inspect its optional mailbox directory", async (t) => {
  for (const code of ["EACCES", "EPERM"]) await t.test(code, (t) => assertHealthyTcpWithUnavailableMailbox(t, code, "directory-stat"));
});
