import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

import { draftStepRegistration, draftStepRegistrations } from "../../../src/flow/engine/composition/draft.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
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
  for (const [stepId, prepared] of [
    ["draft-refine", draft],
    ["draft-questions-review", review],
    ["draft-gate", gate],
  ]) coverage.inspectPrepared(draftStepRegistration(stepId), prepared);
  const inspected = new Set(["draft-refine", "draft-questions-review", "draft-gate"]);
  for (const registration of draftStepRegistrations.filter((candidate) => !inspected.has(candidate.stepId))) {
    const stepRoot = path.join(root, registration.stepId);
    fs.mkdirSync(stepRoot, { recursive: true });
    const stepSpecId = `004-${registration.stepId}-boundary`;
    const manager = new FlowManager({ root: stepRoot, mainRoot: stepRoot,
      inWorktree: false, specId: stepSpecId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId: stepSpecId, runId: `run-${registration.stepId}-boundary`,
      request: "Inspect every registered Draft preparation.",
    }).create().registerActive().activate("draft");
    if (registration.stepId !== "draft") {
      manager.confirmCurrentAttempt({ specId: stepSpecId, artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument())}\n`, "utf8"),
      }] });
    }
    let input;
    if (registration.stepId === "draft-gate-repair") {
      fixture.activate("draft-gate");
      new DraftGateRepairScenario({ flowManager: manager, root: stepRoot, specId: stepSpecId })
        .select({ issueLogId: `issue-${stepSpecId}`, observations: [{
          kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
          where: { file: "draft.json", locator: "goal" },
          observed: "The retained behavior must be explicit.", severity: "blocking", refs: ["R-1"],
        }] });
      input = { flowManager: manager, binding: new DraftWorkerExecutionStepBinding({
        flowManager: manager, specId: stepSpecId, stepId: registration.stepId,
      }), executionBinding: null };
    } else {
      if (["draft-questions-repair", "draft-coverage-repair"].includes(registration.stepId)) {
        const phase = registration.stepId === "draft-questions-repair" ? "questions" : "coverage";
        const triageStep = `draft-${phase}-triage`;
        fixture.activate(triageStep);
        manager.confirmCurrentAttempt({ specId: stepSpecId,
          commandResult: { result: "Prepared triage fixture." }, artifactWrites: [{
            logicalKey: `draft.${phase}.triage`, mediaType: "application/json",
            bytes: Buffer.from(`${JSON.stringify({ version: 1, phase: triageStep,
              sourceReview: `draft-review-${phase}.json`, summary: "No repair targets.", items: [] })}\n`, "utf8"),
          }],
        });
      }
      fixture.activate(registration.stepId);
      if (registration.ConnectorClass === null) {
        const state = manager.canonicalState(stepSpecId);
        const phase = "draft-coverage";
        const source = new CanonicalDraftReviewSource({ flowManager: manager, state, phase });
        const publicationResult = attachCanonicalCommandResultArtifact({ result: "ok" }, {
          logicalKey: "draft.coverage.review", payload: {
            version: 2, phase, sourceDraft: "draft.json", sourceDraftRevision: source.revision(),
            generatedAt: "2026-09-20T00:00:00.000Z", verdict: "PASS", summary: "No blocking findings.",
            blockingFindings: [], advisoryFindings: [], repairTargets: [],
          },
        });
        input = { flowManager: manager, state, publicationResult };
      } else {
        const ctx = { root: stepRoot, mainRoot: stepRoot, executionRoot: stepRoot,
          flowManager: manager, specId: stepSpecId };
        const handoffCoordinator = new WorkerArtifactHandoffCoordinator();
        const request = handoffCoordinator.createRequest({
          ctx, state: manager.loadReadOnly(stepSpecId), invocation: {
            id: `dispatch-${registration.stepId}`, target: { digest: "b".repeat(64) },
            action: { digest: "a".repeat(64), nextAction: { step: registration.stepId } },
          },
        });
        input = { ctx, request, handoffCoordinator };
      }
    }
    coverage.inspectPrepared(registration, await registration.create(input));
    inspected.add(registration.stepId);
  }
  assert.deepEqual([...inspected].sort(), draftStepRegistrations.map((registration) => registration.stepId).sort());
  const required = new Set(draftStepRegistrations.flatMap((registration) => registration.StepClass.dependencies));
  assert.equal(coverage.assertComplete(), required.size);
});
