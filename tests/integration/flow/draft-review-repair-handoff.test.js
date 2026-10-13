import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { prepareDraftService } from "../../support/infrastructure/draft-service.js";
import { DraftRepairCandidate } from "../../../src/flow/steps/draft/draft-repair-candidate.js";
import { DraftQuestionsRepairUnchangedResult, StepErrorResult } from "../../../src/flow/engine/step-result.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { draftWorkerStepRegistration } from "../../../src/flow/engine/composition/draft.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { DraftTriageConnector } from "../../../src/flow/engine/connectors/draft/draft-triage-connector.js";
import { DraftRepairConnector } from "../../../src/flow/engine/connectors/draft/draft-repair-connector.js";
import { DraftQuestionsTriageStep } from "../../../src/flow/steps/draft/draft-questions-triage.js";
import { DraftCoverageTriageStep } from "../../../src/flow/steps/draft/draft-coverage-triage.js";
import { DraftQuestionsRepairStep } from "../../../src/flow/steps/draft/draft-questions-repair.js";
import { DraftCoverageRepairStep } from "../../../src/flow/steps/draft/draft-coverage-repair.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { AnsweredQuestion } from "../../../src/flow/lib/draft-question-ledger.js";

const finding = {
  title: "Make validation explicit", target: "analysis.validation", classification: "blocking",
  rationale: "The validation plan needs a bounded clarification.", evidence: "The current validation is incomplete.",
};

async function review(ctx, phase, rejected) {
  const command = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40), resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
        version: 2, phase, sourceDraft: "draft.json", sourceDraftRevision: source.revision,
        generatedAt: "2026-09-23T00:00:00.000Z", verdict: rejected ? "REJECTED" : "PASS",
        summary: rejected ? finding.rationale : "No outstanding findings.",
        blockingFindings: rejected ? [finding] : [], advisoryFindings: [], repairTargets: [],
      }));
      work.seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const result = await command.execute(commandCtx);
  await FLOW_COMMANDS.run.review.post(commandCtx, result);
}

async function worker(ctx, coordinator, StepClass, Connector, payload, refusedResult = null) {
  const stepId = ctx.flowManager.canonicalState(ctx.specId).current.at(-1);
  const request = coordinator.createRequest({
    ctx, state: ctx.flowManager.loadReadOnly(ctx.specId),
    invocation: { id: `${stepId}-worker`, target: { digest: "b".repeat(64) }, action: { digest: "a".repeat(64), nextAction: { step: stepId } } },
  });
  fs.writeFileSync(request.payloadPath(`${stepId}.json`), workerArtifactJson(payload(request)));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
  const preparation = coordinator.prepareDraftWorker({ ctx, request });
  if (refusedResult !== null) {
    const service = await prepareDraftService({ ctx, request, Connector, handoffCoordinator: coordinator, preparation });
    service.adoptRepairCandidate(new DraftRepairCandidate(service.inspectWorkerFacts().repairInput));
    const before = {
      state: ctx.flowManager.canonicalState(ctx.specId).toJSON(),
      catalog: ctx.flowManager.artifactCatalog(ctx.specId).toJSON(),
      activities: ctx.flowManager.activityLedger(ctx.specId),
    };
    await assert.rejects(refusedResult.persist(service), CurrentFlowStateConflictError);
    const restart = new FlowManager({ root: ctx.root, mainRoot: ctx.root, inWorktree: false, specId: ctx.specId });
    assert.deepEqual(restart.canonicalState(ctx.specId).toJSON(), before.state);
    assert.deepEqual(restart.artifactCatalog(ctx.specId).toJSON(), before.catalog);
    assert.deepEqual(restart.activityLedger(ctx.specId), before.activities);
  }
  return new RunDispatchCommand({ handoffCoordinator: coordinator })
    .runDraftWorkerStep(ctx, request, draftWorkerStepRegistration(stepId), preparation);
}

