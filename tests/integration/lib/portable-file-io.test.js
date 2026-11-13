import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile, AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { captureRegularFile, RegularFileSnapshot, visitRegularFileChunks } from "../../../src/lib/regular-file-snapshot.js";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendRegularFile, RegularFileAppendError } from "../../../src/lib/regular-file-io.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("portable-file-io-");
  t.after(() => removeTmpDir(root));
  return { root, file: path.join(root, "空 白.bin") };
}

test("bounded reads refuse growth and close the descriptor after charging the physical bound", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "abc");
  const read = fs.readSync;
  const close = fs.closeSync;
  const charges = [];
  let calls = 0;
  let closed = 0;
  let readerDescriptor = null;
  fs.readSync = (...args) => {
    readerDescriptor ??= args[0];
    if (calls++ === 0) fs.appendFileSync(file, "defghijklmnopqrstuvwxyz");
    return read(...args);
  };
  fs.closeSync = (descriptor) => { if (descriptor === readerDescriptor) closed++; return close(descriptor); };
  try {
    assert.throws(() => captureRegularFile(file, { label: "source", maxBytes: 3, onRead: (n) => charges.push(n) }), /regular real file|changed while reading/);
  } finally { fs.readSync = read; fs.closeSync = close; }
  assert.deepEqual(charges, [4]);
  assert.equal(closed, 1);
  assert.throws(() => fs.fstatSync(readerDescriptor), { code: "EBADF" });
});

