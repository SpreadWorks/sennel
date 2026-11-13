import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { GitConfigurationObservation, GitReferenceObservation, GitIndexObservation } from "../../src/lib/git-source-observation.js";
import { RegularFileSnapshot } from "../../src/lib/regular-file-snapshot.js";

function indexBytes({ version = 2, width = 40, mode = 0o100644, extension = null } = {}) {
  const entry = Buffer.alloc(Math.ceil((40 + width / 2 + 2 + 5) / 8) * 8);
  entry.writeUInt32BE(mode, 24);
  entry.writeUInt16BE(4, 40 + width / 2);
  entry.write("file", 42 + width / 2);
  const header = Buffer.alloc(12);
  header.write("DIRC"); header.writeUInt32BE(version, 4); header.writeUInt32BE(1, 8);
  const ext = extension === null ? Buffer.alloc(0) : Buffer.concat([Buffer.from(extension), Buffer.alloc(4)]);
  return Buffer.concat([header, entry, ext, Buffer.alloc(width / 2)]);
}
function snapshot(bytes) { return new RegularFileSnapshot({ filePath: path.resolve("index"), bytes }); }
const oid = "a".repeat(40);
const native = [Buffer.from(`100644 ${oid} 0\tfile\0`), Buffer.from("H file\0"), Buffer.from("i/lf    w/lf    attr/                 \tfile\0")];
const combined = Buffer.from(`H 100644 ${oid} 0\ti/lf    w/lf    attr/                 \tfile\0`);

it("projects native index streams without changing raw path bytes or sharing mutable buffers", () => {
  const pathname = Buffer.from([102, 9, 10, 0xff, 0]);
  const observed = GitIndexObservation.read({ snapshot: snapshot(indexBytes()), objectIdLength: 40, maxBytes: 65536,
    read: () => Buffer.concat([Buffer.from(`s 100755 ${oid} 2\ti/none  w/-text attr/-text           \t`), pathname]) });
  assert.deepEqual(observed.index, Buffer.concat([Buffer.from(`100755 ${oid} 2\t`), pathname]));
  assert.deepEqual(observed.flags, Buffer.concat([Buffer.from("s "), pathname]));
  assert.deepEqual(observed.materialization, Buffer.concat([Buffer.from("i/none  w/-text attr/-text           \t"), pathname]));
  const detached = observed.index; detached.fill(0);
  assert.equal(observed.index[0], 49);
});

it("keeps every bounded native stream available at and below the combined-output bound", () => {
  const bytes = indexBytes();
  for (const [maxBytes, expectedCalls] of [[bytes.length + 256, 1], [bytes.length + 255, 3]]) {
    const calls = [];
    const observed = GitIndexObservation.read({ snapshot: snapshot(bytes), objectIdLength: 40, maxBytes,
      read: (args) => { calls.push(args); return expectedCalls === 1 ? combined : native[calls.length - 1]; } });
    assert.equal(calls.length, expectedCalls);
    assert.deepEqual([observed.index, observed.flags, observed.materialization], native);
  }
});

it("uses independent bounded reads for missing, compressed, split, sparse and unrecognized indexes", () => {
  for (const bytes of [null, indexBytes({ version: 4 }), indexBytes({ extension: "link" }), indexBytes({ mode: 0o40000 }),
    indexBytes({ extension: "sdir" }), Buffer.from("truncated")]) {
    let calls = 0;
    const observed = GitIndexObservation.read({ snapshot: bytes === null ? null : snapshot(bytes), objectIdLength: 40,
      maxBytes: 65536, read: () => native[calls++] });
    assert.equal(calls, 3);
    assert.deepEqual([observed.index, observed.flags, observed.materialization], native);
  }
});

it("preserves native execution failure without another query", () => {
  const failure = new Error("native output limit");
  let calls = 0;
  assert.throws(() => GitIndexObservation.read({ snapshot: snapshot(indexBytes()), objectIdLength: 40, maxBytes: 65536,
    read: () => { calls++; throw failure; } }), (error) => error === failure);
  assert.equal(calls, 1);
});

it("rejects malformed combined records rather than manufacturing paths", () => {
  for (const bytes of [Buffer.from("H no-fields\0"), combined.subarray(0, combined.length - 1)]) {
    assert.throws(() => GitIndexObservation.read({ snapshot: snapshot(indexBytes()), objectIdLength: 40, maxBytes: 65536,
      read: () => bytes }), /invalid combined Git index record/);
  }
});

