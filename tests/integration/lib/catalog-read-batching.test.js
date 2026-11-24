import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ArtifactAuthoritySlot,
  FlowArtifactCatalog,
  FlowArtifactDescriptor,
  FlowVersionAuthorityScope,
  FlowVersionLocation,
} from "../../../src/lib/flow-version.js";
import { RegularFileReadError } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t, count, byteLength = 16) {
  const root = createTmpDir("catalog-read-batching-");
  t.after(() => removeTmpDir(root));
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "catalog-read", version: 1 });
  const parent = location.resolve("artifacts/migration");
  fs.mkdirSync(parent, { recursive: true });
  const bytes = Buffer.alloc(byteLength, 0x61);
  const artifacts = [];
  for (let index = 0; index < count; index++) {
    const relativePath = `artifacts/migration/source-${index}.bin`;
    fs.writeFileSync(location.resolve(relativePath), bytes);
    artifacts.push(FlowArtifactDescriptor.fromFile({ location, relativePath,
      authoritySlot: ArtifactAuthoritySlot.singleton({ kind: `source-${index}`, authority: "canonical-flow-artifacts" }),
      mediaType: "application/octet-stream", retention: "permanent", migrationMaterialization: true }));
  }
  return { root, location, parent, bytes, catalog: FlowArtifactCatalog.regenerate(artifacts) };
}

test("catalog sibling reads share fresh ancestor observations while checking every artifact", (t) => {
  const single = fixture(t, 1);
  const many = fixture(t, 17);
  const original = fs.lstatSync;
  const reads = new Map([[single.root, 0], [many.root, 0]]);
  t.mock.method(fs, "lstatSync", function (target, ...options) {
    if (reads.has(target)) reads.set(target, reads.get(target) + 1);
    return original.call(this, target, ...options);
  });
  assert.equal(single.catalog.verify(single.location), single.catalog);
  assert.equal(many.catalog.verify(many.location), many.catalog);
  assert.ok(reads.get(many.root) <= reads.get(single.root) + 2,
    `sibling files must share ancestor observations; single=${reads.get(single.root)}, many=${reads.get(many.root)}`);
  const last = many.catalog.artifacts.at(-1);
  const changed = Buffer.from(many.bytes);
  changed[0] ^= 1;
  fs.writeFileSync(many.location.resolve(last.relativePath), changed);
  assert.throws(() => many.catalog.verify(many.location), /artifact content does not match the catalog/);
  assert.deepEqual(fs.readFileSync(many.location.resolve(last.relativePath)), changed);
});

test("catalog reads accept an artifact larger than the internal capture batch", (t) => {
  const value = fixture(t, 1, 9 * 1024 * 1024);
  assert.equal(value.catalog.verify(value.location), value.catalog);
  assert.deepEqual(fs.readFileSync(value.location.resolve(value.catalog.artifacts[0].relativePath)), value.bytes);
});

test("catalog verification preserves the content-mismatch error for an enlarged artifact", (t) => {
  const value = fixture(t, 3);
  const artifact = value.catalog.artifacts.at(-1);
  const file = value.location.resolve(artifact.relativePath);
  const changed = Buffer.concat([value.bytes, Buffer.from("tampered\n")]);
  fs.writeFileSync(file, changed);
  assert.throws(() => value.catalog.verify(value.location), error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, `artifact content does not match the catalog: ${artifact.relativePath}`);
    return true;
  });
  assert.deepEqual(fs.readFileSync(file), changed);
});

test("catalog capture refuses a parent replacement during a sibling body read and preserves both trees", (t) => {
  const value = fixture(t, 3);
  const last = value.location.resolve(value.catalog.artifacts.at(-1).relativePath);
  const retained = path.join(value.root, "retained-original");
  const open = fs.openSync;
  const read = fs.readSync;
  let descriptor = null;
  let replaced = false;
  t.mock.method(fs, "openSync", function (target, ...options) {
    const result = open.call(this, target, ...options);
    if (target === last) descriptor = result;
    return result;
  });
  t.mock.method(fs, "readSync", function (target, ...options) {
    const result = read.call(this, target, ...options);
    if (target === descriptor && result > 0 && !replaced) {
      replaced = true;
      fs.renameSync(value.parent, retained);
      fs.mkdirSync(value.parent);
      for (const artifact of value.catalog.artifacts) fs.writeFileSync(value.location.resolve(artifact.relativePath), value.bytes);
    }
    return result;
  });
  assert.throws(() => value.catalog.verify(value.location), error => {
    assert.ok(error instanceof RegularFileReadError);
    assert.equal(error.code, "REGULAR_FILE_READ_IDENTITY");
    return true;
  });
  assert.equal(replaced, true);
  for (const artifact of value.catalog.artifacts) {
    assert.deepEqual(fs.readFileSync(value.location.resolve(artifact.relativePath)), value.bytes);
    assert.deepEqual(fs.readFileSync(path.join(retained, path.basename(artifact.relativePath))), value.bytes);
  }
});

test("a completed catalog read reacquires fresh child directories on its next call", (t) => {
  const value = fixture(t, 3);
  assert.equal(value.catalog.verify(value.location), value.catalog);
  const retained = path.join(value.root, "previous-directory");
  fs.renameSync(value.parent, retained);
  fs.mkdirSync(value.parent);
  for (const artifact of value.catalog.artifacts) fs.writeFileSync(value.location.resolve(artifact.relativePath), value.bytes);
  assert.equal(value.catalog.verify(value.location), value.catalog);
  for (const artifact of value.catalog.artifacts) {
    assert.deepEqual(fs.readFileSync(path.join(retained, path.basename(artifact.relativePath))), value.bytes);
  }
});

test("catalog verification preserves the missing-path refusal for the first artifact in a shared parent", t => {
  const value = fixture(t, 3);
  const first = value.catalog.artifacts[0];
  const file = value.location.resolve(first.relativePath);
  fs.unlinkSync(file);
  assert.throws(() => value.catalog.verify(value.location), error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, `Version authority path does not exist: ${path.relative(value.location.repositoryRoot, file)}`);
    return true;
  });
  assert.equal(fs.existsSync(file), false);
  for (const artifact of value.catalog.artifacts.slice(1)) {
    assert.deepEqual(fs.readFileSync(value.location.resolve(artifact.relativePath)), value.bytes);
  }
});
