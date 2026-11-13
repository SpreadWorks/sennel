import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

const CLI = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));

function project(t, managedName) {
  const root = createTmpDir("migration-bootstrap-");
  t.after(() => removeTmpDir(root));
  const managed = path.join(root, managedName);
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(managed, "config.json"), JSON.stringify({
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    logs: { enabled: true },
  }) + "\n");
  fs.writeFileSync(path.join(managed, "evidence.bin"), Buffer.from([0, 255, 13, 10]));
  return root;
}

function invoke(root, args = []) {
  return spawnSync(process.execPath, [CLI, "migrate", "layout", "--to", "1", ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, SENNEL_SOURCE_ROOT: root, SENNEL_WORK_ROOT: root },
  });
}

function tree(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      const relative = path.relative(root, entry);
      if (stat.isDirectory()) { result.push([relative, "directory"]); visit(entry); }
      else result.push([relative, "file", fs.readFileSync(entry).toString("base64")]);
    }
  }
  visit(root);
  return result;
}

test("applies layout migration from a legacy-only root without bootstrap manufacturing a canonical no-op", (t) => {
  const root = project(t, ".senti");
  const result = invoke(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, ".senti")), false, "a successful apply must move the actual legacy source");
  assert.deepEqual(fs.readFileSync(path.join(root, ".sennel", "evidence.bin")), Buffer.from([0, 255, 13, 10]));
});

test("layout planning with logging enabled leaves the entire legacy project unchanged", (t) => {
  const root = project(t, ".senti");
  const before = tree(root);
  const result = invoke(root, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tree(root), before);
});

test("an existing canonical no-op neither creates runtime storage nor rewrites project metadata", (t) => {
  const root = project(t, ".sennel");
  const before = tree(root);
  const result = invoke(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tree(root), before);
});
