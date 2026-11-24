import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowArtifactCatalog, FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const parent = createTmpDir("version-authority-");
  t.after(() => removeTmpDir(parent));
  const root = path.join(parent, "repository");
  fs.mkdirSync(root);
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "authority", version: 1 });
  return { parent, root, location };
}

test("a retained Version location refuses a replaced repository before returning filesystem authority", (t) => {
  const { parent, root, location } = fixture(t);
  fs.renameSync(root, path.join(parent, "original-repository"));
  fs.mkdirSync(root);
  const sentinel = path.join(root, "foreign.txt");
  fs.writeFileSync(sentinel, "foreign repository\n");
  assert.throws(() => location.assertAuthority(), /identity changed/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "foreign repository\n");
  assert.deepEqual(fs.readdirSync(root), ["foreign.txt"]);
});

test("managed enumeration refuses a replaced nested directory before inspecting its foreign files", (t) => {
  const { parent, location } = fixture(t);
  const directory = location.resolve("artifacts/migration");
  const file = path.join(directory, "original.json");
  const backup = path.join(parent, "original-directory");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, "original bytes\n");
  const readdir = fs.readdirSync;
  const lstat = fs.lstatSync;
  let replaced = false;
  let foreignInspections = 0;
  fs.readdirSync = function (value, ...args) {
    const entries = readdir.call(this, value, ...args);
    if (!replaced && path.resolve(String(value)) === directory) {
      fs.renameSync(directory, backup);
      fs.mkdirSync(directory);
      fs.writeFileSync(file, "foreign bytes\n");
      replaced = true;
    }
    return entries;
  };
  fs.lstatSync = function (value, ...args) {
    if (replaced && path.resolve(String(value)) === file) foreignInspections += 1;
    return lstat.call(this, value, ...args);
  };
  try {
    assert.throws(() => FlowArtifactCatalog.managedFiles(location), /identity changed/);
    assert.equal(replaced, true);
    assert.equal(foreignInspections, 0);
  } finally {
    fs.readdirSync = readdir;
    fs.lstatSync = lstat;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "foreign bytes\n");
  assert.equal(fs.readFileSync(path.join(backup, "original.json"), "utf8"), "original bytes\n");
});
