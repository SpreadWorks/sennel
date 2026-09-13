import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RequirementTestLifecycleFacts,
  RequirementTestStepObservation,
  resolveRequirementTestLifecycle,
} from "../../src/flow/definition.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestGateObservation,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBudget,
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestLifecycleAuthority,
  RequirementTestPlan,
  RequirementTestWorkItem,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import { SpecRevisionIdentity } from "../../src/flow/lib/spec-review-artifacts.js";

function specRevision(revision = 2) {
  return new SpecRevisionIdentity({
    specId: "requirement-test-policy", revision, digest: "a".repeat(64), byteLength: 200,
  });
}

function bundle(requirementId = "R1", revision = 1, sourceRevision = specRevision()) {
  return new RequirementTestBundleRevision({
    requirementId,
    specRevision: sourceRevision,
    revision,
    paths: [`tests/${requirementId.toLowerCase()}.test.js`],
    lineage: new RequirementTestBundleLineage({
      requirementId,
      specRevision: sourceRevision,
      bundleRevision: revision,
      predecessorRevision: revision === 1 ? null : revision - 1,
      sourceAttempt: { id: `attempt-${requirementId}-${revision}`, sequence: revision },
      sourceFindingFingerprints: revision === 1 ? [] : ["b".repeat(64)],
    }),
  });
}

function workItem({
  requirementId = "R1",
  expectation = "fail",
  status = "reviewed",
  budget = new RequirementTestBudget(),
  sourceRevision = specRevision(),
} = {}) {
  return new RequirementTestWorkItem({
    requirementId,
    specRevision: sourceRevision,
    expectation,
    status,
    bundleRevision: status === "pending" || status === "in_progress"
      ? null
      : bundle(requirementId, 1, sourceRevision),
    budget,
  });
}

function plan(workItems, sourceRevision = workItems[0].specRevision) {
  return new RequirementTestPlan({ specRevision: sourceRevision, workItems });
}

function authority(leaf) {
  return new RequirementTestLifecycleAuthority({
    runId: "run-requirement-test-policy",
    specId: "requirement-test-policy",
    leaf,
    attempt: { id: `attempt-${leaf}`, sequence: 1 },
    planPublication: {
      logicalKey: "test.requirement.plan",
      relativePath: "steps/test-generate/plan.json",
      hash: "c".repeat(64),
      size: 100,
      activityId: "requirement-test-plan-published",
    },
  });
}

function candidateBundle(item, revision = item.bundleRevision?.revision ?? 1) {
  const source = RequirementTestCandidateSource.fromBytes({
    testPath: `tests/${item.requirementId.toLowerCase()}.test.js`,
    bytes: Buffer.from(`// spec: ${item.requirementId}\n`),
  });
  return new RequirementTestCandidateBundle({
    bundle: bundle(item.requirementId, revision, item.specRevision),
    sources: [source],
  });
}

function stepObservation(item, kind, overrides = {}) {
  const currentCandidate = item.bundleRevision === null ? null : candidateBundle(item);
  return new RequirementTestStepObservation({
    requirementId: item.requirementId,
    specRevision: item.specRevision,
    bundleRevision: item.bundleRevision?.revision ?? null,
    candidateDigest: currentCandidate?.digest ?? null,
    sourceAttempt: currentCandidate?.bundle.lineage.sourceAttempt ?? null,
    semanticFindingFingerprint: kind === "semantic_rejection" ? "e".repeat(64) : null,
    kind,
    ...overrides,
  });
}

function gateObservation(item, candidate, kind, overrides = {}) {
  return new RequirementTestGateObservation({
    requirementId: item.requirementId,
    specRevision: item.specRevision,
    bundleRevision: item.bundleRevision.revision,
    candidateDigest: candidate.digest,
    testName: `${item.requirementId}: behavior`,
    kind,
    sourceAttempt: candidate.bundle.lineage.sourceAttempt,
    ...overrides,
  });
}

function resolve({ leaf, item, workItems = [item], observation, candidateBundle: candidate = null, autoApprove = false }) {
  const selectedAuthority = observation instanceof RequirementTestCandidateBundle
    ? new RequirementTestLifecycleAuthority({
        ...authority(leaf).toJSON(),
        attempt: observation.bundle.lineage.sourceAttempt,
        autoApprove,
      })
    : new RequirementTestLifecycleAuthority({ ...authority(leaf).toJSON(), autoApprove });
  return resolveRequirementTestLifecycle(new RequirementTestLifecycleFacts({
    authority: selectedAuthority,
    plan: plan(workItems), leaf, observation, candidateBundle: candidate,
  }));
}

