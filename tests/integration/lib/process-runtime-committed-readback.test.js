import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { sameFileIdentity } from "../../../src/lib/file-identity.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

const exactInventoryDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function closedFixture(t) {
  const root = createTmpDir("committed-runtime-readback-");
  let runtime;
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  const effect = path.join(root, "child-effect");
  const result = await executeManagedProcess(process.execPath, ["-e",
    `require('node:fs').appendFileSync(${JSON.stringify(effect)},'once');process.stdout.write('retained')`],
  { runtime, timeoutMs: 10000 });
  assert.equal(result.code, 0);
  await runtime.close();
  assert.equal(runtime.control.child.exitCode, 0);
  assert.equal(runtime.control.child.signalCode, null);
  assert.equal(runtime.store.ownerLock.inspect(), null);
  assert.equal(fs.existsSync(runtime.store.transition.filePath), false);
  const expected = runtime.inspect();
  assert.equal(expected.version, 10);
  assert.equal(expected.slot, null);
  assert.equal(expected.executions[0].status, "closed");
  assert.deepEqual(expected.executions[0].calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  assert.equal(exactInventoryDigest(runtime.store.readInventory()), exactInventoryDigest(expected));
  return { root, runtime, expected, effect };
}

test("committed same-byte registry replacement is freshly validated by cached and new readers", { timeout: 60000 }, async t => {
  const { root, runtime, expected, effect } = await closedFixture(t);
  const registry = runtime.store.file.filePath;
  const before = fs.lstatSync(registry, { bigint: true });
  const bytes = fs.readFileSync(registry);
  const evidence = path.join(root, "original-committed-registry.json");
  fs.renameSync(registry, evidence);
  fs.writeFileSync(registry, bytes, { flag: "wx", mode: 0o600 });
  assert.equal(sameFileIdentity(before, fs.lstatSync(registry, { bigint: true })), false);
  assert.equal(exactInventoryDigest(runtime.store.readInventory()), exactInventoryDigest(expected));
  assert.equal(exactInventoryDigest(ProcessExecutionRuntime.inspect({ mainRoot: root })), exactInventoryDigest(expected));
  assert.equal(fs.readFileSync(registry).equals(bytes), true);
  assert.equal(fs.readFileSync(evidence).equals(bytes), true);
  assert.equal(fs.readFileSync(effect, "utf8"), "once");
  assert.equal(runtime.store.ownerLock.inspect(), null);
  assert.equal(fs.existsSync(runtime.store.transition.filePath), false);
});

test("committed same-inode corruption cannot reuse the previously validated logical graph", { timeout: 60000 }, async t => {
  const { root, runtime, effect } = await closedFixture(t);
  const registry = runtime.store.file.filePath;
  const before = fs.lstatSync(registry, { bigint: true });
  fs.writeFileSync(registry, "{");
  assert.equal(sameFileIdentity(before, fs.lstatSync(registry, { bigint: true })), true);
  assert.throws(() => runtime.store.read({ immutable: true }), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
  assert.equal(fs.readFileSync(registry, "utf8"), "{");
  assert.equal(fs.readFileSync(effect, "utf8"), "once");
  assert.equal(runtime.store.ownerLock.inspect(), null);
});


for (const mutation of ["same-byte-replacement", "same-inode-corruption", "missing-block"]) {
  test(`warmed committed request readback validates ${mutation} through cached and fresh readers`, { timeout: 60000 }, async t => {
    const { root, runtime, expected, effect } = await closedFixture(t);
    const executionId = expected.executions[0].executionId;
    const paths = runtime.store.requestStorage.referencedBlockPaths(new Set([executionId]));
    assert.ok(paths.length > 0);
    const block = path.join(runtime.store.authority.directory, ...paths[0].split("/"));
    const original = fs.readFileSync(block), identity = fs.lstatSync(block, { bigint: true });
    const beforeRegistry = runtime.store.file.read();
    const backup = path.join(root, "original-request-block.json");
    try {
      if (mutation === "same-inode-corruption") {
        const envelope = JSON.parse(original);
        envelope.payload.unexpectedRequestField = true;
        envelope.digest = exactInventoryDigest(envelope.payload);
        fs.writeFileSync(block, JSON.stringify(envelope));
        assert.equal(sameFileIdentity(identity, fs.lstatSync(block, { bigint: true })), true);
      } else {
        fs.renameSync(block, backup);
        if (mutation === "same-byte-replacement") {
          fs.writeFileSync(block, original, { flag: "wx", mode: 0o600 });
          assert.equal(sameFileIdentity(identity, fs.lstatSync(block, { bigint: true })), false);
        }
      }
      if (mutation === "same-byte-replacement") {
        assert.equal(exactInventoryDigest(runtime.store.readInventory()), exactInventoryDigest(expected));
        assert.equal(exactInventoryDigest(ProcessExecutionRuntime.inspect({ mainRoot: root })), exactInventoryDigest(expected));
        assert.deepEqual(fs.readFileSync(block), original);
      } else {
        const code = mutation === "missing-block" ? "PROCESS_EXECUTION_RECORD_MISSING" : "PROCESS_EXECUTION_REGISTRY_FAILED";
        assert.throws(() => runtime.store.readInventory(), { code });
        assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code });
      }
      assert.deepEqual(runtime.store.file.read(), beforeRegistry);
      assert.equal(fs.readFileSync(effect, "utf8"), "once");
      assert.equal(runtime.store.ownerLock.inspect(), null);
      assert.equal(fs.existsSync(runtime.store.transition.filePath), false);
    } finally {
      // Restore only this test's closed, quiescent fixture for its owned teardown.
      if (mutation === "same-inode-corruption") fs.writeFileSync(block, original);
      else {
        if (fs.existsSync(block)) fs.unlinkSync(block);
        fs.renameSync(backup, block);
      }
    }
    assert.equal(exactInventoryDigest(runtime.store.readInventory()), exactInventoryDigest(expected));
    assert.equal(exactInventoryDigest(ProcessExecutionRuntime.inspect({ mainRoot: root })), exactInventoryDigest(expected));
  });
}
