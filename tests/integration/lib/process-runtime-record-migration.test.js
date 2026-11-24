import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessRuntimeRecordMigrationStorage } from "../../../src/lib/process-execution-runtime.js";
import { ProcessRuntimeRecordMigration } from "../../../src/lib/process-runtime-record-migration.js";
import { materializeFrozenV8Package, produceFrozenV8HostDisconnectedState } from "../../support/infrastructure/frozen-runtime-v8-producer.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

let unexpectedFailure = null;

function quarantine(cause) {
  unexpectedFailure ??= cause;
  try { testTemporaryRoot().retainOnUnconfirmedExecution(); }
  catch (retention) { throw new AggregateError([cause, retention], "Migration fixture failure and retention failed", { cause }); }
}

function migrationTest(name, body) {
  test(name, async t => {
    if (unexpectedFailure !== null) throw new Error("An earlier migration fixture is retained", { cause: unexpectedFailure });
    const root = createTmpDir("record-migration-");
    let fixture; let complete = false;
    t.after(() => {
      if (!complete) { quarantine(unexpectedFailure ?? new Error("Migration fixture assertions are incomplete")); return; }
      try {
        // The helper already awaited the actual producer ChildProcess exit.
        // Recheck the selected current store before removing this owned fixture.
        new ProcessRuntimeRecordMigrationStorage({ mainRoot: fixture.checkout }).assertQuiescent();
        removeTmpDir(root);
      } catch (cause) { quarantine(cause); throw cause; }
    });
    try {
      fixture = await closedVersion8WithoutRequests(root);
      await body(fixture);
      complete = true;
    } catch (cause) {
      quarantine(cause);
      throw cause;
    }
  });
}

/** The genuine old bootstrap owns a separate producer process; its coordinator
 * uses the real in-process host-loss transition, not simulated IPC death. */
async function closedVersion8WithoutRequests(root) {
  const packageRoot = path.join(root, "previous-source");
  const provenance = materializeFrozenV8Package(packageRoot);
  assert.equal(provenance.sourceRuntimeRecordVersion, 8);
  assert.equal(provenance.sha256, "116edd38534d8b14947651eee68438b8a5164158852a8b81819ca52e5fab9e39");
  const checkout = path.join(root, "checkout");
  const facts = await produceFrozenV8HostDisconnectedState({ packageRoot, targetRoot: checkout,
    factsPath: path.join(root, "producer-facts.json"), logPath: path.join(root, "producer.log") });
  assert.equal(facts.sourcePackageRevision, provenance.sourcePackageRevision);
  assert.equal(facts.endpointWorkspaceCleaned, true);
  assert.equal(facts.producerRoute, "in-process-coordinator-host-disconnection-before-requests");
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  storage.assertQuiescent();
  const directory = storage.authority.directory;
  assert.equal(directory, facts.directory);
  const before = fs.readFileSync(path.join(directory, "registry.json"));
  assert.deepEqual(before, Buffer.from(facts.registryBytesBase64, "base64"));
  const stored = JSON.parse(before).payload;
  assert.equal(stored.version, 8);
  assert.equal(stored.slot, null);
  assert.equal(stored.executions.length, 1);
  assert.deepEqual(stored.executions[0].calls, []);
  assert.deepEqual(stored.executions[0].requests, []);
  assert.equal(stored.executions[0].status, "closed");
  assert.equal(stored.executions[0].closure.recovery, true);
  assert.equal(fs.existsSync(path.join(directory, "requests")), false);
  return { checkout, directory, before };
}

migrationTest("explicit migration previews and publishes authentic request-free history for normal strict readback", ({ checkout, directory, before }) => {
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  assert.equal(storage.version, 8);
  const capture = storage.capture();
  assert.equal(capture.targets.some(target => target.relativePath.startsWith("requests/")), false);
  const preview = new ProcessRuntimeRecordMigration({ mainRoot: checkout, dryRun: true }).run();
  assert.equal(preview.complete, true);
  assert.equal(preview.migrated, 0);
  capture.assertCurrent();
  assert.deepEqual(fs.readFileSync(path.join(directory, "registry.json")), before);
  const result = new ProcessRuntimeRecordMigration({ mainRoot: checkout }).run();
  assert.equal(result.complete, true);
  assert.equal(result.migrated, capture.targets.length);
  const reloaded = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  assert.equal(reloaded.version, 10);
  assert.equal(JSON.stringify(reloaded.validateCurrent()), JSON.stringify(capture.logicalInventory));
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: checkout });
  assert.equal(historical.executions.length, 1);
  assert.equal(historical.executions[0].status, "closed");
  assert.deepEqual(historical.executions[0].calls, []);
  assert.equal(JSON.stringify(historical.executions[0].closure), JSON.stringify(capture.logicalInventory.executions[0].closure));
  const after = fs.readFileSync(path.join(directory, "registry.json"));
  const noOp = new ProcessRuntimeRecordMigration({ mainRoot: checkout }).run();
  assert.equal(noOp.complete, true);
  assert.equal(noOp.migrated, 0);
  assert.deepEqual(fs.readFileSync(path.join(directory, "registry.json")), after);
});

migrationTest("a captured absent request namespace rejects later creation even without new block targets", ({ checkout, directory, before }) => {
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  const capture = storage.capture();
  assert.equal(capture.targets.some(target => target.relativePath.startsWith("requests/")), false);
  capture.assertCurrent();
  // An explicit physical source-change boundary, not a fabricated request or
  // a claim that a native provider produced this additional directory.
  fs.mkdirSync(path.join(directory, "requests"));
  assert.throws(() => capture.assertCurrent(), { code: "PROCESS_EXECUTION_AUTHORITY_MISMATCH" });
  assert.deepEqual(fs.readFileSync(path.join(directory, "registry.json")), before);
});

migrationTest("migration exclusion rejects thenables and releases locks for the next lawful synchronous operation", async ({ checkout, directory, before }) => {
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  let escaped = false;
  assert.throws(() => storage.runExclusive(async () => {
    await Promise.resolve();
    escaped = true;
  }), TypeError);
  await Promise.resolve();
  assert.equal(escaped, true, "rejecting a thenable does not cancel JavaScript");
  assert.equal(storage.runExclusive(current => {
    assert.equal(current, storage);
    current.capture().assertCurrent();
    return "exclusive operation completed";
  }), "exclusive operation completed");
  storage.assertQuiescent();
  assert.deepEqual(fs.readFileSync(path.join(directory, "registry.json")), before);
});
