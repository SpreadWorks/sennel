import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLOW_ARTIFACT_CONTRACTS,
  FLOW_ARTIFACT_SWITCH_TARGETS,
} from "../../../src/lib/flow-artifact-contract.js";
import {
  FLOW_ARTIFACT_AUTHORITY_MATRIX,
  WORKER_ARTIFACT_HANDOFF_STEPS,
} from "../../../src/flow/lib/flow-artifact-authority.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestDeferredReceipt,
  RequirementTestPlanArtifact,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestPlan,
} from "../../../src/flow/lib/requirement-test-lifecycle.js";

const SPEC_REVISION = Object.freeze({
  specId: "requirement-artifact-contract",
  revision: 3,
  digest: "a".repeat(64),
  byteLength: 512,
});

function approvedSpec() {
  return {
    goal: "Exercise Requirement test artifacts.",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    background: "",
    requirements: [{
      id: "R1",
      desc: "One testable behavior.",
      task_ids: ["T1"],
      preimplementation_test_expectation: "fail",
    }],
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    tasks: [{ id: "T1", title: "One", goal: "One", origin: "plan", added_round: 0, status: "pending" }],
  };
}

function candidate() {
  const bytes = Buffer.from("// spec: R1\ntest('R1: behavior', () => {});\n", "utf8");
  const source = RequirementTestCandidateSource.fromBytes({ testPath: "tests/r1.test.js", bytes });
  const bundle = new RequirementTestBundleRevision({
    requirementId: "R1",
    specRevision: SPEC_REVISION,
    revision: 1,
    paths: [source.testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId: "R1",
      specRevision: SPEC_REVISION,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: "generate-r1-1", sequence: 1 },
      sourceFindingFingerprints: [],
    }),
  });
  return { bytes, bundle: new RequirementTestCandidateBundle({ bundle, sources: [source] }) };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

