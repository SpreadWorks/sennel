import { test } from "node:test";
import assert from "node:assert/strict";
import { GitPluginArchive, GitPluginArchiveError, GitPluginArchiveLimits } from "../../src/lib/git-plugin-archive.js";

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return header;
}

function entry({ name = "file", type = "0", body = Buffer.alloc(0), size = body.length, mode = 0o644, mutate = () => {} } = {}) {
  const header = Buffer.alloc(512);
  header.write(name);
  for (const [offset, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 1]]) {
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, "latin1");
  }
  header.write(type, 156, "latin1");
  header.write("ustar\0" + "00", 257, "latin1");
  mutate(header);
  checksum(header);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function archive(...entries) { return Buffer.concat([...entries, Buffer.alloc(1024)]); }
function paxRecord(key, value) {
  const payload = Buffer.from(` ${key}=${value}\n`);
  let length = payload.length + 1;
  while (String(length).length + payload.length !== length) length = String(length).length + payload.length;
  return Buffer.concat([Buffer.from(String(length)), payload]);
}
function pax(type, ...records) { return entry({ type, name: "pax_header", body: Buffer.concat(records.map(([key, value]) => paxRecord(key, value))) }); }
function invalid(bytes, pattern) {
  assert.throws(() => GitPluginArchive.fromBuffer(bytes), (error) => error instanceof GitPluginArchiveError
    && error.code === "GIT_PLUGIN_ARCHIVE_INVALID" && pattern.test(error.message));
}

test("reads bounded regular/directory entries and UTF-8 byte-framed global/local PAX", () => {
  const bytes = archive(pax("g", ["comment", "a".repeat(40)]), entry({ name: "資料/", type: "5", mode: 0o755 }),
    pax("x", ["path", "資料/長い名前.txt"], ["size", "3"], ["mtime", "1.5"]),
    entry({ body: Buffer.from([0, 255, 1]), size: 0 }));
  const result = GitPluginArchive.fromBuffer(bytes);
  assert.equal(result.entryCount, 2);
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.comment, "a".repeat(40));
});

test("local PAX overrides global path/size and expires after its entry", () => {
  const result = GitPluginArchive.fromBuffer(archive(pax("g", ["path", "global"], ["size", "1"]),
    pax("x", ["path", "local"], ["size", "2"]), entry({ body: Buffer.from("ab"), size: 0 }),
    entry({ body: Buffer.from("c"), size: 0 })));
  assert.equal(result.entryCount, 2);
});

test("rejects header, numeric and unsupported-format corruption", () => {
  const badChecksum = archive(entry());
  badChecksum[0] ^= 1;
  invalid(badChecksum, /checksum/);
  for (const [label, mutate, pattern] of [
    ["octal", (header) => { header[124] = 56; }, /octal size/],
    ["base256", (header) => { header[124] = 128; }, /octal size/],
    ["uid", (header) => { header[108] = 45; }, /octal uid/],
    ["mtime", (header) => { header[136] = 120; }, /octal mtime/],
    ["format", (header) => { header[257] = 0; }, /format/],
    ["link", (header) => { header.write("target", 157); }, /link target/],
    ["device", (header) => { header.write("0000001\0", 329); }, /device/],
    ["tail", (header) => { header[511] = 1; }, /extension/],
    ["NUL", (header) => { header.write("a\0b", 0); }, /terminator/],
    ["UTF8", (header) => { header[0] = 255; }, /UTF-8/],
  ]) invalid(archive(entry({ mutate })), pattern, label);
  invalid(archive(entry({ mode: 0o4755 })), /permission/);
});

test("rejects every link or special TAR type before extraction", () => {
  for (const type of ["1", "2", "3", "4", "6", "7", "L", "K", "S", "z"]) {
    invalid(archive(entry({ type })), /unsupported entry type/);
  }
  invalid(archive(entry({ name: "dir/", type: "5", body: Buffer.from("x") })), /directory entry has content/);
});

test("validates complete block, payload padding and archive termination", () => {
  invalid(Buffer.alloc(0), /missing archive end/);
  invalid(Buffer.alloc(513), /incomplete archive block/);
  invalid(Buffer.concat([entry(), Buffer.alloc(512)]), /invalid archive end/);
  invalid(entry(), /missing archive end/);
  invalid(archive(entry({ size: 4096 })), /truncated/);
  const badPadding = archive(entry({ body: Buffer.from("x") }));
  badPadding[513] = 1;
  invalid(badPadding, /padding/);
  const trailing = archive(entry());
  trailing[trailing.length - 1] = 1;
  invalid(trailing, /end blocks/);
  invalid(Buffer.concat([archive(entry()), entry({ name: "hidden" })]), /end blocks/);
  assert.equal(GitPluginArchive.fromBuffer(Buffer.concat([archive(entry()), Buffer.alloc(512)])).entryCount, 1);
});

