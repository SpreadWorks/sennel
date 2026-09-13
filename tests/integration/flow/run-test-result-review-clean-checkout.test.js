import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import { attachedCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import {
  CanonicalFlowFixture,
  makeFlowManager,
  promoteCanonicalRequirementTest,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";

const roots = [];

function root() {
  const value = createTmpDir("test-result-review-canonical-");
  roots.push(value);
  return value;
}

function testExecuteHistory(payload) {
  return Buffer.from(`${JSON.stringify({
    attempts: [{ attempt: 1, artifact: { logicalKey: "test.execute", payload } }],
  }, null, 2)}\n`, "utf8");
}

function testExecutePayload(repairFingerprint, testSourceRevision) {
  return {
    version: "2",
    repairFingerprint,
    testSourceRevision,
    rawEvidenceFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
    raw_output_path: "specs/001-test/001/artifacts/test.execute.raw-log",
    summary: [{
      id: "R1",
      result: "pass",
      evidence: {
        test_file: "specs/001-test/001/artifacts/tests/fixture.test.js",
        test_name: "R1: canonical fixture requirement",
        command: "node --test specs/001-test/001/artifacts/tests/fixture.test.js",
        raw_output_lines: { start_line: 1, end_line: 1 },
      },
    }],
    regression: {
      required: false,
      result: "skipped",
      mode: "none",
      category: "spec-artifact-only",
      reason: "canonical fixture regression not required",
      classified_paths: [],
      changed_files: [],
      trigger_relevant_changed_files: [],
    },
  };
}

function fixture() {
  const repository = root();
  const flowManager = makeFlowManager(repository);
  const flow = new CanonicalFlowFixture({
    flowManager,
    specId: "001-test",
    runId: "run-test-result-review-clean-checkout",
    specRecord: {
      requirements: [{
        id: "R1", desc: "Preserve the canonical completion contract.", priority: "must",
        task_ids: ["T1"], preimplementation_test_expectation: "fail",
      }],
    },
  }).create().addTask({
    id: "T1", title: "Fixture Task", goal: "Preserve the completion contract.",
    origin: "plan", added_round: 0, status: "pending",
  }).registerActive().activate("approval");
  flow.settle("approval");
  promoteCanonicalRequirementTest({
    flowManager,
    specId: flow.specId,
    requirementId: "R1",
    testPath: "fixture.test.js",
    source: [
      "// spec: R1",
      "import test from 'node:test';",
      "test('R1: canonical fixture requirement', () => { throw new Error('expected before implementation'); });",
      "",
    ].join("\n"),
  });
  flow.activate("test-execute");
  const repairFingerprint = buildRepairFingerprint({
    root: repository,
    artifactRoot: repository,
    specPath: flow.location().relativeSpecFile,
  }).hash;
  const testSourceRevision = new CanonicalTestArtifactStore({
    flowManager,
    state: flow.state(),
  }).testSourceRevision().digest;
  flowManager.publishArtifacts({
    specId: flow.specId,
    nodeId: "test-execute",
    artifactWrites: [
      {
        logicalKey: "test.execute",
        mediaType: "application/json",
        bytes: testExecuteHistory(testExecutePayload(repairFingerprint, testSourceRevision)),
      },
    ],
  });
  flow.settle("test-execute").activate("test-result-review");
  return { repository, flowManager, flow };
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

test("test-result review trusts cataloged structured evidence when the transient execution log is absent", async () => {
  const value = fixture();
  const result = await new RunTestResultReviewCommand().execute({
    root: value.repository,
    executionRoot: value.repository,
    flowState: value.flow.state(),
    flowManager: value.flowManager,
  });

  const publication = attachedCanonicalCommandResultArtifact(result);
  assert.equal(result.result, "ok", JSON.stringify(publication?.payload));
  assert.equal(result.artifacts.verdict, "pass");
  assert.equal(publication.logicalKey, "test.result.review");
  assert.equal(publication.payload.verdict, "pass");
  assert.equal(publication.payload.checked_items.every((entry) => entry.result === "pass"), true);
  assert.equal(publication.payload.raw_output_path.includes("test-execute"), true);
});

test("cataloged scenario and execution evidence remain complete without transient raw log bytes", () => {
  const value = fixture();
  const execution = value.flowManager.readArtifact({
    specId: value.flow.specId,
    logicalKey: "test.execute",
    consumerNodeId: "test-result-review",
  });
  assert.ok(execution);
  assert.equal(value.flowManager.readArtifact({
    specId: value.flow.specId,
    logicalKey: "test.execute.raw-log",
    consumerNodeId: "test-result-review",
    optional: true,
  }), null);
  const history = JSON.parse(execution.bytes.toString("utf8"));
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].artifact.payload.summary[0].result, "pass");
});
