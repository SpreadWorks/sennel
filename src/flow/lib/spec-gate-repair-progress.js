/** Canonical publication history for bounded Gate repair worker batches. */
import { readSpecGateRepairInput } from "./spec-gate-repair-input.js";
import { FlowFindingSourceIdentity } from "./flow-finding-source.js";
import { SpecGateRepairContextExpansion } from "./spec-gate-repair-context-expansion.js";
import { PromptRequestLimit, PromptExecutionLimit, PromptExecutionBudget,
  PromptResponseAllowance, PromptBatchingError } from "../../lib/prompt-batching.js";
import { isDeepStrictEqual } from "node:util";
import { DraftWorkerExecutionClaim } from "../definition.js";
import { SpecGateRepairSavedCallPlan, specGateRepairResponseCost,
  specGateRepairProgressMismatch as progressMismatch } from "./spec-gate-repair-call-plan.js";
import { freezeSpecGateRepairValue } from "./spec-gate-repair-selection.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";

const REPAIR_BUDGET_LIMIT = Object.freeze({ maxBatchCount: 16, maxProviderCallCount: 16,
  maxSynthesisCallCount: 16, maxAggregateCharacters: 1_000_000, maxAggregateItemCount: 100_000 });

/** One read boundary shares canonical observations; no cache survives the caller. */
class SpecGateRepairProgressReader {
  #flowManager;
  #specId;
  #attemptId;
  #consumerNodeId;
  #activities;
  #entries = new Map();

  constructor({ flowManager, specId, attemptId, consumerNodeId }) {
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#attemptId = attemptId;
    this.#consumerNodeId = consumerNodeId;
    this.#activities = new Map(flowManager.activityLedger(specId).map((activity) => [activity.id, activity]));
  }