test("rejects malformed PAX byte framing, text, keys and numeric values", () => {
  for (const body of [Buffer.from("no length"), Buffer.from("01 path=x\n"), Buffer.from("99 path=x\n"),
    Buffer.from("1 path=x\n"), Buffer.from("9 path=x!"), Buffer.from("8 broken\n"),
    Buffer.from("13 path=資料\n"), paxRecord("path", "a\0b"),
    Buffer.concat([Buffer.from("10 path="), Buffer.from([255, 10])])]) {
    assert.throws(() => GitPluginArchive.fromBuffer(archive(entry({ type: "x", body }), entry())), GitPluginArchiveError);
  }
  for (const value of ["-1", "1.5", "9007199254740992", "", "01"]) invalid(archive(pax("x", ["size", value]), entry()), /PAX size/);
  invalid(archive(pax("x", ["path", "a"], ["path", "b"]), entry()), /duplicate PAX key/);
  invalid(archive(pax("x", ["GNU.sparse.size", "1"]), entry()), /unsupported PAX key/);
  invalid(archive(pax("x", ["linkpath", "target"]), entry()), /unsupported PAX key/);
  invalid(archive(pax("x", ["mtime", "NaN"]), entry()), /PAX mtime/);
  invalid(archive(pax("x", ["path", "a"])), /orphan PAX/);
  invalid(archive(pax("x", ["path", "a"]), pax("g", ["comment", "x"]), entry()), /must precede/);
});

test("rejects nonportable raw and effective global/local paths and aliases", () => {
  for (const name of ["../escape", "/absolute", "a/../b", "CON", "C:/drive", "a\\b", "a//b", "file.", "file "]) {
    for (const bytes of [archive(entry({ name })), archive(pax("g", ["path", name]), entry()), archive(pax("x", ["path", name]), entry())]) {
      assert.throws(() => GitPluginArchive.fromBuffer(bytes), { code: "PORTABLE_PATH_INVALID" });
    }
  }
  for (const names of [["same", "same"], ["Case", "case"], ["é", "e\u0301"], ["DIR/a", "dir/b"]]) {
    assert.throws(() => GitPluginArchive.fromBuffer(archive(...names.map((name) => entry({ name })))), { code: "PORTABLE_PATH_COLLISION" });
  }
  assert.throws(() => GitPluginArchive.fromBuffer(archive(entry({ name: "dir/", type: "5" }), entry({ name: "dir" }))), { code: "PORTABLE_PATH_COLLISION" });
  for (const entries of [[entry({ name: "a" }), entry({ name: "a/b" })], [entry({ name: "a/b/", type: "5" }), entry({ name: "a" })]]) {
    invalid(archive(...entries), /file path prefixes/);
  }
  assert.throws(() => GitPluginArchive.fromBuffer(archive(pax("g", ["path", "same"]), entry(), entry())), { code: "PORTABLE_PATH_COLLISION" });
});

test("enforces independently bounded archive, headers, payload and effective size", () => {
  const bytes = archive(entry({ body: Buffer.from("ab") }), entry({ name: "other", body: Buffer.from("cd") }));
  for (const [options, pattern] of [[{ archiveBytes: bytes.length - 1 }, /archive byte/], [{ entries: 1 }, /entry count/],
    [{ entryBytes: 1 }, /header size/], [{ totalBytes: 3 }, /total payload/]]) {
    assert.throws(() => GitPluginArchive.fromBuffer(bytes, { limits: new GitPluginArchiveLimits(options) }), pattern);
  }
  const bounded = new GitPluginArchiveLimits({ entryBytes: 512 });
  for (const type of ["g", "x"]) {
    assert.throws(() => GitPluginArchive.fromBuffer(archive(pax(type, ["size", "513"]), entry()), { limits: bounded }), /entry size/);
  }
  assert.throws(() => GitPluginArchive.fromBuffer(archive(pax("g", ["comment", "x"]), entry()),
    { limits: new GitPluginArchiveLimits({ entries: 1 }) }), /entry count/);
  assert.throws(() => new GitPluginArchiveLimits({ entryBytes: Infinity }), TypeError);
  assert.throws(() => new GitPluginArchiveLimits({ entries: 10001 }), TypeError);
  assert.throws(() => new GitPluginArchive(null), TypeError);
});