test("read rejects visible file replacement after body read while preserving the new actor bytes", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "old");
  assert.throws(() => captureRegularFile(file, { label: "source", maxBytes: 3, onRead() {
    const replacement = `${file}.replacement`;
    fs.writeFileSync(replacement, "new");
    fs.renameSync(replacement, file);
  } }), /changed while reading/);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("parent authority pins ancestors and read-only descendant resolution creates nothing", (t) => {
  const { root } = fixture(t);
  const parent = path.join(root, "parent");
  fs.mkdirSync(parent);
  fs.mkdirSync(path.join(parent, "child"));
  const authority = new RealDirectoryAuthority(path.join(parent, "child"));
  const nearest = authority.descendant(path.join(parent, "child", "missing", "leaf"), { allowMissing: true });
  assert.equal(nearest.directory, authority.directory);
  assert.equal(fs.existsSync(path.join(parent, "child", "missing")), false);
  fs.renameSync(parent, `${parent}.old`);
  fs.mkdirSync(parent);
  fs.mkdirSync(path.join(parent, "child"));
  assert.throws(() => authority.assertStable(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
});

test("an authority first observed after absence cannot reuse an ancestor's canonical proof or cache a failed proof", (t) => {
  const { root } = fixture(t);
  const directory = path.join(root, "initially-missing");
  const authority = new RealDirectoryAuthority(directory);
  fs.mkdirSync(directory);
  const realpath = fs.realpathSync;
  const failure = Object.assign(new Error("canonical path lookup denied"), { code: "EACCES" });
  let attempts = 0;
  t.mock.method(fs, "realpathSync", (target, ...args) => {
    if (target === directory) {
      attempts++;
      if (attempts === 1) throw failure;
      if (attempts === 2) return `${directory}-different-spelling`;
    }
    return realpath(target, ...args);
  });
  // Fail both resolvers so this remains a failed canonical lookup.
  t.mock.method(fs.realpathSync, "native", () => { throw failure; });
  assert.throws(() => authority.assertStable(), (error) => error.cause === failure);
  assert.throws(() => authority.assertStable(), /invalid directory authority/);
  assert.equal(authority.assertStable(), directory);
  assert.equal(attempts, 3);
  fs.renameSync(directory, `${directory}.old`);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "sentinel"), "foreign");
  assert.throws(() => authority.assertStable(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "foreign");
});

for (const allowMissing of [false, true]) {
  test(`read-only descendant traversal rechecks its pinned root before ${allowMissing ? "returning the nearest existing ancestor" : "returning an existing descendant"}`, (t) => {
    const { root } = fixture(t);
    const parent = path.join(root, "parent");
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });
    const target = path.join(child, allowMissing ? "missing" : "leaf");
    if (!allowMissing) fs.mkdirSync(target);
    const authority = new RealDirectoryAuthority(parent);
    const stat = fs.lstatSync;
    let replaced = false;
    const replace = () => {
      replaced = true;
      fs.renameSync(parent, `${parent}.old`);
      fs.mkdirSync(child, { recursive: true });
      if (!allowMissing) fs.mkdirSync(target);
      fs.writeFileSync(path.join(parent, "sentinel"), "foreign");
    };
    t.mock.method(fs, "lstatSync", (file, ...args) => {
      try {
        const observed = stat(file, ...args);
        if (!replaced && file === target) replace();
        return observed;
      } catch (cause) {
        if (!replaced && file === target && cause.code === "ENOENT") replace();
        throw cause;
      }
    });
    let returned = null;
    assert.throws(() => { returned = authority.descendant(target, { allowMissing }); }, { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.equal(replaced, true);
    assert.equal(returned, null);
    assert.equal(fs.readFileSync(path.join(parent, "sentinel"), "utf8"), "foreign");
    assert.deepEqual(fs.readdirSync(parent).sort(), ["child", "sentinel"]);
    assert.deepEqual(fs.readdirSync(child), allowMissing ? [] : ["leaf"]);
  });
}

for (const missing of [false, true]) {
  test(`directory ensure refuses a replaced existing prefix before ${missing ? "creating a missing child" : "returning an existing child"}`, (t) => {
    const { root } = fixture(t);
    const parent = path.join(root, "parent");
    const child = path.join(parent, "child");
    const target = path.join(child, "leaf");
    fs.mkdirSync(child, { recursive: true });
    if (!missing) fs.mkdirSync(target);
    const authority = new RealDirectoryAuthority(parent);
    const stat = fs.lstatSync;
    let replaced = false;
    const replace = () => {
      replaced = true;
      fs.renameSync(parent, `${parent}.old`);
      fs.mkdirSync(child, { recursive: true });
      if (!missing) fs.mkdirSync(target);
      fs.writeFileSync(path.join(parent, "sentinel"), "foreign");
    };
    t.mock.method(fs, "lstatSync", (file, ...args) => {
      try {
        const observed = stat(file, ...args);
        if (!replaced && file === target) replace();
        return observed;
      } catch (cause) {
        if (!replaced && file === target && cause.code === "ENOENT") replace();
        throw cause;
      }
    });
    let returned = null;
    assert.throws(() => { returned = authority.descendant(target, { create: true }); }, { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.equal(replaced, true);
    assert.equal(returned, null);
    assert.deepEqual(fs.readdirSync(parent).sort(), ["child", "sentinel"]);
    assert.deepEqual(fs.readdirSync(child), missing ? [] : ["leaf"]);
    assert.equal(fs.readFileSync(path.join(parent, "sentinel"), "utf8"), "foreign");
  });
}

test("atomic baseline refuses another actor appearing during an initially absent write", (t) => {
  const { root, file } = fixture(t);
  const writer = new AtomicFile(file, { faultInjector({ phase }) {
    if (phase === "before-file-rename") fs.writeFileSync(file, "other");
  } });
  assert.throws(() => writer.write("ours"), (error) => error instanceof AtomicFileWriteError && !error.committedToVisibleName);
  assert.equal(fs.readFileSync(file, "utf8"), "other");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("a failed exclusive stage creation preserves the unrelated file at its name", (t) => {
  const { root, file } = fixture(t);
  let foreignPath;
  assert.throws(() => new AtomicFile(file, { faultInjector({ phase, tempPath }) {
    if (phase === "before-file-temp-open") { foreignPath = tempPath; fs.writeFileSync(tempPath, "foreign"); }
  } }).write("ours"), (error) => error.cause.code === "EEXIST" && !error.committed);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign");
  assert.deepEqual(fs.readdirSync(root), [path.basename(foreignPath)]);
});

test("owned closed stages adopt tool output and publish exact binary bytes", (t) => {
  const { root, file } = fixture(t);
  const writer = new AtomicFile(file);
  const stage = writer.createStage();
  const bytes = Buffer.from([0, 255, 128, 10, 0]);
  fs.writeFileSync(stage.path, bytes);
  writer.adoptStage(stage);
  const result = writer.publishStage(stage);
  assert.equal(result.committed, true);
  assert.deepEqual(writer.readSnapshot().bytes, bytes);
  assert.deepEqual(new AtomicFile(file).read(), bytes);
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("owned producer output is sealed and published with streaming receipts without concatenating buffers", (t) => {
  const { file } = fixture(t);
  const writer = new AtomicFile(file, { maxBytes: Number.MAX_SAFE_INTEGER - 1 });
  const concat = Buffer.concat;
  let child;
  let stage;
  let publication;
  Buffer.concat = () => { throw new Error("streamed output must not concatenate all bytes"); };
  try {
    stage = writer.createOutputStage((descriptor) => {
      child = spawnSync(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(200000, 0xa5))"], { stdio: ["ignore", descriptor, "ignore"] });
    }, { exclusive: true });
    publication = writer.publishStage(stage, { exclusive: true });
  } finally { Buffer.concat = concat; }
  assert.equal(child.status, 0);
  assert.equal(publication.snapshot, null);
  assert.equal(publication.receipt.byteLength, 200000);
  assert.deepEqual(fs.readFileSync(file), Buffer.alloc(200000, 0xa5));
  assert.equal(stage.active, false);
  let removed;
  Buffer.concat = () => { throw new Error("streamed output removal must not concatenate all bytes"); };
  try { removed = writer.remove({ streaming: true }); }
  finally { Buffer.concat = concat; }
  assert.equal(removed.receipt.digest, publication.receipt.digest);
  assert.equal(removed.snapshot, null);
  assert.equal(fs.existsSync(file), false);
});

test("producer output refuses post-seal mutation and preserves the old visible target", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "old");
  const writer = new AtomicFile(file);
  let descriptor;
  const stage = writer.createOutputStage((fd) => { descriptor = fd; fs.writeSync(fd, "produced"); });
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  assert.throws(() => writer.adoptStage(stage), /already sealed/);
  fs.writeFileSync(stage.path, "mutated");
  assert.throws(() => writer.publishStage(stage), (error) => error instanceof AtomicFileWriteError && !error.committedToVisibleName && !error.publicationUnknown);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
});

test("exclusive producer refusal preserves a competitor before invoking the child", (t) => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, "competitor");
  let calls = 0;
  assert.throws(() => new AtomicFile(file).createOutputStage(() => { calls++; }, { exclusive: true }),
    (error) => error instanceof AtomicFileWriteError && error.cause.code === "EEXIST" && !error.committedToVisibleName);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "competitor");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("producer byte-limit and thrown failures close the descriptor and clean only the owned stage", (t) => {
  const { root, file } = fixture(t);
  for (const fail of [false, true]) {
    let descriptor;
    const failure = new Error("producer failed");
    assert.throws(() => new AtomicFile(file, { maxBytes: 3 }).createOutputStage((fd) => {
      descriptor = fd;
      fs.writeSync(fd, "four");
      if (fail) throw failure;
    }), (error) => error instanceof AtomicFileWriteError && !error.committedToVisibleName
      && (fail ? error.cause === failure : error.cause.reason === "limit"));
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("stage replacement refuses adoption and cleanup without deleting a foreign inode", (t) => {
  const { file } = fixture(t);
  const writer = new AtomicFile(file);
  const stage = writer.createStage();
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, "foreign");
  fs.renameSync(replacement, stage.path);
  assert.throws(() => writer.publishStage(stage), (error) => error.cleanupFailed && !error.committed);
  assert.equal(fs.readFileSync(stage.path, "utf8"), "foreign");
  assert.equal(fs.existsSync(file), false);
});

test("exclusive publication refuses competitor bytes and cleans only its owned stage", (t) => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, "competitor");
  assert.throws(() => new AtomicFile(file).write("ours", { exclusive: true }), (error) => error.cause.code === "EEXIST" && !error.committed);
  assert.equal(fs.readFileSync(file, "utf8"), "competitor");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("exclusive publication removes its hard link stage before successful single-link readback", (t) => {
  const { root, file } = fixture(t);
  assert.equal(new AtomicFile(file).write("ours", { exclusive: true }).committed, true);
  assert.equal(fs.statSync(file).nlink, 1);
  assert.equal(new AtomicFile(file).read().toString(), "ours");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("exclusive publication cleanup failure is a visible unconfirmed typed failure", (t) => {
  const { file } = fixture(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = () => { throw new Error("owned stage cleanup denied"); };
  try {
    assert.throws(() => new AtomicFile(file).write("ours", { exclusive: true }), (error) => error.committedToVisibleName && error.publicationUnknown && error.cleanupFailed);
    assert.equal(fs.readFileSync(file, "utf8"), "ours");
  } finally { fs.unlinkSync = unlink; }
});

test("post-rename readback mismatch reports visible uncertainty and preserves actor bytes", (t) => {
  const { root, file } = fixture(t);
  assert.throws(() => new AtomicFile(file, { faultInjector({ phase }) {
    if (phase === "before-file-readback") fs.writeFileSync(file, "other");
  } }).write("ours"), (error) => error.code === "ATOMIC_FILE_PUBLICATION_UNCERTAIN" && error.committed && error.publicationUnknown);
  assert.equal(new AtomicFile(file).read().toString(), "other");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("removal rechecks the baseline after its commit guard", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "before");
  assert.throws(() => new AtomicFile(file, { commitGuard() { fs.writeFileSync(file, "after!"); } }).remove(), /visible file changed before commit/);
  assert.equal(fs.readFileSync(file, "utf8"), "after!");
});

test("append enforces its exact byte budget and leaves old bytes on prewrite refusal", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, Buffer.from([0, 255]));
  const result = appendRegularFile(file, Buffer.from([10, 128]), { maxBytes: 4 });
  assert.deepEqual(result.bytes, Buffer.from([0, 255, 10, 128]));
  assert.throws(() => appendRegularFile(file, "x", { maxBytes: 4 }), (error) => error instanceof RegularFileAppendError && !error.publicationUnknown);
  assert.deepEqual(fs.readFileSync(file), result.bytes);
});

test("partial append closes its descriptor and reports unconfirmed persisted bytes without retry", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "old");
  const write = fs.writeSync;
  let calls = 0;
  fs.writeSync = (descriptor, buffer, offset, length, position) => {
    if (calls++ === 0) return write(descriptor, buffer, offset, 2, position);
    throw new Error("append transport failed");
  };
  try {
    assert.throws(() => appendRegularFile(file, "new"), (error) => error.bytesWritten === 2 && error.publicationUnknown);
  } finally { fs.writeSync = write; }
  assert.equal(fs.readFileSync(file, "utf8"), "oldne");
  // Windows refuses removal of descriptors that are still open.
  fs.unlinkSync(file);
  assert.equal(fs.existsSync(file), false);
});

test("optional atomic snapshots return absence without creating missing parents", (t) => {
  const { root } = fixture(t);
  const parent = path.join(root, "missing", "nested");
  const writer = new AtomicFile(path.join(parent, "state"));
  assert.equal(writer.readSnapshot(), null);
  assert.equal(writer.read("fallback"), "fallback");
  assert.equal(fs.existsSync(path.join(root, "missing")), false);
});

test("append captured snapshot refuses an identical-byte replacement inode", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "same");
  const before = new AtomicFile(file).readSnapshot();
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, "same");
  fs.renameSync(replacement, file);
  assert.throws(() => appendRegularFile(file, "extra", { expectedSnapshot: before }), (error) => !error.publicationUnknown && /snapshot baseline/.test(error.message));
  assert.equal(fs.readFileSync(file, "utf8"), "same");
});

test("append absent snapshot refuses a concurrently created file", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "other");
  assert.throws(() => appendRegularFile(file, "ours", { expectedSnapshot: null }), (error) => !error.publicationUnknown);
  assert.equal(fs.readFileSync(file, "utf8"), "other");
});

