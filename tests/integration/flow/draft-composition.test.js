import assert from "node:assert/strict";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { draftStepRegistration, prepareDraftReviewBinding } from "../../../src/flow/engine/composition/draft.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { workerStepExecutionContract } from "../../../src/flow/lib/worker-execution-admission.js";
import { DraftReviewExecutionTargetIdentity } from "../../../src/flow/definition.js";
import { DraftReviewConnector } from "../../../src/flow/engine/connectors/draft/draft-review-connector.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import { ReviewService } from "../../../src/flow/services/review-service.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { CanonicalFlowFixture, FlowAtStepFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { assertServiceBoundary } from "../../support/structure/service-boundary.js";

test("Draft production registration creates the declared Step with its exact Service", async () => {
  const root = createTmpDir("draft-composition-");
  try {
    const specId = "001-draft-composition";
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager, specId, runId: "run-draft-composition",
      request: "Create the registered Draft Step.", targetStep: "draft-refine",
    }).create();
    const binding = new DraftWorkerExecutionStepBinding({ flowManager, specId, stepId: "draft-refine" });
    const prepared = await draftStepRegistration("draft-refine").create({
      flowManager, binding, executionBinding: null,
    });
    assert.ok(prepared.step instanceof DraftRefineStep);
    assert.ok(prepared.dependency(DraftService) instanceof DraftService);
    assert.equal(prepared.dependencies.size, 1);
    assertServiceBoundary(prepared.dependency(DraftService));

    const registration = (prepareServiceArguments) => new StepRegistration({
      stepId: "draft-refine", StepClass: DraftRefineStep, ServiceClass: DraftService,
      prepareServiceArguments, executionContract: workerStepExecutionContract,
    });
    await assert.rejects(registration(() => []).create(), /exactly its declared Service arguments/);
    await assert.rejects(registration(() => [{}]).create(), /exactly its declared Service arguments/);
    await assert.rejects(registration(() => [new Date(), new Date()]).create(),
      /exactly its declared Service arguments/);
  } finally {
    removeTmpDir(root);
  }
});

for (const phase of ["draft-questions", "draft-coverage"]) {
  test(`Draft ${phase} Review registration reuses its supplied binding and refuses a stale Attempt`, async () => {
    const root = createTmpDir(`draft-${phase}-composition-`);
    const originalConnect = DraftReviewConnector.prototype.connect;
    try {
      const specId = `001-${phase}-composition`;
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const flow = new CanonicalFlowFixture({
        flowManager, specId, runId: `run-${phase}-composition`,
        request: "Review the canonical Draft.",
      }).create().registerActive();
      flow.activate("draft");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument())}\n`, "utf8"),
      }] });
      const stepId = `${phase}-review`;
      flow.activate(stepId);
      const state = flowManager.canonicalState(specId);
      const binding = await prepareDraftReviewBinding({ flowManager, state, phase });
      const executionBinding = flowManager.draftStepExecutionState({ binding }).reviewBinding({
        manifestDigest: "1".repeat(64), inputDigest: "2".repeat(64),
        target: new DraftReviewExecutionTargetIdentity({
          treeSha: "3".repeat(40), targetStateDigest: "4".repeat(64),
        }),
      });
      DraftReviewConnector.prototype.connect = () => {
        throw new Error("supplied Review binding must not reconnect");
      };
      const prepared = await draftStepRegistration(stepId).create({
        flowManager, binding, executionBinding,
      });
      DraftReviewConnector.prototype.connect = originalConnect;
      const service = prepared.dependency(ReviewService);
      assert.ok(service instanceof ReviewService);
      assert.equal(service.requiresReviewExecution(), true);

      flowManager.failCurrentAttempt({
        specId,
        failure: {
          category: "tooling", code: "CONCURRENT_REVIEW_FAILURE",
          message: "another execution stopped the review", retryable: false, retryKind: null,
        },
        result: {
          outcome: "failed", summary: "another execution stopped the review",
          confirmedAt: new Date().toISOString(), artifactRefs: [],
        },
      });
      const stopped = flowManager.canonicalState(specId).toJSON();
      await assert.rejects(draftStepRegistration(stepId).create({
        flowManager, binding, executionBinding,
      }), StepAdmissionRefusal);
      assert.deepEqual(flowManager.canonicalState(specId).toJSON(), stopped);
    } finally {
      DraftReviewConnector.prototype.connect = originalConnect;
      removeTmpDir(root);
    }
  });
}
