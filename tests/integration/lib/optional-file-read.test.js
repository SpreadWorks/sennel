import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { captureRegularFile, visitRegularFileChunks } from "../../../src/lib/regular-file-snapshot.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("optional parent reads preserve absence without writes and later capture exact binary bytes and stream receipts", (t) => {
  const root = createTmpDir("optional-file-");
  t.after(() => removeTmpDir(root));
  const parent = path.join(root, "parent"), file = path.join(parent, "data");
  const directoryAuthority = new RealDirectoryAuthority(parent, { create: true });
  const options = { label: "optional input", maxBytes: 8, requireSingleLink: true,
    allowMissing: true, allowMissingDirectory: true, directoryAuthority };
  assert.equal(captureRegularFile(file, options), null);
  assert.deepEqual(fs.readdirSync(root), []);
  directoryAuthority.ensure();
  assert.equal(captureRegularFile(file, options), null);
  assert.deepEqual(fs.readdirSync(parent), []);
  const bytes = Buffer.from([0, 255, 10]);
  fs.writeFileSync(file, bytes);
  const snapshot = captureRegularFile(file, options);
  assert.deepEqual(snapshot.bytes, bytes);
  const pieces = [];
  const receipt = visitRegularFileChunks(file, { ...options, visit(chunk) { pieces.push(Buffer.from(chunk)); } });
  assert.deepEqual(Buffer.concat(pieces), bytes);
  assert.equal(receipt.digest, snapshot.digest);
  assert.equal(receipt.byteLength, bytes.length);
  assert.equal(receipt.identity.equals(snapshot.identity), true);
});

test("optional reads retain direct initial authority refusal and post-read parent replacement refusal", (t) => {
  const root = createTmpDir("optional-file-replacement-");
  t.after(() => removeTmpDir(root));
  const parent = path.join(root, "parent"), file = path.join(parent, "data");
  fs.mkdirSync(parent);
  fs.writeFileSync(file, "same");
  const directoryAuthority = new RealDirectoryAuthority(parent);
  const options = { label: "optional input", maxBytes: 4, requireSingleLink: true,
    allowMissing: true, allowMissingDirectory: true, directoryAuthority };
  let replaced = false;
  assert.throws(() => captureRegularFile(file, { ...options, onRead() {
    replaced = true;
    fs.renameSync(parent, path.join(root, "saved"));
    fs.mkdirSync(parent);
    fs.writeFileSync(file, "same");
  } }), error => error.code === "REGULAR_FILE_READ_IDENTITY"
    && error.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(file, "utf8"), "same");
  assert.equal(fs.readFileSync(path.join(root, "saved", "data"), "utf8"), "same");
  assert.throws(() => captureRegularFile(file, options), {
    code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID",
  });
});