test("a stage from a different target cannot be adopted or cleaned by a writer", (t) => {
  const { file } = fixture(t);
  const source = new AtomicFile(file);
  const stage = source.createStage("staged");
  try {
    assert.throws(() => new AtomicFile(`${file}.other`).publishStage(stage), (error) => !error.committed && !error.cleanupFailed);
    assert.equal(fs.readFileSync(stage.path, "utf8"), "staged");
  } finally { stage.dispose(); }
});

test("exclusive publication preserves an existing two-link competitor", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "competitor");
  fs.linkSync(file, `${file}.owned-stage`);
  assert.throws(() => new AtomicFile(file).write("ours", { exclusive: true }), (error) => error.cause.code === "EEXIST" && !error.committed);
  assert.equal(fs.readFileSync(file, "utf8"), "competitor");
  assert.equal(fs.readFileSync(`${file}.owned-stage`, "utf8"), "competitor");
});

test("a stage read-close failure retains the closed-stage name until descriptor release is confirmed", (t) => {
  const { file } = fixture(t);
  const writer = new AtomicFile(file);
  const stage = writer.createStage("staged");
  const open = fs.openSync;
  const close = fs.closeSync;
  let held = null;
  fs.openSync = (target, ...args) => {
    const descriptor = open(target, ...args);
    if (target === stage.path) held = descriptor;
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    if (descriptor === held) throw new Error("descriptor release denied");
    return close(descriptor);
  };
  try {
    assert.throws(() => writer.publishStage(stage), (error) => !error.committed && error.cleanupFailed);
    assert.equal(fs.existsSync(stage.path), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.openSync = open;
    fs.closeSync = close;
    if (held !== null) close(held);
    stage.dispose();
  }
});

test("directory move rechecks destination absence after its guard and preserves competitor data", (t) => {
  const { root } = fixture(t);
  const source = RealDirectoryAuthority.createExclusive(path.join(root, "source"));
  const destination = path.join(root, "destination");
  fs.writeFileSync(path.join(source.directory, "source.txt"), "source");
  assert.throws(() => source.moveTo(destination, { commitGuard() {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "competitor.txt"), "competitor");
  } }), (error) => !error.committedToVisibleName && error.cause.code === "EEXIST");
  assert.equal(fs.readFileSync(path.join(source.directory, "source.txt"), "utf8"), "source");
  assert.equal(fs.readFileSync(path.join(destination, "competitor.txt"), "utf8"), "competitor");
});

