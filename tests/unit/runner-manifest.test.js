import assert from "node:assert/strict";
import { test } from "node:test";
import { TestSuiteManifest } from "../runner/manifest.js";

test("runner manifest rejects duplicate and unclassified tests", () => {
  assert.throws(() => new TestSuiteManifest({ root: "/repo", files: ["tests/unit/a.test.js", "tests/unit/a.test.js"] }), /duplicate/);
  assert.throws(() => new TestSuiteManifest({ root: "/repo", files: ["tests/support/a.test.js"] }), /exactly one suite/);
  assert.throws(() => new TestSuiteManifest({ root: "/repo", files: ["tests/misc/tests/unit/a.test.js"] }), /exactly one suite/);
});

test("runner manifest assigns only declared roots and enforces unit boundaries", () => {
  const valid = new TestSuiteManifest({ root: "/repo", files: ["tests/unit/a.test.js", "tests/integration/b.test.js", "tests/structure/draft.test.js"], readSource: () => "" });
  assert.deepEqual(valid.suiteFiles("unit"), ["tests/unit/a.test.js"]);
  assert.deepEqual(valid.suiteFiles("structure"), ["tests/structure/draft.test.js"]);
  for (const source of ["import x from 'node:child_process'", "import x from 'child_process'", "import x from '../support/infrastructure/git-repo.js'", "import x from '../support/infrastructure/flow-setup.js'"]) {
    assert.throws(() => new TestSuiteManifest({ root: "/repo", files: ["tests/unit/a.test.js"], readSource: () => source }), /unit boundary violation/);
  }
});
