import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { FileIdentity } from "../../src/lib/file-identity.js";
import { LayoutMigrationRevisionOne as PreviousLayoutMigrationRevisionOne } from "../fixtures/layout-migration-v9/producer.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../support/builders/tmp-dir.js";
import { failAfterJournalWrite, failDuringLegacyBackupRemoval } from "../support/infrastructure/layout-migration-failure.js";

const logger = { log() {}, error() {} };

class PreviousMigrationFixture {
  constructor(t) {
    this.root = createTmpDir("layout-previous-journal-");
    t.after(() => removeTmpDir(this.root));
    writeJson(this.root, ".sdd-forge/config.json", { name: "previous producer fixture", lang: "en", type: "base",
      docs: { languages: ["en"], defaultLanguage: "en" } });
    writeJson(this.root, ".sdd-forge/config.local.json", { docs: { mode: "generate" } });
    writeFile(this.root, ".sdd-forge/output/log.txt", "original opaque senti bytes\n");
    writeFile(this.root, ".gitignore", ".sdd-forge/output/\n");
    writeFile(this.root, ".gitattributes", ".sdd-forge/output/analysis.json merge=ours\n");
    this.originalConfig = fs.readFileSync(path.join(this.root, ".sdd-forge/config.json"));
    this.journalPath = path.join(this.root, ".tmp/sennel-migrate-layout.json");
  }

  produce({ rollback = false } = {}) {
    if (rollback) failAfterJournalWrite(this.root, 2, { Migration: PreviousLayoutMigrationRevisionOne });
    else failDuringLegacyBackupRemoval(this.root, { Migration: PreviousLayoutMigrationRevisionOne });
    const journal = JSON.parse(fs.readFileSync(this.journalPath));
    assert.equal(journal.version, 9);
    assert.equal(journal.sourceSnapshot.version, 2);
    assert.equal(journal.owner.released, true, "only the production finally release authorizes this cold recovery");
    assert.deepEqual(Buffer.from(journal.sourceSnapshot.entries.find(entry => entry.path === "config.json").bytes, "base64"), this.originalConfig);
    return journal;
  }

  assertCanonical() {
    assert.equal(fs.existsSync(path.join(this.root, ".sdd-forge")), false);
    assert.deepEqual(fs.readFileSync(path.join(this.root, ".sennel/config.json")), this.originalConfig);
    assert.equal(fs.readFileSync(path.join(this.root, ".sennel/output/log.txt"), "utf8"), "original opaque senti bytes\n");
    assert.equal(fs.existsSync(this.journalPath), false);
  }
}

test("the previous journal fixture retains the original public producer body with import relocation only", () => {
  const fixture = path.resolve("tests/fixtures/layout-migration-v9/producer.js");
  const provenance = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/layout-migration-v9/provenance.json")));
  const bytes = fs.readFileSync(fixture);
  const sha = value => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(sha(bytes), provenance.fixtureSha256);
  let original = bytes.toString("utf8");
  for (const [source, relocated] of Object.entries(provenance.importRelocations)) {
    original = original.replaceAll(`from ${JSON.stringify(relocated)}`, `from ${JSON.stringify(source)}`);
  }
  assert.equal(sha(original), provenance.originalSourceSha256);
});

test("cold cleanup of a released genuine previous journal preserves its publication receipt and canonical generation", t => {
  const fixture = new PreviousMigrationFixture(t);
  const journal = fixture.produce();
  assert.equal(journal.phase, "cleanup-source-verified");
  assert.ok(journal.receipt);
  const canonical = path.join(fixture.root, ".sennel");
  const identity = FileIdentity.capture(fs.lstatSync(canonical, { bigint: true }));
  const result = new LayoutMigrationRevisionOne(fixture.root, { logger }).run();
  assert.equal(result.recovered, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.receipt, journal.receipt, "recovery never invents a receipt using new snapshot hashes");
  assert.equal(identity.equals(FileIdentity.capture(fs.lstatSync(canonical, { bigint: true }))), true);
  fixture.assertCanonical();
  assert.equal(new LayoutMigrationRevisionOne(fixture.root, { logger }).run().noop, true);
  assert.equal(identity.equals(FileIdentity.capture(fs.lstatSync(canonical, { bigint: true }))), true);
});

test("cold rollback of a released genuine previous journal continues through current preflight in the same invocation", t => {
  const fixture = new PreviousMigrationFixture(t);
  const journal = fixture.produce({ rollback: true });
  assert.equal(journal.phase, "legacy-backed-up");
  assert.equal(journal.receipt, null);
  const result = new LayoutMigrationRevisionOne(fixture.root, { logger }).run();
  assert.equal(result.recovered, true);
  assert.equal(result.migrated, true);
  assert.equal(result.complete, true);
  assert.ok(result.receipt);
  fixture.assertCanonical();
});

test("a genuine previous snapshot with tampered embedded bytes is refused without rewriting its receipt or before-images", t => {
  const fixture = new PreviousMigrationFixture(t);
  const journal = fixture.produce();
  const backupConfig = path.join(fixture.root, journal.stagingRelative, "legacy-source-backup/config.json");
  const canonicalConfig = path.join(fixture.root, ".sennel/config.json");
  journal.sourceSnapshot.entries.find(entry => entry.path === "config.json").bytes = Buffer.from("foreign bytes").toString("base64");
  fs.writeFileSync(fixture.journalPath, JSON.stringify(journal));
  const evidence = fs.readFileSync(fixture.journalPath);
  assert.throws(() => new LayoutMigrationRevisionOne(fixture.root, { logger }).run(), /migration snapshot bytes or hash is invalid/);
  assert.deepEqual(fs.readFileSync(fixture.journalPath), evidence);
  assert.deepEqual(fs.readFileSync(backupConfig), fixture.originalConfig);
  assert.deepEqual(fs.readFileSync(canonicalConfig), fixture.originalConfig);
  assert.deepEqual(JSON.parse(evidence).receipt, journal.receipt);
});

test("cold previous-journal cleanup refuses foreign backup content while preserving the published target and original receipt", t => {
  const fixture = new PreviousMigrationFixture(t);
  const journal = fixture.produce();
  const foreign = path.join(fixture.root, journal.stagingRelative, "legacy-source-backup/foreign.txt");
  fs.writeFileSync(foreign, "foreign bytes stay here");
  const evidence = fs.readFileSync(fixture.journalPath);
  assert.throws(() => new LayoutMigrationRevisionOne(fixture.root, { logger }).run(), /legacy managed directory changed during cleanup: foreign\.txt/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "foreign bytes stay here");
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, ".sennel/config.json")), fixture.originalConfig);
  assert.deepEqual(fs.readFileSync(fixture.journalPath), evidence);
  assert.deepEqual(JSON.parse(evidence).receipt, journal.receipt);
});
