import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { FilePermissionHint, RegularFileReadReceipt, RegularFileSnapshot } from "../../src/lib/regular-file-snapshot.js";
import crypto from "node:crypto";

const identity = { dev: -(1n << 63n), ino: (1n << 63n) + 1n };
const snapshot = (bytes = Buffer.from("exact"), generation = identity, name = "snapshot") =>
  new RegularFileSnapshot({ filePath: path.resolve(name), bytes, identity: generation });

test("file version comparison preserves exact captured bytes independently of mutable buffers and path spelling", () => {
  const input = Buffer.from("exact"), captured = snapshot(input);
  input.fill(0); captured.bytes.fill(0);
  assert.equal(captured.hasSameFileVersion(snapshot()), true);
  assert.equal(captured.hasSameFileVersion(snapshot(Buffer.from("exact"), identity, "renamed")), true);
  assert.equal(captured.text(), "exact");
});

test("file version comparison rejects changed bytes, changed generation and absent physical identity", () => {
  const captured = snapshot();
  for (const other of [snapshot(Buffer.from("other")), snapshot(Buffer.from("exact"), { ...identity, ino: identity.ino + 1n }),
    snapshot(Buffer.from("exact"), null), null]) assert.equal(captured.hasSameFileVersion(other), false);
  assert.equal(snapshot(Buffer.from("exact"), null).hasSameFileVersion(snapshot(Buffer.from("exact"), null)), false);
});

const receipt = (text = "exact", generation = identity, mode = 0o600) => new RegularFileReadReceipt({
  filePath: path.resolve("receipt"), identity: generation, byteLength: Buffer.byteLength(text),
  digest: crypto.createHash("sha256").update(text).digest("hex"), permissionHint: new FilePermissionHint(mode),
});

test("streamed version comparison preserves content and generation independently of permission hints", () => {
  assert.equal(receipt().hasSameFileVersion(receipt("exact", identity, 0o640)), true);
});

test("streamed version comparison refuses changed content or generation and nonreceipt values", () => {
  assert.equal(receipt().hasSameFileVersion(receipt("different bytes")), false);
  assert.equal(receipt().hasSameFileVersion(receipt("exact", { ...identity, ino: identity.ino + 1n })), false);
  assert.equal(receipt().hasSameFileVersion(null), false);
});
