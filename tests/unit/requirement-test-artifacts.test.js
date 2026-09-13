import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestDeferredReceipt,
  RequirementTestGateObservation,
  RequirementTestPlanArtifact,
  RequirementTestReviewSource,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestPlan,
} from "../../src/flow/lib/requirement-test-lifecycle.js";

const specRevision = {
  specId: "requirement-artifacts",
  revision: 2,
  digest: "a".repeat(64),
  byteLength: 512,
};

function candidate() {
  const source = RequirementTestCandidateSource.fromBytes({
    testPath: "tests/r1.test.js",
    bytes: Buffer.from("// spec: R1\ntest('R1: behavior', () => {});\n"),
  });
  const bundle = new RequirementTestBundleRevision({
    requirementId: "R1",
    specRevision,
    revision: 1,
    paths: [source.testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId: "R1",
      specRevision: specRevision,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: "attempt-r1", sequence: 1 },
      sourceFindingFingerprints: [],
    }),
  });
  return new RequirementTestCandidateBundle({ bundle, sources: [source] });
}

describe("Requirement test canonical artifacts", () => {
  it("binds candidate metadata to the exact staged source bytes", () => {
    const value = candidate();
    assert.deepEqual(RequirementTestCandidateBundle.fromJSON(JSON.parse(JSON.stringify(value))).toJSON(), value.toJSON());
    assert.throws(() => RequirementTestCandidateBundle.fromJSON({
      ...value.toJSON(), digest: "b".repeat(64),
    }), /digest does not match/);
    assert.throws(() => new RequirementTestCandidateBundle({
      bundle: value.bundle,
      sources: [new RequirementTestCandidateSource({
        testPath: "tests/other.test.js", digest: "b".repeat(64), byteLength: 1,
      })],
    }), /exactly match/);
  });

  it("binds Gate observations to R, Spec, bundle, candidate, named test, and producer Attempt", () => {
    const value = new RequirementTestGateObservation({
      requirementId: "R1",
      specRevision,
      bundleRevision: 1,
      candidateDigest: candidate().digest,
      testName: "R1: behavior",
      kind: "assertion_failed",
      sourceAttempt: { id: "attempt-r1", sequence: 1 },
    });
    assert.deepEqual(RequirementTestGateObservation.fromJSON(JSON.parse(JSON.stringify(value))).toJSON(), value.toJSON());
    assert.throws(() => new RequirementTestGateObservation({ ...value.toJSON(), kind: "expected_fail" }), /kind is invalid/);
  });

  it("binds review input to one exact Requirement candidate and source Attempt", () => {
    const bundle = candidate();
    const value = new RequirementTestReviewSource({
      runId: "run-review",
      requirementId: "R1",
      specRevision,
      bundleRevision: 1,
      candidateDigest: bundle.digest,
      sourceAttempt: bundle.bundle.lineage.sourceAttempt,
      candidatePaths: bundle.bundle.paths,
    });
    assert.deepEqual(RequirementTestReviewSource.fromJSON(JSON.parse(JSON.stringify(value))).toJSON(), value.toJSON());
    assert.throws(() => RequirementTestReviewSource.fromJSON({
      ...value.toJSON(), candidateDigest: "stale",
    }), /SHA-256/);
    assert.throws(() => RequirementTestReviewSource.fromJSON({
      ...value.toJSON(), candidatePaths: ["tests/../escape.test.js"],
    }), /canonical path/);
  });

  it("persists an exact deferred acceptance handoff", () => {
    const value = new RequirementTestDeferredReceipt({
      requirementId: "R1",
      specRevision,
      bundleRevision: 1,
      candidateDigest: candidate().digest,
      expectation: "fail",
      budget: { autoSemantic: 5, manualSemantic: 5, tooling: 3 },
      sourceAttempt: { id: "attempt-r1", sequence: 1 },
      sourceArtifact: "steps/test-review/requirements/R1/revision-1.json",
      sourceFindingFingerprints: ["c".repeat(64)],
    });
    assert.deepEqual(RequirementTestDeferredReceipt.fromJSON(JSON.parse(JSON.stringify(value))).toJSON(), value.toJSON());
    assert.throws(() => new RequirementTestDeferredReceipt({
      ...value.toJSON(), sourceArtifact: "artifacts/tests/r1.test.js",
    }), /canonical Requirement test evidence/);
    const preCandidate = new RequirementTestDeferredReceipt({
      ...value.toJSON(),
      bundleRevision: null,
      candidateDigest: null,
      sourceArtifact: "steps/test-generate/failures/R1.json",
    });
    assert.equal(preCandidate.bundleRevision, null);
    assert.equal(preCandidate.candidateDigest, null);
  });

  it("round-trips a canonical plan artifact without adding another state shape", () => {
    const plan = RequirementTestPlan.fromApprovedSpec({
      specRevision,
      spec: {
        goal: "Test the requirement.",
        scope: { in: [], out: [] },
        constraints: [], design_principles: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        background: "",
        requirements: [{
          id: "R1", desc: "Behavior.", task_ids: ["T1"], preimplementation_test_expectation: "fail",
        }],
        acceptance_criteria: [], clarifications: [], alternatives_considered: [], open_questions: [],
        tasks: [{ id: "T1", title: "One", goal: "One", origin: "plan", added_round: 0, status: "pending" }],
      },
    });
    const artifact = new RequirementTestPlanArtifact({ plan });
    assert.deepEqual(RequirementTestPlanArtifact.fromJSON(JSON.parse(artifact.toBytes())).toJSON(), artifact.toJSON());
  });
});
