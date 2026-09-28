import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { DraftService } from "../../../src/flow/services/draft-service.js";
import { DraftRepairCandidate } from "../../../src/flow/steps/draft/draft-repair-candidate.js";
import { DraftQuestionsRepairUnchangedResult } from "../../../src/flow/engine/step-result.js";
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
    const service = await DraftService.prepare({ ctx, request, Connector, handoffCoordinator: coordinator, preparation });
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

for (const phase of ["questions", "coverage"]) {
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
