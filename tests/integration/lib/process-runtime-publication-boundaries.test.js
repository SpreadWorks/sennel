import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile, AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { sameFileIdentity } from "../../../src/lib/file-identity.js";
import { captureRegularFile, RegularFileReadReceipt } from "../../../src/lib/regular-file-snapshot.js";
import { ProcessExecutionValueEncoding } from "../../../src/lib/process-execution-values.js";
import { RuntimePublicationMetadataSelection, RuntimePublicationMetadataUpdate } from "../../../src/lib/process-execution-publication-metadata.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const authorityMismatch = (error) => error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH";

function fixture(t, faultInjector = () => {}) {
  const root = createTmpDir("runtime-publication-boundary-");
  t.after(() => removeTmpDir(root));
  const storage = path.join(root, "storage");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(storage); fs.mkdirSync(evidence);
  const authority = new RealDirectoryAuthority(storage);
  const file = new AtomicFile(path.join(storage, "transition.json"), {
    maxBytes: MAX_RECORD_BYTES, directoryAuthority: authority, faultInjector,
  });
  return { root, storage, evidence, authority, file, guard: () => authority.assertStable() };
}

function proof(file) {
  const snapshot = captureRegularFile(file, { label: "test-owned physical generation", maxBytes: MAX_RECORD_BYTES, requireSingleLink: true });
  const stat = fs.lstatSync(file, { bigint: true });
  return { snapshot, stat: Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])])) };
}
function unchanged(file, before) {
  const after = proof(file);
  assert.ok(sameFileIdentity(before.snapshot.identity, after.snapshot.identity), "original physical identity must remain");
  assert.ok(before.snapshot.bytes.equals(after.snapshot.bytes), "all original physical bytes must remain");
  assert.deepEqual(after.stat, before.stat);
}
function storageProof(storage) {
  return new Map(fs.readdirSync(storage).sort().map(name => [name, proof(path.join(storage, name))]));
}
function unchangedStorage(storage, before) {
  assert.deepEqual(fs.readdirSync(storage).sort(), [...before.keys()]);
  for (const [name, expected] of before) unchanged(path.join(storage, name), expected);
}
function boundedStorage(storage) {
  for (const name of fs.readdirSync(storage)) {
    const stat = fs.lstatSync(path.join(storage, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(stat.size <= MAX_RECORD_BYTES, "every physical metadata file retains its original16MiB cap");
  }
}
function largeEncoding(label) {
  // The euro's first byte is the last byte of the current256KiB transport
  // page; the logical JSON must survive the split inside its UTF8 encoding.
  const prefix = Buffer.byteLength(`{"label":${JSON.stringify(label)},"text":"`);
  const text = "x".repeat(256 * 1024 - prefix - 1) + "€" + "☃".repeat(Math.ceil(MAX_RECORD_BYTES / 3));
  const encoding = new ProcessExecutionValueEncoding({ label, text, order: { z: "先", a: "後" } });
  assert.ok(Buffer.byteLength(encoding.text()) > MAX_RECORD_BYTES);
  return encoding;
}
function select(file, encoding, previous = null) {
  return new RuntimePublicationMetadataUpdate(file, encoding, previous).publish({ selectGuard: () => file.directoryAuthority.assertStable() });
}
function exactLogical(selection, encoding) {
  const text = JSON.stringify(selection.value);
  assert.ok(text === encoding.text(), "the complete original JSON text and key order must roundtrip");
  assert.equal(sha(text), encoding.digest);
  selection.assertCurrent();
}
function headPage(file) {
  const pointer = JSON.parse(file.readSnapshot().text());
  assert.equal(pointer.kind, "runtime-publication-metadata");
  return path.join(file.directory, pointer.head.name);
}
function replaceWithSameBytes(file, backup) {
  const bytes = fs.readFileSync(file);
  fs.renameSync(file, backup);
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  assert.equal(sameFileIdentity(proof(file).snapshot.identity, proof(backup).snapshot.identity), false);
  return proof(file);
}
function restoreOriginal(file, backup, foreignEvidence) {
  fs.renameSync(file, foreignEvidence);
  fs.renameSync(backup, file);
}

test("streamed owned stages preserve exact bytes and refuse a same-byte replacement before publication", t => {
  let swap = false, originalStage;
  const f = fixture(t, event => {
    if (swap && event.phase === "before-file-rename") {
      originalStage = path.join(f.evidence, "original-stage");
      replaceWithSameBytes(event.tempPath, originalStage);
    }
  });
  const bytes = Buffer.concat([Buffer.alloc(524288, 0xa5), Buffer.from("UTF8:€☃🙂"), Buffer.alloc(524288, 0x00)]);
  const stage = f.file.createOutputStage(fd => {
    fs.writeFileSync(fd, bytes.subarray(0, 524288));
    fs.writeFileSync(fd, bytes.subarray(524288));
  });
  const sealed = f.file.inspectStage(stage);
  assert.ok(sealed instanceof RegularFileReadReceipt);
  assert.equal(sealed.byteLength, bytes.length); assert.equal(sealed.digest, sha(bytes));
  assert.ok(sameFileIdentity(sealed.identity, stage.identity));
  const published = f.file.publishStage(stage);
  assert.equal(published.committed, true); assert.equal(published.snapshot, null);
  assert.ok(published.receipt instanceof RegularFileReadReceipt);
  assert.ok(sameFileIdentity(published.receipt.identity, stage.identity));
  assert.ok(fs.readFileSync(f.file.filePath).equals(bytes));
  assert.equal(stage.active, false);
  const originalTarget = proof(f.file.filePath);
  const next = f.file.createOutputStage(fd => { fs.writeFileSync(fd, bytes); });
  swap = true;
  assert.throws(() => f.file.publishStage(next, { retainOnFailure: true }),
    error => error instanceof AtomicFileWriteError && !error.committedToVisibleName && !error.publicationUnknown);
  swap = false;
  unchanged(f.file.filePath, originalTarget);
  const foreign = proof(next.path);
  assert.ok(foreign.snapshot.bytes.equals(bytes));
  assert.equal(sameFileIdentity(foreign.snapshot.identity, next.identity), false);
  unchanged(next.path, foreign);
  restoreOriginal(next.path, originalStage, path.join(f.evidence, "foreign-stage"));
  next.dispose(); assert.equal(next.active, false);
});

test("stream publication preserves its primary error when foreign-stage cleanup also refuses", t => {
  const failure = new Error("controlled prepublication failure");
  let armed = false, originalStage;
  const f = fixture(t, event => {
    if (armed && event.phase === "before-file-rename") {
      originalStage = path.join(f.evidence, "original-stage");
      replaceWithSameBytes(event.tempPath, originalStage);
      throw failure;
    }
  });
  fs.writeFileSync(f.file.filePath, "old-visible");
  const originalTarget = proof(f.file.filePath);
  const stage = f.file.createOutputStage(fd => { fs.writeFileSync(fd, "new-produced"); });
  armed = true;
  assert.throws(() => f.file.publishStage(stage), error => error instanceof AtomicFileWriteError
    && error.cause === failure && error.errors[0] === failure && error.cleanupFailed
    && error.cleanupErrors.length > 0 && !error.committedToVisibleName && !error.publicationUnknown);
  armed = false;
  unchanged(f.file.filePath, originalTarget);
  const foreign = proof(stage.path);
  assert.equal(sameFileIdentity(foreign.snapshot.identity, stage.identity), false);
  unchanged(stage.path, foreign);
  restoreOriginal(stage.path, originalStage, path.join(f.evidence, "foreign-stage"));
  stage.dispose(); assert.equal(stage.active, false);
});

test("metadata selects and rereads exact UTF8 JSON above16MiB then replaces and clears its bounded physical chain", t => {
  const f = fixture(t);
  const inline = new ProcessExecutionValueEncoding({ state: "inline", order: { z: 1, a: 2 } });
  const first = select(f.file, inline);
  assert.equal(first.selection.pageCount, 0); exactLogical(first.selection, inline);
  const large = largeEncoding("first");
  const second = select(f.file, large, first.selection);
  assert.ok(second.selection.pageCount > 1);
  exactLogical(second.selection, large);
  exactLogical(RuntimePublicationMetadataSelection.inspect(f.file), large);
  assert.throws(() => first.selection.assertCurrent(), authorityMismatch);
  second.previousRetirement.retire({ retirementGuard: f.guard });
  boundedStorage(f.storage);
  const replacement = largeEncoding("replacement");
  const third = select(f.file, replacement, second.selection);
  assert.ok(third.selection.pageCount > 1); exactLogical(third.selection, replacement);
  third.previousRetirement.retire({ retirementGuard: f.guard });
  assert.throws(() => second.selection.assertCurrent(), authorityMismatch);
  exactLogical(RuntimePublicationMetadataSelection.inspect(f.file), replacement);
  boundedStorage(f.storage);
  const retirement = third.selection.clear({ clearGuard: f.guard });
  assert.equal(f.file.readSnapshot(), null);
  retirement.retire({ retirementGuard: f.guard });
  assert.equal(RuntimePublicationMetadataSelection.inspect(f.file), null);
  assert.deepEqual(fs.readdirSync(f.storage), []);
});

test("selected metadata page byte changes and same-byte foreign identities refuse without replacing the selected root", t => {
  const f = fixture(t), encoding = largeEncoding("selected");
  const { selection } = select(f.file, encoding);
  const root = proof(f.file.filePath), page = headPage(f.file), originalBytes = fs.readFileSync(page);
  const originalIdentity = proof(page).snapshot.identity;
  fs.appendFileSync(page, "\n");
  assert.ok(sameFileIdentity(proof(page).snapshot.identity, originalIdentity));
  assert.throws(() => selection.assertCurrent(), authorityMismatch);
  assert.throws(() => RuntimePublicationMetadataSelection.inspect(f.file), authorityMismatch);
  unchanged(f.file.filePath, root);
  fs.writeFileSync(page, originalBytes);
  exactLogical(selection, encoding);
  const backup = path.join(f.evidence, "original-page");
  const foreign = replaceWithSameBytes(page, backup);
  assert.throws(() => selection.assertCurrent(), authorityMismatch);
  assert.throws(() => RuntimePublicationMetadataSelection.inspect(f.file), authorityMismatch);
  unchanged(f.file.filePath, root); unchanged(page, foreign);
  restoreOriginal(page, backup, path.join(f.evidence, "foreign-page"));
  exactLogical(selection, encoding);
  boundedStorage(f.storage);
  selection.clear({ clearGuard: f.guard }).retire({ retirementGuard: f.guard });
  assert.deepEqual(fs.readdirSync(f.storage), []);
});

test("metadata retirement refuses foreign pages after confirmed root replacement and after confirmed root unlink", t => {
  const f = fixture(t);
  const firstEncoding = largeEncoding("old"), first = select(f.file, firstEncoding);
  const oldPage = headPage(f.file), oldBackup = path.join(f.evidence, "old-original-page");
  const secondEncoding = largeEncoding("new"), second = select(f.file, secondEncoding, first.selection);
  const currentRoot = proof(f.file.filePath);
  const foreignOld = replaceWithSameBytes(oldPage, oldBackup);
  const beforeRetirement = storageProof(f.storage);
  assert.throws(() => second.previousRetirement.retire({ retirementGuard: f.guard }), authorityMismatch);
  unchangedStorage(f.storage, beforeRetirement); unchanged(oldPage, foreignOld);
  unchanged(f.file.filePath, currentRoot);
  assert.throws(() => first.selection.assertCurrent(), authorityMismatch);
  exactLogical(second.selection, secondEncoding);
  restoreOriginal(oldPage, oldBackup, path.join(f.evidence, "old-foreign-page"));
  second.previousRetirement.retire({ retirementGuard: f.guard });
  assert.equal(fs.existsSync(oldPage), false);
  const newPage = headPage(f.file), newBackup = path.join(f.evidence, "new-original-page");
  const retirement = second.selection.clear({ clearGuard: f.guard });
  assert.equal(f.file.readSnapshot(), null);
  const foreignNew = replaceWithSameBytes(newPage, newBackup);
  const beforeAbsentRetirement = storageProof(f.storage);
  assert.throws(() => retirement.retire({ retirementGuard: f.guard }), authorityMismatch);
  assert.equal(f.file.readSnapshot(), null);
  unchangedStorage(f.storage, beforeAbsentRetirement); unchanged(newPage, foreignNew);
  restoreOriginal(newPage, newBackup, path.join(f.evidence, "new-foreign-page"));
  retirement.retire({ retirementGuard: f.guard });
  assert.deepEqual(fs.readdirSync(f.storage), []);
});

test("failed metadata selection retains all new stages under a foreign root and discards them only under the exact old selection", t => {
  const failure = new Error("controlled metadata root selection failure");
  let armed = false;
  const f = fixture(t, event => { if (armed && event.phase === "before-file-rename") throw failure; });
  const originalEncoding = new ProcessExecutionValueEncoding({ selected: "original" });
  const original = select(f.file, originalEncoding).selection;
  const originalRoot = proof(f.file.filePath);
  const update = new RuntimePublicationMetadataUpdate(f.file, largeEncoding("unselected"), original);
  armed = true;
  assert.throws(() => update.publish({ selectGuard: f.guard }), error => error instanceof AtomicFileWriteError
    && error.cause === failure && !error.committedToVisibleName && !error.publicationUnknown);
  armed = false;
  assert.equal(update.rootPublicationConfirmed, false); assert.ok(update.stagedPageCount > 1);
  unchanged(f.file.filePath, originalRoot);
  const backup = path.join(f.evidence, "original-root");
  const foreign = replaceWithSameBytes(f.file.filePath, backup);
  const beforeDiscard = storageProof(f.storage);
  update.discardAfterFailure({ cleanupGuard: f.guard });
  unchangedStorage(f.storage, beforeDiscard); unchanged(f.file.filePath, foreign);
  assert.throws(() => original.assertCurrent(), authorityMismatch);
  restoreOriginal(f.file.filePath, backup, path.join(f.evidence, "foreign-root"));
  // Fixture rename changes native ctime; first prove the exact original
  // identity/bytes/permission, then guard full stats across PRODUCT cleanup.
  const restoredRoot = proof(f.file.filePath);
  assert.ok(sameFileIdentity(restoredRoot.snapshot.identity, originalRoot.snapshot.identity));
  assert.ok(restoredRoot.snapshot.bytes.equals(originalRoot.snapshot.bytes));
  assert.ok(restoredRoot.snapshot.permissionHint.matches(originalRoot.snapshot.permissionHint));
  update.discardAfterFailure({ cleanupGuard: f.guard });
  unchanged(f.file.filePath, restoredRoot);
  exactLogical(original, originalEncoding);
  assert.deepEqual(fs.readdirSync(f.storage), [path.basename(f.file.filePath)]);
  original.clear({ clearGuard: f.guard }).retire({ retirementGuard: f.guard });
  assert.deepEqual(fs.readdirSync(f.storage), []);
});
