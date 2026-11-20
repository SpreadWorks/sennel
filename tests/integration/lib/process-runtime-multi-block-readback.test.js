import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class MultiBlockReadbackFixture {
  constructor(t) {
    this.root = createTmpDir("runtime-multi-block-readback-");
    this.effects = path.join(this.root, "effects");
    this.receipts = [];
    t.after(async () => {
      if (this.runtime && !this.runtime.closed) await this.runtime.close();
      removeQuiescentRuntimeFixture({ mainRoot: this.root });
    });
  }
  async prepare() {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, environment: {} });
    for (let index = 0; index < 4; index++) {
      const script = "/*" + "x".repeat(100000) + "*/"
        + `require('node:fs').appendFileSync(${JSON.stringify(this.effects)},${JSON.stringify(String(index))});process.stdout.write(${JSON.stringify(String(index))})`;
      const result = await executeManagedProcess(process.execPath, ["-e", script],
        { runtime: this.runtime, timeoutMs: 10000 });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, String(index));
      this.receipts.push(result.processExecutionStopReceipt.toJSON());
    }
    await this.runtime.close();
    assert.equal(this.runtime.control.child.exitCode, 0);
    this.expected = this.runtime.store.readInventory();
    this.registry = fs.readFileSync(this.runtime.store.file.filePath);
    this.blocks = this.runtime.store.requestStorage.referencedBlockPaths(new Set([this.runtime.executionId]));
    assert.ok(this.blocks.length > 2, "the actual public producer must create a history spanning multiple physical request blocks");
    return this;
  }
  assertExact(value) {
    assert.deepEqual(value, this.expected);
    assert.deepEqual(value.executions.find(execution => execution.executionId === this.runtime.executionId)
      .calls.map(call => call.receipt), this.receipts);
    assert.equal(fs.readFileSync(this.effects, "utf8"), "0123");
    assert.deepEqual(fs.readFileSync(this.runtime.store.file.filePath), this.registry);
    assert.equal(this.runtime.store.ownerLock.inspect(), null);
    assert.equal(fs.existsSync(this.runtime.store.transition.filePath), false);
  }
}

test("warm multi-block inventory retains exact receipts and revalidates every later physical block", { timeout: 120000 }, async t => {
  const fixture = await new MultiBlockReadbackFixture(t).prepare();
  fixture.assertExact(fixture.runtime.store.readInventory());
  const lstat = fs.lstatSync;
  let rootObservations = 0;
  const observer = t.mock.method(fs, "lstatSync", (file, ...options) => {
    if (file === fixture.root) rootObservations++;
    return lstat(file, ...options);
  });
  try {
    fixture.assertExact(fixture.runtime.store.readInventory());
    fixture.assertExact(fixture.runtime.store.readInventory());
  } finally {
    observer.mock.restore();
    t.diagnostic(JSON.stringify({ physicalBlocks: fixture.blocks.length,
      completeInventoryReads: 2, rootObservations, costEvidenceOnly: true }));
  }
  const file = path.join(fixture.runtime.store.authority.directory, ...fixture.blocks.at(-1).split("/"));
  const original = fs.readFileSync(file);
  const identity = fs.lstatSync(file, { bigint: true });
  const changed = JSON.parse(original);
  changed.payload.unexpectedPhysicalField = true;
  changed.digest = executionValueDigest(changed.payload);
  try {
    fs.writeFileSync(file, JSON.stringify(changed));
    const current = fs.lstatSync(file, { bigint: true });
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.throws(() => fixture.runtime.store.readInventory(), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
    assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: fixture.root }),
      { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
    assert.equal(fs.readFileSync(fixture.effects, "utf8"), "0123");
    assert.deepEqual(fs.readFileSync(fixture.runtime.store.file.filePath), fixture.registry);
  } finally {
    fs.writeFileSync(file, original);
  }
  fixture.assertExact(fixture.runtime.store.readInventory());
  fixture.assertExact(ProcessExecutionRuntime.inspect({ mainRoot: fixture.root }));
});
