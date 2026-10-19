import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { copyPluginRuntimeDirectory } from "../../../src/lib/plugin-registry.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("plugin-runtime-copy-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "old"), "existing destination");
  return { source, destination };
}

test("plugin runtime copy retains binary bytes and empty directories", (t) => {
  const { source, destination } = fixture(t);
  const bytes = Buffer.from([0, 255, 10, 128]);
  const opaque = Buffer.alloc(1024 * 1024 + 1, 0xff);
  fs.mkdirSync(path.join(source, "空 directory"));
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "space name.bin"), bytes);
  fs.writeFileSync(path.join(source, "node_modules", "opaque.json"), opaque);
  copyPluginRuntimeDirectory(source, destination);
  assert.deepEqual(fs.readFileSync(path.join(destination, "space name.bin")), bytes);
  assert.deepEqual(fs.readdirSync(path.join(destination, "空 directory")), []);
  assert.deepEqual(fs.readFileSync(path.join(destination, "node_modules", "opaque.json")), opaque);
  assert.deepEqual(fs.readdirSync(destination).sort(), ["node_modules", "space name.bin", "空 directory"]);
});

test("plugin runtime copy refuses its complete file count before replacing the destination", (t) => {
  const { source, destination } = fixture(t);
  fs.writeFileSync(path.join(source, "one"), "one");
  fs.writeFileSync(path.join(source, "two"), "two");
  assert.throws(() => copyPluginRuntimeDirectory(source, destination, { maxFiles: 1 }), /copied file count exceeds 1/);
  assert.equal(fs.readFileSync(path.join(destination, "old"), "utf8"), "existing destination");
  assert.deepEqual(fs.readdirSync(destination), ["old"]);
});

test("plugin runtime copy refuses a source junction before replacing the destination", (t) => {
  const { source, destination } = fixture(t);
  fs.symlinkSync(destination, path.join(source, "link"), "junction");
  assert.throws(() => copyPluginRuntimeDirectory(source, destination), /symlink not allowed/);
  assert.equal(fs.readFileSync(path.join(destination, "old"), "utf8"), "existing destination");
  assert.deepEqual(fs.readdirSync(destination), ["old"]);
});

test("plugin runtime copy refuses a source parent replaced after enumeration without reading foreign bytes", (t) => {
  const { source, destination } = fixture(t);
  const parent = path.join(source, "lib");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "entry"), "original source");
  const remove = fs.rmSync;
  const open = fs.openSync;
  let replaced = false;
  let foreignReads = 0;
  fs.rmSync = (target, ...args) => {
    if (target === destination && !replaced) {
      replaced = true;
      fs.renameSync(parent, path.join(source, "retained-lib"));
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, "entry"), "foreign source");
    }
    return remove(target, ...args);
  };
  fs.openSync = (target, flags, ...args) => {
    if (replaced && target === path.join(parent, "entry") && flags === "r") foreignReads++;
    return open(target, flags, ...args);
  };
  try {
    assert.throws(() => copyPluginRuntimeDirectory(source, destination),
      (error) => error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
  } finally { fs.rmSync = remove; fs.openSync = open; }
  assert.equal(replaced, true);
  assert.equal(foreignReads, 0);
  assert.equal(fs.readFileSync(path.join(parent, "entry"), "utf8"), "foreign source");
  assert.equal(fs.readFileSync(path.join(source, "retained-lib", "entry"), "utf8"), "original source");
  assert.equal(fs.existsSync(path.join(destination, "lib", "entry")), false);
});

test("plugin runtime copy retains the ensured destination parent before writing", (t) => {
  const { source, destination } = fixture(t);
  fs.mkdirSync(path.join(source, "lib"));
  fs.writeFileSync(path.join(source, "lib", "entry"), "source bytes");
  const targetParent = path.join(destination, "lib");
  const resolve = RealDirectoryAuthority.resolve;
  let replaced = false;
  RealDirectoryAuthority.resolve = function (directory, options) {
    const authority = resolve.call(this, directory, options);
    if (directory === targetParent && options?.create && !replaced) {
      replaced = true;
      fs.renameSync(targetParent, path.join(destination, "retained-lib"));
      fs.mkdirSync(targetParent);
      fs.writeFileSync(path.join(targetParent, "sentinel"), "foreign destination");
    }
    return authority;
  };
  try {
    assert.throws(() => copyPluginRuntimeDirectory(source, destination),
      (error) => error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID"
        || error.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
  } finally { RealDirectoryAuthority.resolve = resolve; }
  assert.equal(replaced, true);
  assert.deepEqual(fs.readdirSync(targetParent), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(targetParent, "sentinel"), "utf8"), "foreign destination");
  assert.equal(fs.readFileSync(path.join(source, "lib", "entry"), "utf8"), "source bytes");
});
