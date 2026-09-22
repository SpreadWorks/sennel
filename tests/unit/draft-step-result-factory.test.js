import assert from "node:assert/strict";
import test from "node:test";

import { DraftReviewArtifactDocument } from "../../src/flow/lib/draft-review-artifacts.js";
import { DraftRepairResultFacts } from "../../src/flow/lib/worker-artifact-handoff.js";
import { DraftWorkerCompletionFacts } from "../../src/flow/services/draft-service.js";
import { draftResult } from "../../src/flow/steps/draft/draft.js";
import { draftQuestionsTriageResult } from "../../src/flow/steps/draft/draft-questions-triage.js";
import { draftCoverageTriageResult } from "../../src/flow/steps/draft/draft-coverage-triage.js";
import { draftGateResult } from "../../src/flow/steps/draft/draft-gate.js";
import { draftQuestionsReviewResult } from "../../src/flow/steps/draft/draft-questions-review.js";
import { draftCoverageReviewResult } from "../../src/flow/steps/draft/draft-coverage-review.js";
import { draftQuestionsRepairResult } from "../../src/flow/steps/draft/draft-questions-repair.js";
import { draftCoverageRepairResult } from "../../src/flow/steps/draft/draft-coverage-repair.js";
import { draftGateRepairResult } from "../../src/flow/steps/draft/draft-gate-repair.js";
import { PlanGateRepairObservation, PlanGateRepairRecord } from "../../src/flow/lib/plan-gate-repair.js";
import {
  ArtifactGateRepairLineage,
  ArtifactGateRepairObservationResult,
  GateEvidenceIdentity,
  GateObservationRepair,
  GateRepairObservationRequest,
  GateRepairReport,
  PlanGateRepairOutcomeDraft,
} from "../../src/flow/lib/gate-observation-convergence.js";
import {
  DraftCreatedResult,
  DraftQuestionsTriageCompletedResult,
  DraftCoverageTriageCompletedResult,
  DraftGatePassedResult,
  DraftGateCarryForwardResult,
  DraftGateRepairRequiredResult,
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftGateRepairAppliedResult,
  DraftGateRepairCarryForwardResult,
  DraftGateRepairWorkerRequiredResult,
  StepErrorResult,
} from "../../src/flow/engine/step-result.js";
import { DraftGateProspectiveFacts } from "../../src/flow/lib/draft-gate-prospective.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function planGateRepairFacts(disposition = null, { phase = "draft" } = {}) {
  const route = phase === "draft"
    ? {
      resultLogicalKey: "draft.gate",
      sourceGateStepId: "draft-gate",
      targetStepId: "draft-gate-repair",
      resetStepIds: ["draft-gate-repair", "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"],
    }
    : {
      resultLogicalKey: "spec.gate",
      sourceGateStepId: "spec-gate",
      targetStepId: "spec",
      resetStepIds: ["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate"],
    };
  const sourceAttempt = { id: "gate-attempt", sequence: 1 };
  const evidenceIdentity = new GateEvidenceIdentity({
    sourceAttempt,
    resultLogicalKey: route.resultLogicalKey,
    publicationActivityId: "gate-publication",
    catalogFingerprint: DIGEST_A,
    transitionLineage: {
      sourceAttempt,
      canonicalAttempt: sourceAttempt,
      sourceFingerprint: DIGEST_A,
      canonicalFingerprint: DIGEST_A,
      sourceRevisionFingerprint: DIGEST_B,
      canonicalRevisionFingerprint: DIGEST_B,
    },
  });
  const observation = new PlanGateRepairObservation({
    kind: "violation",
    failureMode: "missing-invariant",
    requirementRef: "R-1",
    where: { file: "draft.json", locator: "goal" },
    observed: "The invariant is absent.",
    severity: "blocking",
    refs: ["R-1"],
    phase,
    scope: "flow",
    taskId: null,
  });
  const request = new GateRepairObservationRequest({ fingerprint: observation.fingerprint });
  const record = new PlanGateRepairRecord({
    version: 2,
    runId: "run-result-factory",
    specId: "001-result-factory",
    issue: 1,
    phase,
    evidenceIdentity,
    connector: {
      phase,
      sourceGateStepId: route.sourceGateStepId,
      sourceAttempt,
      resultLogicalKey: route.resultLogicalKey,
      resultArtifactId: `steps/${route.sourceGateStepId}/result.json`,
      catalogFingerprint: DIGEST_A,
      targetStepId: route.targetStepId,
      resetStepIds: route.resetStepIds,
      taskLifecycle: null,
    },
    sourceIssueLogId: "draft-gate-issue",
    sourceEntryDigest: DIGEST_C,
    observations: [observation],
    observationFingerprints: [observation.fingerprint.toString()],
    observationRequests: [request],
    requestedAt: "2026-09-20T00:00:00.000Z",
  });
  if (disposition === null) return record;
  const repair = new GateObservationRepair({
    repairId: record.idempotencyKey,
    sourceEvidence: evidenceIdentity,
    targetAttempt: { id: "repair-attempt", sequence: 2 },
    publicationActivityId: "repair-publication",
    recordFingerprint: record.fingerprint,
    handoffRevision: DIGEST_B,
    requests: [request],
  });
  const changed = disposition === "applied";
  const deltaIds = changed ? [DIGEST_C] : [];
  return new PlanGateRepairOutcomeDraft({
    repair,
    disposition,
    report: new GateRepairReport({
      beforeEvidenceDigest: DIGEST_A,
      outputEvidenceDigest: changed ? DIGEST_B : DIGEST_A,
      summary: changed ? "Applied the repair." : "No canonical change.",
      requests: [request],
      results: [new ArtifactGateRepairObservationResult({
        fingerprint: observation.fingerprint,
        strategy: "clarify the invariant",
        summary: changed ? "Updated the draft." : "The draft was already equivalent.",
        deltaIds,
      })],
      lineage: new ArtifactGateRepairLineage({ deltaIds }),
    }),
  });
}

