import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

for (const entry of ["run-retro.js", "test-artifacts.js", "run-report-show.js"]) {
  test(`Acceptance entry ${entry} initializes its shared artifact contracts in a fresh process`, (t) => {
    const root = createTmpDir("sennel-acceptance-import-");
    t.after(() => removeTmpDir(root));
    const source = new URL(`../../../src/flow/lib/${entry}`, import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(source)}); process.stdout.write('initialized');`], {
      cwd: root, encoding: "utf8", env: { ...process.env, SENNEL_SOURCE_ROOT: root, SENNEL_WORK_ROOT: root },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "initialized");
  });
}
