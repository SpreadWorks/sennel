import assert from "node:assert/strict";
import { test } from "node:test";

import { draftStepRegistration, draftStepRegistrations } from "../../../src/flow/engine/composition/draft.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, FlowAtStepFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { ServiceBoundaryCoverage } from "../../support/structure/service-boundary.js";

test("every registered Draft Step Service has a real instance inspected for A07", async (t) => {
  const coverage = new ServiceBoundaryCoverage(draftStepRegistrations);
  const root = createTmpDir("draft-service-boundary-");
  t.after(() => removeTmpDir(root));
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const specId = "001-draft-service-boundary";
  new FlowAtStepFixture({
    flowManager, specId, runId: "run-draft-service-boundary",
    request: "Inspect registered Draft dependencies.", targetStep: "draft-refine",
  }).create();
  const binding = new DraftWorkerExecutionStepBinding({ flowManager, specId, stepId: "draft-refine" });
  const draft = await draftStepRegistration("draft-refine").create({
    flowManager, binding, executionBinding: null,
  });

  const reviewRoot = createTmpDir("review-service-boundary-");
  t.after(() => removeTmpDir(reviewRoot));
  const reviewSpecId = "002-review-service-boundary";
  const reviewManager = new FlowManager({ root: reviewRoot, mainRoot: reviewRoot, inWorktree: false, specId: reviewSpecId });
  const reviewFixture = new CanonicalFlowFixture({
    flowManager: reviewManager, specId: reviewSpecId, runId: "run-review-service-boundary",
    request: "Inspect registered Review dependencies.",
  }).create().registerActive().activate("draft");
  reviewManager.confirmCurrentAttempt({ specId: reviewSpecId, artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument())}\n`, "utf8"),
  }] });
  reviewFixture.activate("draft-questions-review");
  const source = new CanonicalDraftReviewSource({
    flowManager: reviewManager, state: reviewManager.canonicalState(reviewSpecId), phase: "draft-questions",
  });
  const commandResult = attachCanonicalCommandResultArtifact({
    result: "ok", artifacts: { phase: "draft-questions", verdict: "PASS" },
  }, {
    logicalKey: "draft.questions.review",
    payload: {
      version: 2, phase: "draft-questions", sourceDraft: "draft.json",
      sourceDraftRevision: source.revision(), generatedAt: "2026-09-20T00:00:00.000Z",
      verdict: "PASS", summary: "No blocking findings.", blockingFindings: [],
      advisoryFindings: [], repairTargets: [],
    },
  });
  const review = await draftStepRegistration("draft-questions-review").create({
    flowManager: reviewManager, state: reviewManager.canonicalState(reviewSpecId), commandResult,
  });

  const gateRoot = createTmpDir("gate-service-boundary-");
  t.after(() => removeTmpDir(gateRoot));
  const gateSpecId = "003-gate-service-boundary";
  const gateManager = new FlowManager({ root: gateRoot, mainRoot: gateRoot, inWorktree: false, specId: gateSpecId });
  const gateFixture = new CanonicalFlowFixture({
    flowManager: gateManager, specId: gateSpecId, runId: "run-gate-service-boundary",
    request: "Inspect registered Gate dependencies.",
  }).create().registerActive().activate("draft");
  gateManager.confirmCurrentAttempt({ specId: gateSpecId, artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument())}\n`, "utf8"),
  }] });
  gateFixture.activate("draft-gate");
  const result = new CanonicalGatePromotion({
    state: gateManager.canonicalState(gateSpecId), phase: "draft", nodeId: "draft-gate",
  }).promote({ result: "pass", artifacts: { phase: "draft", evaluations: [] } });
  const gate = await draftStepRegistration("draft-gate").create({
    ctx: { flowManager: gateManager, specId: gateSpecId }, result,
  });
  for (const prepared of [draft, review, gate]) {
    for (const [Dependency, instance] of prepared.dependencies) coverage.inspect(Dependency, instance);
  }
  const required = new Set(draftStepRegistrations.flatMap((registration) => registration.StepClass.dependencies));
  assert.equal(coverage.assertComplete(), required.size);
});
