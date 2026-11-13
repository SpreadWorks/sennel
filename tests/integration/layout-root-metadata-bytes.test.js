import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { FileIdentity } from "../../src/lib/file-identity.js";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { LayoutMigrationEvidence } from "../../src/lib/layout-migration-evidence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

const logger = { log() {}, error() {} };
const originalIgnore = Buffer.concat([Buffer.from("#\ufeff"), Buffer.from([0xff]), Buffer.from("🙂\n.senti/\n")]);
const originalAttributes = Buffer.concat([Buffer.from(".senti/output/analysis.json merge=ours\n#"), Buffer.from([0xf0, 0x9f])]);
const plannedIgnore = "#\ufeff�🙂\n.sennel/*\n!.sennel/config.json\n!.sennel/templates/\n!.sennel/output/\n!.sennel/presets/\n.sennel/output/acceptance-report-*.json\n";
const plannedAttributes = ".sennel/output/analysis.json merge=ours\n#�\n";

// The causal comparison spans the two explicit candidate encodings. Normal
// product readers still accept only their own current format.
function originalBytes(root, journal, name) {
  const entry = journal.metadata.find(value => value.name === name);
  return journal.metadataImages === undefined ? Buffer.from(entry.original, "base64")
    : LayoutMigrationEvidence.fromJSON(root, journal.metadataImages).readBytes(entry.original);
}

function seed(t) {
  const root = createTmpDir("layout-root-raw-bytes-");
  t.after(() => removeTmpDir(root));
  writeJson(root, ".senti/config.json", { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } });
  fs.writeFileSync(path.join(root, ".gitignore"), originalIgnore);
  fs.writeFileSync(path.join(root, ".gitattributes"), originalAttributes);
  return root;
}

function assertOriginal(root) {
  assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), originalIgnore);
  assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), originalAttributes);
}

function assertComplete(root, result) {
  assert.equal(result.complete, true);
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), plannedIgnore);
  assert.equal(fs.readFileSync(path.join(root, ".gitattributes"), "utf8"), plannedAttributes);
  assert.equal(fs.existsSync(path.join(root, ".senti")), false);
  assert.equal(fs.existsSync(path.join(root, ".sennel/config.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".tmp/sennel-migrate-layout.json")), false);
}

// Reuse the existing real rename-failure boundary. Only the normal producer
// publishes and releases the journal; no owner or terminal field is invented.
function interruptMetadata(root, blockRestoration) {
  const rename = fs.renameSync;
  let publicationInterrupted = false;
  let restorationInterrupted = false;
  fs.renameSync = function (from, to, ...rest) {
    if (!publicationInterrupted && path.resolve(String(to)) === path.join(root, ".gitattributes")) {
      publicationInterrupted = true;
      throw Object.assign(new Error("metadata publication interrupted"), { code: "EIO" });
    }
    if (blockRestoration && publicationInterrupted && path.resolve(String(to)) === path.join(root, ".gitignore")) {
      restorationInterrupted = true;
      throw Object.assign(new Error("metadata restoration interrupted"), { code: "EIO" });
    }
    return rename.call(fs, from, to, ...rest);
  };
  try {
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger }).run(),
      /metadata publication interrupted|migration and rollback both failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(publicationInterrupted, true);
  assert.equal(restorationInterrupted, blockRestoration);
}

test("Layout accepts original non-UTF8 metadata while retaining raw before-images until publication", t => {
  const root = seed(t);
  const journalPath = path.join(root, ".tmp/sennel-migrate-layout.json");
  const publish = AtomicFile.prototype.publishStage;
  let first = null;
  AtomicFile.prototype.publishStage = function (...args) {
    const result = publish.apply(this, args);
    if (this.filePath === journalPath && first === null) {
      first = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      assert.deepEqual(originalBytes(root, first, ".gitignore"), originalIgnore);
      assert.deepEqual(originalBytes(root, first, ".gitattributes"), originalAttributes);
    }
    return result;
  };
  let result;
  try { result = new LayoutMigrationRevisionOne(root, { logger }).run(); }
  finally { AtomicFile.prototype.publishStage = publish; }
  assertComplete(root, result);
  assert.equal(result.receipt.operation, first.operation);
  assert.equal(result.receipt.sourceFingerprint, first.sourceSnapshotFingerprint);
  assert.equal(result.receipt.targetFingerprint, first.stagedSnapshotFingerprint);
});

test("readonly Layout preserves arbitrary original metadata bytes and generations without creating scratch", t => {
  const root = seed(t);
  const before = [".gitignore", ".gitattributes"].map(name => FileIdentity.capture(fs.lstatSync(path.join(root, name), { bigint: true })));
  const result = new LayoutMigrationRevisionOne(root, { logger, dryRun: true }).run();
  assert.equal(result.migrated, false);
  assertOriginal(root);
  for (const [index, name] of [".gitignore", ".gitattributes"].entries()) {
    assert.equal(before[index].equals(FileIdentity.capture(fs.lstatSync(path.join(root, name), { bigint: true }))), true);
  }
  assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
  assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
});

test("failed metadata publication restores raw original bytes rather than decoded text", t => {
  const root = seed(t);
  interruptMetadata(root, false);
  assertOriginal(root);
  assert.equal(fs.existsSync(path.join(root, ".senti/config.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
  assert.equal(fs.existsSync(path.join(root, ".tmp/sennel-migrate-layout.json")), false);
});

for (const foreignEdit of [false, true]) {
  test(`cold Layout reads raw original metadata after interrupted restoration; foreign edit=${foreignEdit}`, t => {
    const root = seed(t);
    interruptMetadata(root, true);
    const journalPath = path.join(root, ".tmp/sennel-migrate-layout.json");
    const before = fs.readFileSync(journalPath);
    const saved = JSON.parse(before);
    assert.equal(saved.owner.released, true);
    assert.deepEqual(originalBytes(root, saved, ".gitignore"), originalIgnore);
    assert.deepEqual(originalBytes(root, saved, ".gitattributes"), originalAttributes);
    if (foreignEdit) {
      const target = path.join(root, ".gitignore");
      const foreign = Buffer.from("foreign metadata\n");
      fs.writeFileSync(target, foreign);
      const identity = FileIdentity.capture(fs.lstatSync(target, { bigint: true }));
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger }).run(),
        /changed by another process|input-invalid/);
      assert.deepEqual(fs.readFileSync(target), foreign);
      assert.equal(identity.equals(FileIdentity.capture(fs.lstatSync(target, { bigint: true }))), true);
      assert.deepEqual(fs.readFileSync(journalPath), before);
      assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    } else {
      const publish = AtomicFile.prototype.publishStage;
      let rawRestored = false;
      AtomicFile.prototype.publishStage = function (...args) {
        const result = publish.apply(this, args);
        if (this.filePath === path.join(root, ".gitignore") && fs.readFileSync(this.filePath).equals(originalIgnore)) rawRestored = true;
        return result;
      };
      let result;
      try { result = new LayoutMigrationRevisionOne(root, { logger }).run(); }
      finally { AtomicFile.prototype.publishStage = publish; }
      assert.equal(rawRestored, true);
      assert.equal(result.recovered, true);
      assertComplete(root, result);
    }
  });
}