function reviewFacts(phase, findings = false) {
  return new DraftReviewArtifactDocument({
    phase,
    sourceDraft: "draft.json",
    sourceDraftRevision: {
      version: 1,
      runId: "run-result-factory",
      specId: "001-result-factory",
      sourceStepId: "draft",
      digest: "a".repeat(64),
      byteLength: 100,
      finalizedAt: "2026-09-20T00:00:00.000Z",
    },
    generatedAt: "2026-09-20T00:01:00.000Z",
    ...(findings ? {
      blockingFindings: [{
        title: "Missing decision",
        target: "decisionMap",
        rationale: "The decision is required.",
        evidence: "No decision was recorded.",
      }],
    } : {}),
  });
}

test("worker-only Draft Result factories map their Step-specific typed completion facts without I/O", () => {
  const cases = [
    [draftResult, "draft", DraftCreatedResult],
    [draftQuestionsTriageResult, "draft-questions-triage", DraftQuestionsTriageCompletedResult],
    [draftCoverageTriageResult, "draft-coverage-triage", DraftCoverageTriageCompletedResult],
  ];
  for (const [factory, stepId, Result] of cases) {
    assert.equal(factory(new DraftWorkerCompletionFacts(stepId)) instanceof Result, true);
  }
});

test("Draft Gate Result factory maps pass, convergence, exhaustion, repair, and typed errors without I/O", () => {
  assert.equal(draftGateResult(new DraftGateProspectiveFacts({ result: "pass" })) instanceof DraftGatePassedResult, true);
  assert.equal(draftGateResult(new DraftGateProspectiveFacts({
    result: "fail", failureCategory: "semantic", sameEvidence: true,
  })) instanceof DraftGateCarryForwardResult, true);
  assert.equal(draftGateResult(new DraftGateProspectiveFacts({
    result: "fail", failureCategory: "semantic", retryExhausted: true, retryUsed: 1,
  })) instanceof DraftGateCarryForwardResult, true);
  assert.equal(draftGateResult(new DraftGateProspectiveFacts({
    result: "fail", failureCategory: "semantic",
  })) instanceof DraftGateRepairRequiredResult, true);
  assert.equal(draftGateResult(new DraftGateProspectiveFacts({
    result: "fail", failureCategory: "tooling",
  })) instanceof StepErrorResult, true);
  const failed = draftGateResult(new Error("prospective facts unavailable"));
  assert.equal(failed instanceof StepErrorResult, true);
  assert.equal(failed.error.message, "prospective facts unavailable");
});

