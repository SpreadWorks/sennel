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

test("a TCP response preserves Unicode across a received byte boundary", async (t) => {
  const call = callIn();
  const expected = { literal: "日本語😀" };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (bytes) => {
      const request = ManagedProcessMessage.from(JSON.parse(bytes.toString().trim()));
      socket.end(`${JSON.stringify(request.respond(expected))}\n`);
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await listen(server, call);
  const emit = net.Socket.prototype.emit;
  const received = [];
  let fragmented = false;
  // Normalize only this real connection's data-event boundaries. Preserve every
  // server byte, but split the first UTF-8 code point independently of TCP packet
  // coalescing. The real transport still creates, writes and closes its socket.
  t.mock.method(net.Socket.prototype, "emit", function (event, ...args) {
    if (event !== "data" || this.remotePort !== call.endpoint.port || fragmented) {
      return emit.call(this, event, ...args);
    }
    received.push(Buffer.from(args[0]));
    if (!args[0].includes(10)) return true;
    const frame = Buffer.concat(received);
    const split = frame.indexOf(Buffer.from("日")) + 1;
    assert.ok(split > 1);
    fragmented = true;
    emit.call(this, "data", frame.subarray(0, split));
    return emit.call(this, "data", frame.subarray(split));
  });
  const response = await managedRequest(call, "status");
  assert.equal(fragmented, true);
  assert.deepEqual(response, expected);
});

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

import { ManagedProcessRequestBatch, ManagedRequestTransportCohort } from "../../../src/lib/managed-process-protocol.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";

async function cohortServer(t, call, respond) {
  const sockets = new Set(), incoming = [];
  let serverFailure = null;
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let text = "", complete = false;
    socket.on("data", (bytes) => {
      if (complete) return;
      text += bytes;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      complete = true;
      try {
        const raw = JSON.parse(text.slice(0, newline));
        const messages = Object.hasOwn(raw, "messages") ? ManagedProcessRequestBatch.fromEnvelope(raw).messages : [ManagedProcessMessage.from(raw)];
        for (const message of messages) message.assertPayload();
        incoming.push(messages);
        respond(socket, messages, incoming);
      } catch (cause) { serverFailure ??= cause; socket.destroy(cause); }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (serverFailure !== null) throw serverFailure;
  });
  await listen(server, call);
  return { server, sockets, incoming };
}

test("cohort transport correlates reordered replies and preserves a sibling refusal with its own physical target", async (t) => {
  const call = callIn(), ids = [randomUUID(), randomUUID(), randomUUID()], targets = ids.map(() => randomUUID());
  const carrier = new ManagedRequestTransportCohort();
  const observed = await cohortServer(t, call, (socket, messages) => {
    assert.equal(messages.length, 3);
    const refusal = new ProcessExecutionControlFailure("delegation-refused", "Selected target refused");
    socket.end([
      messages[1].respond({ ok: false, error: refusal.toJSON() }),
      messages[2].respond({ ok: true, value: "third" }),
      messages[0].respond({ ok: true, value: "first" }),
    ].map((response) => JSON.stringify(response) + "\n").join(""));
  });
  const settled = await Promise.allSettled(ids.map((requestId, index) => managedRequest(call, "reserve", {
    data: { call: { callId: targets[index] }, marker: index },
  }, { requestId, request: carrier.createRequest() })));
  assert.deepEqual(observed.incoming.map((messages) => messages.map((message) => message.requestId)), [ids]);
  assert.deepEqual(settled[0], { status: "fulfilled", value: { ok: true, value: "first" } });
  assert.deepEqual(settled[2], { status: "fulfilled", value: { ok: true, value: "third" } });
  const rejected = settled[1]; assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason.code, "PROCESS_EXECUTION_DELEGATION_REFUSED");
  assert.equal(rejected.reason.callId, targets[1]); assert.equal(rejected.reason.executionId, call.executionId);
  assert.equal(rejected.reason.communication.cutoff, "refused"); assert.equal(rejected.reason.communication.attempts.length, 1);
  assert.equal(rejected.reason.processExecutionStopReceipt, undefined);
});

test("cohort transport keeps a sibling connection live after one caller aborts and never upgrades its late reply", async (t) => {
  const call = callIn(), ids = [randomUUID(), randomUUID()];
  const carrier = new ManagedRequestTransportCohort(), controller = new AbortController();
  let accept;
  const received = new Promise((resolve) => { accept = resolve; });
  await cohortServer(t, call, (socket, messages) => accept({ socket, messages }));
  const first = managedRequest(call, "claim-launch", { data: { marker: "aborted" } }, {
    requestId: ids[0], request: carrier.createRequest(), abortSignal: controller.signal,
  });
  const second = managedRequest(call, "claim-launch", { data: { marker: "kept" } }, { requestId: ids[1], request: carrier.createRequest() });
  const { socket, messages } = await received;
  assert.equal(messages.length, 2);
  controller.abort(new Error("Selected caller cancelled"));
  await assert.rejects(first, (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_COMMUNICATION_ABORTED");
    assert.equal(error.communication.cutoff, "aborted"); assert.equal(error.communication.attempts.length, 1);
    assert.equal(error.communication.stopConfirmation, "unknown"); return true;
  });
  socket.end(messages.map((message, index) => JSON.stringify(message.respond({ ok: true, value: index === 0 ? "late" : "kept" })) + "\n").join(""));
  assert.deepEqual(await second, { ok: true, value: "kept" });
});

