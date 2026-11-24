import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  FlowVersionLocation,
  FlowVersionAuthorityScope,
  FlowArtifactDescriptor,
  ArtifactAuthoritySlot,
} from "../../../src/lib/flow-version.js";
import { RegularFileReadError } from "../../../src/lib/regular-file-snapshot.js";

function fixture(t) {
  const root = createTmpDir("artifact-resolution-");
  t.after(() => removeTmpDir(root));
  const location = new FlowVersionLocation({
    repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(),
    specId: "authority-resolution",
    version: 1,
  });
  const relativePath = "artifacts/migration/source.json",
    file = location.resolve(relativePath),
    parent = path.dirname(file),
    retained = path.join(root, "retained-parent"),
    bytes = Buffer.from("original bytes");
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(file, bytes);
  const options = {
    location,
    authoritySlot: ArtifactAuthoritySlot.singleton({ kind: "source", authority: "canonical-flow-artifacts" }),
    relativePath,
    mediaType: "application/json",
    retention: "permanent",
    migrationMaterialization: true,
  };
  const descriptor = FlowArtifactDescriptor.fromFile(options);
  return { root, location, file, parent, retained, bytes, options, descriptor };
}

for (const operation of ["fromFile", "readBytes"]) {
  test(`artifact ${operation} retains typed capture refusal after direct parent removal`, t => {
    const { location, file, parent, retained, bytes, options, descriptor } = fixture(t);
    const original = fs.lstatSync;
    let targetReads = 0, displaced = false;
    t.mock.method(fs, "lstatSync", function (target, ...args) {
      const result = original.call(this, target, ...args);
      if (path.resolve(target) === file && ++targetReads === 2) {
        fs.renameSync(parent, retained);
        displaced = true;
      }
      return result;
    });
    let error;
    try {
      operation === "fromFile" ? FlowArtifactDescriptor.fromFile(options) : descriptor.readBytes(location);
    } catch (cause) {
      error = cause;
    }
    assert.equal(displaced, true);
    assert.deepEqual(fs.readFileSync(path.join(retained, "source.json")), bytes);
    assert.equal(fs.existsSync(parent), false);
    assert.equal(error?.code, "REGULAR_FILE_READ_IDENTITY");
    assert.ok(error instanceof RegularFileReadError);
    assert.equal(error.reason, "identity");
  });

  test(`artifact ${operation} accepts its parent appearing during authority validation`, t => {
    const { location, file, parent, retained, bytes, options, descriptor } = fixture(t);
    fs.renameSync(parent, retained);
    const original = fs.lstatSync;
    let appeared = false;
    t.mock.method(fs, "lstatSync", function (target, ...args) {
      if (path.resolve(target) === file && !appeared) {
        fs.mkdirSync(parent);
        fs.writeFileSync(file, bytes);
        appeared = true;
      }
      return original.call(this, target, ...args);
    });
    if (operation === "fromFile") assert.deepEqual(FlowArtifactDescriptor.fromFile(options).toJSON(), descriptor.toJSON());
    else assert.deepEqual(descriptor.readBytes(location), bytes);
    assert.equal(appeared, true);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readFileSync(path.join(retained, "source.json")), bytes);
  });
}

test("artifact repeated read retains replacement refusal after body read", t => {
  const { location, file, parent, retained, bytes, descriptor } = fixture(t);
  assert.deepEqual(descriptor.readBytes(location), bytes);
  let replaced = false;
  assert.throws(() => descriptor.readBytes(location, {
    onRead: () => {
      if (replaced) return;
      fs.renameSync(parent, retained);
      fs.mkdirSync(parent);
      fs.writeFileSync(file, bytes);
      replaced = true;
    },
  }), error => {
    assert.ok(error instanceof RegularFileReadError);
    assert.equal(error.code, "REGULAR_FILE_READ_IDENTITY");
    return true;
  });
  assert.equal(replaced, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(path.join(retained, "source.json")), bytes);
});

test("artifact capture refuses same-byte parent replacement after authority validation", t => {
  const { location, file, parent, retained, bytes, options } = fixture(t);
  const original = fs.lstatSync;
  let targetReads = 0, replaced = false;
  t.mock.method(fs, "lstatSync", function (target, ...args) {
    const result = original.call(this, target, ...args);
    if (path.resolve(target) === file && ++targetReads === 2) {
      fs.renameSync(parent, retained);
      fs.mkdirSync(parent);
      fs.writeFileSync(file, bytes);
      replaced = true;
    }
    return result;
  });
  let error;
  try {
    FlowArtifactDescriptor.fromFile(options);
  } catch (cause) {
    error = cause;
  }
  assert.equal(replaced, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(path.join(retained, "source.json")), bytes);
  const prior = original(retained, { bigint: true }), current = original(parent, { bigint: true });
  assert.notDeepEqual([current.dev, current.ino], [prior.dev, prior.ino]);
  assert.equal(error?.code, "REGULAR_FILE_READ_IDENTITY");
  assert.ok(error instanceof RegularFileReadError);
  assert.equal(error.reason, "identity");
});
