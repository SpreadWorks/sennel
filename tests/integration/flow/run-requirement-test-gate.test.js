import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestSupportArtifact,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
} from "../../../src/flow/lib/requirement-test-lifecycle.js";
import { runRequirementTestGate } from "../../../src/flow/lib/run-requirement-test-gate.js";
import { flowTemporaryRoot } from "../../../src/flow/lib/flow-context.js";
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

function candidate(source, support = []) {
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
  return {
    bundle: new RequirementTestCandidateBundle({ bundle, sources: [member], support }),
    sourceBytes: new Map([[testPath, bytes]]),
  };
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
  const source = "// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('R1: behavior', () => assert.equal('before', 'required'));\n";
  const value = candidate(source);
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_failed");
  assert.equal(result.observation.requirementId, "R1");
  assert.equal(result.observation.bundleRevision, 1);
  assert.match(result.rawLog, /exitCode: 1/);
  assert.deepEqual(fs.readdirSync(path.join(root, ".tmp", "runtime", "requirement-test-gate")), []);
  assert.equal(fs.existsSync(context.versionLocation.resolve(".runtime/requirement-test-gate")), false);
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
  const value = candidate("// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('R1: behavior', () => assert.equal('before', 'required'));\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_failed");
  assert.match(fs.readFileSync(path.join(root, "specs", "gate-engine", "001", "tests", "r1.test.js"), "utf8"), /=> \{\}\);/);
});

test("a named ReferenceError is invalid test evidence, not an expected failure", async () => {
  const context = setup();
  const value = candidate("// spec: R1\nimport test from 'node:test';\ntest('R1: behavior', () => missingFixture());\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "invalid_test");
});

test("candidate relative imports resolve as if executed from the canonical promoted path", async () => {
  const context = setup();
  fs.writeFileSync(path.join(root, "value.mjs"), "export const value = 1;\n");
  const value = candidate("// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../../../../../value.mjs';\ntest('R1: behavior', () => assert.equal(value, 1));\n");
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_passed");
});

test("materializes owner-bound shared support before running the candidate test", async () => {
  const context = setup();
  const helper = Buffer.from("export const value = 1;\n");
  const support = RequirementTestSupportArtifact.fromBytes({
    ownerRequirementId: "R1",
    supportPath: "tests/support/helper.mjs",
    bytes: helper,
  });
  const value = candidate(
    "// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './support/helper.mjs';\ntest('R1: behavior', () => assert.equal(value, 1));\n",
    [support],
  );
  value.sourceBytes.set(support.supportPath, helper);
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "assertion_passed");
});

test("records an invalid_test observation when any materialized candidate import cannot bootstrap", async () => {
  const context = setup();
  const value = candidate(
    "// spec: R1\nimport test from 'node:test';\nimport './support/missing.mjs';\ntest('R1: behavior', () => {});\n",
  );
  const result = await runRequirementTestGate({ ...context, specRevision: revision, requirementId: "R1", ...value });
  assert.equal(result.observation.kind, "invalid_test");
  assert.equal(result.observation.requirementId, "R1");
  assert.equal(result.observation.candidateDigest, value.bundle.digest);
  assert.equal(result.command, null);
  assert.equal(result.process, null);
  assert.match(result.rawLog, /statically imports missing pre-implementation module \.\/support\/missing\.mjs/);
});

test("selected Flow scratch preserves runner checkout, canonical import mapping and exact candidate bytes", async () => {
  setup();
  const checkout = path.join(root, "checkout");
  const versionDirectory = path.join(root, "specs", "gate-engine", "001");
  fs.mkdirSync(checkout);
  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(path.join(checkout, "value.mjs"), "export const value = 'checkout';\n");
  fs.writeFileSync(path.join(root, "value.mjs"), "export const value = 'canonical';\n");
  const temporaryRoot = flowTemporaryRoot({ root: checkout, repositoryRoot: root,
    specId: "gate-engine", flowState: { specId: "gate-engine", runId: "selected-gate-run" } });
  const source = `// spec: R1
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { value } from '../../../../../value.mjs';
test('R1: behavior', () => {
  assert.equal(process.cwd(), ${JSON.stringify(checkout)});
  assert.equal(value, 'checkout');
  assert.equal(fs.readFileSync(new URL(import.meta.url), 'utf8'), process.env.EXPECTED_GATE_SOURCE);
  console.log('GATE_CANDIDATE=' + import.meta.url);
});
`;
  const value = candidate(source);
  const original = process.env.EXPECTED_GATE_SOURCE;
  process.env.EXPECTED_GATE_SOURCE = source;
  let result;
  try {
    result = await runRequirementTestGate({ repositoryRoot: checkout, temporaryRepositoryRoot: root, temporaryRoot,
      versionLocation: { resolve: (relative) => path.join(versionDirectory, ...relative.split("/")) },
      specRevision: revision, requirementId: "R1", ...value });
  } finally {
    if (original === undefined) delete process.env.EXPECTED_GATE_SOURCE;
    else process.env.EXPECTED_GATE_SOURCE = original;
  }
  assert.equal(result.observation.kind, "assertion_passed", result.rawLog);
  assert.equal(result.observation.candidateDigest, value.bundle.digest);
  const materializedFile = /^# GATE_CANDIDATE=(.+)$/m.exec(result.rawLog)?.[1];
  assert.ok(materializedFile);
  const candidatePath = fileURLToPath(materializedFile);
  assert.equal(path.dirname(path.dirname(path.dirname(candidatePath))), temporaryRoot);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  assert.equal(fs.existsSync(path.join(checkout, ".tmp")), false);
  assert.equal(fs.existsSync(path.join(versionDirectory, ".runtime", "requirement-test-gate")), false);
});
