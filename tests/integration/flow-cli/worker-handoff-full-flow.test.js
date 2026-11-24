import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import { sealWorkerArtifactHandoff, WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { DraftCompletionFacts, DraftCompletionSettlementApplication } from "../../../src/flow/lib/draft-completion-connector.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { completeDraftWorkerThroughStep, prepareConditionalDraftWorkerThroughStep } from "../../support/infrastructure/draft-worker-step.js";
import { produceDraftGateResult } from "../../support/infrastructure/query-draft-review-scenario.js";

function repairValueDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyQuestionLedgerDraft(goal = "full flow") {
  return {
    devType: "feature",
    goal,
    analysis: { problem: "Exercise the full flow.", proposedApproach: "Publish canonical artifacts.", validation: "Complete every deterministic step." },
    decisionMap: { knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [] },
    questionLedger: { revision: 0, publication: "fixture", evidenceDigest: "a".repeat(64), questions: [] },
  };
}

async function completeArtifactHandoff({ coordinator, ctx, stepId, invocationId, logicalName, payload }) {
  const actionDigest = crypto.createHash("sha256").update(`${invocationId}:action`).digest("hex");
  const targetDigest = crypto.createHash("sha256").update(`${invocationId}:target`).digest("hex");
  const request = coordinator.createRequest({
    ctx,
    state: ctx.flowManager.load(ctx.specId),
    invocation: {
      id: invocationId,
      target: { digest: targetDigest },
      action: { digest: actionDigest, nextAction: { step: stepId } },
    },
  });
  assert.ok(request, `${stepId} must create a handoff request`);
  fs.writeFileSync(request.payloadPath(logicalName), workerArtifactJson(payload));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId });
  return { request, result: await completeDraftWorkerThroughStep({ coordinator, ctx, request }) };
}

