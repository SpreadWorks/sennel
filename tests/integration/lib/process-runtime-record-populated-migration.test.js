import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionHistoricalInventory, ProcessRuntimeRecordMigrationStorage, ProcessExecutionRuntimeRecordMigrationPrepared } from "../../../src/lib/process-execution-runtime.js";
import { AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { ProcessRuntimeRecordMigration } from "../../../src/lib/process-runtime-record-migration.js";
import { MigrationProcessOwner } from "../../../src/lib/migration-process-owner.js";
import { OfflineMigrationDirectorySnapshot } from "../../support/assertions/migration-directory-snapshot.js";
import { materializeFrozenV8Package, produceFrozenV8PopulatedState } from "../../support/infrastructure/frozen-runtime-v8-producer.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

import { assertProcessRuntimeEvidencePreserved } from "../../support/assertions/process-evidence-migration.js";

let unexpectedFailure = null;
function quarantine(root, cause) {
  unexpectedFailure ??= cause;
  const file = path.join(root, "firstfailure.json");
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ status: "FAIL", errorType: cause?.constructor?.name ?? null,
      errorCode: typeof cause?.code === "string" ? cause.code : null, originalFailureRetained: true }) + "\n", { flag: "wx", mode: 0o600 });
    testTemporaryRoot().retainOnUnconfirmedExecution();
  } catch (retention) { throw new AggregateError([cause, retention], "Populated migration failure and evidence retention failed", { cause }); }
}
function migrationTest(name, body) {
  test(name, async t => {
    if (unexpectedFailure !== null) throw new Error("An earlier populated migration fixture is retained", { cause: unexpectedFailure });
    const root = createTmpDir("populated-record-migration-");
    let complete = false, stopped = false, fixture;
    const checkpoint = () => {
      if (stopped || unexpectedFailure !== null || t.signal.aborted) throw unexpectedFailure ?? new Error("Populated migration body is no longer active");
    };
    t.after(() => {
      if (!complete) {
        stopped = true;
        quarantine(root, unexpectedFailure ?? new Error("Populated migration body did not complete"));
        return;
      }
      try {
        assert.equal(fixture.facts.producerExit.code, 0); assert.equal(fixture.facts.producerExit.signal, null);
        new ProcessRuntimeRecordMigrationStorage({ mainRoot: fixture.checkout }).assertQuiescent();
        removeTmpDir(root);
      } catch (cause) { stopped = true; quarantine(root, cause); throw cause; }
    });
    try {
      fixture = await populatedVersion8(root, checkpoint);
      checkpoint();
      await body(fixture, checkpoint);
      checkpoint(); complete = true;
    } catch (cause) { stopped = true; quarantine(root, cause); throw cause; }
  });
}

async function populatedVersion8(root, checkpoint) {
  checkpoint();
  const packageRoot = path.join(root, "previous-source");
  const provenance = materializeFrozenV8Package(packageRoot);
  assert.equal(provenance.sourcePackageRevision, "1f06da0d3a4426ad41cf2980bee7693bf8362149142e4759db1ded65240cf20a");
  assert.equal(provenance.sha256, "116edd38534d8b14947651eee68438b8a5164158852a8b81819ca52e5fab9e39");
  const checkout = path.join(root, "checkout");
  const facts = await produceFrozenV8PopulatedState({ packageRoot, targetRoot: checkout,
    factsPath: path.join(root, "producer-facts.json"), logPath: path.join(root, "producer.log") });
  // A timeout/failed body cannot resume into canonical inspection after the
  // independently bootstrapped old producer's promise eventually settles.
  checkpoint();
  assert.equal(facts.sourcePackageRevision, provenance.sourcePackageRevision);
  assert.equal(facts.producerRoute, "actual-public-registered-child-and-normal-owner-close");
  for (const witness of [facts.producerExit, facts.businessExit, facts.coordinatorExit]) {
    assert.ok(Number.isInteger(witness.pid) && witness.pid > 0);
    assert.equal(witness.code, 0); assert.equal(witness.signal, null);
  }
  assert.equal(facts.originalOwnerLockReleased, true);
  assert.deepEqual(facts.actualCommandEnvironmentKeys, []);
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  storage.assertQuiescent(); assert.equal(storage.version, 8);
  assert.equal(storage.authority.directory, facts.directory);
  const capture = storage.capture();
  assertProcessRuntimeEvidencePreserved(facts.originalInventory, capture.logicalInventory);
  const expected = capture.logicalInventory;
  const execution = facts.originalInventory.executions[0];
  assert.equal(execution.status, "closed"); assert.equal(execution.calls.length, 1);
  assert.ok(execution.requests.length > 0); assert.equal(execution.runtimeOnlyDispositions.length, 4);
  assert.ok(JSON.stringify(execution.calls[0].receipt) === facts.receiptText);
  const callsDirectory = path.join(facts.directory, "calls");
  const callDirectory = path.join(callsDirectory, execution.calls[0].callId);
  const namespaces = [OfflineMigrationDirectorySnapshot.capture(checkout, callsDirectory),
    OfflineMigrationDirectorySnapshot.capture(checkout, callDirectory)];
  const fixture = { root, checkout, directory: facts.directory, storage, capture, expected, facts, namespaces };
  assertPrivateArtifacts(fixture);
  return fixture;
}
function assertPrivateArtifacts(fixture) {
  for (const namespace of fixture.namespaces) namespace.assertUnchanged();
  for (const artifact of fixture.facts.artifacts) {
    const file = path.join(fixture.directory, ...artifact.relativePath.split("/"));
    assert.ok(fs.readFileSync(file).equals(Buffer.from(artifact.bytesBase64, "base64")), "every original private artifact byte remains exact");
    const stat = fs.lstatSync(file, { bigint: true });
    const actual = Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));
    assert.deepEqual(actual, artifact.nativeGeneration);
  }
}
function strictCurrentReadback(fixture) {
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: fixture.checkout });
  storage.assertQuiescent(); assert.equal(storage.version, 10);
  assert.equal(storage.inspectTransition(), null);
  const inventory = storage.validateCurrent();
  assert.ok(JSON.stringify(inventory) === JSON.stringify(fixture.expected), "normal10 strict readback must preserve the complete original graph");
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: fixture.checkout });
  assert.ok(history instanceof ProcessExecutionHistoricalInventory);
  assert.ok(JSON.stringify(history.inventory) === JSON.stringify(fixture.expected), "the public history inventory must preserve full replies, outcome, receipt and order");
  assert.ok(JSON.stringify(history.executions) === JSON.stringify(fixture.expected.executions), "unfiltered public history executions must retain the complete original array and order");
  assert.ok(JSON.stringify(history.checkoutIdentity.toJSON()) === JSON.stringify(fixture.expected.checkout), "the typed public history checkout must retain the exact original JSON identity");
  assertPrivateArtifacts(fixture);
  return storage;
}