test("directory move returns the pinned published identity and recursive cleanup confirms absence", (t) => {
  const { root } = fixture(t);
  const source = RealDirectoryAuthority.createExclusive(path.join(root, "source"));
  fs.writeFileSync(path.join(source.directory, "payload"), "exact");
  const destination = path.join(root, "published");
  const moved = source.moveTo(destination);
  assert.deepEqual(moved.identity, source.identity);
  assert.equal(fs.existsSync(source.directory), false);
  assert.equal(fs.readFileSync(path.join(moved.directory, "payload"), "utf8"), "exact");
  assert.equal(moved.remove({ recursive: true }).committed, true);
  assert.equal(fs.existsSync(destination), false);
});

test("exclusive directory creation refuses an existing directory without adopting its ownership", (t) => {
  const { root } = fixture(t);
  const directory = path.join(root, "existing");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "competitor");
  assert.throws(() => RealDirectoryAuthority.createExclusive(directory), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(directory, "payload"), "utf8"), "competitor");
});

test("publication results retain exact confirmed identity and serialize without bigint fields", (t) => {
  const { file } = fixture(t);
  const publication = new AtomicFile(file).write("exact");
  assert.equal(publication.snapshot.digest, new AtomicFile(file).readSnapshot().digest);
  assert.deepEqual(JSON.parse(JSON.stringify(publication)), { committed: true, path: file });
  assert.equal(Object.isFrozen(publication), true);
});

