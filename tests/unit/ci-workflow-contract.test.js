import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("CI workflow contract", () => {
  it("runs the deterministic test command on the declared minimum and current LTS lanes", () => {
    assert.match(WORKFLOW, /name: CI/);
    assert.match(WORKFLOW, /run: node scripts\/ci-node-matrix\.js/);
    assert.match(WORKFLOW, /matrix: \$\{\{ fromJson\(needs\.prepare-node-matrix\.outputs\.matrix\) \}\}/);
    assert.match(WORKFLOW, /node-version: \$\{\{ matrix\.node-version \}\}/);
    assert.match(WORKFLOW, /run: npm test/);
    assert.match(WORKFLOW, /fail-fast: false/);
    assert.match(WORKFLOW, /GIT_AUTHOR_NAME: sennel CI/);
    assert.match(WORKFLOW, /GIT_COMMITTER_EMAIL: sennel-ci@example\.invalid/);
  });

  it("provides a stable required-check aggregator for the complete matrix", () => {
    assert.match(WORKFLOW, /^  required:\n/m);
    assert.match(WORKFLOW, /name: Required CI/);
    assert.match(WORKFLOW, /needs: \[prepare-node-matrix, test-ci\]/);
    assert.match(WORKFLOW, /if: always\(\)/);
    assert.match(WORKFLOW, /MATRIX_RESULT: \$\{\{ needs\.test-ci\.result \}\}/);
  });
});
