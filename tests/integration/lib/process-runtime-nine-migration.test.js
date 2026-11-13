import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessRuntimeRecordMigrationStorage } from "../../../src/lib/process-execution-runtime.js";
import { ProcessRuntimeRecordMigration } from "../../../src/lib/process-runtime-record-migration.js";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { materializeFrozenV9Package, produceFrozenV9ClosedState, calibrateFrozenV9BlockRetirement } from "../../support/infrastructure/frozen-runtime-v9-producer.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { StoredFlowPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { testTemporaryRoot } from "../../test-environment.js";

import { assertProcessRuntimeEvidencePreserved } from "../../support/assertions/process-evidence-migration.js";

const logger = { log() {} };
let firstFailure = null;

function migrationTest(name, body, producerOptions = {}) {
  test(name, { timeout: 120000, skip: process.platform !== "linux" ? "Genuine previous native producer acceptance is Linux-only; macOS/Windows acceptance is unverified" : false }, async t => {
    if (firstFailure !== null) throw new Error("An earlier native migration fixture is retained", { cause: firstFailure });
    const root = createTmpDir("runtime-nine-migration-");
    let complete = false, active = true, facts, checkout;
    const checkpoint = () => {
      if (!active || t.signal.aborted || firstFailure !== null) throw firstFailure ?? new Error("Native migration fixture no longer owns its test phase");
    };
    t.after(() => {
      active = false;
      if (!complete) { testTemporaryRoot().retainOnUnconfirmedExecution(); return; }
      assert.equal(facts.producerExit.code, 0);
      assert.equal(facts.producerExit.signal, null);
      new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).assertQuiescent();
      removeTmpDir(root);
    });
    try {
      initGitRepo(root);
      const packageRoot = path.join(root, "original-source");
      const provenance = materializeFrozenV9Package(packageRoot);
      assert.equal(provenance.sourcePackageRevision, "7d58bd1b4cd78f8e80129b6b7ccf8d56329123a5245bab7d275ae90ac764e833");
      assert.equal(provenance.sha256, "ea0d4f025dd94a8f13007abfca00e48221ccd00e02775ec82402a75f5c96c2fc");
      let sourceOptions = producerOptions;
      if (producerOptions.calibrateRetirement === true) {
        const calibrationRoot = path.join(root, "calibration");
        const acceptanceRoot = path.join(root, "acceptancex");
        // Sibling names have equal encoded lengths; the opaque bytes change,
        // never their authority or actual process lifecycle.
        assert.equal(calibrationRoot.length, acceptanceRoot.length);
        fs.mkdirSync(calibrationRoot); fs.mkdirSync(acceptanceRoot);
        const seed = await produceFrozenV9ClosedState({ packageRoot, targetRoot: path.join(calibrationRoot, "checkout"),
          bindingPaddingBytes: 40000, factsPath: path.join(root, "calibration-facts.json"), logPath: path.join(root, "calibration-producer.log") });
        checkpoint();
        assert.equal(seed.producerExit.code, 0); assert.equal(seed.producerExit.signal, null);
        assert.equal(seed.originalOwnerReleased, true);
        new ProcessRuntimeRecordMigrationStorage({ mainRoot: path.join(calibrationRoot, "checkout") }).assertQuiescent();
        sourceOptions = await calibrateFrozenV9BlockRetirement(packageRoot, seed, 40000);
        checkout = path.join(acceptanceRoot, "checkout");
      } else checkout = path.join(root, "checkout");
      facts = await produceFrozenV9ClosedState({ ...sourceOptions, packageRoot, targetRoot: checkout,
        factsPath: path.join(root, "source-facts.json"), logPath: path.join(root, "source-producer.log") });
      checkpoint();
      assert.equal(facts.originalOwnerReleased, true);
      for (const witness of [facts.parentExit, facts.coordinatorExit]) {
        assert.ok(witness.pid > 0); assert.equal(witness.code, 0); assert.equal(witness.signal, null);
      }
      await body({ root, checkout, facts, checkpoint });
      checkpoint(); complete = true;
    } catch (cause) { firstFailure ??= cause; active = false; testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
  });
}


