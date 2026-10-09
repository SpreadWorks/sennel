import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { afterEach } from "node:test";

import {
  ApprovalRouteFacts,
  DefinitionRouteTarget,
  resolveDefinitionRoute,
  settleAcceptanceStepResult,
  resolveLifecycle,
} from "../../../src/flow/definition.js";
import { CanonicalSpecApproval } from "../../../src/flow/lib/canonical-spec-approval.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { projectApprovalRequirements } from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { acquireApprovalInput, executeApprovalInput } from "../../../src/flow/engine/composition/test.js";

import { NonGateTargetBinding, NonGateCatalogPublication, NonGateSourcePublication } from "../../../src/flow/lib/non-gate-transition.js";
import { AcceptanceReviewResultEvidence, AcceptanceDecisionResultEvidence, AcceptanceDecisionRequest } from "../../../src/flow/steps/acceptance/acceptance-review-values.js";
import { acceptanceReviewResult } from "../../../src/flow/steps/acceptance/acceptance-review.js";
import { acceptanceDecisionResult } from "../../../src/flow/steps/acceptance/acceptance-decision.js";
import { AcceptanceReviewInput } from "../../../src/flow/services/acceptance-review-input.js";
import { AcceptanceDecisionInput } from "../../../src/flow/services/acceptance-decision-input.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";

const digest = "a".repeat(64);
const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) removeTmpDir(root);
});

function target(stepId) {
  return new DefinitionRouteTarget({
    runId: "run-definition-route",
    specId: "definition-route",
    stepId,
    attemptId: `${stepId}-attempt`,
    sequence: 3,
  });
}

// Local immutable observations exercise the selector without publishing a Flow.
function acceptanceIdentity(stepId) {
  return new NonGateTargetBinding({ runId: "run-definition-route", specId: "definition-route", stepId,
    attempt: { id: `${stepId}-attempt`, sequence: 3 } });
}
function acceptancePublication(stepId, Publication = NonGateCatalogPublication) {
  return new Publication({ runId: "run-definition-route", specId: "definition-route", stepId,
    attemptId: `${stepId}-attempt`, sequence: 3, producerActivityId: `${stepId}-publication`,
    artifactId: `steps/${stepId}/result.json`, fingerprint: digest });
}
function reviewResult(verdict) {
  return acceptanceReviewResult(new AcceptanceReviewInput({ evidence: new AcceptanceReviewResultEvidence({
    identity: acceptanceIdentity("acceptance-review"), fingerprint: digest, requirementIds: ["REQ-1"],
    publication: verdict === null ? null : acceptancePublication("acceptance-review"), verdict,
    reviewDigest: verdict === null ? null : digest, reviewAttempt: verdict === null ? null : 3,
    findingIds: verdict === "repair_required" ? ["requirement:REQ-1"] : [],
    decisionAttemptSequence: 0, decisionStatus: "pending",
  }) }));
}
function decisionResult(choice) {
  return acceptanceDecisionResult(new AcceptanceDecisionInput({ evidence: new AcceptanceDecisionResultEvidence({
    identity: acceptanceIdentity("acceptance-decision"),
    sourcePublication: acceptancePublication("acceptance-review", NonGateSourcePublication),
    reviewAttempt: 3, repairFingerprint: digest, choice,
    publication: choice === null ? null : acceptancePublication("acceptance-decision"),
  }) }));
}