test("cohort transport retains separate immutable mailbox fallback state for every original operation", async (t) => {
  const root = createTmpDir("managed-cohort-fallback-"); t.after(() => removeTmpDir(root));
  const requests = path.join(root, "requests"), responses = path.join(root, "responses");
  fs.mkdirSync(requests); fs.mkdirSync(responses);
  const call = callIn(), ids = [randomUUID(), randomUUID()];
  const observed = await cohortServer(t, call, (socket) => socket.destroy());
  call.endpoint.mailbox = { requests, responses };
  const payloads = [{ data: { marker: "left" } }, { data: { marker: "right" } }];
  const expected = payloads.map((payload, index) => new ManagedProcessMessage(call, "reserve", payload, { requestId: ids[index] }));
  const files = ids.map((id) => new AtomicFile(path.join(requests, id + ".json")));
  const replies = ids.map((id) => new AtomicFile(path.join(responses, id + ".json")));
  let published = false;
  const onWait = () => {
    if (published) return;
    const bytes = files.map((file) => file.read());
    if (bytes.some((value) => value === null)) return;
    const messages = bytes.map((value) => ManagedProcessMessage.from(JSON.parse(value)));
    assert.deepEqual(messages, expected);
    for (const [index, message] of messages.entries()) replies[index].write(JSON.stringify(message.respond({ ok: true, value: payloads[index].data.marker })), { exclusive: true });
    published = true;
  };
  const carrier = new ManagedRequestTransportCohort();
  const returned = await Promise.all(payloads.map((payload, index) => managedRequest(call, "reserve", payload, {
    requestId: ids[index], request: carrier.createRequest(), onWait,
  })));
  assert.equal(published, true);
  assert.deepEqual(returned, [{ ok: true, value: "left" }, { ok: true, value: "right" }]);
  assert.deepEqual(observed.incoming.map((messages) => messages.map((message) => message.requestId)), [ids]);
  for (const [index, file] of files.entries()) assert.deepEqual(ManagedProcessMessage.from(JSON.parse(file.read())), expected[index]);
});

test("cohort transport preserves the original retry count and identity when one response slot expires beside a completed sibling", async (t) => {
  const call = callIn(), ids = [randomUUID(), randomUUID()];
  const policy = new ManagedControlPolicy({ initialMs: 100 }), carrier = new ManagedRequestTransportCohort();
  const observed = await cohortServer(t, call, (socket, messages) => {
    const kept = messages.find((message) => message.requestId === ids[1]);
    if (kept) socket.write(JSON.stringify(kept.respond({ ok: true, value: "kept" })) + "\n");
  });
  const returned = await Promise.allSettled(ids.map((requestId, index) => managedRequest(call, "reserve", { data: { marker: index } }, {
    requestId, request: carrier.createRequest(), policy,
  })));
  assert.deepEqual(returned[1], { status: "fulfilled", value: { ok: true, value: "kept" } });
  const expired = returned[0]; assert.equal(expired.status, "rejected");
  assert.equal(expired.reason.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
  assert.equal(expired.reason.communication.cutoff, "budget-exhausted");
  assert.equal(expired.reason.communication.attempts.length, policy.attemptCount);
  const received = observed.incoming.flat().filter((message) => message.requestId === ids[0]);
  assert.equal(received.length, policy.attemptCount);
  for (const message of received) assert.deepEqual(message, received[0]);
  assert.equal(observed.incoming.flat().filter((message) => message.requestId === ids[1]).length, 1);
  assert.equal(expired.reason.communication.stopConfirmation, "unknown");
});

test("cohort transport completes more operations than one bounded carrier without imposing a public admission limit", async (t) => {
  const call = callIn(), carrier = new ManagedRequestTransportCohort();
  const ids = Array.from({ length: ManagedProcessRequestBatch.maximumWidth + 2 }, () => randomUUID());
  const observed = await cohortServer(t, call, (socket, messages) => socket.end(messages.map((message) => {
    return JSON.stringify(message.respond({ ok: true, value: message.payload.data.marker })) + "\n";
  }).join("")));
  const returned = await Promise.all(ids.map((requestId, marker) => managedRequest(call, "reserve", { data: { marker } }, {
    requestId, request: carrier.createRequest(),
  })));
  assert.deepEqual(returned, ids.map((_id, marker) => ({ ok: true, value: marker })));
  assert.equal(observed.incoming.every((messages) => messages.length <= ManagedProcessRequestBatch.maximumWidth), true);
  assert.equal(observed.incoming.flat().length, ids.length);
  assert.deepEqual(new Set(observed.incoming.flat().map((message) => message.requestId)), new Set(ids));
});