migrationTest("genuine revision-nine parent/child, unlaunched revocation and refusal migrate without reissuing their canonical ACKs", async ({ checkout, facts }) => {
  const before = new StoredFlowPersistenceSnapshot(checkout);
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: checkout }), { code: "PROCESS_EXECUTION_RUNTIME_RECORD_MIGRATION_REQUIRED" });
  const preview = new ProcessRuntimeRecordMigration({ mainRoot: checkout, dryRun: true, logger }).run();
  assert.equal(preview.preview.sourceVersion, 9); assert.equal(preview.preview.targetVersion, 10);
  before.assertUnchanged();
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: checkout, logger }).run().complete, true);
  const current = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).inspectCurrent();
  assertProcessRuntimeEvidencePreserved(facts.inventory, current);
  assert.equal(current.executions[0].calls.filter(call => call.receipt !== null).length, 2);
  assert.equal(current.executions[0].calls.filter(call => call.revocation !== null).length, 1);
  assert.ok(facts.publications.length > 0);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: checkout, environment: {} });
  const coordinator = runtime.control.child;
  const script = path.join(checkout, "after-migration.mjs");
  fs.writeFileSync(script, "process.stdout.write('current');\n", { flag: "wx" });
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script, cwd: checkout, env: {}, stdio: "pipe" }), [], { timeoutMs: 10000 }));
  assert.equal(result.stdout, "current");
  await runtime.close(); assert.equal(runtime.closed, true); assert.equal(coordinator.exitCode, 0); assert.equal(coordinator.signalCode, null);
  assert.equal(runtime.inspect().ownerEpoch, facts.inventory.ownerEpoch + 1);
});

migrationTest("the public runtime revision-ten CLI previews and converts a genuine closed revision-nine namespace", async ({ checkout, facts }) => {
  const execute = extra => spawnSync(process.execPath, [path.resolve("src/sennel.js"), "migrate", "runtime", "--to", "10", ...extra], {
    cwd: checkout, encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: checkout, SENNEL_SOURCE_ROOT: checkout },
  });
  const before = new StoredFlowPersistenceSnapshot(checkout);
  const preview = execute(["--dry-run"]); assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /from9 to10/);
  before.assertUnchanged();
  const applied = execute([]); assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stdout, /reached revision 10/);
  assertProcessRuntimeEvidencePreserved(facts.inventory, new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).inspectCurrent());
});

migrationTest("an interrupted selected revision-nine migration refuses execution and recovers its exact data publication", async ({ checkout, facts }) => {
  assert.throws(() => new ProcessRuntimeRecordMigration({ mainRoot: checkout, logger,
    faultInjector({ phase }) { if (phase === "after-runtime-publication-prepared") throw new Error("interrupted source-nine publication"); },
  }).run(), /interrupted source-nine publication/);
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: checkout }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.throws(() => new ProcessRuntimeRecordMigration({ mainRoot: checkout, logger }).run(), /explicit --recover/);
  const before = new StoredFlowPersistenceSnapshot(checkout);
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: checkout, recover: true, dryRun: true, logger }).run().requiresRecovery, true);
  before.assertUnchanged();
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: checkout, recover: true, logger }).run().complete, true);
  assertProcessRuntimeEvidencePreserved(facts.inventory, new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).inspectCurrent());
});


migrationTest("migration retires obsolete original blocks with durable before-images and recovers after retirement", ({ checkout, facts }) => {
  const source = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout });
  const capture = source.capture();
  const retired = capture.targets.filter(target => target.removal);
  assert.ok(retired.length > 0, "original legal packing must leave blocks superseded by current repacking");
  const first = retired[0].relativePath;
  const original = facts.records.find(record => record.relativePath === first);
  assert.ok(original);
  assert.deepEqual(retired[0].bytes, Buffer.from(original.bytesBase64, "base64"));
  let interrupted = false;
  const planned = new Error("interrupted immediately after original block retirement");
  assert.throws(() => new ProcessRuntimeRecordMigration({ mainRoot: checkout, logger,
    faultInjector({ phase, filePath }) {
      if (phase === "after-runtime-dependency-publication" && path.relative(facts.directory, filePath).split(path.sep).join("/") === first) {
        interrupted = true;
        assert.equal(fs.existsSync(filePath), false);
        throw planned;
      }
    },
  }).run(), cause => cause === planned);
  assert.equal(interrupted, true);
  const selected = new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).inspectTransition();
  const removal = selected.targets.find(target => target.relativePath === first);
  assert.equal(removal.removal, true);
  assert.equal(removal.sourceStage.generation.digest, original.sha256);
  const before = new StoredFlowPersistenceSnapshot(checkout);
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: checkout, recover: true, dryRun: true, logger }).run().requiresRecovery, true);
  before.assertUnchanged();
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: checkout, recover: true, logger }).run().complete, true);
  for (const target of retired) assert.equal(fs.existsSync(path.join(facts.directory, target.relativePath)), false);
  assertProcessRuntimeEvidencePreserved(facts.inventory, new ProcessRuntimeRecordMigrationStorage({ mainRoot: checkout }).inspectCurrent());
}, { calibrateRetirement: true });
