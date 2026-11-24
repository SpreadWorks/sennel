import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RealDirectoryAuthority, RealDirectoryOperationError } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("directory-readback-");
  t.after(() => removeTmpDir(root));
  const source = RealDirectoryAuthority.createExclusive(path.join(root, "source"));
  return { root, source, destination: path.join(root, "destination") };
}

function replace(directory) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign owner\n");
}

function assertForeign(directory) {
  assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign owner\n");
}

function authorityRefusal(operation, target, nativeCode = null) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof RealDirectoryOperationError);
    assert.equal(error.committedToVisibleName, true);
    assert.equal(error.publicationUnknown, true);
    assert.equal(error.code, "REAL_DIRECTORY_OPERATION_PUBLICATION_UNCERTAIN");
    assert.equal(RealDirectoryAuthority.isAuthorityFailure(error), true);
    assert.equal(error.cause.code, "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
    assert.equal(error.cause.lockPath, target);
    if (nativeCode !== null) assert.equal(error.cause.cause.code, nativeCode);
    return true;
  });
}

for (const recursive of [false, true]) {
  test(`directory ${recursive ? "recursive" : "empty"} removal propagates a recreated name as an authority refusal`, (t) => {
    const { source } = fixture(t);
    if (recursive) fs.writeFileSync(path.join(source.directory, "owned.txt"), "owned bytes\n");
    const method = recursive ? "rmSync" : "rmdirSync";
    const remove = fs[method];
    let replaced = false;
    t.mock.method(fs, method, function (target, ...args) {
      const result = remove.call(this, target, ...args);
      if (!replaced && path.resolve(target) === source.directory) {
        replace(source.directory);
        replaced = true;
      }
      return result;
    });
    authorityRefusal(() => source.remove({ recursive }), source.directory);
    assert.equal(replaced, true);
    assertForeign(source.directory);
  });
}

for (const changed of ["source", "destination"]) {
  test(`directory move propagates a replaced ${changed} readback as an authority refusal`, (t) => {
    const { root, source, destination } = fixture(t);
    fs.writeFileSync(path.join(source.directory, "owned.txt"), "owned bytes\n");
    const backup = path.join(root, "displaced");
    const rename = fs.renameSync;
    let replaced = false;
    t.mock.method(fs, "renameSync", function (from, to) {
      const result = rename.call(this, from, to);
      if (!replaced && from === source.directory && to === destination) {
        if (changed === "destination") rename.call(this, destination, backup);
        replace(changed === "source" ? source.directory : destination);
        replaced = true;
      }
      return result;
    });
    authorityRefusal(() => source.moveTo(destination), changed === "source" ? source.directory : destination);
    assert.equal(replaced, true);
    assertForeign(changed === "source" ? source.directory : destination);
    assert.equal(fs.readFileSync(path.join(changed === "source" ? destination : backup, "owned.txt"), "utf8"), "owned bytes\n");
  });
}

for (const operation of ["remove", "move"]) {
  test(`unavailable source readback after directory ${operation} preserves a typed authority refusal`, (t) => {
    const { source, destination } = fixture(t);
    const mutate = operation === "remove" ? fs.rmdirSync : fs.renameSync;
    const stat = fs.lstatSync;
    let mutated = false;
    t.mock.method(fs, operation === "remove" ? "rmdirSync" : "renameSync", function (...args) {
      const result = mutate.apply(this, args);
      if (args[0] === source.directory) mutated = true;
      return result;
    });
    t.mock.method(fs, "lstatSync", function (target, ...args) {
      if (mutated && target === source.directory) throw Object.assign(new Error("readback unavailable"), { code: "EIO" });
      return stat.call(this, target, ...args);
    });
    authorityRefusal(() => operation === "remove" ? source.remove() : source.moveTo(destination), source.directory, "EIO");
    assert.equal(mutated, true);
    assert.equal(fs.existsSync(source.directory), false);
    if (operation === "move") assert.deepEqual(fs.readdirSync(destination), []);
  });
}
