import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

// Lose the response of the normal registry post's execution publication,
// before its terminal Step. No saved publication or receipt is manufactured.
for (const phase of ["questions", "coverage"]) {
  it(`replays a normal Draft ${phase} Review publication through the dispatcher after reload`, async () => {
    const root = fixtureRepository(`de71-review-${phase}-replay-`);
    try {
      const specId = `971-review-${phase}-replay`;
      let manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager: manager, specId, runId: `run-de71-review-${phase}`,
        request: "Replay a retained Review without evaluating it twice.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().registerActive().activate("draft");
      manager.confirmCurrentAttempt({ specId, artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(workerArtifactJson(canonicalDraftDocument())),
      }] });
      fixture.activate(`draft-${phase}-review`);
      let providerCalls = 0;
      const command = new RunReviewCommand({
        resolveTreeSha: () => "a".repeat(40),
        resolveTargetStateDigest: () => "b".repeat(64),
        runCommand(_command, _args, options) {
          providerCalls += 1;
          const work = ReviewWorkUnit.fromEnvironment(options.env);
          const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
          fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
            version: 2, phase: `draft-${phase}`, sourceDraft: "draft.json",
            sourceDraftRevision: source.revision, generatedAt: "2026-10-15T00:00:00.000Z",
            verdict: "PASS", summary: "The retained Draft passes Review.",
            blockingFindings: [], advisoryFindings: [], repairTargets: [],
          }));
          work.seal();
          return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
        },
      });
      const produced = await command.execute({ root, mainRoot: root, executionRoot: root,
        specId, flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft", config: {} });
      assert.equal(produced.result, "ok", JSON.stringify(produced));
      assert.equal(providerCalls, 1);
      const settle = manager.commitDraftStepResult.bind(manager);
      let interrupted = false;
      manager.commitDraftStepResult = (input) => {
        const outcome = settle(input);
        if (!interrupted && outcome.receipt.executionLifecycle?.phase === "publication") {
          interrupted = true;
          throw new Error("lost Draft Review publication response");
        }
        return outcome;
      };
      await assert.rejects(FLOW_COMMANDS.run.review.post({ root, mainRoot: root, executionRoot: root,
        specId, flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft", config: {} }, produced),
      /lost Draft Review publication response/);
      assert.equal(interrupted, true);
      const stepId = `draft-${phase}-review`;
      const logicalKey = `draft.${phase}.review`;
      const sourceBefore = manager.readProducerArtifact({ specId, nodeId: stepId, logicalKey });
      const evidenceBefore = manager.artifactCatalog(specId).artifacts.filter((entry) => entry.logicalKey === "review.evidence");
      assert.equal(evidenceBefore.length, 1);
      const evidenceBytesBefore = manager.readCanonicalTransitionView({ specId,
        read: (view) => view.readCatalogedArtifact(evidenceBefore[0]) });
      const publication = manager.activityLedger(specId).find((entry) => entry.id === evidenceBefore[0].activityId);
      const publicationCount = () => manager.activityLedger(specId).filter((entry) => (
        entry.nodeId === stepId && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication"
      )).length;
      assert.equal(publicationCount(), 1);

      manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const state = manager.loadReadOnly(specId);
      const selected = await new GetNextActionCommand().execute({ root, mainRoot: root,
        executionRoot: root, flowManager: manager, flowState: state, specId });
      assert.equal(selected.step, stepId);
      assert.equal(selected.directive.kind, "execute_step");
      let workerCalls = 0;
      const agent = { async call() { workerCalls += 1; assert.fail("retained Review must not start a worker"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1, repositoryFingerprint: () => "de71-review-replay" });
      dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
      const resumed = await dispatcher.execute({ root, mainRoot: root, executionRoot: root,
        specId, flowManager: manager, flowState: state,
        expectBinding: FlowTargetBinding.capture({ flowState: state, mainRoot: root, authorityRoot: root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 0);
      assert.equal(providerCalls, 1);
      assert.equal(resumed.ok, false);
      assert.deepEqual(resumed.errors.map((entry) => entry.code), ["FLOW_DISPATCH_LIMIT_REACHED"],
        JSON.stringify(resumed.errors));
      assert.equal(resumed.data.dispatch.dispatchCount, 1);
      const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      assert.equal(reloaded.canonicalState(specId).nextAction().nodeId,
        phase === "questions" ? "draft-refine" : "draft-gate");
      // Audit the retained publication through the lock-scoped catalog. The
      // selected next Step is not necessarily an authorized Review reader.
      reloaded.readCanonicalTransitionView({ specId, read(view) {
        const sourceAfter = view.catalog.resolve(sourceBefore.descriptor.relativePath);
        assert.deepEqual(sourceAfter.toJSON(), sourceBefore.descriptor);
        assert.deepEqual(view.readCatalogedArtifact(sourceAfter), sourceBefore.bytes);
        const evidenceAfter = view.catalog.artifacts.filter((entry) => entry.logicalKey === "review.evidence");
        assert.equal(evidenceAfter.length, 1);
        assert.deepEqual(view.readCatalogedArtifact(evidenceAfter[0]), evidenceBytesBefore);
        // The terminal Step owns the same evidence bytes in its atomic
        // confirmation publication; validate the new owner and exact Attempt.
        const { activityId: previousOwner, ...before } = evidenceBefore[0].toJSON();
        const { activityId: currentOwner, ...after } = evidenceAfter[0].toJSON();
        assert.deepEqual(after, before);
        assert.notEqual(currentOwner, previousOwner);
        const completion = view.activities.find((entry) => entry.id === currentOwner);
        assert.equal(completion.transition.operation,
          phase === "questions" ? "confirm_attempt" : "complete_draft_completion");
        assert.deepEqual(completion.result.draftSettlementReceipt.binding,
          publication.result.draftSettlementReceipt.binding);
        assert.equal(completion.result.draftSettlementReceipt.resultKind, `draft-${phase}-review-passed`);
        if (phase === "coverage") {
          assert.equal(completion.transition.stepConnectionReceipt.sourceStepId, stepId);
          assert.equal(completion.transition.stepConnectionReceipt.targetStepId, "draft-gate");
          assert.equal(completion.result.draftSettlementReceipt.settlementKind, "target-connection");
        }
      } });
      assert.equal(publicationCount(), 1);
      assert.equal(reloaded.canonicalState(specId).findNode(stepId).status, "done");
    } finally {
      removeTmpDir(root);
    }
  });
}
