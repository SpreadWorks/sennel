import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
} from "../../../src/flow/lib/requirement-test-lifecycle.js";
import { runRequirementTestGate } from "../../../src/flow/lib/run-requirement-test-gate.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let root;

afterEach(() => {
  if (root) removeTmpDir(root);
  root = null;
});

const revision = {
  specId: "gate-engine",
  revision: 1,
  digest: "a".repeat(64),
  byteLength: 1,
};

function candidate(source) {
  const testPath = "tests/r1.test.js";
  const bytes = Buffer.from(source);
  const member = new RequirementTestCandidateSource({
    testPath,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  });
  const bundle = new RequirementTestBundleRevision({
    requirementId: "R1",
    specRevision: revision,
    revision: 1,
    paths: [testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId: "R1",
      specRevision: revision,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: "attempt-r1", sequence: 1 },
      sourceFindingFingerprints: [],
    }),
  });
  return { bundle: new RequirementTestCandidateBundle({ bundle, sources: [member] }), sourceBytes: new Map([[testPath, bytes]]) };
}

function setup(activeSource = null) {
  root = createTmpDir("requirement-test-gate-");
  const versionDirectory = path.join(root, "specs", "gate-engine", "001");
  fs.mkdirSync(versionDirectory, { recursive: true });
  if (activeSource) {
    fs.mkdirSync(path.join(versionDirectory, "tests"), { recursive: true });
    fs.writeFileSync(path.join(versionDirectory, "tests", "r1.test.js"), activeSource);
  }
  return {
    repositoryRoot: root,
    versionLocation: { resolve: (relative) => path.join(versionDirectory, ...relative.split("/")) },
  };
}

test("executes only the candidate named test and returns a bound observation", async () => {
  const context = setup();
  const source = "// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => { throw new Error('candidate'); });\n";
  const value = candidate(source);
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_failed");
  assert.equal(result.observation.requirementId, "R1");
  assert.equal(result.observation.bundleRevision, 1);
  assert.match(result.rawLog, /exitCode: 1/);
  assert.equal(fs.existsSync(path.join(root, "specs", "gate-engine", "001", ".runtime", "requirement-test-gate")), true);
});

test("returns an assertion_passed observation for a passing candidate", async () => {
  const context = setup();
  const value = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => {});\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_passed");
});

test("reports missing and multiple assigned named tests without running them", async () => {
  const context = setup();
  const missing = candidate("// spec: R1\nimport test from 'node:test';\ntest('R2: other', () => {});\n");
  const missingResult = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...missing });
  assert.equal(missingResult.observation.kind, "missing");
  const multiple = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: one', () => {});\ntest('R1: two', () => {});\n");
  const multipleResult = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...multiple });
  assert.equal(multipleResult.observation.kind, "invalid_test");
});

test("distinguishes invalid source and runner tooling failure", async () => {
  const context = setup();
  const invalid = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => {\n");
  const invalidResult = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...invalid });
  assert.equal(invalidResult.observation.kind, "invalid_test");
  const tooling = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => {});\nprocess.exitCode = 2;\n");
  const toolingResult = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...tooling });
  assert.equal(toolingResult.observation.kind, "tooling_failure");
});

test("candidate materialization is isolated from active tests", async () => {
  const context = setup("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => {});\n");
  const value = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => { throw new Error('candidate'); });\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_failed");
  assert.match(fs.readFileSync(path.join(root, "specs", "gate-engine", "001", "tests", "r1.test.js"), "utf8"), /=> \{\}\);/);
});

test("candidate relative imports resolve as if executed from the canonical promoted path", async () => {
  const context = setup();
  fs.writeFileSync(path.join(root, "value.mjs"), "export const value = 1;\n");
  const value = candidate("// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../../../../../value.mjs';\ntest('R1: behavior', () => assert.equal(value, 1));\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_passed");
});
