import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function project(t) {
  const root = createTmpDir("temporary-authority-");
  t.after(() => removeTmpDir(root));
  return root;
}

test("namespace lookup and validation are read-only, and malformed allocation does not create scratch", (t) => {
  const root = project(t);
  const paths = new TemporaryPaths(root);
  assert.equal(paths.logs(), path.join(root, ".tmp", "logs"));
  assert.equal(paths.tests(), path.join(root, ".tmp", "tests"));
  assert.equal(paths.runtime("agent"), path.join(root, ".tmp", "runtime", "agent"));
  assert.equal(paths.validate(".tmp/custom/nested"), path.join(root, ".tmp", "custom", "nested"));
  assert.equal(fs.existsSync(paths.temporaryRoot), false);
  assert.throws(() => paths.create(paths.tests(), "../outside"), { code: "PORTABLE_PATH_INVALID" });
  assert.equal(fs.existsSync(paths.temporaryRoot), false);
  assert.throws(() => paths.ensureDirectory(path.dirname(root)), { code: "TEMPORARY_PATH_OUTSIDE_PROJECT" });
  assert.equal(fs.existsSync(paths.temporaryRoot), false);
});

test("cleanup requires the minted owner and preserves replacements instead of recursively deleting them", (t) => {
  const root = project(t);
  const paths = new TemporaryPaths(root);
  const created = paths.create(paths.tests(), "owned-");
  const file = path.join(created, "binary evidence");
  const bytes = Buffer.from([0, 255, 42]);
  TemporaryPaths.writeFile(file, bytes);
  assert.throws(() => new TemporaryPaths(root).cleanup(created), { code: "TEMPORARY_DIRECTORY_NOT_OWNED" });
  assert.deepEqual(fs.readFileSync(file), bytes);
  const displaced = `${created}-displaced`;
  fs.renameSync(created, displaced);
  fs.mkdirSync(created);
  fs.writeFileSync(path.join(created, "sentinel"), "preserved");
  assert.throws(() => paths.cleanup(created), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(created, "sentinel"), "utf8"), "preserved");
  assert.deepEqual(fs.readFileSync(path.join(displaced, "binary evidence")), bytes);
  const ordinary = new TemporaryPaths(root);
  const released = ordinary.create(ordinary.operator(), "released-");
  TemporaryPaths.writeFile(path.join(released, "payload"), "done");
  ordinary.cleanup(released);
  assert.equal(fs.existsSync(released), false);
  assert.equal(fs.existsSync(created), true);
});

test("read-only namespace validation refuses an existing directory link and leaves its target unchanged", (t) => {
  const root = project(t);
  const paths = new TemporaryPaths(root);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
  fs.symlinkSync(outside, paths.temporaryRoot, "junction");
  assert.throws(() => paths.logs(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
});

for (const operation of ["validate", "ensureDirectory"]) {
  for (const replaced of ["root", "nested"]) {
    test(`pinned authority handoff refuses ${replaced} replacement before temporary ${operation}`, (t) => {
      const root = project(t);
      const paths = new TemporaryPaths(root);
      const known = paths.ensureDirectory(path.join(paths.temporaryRoot, "known"));
      const victim = replaced === "root" ? root : known;
      const displaced = `${victim}-displaced`;
      t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
      const target = path.join(known, "new-child");
      const resolve = RealDirectoryAuthority.resolve;
      let intercepted = false;
      t.mock.method(RealDirectoryAuthority, "resolve", function(directory, options) {
        if (!intercepted && directory === target && (operation === "validate" ? options.allowMissing : options.create)) {
          intercepted = true;
          fs.renameSync(victim, displaced);
          fs.mkdirSync(victim);
          fs.writeFileSync(path.join(victim, "sentinel"), "replacement");
        }
        return resolve.call(this, directory, options);
      });
      assert.throws(() => paths[operation](target), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
      assert.equal(intercepted, true);
      assert.deepEqual(fs.readdirSync(victim), ["sentinel"]);
      assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "replacement");
      assert.equal(fs.existsSync(path.join(displaced, "new-child")), false);
    });
  }
}

test("pinned authority handoff refuses replacement between temporary file validation and publication", (t) => {
  const root = project(t);
  const parent = path.join(root, "output");
  fs.mkdirSync(parent);
  const file = path.join(parent, "evidence");
  fs.writeFileSync(file, "original");
  const displaced = `${parent}-displaced`;
  const inspect = TemporaryPaths.assertRegularFile;
  t.mock.method(TemporaryPaths, "assertRegularFile", function(target) {
    inspect.call(this, target);
    fs.renameSync(parent, displaced);
    fs.mkdirSync(parent);
    fs.writeFileSync(file, "replacement");
  });
  assert.throws(() => TemporaryPaths.writeFile(file, "new"), (error) =>
    error.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" && error.committedToVisibleName === false);
  assert.deepEqual(fs.readdirSync(parent), ["evidence"]);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(displaced, "evidence"), "utf8"), "original");
});
