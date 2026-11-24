import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { ProcessExecutionControlEndpoint } from "../../../src/lib/process-execution-endpoint.js";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { isNativePathWithin } from "../../../src/lib/portable-path.js";
import { ProcessExecutionRuntime, ProcessExecutionGrant } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { managedRequest, ManagedProcessFrameReader } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

function unusedEndpoint(t, root) {
  const workspace = ReadOnlyInvocationWorkspace.create();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    // This factory never launches an owner or receives an accepted execution.
    workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
    workspace.cleanup({ generation: workspace.generation });
    cleaned = true;
  };
  t.after(cleanup);
  return { endpoint: ProcessExecutionControlEndpoint.create(workspace.processRuntimeStorage(), root), cleanup };
}

async function runtimeFixture(t) {
  const root = createTmpDir("separate-process-endpoint-");
  let runtime;
  t.after(async () => {
    try { if (runtime && !runtime.closed) await runtime.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  return { root, runtime };
}

/** External transport fault only: forward authenticated bytes, drop TCP replies. */
class ReplyDroppingProxy {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.sockets = new Set();
    this.requests = [];
    this.droppedReplies = 0;
    this.errors = [];
    this.server = net.createServer(client => {
      const upstream = net.createConnection({ host: endpoint.host, port: endpoint.port });
      const requestFrames = new ManagedProcessFrameReader();
      const responseFrames = new ManagedProcessFrameReader();
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        socket.on("error", error => { this.errors.push(error.code); client.destroy(); upstream.destroy(); });
      }
      client.once("close", () => upstream.destroy());
      client.on("data", bytes => {
        for (const frame of requestFrames.read(bytes)) {
          const message = JSON.parse(frame);
          this.requests.push({ requestId: message.requestId, payloadDigest: message.payloadDigest });
        }
        upstream.write(bytes);
      });
      upstream.on("data", bytes => {
        for (const frame of responseFrames.read(bytes)) {
          assert.ok(JSON.parse(frame).requestId);
          this.droppedReplies += 1;
        }
      });
    });
  }

  static async create(t, endpoint) {
    const proxy = new this(endpoint);
    t.after(async () => {
      for (const socket of proxy.sockets) socket.destroy();
      await new Promise((resolve, reject) => proxy.server.close(error => error ? reject(error) : resolve()));
    });
    await new Promise((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    return proxy;
  }
}

test("a late TCP response-slot timeout still prepares mailbox replay within the original communication budget", { timeout: 60000 }, async t => {
  const { root, runtime } = await runtimeFixture(t);
  const grant = runtime.remoteGrant();
  const proxy = await ReplyDroppingProxy.create(t, grant.endpoint);
  // Only the carrier route changes. The message's authenticated grant keeps
  // the real endpoint and all original checkout/owner/request authority.
  const route = { ...grant, endpoint: { ...grant.endpoint, port: proxy.server.address().port } };
  const policy = new ManagedControlPolicy();
  const pauses = [];
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const timers = policy.responseDeadlinesMs.slice(0, -1).map(deadline => setTimeout(() => {
    pauses.push(deadline);
    Atomics.wait(waitBuffer, 0, 0, 250);
  }, deadline - 25));
  let response;
  try { response = await managedRequest(route, "authenticate", { grant, data: {} }, { policy }); }
  finally { for (const timer of timers) clearTimeout(timer); }
  assert.ok(pauses.length >= 1, "the actual first response timer fires after its slot cutoff");
  assert.equal(response.ok, true);
  assert.equal(response.value.grant.executionId, runtime.executionId);
  assert.equal(response.value.checkout.executionRoot, root);
  assert.ok(proxy.droppedReplies >= 1, "the real coordinator committed and replied through the blackholed TCP route");
  assert.ok(proxy.requests.length <= policy.attemptCount);
  assert.equal(new Set(proxy.requests.map(message => message.requestId)).size, 1);
  assert.equal(new Set(proxy.requests.map(message => message.payloadDigest)).size, 1);
  assert.deepEqual(proxy.errors, []);
});

test("retained endpoint decoding is structural while a live endpoint requires its minted physical storage", (t) => {
  const root = createTmpDir("endpoint-history-structure-");
  t.after(() => removeTmpDir(root));
  const { endpoint, cleanup } = unusedEndpoint(t, root);
  const saved = endpoint.toJSON();
  const assertMalformedIdentitiesRefused = () => {
    for (const field of ["workspaceIdentity", "directoryIdentity"]) {
      for (const identity of [null, {}, { dev: "1" }, { dev: "1", ino: "" }, { dev: 1, ino: "2" }, { dev: "1", ino: "2", extra: "3" }]) {
        const malformed = { ...saved, storage: { ...saved.storage, [field]: identity } };
        assert.throws(() => new ProcessExecutionControlEndpoint(malformed), { code: "READONLY_WORKSPACE_STORAGE_AUTHORITY_INVALID" });
      }
      const missing = { ...saved.storage };
      delete missing[field];
      missing.unrelated = null;
      assert.throws(() => new ProcessExecutionControlEndpoint({ ...saved, storage: missing }),
        { code: "READONLY_WORKSPACE_STORAGE_AUTHORITY_INVALID" });
    }
  };
  assertMalformedIdentitiesRefused();
  assert.equal(endpoint.assertCheckout(root), endpoint);
  assert.equal(endpoint.assertStorage().directory, saved.storage.directory);
  assert.throws(() => endpoint.assertCheckout(path.join(root, "other-checkout")), TypeError);
  cleanup();
  assert.equal(fs.existsSync(saved.storage.workspaceRoot), false);
  assertMalformedIdentitiesRefused();
  assert.deepEqual(new ProcessExecutionControlEndpoint(saved).toJSON(), saved,
    "historical endpoint shape remains readable without reopening its expired physical directory");
  assert.throws(() => new ProcessExecutionControlEndpoint(saved).assertStorage(), error =>
    error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" && error.cause?.code === "ENOENT");
});

test("mailbox-only registered execution uses separate control scratch and keeps it after actual coordinator exit", { timeout: 60000 }, async (t) => {
  const { root, runtime } = await runtimeFixture(t);
  const grant = runtime.remoteGrant();
  assert.equal(grant.version, 3);
  assert.equal(grant.storage, null, "ordinary registry storage remains checkout-owned");
  assert.equal(runtime.store.authority.directory.startsWith(path.join(root, ".sennel", "process-runtime") + path.sep), true);
  assert.equal(isNativePathWithin(root, grant.endpoint.storage.workspaceRoot), false);
  assert.equal(grant.endpoint.mailbox.requests.startsWith(grant.endpoint.storage.directory + path.sep), true);
  assert.equal(grant.endpoint.mailbox.responses.startsWith(grant.endpoint.storage.directory + path.sep), true);
  const remote = await ProcessExecutionRuntime.fromRemoteGrant({ ...grant, transport: "mailbox" });
  const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('separate-control')"],
    { runtime: remote, timeoutMs: 10000 });
  assert.equal(result.stdout, "separate-control");
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
  assert.equal(result.processExecutionStopReceipt.observation.code, 0);
  assert.equal(result.processExecutionStopReceipt.output.completion, "complete");
  const saved = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
  assert.deepEqual(saved.endpoint, grant.endpoint);
  assert.deepEqual(saved.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  await remote.close();
  await runtime.close();
  assert.equal(runtime.control.child.exitCode, 0);
  assert.equal(fs.existsSync(grant.endpoint.mailbox.responses), true, "actual exit must retain terminating reply replay storage");
  assert.equal(new ProcessExecutionControlEndpoint(grant.endpoint).assertStorage().directory, grant.endpoint.storage.directory);
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions
    .find((execution) => execution.executionId === runtime.executionId);
  assert.equal(history.status, "closed");
  assert.deepEqual(history.endpoint, grant.endpoint);
  assert.deepEqual(history.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
});

test("current grants reject missing, altered and other-owner endpoint storage before protected registry mutation", { timeout: 60000 }, async (t) => {
  const { root, runtime } = await runtimeFixture(t);
  const grant = runtime.remoteGrant(), before = runtime.store.file.read();
  assert.throws(() => new ProcessExecutionGrant({ ...grant, version: 2 }), TypeError);
  const { storage: _storage, ...missingStorage } = grant.endpoint;
  assert.throws(() => new ProcessExecutionGrant({ ...grant, endpoint: missingStorage }), TypeError);
  const changed = JSON.parse(JSON.stringify(grant));
  changed.endpoint.storage.token = "00000000-0000-4000-8000-000000000000";
  assert.throws(() => new ProcessExecutionGrant(changed), { code: "READONLY_WORKSPACE_STORAGE_AUTHORITY_INVALID" });
  const { endpoint } = unusedEndpoint(t, root);
  const otherEndpoint = endpoint.withPort(grant.endpoint.port).toJSON();
  const forged = new ProcessExecutionGrant({ ...grant, endpoint: otherEndpoint }).toJSON();
  await assert.rejects(managedRequest(forged, "runtime-snapshot", { grant: forged, data: {} }),
    { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.deepEqual(runtime.store.file.read(), before);
  assert.deepEqual(runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId).endpoint, grant.endpoint);
});
