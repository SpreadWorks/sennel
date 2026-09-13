import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runSpecLocalTests } from "../../../src/flow/lib/run-test-execute.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let root;

afterEach(() => {
  if (root) removeTmpDir(root);
  root = null;
});

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("shared spec tests import repository modules from the execution worktree", async () => {
  root = createTmpDir("shared-spec-test-execution-");
  const repositoryRoot = path.join(root, "base");
  const executionRoot = path.join(root, "worktree");
  const specDir = path.join(repositoryRoot, "specs", "485-execution-root");
  for (const checkout of [repositoryRoot, executionRoot]) {
    write(path.join(checkout, "package.json"), "{\"type\":\"module\"}\n");
  }
  write(path.join(repositoryRoot, "src", "marker.js"), "export default 'base';\n");
  write(path.join(executionRoot, "src", "marker.js"), "export default 'execution';\n");
  write(path.join(executionRoot, "src", "execution-only.js"), "export default 485;\n");
  write(path.join(specDir, "tests", "execution-root.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import marker from '../../../src/marker.js';",
    "import executionOnly from '../../../src/execution-only.js';",
    "test('uses worktree source', () => {",
    "  assert.equal(marker, 'execution');",
    "  assert.equal(executionOnly, 485);",
    "});",
    "",
  ].join("\n"));

  const result = await runSpecLocalTests({
    repositoryRoot,
    executionRoot,
    specDir,
    timeoutMs: 10_000,
  });

  assert.equal(result.result.exitCode, 0, result.result.stderr || result.result.stdout);
  assert.equal(result.result.spawnError, null);
});
