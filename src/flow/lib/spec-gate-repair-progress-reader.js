import { PromptExecutionLimit, PromptExecutionBudget, PromptResponseAllowance, PromptBatchingError } from "../../lib/prompt-batching.js";
import { isDeepStrictEqual } from "node:util";
import { DraftWorkerExecutionClaim } from "../definition.js";
import { SpecGateRepairSavedCallPlan, specGateRepairResponseCost,
  specGateRepairProgressMismatch as progressMismatch } from "./spec-gate-repair-call-plan.js";
import { freezeSpecGateRepairValue } from "./spec-gate-repair-selection.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { readSpecGateRepairSourceSnapshots, assertSpecGateRepairSelectedSources } from "./spec-gate-repair-source-storage.js";
import { SpecGateRepairInputDescriptor } from "./spec-gate-repair-input-descriptor.js";
import { SpecGateRepairSelectedInputIdentity } from "./spec-gate-repair-input-unavailable.js";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";
import { specGateRepairInputFormatUnavailable } from "./worker-artifact-input-format.js";

export const SPEC_GATE_REPAIR_PROGRESS_VERSION = 4;

export const REPAIR_BUDGET_LIMIT = Object.freeze({ maxBatchCount: 16, maxProviderCallCount: 16,
  maxSynthesisCallCount: 16, maxAggregateCharacters: null, maxAggregateItemCount: 100_000 });

/** One read boundary shares canonical observations; no cache survives the caller. */
export class SpecGateRepairProgressReader {
  #flowManager;
  #specId;
  #attemptId;
  #consumerNodeId;
  #activities = new Map();
  #view = null;
  #entries = new Map();

  constructor({ flowManager, specId, attemptId, consumerNodeId }) {
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#attemptId = attemptId;
    this.#consumerNodeId = consumerNodeId;
  }