describe("Requirement test artifact authority", () => {
  it("declares the fixed lifecycle topology and worker handoff leaves", () => {
    const entries = new Map(FLOW_ARTIFACT_AUTHORITY_MATRIX.map((entry) => [entry.stepId, entry]));
    assert.deepEqual(
      ["approval", "test-generate", "test-review", "test-repair", "test-gate"].map((stepId) => {
        const entry = entries.get(stepId);
        return [stepId, entry.producer, entry.consumer, entry.workerHandoff];
      }),
      [
        ["approval", "user", "test-generate", false],
        ["test-generate", "worker", "test-review", true],
      ["test-review", "cli", "test-review, test-repair, or test-gate", false],
        ["test-repair", "worker", "test-gate", true],
        ["test-gate", "cli", "test-gate, test-repair, next Requirement test-generate, or implement", false],
      ],
    );
    assert.deepEqual(
      WORKER_ARTIFACT_HANDOFF_STEPS.filter((stepId) => stepId.startsWith("test")),
      ["test-generate", "test-repair"],
    );
    assert.equal(entries.has("test"), false);
    assert.equal(entries.has("scenario-validity"), false);
  });

  it("assigns canonical paths, owners, histories, and active-source promotion", () => {
    const expectedPaths = new Map([
      ["test.requirement.plan", "steps/test-generate/plan.json"],
      ["test.requirement.candidate.bundle", "artifacts/test-candidates/:{requirementId}/revision-:{bundleRevision}/bundle.json"],
      ["test.requirement.candidate.source", "artifacts/test-candidates/:{requirementId}/revision-:{bundleRevision}/sources/:{testPath}"],
      ["test.requirement.review", "steps/test-review/result.json"],
      ["test.requirement.repair.progress", "steps/test-repair/progress/:{requirementId}.json"],
      ["test.requirement.gate", "steps/test-gate/result.json"],
      ["test.requirement.deferred", "steps/test-gate/deferred/:{requirementId}.json"],
      ["test.requirement.gate.raw-log", "steps/test-gate/output.log"],
    ]);
    for (const [logicalKey, canonicalPath] of expectedPaths) {
      assert.equal(FLOW_ARTIFACT_CONTRACTS.require(logicalKey).canonicalPath.toString(), canonicalPath, logicalKey);
    }

    const plan = FLOW_ARTIFACT_CONTRACTS.require("test.requirement.plan");
    assert.deepEqual(plan.ownership.producers, ["approval"]);
    assert.deepEqual(plan.ownership.updaters, ["approval", "test-generate", "test-review", "test-repair", "test-gate"]);
    assert.equal(plan.authoritySlot.publicationStep, "approval");
    assert.notEqual(FLOW_ARTIFACT_CONTRACTS.require("test.requirement.review").contentContract, null);
    assert.notEqual(FLOW_ARTIFACT_CONTRACTS.require("test.requirement.gate").contentContract, null);
    const repairProgress = FLOW_ARTIFACT_CONTRACTS.require("test.requirement.repair.progress");
    assert.deepEqual(repairProgress.ownership.producers, ["test-repair"]);
    assert.deepEqual(repairProgress.ownership.updaters, ["test-repair"]);
    assert.deepEqual(repairProgress.ownership.consumers, ["test-repair"]);
    assert.equal(repairProgress.authoritySlot.cardinality.toString(), "collection");
    assert.equal(repairProgress.mutationPolicy.toString(), "replaceable");

    for (const logicalKey of [
      "test.requirement.candidate.bundle", "test.requirement.candidate.source", "test.requirement.deferred",
    ]) {
      const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
      assert.equal(contract.authoritySlot.cardinality.toString(), "collection", logicalKey);
      assert.equal(contract.mutationPolicy.toString(), "immutable", logicalKey);
    }

    const active = FLOW_ARTIFACT_CONTRACTS.require("tests.source");
    assert.deepEqual(active.ownership.producers, ["test-gate"]);
    assert.deepEqual(active.ownership.updaters, ["test-gate"]);
    assert.equal(active.authoritySlot.publicationStep, "test-gate");
    for (const retired of ["scenario.validity", "test.review", "test.review.repair.progress", "test.bootstrap.observation"]) {
      assert.throws(() => FLOW_ARTIFACT_CONTRACTS.require(retired), /unknown artifact logical key/, retired);
    }
  });

  it("resolves candidate members independently from active test source", () => {
    assert.equal(
      FLOW_ARTIFACT_CONTRACTS.resolve("test.requirement.candidate.bundle", {
        requirementId: "R1", bundleRevision: "1",
      }).relativePath,
      "artifacts/test-candidates/R1/revision-1/bundle.json",
    );
    assert.equal(
      FLOW_ARTIFACT_CONTRACTS.resolve("test.requirement.candidate.source", {
        requirementId: "R1", bundleRevision: "1", testPath: "tests/r1.test.js",
      }).relativePath,
      "artifacts/test-candidates/R1/revision-1/sources/tests/r1.test.js",
    );
    assert.equal(
      FLOW_ARTIFACT_CONTRACTS.resolve("tests.source", { testPath: "r1.test.js" }).relativePath,
      "artifacts/tests/r1.test.js",
    );
    const firstProgress = FLOW_ARTIFACT_CONTRACTS.resolve("test.requirement.repair.progress", { requirementId: "R1" });
    const secondProgress = FLOW_ARTIFACT_CONTRACTS.resolve("test.requirement.repair.progress", { requirementId: "R2" });
    assert.equal(firstProgress.relativePath, "steps/test-repair/progress/R1.json");
    assert.notEqual(firstProgress.authoritySlot().memberId, secondProgress.authoritySlot().memberId);
  });

  it("classifies new canonical artifacts and retires the all-Requirement artifacts", () => {
    const targets = new Map(FLOW_ARTIFACT_SWITCH_TARGETS.map((target) => [target.logicalKey, target]));
    for (const logicalKey of [
      "test.requirement.plan", "test.requirement.candidate.bundle", "test.requirement.candidate.source",
      "test.requirement.review", "test.requirement.repair.progress", "test.requirement.gate", "test.requirement.deferred", "test.requirement.gate.raw-log",
    ]) assert.equal(targets.get(logicalKey).action, "new", logicalKey);
    assert.deepEqual(
      targets.get("legacy.scenario.validity").legacyPaths.map(String),
      ["scenario-validity-result.json", "tests/.raw/scenario-validity.log"],
    );
    assert.deepEqual(
      targets.get("legacy.test.review").legacyPaths.map(String),
      ["test-review.json", "test-coverage.json"],
    );
  });
});