describe("Definition-owned Requirement test lifecycle policy", () => {
  it("stages each non-final candidate while retaining the generate frontier", () => {
    const first = workItem({ requirementId: "R1", status: "in_progress" });
    const second = workItem({ requirementId: "R2", status: "pending" });
    const decision = resolve({
      leaf: "test-generate", item: first, workItems: [first, second], observation: candidateBundle(first),
    });
    assert.equal(decision.continuesSourceAttempt, true);
    assert.equal(decision.target, "test-generate");
    assert.equal(decision.nextRequirementId, "R2");
    const advanced = decision.apply(plan([first, second]));
    assert.equal(advanced.workItem("R1").status, "candidate_saved");
    assert.equal(advanced.activeWorkItem().requirementId, "R2");
  });

  it("skips repair atomically after an accepted review and uses repair only for a changed candidate", () => {
    const generating = workItem({ status: "in_progress" });
    const generated = candidateBundle(generating);
    assert.equal(resolve({
      leaf: "test-generate", item: generating, observation: generated,
    }).target, "test-review");

    const candidate = workItem({ status: "candidate_saved" });
    const currentCandidate = candidateBundle(candidate);

    for (const kind of ["review_pass", "review_advisory"]) {
      const decision = resolve({
        leaf: "test-review", item: candidate, observation: stepObservation(candidate, kind),
        candidateBundle: currentCandidate,
      });
      assert.equal(decision.target, "test-gate");
      assert.equal(decision.repairRequired, false);
      assert.equal(decision.nextStatus, "reviewed");
    }

    const reviewed = workItem();
    const repairedCandidate = candidateBundle(reviewed, 2);
    const repaired = resolve({ leaf: "test-repair", item: reviewed, observation: repairedCandidate });
    assert.equal(repaired.target, "test-review");
    assert.equal(repaired.nextStatus, "candidate_saved");
    assert.deepEqual(repaired.candidateBundle.toJSON(), repairedCandidate.toJSON());
  });

  it("promotes only an assertion observation compatible with the exact expectation", () => {
    const expectedFail = workItem({ expectation: "fail" });
    const failCandidate = candidateBundle(expectedFail);
    const promoted = resolve({
      leaf: "test-gate", item: expectedFail,
      observation: gateObservation(expectedFail, failCandidate, "assertion_failed"), candidateBundle: failCandidate,
    });
    assert.equal(promoted.disposition, "promote");
    assert.equal(promoted.target, "implement");

    const expectedPass = workItem({ expectation: "pass" });
    const passCandidate = candidateBundle(expectedPass);
    assert.equal(resolve({
      leaf: "test-gate", item: expectedPass,
      observation: gateObservation(expectedPass, passCandidate, "assertion_passed"), candidateBundle: passCandidate,
    }).disposition, "promote");

    const mismatch = resolve({
      leaf: "test-gate", item: expectedFail,
      observation: gateObservation(expectedFail, failCandidate, "assertion_passed"), candidateBundle: failCandidate,
    });
    assert.deepEqual([mismatch.disposition, mismatch.target, mismatch.budgetIncrement, mismatch.repairRequired], [
      "advance", "test-review", null, null,
    ]);
  });

  it("uses only the selected automatic or manual semantic retry budget", () => {
    const cases = [
      [true, new RequirementTestBudget({ autoSemantic: 4, manualSemantic: 5, tooling: 0 }), "semantic_retry", "autoSemantic"],
      [false, new RequirementTestBudget({ autoSemantic: 5, manualSemantic: 4, tooling: 0 }), "semantic_retry", "manualSemantic"],
      [true, new RequirementTestBudget({ autoSemantic: 5, manualSemantic: 0, tooling: 0 }), "defer", null],
      [false, new RequirementTestBudget({ autoSemantic: 0, manualSemantic: 5, tooling: 0 }), "defer", null],
    ];
    for (const [autoApprove, budget, disposition, increment] of cases) {
      const item = workItem({ status: "candidate_saved", budget });
      const candidate = candidateBundle(item);
      const decision = resolve({
        leaf: "test-review", item, observation: stepObservation(item, "semantic_rejection"),
        candidateBundle: candidate, autoApprove,
      });
      assert.equal(decision.disposition, disposition);
      assert.equal(decision.budgetIncrement, increment);
      assert.equal(decision.acceptanceHandoff, disposition === "defer");
    }
  });

  it("counts a canonical rejected finding once for one Requirement candidate revision", () => {
    const item = workItem({ status: "candidate_saved" });
    const candidate = candidateBundle(item);
    const first = resolve({
      leaf: "test-review", item,
      observation: stepObservation(item, "semantic_rejection"), candidateBundle: candidate,
    });
    assert.equal(first.budgetIncrement, "manualSemantic");
    const alreadyCounted = item.withState({ semanticFindings: [first.semanticFinding] });
    const duplicate = resolve({
      leaf: "test-review", item: alreadyCounted,
      observation: stepObservation(alreadyCounted, "semantic_rejection"), candidateBundle: candidateBundle(alreadyCounted),
    });
    assert.equal(duplicate.budgetIncrement, null);
    assert.equal(duplicate.apply(plan([alreadyCounted])).workItem("R1").budget.manualSemantic, 0);
  });

  it("retries the same leaf through tooling count 2 and defers at count 3 before a candidate exists", () => {
    const retrying = workItem({
      status: "in_progress", budget: new RequirementTestBudget({ autoSemantic: 0, manualSemantic: 0, tooling: 2 }),
    });
    const retry = resolve({
      leaf: "test-generate", item: retrying, observation: stepObservation(retrying, "tooling_failure"),
    });
    assert.deepEqual([retry.disposition, retry.target, retry.budgetIncrement], [
      "tooling_retry", "test-generate", "tooling",
    ]);
    assert.equal(retrying.budget.tooling, 2);

    const exhausted = workItem({
      status: "in_progress", budget: new RequirementTestBudget({ autoSemantic: 0, manualSemantic: 0, tooling: 3 }),
    });
    const deferred = resolve({
      leaf: "test-generate", item: exhausted, observation: stepObservation(exhausted, "tooling_failure"),
    });
    assert.equal(deferred.disposition, "defer");
    assert.equal(deferred.nextStatus, "deferred");
    assert.equal(deferred.acceptanceHandoff, true);
  });

  it("selects the next pending Requirement after mixed promoted and deferred completion", () => {
    const promoted = workItem({ requirementId: "R1", status: "promoted" });
    const current = workItem({ requirementId: "R2" });
    const deferred = workItem({ requirementId: "R3", status: "deferred" });
    const pending = workItem({ requirementId: "R4", status: "pending" });
    const decision = resolve({
      leaf: "test-gate",
      item: current,
      workItems: [promoted, current, deferred, pending],
      observation: gateObservation(current, candidateBundle(current), "assertion_failed"),
      candidateBundle: candidateBundle(current),
    });
    assert.equal(decision.target, "test-generate");
    assert.equal(decision.nextRequirementId, "R4");
  });

  it("reviews an already staged next Requirement before claiming any new generator work", () => {
    const current = workItem({ requirementId: "R1" });
    const staged = workItem({ requirementId: "R2", status: "candidate_saved" });
    const candidate = candidateBundle(current);
    const decision = resolve({
      leaf: "test-gate", item: current, workItems: [current, staged],
      observation: gateObservation(current, candidate, "assertion_failed"), candidateBundle: candidate,
    });
    assert.equal(decision.target, "test-review");
    assert.equal(decision.nextRequirementId, null);
    assert.equal(decision.apply(plan([current, staged])).activeWorkItem().requirementId, "R2");
  });

  it("fails closed for wrong Requirement, Spec, bundle, observation type, and status", () => {
    const item = workItem();
    const canonicalPlan = plan([item]);
    const currentCandidate = candidateBundle(item);
    for (const observation of [
      gateObservation(item, currentCandidate, "assertion_failed", { requirementId: "R2" }),
      gateObservation(item, currentCandidate, "assertion_failed", { specRevision: specRevision(3) }),
      gateObservation(item, currentCandidate, "assertion_failed", { bundleRevision: 2 }),
    ]) {
      assert.throws(() => new RequirementTestLifecycleFacts({
        authority: authority("test-gate"),
        plan: canonicalPlan, leaf: "test-gate", observation, candidateBundle: currentCandidate,
      }), /stale Requirement or Spec identity|stale bundle revision/);
    }
    assert.throws(() => new RequirementTestLifecycleFacts({
      authority: authority("test-gate"),
      plan: canonicalPlan,
      leaf: "test-gate",
      observation: gateObservation(item, currentCandidate, "assertion_failed", { candidateDigest: "d".repeat(64) }),
      candidateBundle: currentCandidate,
    }), /not bound to current candidate lineage/);
    assert.throws(() => new RequirementTestLifecycleFacts({
      authority: authority("test-gate"),
      plan: canonicalPlan,
      leaf: "test-gate",
      observation: gateObservation(item, currentCandidate, "assertion_failed", {
        sourceAttempt: { id: "other-attempt", sequence: 1 },
      }),
      candidateBundle: currentCandidate,
    }), /not bound to current candidate lineage/);
    assert.throws(() => new RequirementTestLifecycleFacts({
      authority: authority("test-gate"),
      plan: canonicalPlan, leaf: "test-gate", observation: stepObservation(item, "tooling_failure"),
    }), /observation type does not match/);

    const candidate = workItem({ status: "candidate_saved" });
    assert.throws(() => new RequirementTestLifecycleFacts({
      authority: authority("test-gate"),
      plan: plan([candidate]), leaf: "test-gate",
      observation: gateObservation(candidate, candidateBundle(candidate), "assertion_failed"),
      candidateBundle: candidateBundle(candidate),
    }), /leaf, observation, and status do not match/);

    const generating = workItem({ status: "in_progress" });
    assert.throws(() => new RequirementTestLifecycleFacts({
      authority: authority("test-generate"),
      plan: plan([generating]),
      leaf: "test-generate",
      observation: candidateBundle(generating),
    }), /candidate lineage does not match its active producer Attempt/);
  });
});
