import fs from "node:fs";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowAtStepFixture } from "./flow-setup.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "./worker-artifact.js";

/** Build the initial Spec handoff through canonical Flow state and the production preparation API. */
export class SpecStepPreparationFixture {
  constructor(root) {
    this.root = root;
    this.specId = "001-spec-boundary";
    this.flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: this.specId });
    new FlowAtStepFixture({
      flowManager: this.flowManager, specId: this.specId, runId: "run-spec-boundary",
      request: "Inspect a prepared Spec dependency.", targetStep: "spec",
    }).create();
    this.ctx = { root, executionRoot: root, mainRoot: root, specId: this.specId, flowManager: this.flowManager };
    this.coordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });
  }

  createInput() {
    const request = this.coordinator.createRequest({
      ctx: this.ctx, state: this.flowManager.load(this.specId),
      invocation: {
        id: "dispatch-spec-boundary", target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "spec" } },
      },
    });
    fs.writeFileSync(request.payloadPath("spec.json"), workerArtifactJson(validWorkerHandoffTaskSpec()));
    sealWorkerArtifactHandoff({
      requestPath: request.requestPath, invocationId: request.dispatchInvocationId,
      now: () => new Date("2026-08-04T00:00:01.000Z"),
    });
    return {
      request,
      input: { ctx: this.ctx, request, Connector: SpecEntryConnector, handoffCoordinator: this.coordinator },
    };
  }
}
