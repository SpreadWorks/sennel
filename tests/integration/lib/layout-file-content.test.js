import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LayoutFileContent } from "../../../src/lib/layout-file-content.js";
import { DEFAULT_MAX_FILE_BYTES, MAX_IN_MEMORY_FILE_BYTES, FilePermissionHint } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t, bytes) {
  const root = createTmpDir("layout-file-content-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.writeFileSync(source, bytes);
  return { root, source, destination };
}

function assertUnpublished(root, source, destination, expected) {
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readFileSync(source), expected);
  assert.deepEqual(fs.readdirSync(root), ["source"]);
}

test("streamed layout capture enforces an explicit per-file source limit before reading or publishing", t => {
  const { root, source, destination } = fixture(t, Buffer.alloc(0));
  fs.truncateSync(source, DEFAULT_MAX_FILE_BYTES + 1);
  const original = fs.lstatSync(source, { bigint: true });
  for (const transform of [false, true]) {
    assert.throws(() => LayoutFileContent.capture(source, { transform, maxBytes: DEFAULT_MAX_FILE_BYTES }), { code: "REGULAR_FILE_READ_LIMIT" });
  }
  const after = fs.lstatSync(source, { bigint: true });
  assert.equal(after.dev, original.dev);
  assert.equal(after.ino, original.ino);
  assert.equal(after.size, BigInt(DEFAULT_MAX_FILE_BYTES + 1));
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root), ["source"]);
});

test("layout capture rejects a file exceeding its original default bound before opening it", t => {
  const { root, source, destination } = fixture(t, Buffer.alloc(0));
  const lstat = fs.lstatSync;
  const open = fs.openSync;
  let opened = false;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    return file === source ? { ...stat, size: BigInt(MAX_IN_MEMORY_FILE_BYTES) + 1n } : stat;
  });
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === source) opened = true;
    return open(file, ...args);
  });
  for (const transform of [false, true]) {
    assert.throws(() => LayoutFileContent.capture(source, { transform }), { code: "REGULAR_FILE_READ_LIMIT" });
  }
  assert.equal(opened, false);
  assertUnpublished(root, source, destination, Buffer.alloc(0));
});

test("layout content streams a BOM and tokens spanning physical chunks, with exact source and publication receipts", t => {
  const bytes = Buffer.from(`\ufeff${"x".repeat(65528)} sentiDir SentiRunner sdd-forge\n`);
  const expected = Buffer.from(`\ufeff${"x".repeat(65528)} managedDir SennelRunner sennel\n`);
  const { source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source, { transform: true });
  assert.equal(content.transform, true);
  assert.equal(content.original.digest, digest(bytes));
  assert.equal(content.original.byteLength, bytes.length);
  assert.equal(content.transformedDigest, digest(expected));
  assert.equal(content.transformedByteLength, expected.length);
  const result = content.copyTo(destination);
  assert.equal(result.committed, true);
  assert.equal(result.receipt.digest, digest(expected));
  assert.equal(result.receipt.byteLength, expected.length);
  assert.deepEqual(fs.readFileSync(destination), expected);
  assert.deepEqual(fs.readFileSync(source), bytes);
});

test("layout before-images retain independent original bytes while user-file copies receive the template transformation", t => {
  const bytes = Buffer.from("\ufeffsentiDir SentiRunner\n");
  const { root, source, destination } = fixture(t, bytes);
  fs.chmodSync(source, 0o755);
  const content = LayoutFileContent.capture(source, { transform: true });
  const beforeImage = path.join(root, "before-image");
  const retained = content.writeBeforeImage(beforeImage);
  const copied = content.copyTo(destination);
  assert.equal(retained.receipt.digest, digest(bytes));
  assert.equal(copied.receipt.digest, digest(Buffer.from("\ufeffmanagedDir SennelRunner\n")));
  assert.deepEqual(fs.readFileSync(beforeImage), bytes);
  assert.equal(fs.readFileSync(destination, "utf8"), "\ufeffmanagedDir SennelRunner\n");
  assert.equal(new FilePermissionHint(0o600).matches(FilePermissionHint.fromStat(fs.statSync(beforeImage))), true);
  assert.equal(content.original.permissionHint.matchesAfterWrite(FilePermissionHint.fromStat(fs.statSync(destination))), true);
  fs.writeFileSync(source, "subsequent source bytes");
  assert.deepEqual(fs.readFileSync(beforeImage), bytes);
  assert.equal(fs.readFileSync(destination, "utf8"), "\ufeffmanagedDir SennelRunner\n");
});