it("uses the final configuration value and Git's own uncommon boolean normalization", () => {
  for (const [value, expected] of [[null, true], ["", false], ["YES", true], ["off", false], ["1", true], ["0", false]]) {
    const suffix = value === null ? "" : `\n${value}`;
    const observation = new GitConfigurationObservation(Buffer.from(`file:one\0core.filemode\ninvalid\0file:two\0core.filemode${suffix}\0`));
    assert.equal(observation.boolean("core.filemode", false, () => assert.fail("canonical value needs no second query")), expected);
    assert.equal(observation.boolean("core.symlinks", true, () => assert.fail("missing value needs no query")), true);
  }
  for (const value of ["2k", "-1", "invalid", " true ", "true\nfalse"]) {
    const observation = new GitConfigurationObservation(Buffer.from(`file:one\0core.filemode\n${value}\0`));
    const marker = new Error(value);
    assert.throws(() => observation.boolean("core.filemode", true, () => { throw marker; }), (error) => error === marker);
  }
});

it("requires the HEAD record and retains either native object ID width", () => {
  for (const width of [40, 64]) {
    const head = "a".repeat(width);
    assert.equal(new GitReferenceObservation(Buffer.from(`${head} HEAD\n${"b".repeat(width)} refs/heads/main\n`)).head, head);
  }
  assert.throws(() => new GitReferenceObservation(Buffer.from(`${oid} refs/heads/main\n`)), /Git HEAD reference is invalid/);
});

it("reads the same final boolean from native origin-bearing and flat configuration records", () => {
  const records = Buffer.from("core.filemode\ninvalid\0core.filemode\nfalse\0core.symlinks\0");
  const configuration = GitConfigurationObservation.fromRecords(records);
  assert.equal(configuration.boolean("core.filemode", true, () => assert.fail("the final canonical value requires no extra query")), false);
  assert.equal(configuration.boolean("core.symlinks", false, () => assert.fail("valueless is canonical true")), true);
});

it("prepares captured native path input in either object format without sharing its buffers", () => {
  for (const width of [40, 64]) {
    const plan = GitIndexObservation.prepare({ snapshot: snapshot(indexBytes({ width })), maxBytes: 65536 });
    assert.notEqual(plan, null);
    assert.deepEqual(plan.attributeInput, Buffer.from("file\0"));
    const changed = plan.attributeInput; changed.fill(0);
    assert.deepEqual(plan.attributeInput, Buffer.from("file\0"));
    const object = "a".repeat(width);
    const bytes = Buffer.from(`H 100644 ${object} 0\ti/lf    w/lf    attr/                 \tfile\0`);
    const observed = plan.observe(bytes, width);
    assert.deepEqual(observed.index, Buffer.from(`100644 ${object} 0\tfile\0`));
    assert.deepEqual(observed.attributeInput, plan.attributeInput);
  }
});

it("refuses a prepared path or object-format mismatch instead of returning authority from different native data", () => {
  const plan = GitIndexObservation.prepare({ snapshot: snapshot(indexBytes()), maxBytes: 65536 });
  assert.notEqual(plan, null);
  assert.throws(() => plan.observe(combined, 64), /format differs from native HEAD/);
  assert.throws(() => plan.observe(Buffer.from(combined.toString().replace("file\0", "different\0")), 40), /paths differ from the native index/);
  assert.throws(() => plan.observe(Buffer.concat([combined, combined]), 40), /paths differ from the native index/);
});

it("keeps missing, unsupported, oversized, non-UTF8 and ambiguous captured layouts on the original native read path", () => {
  const invalidPath = indexBytes(); invalidPath[12 + 42 + 20] = 0xff;
  const header = Buffer.alloc(12); header.write("DIRC"); header.writeUInt32BE(2, 4);
  // Both structural widths fit; do not guess from an untrusted layout. Native
  // Git still owns validating this malformed file if a caller selects it.
  const ambiguous = Buffer.concat([header, Buffer.from("TREE"), Buffer.alloc(4),
    Buffer.from("ABCD"), Buffer.from([0,0,0,4]), Buffer.alloc(4), Buffer.alloc(20)]);
  for (const bytes of [null, indexBytes({ version: 4 }), indexBytes({ extension: "link" }),
    indexBytes({ mode: 0o40000 }), invalidPath, ambiguous, Buffer.from("truncated")]) {
    assert.equal(GitIndexObservation.prepare({ snapshot: bytes === null ? null : snapshot(bytes), maxBytes: 65536 }), null);
  }
  const bytes = indexBytes();
  assert.equal(GitIndexObservation.prepare({ snapshot: snapshot(bytes), maxBytes: bytes.length + 255 }), null);
});
