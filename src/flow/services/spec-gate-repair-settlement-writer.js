import { rethrowStepSettlementFailure } from "../lib/definition-lifecycle-failure.js";
import { FlowArtifactCatalogSnapshotLimits } from "../../lib/flow-version.js";

/** Exact handoff save capability; exposes no state or artifact reader. */
export class SpecGateRepairSettlementWriter {
  #ctx;
  #request;
  #binding;
  #preparation;
  #handoffCoordinator;
  #publication;
  #publicationReceipt;
  #publicationLimits;

  constructor({ ctx, request, binding, preparation, handoffCoordinator, publication, publicationReceipt,
    publicationLimits = new FlowArtifactCatalogSnapshotLimits() }) {
    if (!(publicationLimits instanceof FlowArtifactCatalogSnapshotLimits)) {
      throw new TypeError("Spec Gate repair settlement writer requires typed publication limits");
    }
    this.#ctx = ctx;
    this.#request = request;
    this.#binding = binding;
    this.#preparation = preparation;
    this.#handoffCoordinator = handoffCoordinator;
    this.#publication = publication;
    this.#publicationReceipt = publicationReceipt;
    this.#publicationLimits = publicationLimits;
  }

  settle(input, replayed = false) {
    const selected = { ...this.#publication, ...input, binding: this.#binding,
      publicationLimits: this.#publicationLimits };
    try {
      if (!replayed) this.#handoffCoordinator.faultInjector({
        phase: "before-worker-handoff-publication", stepId: "spec-gate-repair",
      });
    } catch (error) { rethrowStepSettlementFailure(error); }
    return this.#ctx.flowManager.commitSpecStepResult(selected);
  }

  settleDraftReturn(input) {
    return this.#ctx.flowManager.commitSpecStepResult({ ...input, binding: this.#binding,
      publicationLimits: this.#publicationLimits });
  }

  completeProgress(input) {
    return this.#ctx.flowManager.completeSpecGateRepairProgress({ ...input, binding: this.#binding,
      publicationLimits: this.#publicationLimits,
      publicationReceipt: this.#publicationReceipt });
  }

  completeHandoff(stepResult, receipt, replayed) {
    if (this.#request !== null) {
      return this.#handoffCoordinator.completeSpecWorkerHandoff({
        request: this.#request, preparation: this.#preparation,
        stepResult, receipt, replayed,
      });
    }
    this.#handoffCoordinator.cleanupCompletedSpecGateRepairHandoff({ ctx: this.#ctx, receipt });
    return { completed: true, replayed: true, stepId: this.#binding.stepId,
      stepResult, receipt, settlementReceipt: receipt };
  }
}
