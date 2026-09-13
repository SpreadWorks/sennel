import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { CanonicalReviewWorkUnit } from "../../src/flow/lib/canonical-review-artifacts.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestPlanArtifact,
  RequirementTestSupportArtifact,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestPlan,
  RequirementTestWorkItem,
} from "../../src/flow/lib/requirement-test-lifecycle.js";

const roots = [];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-review-"));
  roots.push(root);
  const specRevision = { specId: "review-r", revision: 1, digest: "a".repeat(64), byteLength: 100 };
  const bytes = Buffer.from("// spec: R6\nimport test from 'node:test';\ntest('R6: behavior', () => {});\n");
  const source = RequirementTestCandidateSource.fromBytes({ testPath: "tests/r6.test.js", bytes });
  const supportBytes = Buffer.from("export const helper = true;\n");
  const support = RequirementTestSupportArtifact.fromBytes({
    ownerRequirementId: "R6", supportPath: "tests/support/helper.mjs", bytes: supportBytes,
  });
  const bundleRevision = new RequirementTestBundleRevision({
    requirementId: "R6", specRevision, revision: 1, paths: [source.testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId: "R6", specRevision, bundleRevision: 1, predecessorRevision: null,
      sourceAttempt: { id: "generate-r6", sequence: 1 }, sourceFindingFingerprints: [],
    }),
  });
  const candidate = new RequirementTestCandidateBundle({ bundle: bundleRevision, sources: [source], support: [support] });
  const plan = new RequirementTestPlan({
    specRevision,
    workItems: [new RequirementTestWorkItem({
      requirementId: "R6", specRevision, expectation: "fail", status: "candidate_saved",
      bundleRevision, budget: { autoSemantic: 0, manualSemantic: 0, tooling: 0 },
    })],
  });
  const planBytes = new RequirementTestPlanArtifact({ plan }).toBytes();
  const bundleBytes = Buffer.from(`${JSON.stringify(candidate.toJSON())}\n`);
  const descriptor = (logicalKey, value) => ({ logicalKey, mediaType: "application/json", hash: sha(value), size: value.length });
  const reads = [];
  const state = {
    schemaRevision: 3, runId: "run-review-r", specId: "review-r",
    attempt: { id: "review-r6", nodeId: "test-review", sequence: 2 },
  };
  const flowManager = {
    canonicalState() { return state; },
    activityLedger() { return []; },
    artifactCatalog() { throw new Error("active artifact catalog must not be consulted for Requirement review"); },
    readArtifact({ logicalKey }) {
      reads.push(logicalKey);
      if (logicalKey === "test.requirement.plan") return { bytes: planBytes, descriptor: descriptor(logicalKey, planBytes) };
      if (logicalKey === "test.requirement.candidate.bundle") return { bytes: bundleBytes, descriptor: descriptor(logicalKey, bundleBytes) };
      if (logicalKey === "test.requirement.candidate.source") return { bytes, descriptor: { ...descriptor(logicalKey, bytes), mediaType: "text/javascript" } };
      if (logicalKey === "test.requirement.support") return {
        bytes: supportBytes,
        descriptor: { ...descriptor(logicalKey, supportBytes), mediaType: "text/javascript" },
      };
      if (logicalKey === "test.requirement.gate") return null;
      throw new Error(`unexpected artifact read: ${logicalKey}`);
    },
    specLocation() {
      return { repositoryRoot: root, resolve: (...parts) => path.join(root, ".canonical", ...parts) };
    },
  };
  return { root, state, flowManager, reads, candidate, bytes, supportBytes };
}

describe("Requirement test review connection", () => {
  it("materializes only the active candidate and never reads active tests.source", () => {
    const value = fixture();
    const workUnit = new CanonicalReviewWorkUnit({
      flowManager: value.flowManager,
      state: value.state,
      phase: "test",
      executionRoot: value.root,
      treeSha: "b".repeat(40),
      targetStateDigest: "c".repeat(64),
    });
    workUnit.prepare();
    const materialized = workUnit.materializeTestSources(workUnit.workUnit.directory);
    assert.deepEqual(value.reads, [
      "test.requirement.plan", "test.requirement.candidate.bundle", "test.requirement.candidate.source", "test.requirement.support", "test.requirement.gate",
    ]);
    assert.equal(value.reads.includes("tests.source"), false);
    assert.equal(fs.readFileSync(path.join(materialized.directory, "tests/r6.test.js"), "utf8"), value.bytes.toString("utf8"));
    assert.equal(fs.readFileSync(path.join(materialized.directory, "tests/support/helper.mjs"), "utf8"), value.supportBytes.toString("utf8"));
    assert.equal(materialized.revision.requirementId, "R6");
    assert.equal(materialized.revision.candidateDigest, value.candidate.digest);
    assert.deepEqual(materialized.revision.sourceAttempt, { id: "generate-r6", sequence: 1 });
    assert.equal(workUnit.workUnit.manifest().inputs.some((input) => input.logicalKey === "tests.source"), false);
    workUnit.workUnit.cleanup();
  });
});