  activities() { return [...this.#activities.values()]; }

  read(generation, phase) {
    const key = `${generation}:${phase}`;
    if (this.#entries.has(key)) return this.#entries.get(key);
    const flowManager = this.#flowManager;
    const specId = this.#specId;
    const attemptId = this.#attemptId;
    const consumerNodeId = this.#consumerNodeId;
    const artifact = flowManager.readArtifact({ specId, logicalKey: "spec.gate.repair.progress",
      consumerNodeId, parameters: { attemptId, generation: String(generation), phase } });
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
    const activity = this.#activities.get(artifact.descriptor.activityId);
    const receipt = activity?.result?.draftSettlementReceipt;
    const lifecycle = receipt?.executionLifecycle;
    if (saved.version !== 2 || saved.phase !== phase || saved.specId !== specId
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
    if (Object.keys(ceiling).some((field) => typeof limit[field] !== "number" || limit[field] > ceiling[field])) {
      throw progressMismatch("Gate repair progress relaxed its execution limits");
    }
    const callPlan = new SpecGateRepairSavedCallPlan({ plan: saved.plan, limit });
    const call = callPlan.currentCall(saved);
    if (phase === "checkpoint") {
      const previous = saved.generation === 0 ? null
        : this.read(saved.generation - 1, "publication");
      if (previous !== null && Object.keys(ceiling).some((field) => limit[field] > previous.limit[field])) {
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
        "requestDigest", "executionLocator", "actionFileDigest", "actionRepositoryFingerprint", "limit", "context", "plan", "callCost", "responseAllowance"];
      if (common.some((field) => !isDeepStrictEqual(saved[field], previous.document[field]))) {
        throw progressMismatch("Gate repair progress changed an immutable checkpoint contract");
      }
    }
    const result = Object.freeze({ document: freezeSpecGateRepairValue(saved), executionLocator, limit, budget, callPlan });
    this.#entries.set(key, result);
    return result;
  }
}

/** Read only the progress artifact belonging to the active canonical lifecycle. */
export function readSpecGateRepairExecutionProgress({ flowManager, state, lifecycle }) {
  const reader = new SpecGateRepairProgressReader({ flowManager, specId: state.specId,
    attemptId: state.attempt.id, consumerNodeId: "spec-gate-repair" });
  const progress = reader.read(lifecycle.executionGeneration, lifecycle.phase);
  if (progress.document.runId !== state.runId || progress.document.attemptSequence !== state.attempt.sequence
    || progress.document.inputDigest !== lifecycle.binding.inputDigest
    || progress.document.inputRevision !== lifecycle.binding.inputRevision) {
    throw progressMismatch("Gate repair saved execution differs from the active Attempt");
  }
  return progress;
}

export function latestRepairBudget({ flowManager, specId, attemptId, baseRevision, consumerNodeId }) {
  const prefix = `artifacts/spec-gate-repairs/${attemptId}/progress/`;
  const phaseOrder = { checkpoint: 0, claimed: 1, publication: 2 };
  const descriptor = flowManager.artifactCatalog(specId).artifacts
    .filter((entry) => entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.startsWith(prefix)
      && /\d+-(checkpoint|claimed|publication)\.json$/.test(entry.relativePath))
    .sort((a, b) => {
      const left = a.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/);
      const right = b.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/);
      if (left === null || right === null) throw progressMismatch("Gate repair budget has an invalid progress artifact");
      return Number(left[1]) - Number(right[1]) || phaseOrder[left[2]] - phaseOrder[right[2]];
    }).at(-1);
  if (descriptor === undefined) {
    const limit = new PromptExecutionLimit(REPAIR_BUDGET_LIMIT);
    return { limit, budget: new PromptExecutionBudget(limit) };
  }
  const [, generation, phase] = descriptor.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/) ?? [];
  if (generation === undefined) throw progressMismatch("Gate repair budget has an invalid claimed generation");
  const reader = new SpecGateRepairProgressReader({ flowManager, specId, attemptId, consumerNodeId });
  const progress = reader.read(generation, phase);
  if (progress.document.context?.baseRevision !== baseRevision) {
    throw progressMismatch("Gate repair budget checkpoint differs from the active revision");
  }
  return progress;
}

export const SPEC_GATE_REPAIR_REQUEST_LIMIT = new PromptRequestLimit({ maxCharacters: 100_000 });

class SpecGateRepairCompletedPublication {
  constructor({ completion, activityId, receipt }) {
    this.completion = Object.freeze(completion);
    this.activityId = activityId;
    this.receipt = receipt;
    Object.freeze(this);
  }
}

function completedRepairPublication({ flowManager, specId, attemptId, attemptSequence, runId, entry, activities }) {
  const artifact = flowManager.readArtifact({ specId, logicalKey: "spec.gate.repair.progress",
    consumerNodeId: "spec-gate-repair",
    parameters: { attemptId, generation: String(entry.generation), phase: "completed" }, optional: true });
  if (artifact === null) return null;
  const completion = JSON.parse(artifact.bytes.toString("utf8"));
  const settled = activities.find((activity) => activity.id === artifact.descriptor.activityId);
  const receipt = settled?.result?.draftSettlementReceipt;
  const publication = activities.find((activity) => (
    activity.result?.draftSettlementReceipt?.id === completion.publicationReceiptId
  ))?.result?.draftSettlementReceipt;
  if (completion.version !== 1 || completion.phase !== "completed"
    || completion.runId !== runId || completion.specId !== specId
    || completion.attemptId !== attemptId || completion.attemptSequence !== attemptSequence
    || completion.generation !== entry.generation
    || completion.requestDigest !== entry.requestDigest
    || completion.resultKind !== "spec-gate-repair-context-required"
    || receipt?.binding?.runId !== runId || receipt.binding.specId !== specId
    || receipt.binding.stepId !== "spec-gate-repair"
    || receipt.binding.attemptId !== attemptId || receipt.binding.attemptSequence !== attemptSequence
    || receipt.resultKind !== completion.resultKind || receipt.id === completion.publicationReceiptId
    || receipt.executionLifecycle?.phase !== "publication"
    || receipt.executionLifecycle.binding.executionGeneration !== entry.generation
    || receipt.executionLifecycle.binding.inputRevision !== entry.inputRevision
    || receipt.executionLifecycle.claim.requestDigest !== entry.requestDigest
    || publication?.binding?.runId !== runId || publication.binding.specId !== specId
    || publication.binding.stepId !== "spec-gate-repair"
    || publication.binding.attemptId !== attemptId || publication.binding.attemptSequence !== attemptSequence
    || publication.executionLifecycle?.phase !== "publication"
    || publication.executionLifecycle.binding.executionGeneration !== entry.generation
    || publication.executionLifecycle.binding.inputRevision !== entry.inputRevision
    || publication.executionLifecycle.claim.requestDigest !== entry.requestDigest) {
    throw new Error("Gate repair completion has no exact publication and Step receipt");
  }
  return new SpecGateRepairCompletedPublication({ completion, activityId: artifact.descriptor.activityId, receipt });
}

export function readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot,
  executionLifecycle = null, acceptedPublication = false }) {
  let source = readSpecGateRepairInput({ flowManager, state, executionRoot });
  const ledger = new SpecGateRepairProgressLedger({ flowManager, specId: state.specId,
    attemptId: state.attempt.id, baseRevision: source.baseRevision, executionLifecycle });
  const activeDraftReturn = ledger.publication?.proposal.stage === "spec-gate-repair-draft-return"
    || (acceptedPublication && ledger.entries.at(-1)?.proposal.stage === "spec-gate-repair-draft-return"
      && ledger.entries.at(-1).generation === ledger.activePublicationGeneration);
  // A Draft return consumes its current publication only. Prior locate batches
  // are bound by their canonical revision and exact location-plan batch digest;
  // only repair publications carry semantic content into new work.
  if (!activeDraftReturn && ledger.entries.some((entry) => (
    entry.context.mode !== "locate"
      && entry.context.evidenceDigest !== source.context.evidenceDigest
  ))) {
    throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
      "published Spec Gate repair evidence changed before further work",
      { retryable: false, recoveryPossible: false });
  }
  const locationPlan = source.context.unresolvedFindings().length > 0
    ? source.context.locationPlan({ limit: SPEC_GATE_REPAIR_REQUEST_LIMIT }) : null;
  const completedLocations = locationPlan === null ? [] : acceptedPublication
    ? ledger.acceptedLocationBatches(locationPlan) : ledger.completedLocationBatches(locationPlan);
  if (locationPlan !== null && completedLocations.length === locationPlan.batches.length) {
    const unresolved = new Set(source.context.unresolvedFindings().map((finding) => finding.identity.toString()));
    const resolved = source.context.resolveLocationBatches({ plan: locationPlan,
      responses: completedLocations.map((entry) => ({
        batchDigest: entry.context.batchDigest, baseRevision: entry.context.baseRevision,
        locations: entry.proposal.locations,
      })) });
    if (resolved.unresolvedFindings().length === 0) {
      source = readSpecGateRepairInput({ flowManager, state, executionRoot,
        locations: resolved.units().flatMap((unit) => unit.findings
          .filter((finding) => unresolved.has(finding.identity.toString()))
          .map((finding) => ({ identity: finding.identity.toJSON(), rangeIds: finding.rangeIds }))) });
    }
  }
  return Object.freeze({ source, ledger, locationPlan });
}