test("layout content preserves the entire raw file when invalid UTF-8 appears after transformed provisional chunks", t => {
  const bytes = Buffer.concat([Buffer.from("senti ".repeat(14000)), Buffer.from([0xff]), Buffer.from(" sentiDir\n")]);
  const { source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source, { transform: true });
  assert.equal(content.transform, false);
  assert.equal(content.transformedDigest, digest(bytes));
  assert.equal(content.transformedByteLength, bytes.length);
  const result = content.copyTo(destination);
  assert.equal(result.receipt.digest, digest(bytes));
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(fs.readFileSync(source), bytes);
});

test("layout content leaves complete valid text unchanged when its path requires a raw copy", t => {
  const bytes = Buffer.from("sentiDir SentiRunner sdd-forge\n");
  const { source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source);
  assert.equal(content.transform, false);
  assert.equal(content.transformedDigest, digest(bytes));
  content.copyTo(destination);
  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test("layout content publishes an empty valid template with the empty-byte receipt", t => {
  const { source, destination } = fixture(t, Buffer.alloc(0));
  const content = LayoutFileContent.capture(source, { transform: true });
  assert.equal(content.transform, true);
  assert.equal(content.original.byteLength, 0);
  assert.equal(content.transformedByteLength, 0);
  const result = content.copyTo(destination);
  assert.equal(result.receipt.digest, digest(Buffer.alloc(0)));
  assert.deepEqual(fs.readFileSync(destination), Buffer.alloc(0));
});

test("layout content refuses changed source bytes before publication and removes only its output stage", t => {
  const { root, source, destination } = fixture(t, Buffer.from("senti"));
  const content = LayoutFileContent.capture(source, { transform: true });
  const changed = Buffer.from("foreign source bytes");
  fs.writeFileSync(source, changed);
  assert.throws(() => content.copyTo(destination), { code: "ATOMIC_FILE_WRITE_FAILED" });
  assertUnpublished(root, source, destination, changed);
});

test("layout content refuses a same-byte source replacement before publication", t => {
  const bytes = Buffer.from("senti");
  const { root, source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source, { transform: true });
  fs.renameSync(source, `${source}.saved`);
  fs.writeFileSync(source, bytes);
  assert.throws(() => content.copyTo(destination), { code: "ATOMIC_FILE_WRITE_FAILED" });
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.deepEqual(fs.readFileSync(`${source}.saved`), bytes);
  assert.deepEqual(fs.readdirSync(root).sort(), ["source", "source.saved"]);
});

test("layout content refuses a destination collision without changing either source or destination", t => {
  const bytes = Buffer.from("senti");
  const { root, source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source, { transform: true });
  fs.writeFileSync(destination, "foreign destination");
  assert.throws(() => content.copyTo(destination), { code: "ATOMIC_FILE_WRITE_FAILED" });
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.equal(fs.readFileSync(destination, "utf8"), "foreign destination");
  assert.deepEqual(fs.readdirSync(root).sort(), ["destination", "source"]);
});

test("layout content refuses a source mutation during the physical copy interval", t => {
  const { root, source, destination } = fixture(t, Buffer.from("senti"));
  const content = LayoutFileContent.capture(source, { transform: true });
  const changed = Buffer.from("changed during read");
  let injected = false;
  assert.throws(() => content.copyTo(destination, { faultInjector(event) {
    if (event.phase === "before-layout-copy-source-read") { injected = true; fs.writeFileSync(source, changed); }
  } }), { code: "ATOMIC_FILE_WRITE_FAILED" });
  assert.equal(injected, true);
  assertUnpublished(root, source, destination, changed);
});

test("layout content refuses an output stage that differs from the source-derived transformation", t => {
  const bytes = Buffer.from("senti");
  const { root, source, destination } = fixture(t, bytes);
  const content = LayoutFileContent.capture(source, { transform: true });
  let injected = false;
  const options = { faultInjector(event) {
    if (event.phase === "before-layout-copy-fsync") { injected = true; fs.writeFileSync(event.tempPath, "foreign stage bytes"); }
  } };
  assert.throws(() => content.copyTo(destination, options), /output differs from its source-derived transformation/);
  assert.equal(injected, true);
  assertUnpublished(root, source, destination, bytes);
});