test("Draft Review Result factories map typed PASS, findings, and Error facts without I/O", () => {
  const cases = [
    [draftQuestionsReviewResult, "draft-questions", DraftQuestionsReviewPassedResult, DraftQuestionsReviewFindingsResult],
    [draftCoverageReviewResult, "draft-coverage", DraftCoverageReviewPassedResult, DraftCoverageReviewFindingsResult],
  ];
  for (const [factory, phase, PassedResult, FindingsResult] of cases) {
    assert.equal(factory(reviewFacts(phase)) instanceof PassedResult, true);
    assert.equal(factory(reviewFacts(phase, true)) instanceof FindingsResult, true);
    const error = new Error(`${phase} facts unavailable`);
    const failed = factory(error);
    assert.equal(failed instanceof StepErrorResult, true);
    assert.equal(failed.error.message, error.message);
  }
});

test("Draft Repair Result factories map typed changed, unchanged, and Error facts without I/O", () => {
  const cases = [
    [draftQuestionsRepairResult, "draft-questions-repair", DraftQuestionsRepairChangedResult, DraftQuestionsRepairUnchangedResult],
    [draftCoverageRepairResult, "draft-coverage-repair", DraftCoverageRepairChangedResult, DraftCoverageRepairUnchangedResult],
  ];
  for (const [factory, stepId, ChangedResult, UnchangedResult] of cases) {
    assert.equal(factory(new DraftRepairResultFacts({ stepId, draftChanged: true })) instanceof ChangedResult, true);
    assert.equal(factory(new DraftRepairResultFacts({ stepId, draftChanged: false })) instanceof UnchangedResult, true);
    const error = new Error(`${stepId} facts unavailable`);
    const failed = factory(error);
    assert.equal(failed instanceof StepErrorResult, true);
    assert.equal(failed.error.message, error.message);
  }
});

test("Draft Gate Repair Result factory maps binding, outcomes, and accepted semantic errors", () => {
  assert.equal(draftGateRepairResult(planGateRepairFacts()) instanceof DraftGateRepairWorkerRequiredResult, true);
  assert.equal(draftGateRepairResult(planGateRepairFacts("applied")) instanceof DraftGateRepairAppliedResult, true);
  assert.equal(draftGateRepairResult(planGateRepairFacts("rejected-no-progress")) instanceof DraftGateRepairCarryForwardResult, true);
  const failed = draftGateRepairResult(new Error("accepted outcome is inconsistent"));
  assert.equal(failed instanceof StepErrorResult, true);
  assert.equal(failed.error.message, "accepted outcome is inconsistent");
});

test("Draft Result factories reject facts typed for a different Step", () => {
  assert.throws(
    () => draftResult(new DraftWorkerCompletionFacts("draft-questions-triage")),
    /typed completion facts/,
  );
  assert.throws(
    () => draftQuestionsTriageResult(new DraftWorkerCompletionFacts("draft-coverage-triage")),
    /typed completion facts/,
  );
  assert.throws(() => draftGateResult({ result: "pass" }), /typed prospective facts/);
  assert.throws(
    () => draftQuestionsRepairResult(new DraftRepairResultFacts({
      stepId: "draft-coverage-repair", draftChanged: true,
    })),
    /requires its typed worker facts/,
  );
  assert.throws(
    () => draftQuestionsReviewResult(reviewFacts("draft-coverage")),
    /requires typed Review facts/,
  );
  assert.throws(() => draftCoverageReviewResult({ verdict: "PASS" }), /typed Review facts/);
  assert.throws(() => draftGateRepairResult({ disposition: "applied" }), /typed repair facts/);
  assert.throws(
    () => draftGateRepairResult(planGateRepairFacts(null, { phase: "spec" })),
    /does not target its Step/,
  );
  assert.throws(
    () => draftGateRepairResult(planGateRepairFacts("applied", { phase: "spec" })),
    /does not belong to the Draft Gate/,
  );
});
