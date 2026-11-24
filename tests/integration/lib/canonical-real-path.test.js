import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isCanonicalRealPath } from "../../../src/lib/canonical-real-path.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { captureRegularFile } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("native canonical observations accept exact real Unicode names and refuse linked ancestors", (t) => {
  const root = createTmpDir("canonical-real-path-");
  t.after(() => removeTmpDir(root));
  const directory = path.join(root, "空 白", "nested");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "資料.txt");
  fs.writeFileSync(file, "exact");
  assert.equal(isCanonicalRealPath(directory), true);
  assert.equal(isCanonicalRealPath(file), true);
  assert.equal(new RealDirectoryAuthority(directory).assertStable(), directory);
  assert.equal(captureRegularFile(file, { label: "source", maxBytes: 5 }).text(), "exact");
  const link = path.join(root, "alias");
  fs.symlinkSync(directory, link, "junction");
  assert.equal(isCanonicalRealPath(path.join(link, "資料.txt")), false);
  assert.throws(() => captureRegularFile(path.join(link, "資料.txt"), { label: "source", maxBytes: 5 }));
  assert.throws(() => isCanonicalRealPath(path.join(root, "absent")), { code: "ENOENT" });
});

test("native success avoids the component-walking resolver and is observed anew", (t) => {
  let nativeReads = 0;
  let ordinaryReads = 0;
  const resolver = (target) => { ordinaryReads++; return `${target}-different`; };
  resolver.native = (target) => ++nativeReads === 1 ? target : `${target}-different`;
  t.mock.method(fs, "realpathSync", resolver);
  // Mock methods intentionally have no native property unless supplied here.
  fs.realpathSync.native = resolver.native;
  assert.equal(isCanonicalRealPath("/observed"), true);
  assert.equal(isCanonicalRealPath("/observed"), false);
  assert.equal(nativeReads, 2);
  assert.equal(ordinaryReads, 1);
});

for (const result of ["unavailable", "different-spelling", "missing-api"]) {
  test(`ordinary canonical semantics remain available after native ${result}`, (t) => {
    const ordinary = [];
    const resolver = (target) => { ordinary.push(target); return target; };
    t.mock.method(fs, "realpathSync", resolver);
    if (result !== "missing-api") fs.realpathSync.native = (target) => {
      if (result === "unavailable") throw Object.assign(new Error("native prerequisites unavailable"), { code: "ENOENT" });
      return `${target}-native-spelling`;
    };
    assert.equal(isCanonicalRealPath("/observed"), true);
    assert.deepEqual(ordinary, ["/observed"]);
  });
}

test("native refusal retains the original resolver failure without caching a failed proof", (t) => {
  const failure = Object.assign(new Error("ordinary lookup denied"), { code: "EACCES" });
  let attempts = 0;
  t.mock.method(fs, "realpathSync", (target) => { if (++attempts === 1) throw failure; return target; });
  fs.realpathSync.native = () => { throw new Error("native unavailable"); };
  assert.throws(() => isCanonicalRealPath("/observed"), (error) => error === failure);
  assert.equal(isCanonicalRealPath("/observed"), true);
  assert.equal(attempts, 2);
});
