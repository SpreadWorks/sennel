import { PromptLogicalFootprint, PromptFixedContextTooLargeFailure, PromptBatchCountExceededFailure } from "../../../lib/prompt-batching.js";
import { PreparedStepReplay } from "./step-registration.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { SpecWorkerStepBinding } from "../connectors/spec/spec-step-binding.js";
import { DraftWorkerExecutionClaim, settleSpecStepResult as selectSettlement } from "../../definition.js";
import { SpecGateRepairContextRequiredResult } from "../step-result.js";
import { SpecGateRepairWorkerFacts, SpecGateRepairContinuationFacts } from "../../lib/spec-gate-repair-worker-facts.js";
import { readProgressBoundSpecGateRepairInput, SPEC_GATE_REPAIR_REQUEST_LIMIT, latestRepairBudget } from "../../lib/spec-gate-repair-progress.js";
import { readSpecGateRepairInput } from "../../lib/spec-gate-repair-input.js";
import { nextSpecGateRepairEvidence, SpecGateRepairContextExpansion } from "../../lib/spec-gate-repair-evidence.js";
import { canonicalWorkerExecutionClaimForStored, WorkerArtifactHandoffError } from "../../lib/worker-artifact-handoff.js";
import { isDeepStrictEqual } from "node:util";
import { SpecGateRepairServiceInput } from "../../services/spec-gate-repair-service.js";
import { SpecGateRepairSettlementWriter } from "../../services/spec-gate-repair-settlement-writer.js";

function progressWrite(binding, generation, phase, document) {
  return { logicalKey: "spec.gate.repair.progress",
    parameters: { attemptId: binding.attempt.id, generation: String(generation), phase },
    mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8") };
}

function changedLocationPlanError({ stepId, attemptId, context, locationPlan }) {
  if (context?.mode !== "locate") return null;
  const batch = locationPlan?.batches[context.batchIndex];
  if (batch?.digest === context.batchDigest) return null;
  return new WorkerArtifactHandoffError("recovery-required", "FLOW_SPEC_GATE_REPAIR_PLAN_CHANGED",
    "saved Spec Gate repair location batch differs from the current frozen plan",
    { recoveryPossible: false, data: { stepId, attemptId,
      baseRevision: context.baseRevision, batchIndex: context.batchIndex,
      savedBatchDigest: context.batchDigest, currentBatchDigest: batch?.digest ?? null } });
}

class SpecGateRepairPublishedDecision {
  constructor({ source, ledger, refreshed, proposal, contextMode }) {
    const continuation = new SpecGateRepairContinuationFacts({ input: refreshed.source,
      ledger: refreshed.ledger, locationPlan: refreshed.locationPlan, proposal });
    const intermediate = continuation.unresolvedLocationCount > 0
      || contextMode === "evidence" || continuation.draftReturnRequired
      || continuation.additionalContextRequested || continuation.completedUnitCount < continuation.unitCount;
    this.facts = new SpecGateRepairWorkerFacts({ input: source, proposal: intermediate
      ? proposal : { ...proposal, groups: [...ledger.groups(), ...proposal.groups] } });
    this.continuation = intermediate ? continuation : null;
    Object.freeze(this);
  }
}

function serviceArguments({ ctx, request, binding, preparation, handoffCoordinator,
  facts = preparation?.facts ?? null, continuation = null, publicationReceipt = null }) {
  binding.assertCurrent();
  const input = new SpecGateRepairServiceInput({ facts, continuation,
    attemptId: binding.attempt.id,
    attemptSequence: binding.attempt.sequence });
  return [input, new SpecGateRepairSettlementWriter({ ctx, request, binding,
    preparation, handoffCoordinator, publicationReceipt,
    publication: preparation?.settlementPublication(handoffCoordinator.now) ?? {} })];
}

export async function preparePublishedSpecGateRepairArguments({ ctx, state: requestedState, handoffCoordinator }) {
  const state = ctx.flowManager.canonicalState(requestedState.specId);
  const execution = ctx.flowManager.draftStepExecutionState({ binding: {
    runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt,
  } });
  if (execution.lifecycle?.phase !== "publication") throw new Error("Gate repair has no published response to resume");
  const { source, ledger } = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
    state, executionRoot: ctx.executionRoot || ctx.root, executionLifecycle: execution.lifecycle });
  const saved = ledger.publication;
  if (saved === null || ledger.completion !== null) throw new Error("Gate repair response is already completed or unavailable");
  if (saved.context.evidenceDigest !== source.context.evidenceDigest) {
    throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
      "published Spec Gate repair evidence changed before replay",
      { retryable: false, recoveryPossible: false });
  }
  const binding = new SpecWorkerStepBinding({ flowManager: ctx.flowManager,
    specId: state.specId, revision: source.baseRevision });
  const refreshed = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
    state, executionRoot: ctx.executionRoot || ctx.root, acceptedPublication: true });
  const { facts, continuation } = new SpecGateRepairPublishedDecision({ source, ledger, refreshed,
    proposal: saved.proposal, contextMode: saved.context.mode });
  return serviceArguments({ ctx, request: null, binding, preparation: null,
    facts, handoffCoordinator, continuation,
    publicationReceipt: ctx.flowManager.readCurrentStepSettlement({
      specId: state.specId, stepId: "spec-gate-repair",
    }).receipt });
}

