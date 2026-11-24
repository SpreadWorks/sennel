import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SourceWorkingFileCapture } from "../../../src/flow/lib/source-working-file-capture.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";

it("rejects a replaced ancestor while observing a directory or missing Source path", async (t) => {
  for (const kind of ["directory", "missing"]) {
    await t.test(kind, () => {
      const root = createTmpDir("source-directory-parent-race-");
      t.after(() => removeTmpDir(root));
      const parent = path.join(root, "source");
      const retained = path.join(root, "original-source");
      const replacement = path.join(root, "replacement");
      const target = path.join(parent, "child");
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(replacement);
      if (kind === "directory") fs.mkdirSync(path.join(replacement, "child"));
      const before = fs.statSync(parent, { bigint: true });
      const originalLstat = fs.lstatSync;
      let replaced = false;
      fs.lstatSync = function (file, ...options) {
        if (file === target && !replaced) {
          replaced = true;
          fs.renameSync(parent, retained);
          fs.renameSync(replacement, parent);
        }
        return Reflect.apply(originalLstat, this, [file, ...options]);
      };
      try {
        assert.throws(() => SourceWorkingFileCapture.capture(root, "source/child", { maxBytes: 32 }),
          (error) => RealDirectoryAuthority.isAuthorityFailure(error)
            && error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" && error.lockPath === parent);
      } finally {
        fs.lstatSync = originalLstat;
      }
      assert.equal(replaced, true);
      const preserved = fs.statSync(retained, { bigint: true });
      assert.deepEqual({ dev: preserved.dev, ino: preserved.ino }, { dev: before.dev, ino: before.ino });
      assert.equal(fs.statSync(path.join(retained, "child")).isDirectory(), true);
    });
  }
});

it("proves a regular ancestor before treating its former descendants as missing", (t) => {
  const root = createTmpDir("source-file-blocker-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "source"), "regular blocker");
  const capture = SourceWorkingFileCapture.capture(root, "source/nested/child.js", { maxBytes: 32 });
  assert.deepEqual(capture.working.toJSON(), { kind: "missing", digest: null, generation: null });
  assert.equal(capture.snapshot, null);
  assert.throws(() => SourceWorkingFileCapture.capture(root, "source/child.js", { maxBytes: 32, requireExisting: true }), /inventory entry disappeared/);
  assert.throws(() => SourceWorkingFileCapture.capture(root, "source/child.js", { maxBytes: 1 }), { code: "REGULAR_FILE_READ_LIMIT" });
  assert.equal(fs.readFileSync(path.join(root, "source"), "utf8"), "regular blocker");
});

it("refuses a symlink ancestor instead of using it to certify a missing child", (t) => {
  const root = createTmpDir("source-link-blocker-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "external"));
  fs.writeFileSync(path.join(root, "external", "child.js"), "external bytes");
  fs.symlinkSync(path.join(root, "external"), path.join(root, "source"), "junction");
  assert.throws(() => SourceWorkingFileCapture.capture(root, "source/child.js", { maxBytes: 32 }), /unsupported native type/);
  assert.equal(fs.readFileSync(path.join(root, "external", "child.js"), "utf8"), "external bytes");
});

it("refuses a hard-linked ancestor instead of treating an unproved blocker as absence", (t) => {
  const root = createTmpDir("source-hardlink-blocker-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "source"), "linked blocker");
  fs.linkSync(path.join(root, "source"), path.join(root, "alias"));
  assert.throws(() => SourceWorkingFileCapture.capture(root, "source/child.js", { maxBytes: 32 }), { name: "RegularFileLinkCountError" });
  assert.equal(fs.readFileSync(path.join(root, "alias"), "utf8"), "linked blocker");
});