test("a named stage cannot create the visible target before publication", (t) => {
  const { file } = fixture(t);
  assert.throws(() => new AtomicFile(file).createStage("ours", { stageName: path.basename(file) }), /distinct basename/);
  assert.equal(fs.existsSync(file), false);
});

test("an adopted stage refuses a later same-inode byte change before publication", (t) => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, "old-target");
  const writer = new AtomicFile(file);
  const stage = writer.createStage();
  fs.writeFileSync(stage.path, "first-tool-output");
  writer.adoptStage(stage);
  fs.writeFileSync(stage.path, "later-tool-output");
  assert.throws(() => writer.publishStage(stage), (error) => !error.committedToVisibleName && !error.publicationUnknown);
  assert.equal(fs.readFileSync(file, "utf8"), "old-target");
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test("append passes its explicit private-file creation hint through the common exclusive open", (t) => {
  const { file } = fixture(t);
  const open = fs.openSync;
  const observed = [];
  fs.openSync = (target, flags, mode) => {
    if (target === file && flags === "ax") observed.push(mode);
    return open(target, flags, mode);
  };
  try { assert.equal(appendRegularFile(file, "private", { creationMode: 0o600 }).text(), "private"); }
  finally { fs.openSync = open; }
  assert.deepEqual(observed, [0o600]);
});