describe("worker handoff Draft to Spec connection", { concurrency: false }, () => {
  it("runs Draft entry, a repair loop, reload, and terminal Spec connection through production APIs", async () => {
    const temporaryRoot = createTmpDir("worker-handoff-draft-coverage-repair-");
    try {
      const repository = temporaryRoot;
      initGitRepo(repository);
      fs.writeFileSync(path.join(repository, "README.md"), "Draft repair and downstream connection fixture.\n");
      commitAll(repository, "fixture baseline");
      const specId = "715f-worker-handoff-draft-coverage-repair";
      let flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-worker-handoff-draft-coverage-repair",
        autoApprove: true,
      });
      fixture.create().registerActive().activate("draft");

      const candidateQuestion = {
        state: "CandidateQuestion",
        id: "q1",
        question: "Which validation behavior must the Draft retain?",
        category: "user-visible-behavior",
        revision: 0,
        provenance: { producer: "production-scenario" },
        evidenceDigest: "a".repeat(64),
      };
      const emptyDraft = emptyQuestionLedgerDraft("draft coverage repair");
      const sourceDraft = {
        ...emptyDraft,
        decisionMap: { ...emptyDraft.decisionMap, requiresUserJudgment: [candidateQuestion.id] },
        questionLedger: { ...emptyDraft.questionLedger, questions: [candidateQuestion] },
      };
      class InterruptAfterPublicationCoordinator extends WorkerArtifactHandoffCoordinator {
        interrupted = false;

        completePublishedDraftWorker(input) {
          if (!this.interrupted) {
            this.interrupted = true;
            throw new Error("simulated interruption after conditional publication");
          }
          return super.completePublishedDraftWorker(input);
        }
      }
      const coordinator = new InterruptAfterPublicationCoordinator();
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        flowManager,
      };
      const runDraftReview = async (manager, phase, { verdict, summary, repairTargets = [] }) => {
        const command = new RunReviewCommand({
          resolveTreeSha: () => "a".repeat(40),
          resolveTargetStateDigest: () => "b".repeat(64),
          runCommand(_command, _args, options) {
            const worker = ReviewWorkUnit.fromEnvironment(options.env);
            const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
            fs.writeFileSync(path.join(worker.root, worker.manifestDocument.output.basename), `${JSON.stringify({
              version: 2,
              phase,
              sourceDraft: "draft.json",
              sourceDraftRevision: source.revision,
              generatedAt: "2026-09-20T00:00:00.000Z",
              verdict,
              summary,
              blockingFindings: [],
              advisoryFindings: [],
              repairTargets,
            }, null, 2)}\n`);
            worker.seal();
            return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
          },
        });
        const reviewCtx = {
          ...ctx,
          flowManager: manager,
          phase: "draft",
          flowState: manager.loadReadOnly(specId),
          config: {},
        };
        const commandResult = await command.execute(reviewCtx);
        assert.equal(commandResult.result, "ok", JSON.stringify(commandResult));
        assert.equal(commandResult.artifacts.phase, phase);
        await FLOW_COMMANDS.run.review.post(reviewCtx, commandResult);
      };

      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft",
        invocationId: "draft-production-entry",
        logicalName: "draft.json",
        payload: sourceDraft,
      });
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
      flowManager.beginNextAction(specId);
      await runDraftReview(flowManager, "draft-questions", {
        verdict: "PASS",
        summary: "No question-review finding remains.",
      });
      assert.equal(
        flowManager.canonicalState(specId).nextAction().operation,
        "start",
        JSON.stringify(flowManager.loadReadOnly(specId), null, 2),
      );
      flowManager.beginNextAction(specId);
      const refineState = flowManager.loadReadOnly(specId);
      const refine = await prepareConditionalDraftWorkerThroughStep({
        coordinator,
        ctx,
        state: refineState,
        invocationId: "draft-production-refine",
      });
      assert.notEqual(refine.request, null);
      assert.equal(
        flowManager.draftStepExecutionState({
          binding: {
            runId: flowManager.canonicalState(specId).runId,
            specId,
            stepId: "draft-refine",
            attempt: flowManager.canonicalState(specId).attempt,
          },
        }).lifecycle.phase,
        "claimed",
      );
      fs.writeFileSync(refine.request.payloadPath("draft.json"), workerArtifactJson(emptyDraft));
      sealWorkerArtifactHandoff({
        requestPath: refine.request.requestPath,
        invocationId: refine.request.dispatchInvocationId,
      });
      await assert.rejects(
        () => completeDraftWorkerThroughStep({ coordinator, ctx, request: refine.request }),
        /simulated interruption after conditional publication/,
      );
      flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      ctx.flowManager = flowManager;
      const publicationBinding = {
        runId: flowManager.canonicalState(specId).runId,
        specId,
        stepId: "draft-refine",
        attempt: flowManager.canonicalState(specId).attempt,
      };
      assert.equal(flowManager.draftStepExecutionState({ binding: publicationBinding }).lifecycle.phase, "publication");
      const recoveredRefine = await completeDraftWorkerThroughStep({
        coordinator,
        ctx,
        request: refine.request,
      });
      assert.equal(recoveredRefine.stepResult.kind, "draft-refine-completed");
      assert.deepEqual(
        flowManager.activityLedger(specId)
          .filter((activity) => activity.nodeId === "draft-refine")
          .map((activity) => activity.result?.draftSettlementReceipt?.executionLifecycle?.phase)
          .filter((phase) => phase !== undefined),
        ["checkpoint", "claimed", "publication", "terminal"],
      );
      flowManager.beginNextAction(specId);
      const reviewFinding = {
        title: "Clarify validation coverage",
        target: "analysis.validation",
        rationale: "The validation statement must describe the repaired coverage.",
        evidence: "The current validation statement omits the repaired coverage behavior.",
        classification: "repair_target",
      };
      await runDraftReview(flowManager, "draft-coverage", {
        verdict: "ADVISORY",
        summary: "One coverage repair is required.",
        repairTargets: [reviewFinding],
      });
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-triage");
      flowManager.beginNextAction(specId);
      const triage = {
        version: 1,
        phase: "draft-coverage-triage",
        sourceReview: "draft-review-coverage.json",
        summary: "Apply the coverage repair.",
        items: [{
          ...reviewFinding,
          decision: "apply",
          allowedFieldPaths: ["analysis.validation"],
          requiredFieldPaths: ["analysis.validation"],
        }],
      };
      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft-coverage-triage",
        invocationId: "draft-coverage-repair-triage",
        logicalName: "draft-coverage-triage.json",
        payload: triage,
      });

      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-repair");
      flowManager.beginNextAction(specId);
      const repairHandoff = coordinator.createRequest({
        ctx,
        state: flowManager.load(specId),
        invocation: {
          id: "draft-coverage-repair-worker",
          target: { digest: "1".repeat(64) },
          action: { digest: "2".repeat(64), nextAction: { step: "draft-coverage-repair" } },
        },
      });
      const expectedDigest = repairValueDigest(sourceDraft.analysis.validation);
      const repairedValue = "Complete the repaired coverage behavior.";
      fs.writeFileSync(repairHandoff.payloadPath("draft-coverage-repair.json"), workerArtifactJson({
        version: 1,
        baseRevision: `sha256:${repairHandoff.inputRevision}`,
        operations: [
          {
            title: reviewFinding.title,
            target: reviewFinding.target,
            kind: "replace-value",
            path: "analysis.validation",
            expectedDigest,
            replacement: repairedValue,
            reason: "The permitted validation field now covers the repaired behavior.",
          },
          {
            title: "Unrelated operation",
            target: "unrelated finding",
            kind: "replace-value",
            path: "analysis.problem",
            expectedDigest: repairValueDigest(sourceDraft.analysis.problem),
            replacement: "This unrelated field must remain unchanged.",
            reason: "This proposal is outside the triage permission.",
          },
        ],
      }));
      sealWorkerArtifactHandoff({
        requestPath: repairHandoff.requestPath,
        invocationId: "draft-coverage-repair-worker",
      });
      const repaired = await completeDraftWorkerThroughStep({ coordinator, ctx, request: repairHandoff });

      assert.equal(repaired.completed, true);
      const repairAudit = JSON.parse(flowManager.readArtifact({
        specId,
        logicalKey: "draft.coverage.repair",
        consumerNodeId: "draft-gate",
      }).bytes.toString("utf8"));
      const completedDraftArtifact = flowManager.readArtifact({
        specId,
        logicalKey: "draft",
        consumerNodeId: "draft-gate",
      });
      const completedDraft = JSON.parse(completedDraftArtifact.bytes.toString("utf8"));
      assert.equal(repairAudit.acceptedOperations.length, 1);
      assert.equal(repairAudit.acceptedOperations[0].kind, "replace-value");
      assert.equal(repairAudit.acceptedOperations[0].path, "analysis.validation");
      assert.equal(repairAudit.discardedOperations.length, 1);
      assert.equal(repairAudit.discardedOperations[0].reason, "unauthorized operation");
      assert.equal(completedDraft.analysis.validation, repairedValue);
      assert.equal(Object.hasOwn(completedDraft, "approval"), false);

      const repairDescriptor = flowManager.readArtifact({
        specId,
        logicalKey: "draft.coverage.repair",
        consumerNodeId: "draft-gate",
      }).descriptor;
      const completionActivity = flowManager.activityLedger(specId)
        .find((activity) => activity.id === repairDescriptor.activityId);
      assert.ok(completionActivity);
      assert.equal(repairDescriptor.activityId, completedDraftArtifact.descriptor.activityId);
      assert.equal(completedDraftArtifact.descriptor.activityId, completionActivity.id);
      assert.equal(completionActivity.transition.operation, "confirm_attempt");
      assert.equal(repaired.stepResult.kind, "draft-coverage-repair-changed");
      assert.equal(repaired.settlementReceipt.targetStepId, "draft-coverage-review");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");

      const activityCount = flowManager.activityLedger(specId).length;
      const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      const durableReceipt = reloaded.activityLedger(specId).findLast((activity) => (
        activity.result?.draftSettlementReceipt?.id === repaired.settlementReceipt.id
      ))?.result.draftSettlementReceipt ?? null;
      assert.equal(durableReceipt?.id, repaired.settlementReceipt.id);
      assert.equal(reloaded.activityLedger(specId).length, activityCount);
      assert.equal(
        reloaded.activityLedger(specId).filter((activity) => activity.transition.stepConnectionReceipt?.kind === "draft-completion").length,
        0,
      );

      ctx.flowManager = reloaded;
      reloaded.beginNextAction(specId);
      await runDraftReview(reloaded, "draft-coverage", {
        verdict: "ADVISORY",
        summary: "The repaired Draft retains one already-resolved coverage target.",
        repairTargets: [reviewFinding],
      });
      reloaded.beginNextAction(specId);
      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft-coverage-triage",
        invocationId: "draft-coverage-unchanged-triage",
        logicalName: "draft-coverage-triage.json",
        payload: {
          ...triage,
          summary: "The coverage target is already resolved by the prior repair.",
          items: triage.items.map((item) => ({ ...item, decision: "already_resolved" })),
        },
      });
      reloaded.beginNextAction(specId);
      const unchangedHandoff = coordinator.createRequest({
        ctx,
        state: reloaded.load(specId),
        invocation: {
          id: "draft-coverage-unchanged-repair",
          target: { digest: "7".repeat(64) },
          action: { digest: "8".repeat(64), nextAction: { step: "draft-coverage-repair" } },
        },
      });
      fs.writeFileSync(unchangedHandoff.payloadPath("draft-coverage-repair.json"), workerArtifactJson({
        version: 1,
        baseRevision: `sha256:${unchangedHandoff.inputRevision}`,
        operations: [],
      }));
      sealWorkerArtifactHandoff({
        requestPath: unchangedHandoff.requestPath,
        invocationId: unchangedHandoff.dispatchInvocationId,
      });
      let selectedFacts = null;
      let handoffApplication = null;
      let storeApplication = null;
      const commitDraftWorker = coordinator.commitDraftWorker.bind(coordinator);
      coordinator.commitDraftWorker = (input) => {
        if (input.request === unchangedHandoff) {
          handoffApplication = input.draftCompletionApplication;
          assert.ok(handoffApplication instanceof DraftCompletionSettlementApplication);
          selectedFacts = handoffApplication.facts;
          assert.ok(selectedFacts instanceof DraftCompletionFacts);
        }
        return commitDraftWorker(input);
      };
      const settleDraftStepResult = reloaded.settleDraftStepResult.bind(reloaded);
      reloaded.settleDraftStepResult = (input) => {
        if (input.binding?.stepId === "draft-coverage-repair") {
          storeApplication = input.draftCompletionApplication;
        }
        return settleDraftStepResult(input);
      };
      const unchanged = await completeDraftWorkerThroughStep({
        coordinator, ctx, request: unchangedHandoff,
      });
      assert.equal(unchanged.stepResult.kind, "draft-coverage-repair-unchanged");
      assert.equal(storeApplication, handoffApplication);
      assert.ok(storeApplication instanceof DraftCompletionSettlementApplication);
      assert.equal(storeApplication.facts, selectedFacts);
      assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-gate");
      reloaded.beginNextAction(specId);
      const gateResult = await produceDraftGateResult({
        ...ctx, flowManager: reloaded, config: {},
        flowState: reloaded.loadReadOnly(specId),
      });
      await FLOW_COMMANDS.run.gate.post({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        phase: "draft",
      }, gateResult);
      const specAction = await new GetNextActionCommand().execute({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        config: {},
      });
      assert.equal(specAction.step, "spec");
      assert.equal(specAction.directive.actionId, "CLAIM_NEXT_ACTION");
      const claimedSpec = await new RunClaimNextActionCommand().execute({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        config: {},
      });
      assert.equal(claimedSpec.ok, true, JSON.stringify(claimedSpec));
      const specRequest = coordinator.createRequest({
        ctx: { ...ctx, flowManager: reloaded },
        state: reloaded.loadReadOnly(specId),
        invocation: {
          id: "draft-production-spec-connection",
          target: { digest: "3".repeat(64) },
          action: { digest: "4".repeat(64), nextAction: { step: "spec" } },
        },
        deferPreparation: true,
      });
      const draftInput = specRequest.inputs.find((entry) => entry.name === "draft.json");
      assert.equal(draftInput.document.analysis.validation, repairedValue);
      assert.equal(
        reloaded.activityLedger(specId).filter((activity) => (
          activity.result?.draftSettlementReceipt?.targetStepId === "spec"
        )).length,
        1,
      );
    } finally {
      removeTmpDir(temporaryRoot);
    }
  });
});
