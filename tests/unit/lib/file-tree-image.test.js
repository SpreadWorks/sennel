import assert from "node:assert/strict";
import { test } from "node:test";
import { FileTreeImage, FileTreeEntry, DirectoryTreeEntry, FileTreeImageRevisionError } from "../../../src/lib/file-tree-image.js";

function image() {
  return new FileTreeImage([new DirectoryTreeEntry(""), new DirectoryTreeEntry("data"),
    new FileTreeEntry("data/日本語.bin", Buffer.from([0, 255, 13, 10]))]);
}

test("transaction image preserves exact binary bytes and stored names through strict codec", () => {
  const source = image();
  const restored = FileTreeImage.fromStored(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(restored.toJSON(), source.toJSON());
  assert.equal(restored.toJSON().schemaRevision, 2);
  assert.deepEqual(restored.entries.at(-1).bytes, Buffer.from([0, 255, 13, 10]));
  const bytes = restored.entries.at(-1).bytes;
  bytes.fill(7);
  assert.deepEqual(restored.entries.at(-1).bytes, Buffer.from([0, 255, 13, 10]));
  assert.equal("mode" in restored.entries.at(-1).toJSON(), false);
});

for (const [name, mutate] of [
  ["wrong bytes", (wire) => { wire.entries.at(-1).bytes = "AQ=="; }],
  ["wrong length", (wire) => { wire.entries.at(-1).byteLength = 3; }],
  ["wrong digest", (wire) => { wire.entries.at(-1).hash = "0".repeat(64); }],
  ["wrong image hash", (wire) => { wire.hash = "0".repeat(64); }],
  ["extra mode field", (wire) => { wire.entries.at(-1).mode = 0o755; }],
  ["noncanonical base64", (wire) => { wire.entries.at(-1).bytes += "\n"; }],
  ["unsupported kind", (wire) => { wire.entries.at(-1).kind = "link"; }],
]) test(`transaction image refuses ${name}`, () => {
  const wire = image().toJSON();
  mutate(wire);
  assert.throws(() => FileTreeImage.fromStored(wire));
});

test("old mode-bearing images require explicit recovery instead of compatibility interpretation", () => {
  assert.throws(() => FileTreeImage.fromStored({ directories: [""], files: [] }),
    (error) => error instanceof FileTreeImageRevisionError && error.revision === 1 && error.requiredRevision === 2);
});

test("transaction image rejects missing directory ancestry and cross-platform aliases before publication", () => {
  assert.throws(() => new FileTreeImage([new DirectoryTreeEntry(""), new FileTreeEntry("missing/file", Buffer.alloc(0))]), /ancestry/);
  const source = image();
  assert.throws(() => source.assertFileTargets(["DATA/other.json"]), { code: "PORTABLE_PATH_COLLISION" });
  assert.throws(() => source.assertFileTargets(["data/日本語.bin/child"]), { code: "PORTABLE_PATH_COLLISION" });
  assert.throws(() => source.assertFileTargets(["data"]), /(?:existing directory|prefixes another target)/);
  assert.throws(() => source.assertFileTargets(["data/NUL.json"]), { code: "PORTABLE_PATH_INVALID" });
});
