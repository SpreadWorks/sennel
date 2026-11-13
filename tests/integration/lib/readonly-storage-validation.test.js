import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ReadOnlyInvocationWorkspace, ReadOnlyProcessRuntimeStorage } from "../../../src/lib/readonly-invocation-workspace.js";

function fixture(t) {
  const workspace = ReadOnlyInvocationWorkspace.create();
  t.after(() => fs.rmSync(workspace.path, { recursive: true, force: true }));
  const local = workspace.processRuntimeStorage();
  const remote = ReadOnlyProcessRuntimeStorage.fromGrant(local.toJSON());
  return { workspace, local, remote, marker: path.join(local.directory, "storage-authority.json") };
}

for (const reader of ["local", "remote"]) {
  test(`${reader} storage freshly rejects a changed marker after an earlier successful validation`, (t) => {
    const value = fixture(t), storage = value[reader];
    storage.assertStable();
    fs.writeFileSync(value.marker, "changed grant");
    assert.throws(() => storage.assertStable(), { code: "READONLY_WORKSPACE_STORAGE_AUTHORITY_INVALID" });
    assert.equal(fs.readFileSync(value.marker, "utf8"), "changed grant");
  });

  for (const timing of ["before", "during"]) test(`${reader} storage rejects workspace replacement ${timing} marker reading even when the leaf is retained`, (t) => {
    const value = fixture(t), storage = value[reader];
    storage.assertStable();
    const displaced = `${value.workspace.path}-retained`;
    t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
    const read = fs.readSync;
    let replaced = false;
    const bytes = fs.readFileSync(value.marker);
    const replace = () => {
      replaced = true;
      fs.renameSync(value.workspace.path, displaced);
      fs.mkdirSync(value.workspace.path);
      fs.renameSync(path.join(displaced, "control"), path.join(value.workspace.path, "control"));
      fs.writeFileSync(path.join(value.workspace.path, "foreign-marker"), "preserved");
    };
    if (timing === "before") replace();
    else t.mock.method(fs, "readSync", function (...args) {
      const count = Reflect.apply(read, this, args);
      if (!replaced) replace();
      return count;
    });
    assert.throws(() => storage.assertStable(), (error) => timing === "before"
      ? error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID"
      : error.code === "REGULAR_FILE_READ_IDENTITY" && error.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
    t.mock.restoreAll();
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(value.marker).equals(bytes), true);
    assert.equal(fs.readFileSync(path.join(value.workspace.path, "foreign-marker"), "utf8"), "preserved");
    assert.equal(fs.existsSync(displaced), true);
  });
}

test("local storage preserves its workspace closure refusal before further physical reads", (t) => {
  const { workspace, local, marker } = fixture(t);
  const bytes = fs.readFileSync(marker);
  local.assertStable();
  workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
  assert.throws(() => local.assertStable(), { code: "READONLY_WORKSPACE_CLOSED" });
  assert.equal(fs.readFileSync(marker).equals(bytes), true);
  workspace.cleanup({ generation: workspace.generation });
  assert.equal(fs.existsSync(workspace.path), false);
});
