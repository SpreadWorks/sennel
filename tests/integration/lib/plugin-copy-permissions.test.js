import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { copyPluginRuntimeDirectory, installPlugin } from "../../../src/lib/plugin-registry.js";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";

function permissionFiles(source) {
  fs.mkdirSync(source, { recursive: true });
  const files = [
    ["executable", `#!${process.execPath}\nprocess.stdout.write("plugin executable\\n");\n`, 0o751],
    ["data", "plugin data\n", 0o640],
    ["read-only", "plugin read only\n", 0o444],
  ];
  // copyFile preserves these native POSIX bits too; Windows has no equivalent.
  if (process.platform !== "win32") {
    for (const mode of [0o1750, 0o3750, 0o4750, 0o6750]) files.push([`special-${mode.toString(8)}`, "permission metadata\n", mode]);
  }
  return files.map(([name, bytes, mode]) => {
    const file = path.join(source, name);
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, mode);
    // Native copy is the prior public behavior, including kernel-cleared setid.
    const reference = path.join(source, ".native-copy-reference");
    fs.copyFileSync(file, reference);
    const copiedMode = fs.statSync(reference).mode & 0o7777;
    fs.unlinkSync(reference);
    return { name, bytes, mode: fs.statSync(file).mode & 0o7777, copiedMode };
  });
}

function assertPermissionFiles(source, destination, files) {
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(destination, file.name), "utf8"), file.bytes);
    assert.equal(fs.statSync(path.join(destination, file.name)).mode & 0o7777, file.copiedMode, file.name);
    assert.equal(fs.statSync(path.join(source, file.name)).mode & 0o7777, file.mode, "source mode unchanged");
    assert.equal(fs.readFileSync(path.join(source, file.name), "utf8"), file.bytes);
  }
  const executable = path.join(destination, "executable");
  const result = process.platform === "win32"
    ? spawnSync(process.execPath, [executable], { encoding: "utf8" })
    : spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "plugin executable\n");
}

test("runtime copy preserves source permissions and executable behavior despite restrictive umask", (t) => {
  const root = createTmpDir("plugin-runtime-permissions-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const files = permissionFiles(source);
  const mask = process.umask(0o077);
  try { copyPluginRuntimeDirectory(source, destination); }
  finally { process.umask(mask); }
  assertPermissionFiles(source, destination, files);
});

test("plugin install preserves source permissions through staging and visible publication", (t) => {
  const root = createTmpDir("plugin-install-permissions-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source");
  const files = permissionFiles(path.join(source, "lib"));
  writeJson(source, "plugin.json", { name: "permission-plugin", type: "mixed", files: ["plugin.json", "lib/"], contributions: {} });
  writeJson(root, ".sennel/config.json", { plugin: { sources: [{ id: "permission-source", type: "local", path: source }], packages: [] } });
  const mask = process.umask(0o077);
  let installed;
  try { installed = installPlugin(root, "permission-plugin"); }
  finally { process.umask(mask); }
  assert.equal(installed.id, "permission-plugin");
  const destination = path.join(root, ".sennel/plugins/permission-plugin/lib");
  assertPermissionFiles(path.join(source, "lib"), destination, files);
  assert.deepEqual(fs.readdirSync(path.join(root, ".sennel/plugins")), ["permission-plugin"]);
});

test("worktree preparation preserves installed plugin permissions for the executable consumer", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
  scenario.installPreparePlugin();
  const source = path.join(scenario.root, ".sennel/plugins/prepare-observer/hooks/permission-files");
  const files = permissionFiles(source);
  await scenario.initialize();
  const mask = process.umask(0o077);
  let prepared;
  try { prepared = await scenario.prepare(); }
  finally { process.umask(mask); }
  assert.equal(prepared.result, "ok");
  const destination = path.join(scenario.executionRoot, ".sennel/plugins/prepare-observer/hooks/permission-files");
  assertPermissionFiles(source, destination, files);
});
