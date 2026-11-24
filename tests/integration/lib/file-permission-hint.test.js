import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { captureRegularFile, FilePermissionHint } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("file-permission-hint-");
  t.after(() => removeTmpDir(root));
  const file = path.join(root, "source");
  fs.writeFileSync(file, "captured bytes");
  return { root, file };
}
const capture = (file, options = {}) => captureRegularFile(file, { label: "permission source", maxBytes: 1024, ...options });

test("captured permission metadata remains paired with its immutable bytes", (t) => {
  const { file } = fixture(t);
  fs.chmodSync(file, 0o751);
  const expected = fs.statSync(file).mode & 0o7777;
  const snapshot = capture(file);
  fs.chmodSync(file, 0o640);
  assert.equal(snapshot.permissionHint.mode, expected);
  assert.equal(snapshot.text(), "captured bytes");
  assert.equal(Object.isFrozen(snapshot.permissionHint), true);
  assert.throws(() => new FilePermissionHint(0o10000), TypeError);
});

test("capture refuses permission changes during the same file read", (t) => {
  const { file } = fixture(t);
  fs.chmodSync(file, 0o600);
  assert.throws(() => capture(file, { faultInjector(event) {
    if (event.phase === "before-file-read") fs.chmodSync(file, 0o444);
  } }), (error) => error.code === "REGULAR_FILE_READ_IDENTITY");
  assert.equal(fs.readFileSync(file, "utf8"), "captured bytes");
});

test("atomic publication applies permissions before writing and seals native final modes despite umask", (t) => {
  const { root, file } = fixture(t);
  fs.chmodSync(file, process.platform === "win32" ? 0o444 : 0o6751);
  const snapshot = capture(file);
  const destination = path.join(root, "destination");
  const mask = process.umask(0o077);
  let observed;
  let firstWriteMode;
  const write = fs.writeSync;
  fs.writeSync = (descriptor, ...args) => {
    if (firstWriteMode === undefined) firstWriteMode = FilePermissionHint.fromStat(fs.fstatSync(descriptor));
    return write(descriptor, ...args);
  };
  let result;
  try {
    result = new AtomicFile(destination, { permissionHint: snapshot.permissionHint, faultInjector(event) {
      if (event.phase === "before-file-fsync") observed = FilePermissionHint.fromStat(fs.statSync(event.tempPath));
    } }).write(snapshot.bytes);
    new AtomicFile(path.join(root, "private-default")).write("private bytes");
  } finally { process.umask(mask); fs.writeSync = write; }
  assert.equal(snapshot.permissionHint.matches(firstWriteMode), true, "source hint applied before the first write");
  assert.equal(snapshot.permissionHint.matchesAfterWrite(observed), true);
  assert.equal(snapshot.permissionHint.matchesAfterWrite(result.snapshot.permissionHint), true);
  assert.equal(fs.readFileSync(destination, "utf8"), "captured bytes");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "private-default")).mode & 0o7777, 0o600);
});

test("permission application failure preserves the old visible target and removes the owned stage", (t) => {
  const { root, file } = fixture(t);
  const before = capture(file);
  const injected = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const chmod = fs.fchmodSync;
  fs.fchmodSync = () => { throw injected; };
  try {
    assert.throws(() => new AtomicFile(file, { permissionHint: new FilePermissionHint(0o751) }).write("replacement"),
      (error) => error.cause === injected && error.code === "ATOMIC_FILE_WRITE_FAILED"
        && error.committedToVisibleName === false && error.cleanupFailed === false);
  } finally { fs.fchmodSync = chmod; }
  assert.equal(capture(file).digest, before.digest);
  assert.deepEqual(fs.readdirSync(root), ["source"]);
});

test("publication refuses a stage permission change after sealing", (t) => {
  const { root, file } = fixture(t);
  const writer = new AtomicFile(file, { permissionHint: new FilePermissionHint(0o600), faultInjector(event) {
    if (event.phase === "before-file-rename") fs.chmodSync(event.tempPath, 0o444);
  } });
  assert.throws(() => writer.write("replacement"), (error) => error.code === "ATOMIC_FILE_WRITE_FAILED"
    && error.committedToVisibleName === false && error.cleanupFailed === false);
  assert.equal(fs.readFileSync(file, "utf8"), "captured bytes");
  assert.deepEqual(fs.readdirSync(root), ["source"]);
});

test("post-publication permission changes remain an unconfirmed visible publication", (t) => {
  const { file } = fixture(t);
  assert.throws(() => new AtomicFile(file, { permissionHint: new FilePermissionHint(0o600), faultInjector(event) {
    if (event.phase === "before-file-readback") fs.chmodSync(file, 0o444);
  } }).write("replacement"), (error) => error.code === "ATOMIC_FILE_PUBLICATION_UNCERTAIN"
    && error.committedToVisibleName === true && error.publicationUnknown === true);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement");
});

test("adopting tool output refuses ordinary permission changes against the selected source hint", (t) => {
  const { root, file } = fixture(t);
  const writer = new AtomicFile(file, { permissionHint: new FilePermissionHint(0o444) });
  const stage = writer.createStage();
  try {
    fs.chmodSync(stage.path, 0o600);
    fs.writeFileSync(stage.path, "tool output");
    assert.throws(() => writer.adoptStage(stage), /atomic file stage changed while flushing/);
    assert.equal(fs.readFileSync(file, "utf8"), "captured bytes");
  } finally { stage.dispose(); }
  assert.deepEqual(fs.readdirSync(root), ["source"]);
});