it("Draft Step Error replacement repairs from the retained triage producer and publishes a new Review source", async () => {
  const root = fixtureRepository("draft-repair-error-replacement-");
  try {
    const specId = "804-questions-repair-error-replacement";
    let manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager };
    const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-repair-error-replacement",
      request: "Preserve the selected triage source across explicit repair recovery.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    const source = canonicalDraftDocument();
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(workerArtifactJson(source)) }] });
    fixture.activate("draft-questions-review");
    await review(ctx, "draft-questions", true);
    manager.beginNextAction(specId);
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const triage = await worker(ctx, coordinator, DraftQuestionsTriageStep, DraftTriageConnector, () => ({
      version: 1, phase: "draft-questions-triage", sourceReview: "draft-review-questions.json",
      summary: finding.rationale, items: [{ ...finding, decision: "apply",
        allowedFieldPaths: [finding.target], requiredFieldPaths: [finding.target] }],
    }));
    assert.equal(triage.stepResult.kind, "draft-questions-triage-completed");
    manager.beginNextAction(specId);
    const triageSource = manager.readArtifact({ specId, logicalKey: "draft.questions.triage", consumerNodeId: "draft-questions-repair" });
    const triageActivity = manager.activityLedger(specId).findLast((activity) =>
      activity.result?.draftSettlementReceipt?.id === triage.receipt.id);
    assert.equal(triageSource.descriptor.activityId, triageActivity.id);
    const request = coordinator.createRequest({ ctx, state: manager.loadReadOnly(specId), invocation: {
      id: "repair-error-failed-request", target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "draft-questions-repair" } },
    } });
    const binding = await new DraftRepairConnector(request).connect();
    const service = await prepareDraftService({ ctx, request, binding, handoffCoordinator: coordinator });
    // This tests the chosen Error's persistence boundary, not automatic error generation.
    await new StepErrorResult("draft-questions-repair", new Error("The selected repair could not be processed."))
      .persist(service);
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const failed = manager.canonicalState(specId);
    const failedActivities = manager.activityLedger(specId);
    const failureReceipt = manager.readCurrentStepSettlement({ specId, stepId: "draft-questions-repair" }).receipt;
    assert.equal(failed.attempt.failure.category, "step-result-error");
    assert.equal(failed.nextAction().operation, "blocked");
    manager.recoverDraftExecution({ specId, reason: "The bounded repair processing cause was corrected.",
      expectedAttempt: failed.attempt });
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const replacement = manager.canonicalState(specId).attempt;
    assert.notEqual(replacement.id, binding.attempt.id);
    assert.equal(replacement.sequence, binding.attempt.sequence + 1);
    assert.deepEqual(replacement.consumption.toJSON(), failed.attempt.consumption.toJSON());
    assert.deepEqual(manager.activityLedger(specId).slice(0, failedActivities.length), failedActivities);
    assert.equal(manager.activityLedger(specId).at(-1).transition.draftStepErrorRecoveryReceipt.failureReceiptId, failureReceipt.id);
    assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft.questions.triage", consumerNodeId: "draft-questions-repair" }), triageSource);
    assert.equal(manager.readCurrentStepSettlement({ specId, stepId: "draft-questions-repair" }), null);
    const beforeStale = manager.canonicalState(specId).toJSON();
    const beforeStaleActivities = manager.activityLedger(specId);
    assert.throws(() => request.assertCurrent(manager.loadReadOnly(specId)), { code: "FLOW_ARTIFACT_HANDOFF_STALE" });
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeStale);
    assert.deepEqual(manager.activityLedger(specId), beforeStaleActivities);

    const repairedValidation = "Execute the exact regression for the retained triage finding.";
    const repaired = await worker({ ...ctx, flowManager: manager }, coordinator,
      DraftQuestionsRepairStep, DraftRepairConnector, (nextRequest) => {
        assert.notEqual(nextRequest.requestDigest, request.requestDigest);
        const input = nextRequest.inputs.find((entry) => entry.name === "draft-questions-triage.json");
        assert.deepEqual(input.document, JSON.parse(triageSource.bytes));
        assert.equal(input.digest, triageSource.descriptor.hash);
        return { version: 1, baseRevision: `sha256:${nextRequest.inputRevision}`, operations: [{
          title: finding.title, target: finding.target, kind: "replace-value", path: finding.target,
          replacement: repairedValidation, reason: finding.rationale,
          expectedDigest: crypto.createHash("sha256").update(JSON.stringify(source.analysis.validation)).digest("hex"),
        }] };
      });
    assert.equal(repaired.stepResult.kind, "draft-questions-repair-changed");
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const terminal = manager.activityLedger(specId).findLast((activity) =>
      activity.result?.draftSettlementReceipt?.id === repaired.receipt.id);
    assert.equal(terminal.attemptId, replacement.id);
    assert.equal(terminal.sequence, replacement.sequence);
    assert.equal(terminal.result.draftSettlementReceipt.binding.attemptId, replacement.id);
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
    const audit = manager.readArtifact({ specId, logicalKey: "draft.questions.repair", consumerNodeId: "draft-gate" });
    assert.equal(audit.descriptor.activityId, terminal.id);
    assert.equal(JSON.parse(audit.bytes).acceptedOperations.length, 1);
    const repairedDraft = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
    assert.equal(repairedDraft.descriptor.activityId, terminal.id);
    assert.equal(JSON.parse(repairedDraft.bytes).analysis.validation, repairedValidation);
    manager.beginNextAction(specId);
    await review({ ...ctx, flowManager: manager }, "draft-questions", false);
    const final = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const consumed = JSON.parse(final.readArtifact({ specId, logicalKey: "draft.questions.review", consumerNodeId: "draft-questions-triage" }).bytes)
      .attempts.at(-1).artifact.payload;
    assert.equal(consumed.sourceDraftRevision.digest, repairedDraft.descriptor.hash);
    assert.equal(consumed.verdict, "PASS");
    assert.equal(final.canonicalState(specId).nextAction().nodeId, "draft-refine");
    assert.deepEqual(final.activityLedger(specId).slice(0, failedActivities.length), failedActivities);
  } finally { removeTmpDir(root); }
});