/** The claimed budget is committed before a provider-visible call. */
export function reserveSpecGateRepairWorkerCall({ ctx, request, prompt }) {
  const binding = new SpecWorkerStepBinding({ request });
  const flowManager = ctx.flowManager;
  const { limit, budget } = latestRepairBudget({ flowManager, specId: binding.specId,
    attemptId: binding.attempt.id, baseRevision: request.inputs.find((entry) => (
      entry.name === "spec-gate-repair-context.json"
    ))?.document?.baseRevision, consumerNodeId: binding.stepId });
  // Immutable file inputs are bounded in bytes by WorkerArtifactInputSnapshot.
  // Count their decoded documents only in the aggregate character budget; they
  // do not occupy the provider instruction/argv character budget.
  const inputCharacters = request.inputs.reduce((total, input) => total + JSON.stringify(input.document).length, 0);
  const instructionCharacters = PromptLogicalFootprint.measure(prompt).total;
  if (typeof prompt !== "string" || instructionCharacters > limit.maxRequestCharacters) {
    throw new PromptFixedContextTooLargeFailure("Spec Gate repair instructions exceed their durable character limit",
      { actualCharacters: instructionCharacters, maximumCharacters: limit.maxRequestCharacters });
  }
  const selectedContext = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json")?.document;
  const state = flowManager.canonicalState(binding.specId);
  const { ledger, locationPlan } = readProgressBoundSpecGateRepairInput({ flowManager,
    state, executionRoot: request.executionRoot });
  let requiredCalls = 1;
  if (selectedContext.mode === "locate") {
    requiredCalls = locationPlan.batches.length - ledger.completedLocationBatches(locationPlan).length + 1;
  } else if (selectedContext.mode === "evidence") {
    const completed = ledger.entries.filter((entry) => entry.context.mode === "evidence"
      && entry.context.unitId === selectedContext.unitId
      && entry.context.evidenceContextDigest === selectedContext.evidenceContextDigest
      && entry.context.evidenceDepth === selectedContext.evidenceDepth);
    requiredCalls = selectedContext.batchCount - completed.length + 1;
  } else if (selectedContext.mode === "repair") {
    requiredCalls = selectedContext.batchCount;
  }
  budget.assertCanExecute(requiredCalls);
  if (budget.providerCallCount + 1 > limit.maxBatchCount) {
    throw new PromptBatchCountExceededFailure("Spec Gate repair exceeds its durable batch limit",
      { batchCount: budget.providerCallCount + 1, maxBatchCount: limit.maxBatchCount });
  }
  if (selectedContext?.mode === "evidence" && selectedContext.evidenceDepth > 0) {
    budget.consumeSynthesisCalls(1);
  }
  budget.consumeAggregate({ characters: instructionCharacters + inputCharacters,
    items: request.inputs.length + 1 });
  const execution = flowManager.draftStepExecutionState({ binding });
  const executionBinding = execution.workerBinding({
    inputDigest: request.inputDigest, inputRevision: request.inputRevision,
  });
  const stepResult = new SpecGateRepairContextRequiredResult();
  const settlement = selectSettlement(binding.stepId, stepResult);
  const base = { version: 1, attemptId: binding.attempt.id,
    inputRevision: request.inputRevision, requestDigest: request.requestDigest,
    limit: { ...limit }, generation: executionBinding.executionGeneration,
    context: selectedContext };
  flowManager.checkpointDraftStepExecution({ binding, stepResult, settlement, executionBinding,
    artifactWrites: [progressWrite(binding, executionBinding.executionGeneration, "checkpoint",
      { ...base, phase: "checkpoint", budget: budget.snapshot() })] });
  budget.consumeProviderCall();
  const claim = new DraftWorkerExecutionClaim({
    dispatchInvocationId: request.dispatchInvocationId,
    generatedAt: request.generatedAt,
    actionDigest: request.actionDigest,
    requestDigest: request.requestDigest,
  });
  flowManager.claimDraftStepExecution({ binding, stepResult, settlement, executionBinding,
    executionClaim: claim,
    artifactWrites: [progressWrite(binding, executionBinding.executionGeneration, "claimed",
      { ...base, phase: "claimed", budget: budget.snapshot() })] });
}