  activities() {
    if (this.#activities.size === 0) this.#flowManager.readCanonicalTransitionView({ specId: this.#specId,
      read: (view) => this.#setActivities(view) });
    return [...this.#activities.values()];
  }

  #setActivities(view) {
    this.#activities = new Map(view.activities.map((activity) => {
      const value = activity.toJSON();
      return [value.id, value];
    }));
  }

  read(generation, phase) {
    if (this.#view === null) {
      return this.#flowManager.readCanonicalTransitionView({ specId: this.#specId, read: (view) => {
        this.#view = view;
        this.#setActivities(view);
        this.#entries.clear();
        try { return this.read(generation, phase); } finally { this.#view = null; }
      } });
    }
    const key = `${generation}:${phase}`;
    if (this.#entries.has(key)) return this.#entries.get(key);
    const flowManager = this.#flowManager;
    const specId = this.#specId;
    const attemptId = this.#attemptId;
    const consumerNodeId = this.#consumerNodeId;
    const artifact = flowManager.readArtifact({ specId, logicalKey: "spec.gate.repair.progress",
      consumerNodeId, parameters: { attemptId, generation: String(generation), phase }, view: this.#view });
    try {
      return this.#restore(artifact, generation, phase, key);
    } catch (error) {
      if (error instanceof WorkerArtifactHandoffError) throw error;
      if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError
        || error instanceof PromptBatchingError) {
        throw progressMismatch("Gate repair saved progress contains an invalid serialized contract");
      }
      throw error;
    }
  }

  #restore(artifact, generation, phase, key) {
    const specId = this.#specId;
    const attemptId = this.#attemptId;
    const saved = JSON.parse(artifact.bytes.toString("utf8"));
    if (saved.version !== SPEC_GATE_REPAIR_PROGRESS_VERSION || saved.sourceSnapshotReference === undefined || Object.hasOwn(saved, "sourceSnapshots")
      || !Array.isArray(saved.inputDescriptors)
      || saved.inputDescriptors.some((input) => input.descriptor === undefined)) {
      throw specGateRepairInputFormatUnavailable("Saved unfinished Gate repair has no current immutable input descriptor");
    }
    let sourceSnapshots;
    try {
      if (!isDeepStrictEqual(saved.sourceSnapshotReference, saved.context?.sourceSnapshotReference)) {
        throw new TypeError("Repair source reference differs from its immutable selected input");
      }
      sourceSnapshots = readSpecGateRepairSourceSnapshots({ flowManager: this.#flowManager,
        specId, consumerNodeId: this.#consumerNodeId, reference: saved.sourceSnapshotReference,
        progressActivityId: artifact.descriptor.activityId, view: this.#view, activities: this.#activities });
      assertSpecGateRepairSelectedSources(saved.context, sourceSnapshots);
    } catch (error) {
      throw progressMismatch(`Gate repair saved source publication is invalid: ${error.message}`);
    }
    if (saved.inputDescriptors.length !== 1) throw specGateRepairInputFormatUnavailable("Saved Gate repair requires one exact input descriptor");
    const descriptor = SpecGateRepairInputDescriptor.fromJSON(saved.inputDescriptors[0].descriptor);
    descriptor.assertInput(saved.inputDescriptors[0]);
    const locator = descriptor.canonicalLocator;
    if (locator.attemptId !== attemptId || locator.attemptSequence !== saved.attemptSequence
      || locator.generation !== saved.generation || descriptor.selectedIdentity.baseRevision !== saved.context.baseRevision) {
      throw specGateRepairInputFormatUnavailable("Saved Gate repair input descriptor has a foreign revision or Attempt");
    }
    const selectedIdentity = SpecGateRepairSelectedInputIdentity.selectionFromDocument(saved.context, descriptor.selectionDigest);
    if (!isDeepStrictEqual(descriptor.selectedIdentity.toJSON(), selectedIdentity.toJSON())) {
      throw specGateRepairInputFormatUnavailable("Saved Gate repair input descriptor has foreign units or finding identities");
    }
    descriptor.assertBytes(Buffer.from(workerArtifactStableStringify(saved.context), "utf8"));
    const activity = this.#activities.get(artifact.descriptor.activityId);
    const receipt = activity?.result?.draftSettlementReceipt;
    const lifecycle = receipt?.executionLifecycle;
    if (saved.phase !== phase || saved.specId !== specId
      || saved.attemptId !== attemptId || saved.generation !== Number(generation)
      || receipt?.binding?.runId !== saved.runId || receipt.binding.specId !== specId
      || receipt.binding.stepId !== "spec-gate-repair" || receipt.binding.attemptId !== attemptId
      || receipt.binding.attemptSequence !== saved.attemptSequence || lifecycle?.phase !== phase
      || lifecycle.binding.executionGeneration !== saved.generation
      || lifecycle.binding.inputDigest !== saved.inputDigest || lifecycle.binding.inputRevision !== saved.inputRevision
      || typeof saved.actionFileDigest !== "string" || !/^[a-f0-9]{64}$/.test(saved.actionFileDigest)
      || !Object.hasOwn(saved, "actionRepositoryFingerprint")
      || saved.actionRepositoryFingerprint !== null
        && (typeof saved.actionRepositoryFingerprint !== "string" || saved.actionRepositoryFingerprint.trim() === "")) {
      throw progressMismatch("Gate repair progress differs from its exact canonical receipt");
    }
    if (saved.executionLocator === null || typeof saved.executionLocator !== "object"
      || Object.keys(saved.executionLocator).sort().join(",") !== "actionDigest,dispatchInvocationId,generatedAt,kind,requestDigest") {
      throw progressMismatch("Gate repair execution locator has an invalid shape");
    }
    const executionLocator = new DraftWorkerExecutionClaim(saved.executionLocator);
    if (!isDeepStrictEqual(saved.executionLocator, executionLocator.toJSON())
      || executionLocator.requestDigest !== saved.requestDigest
      || (phase !== "checkpoint" && !isDeepStrictEqual(lifecycle.claim, executionLocator.toJSON()))) {
      throw progressMismatch("Gate repair progress locator differs from its canonical claim");
    }
    const ceiling = new PromptExecutionLimit(REPAIR_BUDGET_LIMIT);
    if (saved.limit === null || typeof saved.limit !== "object" || Array.isArray(saved.limit)
      || Object.keys(saved.limit).sort().join(",") !== Object.keys(ceiling).sort().join(",")) {
      throw progressMismatch("Gate repair progress execution limits have an invalid shape");
    }
    const limit = new PromptExecutionLimit(saved.limit);
    if (!limit.isWithin(ceiling)) {
      throw progressMismatch("Gate repair progress relaxed its execution limits");
    }
    const callPlan = new SpecGateRepairSavedCallPlan({ plan: saved.plan, limit });
    const call = callPlan.currentCall(saved);
    if (phase === "checkpoint") {
      const previous = saved.generation === 0 ? null
        : this.read(saved.generation - 1, "publication");
      if (previous !== null && !previous.limit.canContinueWith(limit)) {
        throw progressMismatch("Gate repair checkpoint expanded its durable execution limits");
      }
      const frontier = previous?.budget ?? new PromptExecutionBudget(limit);
      if (!isDeepStrictEqual(frontier.snapshot(), saved.plan.budgetFrontier)) {
        throw progressMismatch("Gate repair call plan changed its canonical budget frontier");
      }
    }
    const expected = PromptExecutionBudget.fromSnapshot(limit, saved.plan.budgetFrontier);
    expected.consumeAggregate(call.callCost);
    if (call.synthesisCallCount > 0) expected.consumeSynthesisCalls(call.synthesisCallCount);
    if (phase !== "checkpoint") expected.consumeProviderCall();
    if (phase === "publication") {
      const responseCost = PromptResponseAllowance.fromJSON(saved.responseCost);
      if (!isDeepStrictEqual(responseCost.toJSON(), specGateRepairResponseCost(saved.context, saved.proposal).toJSON())
        || responseCost.characters > call.responseAllowance.characters || responseCost.items > call.responseAllowance.items) {
        throw progressMismatch("Gate repair publication exceeds its saved response allowance");
      }
      expected.consumeAggregate(responseCost);
    }
    const budget = PromptExecutionBudget.fromSnapshot(limit, saved.budget);
    if (!isDeepStrictEqual(budget.snapshot(), expected.snapshot())) {
      throw progressMismatch("Gate repair progress budget differs from its exact consumed costs");
    }
    if (phase !== "checkpoint") {
      const previous = this.read(generation, phase === "claimed" ? "checkpoint" : "claimed");
      const common = ["runId", "specId", "attemptId", "attemptSequence", "generation", "inputDigest", "inputRevision",
        "requestDigest", "executionLocator", "actionFileDigest", "actionRepositoryFingerprint", "limit", "context", "sourceSnapshotReference", "inputDescriptors", "plan", "callCost", "responseAllowance", "physicalPromptFootprint", "deliveryMode"];
      if (common.some((field) => !isDeepStrictEqual(saved[field], previous.document[field]))) {
        throw progressMismatch("Gate repair progress changed an immutable checkpoint contract");
      }
    }
    const result = Object.freeze({ document: freezeSpecGateRepairValue(saved), executionLocator,
      sourceSnapshots, limit, budget, callPlan });
    this.#entries.set(key, result);
    return result;
  }
}
