import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repositoryRoot, "scripts/ci-node-matrix.js");
const packageManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("CI matrix command writes its engines-derived matrix to the GitHub output file", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-ci-node-matrix-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const output = path.join(temporaryRoot, "github-output");

  const execution = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });

  assert.equal(execution.error, undefined);
  assert.equal(execution.signal, null);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "");
  const result = fs.readFileSync(output, "utf8");
  assert.match(packageManifest.engines.node, /^>=\d+\.\d+\.\d+$/);
  assert.equal(result,
    `matrix={"include":[{"lane":"minimum","node-version":"${packageManifest.engines.node.slice(2)}"},{"lane":"current-lts","node-version":"lts/*"}]}\n`);
});
