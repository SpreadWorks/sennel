import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("snapshot-group-");
  t.after(() => removeTmpDir(root));
  for (const name of ["a", "b"]) fs.mkdirSync(path.join(root, name));
  const paths = ["a", "b"].map(name => path.join(root, name, "data"));
  for (const [index, file] of paths.entries()) fs.writeFileSync(file, `value-${index}`);
  return { root, paths, files: paths.map(file => new AtomicFile(file, { maxBytes: 32 })) };
}

class ReadDescriptorSelection {
  #selected = new Map();
  constructor(t, selectedPath) {
    const open = fs.openSync;
    t.mock.method(fs, "openSync", (file, flags, ...options) => {
      const descriptor = open(file, flags, ...options);
      this.#selected.set(descriptor, file === selectedPath && flags === "r");
      return descriptor;
    });
  }
  has(descriptor) { return this.#selected.get(descriptor) === true; }
}

test("grouped snapshots retain exact bytes and immutable file identities, including absence under an existing parent", t => {
  const { paths, files } = fixture(t);
  const absent = new AtomicFile(path.join(path.dirname(paths[0]), "absent"));
  const snapshots = AtomicFile.readSnapshots([...files, absent]);
  for (const [index, file] of files.entries()) {
    const snapshot = snapshots.get(file.filePath);
    assert.equal(snapshot.text(), `value-${index}`);
    assert.equal(snapshot.byteLength, 7);
    assert.deepEqual(snapshot.identity, file.readSnapshot().identity);
    snapshot.bytes.fill(0);
    assert.equal(snapshot.text(), `value-${index}`);
  }
  assert.equal(snapshots.get(absent.filePath), null);
  assert.throws(() => snapshots.get("uncaptured"));
});

test("grouped snapshots preserve empty, small and multi-megabyte payloads independently of later mutations", t => {
  const { root } = fixture(t);
  const sizes = [0, 1, 17, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 2 * 1024 * 1024 + 137];
  const sources = sizes.map((size, index) => {
    const bytes = Buffer.alloc(size, 0x41 + index);
    const file = new AtomicFile(path.join(root, `payload-${index}`), { maxBytes: 4 * 1024 * 1024 });
    fs.writeFileSync(file.filePath, bytes);
    return { file, bytes };
  });
  const snapshots = AtomicFile.readSnapshots(sources.map(source => source.file));
  for (const { file, bytes } of sources) {
    const snapshot = snapshots.get(file.filePath);
    assert.equal(snapshot.byteLength, bytes.length);
    assert.deepEqual(snapshot.bytes, bytes);
    snapshot.bytes.fill(0);
    assert.deepEqual(snapshot.bytes, bytes);
  }
  const { file, bytes } = sources[2];
  fs.writeFileSync(file.filePath, Buffer.alloc(bytes.length, 0x7a));
  assert.deepEqual(snapshots.get(file.filePath).bytes, bytes);
  assert.deepEqual(file.readSnapshot().bytes, Buffer.alloc(bytes.length, 0x7a));
});

test("grouped snapshots assemble complete payloads across legal short reads", t => {
  const { paths, files } = fixture(t);
  const read = fs.readSync;
  const selected = new ReadDescriptorSelection(t, paths[0]);
  let shortReads = 0;
  t.mock.method(fs, "readSync", (...args) => {
    if (selected.has(args[0])) { args[3] = Math.min(args[3], 2); shortReads++; }
    return read(...args);
  });
  const snapshots = AtomicFile.readSnapshots(files);
  assert.ok(shortReads > 1);
  assert.equal(snapshots.get(paths[0]).text(), "value-0");
  assert.equal(snapshots.get(paths[1]).text(), "value-1");
});

for (const changedClock of [false, true]) {
test(`grouped snapshots ${changedClock ? "refuse observably changed metadata" : "capture complete growth with a stable coarse clock"} during a read`, t => {
  const { paths, files } = fixture(t);
  const read = fs.readSync, fstat = fs.fstatSync, lstat = fs.lstatSync;
  const selected = new ReadDescriptorSelection(t, paths[0]);
  let appended = false, clockMs = Date.UTC(2026, 0, 1);
  const observedClock = stat => {
    if (typeof stat.mtimeNs !== "bigint") return stat;
    const observed = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
    for (const name of ["atime", "mtime", "ctime", "birthtime"]) {
      observed[`${name}Ns`] = BigInt(clockMs) * 1000000n;
      observed[`${name}Ms`] = BigInt(clockMs);
      observed[name] = new Date(clockMs);
    }
    return observed;
  };
  t.mock.method(fs, "fstatSync", (file, ...options) => {
    const stat = fstat(file, ...options);
    return selected.has(file) ? observedClock(stat) : stat;
  });
  t.mock.method(fs, "lstatSync", (file, ...options) => {
    const stat = lstat(file, ...options);
    return file === paths[0] ? observedClock(stat) : stat;
  });
  t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (selected.has(args[0]) && count > 0 && !appended) {
      appended = true;
      fs.appendFileSync(paths[0], ":appended");
      if (changedClock) clockMs += 5000;
    }
    return count;
  });
  let snapshots;
  const capture = () => { snapshots = AtomicFile.readSnapshots(files); };
  if (changedClock) {
    assert.throws(capture, { code: "REGULAR_FILE_READ_IDENTITY" });
    assert.equal(snapshots, undefined);
  } else {
    capture();
    assert.equal(snapshots.get(paths[0]).text(), "value-0:appended");
    assert.equal(snapshots.get(paths[1]).text(), "value-1");
  }
  assert.equal(appended, true);
  assert.equal(fs.readFileSync(paths[0], "utf8"), "value-0:appended");
});
}

