import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class MultiArchiveFixture {
  constructor(t) {
    this.root = createTmpDir("runtime-archive-capture-");
    this.runtimes = [];
    this.receipts = [];
    this.effects = path.join(this.root, "effects");
    t.after(async () => {
      for (const runtime of this.runtimes) if (!runtime.closed) await runtime.close();
      removeQuiescentRuntimeFixture({ mainRoot: this.root });
    });
  }
  async prepare({ environment = {} } = {}) {
    for (let index = 0; index < 2; index++) {
      const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, environment: {} });
      this.runtimes.push(runtime);
      const result = await executeManagedProcess(process.execPath, ["-e",
        `require('node:fs').appendFileSync(${JSON.stringify(this.effects)},${JSON.stringify(String(index))});process.stdout.write(${JSON.stringify(String(index))})`],
      { runtime, timeoutMs: 10000 });
      assert.equal(result.stdout, String(index));
      this.receipts.push(result.processExecutionStopReceipt.toJSON());
      await runtime.close();
      assert.equal(runtime.control.child.exitCode, 0);
    }
    this.active = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, environment });
    this.runtimes.push(this.active);
    this.expected = this.active.inspect();
    this.registry = fs.readFileSync(this.active.store.file.filePath);
    this.archives = this.active.store.archivesAuthority.directory;
    return this;
  }
  inspect() { return this.active.inspect(); }
  assertExact(value) {
    assert.deepEqual(value, this.expected);
    assert.deepEqual(value.executions.filter(execution => execution.status === "closed")
      .flatMap(execution => execution.calls.map(call => call.receipt)), this.receipts);
    assert.equal(fs.readFileSync(this.effects, "utf8"), "01");
    assert.deepEqual(fs.readFileSync(this.active.store.file.filePath), this.registry);
  }
}

test("multiple archived receipts are captured completely without changing their exact durable inventory", { timeout: 60000 }, async t => {
  const fixture = await new MultiArchiveFixture(t).prepare();
  const lstat = fs.lstatSync;
  let rootObservations = 0;
  const observer = t.mock.method(fs, "lstatSync", (file, ...options) => {
    if (file === fixture.root) rootObservations++;
    return lstat(file, ...options);
  });
  try {
    fixture.assertExact(fixture.inspect());
    fixture.assertExact(fixture.inspect());
  } finally {
    observer.mock.restore();
    t.diagnostic(JSON.stringify({ completeInventoryReads: 2, rootObservations, costEvidenceOnly: true }));
  }
});

test("warmed multi-archive reads reject changed physical archive bytes and recover the same saved receipts", { timeout: 60000 }, async t => {
  const fixture = await new MultiArchiveFixture(t).prepare();
  fixture.assertExact(fixture.inspect());
  const archive = path.join(fixture.archives, `${fixture.runtimes[1].executionId}.json`);
  const original = fs.readFileSync(archive);
  const identity = fs.lstatSync(archive, { bigint: true });
  const changed = JSON.parse(original);
  changed.payload.unexpectedArchiveCaptureField = true;
  changed.digest = executionValueDigest(changed.payload);
  try {
    fs.writeFileSync(archive, JSON.stringify(changed));
    const current = fs.lstatSync(archive, { bigint: true });
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.throws(() => fixture.inspect(), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
    assert.deepEqual(fs.readFileSync(fixture.active.store.file.filePath), fixture.registry);
    assert.equal(fs.readFileSync(fixture.effects, "utf8"), "01");
  } finally {
    fs.writeFileSync(archive, original);
  }
  fixture.assertExact(fixture.inspect());
});

// Observe native reads in the actual owned coordinator. The preload changes
// no result, IO contract or publication boundary; counts are comparative cost
// evidence and never replace the exact persisted-result assertions below.
test("new publication preserves every archived request and receipt through a complete captured view", { timeout: 60000 }, async t => {
  const fixture = new MultiArchiveFixture(t);
  const observationPath = path.join(fixture.root, "coordinator-archive-reads.json");
  const preload = `import fs from 'node:fs'; import path from 'node:path';
    if (path.basename(process.argv[1] ?? '') === 'execution-coordinator.js') {
      const open = fs.openSync;
      let archivedBlockOpens = 0, preparedArchiveBlockOpens = 0;
      fs.openSync = function(file, ...args) {
        const name = String(file);
        if (name.startsWith(${JSON.stringify(fixture.root + path.sep)})
          && name.includes(path.sep + 'blocks' + path.sep) && name.endsWith('.json')) {
          archivedBlockOpens++;
          if (new Error().stack.includes('readPreservedArchive')) preparedArchiveBlockOpens++;
        }
        return open.call(this, file, ...args);
      };
      process.once('beforeExit', () => fs.writeFileSync(${JSON.stringify(observationPath)},
        JSON.stringify({ pid: process.pid, archivedBlockOpens, preparedArchiveBlockOpens }), { flag: 'wx' }));
    }`;
  const nodeOptionsKey = Object.keys(process.env).find(key => key.toUpperCase() === "NODE_OPTIONS") ?? "NODE_OPTIONS";
  const environment = { ...process.env,
    [nodeOptionsKey]: `${process.env[nodeOptionsKey] ?? ""} --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`.trim() };
  const started = performance.now();
  await fixture.prepare({ environment });
  const previous = fixture.expected.executions.filter(execution => execution.status === "closed");
  const result = await executeManagedProcess(process.execPath, ["-e",
    `require('node:fs').appendFileSync(${JSON.stringify(fixture.effects)},'A');process.stdout.write('active')`],
  { runtime: fixture.active, timeoutMs: 10000 });
  assert.equal(result.stdout, "active");
  await fixture.active.close();
  assert.equal(fixture.active.control.child.exitCode, 0);
  assert.equal(fixture.active.control.child.signalCode, null);
  const reloaded = ProcessExecutionRuntime.inspect({ mainRoot: fixture.root });
  assert.equal(reloaded.executions.length, 3);
  assert.ok(reloaded.executions.every(execution => execution.status === "closed"));
  assert.deepEqual(reloaded.executions.filter(execution => previous.some(old => old.executionId === execution.executionId)), previous,
    "the original archived requests, outcomes, receipts and ordering survive the new publication exactly");
  const current = reloaded.executions.find(execution => execution.executionId === fixture.active.executionId);
  assert.deepEqual(current.calls.map(call => call.receipt), [result.processExecutionStopReceipt.toJSON()]);
  assert.equal(fs.readFileSync(fixture.effects, "utf8"), "01A", "each real child effect occurs exactly once");
  assert.equal(fs.existsSync(fixture.active.store.transition.filePath), false);
  assert.equal(fixture.active.store.ownerLock.inspect(), null);
  const observed = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  assert.equal(observed.pid, fixture.active.control.child.pid);
  assert.ok(observed.archivedBlockOpens > 0, "the actual coordinator still performs physical request reads");
  t.diagnostic(JSON.stringify({ ...observed, elapsedMs: performance.now() - started, costEvidenceOnly: true }));
});
