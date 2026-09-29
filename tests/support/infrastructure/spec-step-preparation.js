import fs from "node:fs";
import path from "node:path";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecReviewStepBinding, SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalSpecReview } from "../../../src/flow/lib/spec-review-artifacts.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario, prepareSpecGateRepairHandoffInput } from "./spec-gate-repair-scenario.js";
import { FlowAtStepFixture } from "./flow-setup.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec, workerArtifactJson } from "./worker-artifact.js";
import { removeTmpDir } from "../builders/tmp-dir.js";
import { ReviewWorkUnitManifest, ReviewWorkUnitOutput } from "../../../src/flow/lib/review-work-unit-values.js";
import { DraftReviewExecutionTargetIdentity } from "../../../src/flow/definition.js";

/** Canonical inputs for every registered Spec Step preparation contract. */
export class SpecStepPreparationFixture {
  #ownedRoots = [];

  constructor(root) { this.root = root; }

  dispose() {
    for (const root of this.#ownedRoots) removeTmpDir(root);
    this.#ownedRoots = [];
  }

  async createInput(stepId) {
    if (stepId === "spec-gate-repair") {
      const scenario = await createSpecGateRepairScenario();
      this.#ownedRoots.push(scenario.root);
      return prepareSpecGateRepairHandoffInput({
        ctx: scenario.ctx, invocation: scenario.invocation,
        coordinator: scenario.coordinator, replacement: "Corrected requirement text.",
      });
    }
    if (!["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate"].includes(stepId)) {
      throw new Error(`Spec preparation has no input for registered Step ${stepId}`);
    }
    const root = path.join(this.root, stepId);
    fs.mkdirSync(root, { recursive: true });
    const specId = `001-${stepId}-boundary`;
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new FlowAtStepFixture({
      flowManager, specId, runId: `run-${stepId}-boundary`,
      request: "Inspect a prepared Spec dependency.", targetStep: stepId,
      specRecord: validWorkerHandoffSpec(),
    }).create();
    const ctx = { root, executionRoot: root, mainRoot: root, specId, flowManager };

    if (stepId === "spec-review") {
      const state = flowManager.canonicalState(specId);
      const binding = new SpecReviewStepBinding({ flowManager, specId });
      const manifest = new ReviewWorkUnitManifest({
        version: 1, runId: state.runId, specId, phase: "spec", taskId: null,
        nodeId: stepId, attemptId: state.attempt.id,
        target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
        inputs: [], output: ReviewWorkUnitOutput.forReview({ phase: "spec" }).toJSON(),
      });
      const executionBinding = flowManager.draftStepExecutionState({ binding }).reviewBinding({
        manifestDigest: manifest.digest, inputDigest: manifest.inputDigest,
        target: new DraftReviewExecutionTargetIdentity(manifest.target.toJSON()),
      });
      return { request: { stepId }, input: {
        flowManager, binding, executionBinding, manifest,
      } };
    }
    if (stepId === "spec-gate") {
      const binding = new SpecGateEvaluationBinding({ flowManager, specId });
      const commandResult = new CanonicalGatePromotion({
        state: flowManager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
      }).promote({ result: "pass", artifacts: { phase: "spec", evaluations: [] } });
      return { request: { stepId }, input: { flowManager, binding, commandResult } };
    }

    const handoffCoordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const request = handoffCoordinator.createRequest({
      ctx, state: flowManager.load(specId),
      invocation: {
        id: `dispatch-${stepId}-boundary`, target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: stepId } },
      },
    });
    if (stepId === "spec") {
      fs.writeFileSync(request.payloadPath("spec.json"), workerArtifactJson(validWorkerHandoffTaskSpec()));
    } else {
      const review = new CanonicalSpecReview(request.inputs.find((entry) => entry.name === "review.json").document);
      fs.writeFileSync(request.payloadPath("review.delta.json"), workerArtifactJson({
        version: 2, stage: stepId, identity: review.identity.toJSON(),
        baseReviewDigest: review.digest, findings: [], operations: [],
      }));
    }
    sealWorkerArtifactHandoff({
      requestPath: request.requestPath, invocationId: request.dispatchInvocationId,
      now: () => new Date("2026-08-04T00:00:01.000Z"),
    });
    return { request, input: { ctx, request, Connector: SpecEntryConnector, handoffCoordinator } };
  }
}
