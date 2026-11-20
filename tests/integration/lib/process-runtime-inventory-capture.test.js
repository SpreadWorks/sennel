import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { sameFileIdentity } from "../../../src/lib/file-identity.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class ClosedRuntimeArchiveFixture {
  constructor(t, stdout) {
    this.root = createTmpDir("runtime-inventory-capture-");
    this.stdout = stdout;
    this.runtime = null;
    t.after(async () => {
      if (this.runtime && !this.runtime.closed) await this.runtime.close();
      removeQuiescentRuntimeFixture({ mainRoot: this.root });
    });
  }
  async prepare() {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, environment: {} });
    this.effect = path.join(this.root, "child-effect");
    this.result = await executeManagedProcess(process.execPath, ["-e",
      `require('node:fs').appendFileSync(${JSON.stringify(this.effect)},'once');process.stdout.write(${JSON.stringify(this.stdout)})`],
    { runtime: this.runtime, timeoutMs: 10000 });
    assert.equal(this.result.code, 0);
    assert.equal(this.result.stdout, this.stdout);
    await this.runtime.close();
    assert.equal(this.runtime.control.child.exitCode, 0);
    assert.equal(this.runtime.control.child.signalCode, null);
    assert.equal(this.runtime.store.ownerLock.inspect(), null);
    this.expected = this.runtime.inspect();
    assert.equal(this.expected.ownerEpoch, 1);
    assert.equal(this.expected.slot, null);
    assert.equal(this.expected.executions.length, 1);
    const execution = this.expected.executions.find(entry => entry.executionId === this.runtime.executionId);
    assert.equal(execution.status, "closed");
    assert.deepEqual(execution.calls[0].receipt, this.result.processExecutionStopReceipt.toJSON());
    assert.equal(fs.existsSync(this.runtime.store.transition.filePath), false);
    this.archive = path.join(this.runtime.store.archivesAuthority.directory, `${this.runtime.executionId}.json`);
    this.original = fs.readFileSync(this.archive);
    this.identity = fs.lstatSync(this.archive, { bigint: true });
    this.registry = fs.readFileSync(this.runtime.store.file.filePath);
    return this;
  }
  inspect() { return ProcessExecutionRuntime.inspect({ mainRoot: this.root }); }
  assertExactInventory(inventory) {
    assert.deepEqual(inventory, this.expected);
    assert.deepEqual(inventory.executions.find(entry => entry.executionId === this.runtime.executionId).calls[0].receipt,
      this.result.processExecutionStopReceipt.toJSON());
  }
  assertUnchanged() {
    assert.deepEqual(fs.readFileSync(this.runtime.store.file.filePath), this.registry);
    assert.equal(fs.readFileSync(this.effect, "utf8"), "once");
    assert.equal(this.runtime.store.ownerLock.inspect(), null);
    assert.equal(fs.existsSync(this.runtime.store.transition.filePath), false);
  }
}

test("captured archive reads preserve the exact receipt or refuse and later reads revalidate changed bytes", { timeout: 60000 }, async t => {
  const fixture = await new ClosedRuntimeArchiveFixture(t, "captured-archive").prepare();
  const physicalRead = AtomicFile.prototype.readSnapshot;
  const counts = { stable: 0, capturedView: 0, laterRead: 0 };
  const bytes = { stable: 0, capturedView: 0, laterRead: 0 };
  let phase = "stable", mutated = false;
  const observer = t.mock.method(AtomicFile.prototype, "readSnapshot", function (...args) {
    const snapshot = Reflect.apply(physicalRead, this, args);
    if (this.filePath === fixture.archive) {
      counts[phase] += 1;
      bytes[phase] += snapshot?.byteLength ?? 0;
      if (phase === "capturedView" && !mutated) {
        const changed = JSON.parse(fixture.original);
        changed.payload.unexpectedInventoryField = true;
        changed.digest = executionValueDigest(changed.payload);
        fs.writeFileSync(fixture.archive, JSON.stringify(changed));
        mutated = true;
      }
    }
    return snapshot;
  });
  try {
    fixture.assertExactInventory(fixture.inspect());
    phase = "capturedView";
    let captured = null, refusal = null;
    try { captured = fixture.inspect(); }
    catch (error) { refusal = error; }
    assert.equal(mutated, true);
    if (refusal === null) fixture.assertExactInventory(captured);
    else {
      assert.ok(refusal instanceof ProcessExecutionControlFailure);
      assert.equal(refusal.code, "PROCESS_EXECUTION_REGISTRY_FAILED");
      assert.equal(captured, null);
    }
    assert.equal(sameFileIdentity(fixture.identity, fs.lstatSync(fixture.archive, { bigint: true })), true);
    assert.equal(fs.readFileSync(fixture.archive).equals(fixture.original), false);
    phase = "laterRead";
    assert.throws(() => fixture.inspect(), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
    fixture.assertUnchanged();
  } finally {
    observer.mock.restore();
    fs.writeFileSync(fixture.archive, fixture.original);
    t.diagnostic(JSON.stringify({ archiveCaptureCounts: counts, archiveCaptureBytes: bytes, costEvidenceOnly: true }));
  }
  fixture.assertExactInventory(fixture.inspect());
  assert.equal(fs.readFileSync(fixture.effect, "utf8"), "once");
});

test("inventory never substitutes an incomplete later archive listing for its validated closed receipt view", { timeout: 60000 }, async t => {
  const fixture = await new ClosedRuntimeArchiveFixture(t, "archive-receipt").prepare();
  const backup = path.join(fixture.root, "captured-original-archive.json");
  const physicalRead = AtomicFile.prototype.readSnapshot;
  let moved = false;
  const observer = t.mock.method(AtomicFile.prototype, "readSnapshot", function (...args) {
    const snapshot = Reflect.apply(physicalRead, this, args);
    if (this.filePath === fixture.archive && !moved) {
      fs.renameSync(fixture.archive, backup);
      moved = true;
    }
    return snapshot;
  });
  try {
    let observed = null, refusal = null;
    try { observed = fixture.inspect(); }
    catch (error) { refusal = error; }
    assert.equal(moved, true);
    assert.deepEqual(fs.readFileSync(backup), fixture.original);
    assert.equal(sameFileIdentity(fixture.identity, fs.lstatSync(backup, { bigint: true })), true);
    if (refusal === null) {
      assert.equal(observed.ownerEpoch, fixture.expected.ownerEpoch);
      assert.equal(observed.executions.length, fixture.expected.executions.length,
        "returned inventory must include every captured validated execution");
      fixture.assertExactInventory(observed);
    } else {
      assert.ok(refusal instanceof ProcessExecutionControlFailure);
      assert.equal(refusal.code, "PROCESS_EXECUTION_RECORD_MISSING");
      assert.equal(observed, null);
    }
    assert.throws(() => fixture.inspect(), { code: "PROCESS_EXECUTION_RECORD_MISSING" });
    fixture.assertUnchanged();
  } finally {
    observer.mock.restore();
    if (moved) fs.renameSync(backup, fixture.archive);
  }
  fixture.assertExactInventory(fixture.inspect());
  assert.equal(fs.readFileSync(fixture.effect, "utf8"), "once");
});