test("append preserves explicit existing-file permission hints and exact content", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "before", { mode: 0o666 });
  const chmod = fs.fchmodSync;
  const observed = [];
  fs.fchmodSync = (descriptor, mode) => { observed.push(mode); return chmod(descriptor, mode); };
  try { assert.equal(appendRegularFile(file, "after", { permissionMode: 0o600 }).text(), "beforeafter"); }
  finally { fs.fchmodSync = chmod; }
  assert.deepEqual(observed, [0o600]);
  if (process.platform === "win32") t.diagnostic("Windows evidence covers the Node writable hint; POSIX privacy bits and private ACLs are not asserted.");
  else assert.equal(fs.statSync(file).mode & 0o777, 0o600, "POSIX local permission sideeffect");
});

test("streamed directory visitation closes its handle when a caller cap refuses the next entry", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "entry"), "bytes");
  const open = fs.opendirSync;
  let closed = 0;
  const primary = new Error("entry cap exceeded");
  fs.opendirSync = (...args) => {
    const handle = open(...args);
    const close = handle.closeSync.bind(handle);
    handle.closeSync = () => { closed++; return close(); };
    return handle;
  };
  try { assert.throws(() => new RealDirectoryAuthority(root).forEachEntry(() => { throw primary; }), (error) => error === primary); }
  finally { fs.opendirSync = open; }
  assert.equal(closed, 1);
  assert.equal(fs.readFileSync(path.join(root, "entry"), "utf8"), "bytes");
});