for (const operation of ["capture", "compare"]) {
test(`grouped ${operation} refuses an earlier parent replaced while the final file is read`, t => {
  const { root, paths, files } = fixture(t);
  const originals = AtomicFile.readSnapshots(files);
  const expected = new Map(files.map(file => [file, originals.get(file.filePath)]));
  const open = fs.openSync, read = fs.readSync;
  let finalDescriptor = null, replaced = false, published;
  t.mock.method(fs, "openSync", (file, ...options) => {
    const descriptor = open(file, ...options);
    if (file === paths[1]) finalDescriptor = descriptor;
    return descriptor;
  });
  t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (!replaced && args[0] === finalDescriptor && count > 0) {
      replaced = true;
      fs.renameSync(path.join(root, "a"), path.join(root, "saved-a"));
      fs.mkdirSync(path.join(root, "a"));
      fs.writeFileSync(path.join(root, "a", "foreign"), "preserved");
    }
    return count;
  });
  assert.throws(() => { published = operation === "capture" ? AtomicFile.readSnapshots(files) : AtomicFile.snapshotsMatch(expected); }, { code: "REGULAR_FILE_READ_IDENTITY" });
  assert.equal(published, undefined);
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(root, "a", "foreign"), "utf8"), "preserved");
  assert.equal(fs.readFileSync(path.join(root, "saved-a", "data"), "utf8"), "value-0");
});
}

test("grouped snapshots retain individual same-byte replacement refusal", t => {
  const { paths, files } = fixture(t);
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (file, ...options) => {
    if (!replaced && file === paths[1]) {
      replaced = true;
      fs.renameSync(file, `${file}.saved`);
      fs.copyFileSync(`${file}.saved`, file);
    }
    return open(file, ...options);
  });
  assert.throws(() => AtomicFile.readSnapshots(files), { code: "REGULAR_FILE_READ_IDENTITY" });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(paths[1], "utf8"), "value-1");
});

test("grouped snapshots keep each file's original byte limit", t => {
  const { paths, files } = fixture(t);
  files[1] = new AtomicFile(paths[1], { maxBytes: 6 });
  assert.throws(() => AtomicFile.readSnapshots(files), { code: "REGULAR_FILE_READ_LIMIT" });
  assert.equal(fs.readFileSync(paths[1], "utf8"), "value-1");
});

test("grouped snapshots keep the single-link guarantee", t => {
  const { paths, files } = fixture(t);
  fs.linkSync(paths[1], `${paths[1]}.alias`);
  assert.throws(() => AtomicFile.readSnapshots(files), { code: "REGULAR_FILE_READ_IDENTITY" });
  assert.equal(fs.readFileSync(`${paths[1]}.alias`, "utf8"), "value-1");
});


test("grouped comparison retains exact versions and absence while detecting later byte, presence and generation changes", t => {
  const { paths, files } = fixture(t);
  const absent = new AtomicFile(path.join(path.dirname(paths[0]), "absent"));
  const group = AtomicFile.readSnapshots([...files, absent]);
  const expected = new Map([...files, absent].map(file => [file, group.get(file.filePath)]));
  assert.equal(AtomicFile.snapshotsMatch(expected), true);
  fs.writeFileSync(paths[0], "changed");
  assert.equal(AtomicFile.snapshotsMatch(expected), false);
  fs.writeFileSync(paths[0], "value-0");
  assert.equal(AtomicFile.snapshotsMatch(expected), true);
  fs.writeFileSync(absent.filePath, "new");
  assert.equal(AtomicFile.snapshotsMatch(expected), false);
  fs.unlinkSync(absent.filePath);
  fs.renameSync(paths[1], `${paths[1]}.saved`);
  fs.copyFileSync(`${paths[1]}.saved`, paths[1]);
  assert.equal(AtomicFile.snapshotsMatch(expected), false);
  assert.equal(fs.readFileSync(paths[1], "utf8"), "value-1");
});

test("grouped comparison still enforces the final file limit after an earlier value mismatches", t => {
  const { paths, files } = fixture(t);
  const group = AtomicFile.readSnapshots(files);
  const expected = new Map(files.map(file => [file, group.get(file.filePath)]));
  fs.writeFileSync(paths[0], "changed");
  fs.writeFileSync(paths[1], "x".repeat(33));
  assert.throws(() => AtomicFile.snapshotsMatch(expected), { code: "REGULAR_FILE_READ_LIMIT" });
  assert.equal(fs.readFileSync(paths[1], "utf8"), "x".repeat(33));
});
