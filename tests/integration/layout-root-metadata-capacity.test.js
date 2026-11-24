import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { FileIdentity } from "../../src/lib/file-identity.js";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { LayoutMigrationEvidence } from "../../src/lib/layout-migration-evidence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

for (const originalMiB of [193, 257]) {
  test(`Layout preserves the original root metadata contract for ${originalMiB} MiB and a small plan`, t => {
    const root = createTmpDir("layout-root-evidence-capacity-");
    t.after(() => removeTmpDir(root));
    writeJson(root, ".senti/config.json", { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } });
    const target = path.join(root, ".gitignore");
    const chunk = Buffer.alloc(1024 * 1024, 32);
    const digest = crypto.createHash("sha256");
    const tail = Buffer.from(".senti/\n");
    const fd = fs.openSync(target, "wx");
    try {
      for (let index = 0; index < originalMiB; index++) { fs.writeFileSync(fd, chunk); digest.update(chunk); }
      fs.writeFileSync(fd, tail); digest.update(tail);
    } finally { fs.closeSync(fd); }
    const originalDigest = digest.digest("hex");
    const originalLength = originalMiB * chunk.length + tail.length;
    const originalIdentity = FileIdentity.capture(fs.lstatSync(target, { bigint: true }));
    const journalPath = path.join(root, ".tmp/sennel-migrate-layout.json");
    const publish = AtomicFile.prototype.publishStage;
    let first = null;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      if (this.filePath === journalPath && first === null) {
        const bytes = fs.readFileSync(journalPath);
        const journal = JSON.parse(bytes);
        const evidence = LayoutMigrationEvidence.fromJSON(root, journal.metadataImages);
        const original = journal.metadata.find(value => value.name === ".gitignore");
        const receipt = evidence.receipt(original.original);
        assert.equal(receipt.byteLength, originalLength);
        assert.equal(receipt.digest, originalDigest);
        assert.equal(originalIdentity.equals(FileIdentity.fromStored(original.originalIdentity)), true);
        evidence.assertIntact();
        first = { journal, byteLength: bytes.length };
      }
      return result;
    };
    let result;
    try { result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally { AtomicFile.prototype.publishStage = publish; }
    assert.equal(result.complete, true);
    assert.equal(result.migrated, true);
    assert.ok(first.byteLength < 16 * 1024, "raw payload size must not enlarge the journal");
    assert.equal(fs.readFileSync(target, "utf8"),
      ".sennel/*\n!.sennel/config.json\n!.sennel/templates/\n!.sennel/output/\n!.sennel/presets/\n.sennel/output/acceptance-report-*.json\n");
    assert.equal(result.receipt.operation, first.journal.operation);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.existsSync(path.join(root, ".sennel/config.json")), true);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(path.join(root, first.journal.metadataImages.path)), false);
    assert.equal(fs.existsSync(path.join(root, first.journal.beforeImages.path)), false);
  });
}

test("Layout streams a257MiB raw managed file through publication and cleanup without narrowing its original per-file contract", t => {
  const root = createTmpDir("layout-raw-file-capacity-");
  t.after(() => removeTmpDir(root));
  writeJson(root, ".senti/config.json", { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } });
  fs.mkdirSync(path.join(root, ".senti/plugins"));
  const source = path.join(root, ".senti/plugins/large.bin");
  const chunk = Buffer.alloc(1024 * 1024, 97);
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(source, "wx");
  try { for (let index = 0; index < 257; index++) { fs.writeFileSync(fd, chunk); digest.update(chunk); } }
  finally { fs.closeSync(fd); }
  const expectedDigest = digest.digest("hex");
  const journalPath = path.join(root, ".tmp/sennel-migrate-layout.json");
  const publish = AtomicFile.prototype.publishStage;
  let first = null;
  AtomicFile.prototype.publishStage = function (...args) {
    const result = publish.apply(this, args);
    if (this.filePath === journalPath && first === null) {
      const bytes = fs.readFileSync(journalPath);
      const journal = JSON.parse(bytes);
      const evidence = LayoutMigrationEvidence.fromJSON(root, journal.beforeImages);
      const receipt = evidence.receipt("plugins/large.bin");
      assert.equal(receipt.byteLength, 257 * chunk.length);
      assert.equal(receipt.digest, expectedDigest);
      evidence.assertIntact();
      first = { journal, byteLength: bytes.length };
    }
    return result;
  };
  let result;
  try { result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
  finally { AtomicFile.prototype.publishStage = publish; }
  assert.equal(result.complete, true);
  assert.equal(result.migrated, true);
  assert.ok(first.byteLength < 16 * 1024);
  const target = path.join(root, ".sennel/plugins/large.bin");
  const current = crypto.createHash("sha256");
  const input = fs.openSync(target, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  let byteLength = 0;
  try {
    for (;;) {
      const length = fs.readSync(input, buffer, 0, buffer.length, null);
      if (length === 0) break;
      current.update(buffer.subarray(0, length));
      byteLength += length;
    }
  } finally { fs.closeSync(input); }
  assert.equal(byteLength, 257 * chunk.length);
  assert.equal(current.digest("hex"), expectedDigest);
  assert.equal(fs.existsSync(path.join(root, ".senti")), false);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(fs.existsSync(path.join(root, first.journal.beforeImages.path)), false);
  assert.equal(fs.existsSync(path.join(root, first.journal.metadataImages.path)), false);
});