export async function prepareSpecGateRepairServiceArguments({ ctx, request, handoffCoordinator }, ConnectorClass) {
  if (request === undefined) return preparePublishedSpecGateRepairArguments({ ctx, state: ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId), handoffCoordinator });
  let preparation;
  try {
    preparation = handoffCoordinator.prepareSpecWorker({ ctx, request });
  } catch (error) {
    // A saved locate request can become stale when a newer frozen context
    // resolves its ordinal path. Classify that exact old plan before the
    // generic stale handoff path records an issue-log mutation.
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json")?.document;
    if (!(error instanceof WorkerArtifactHandoffError)
      || error.code !== "FLOW_ARTIFACT_HANDOFF_STALE" || context?.mode !== "locate") throw error;
    const lifecycle = canonicalWorkerExecutionClaimForStored({ flowManager: ctx.flowManager, stored: request });
    if (lifecycle === null) throw error;
    const canonical = ctx.flowManager.canonicalState(request.specId);
    let source;
    try {
      source = readSpecGateRepairInput({ flowManager: ctx.flowManager, state: canonical,
        executionRoot: request.executionRoot });
    } catch (sourceError) {
      if (sourceError instanceof CurrentFlowStateConflictError) throw error;
      throw sourceError;
    }
    if (context.baseRevision !== source.baseRevision) throw error;
    const { locationPlan } = readProgressBoundSpecGateRepairInput({
      flowManager: ctx.flowManager, state: canonical,
      executionRoot: request.executionRoot, executionLifecycle: lifecycle,
    });
    throw changedLocationPlanError({ stepId: request.stepId, attemptId: canonical.attempt.id,
      context, locationPlan }) ?? error;
  }
  if (preparation.completed) return new PreparedStepReplay(preparation);
  const binding = await new ConnectorClass(request).connect();
  const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json")?.document;
  const lifecycle = canonicalWorkerExecutionClaimForStored({ flowManager: ctx.flowManager, stored: request });
  if (lifecycle === null) throw new Error("Spec Gate repair response lacks its exact durable worker claim");
  const { source, ledger, locationPlan } = readProgressBoundSpecGateRepairInput({
    flowManager: ctx.flowManager, state: ctx.flowManager.canonicalState(binding.specId),
    executionRoot: request.executionRoot, executionLifecycle: lifecycle,
  });
  if (context?.baseRevision !== source.baseRevision) {
    throw new Error("Spec Gate repair response differs from its selected context revision");
  }
  if (context.evidenceDigest !== source.context.evidenceDigest) {
    throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
      "Spec Gate repair worker context changed before publication",
      { retryable: false, recoveryPossible: false });
  }
  const alreadyPublished = lifecycle.phase === "publication";
  if (context.mode === "locate") {
    const planError = changedLocationPlanError({ stepId: binding.stepId,
      attemptId: binding.attempt.id, context, locationPlan });
    if (planError) throw planError;
    const allowed = new Set(context.tableOfContents.map((entry) => entry.id));
    const exactIdentity = context.finding.identity;
    const proposal = preparation.facts.proposal;
    if (proposal.baseRevision !== context.baseRevision
      || proposal.locations.length !== 1
      || !isDeepStrictEqual(proposal.locations[0].identity, exactIdentity)
      || !Array.isArray(proposal.locations[0].rangeIds)
      || proposal.locations[0].rangeIds.some((id) => !allowed.has(id))) {
      throw new Error("Spec Gate repair location response exceeds its selected canonical table of contents");
    }
  } else if (context.mode === "evidence") {
    const { budget: executionBudget } = latestRepairBudget({ flowManager: ctx.flowManager,
      specId: binding.specId, attemptId: binding.attempt.id,
      baseRevision: context.baseRevision, consumerNodeId: binding.stepId });
    const work = nextSpecGateRepairEvidence({ context: source.context,
      limit: SPEC_GATE_REPAIR_REQUEST_LIMIT, executionBudget,
      unitId: context.unitId, publications: ledger.entries,
      additionalRangeIds: ledger.additionalRangeIds(source.context, context.unitId) });
    if (work.mode !== "evidence" || work.batch.digest !== context.batchDigest
      || work.evidenceDepth !== context.evidenceDepth
      || work.evidenceContextDigest !== context.evidenceContextDigest
      || preparation.facts.proposal.baseRevision !== context.baseRevision
      || preparation.facts.proposal.unitId !== context.unitId) {
      throw new Error("Spec Gate repair evidence response differs from its bounded work unit");
    }
  } else if (context.mode === "repair") {
    const proposal = preparation.facts.proposal;
    if (proposal.baseRevision !== context.baseRevision) {
      throw new Error("Spec Gate repair response changed its base revision");
    }
    if (proposal.stage === "spec-gate-repair-context-request") {
      if (!context.selections.some((selection) => selection.unit.id === proposal.unitId)) {
        throw new Error("Spec Gate repair requested context for an unselected atomic unit");
      }
      new SpecGateRepairContextExpansion({ context: source.context,
        unitId: proposal.unitId, baseRevision: proposal.baseRevision,
        requestedRangeIds: proposal.additionalRangeIds,
        previousRangeIds: ledger.additionalRangeIds(source.context, proposal.unitId) });
    } else if (proposal.stage === "spec-gate-repair-draft-return") {
      if (![proposal.decision, proposal.evidence, proposal.unresolvedBecause].every((value) => (
        typeof value === "string" && value.trim() !== ""
      )) || !context.selections.some((selection) => selection.unit.id === proposal.unitId)) {
        throw new Error("Spec Gate repair Draft return requires a selected unit and cited decision gap");
      }
    } else if (proposal.groups.length !== context.selections.length
      || proposal.groups.some((group, index) => !isDeepStrictEqual(
        group.findingIdentities,
        context.selections[index].unit.findings.map((finding) => finding.identity),
      ))) {
      throw new Error("Spec Gate repair proposal does not cover its selected atomic units");
    }
  } else {
    throw new Error("Spec Gate repair worker context mode is invalid");
  }
  let publicationReceipt = null;
  if (lifecycle.phase === "claimed") {
    const { limit, budget } = latestRepairBudget({ flowManager: ctx.flowManager, specId: binding.specId,
      attemptId: binding.attempt.id, baseRevision: context.baseRevision,
      consumerNodeId: binding.stepId });
    const proposal = preparation.facts.proposal;
    const proposalCharacters = JSON.stringify(proposal).length;
    if (proposalCharacters > limit.maxResponseCharacters) {
      throw new Error("Spec Gate repair response exceeds its durable response limit");
    }
    budget.consumeAggregate({ characters: proposalCharacters,
      items: context.mode === "locate" ? proposal.locations.length
        : context.mode === "evidence" ? proposal.observations.length
          : proposal.stage === "spec-gate-repair" ? proposal.groups.length : 1 });
    const stepResult = new SpecGateRepairContextRequiredResult();
    publicationReceipt = ctx.flowManager.settleSpecStepResult({
      binding, stepResult, settlement: selectSettlement(binding.stepId, stepResult),
      artifactWrites: [progressWrite(binding, lifecycle.executionGeneration, "publication", {
        version: 1, phase: "publication", attemptId: binding.attempt.id,
        generation: lifecycle.executionGeneration,
        inputRevision: request.inputRevision, requestDigest: request.requestDigest,
        limit: { ...limit }, budget: budget.snapshot(), context, proposal,
      })],
    }).receipt;
  } else if (lifecycle.phase !== "publication") {
    throw new Error("Spec Gate repair worker response lacks a durable provider claim");
  }
  publicationReceipt ??= ctx.flowManager.readCurrentStepSettlement({
    specId: binding.specId, stepId: binding.stepId,
  })?.receipt;
  if (alreadyPublished) {
    const saved = ledger.publication;
    if (saved?.requestDigest !== request.requestDigest
      || !isDeepStrictEqual(saved.context, context)
      || !isDeepStrictEqual(saved.proposal, preparation.facts.proposal)) {
      throw new Error("Spec Gate repair replay differs from its durable worker response");
    }
  }
  const refreshed = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
    state: ctx.flowManager.canonicalState(binding.specId), executionRoot: request.executionRoot,
    acceptedPublication: true });
  const selected = new SpecGateRepairPublishedDecision({ source, ledger, refreshed,
    proposal: preparation.facts.proposal, contextMode: context.mode });
  if (selected.continuation !== null) {
    return serviceArguments({ ctx, request, binding, preparation, handoffCoordinator,
      continuation: selected.continuation, publicationReceipt });
  }
  const combined = preparation.withSpecGateRepairFacts(selected.facts);
  return serviceArguments({ ctx, request, binding, preparation: combined, handoffCoordinator,
    publicationReceipt });
}
