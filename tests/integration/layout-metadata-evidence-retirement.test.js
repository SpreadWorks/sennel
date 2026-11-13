import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { FileIdentity } from "../../src/lib/file-identity.js";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { LayoutMigrationEvidence } from "../../src/lib/layout-migration-evidence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

for (const rollback of [false, true]) {
  test(`cold Layout resumes after partial root metadata evidence retirement; rollback=${rollback}`, t => {
    const root = createTmpDir("layout-metadata-retirement-");
    t.after(() => removeTmpDir(root));
    writeJson(root, ".senti/config.json", { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } });
    fs.writeFileSync(path.join(root, ".gitignore"), ".senti/\n");
    fs.writeFileSync(path.join(root, ".gitattributes"), ".senti/output/analysis.json merge=ours\n");
    const journalPath = path.join(root, ".tmp/sennel-migrate-layout.json");
    const retire = LayoutMigrationEvidence.prototype.removeAfterCompletion;
    const remove = AtomicFile.prototype.remove;
    const rename = fs.renameSync;
    let metadataDirectory = null;
    let injected = false;
    let rollbackTriggered = false;
    LayoutMigrationEvidence.prototype.removeAfterCompletion = function (...args) {
      if (this.files.some(file => file.sourcePath.startsWith("root-"))) metadataDirectory = this.directory;
      return retire.apply(this, args);
    };
    AtomicFile.prototype.remove = function (...args) {
      const publication = remove.apply(this, args);
      if (!injected && metadataDirectory !== null && path.dirname(this.filePath) === metadataDirectory && publication.committed) {
        injected = true;
        throw Object.assign(new Error("injected metadata evidence retirement failure"), { code: "EIO" });
      }
      return publication;
    };
    fs.renameSync = function (from, to, ...args) {
      if (rollback && !rollbackTriggered && path.resolve(String(to)) === path.join(root, ".sennel")) {
        rollbackTriggered = true;
        throw Object.assign(new Error("injected final migration publication failure"), { code: "EIO" });
      }
      return rename.call(fs, from, to, ...args);
    };
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /metadata evidence retirement failure|migration and rollback both failed/);
    } finally {
      LayoutMigrationEvidence.prototype.removeAfterCompletion = retire;
      AtomicFile.prototype.remove = remove;
      fs.renameSync = rename;
    }
    assert.equal(injected, true, "a real owned metadata payload must be removed before interruption");
    assert.equal(rollbackTriggered, rollback);
    const saved = JSON.parse(fs.readFileSync(journalPath));
    assert.equal(saved.phase, rollback ? "rollback-complete" : "cleanup-complete");
    assert.equal(saved.owner.released, true, "only the original producer releases its writer");
    assert.equal(fs.existsSync(path.join(root, saved.stagingRelative)), false);
    assert.equal(fs.existsSync(path.join(root, saved.beforeImages.path)), false);
    assert.equal(fs.readdirSync(metadataDirectory).length, saved.metadataImages.files.length - 1);
    const metadata = [".gitignore", ".gitattributes"].map(name => ({ name,
      bytes: fs.readFileSync(path.join(root, name)), identity: FileIdentity.capture(fs.lstatSync(path.join(root, name), { bigint: true })) }));
    let retiredJournal = false;
    AtomicFile.prototype.remove = function (...args) {
      const publication = remove.apply(this, args);
      if (this.filePath === journalPath && publication.committed && !retiredJournal) {
        retiredJournal = true;
        for (const entry of metadata) {
          assert.deepEqual(fs.readFileSync(path.join(root, entry.name)), entry.bytes);
          assert.equal(entry.identity.equals(FileIdentity.capture(fs.lstatSync(path.join(root, entry.name), { bigint: true }))), true);
        }
      }
      return publication;
    };
    let result;
    try { result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally { AtomicFile.prototype.remove = remove; }
    assert.equal(retiredJournal, true);
    assert.equal(result.complete, true);
    assert.equal(result.recovered, true);
    assert.equal(result.migrated, rollback);
    assert.equal(fs.existsSync(path.join(root, ".sennel/config.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.existsSync(metadataDirectory), false);
    assert.equal(fs.existsSync(journalPath), false);
  });
}