describe("Definition-owned approval and acceptance routes", () => {
  it("keeps approval waiting until a bound explicit or auto policy confirmation exists", () => {
    const waiting = resolveDefinitionRoute(new ApprovalRouteFacts({
      target: target("approval"), specPublicationDigest: digest,
    }));
    assert.equal(waiting.route, "await-approval");
    const approved = resolveDefinitionRoute(new ApprovalRouteFacts({
      target: target("approval"), specPublicationDigest: digest, requestedApproval: true,
    }));
    assert.equal(approved.route, "confirm-and-advance");
    const automatic = resolveDefinitionRoute(new ApprovalRouteFacts({
      target: target("approval"), specPublicationDigest: digest, autoApprove: true,
    }));
    assert.equal(automatic.route, "confirm-and-advance");
    const stale = resolveDefinitionRoute(new ApprovalRouteFacts({
      target: target("approval"), specPublicationDigest: digest,
      approvalRecord: { approved: true, confirmed_at: "2026-01-01T00:00:00.000Z" },
      requestedApproval: true,
    }));
    assert.deepEqual(stale.toJSON().route, "blocked");
  });

  it("selects every acceptance review settlement from its concrete Result", () => {
    const expected = [
      ["pass", "target-connection", "final-regression"],
      ["repair_required", "target-connection", "impl-triage"],
      ["user_decision_required", "target-connection", "acceptance-decision"],
      ["blocked", "await", undefined],
    ];
    for (const [verdict, kind, targetStepId] of expected) {
      const result = reviewResult(verdict);
      const settlement = settleAcceptanceStepResult(result.stepId, result);
      assert.equal(settlement.kind, kind);
      assert.equal(settlement.targetStepId, targetStepId);
      const restored = StepResult.fromStored(result.stepId, JSON.parse(JSON.stringify(result)));
      assert.deepEqual(settleAcceptanceStepResult(restored.stepId, restored).toJSON(), settlement.toJSON());
    }
  });

  it("keeps unavailable evidence distinct from unfinished execution after Result reload", () => {
    for (const [verdict, kind] of [[null, "execution"], ["blocked", "await"]]) {
      const result = reviewResult(verdict);
      const restored = StepResult.fromStored(result.stepId, JSON.parse(JSON.stringify(result)));
      const settlement = settleAcceptanceStepResult(result.stepId, result);
      assert.equal(settlement.kind, kind);
      assert.deepEqual(settleAcceptanceStepResult(restored.stepId, restored).toJSON(), settlement.toJSON());
    }
  });

  it("keeps acceptance choices tokenless and derives continuation or park only from their Result", () => {
    for (const [choice, kind, targetStepId] of [[null, "await", undefined],
      ["accept_risk_and_continue", "target-connection", "final-regression"], ["abort", "park", undefined]]) {
      const result = decisionResult(choice);
      const settlement = settleAcceptanceStepResult(result.stepId, result);
      assert.equal(settlement.kind, kind);
      assert.equal(settlement.targetStepId, targetStepId);
      assert.equal(settlement.token, undefined);
      const restored = StepResult.fromStored(result.stepId, JSON.parse(JSON.stringify(result)));
      assert.deepEqual(settleAcceptanceStepResult(restored.stepId, restored).toJSON(), settlement.toJSON());
    }
    assert.throws(() => new AcceptanceDecisionRequest({ choice: "abort", reviewDigest: digest,
      record: { reviewDigest: "b".repeat(64), choice: "abort" } }), /bound to canonical review evidence/);
    assert.throws(() => new AcceptanceDecisionRequest({ choice: "abort", reviewDigest: digest,
      record: { reviewDigest: digest, choice: "accept_risk_and_continue" } }), /bound to canonical review evidence/);
  });

  it("leaves Acceptance completion to Result settlements while retaining report outbox boundaries", () => {
    for (const stepId of ["retro", "acceptance-review", "final-regression", "report"]) {
      assert.deepEqual(resolveLifecycle({ event: `${stepId}:post`, currentStepId: stepId,
        targetStepId: stepId, status: "done", result: { result: "ok", verdict: "pass" } }), []);
    }
    assert.equal(resolveLifecycle({ event: "report:pre", currentStepId: "report" }).length, 1);
    assert.equal(resolveLifecycle({ event: "report:onError", currentStepId: "report" }).length, 1);
  });

  it("rejects a stale approval publication digest without advancing the Flow", async () => {
    const root = createTmpDir("definition-route-stale-approval-");
    fixtureRoots.push(root);
    const specId = "stale-approval";
    const manager = makeFlowManager(root);
    new FlowAtStepFixture({
      flowManager: manager, specId, runId: "run-stale-approval", execution: { mode: "direct" },
      targetStep: "approval", specRecord: { ...emptySpecStub(), tasks: [] },
    }).create();
    const before = manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "approval" });
    const observed = acquireApprovalInput({
      state: manager.canonicalState(specId),
      specDescriptor: before.descriptor,
      spec: JSON.parse(before.bytes.toString("utf8")),
      review: manager.readCurrentSpecReview({ specId, consumerNodeId: "approval" }).review,
      approval: new CanonicalSpecApproval({ confirmedAt: "2026-01-02T00:00:00.000Z" }),
    });
    manager.updateSpecApproval({
      specId,
      approval: new CanonicalSpecApproval({ confirmedAt: "2026-01-01T00:00:00.000Z" }),
    });
    const flowBefore = manager.canonicalState(specId).toJSON();
    await assert.rejects(() => executeApprovalInput({
      stepId: "approval", flowManager: manager, specId, observed,
      expectedSpecDigest: before.descriptor.hash,
    }), /changed before approval confirmation/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), flowBefore);
  });

  it("projects manual, automatic, and recovered approval plans without an unintended token", () => {
    const base = { target: target("approval"), specPublicationDigest: digest };
    const manual = resolveDefinitionRoute(new ApprovalRouteFacts(base));
    assert.deepEqual(projectApprovalRequirements({ plan: manual, requiresApproval: true, autoApproveChoiceId: "1" }), {
      requiresApproval: true, autoApproveChoiceId: "1",
    });
    for (const facts of [
      new ApprovalRouteFacts({ ...base, autoApprove: true }),
      new ApprovalRouteFacts({ ...base, approvalRecord: { approved: true, confirmed_at: "2026-01-01T00:00:00.000Z", notes: "kept" } }),
    ]) {
      const plan = resolveDefinitionRoute(facts);
      assert.deepEqual(projectApprovalRequirements({ plan, requiresApproval: true, autoApproveChoiceId: "1" }), {
        requiresApproval: false, autoApproveChoiceId: null,
      });
    }
  });

  it("rejects a blocked approval plan before any Store call", async () => {
    let storeCalls = 0;
    const flowManager = {
      canonicalState: () => ({
        runId: "run-definition-route", specId: "definition-route", current: ["approval"],
        currentNodeId: "approval", attempt: { id: "approval-attempt", sequence: 1 },
        policy: { autoApprove: false },
      }),
      readArtifact: () => ({
        descriptor: { hash: digest },
        bytes: Buffer.from(JSON.stringify({
          user_approval: { approved: true, confirmed_at: "2026-01-01T00:00:00.000Z" },
        })),
      }),
      approveSpecContinuation() { storeCalls += 1; },
      commitSpecStepResult() { storeCalls += 1; },
    };
    await assert.rejects(() => new RunDispatchCommand().runApprovalContinuation({
      specId: "definition-route", flowManager,
    }, {
      action: { nextAction: { step: "approval" } }, approved: true, authorization: null,
    }), /approval_already_recorded/);
    assert.equal(storeCalls, 0);
  });

  it("reuses an existing approval record when Definition resumes confirmation", async (t) => {
    const root = createTmpDir("definition-route-recovered-approval-");
    fixtureRoots.push(root);
    const specId = "recovered-approval";
    const flowManager = makeFlowManager(root);
    const recorded = {
      approved: true,
      confirmed_at: "2026-01-01T00:00:00.000Z",
      notes: "preserve this approval",
    };
    new FlowAtStepFixture({
      flowManager, specId, runId: "run-recovered-approval", execution: { mode: "direct" },
      // The persisted approval belongs to the same Spec that its Review evaluated.
      targetStep: "approval", specRecord: { ...emptySpecStub(), tasks: [], user_approval: recorded },
    }).create();
    const digest = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "approval" }).descriptor.hash;
    let applied = null;
    const commit = flowManager.commitSpecStepResult.bind(flowManager);
    t.mock.method(flowManager, "commitSpecStepResult", (input) => {
      applied = input;
      return commit(input);
    });
    await new RunDispatchCommand().runApprovalContinuation({ specId, flowManager }, {
      action: { nextAction: { step: "approval" } }, approved: false, authorization: null,
    });
    assert.equal(applied.expectedSpecDigest, digest);
    assert.deepEqual(applied.approval.toJSON(), recorded);
    const persisted = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "approval" });
    assert.deepEqual(JSON.parse(persisted.bytes.toString("utf8")).user_approval, recorded);
  });
});