describe("Requirement test artifact content contracts", () => {
  it("parses a typed plan and rejects identity or counter regression without selecting transitions", () => {
    const planContract = FLOW_ARTIFACT_CONTRACTS.require("test.requirement.plan");
    const initial = new RequirementTestPlanArtifact({
      plan: RequirementTestPlan.fromApprovedSpec({ spec: approvedSpec(), specRevision: SPEC_REVISION }),
    }).toJSON();
    const progressed = structuredClone(initial);
    progressed.plan.workItems[0].status = "in_progress";
    progressed.plan.workItems[0].budget.autoSemantic = 1;

    const parsed = planContract.assertContentPublication(null, jsonBytes(initial));
    assert.ok(parsed instanceof RequirementTestPlanArtifact);
    assert.doesNotThrow(() => planContract.assertContentPublication(jsonBytes(initial), jsonBytes(progressed)));

    const changedIdentity = structuredClone(progressed);
    changedIdentity.plan.workItems[0].requirementId = "R2";
    assert.throws(
      () => planContract.assertContentPublication(jsonBytes(progressed), jsonBytes(changedIdentity)),
      /identity cannot change/,
    );
    const regressed = structuredClone(progressed);
    regressed.plan.workItems[0].budget.autoSemantic = 0;
    assert.throws(
      () => planContract.assertContentPublication(jsonBytes(progressed), jsonBytes(regressed)),
      /counters cannot decrease/,
    );
  });

  it("validates typed candidate/deferred bytes and makes their members immutable", () => {
    const value = candidate();
    const bundleContract = FLOW_ARTIFACT_CONTRACTS.require("test.requirement.candidate.bundle");
    const parsedBundle = bundleContract.assertContentPublication(null, jsonBytes(value.bundle.toJSON()));
    assert.ok(parsedBundle instanceof RequirementTestCandidateBundle);
    const invalidBundle = { ...value.bundle.toJSON(), digest: "b".repeat(64) };
    assert.throws(() => bundleContract.assertContentPublication(null, jsonBytes(invalidBundle)), /digest does not match/);

    const receipt = new RequirementTestDeferredReceipt({
      requirementId: "R1",
      specRevision: SPEC_REVISION,
      bundleRevision: 1,
      candidateDigest: value.bundle.digest,
      expectation: "fail",
      budget: { autoSemantic: 5, manualSemantic: 5, tooling: 3 },
      sourceAttempt: { id: "review-r1-1", sequence: 1 },
      sourceArtifact: "steps/test-review/requirements/R1/revision-1.json",
      sourceFindingFingerprints: ["c".repeat(64)],
    });
    const deferredContract = FLOW_ARTIFACT_CONTRACTS.require("test.requirement.deferred");
    const parsedReceipt = deferredContract.assertContentPublication(null, jsonBytes(receipt.toJSON()));
    assert.ok(parsedReceipt instanceof RequirementTestDeferredReceipt);

    for (const contract of [bundleContract, deferredContract, FLOW_ARTIFACT_CONTRACTS.require("test.requirement.candidate.source")]) {
      assert.doesNotThrow(() => contract.mutationPolicy.assertPublication(
        { hash: "a", size: value.bytes.length },
        { hash: "a", size: value.bytes.length },
      ));
      assert.throws(() => contract.mutationPolicy.assertPublication(
        { hash: "a", size: value.bytes.length },
        { hash: "b", size: value.bytes.length },
      ), /cannot replace existing bytes/);
    }
  });

  it("keeps Requirement review and gate results as append-only Attempt histories", () => {
    const first = jsonBytes({ attempts: [{ attempt: 1, requirementId: "R1", result: "pass" }] });
    const second = jsonBytes({ attempts: [
      { attempt: 1, requirementId: "R1", result: "pass" },
      { attempt: 2, requirementId: "R2", result: "block" },
    ] });
    for (const logicalKey of ["test.requirement.review", "test.requirement.gate"]) {
      const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
      assert.doesNotThrow(() => contract.assertContentPublication(null, first), logicalKey);
      assert.doesNotThrow(() => contract.assertContentPublication(first, second), logicalKey);
      assert.throws(() => contract.assertContentPublication(second, first), /append-only/, logicalKey);
    }
  });
});