for (const phase of ["questions", "coverage"]) {
  it(`refuses a new ${phase} user choice after Review and preserves prior QA, publication and completion across reload`, async () => {
    const root = fixtureRepository(`draft-${phase}-triage-refusal-`);
    try {
      const specId = `804-${phase}-triage-refusal`;
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
      const fixture = new CanonicalFlowFixture({
        flowManager, specId, runId: `run-${specId}`, request: "Preserve earlier answers when a new choice is required.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().registerActive().activate("draft");
      const source = canonicalDraftDocument({ questions: [new AnsweredQuestion({
        id: "q1", question: "Keep the existing public behavior?", revision: 0,
        category: "user-visible-behavior", provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
        answer: "Keep the public behavior.", why: "The request requires it.", considered: "Changing it was rejected.",
      }).toJSON()] });
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(source)),
      }] });
      fixture.activate("draft-questions-review");
      if (phase === "coverage") {
        await review(ctx, "draft-questions", false);
        fixture.activate("draft-coverage-review");
      }
      await review(ctx, `draft-${phase}`, true);
      flowManager.beginNextAction(specId);
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const request = coordinator.createRequest({ ctx, state: flowManager.loadReadOnly(specId), invocation: {
        id: `${phase}-new-choice`, target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: `draft-${phase}-triage` } },
      } });
      const storedRequest = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      assert.match(storedRequest.workerInstructions.schemaGuidance, /requires_user_decision is recognized but rejected/);
      fs.writeFileSync(request.payloadPath(`draft-${phase}-triage.json`), workerArtifactJson({
        version: 1, phase: `draft-${phase}-triage`, sourceReview: `draft-review-${phase}.json`,
        summary: "A new user choice is required.", items: [{ ...finding, decision: "requires_user_decision" }],
      }));
      sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
      const before = {
        state: flowManager.canonicalState(specId).toJSON(), catalog: flowManager.artifactCatalog(specId).toJSON(),
        activities: flowManager.activityLedger(specId),
      };
      for (let replay = 0; replay < 2; replay += 1) {
        const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.throws(() => coordinator.prepareDraftWorker({ ctx: { ...ctx, flowManager: restarted }, request }), (error) => {
          assert.equal(error.code, "FLOW_ARTIFACT_HANDOFF_INVALID");
          assert.match(error.message, /decision requires user decision/);
          return true;
        });
        assert.deepEqual(restarted.canonicalState(specId).toJSON(), before.state);
        assert.deepEqual(restarted.artifactCatalog(specId).toJSON(), before.catalog);
        assert.deepEqual(restarted.activityLedger(specId), before.activities);
        const persistedDraft = JSON.parse(restarted.readArtifact({ specId, logicalKey: "draft", consumerNodeId: `draft-${phase}-triage` }).bytes);
        assert.deepEqual(persistedDraft, source);
        assert.deepEqual(persistedDraft.questionLedger.questions[0], source.questionLedger.questions[0]);
      }
    } finally { removeTmpDir(root); }
  });
  for (const changed of [true, false]) {
    it(`publishes ${phase} Repair ${changed ? "changed" : "unchanged"} through its real Step and reloads the selected Result and audit`, async () => {
      const root = fixtureRepository(`draft-${phase}-repair-`);
      try {
        const specId = `804-${phase}-${changed ? "changed" : "unchanged"}`;
        const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
        const fixture = new CanonicalFlowFixture({
          flowManager, specId, runId: `run-${specId}`, request: "Preserve selected bounded Draft repairs.",
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate("draft");
        const source = canonicalDraftDocument();
        flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(source)),
        }] });
        fixture.activate("draft-questions-review");
        if (phase === "coverage") {
          await review(ctx, "draft-questions", false);
          fixture.activate("draft-coverage-review");
        }
        await review(ctx, `draft-${phase}`, true);
        flowManager.beginNextAction(specId);
        const coordinator = new WorkerArtifactHandoffCoordinator();
        const triage = await worker(ctx, coordinator,
          phase === "questions" ? DraftQuestionsTriageStep : DraftCoverageTriageStep,
          DraftTriageConnector, () => ({
            version: 1, phase: `draft-${phase}-triage`, sourceReview: `draft-review-${phase}.json`,
            summary: finding.rationale,
            items: [{ ...finding, decision: changed ? "apply" : "already_resolved", allowedFieldPaths: [finding.target], requiredFieldPaths: changed ? [finding.target] : [] }],
          }));
        assert.equal(triage.stepResult.kind, `draft-${phase}-triage-completed`);
        flowManager.beginNextAction(specId);
        const repairAttempt = flowManager.canonicalState(specId).attempt;
        const repairedValidation = "Verify the selected repair, persisted audit, and downstream source identity.";
        const result = await worker(ctx, coordinator,
          phase === "questions" ? DraftQuestionsRepairStep : DraftCoverageRepairStep,
          DraftRepairConnector, (request) => ({
            version: 1, baseRevision: `sha256:${request.inputRevision}`,
            operations: changed ? [{
              title: finding.title, target: finding.target, kind: "replace-value", path: finding.target,
              replacement: repairedValidation, reason: finding.rationale,
              expectedDigest: crypto.createHash("sha256").update(JSON.stringify(source.analysis.validation)).digest("hex"),
            }] : [],
          }), phase === "questions" && changed ? new DraftQuestionsRepairUnchangedResult() : null);
        const kind = `draft-${phase}-repair-${changed ? "changed" : "unchanged"}`;
        assert.equal(result.stepResult.kind, kind);
        const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const state = restarted.canonicalState(specId);
        // A changed repair loops to Review and invalidates the old tree result;
        // its terminal Result and receipt remain authoritative in the ledger.
        const terminal = restarted.activityLedger(specId).findLast((activity) =>
          activity.nodeId === `draft-${phase}-repair` && activity.attemptId === repairAttempt.id
          && activity.result?.draftSettlementReceipt?.id === result.receipt.id);
        assert.equal(terminal.result.stepResult.kind, kind);
        assert.equal(terminal.result.draftSettlementReceipt.id, result.receipt.id);
        assert.equal(result.receipt.binding.attemptId, repairAttempt.id);
        const audit = restarted.readArtifact({ specId, logicalKey: `draft.${phase}.repair`, consumerNodeId: "draft-gate" });
        assert.equal(JSON.parse(audit.bytes).acceptedOperations.length, changed ? 1 : 0);
        assert.equal(crypto.createHash("sha256").update(audit.bytes).digest("hex"), audit.descriptor.hash);
        const draft = restarted.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate" });
        assert.equal(JSON.parse(draft.bytes).analysis.validation, changed ? repairedValidation : source.analysis.validation);
        assert.equal(state.nextAction().nodeId, changed ? `draft-${phase}-review` : phase === "questions" ? "draft-refine" : "draft-gate");
        if (changed) {
          const downstream = new CanonicalDraftReviewSource({ flowManager: restarted, state: restarted.loadReadOnly(specId), phase: `draft-${phase}` });
          assert.equal(downstream.sourceNodeId, `draft-${phase}-repair`);
          assert.equal(downstream.revision().digest, draft.descriptor.hash);
          assert.equal(JSON.parse(downstream.bytes).analysis.validation, repairedValidation);
        }
      } finally {
        removeTmpDir(root);
      }
    });
  }
}