export class SpecGateRepairProgressLedger {
  constructor({ flowManager, specId, attemptId, baseRevision, executionLifecycle = null }) {
    if (typeof attemptId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseRevision)) {
      throw new TypeError("Gate repair progress requires its Attempt and revision");
    }
    const prefix = `artifacts/spec-gate-repairs/${attemptId}/progress/`;
    const descriptors = flowManager.artifactCatalog(specId).artifacts.filter((entry) => (
      entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.startsWith(prefix)
      && entry.relativePath.endsWith("-publication.json")
    ));
    const reader = new SpecGateRepairProgressReader({ flowManager, specId, attemptId,
      consumerNodeId: "spec-gate-repair" });
    const entries = descriptors.map((entry) => {
      const match = entry.relativePath.slice(prefix.length).match(/^(\d+)-publication\.json$/);
      if (match === null) throw new Error("Gate repair publication has an invalid generation path");
      const { document } = reader.read(match[1], "publication");
      if (document.version !== 2 || document.phase !== "publication"
        || document.attemptId !== attemptId
        || document.generation !== Number(match[1]) || document.context?.baseRevision !== baseRevision) {
        throw new Error("Gate repair publication differs from its canonical Attempt and revision");
      }
      return Object.freeze(document);
    }).sort((a, b) => a.generation - b.generation);
    const batchKeys = entries.map((entry) => JSON.stringify([
      entry.context.mode, entry.context.unitId ?? null,
      entry.context.batchDigest,
    ]));
    if (new Set(batchKeys).size !== batchKeys.length) throw new Error("Gate repair published a batch twice");
    // A response is validated against the input frontier of its exact claimed
    // generation. Its own publication advances future requests, not its replay.
    this.publication = null;
    if (executionLifecycle?.phase === "publication") {
      const saved = entries.at(-1);
      if (saved?.generation !== executionLifecycle.executionGeneration
        || saved.requestDigest !== executionLifecycle.claim.requestDigest
        || saved.inputRevision !== executionLifecycle.binding.inputRevision) {
        throw new Error("Gate repair publication differs from its current execution claim");
      }
      this.publication = saved;
    }
    this.entries = Object.freeze(this.publication === null ? entries : entries.slice(0, -1));
    const state = flowManager.canonicalState(specId);
    const activities = reader.activities();
    const completed = (entry) => completedRepairPublication({ flowManager, specId, attemptId,
      attemptSequence: state.attempt.sequence, runId: state.runId, entry, activities });
    this.completedLocations = Object.freeze(this.entries.filter((entry) => (
      entry.context.mode === "locate" && completed(entry) !== null
    )));
    const current = flowManager.readCurrentStepSettlement({ specId, stepId: "spec-gate-repair" });
    const activeLifecycle = current?.receipt.executionLifecycle;
    const active = activeLifecycle?.phase === "publication" && current.receipt.binding.attemptId === attemptId
      ? entries.find((entry) => entry.generation === activeLifecycle.binding.executionGeneration) : null;
    if (active !== null && active !== undefined && (active.requestDigest !== activeLifecycle.claim.requestDigest
      || active.inputRevision !== activeLifecycle.binding.inputRevision)) {
      throw new Error("Gate repair active publication differs from its exact Step receipt");
    }
    this.activePublicationGeneration = active?.generation ?? null;
    this.completion = null;
    if (executionLifecycle?.phase === "publication") {
      const saved = completed(this.publication);
      if (saved !== null) {
        const { completion } = saved;
        const current = flowManager.readCurrentStepSettlement({ specId, stepId: "spec-gate-repair" });
        if (current?.activityId !== saved.activityId
          || current.receipt.id !== saved.receipt.id
          || current.result.kind !== completion.resultKind
          || completion.requestDigest !== executionLifecycle.claim.requestDigest) {
          throw new Error("Gate repair completion has no exact publication and Step receipt");
        }
        this.completion = Object.freeze(completion);
      }
    }
    Object.freeze(this);
  }

  forMode(mode) { return this.entries.filter((entry) => entry.context.mode === mode); }

  completedLocationBatches(plan) {
    if (plan === null) return Object.freeze([]);
    const matched = this.completedLocations.filter((entry) => {
      const batch = plan.batches[entry.context.batchIndex];
      return batch?.digest === entry.context.batchDigest && entry.context.batchCount === plan.batches.length;
    });
    if (new Set(matched.map((entry) => entry.context.batchIndex)).size !== matched.length) {
      throw new Error("Gate repair location plan has duplicate completed batches");
    }
    return Object.freeze(matched.sort((a, b) => a.context.batchIndex - b.context.batchIndex));
  }

  acceptedLocationBatches(plan) {
    const completed = this.completedLocationBatches(plan);
    if (plan === null) return completed;
    const active = this.entries.find((entry) => entry.generation === this.activePublicationGeneration
      && entry.context.mode === "locate" && plan.batches[entry.context.batchIndex]?.digest === entry.context.batchDigest
      && entry.context.batchCount === plan.batches.length);
    return active === undefined || completed.includes(active) ? completed
      : Object.freeze([...completed, active].sort((a, b) => a.context.batchIndex - b.context.batchIndex));
  }

  groups() { return this.forMode("repair")
    .filter((entry) => entry.proposal.stage === "spec-gate-repair")
    .flatMap((entry) => entry.proposal.groups); }

  additionalRangeIds(context, unitId, { beforeGeneration = Infinity } = {}) {
    let ids = [];
    for (const entry of this.entries) {
      if (entry.generation >= beforeGeneration
        || entry.proposal.stage !== "spec-gate-repair-context-request"
        || entry.proposal.unitId !== unitId) continue;
      ids = new SpecGateRepairContextExpansion({ context, unitId,
        baseRevision: entry.proposal.baseRevision,
        requestedRangeIds: entry.proposal.additionalRangeIds,
        previousRangeIds: ids }).additionalRangeIds;
    }
    return ids;
  }

  completedUnitIds(context) {
    const units = context.units();
    const unitByIdentities = new Map(units.map((unit) => [
      JSON.stringify(unit.findings.map((finding) => finding.identity.toString()).sort()), unit.id,
    ]));
    const ids = this.groups().map((group) => {
      const key = JSON.stringify(group.findingIdentities.map((identity) => (
        new FlowFindingSourceIdentity(identity).toString()
      )).sort());
      const unitId = unitByIdentities.get(key);
      if (unitId === undefined) throw new Error("Gate repair publication has a foreign atomic unit");
      return unitId;
    });
    if (new Set(ids).size !== ids.length) throw new Error("Gate repair published an atomic unit twice");
    return Object.freeze(ids);
  }
}