test("streamed directory visitation preserves caller refusal before its close failure", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "entry"), "bytes");
  const open = fs.opendirSync;
  const primary = new Error("entry cap exceeded");
  const cleanup = new Error("directory handle close failed");
  fs.opendirSync = (...args) => {
    const handle = open(...args);
    const close = handle.closeSync.bind(handle);
    handle.closeSync = () => { close(); throw cleanup; };
    return handle;
  };
  try {
    assert.throws(() => new RealDirectoryAuthority(root).forEachEntry(() => { throw primary; }), (error) => error instanceof AggregateError
      && error.cause === primary && error.errors[0] === primary && error.errors[1] === cleanup && error.cleanupFailed);
  } finally { fs.opendirSync = open; }
  assert.equal(fs.readFileSync(path.join(root, "entry"), "utf8"), "bytes");
});

test("append refuses special permission bits before opening or changing the target", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "original bytes");
  const mode = fs.statSync(file).mode;
  const open = fs.openSync;
  let targetOpens = 0;
  fs.openSync = (target, ...args) => {
    if (target === file) targetOpens++;
    return open(target, ...args);
  };
  try {
    assert.throws(() => appendRegularFile(file, "unwanted tail", { permissionMode: 0o7777 }), TypeError);
  } finally { fs.openSync = open; }
  assert.equal(targetOpens, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "original bytes");
  assert.equal(fs.statSync(file).mode, mode);
});

test("authority failure classification follows wrapped and cyclic error graphs without guessing status fields", (t) => {
  const directory = createTmpDir("sennel-authority-failure-");
  t.after(() => removeTmpDir(directory));
  const authority = RealDirectoryAuthority.resolve(directory);
  fs.renameSync(directory, `${directory}-original`);
  t.after(() => removeTmpDir(`${directory}-original`));
  fs.mkdirSync(directory);
  let refusal;
  try { authority.assertStable(); } catch (error) { refusal = error; }
  assert.ok(refusal instanceof Error);
  const cycle = new Error("unrelated cycle");
  cycle.cause = cycle;
  assert.equal(RealDirectoryAuthority.isAuthorityFailure(cycle), false);
  const fake = Object.assign(new Error("unrelated caller error"), { lockStatus: "authority-invalid" });
  assert.equal(RealDirectoryAuthority.isAuthorityFailure(fake), false);
  const wrapped = new AggregateError([cycle, new Error("writer", { cause: refusal })], "wrapped refusal");
  assert.equal(RealDirectoryAuthority.isAuthorityFailure(wrapped), true);
});


test("public file snapshots own their Buffer bytes and never trust caller digest or receipt hints", (t) => {
  const { file } = fixture(t);
  const original = Buffer.from([0, 255, 128, 10, 13, 0]);
  fs.writeFileSync(file, original);
  const supplied = Buffer.from(original);
  const expectedDigest = crypto.createHash("sha256").update(original).digest("hex");
  const snapshot = new RegularFileSnapshot({ filePath: file, bytes: supplied, digest: "0".repeat(64) });
  supplied.fill(42);
  const exposed = snapshot.bytes; exposed.fill(43);
  assert.deepEqual(snapshot.bytes, original);
  assert.equal(snapshot.text(), original.toString("utf8"));
  assert.equal(snapshot.digest, expectedDigest);
  assert.equal(snapshot.byteLength, original.length);
  assert.equal(Object.isFrozen(snapshot), true);
  const receipt = visitRegularFileChunks(file, { label: "public snapshot receipt", maxBytes: original.length, visit() {} });
  assert.throws(() => new RegularFileSnapshot({ filePath: file, bytes: receipt }), /Buffer bytes/);
  assert.throws(() => new RegularFileSnapshot({ filePath: file, bytes: { bytes: original, receipt } }), /Buffer bytes/);
});