migrationTest("explicit migration preserves populated authentic8 registered history and every private binary artifact", fixture => {
  const preview = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout, dryRun: true }).run();
  assert.equal(preview.complete, true); assert.equal(preview.migrated, 0);
  fixture.capture.assertCurrent(); assertPrivateArtifacts(fixture);
  const result = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout }).run();
  assert.equal(result.complete, true); assert.equal(result.migrated, fixture.capture.targets.length);
  strictCurrentReadback(fixture);
  const noOp = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout }).run();
  assert.equal(noOp.complete, true); assert.equal(noOp.migrated, 0);
  strictCurrentReadback(fixture);
});

migrationTest("interrupted populated8 publication recovers only its exact released migration plan and keeps private bytes unchanged", fixture => {
  const planned = new Error("controlled interruption after first converted dependency");
  const firstTarget = fixture.capture.targets[0].relativePath;
  assert.ok(firstTarget.startsWith("requests/"));
  let injected = false, observed = false;
  const migration = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout, faultInjector(event) {
    const relative = path.relative(fixture.directory, event.filePath).split(path.sep).join("/");
    if (!injected && event.phase === "after-runtime-dependency-publication" && relative === firstTarget) {
      injected = true; throw planned;
    }
  } });
  try { migration.run(); }
  catch (cause) { if (cause !== planned) throw cause; observed = true; }
  assert.equal(injected, true); assert.equal(observed, true);
  // This is the one planned failure. Every different failure escapes directly
  // to quarantine before further namespace reads, cleanup, recovery or close.
  const storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: fixture.checkout });
  storage.assertQuiescent();
  const selected = storage.inspectTransition();
  assert.ok(selected instanceof ProcessExecutionRuntimeRecordMigrationPrepared);
  assert.equal(selected.metadata.owner.released, true);
  MigrationProcessOwner.fromJSON(selected.metadata.owner).assertInactive();
  storage.assertPlanCurrent(selected);
  assert.equal(selected.targets.length, fixture.capture.targets.length);
  assertPrivateArtifacts(fixture);
  const dryRun = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout, recover: true, dryRun: true }).run();
  assert.equal(dryRun.complete, false); assert.equal(dryRun.requiresRecovery, true);
  storage.assertPlanCurrent(selected); assertPrivateArtifacts(fixture);
  const recovered = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout, recover: true }).run();
  assert.equal(recovered.complete, true); assert.equal(recovered.recovered, true);
  assert.equal(recovered.migrated, fixture.capture.targets.length);
  strictCurrentReadback(fixture);
});

migrationTest("a nondurable populated8 stage fault discards only owned parents and permits a fresh complete migration", fixture => {
  const planned = new Error("controlled nondurable converted stage interruption");
  const firstTarget = fixture.capture.targets[0].relativePath;
  assert.ok(firstTarget.startsWith("requests/"));
  const parentRelative = path.posix.dirname(firstTarget);
  const newParent = fixture.capture.absenceObservations().find(absence => absence.relativePath === parentRelative);
  assert.ok(newParent, "the authentic source8 conversion must require a genuinely absent target parent");
  let injected = false, observed = false;
  const migration = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout, faultInjector(event) {
    const relative = path.relative(fixture.directory, event.filePath).split(path.sep).join("/");
    if (!injected && event.phase === "before-runtime-dependency-temp-close" && relative === firstTarget) {
      assert.ok(fs.lstatSync(path.dirname(event.filePath)).isDirectory());
      assert.ok(fs.lstatSync(event.tempPath).isFile());
      injected = true; throw planned;
    }
  } });
  try { migration.run(); }
  catch (cause) {
    if (!(cause instanceof AtomicFileWriteError) || cause.cause !== planned || cause.cleanupFailed
      || cause.committedToVisibleName || cause.publicationUnknown) throw cause;
    assert.equal(cause.phase, "before-runtime-dependency-temp-close"); observed = true;
  }
  assert.equal(injected, true); assert.equal(observed, true);
  assert.equal(migration.storage.inspectTransition(), null);
  assert.equal(migration.storage.version, 8);
  assert.equal(fs.existsSync(path.join(fixture.directory, ...parentRelative.split("/"))), false);
  fixture.capture.assertCurrent(); assertPrivateArtifacts(fixture);
  // A fresh run gets a fresh Store; no stale nominal directory object is reused after owned-parent rollback.
  const fresh = new ProcessRuntimeRecordMigration({ mainRoot: fixture.checkout });
  const result = fresh.run();
  assert.equal(result.complete, true); assert.equal(result.migrated, fixture.capture.targets.length);
  strictCurrentReadback(fixture);
});
