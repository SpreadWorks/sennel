import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { LayoutMigrationRevisionOne } from "../../../src/lib/layout-migration.js";

// Leave the real journal at a durable phase using an I/O failure. Mutation
// failures also prevent rollback, while the production finally block alone
// publishes the writer release. No owner field is edited by this fixture.
export function failAfterJournalWrite(root, writeNumber, { Migration = LayoutMigrationRevisionOne, checkpointPhase = null } = {}) {
  const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
  const publish = AtomicFile.prototype.publishStage;
  const rename = fs.renameSync;
  const remove = fs.rmSync;
  let writes = 0;
  let reached = false;
  let stagingRoot = null;
  const fault = () => Object.assign(new Error("injected migration I/O failure"), { code: "EIO" });
  try {
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      if (this.filePath === journalPath && !reached) {
        const atCheckpoint = checkpointPhase === null ? ++writes === writeNumber
          : JSON.parse(fs.readFileSync(journalPath, "utf8")).phase === checkpointPhase;
        if (atCheckpoint) {
          reached = true;
          stagingRoot = path.join(root, JSON.parse(fs.readFileSync(journalPath, "utf8")).stagingRelative);
        }
      }
      return result;
    };
    fs.renameSync = function (from, to, ...rest) {
      if (reached) {
        const release = path.resolve(String(to)) === journalPath
          && JSON.parse(fs.readFileSync(from, "utf8")).owner.released === true;
        if (!release) throw fault();
      }
      return rename.call(fs, from, to, ...rest);
    };
    fs.rmSync = function (...args) {
      const target = path.resolve(String(args[0]));
      if (reached && (target === stagingRoot || target.startsWith(`${stagingRoot}${path.sep}`))) throw fault();
      return remove.apply(fs, args);
    };
    assert.throws(() => new Migration(root, { logger: { log() {}, error() {} } }).run(),
      /injected migration I\/O failure|migration and rollback both failed/);
  } finally {
    AtomicFile.prototype.publishStage = publish;
    fs.renameSync = rename;
    fs.rmSync = remove;
  }
  assert.equal(reached, true);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.owner.released, true);
  return journal;
}

export function failDuringLegacyBackupRemoval(root, { Migration = LayoutMigrationRevisionOne } = {}) {
  const remove = fs.rmSync;
  let injected = false;
  try {
    fs.rmSync = function (target, options) {
      if (!injected && path.basename(path.resolve(String(target))) === "legacy-source-backup") {
        injected = true;
        remove(path.join(String(target), "config.local.json"), { force: true });
        throw Object.assign(new Error("injected partial cleanup failure"), { code: "EIO" });
      }
      return remove.call(fs, target, options);
    };
    assert.throws(() => new Migration(root, { logger: { log() {}, error() {} } }).run(), /injected partial cleanup failure/);
  } finally { fs.rmSync = remove; }
  assert.equal(injected, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8")).owner.released, true);
}