test("captured snapshots retain exact empty and multi-chunk binary bytes through detached validation copies", (t) => {
  const { file } = fixture(t);
  const binary = Buffer.alloc(2 * 1024 * 1024 + 19);
  for (let index = 0; index < binary.length; index++) binary[index] = index % 251;
  for (const original of [Buffer.alloc(0), binary]) {
    fs.writeFileSync(file, original);
    const charges = [];
    let validated = null;
    const snapshot = captureRegularFile(file, { label: "captured exact binary", maxBytes: original.length,
      onRead(length) { charges.push(length); }, validateSnapshot(value) {
        validated = value;
        assert.equal(Object.isFrozen(value), true);
        const exposed = value.bytes; exposed.fill(254);
      } });
    assert.equal(snapshot, validated);
    assert.deepEqual(snapshot.bytes, original);
    assert.equal(snapshot.digest, crypto.createHash("sha256").update(original).digest("hex"));
    assert.equal(snapshot.byteLength, original.length);
    assert.equal(snapshot.text(), original.toString("utf8"));
    assert.deepEqual(charges, [original.length]);
    const secondCopy = snapshot.bytes; secondCopy.fill(253);
    assert.deepEqual(snapshot.bytes, original);
    fs.writeFileSync(file, "later physical bytes");
    assert.deepEqual(snapshot.bytes, original);
  }
});

test("snapshot validation refusal closes the descriptor and preserves any later close failure", (t) => {
  const { file } = fixture(t);
  const original = Buffer.from("complete validated content");
  fs.writeFileSync(file, original);
  for (const failClose of [false, true]) {
    const primary = new Error("snapshot consumer refusal"), cleanup = new Error("descriptor close refusal");
    const open = fs.openSync, close = fs.closeSync;
    let descriptor = null, closed = 0, validated = null;
    const charges = [];
    fs.openSync = (target, ...args) => { const result = open(target, ...args); if (target === file) descriptor = result; return result; };
    fs.closeSync = value => { const result = close(value); if (value === descriptor) { closed++; if (failClose) throw cleanup; } return result; };
    try {
      assert.throws(() => captureRegularFile(file, { label: "consumer refusal", maxBytes: original.length,
        onRead(length) { charges.push(length); }, validateSnapshot(snapshot) { validated = snapshot; throw primary; } }),
      error => failClose ? error instanceof AggregateError && error.cause === primary
        && error.errors[0] === primary && error.errors[1] === cleanup && error.cleanupFailed === true : error === primary);
    } finally { fs.openSync = open; fs.closeSync = close; }
    assert.equal(closed, 1);
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    assert.deepEqual(charges, [original.length]);
    assert.deepEqual(validated.bytes, original);
    assert.equal(validated.digest, crypto.createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(fs.readFileSync(file), original);
  }
});


test("captured snapshots assemble short native reads and refuse growth after their initial size", (t) => {
  const { file } = fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 19);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const read = fs.readSync;
  for (const grows of [false, true]) {
    fs.writeFileSync(file, bytes);
    let calls = 0, grew = false;
    const charges = [];
    fs.readSync = (descriptor, buffer, offset, length, position) => {
      calls++;
      if (grows && !grew && position >= bytes.length) {
        fs.appendFileSync(file, Buffer.from([252, 253])); grew = true;
      }
      return read(descriptor, buffer, offset, Math.min(length, 131071), position);
    };
    try {
      const capture = () => captureRegularFile(file, { label: "short native reads", maxBytes: bytes.length,
        onRead(length) { charges.push(length); } });
      if (grows) {
        assert.throws(capture, { code: "REGULAR_FILE_READ_LIMIT" });
        assert.equal(grew, true);
        assert.deepEqual(charges, [bytes.length + 1]);
      } else {
        const snapshot = capture();
        assert.deepEqual(snapshot.bytes, bytes);
        assert.equal(snapshot.digest, crypto.createHash("sha256").update(bytes).digest("hex"));
        assert.deepEqual(charges, [bytes.length]);
      }
      assert.ok(calls > 2, "the real reader must assemble partial native results through EOF or its bound");
    } finally { fs.readSync = read; }
    assert.deepEqual(fs.readFileSync(file), grows ? Buffer.concat([bytes, Buffer.from([252, 253])]) : bytes);
  }
});
