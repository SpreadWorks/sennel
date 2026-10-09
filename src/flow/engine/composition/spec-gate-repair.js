import { PreparedStepReplay } from "./step-registration.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { SpecWorkerStepBinding } from "../connectors/spec/spec-step-binding.js";
import { DraftWorkerExecutionClaim, settleSpecStepResult as selectSettlement } from "../../definition.js";
import { SpecGateRepairContextRequiredResult, StepErrorResult } from "../step-result.js";
import { SpecGateRepairWorkerFacts, SpecGateRepairContinuationFacts } from "../../lib/spec-gate-repair-worker-facts.js";
import { readProgressBoundSpecGateRepairInput, latestRepairBudget, readSpecGateRepairExecutionProgress,
  SPEC_GATE_REPAIR_PROGRESS_VERSION } from "../../lib/spec-gate-repair-progress.js";
import { readSpecGateRepairInput } from "../../lib/spec-gate-repair-input.js";
import { canonicalWorkerExecutionClaimForStored, WorkerArtifactHandoffError } from "../../lib/worker-artifact-handoff.js";
import { isDeepStrictEqual } from "node:util";
import { SpecGateRepairBundle } from "../../lib/spec-gate-repair-bundle.js";
import { specGateRepairCallFootprint, specGateRepairResponseCost } from "../../lib/spec-gate-repair-call-plan.js";
import { rethrowStepSettlementFailure } from "../../lib/definition-lifecycle-failure.js";
import { SpecGateRepairServiceInput } from "../../services/spec-gate-repair-service.js";
import { SpecGateRepairSettlementWriter } from "../../services/spec-gate-repair-settlement-writer.js";
import { PromptLogicalFootprint } from "../../../lib/prompt-batching.js";
import { FlowArtifactCatalogSnapshotLimits } from "../../../lib/flow-version.js";
import { SpecGateRepairSourcePublication } from "../../lib/spec-gate-repair-source-storage.js";

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
  constructor({ source, ledger, refreshed, proposal }) {
    if (proposal.stage === "spec-gate-repair-input-unavailable") {
      this.facts = new SpecGateRepairWorkerFacts({ input: source, proposal });
      this.continuation = null;
      Object.freeze(this);
      return;
    }
    const continuation = new SpecGateRepairContinuationFacts({ input: refreshed.source,
      ledger: refreshed.ledger, locationPlan: refreshed.locationPlan, proposal });
    const intermediate = continuation.unresolvedLocationCount > 0
      || continuation.draftReturnRequired
      || continuation.additionalContextRequested || continuation.completedUnitCount < continuation.unitCount;
    this.facts = new SpecGateRepairWorkerFacts({ input: source, proposal: intermediate
      ? proposal : { ...proposal, groups: [...ledger.groups(), ...proposal.groups] } });
    this.continuation = intermediate ? continuation : null;
    Object.freeze(this);
  }
}

function serviceArguments({ ctx, request, binding, preparation, handoffCoordinator,
  publicationLimits, facts = preparation?.facts ?? null, continuation = null, publicationReceipt = null }) {
  binding.assertCurrent();
  const input = new SpecGateRepairServiceInput({ facts, continuation,
    attemptId: binding.attempt.id,
    attemptSequence: binding.attempt.sequence });
  return [input, new SpecGateRepairSettlementWriter({ ctx, request, binding,
    preparation, handoffCoordinator, publicationReceipt, publicationLimits,
    publication: preparation?.settlementPublication(handoffCoordinator.now) ?? {} })];
}

export async function preparePublishedSpecGateRepairArguments({ ctx, state: requestedState, handoffCoordinator,
  publicationLimits = new FlowArtifactCatalogSnapshotLimits() }) {
  const state = ctx.flowManager.canonicalState(requestedState.specId);
  const execution = ctx.flowManager.draftStepExecutionState({ binding: {
    runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt,
  } });
  const completed = ctx.flowManager.readCurrentStepSettlement({ specId: state.specId,
    stepId: "spec-gate-repair" });
  if (completed?.result instanceof StepErrorResult && completed.receipt.settlementKind === "failure") {
    return new PreparedStepReplay({ completed: true, replayed: true, stepId: "spec-gate-repair",
      stepResult: completed.result, receipt: completed.receipt, settlementReceipt: completed.receipt });
  }
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
    proposal: saved.proposal });
  return serviceArguments({ ctx, request: null, binding, preparation: null,
    facts, handoffCoordinator, continuation, publicationLimits,
    publicationReceipt: ctx.flowManager.readCurrentStepSettlement({
      specId: state.specId, stepId: "spec-gate-repair",
    }).receipt });
}

/** The claimed budget is committed before a provider-visible call. */
export function reserveSpecGateRepairWorkerCall({ ctx, request, prompt, physicalRequest = prompt,
  instructionPrompt = prompt, callPlan = null, publicationLimits = new FlowArtifactCatalogSnapshotLimits() }) {
  const binding = new SpecWorkerStepBinding({ request });
  const flowManager = ctx.flowManager;
  binding.assertCurrent();
  const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
  request.assertCurrent(flowManager.loadReadOnly(binding.specId));
  const execution = flowManager.draftStepExecutionState({ binding });
  const checkpoint = execution.lifecycle?.phase === "checkpoint";
  const { limit, budget } = latestRepairBudget({ flowManager, specId: binding.specId,
    attemptId: binding.attempt.id, baseRevision: context.baseRevision, consumerNodeId: binding.stepId,
    forNewGeneration: !checkpoint });
  let base;
  let sourceWrites = [];
  let executionBinding;
  const stepResult = new SpecGateRepairContextRequiredResult();
  const settlement = selectSettlement(binding.stepId, stepResult);
  if (checkpoint) {
    const saved = readSpecGateRepairExecutionProgress({ flowManager,
      state: flowManager.canonicalState(binding.specId), lifecycle: execution.lifecycle });
    const call = saved.callPlan.currentCall(saved.document);
    if (request.inputDigest !== saved.document.inputDigest
      || request.inputRevision !== saved.document.inputRevision
      || request.requestDigest !== saved.document.requestDigest
      || !isDeepStrictEqual(PromptLogicalFootprint.measure(physicalRequest).toJSON(), saved.document.physicalPromptFootprint)
      || !isDeepStrictEqual(specGateRepairCallFootprint(request, instructionPrompt).toJSON(), call.callCost.toJSON())
      || !isDeepStrictEqual(context, saved.document.context)) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_PLAN_CHANGED",
        "Spec Gate repair checkpoint does not match its exact request and measured cost",
        { data: { failureKind: "step-admission" }, recoveryPossible: false });
    }
    // Input/synthesis cost was durably consumed before interruption. Only the
    // unclaimed provider slot is consumed by the exact checkpoint continuation.
    budget.assertCanExecute(1);
    executionBinding = execution.lifecycle.binding;
    base = saved.document;
  } else {
    if (callPlan === null) throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_PLAN_REQUIRED",
      "Spec Gate repair execution requires its measured remaining call plan",
      { data: { failureKind: "step-admission" } });
    const call = callPlan.assertCurrent({ request, physicalRequest, instructionPrompt, budget });
    executionBinding = execution.workerBinding({ inputDigest: request.inputDigest, inputRevision: request.inputRevision });
    budget.consumeAggregate(call.callCost);
    if (call.synthesisCallCount > 0) budget.consumeSynthesisCalls(call.synthesisCallCount);
    const executionLocator = new DraftWorkerExecutionClaim({ dispatchInvocationId: request.dispatchInvocationId,
      generatedAt: request.generatedAt, actionDigest: request.actionDigest, requestDigest: request.requestDigest });
    const { source } = readProgressBoundSpecGateRepairInput({ flowManager,
      state: flowManager.canonicalState(binding.specId), executionRoot: request.executionRoot });
    if (source.context.evidenceDigest !== context.evidenceDigest) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
        "Spec Gate repair evidence changed before checkpoint", { retryable: false, recoveryPossible: false,
          data: { failureKind: "step-admission" } });
    }
    const sourceSnapshots = source.context.sourceSnapshots();
    for (const entry of sourceSnapshots.sources()) if (entry.required) entry.assertAvailable();
    const sourcePublication = new SpecGateRepairSourcePublication({ snapshots: sourceSnapshots });
    if (!isDeepStrictEqual(context.sourceSnapshotReference, sourcePublication.reference().toJSON())) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
        "Spec Gate repair source manifest differs from its selected input", {
          retryable: false, recoveryPossible: false, data: { failureKind: "step-admission" },
        });
    }
    sourceWrites = sourcePublication.artifactWrites();
    base = { version: SPEC_GATE_REPAIR_PROGRESS_VERSION, runId: request.runId, specId: request.specId,
      attemptId: binding.attempt.id, attemptSequence: binding.attempt.sequence,
      inputDigest: request.inputDigest, inputRevision: request.inputRevision,
      requestDigest: request.requestDigest, actionFileDigest: request.actionRequestDigest, limit: { ...limit },
      actionRepositoryFingerprint: request.invocation.action.repositoryFingerprint ?? null,
      generation: executionBinding.executionGeneration, context,
      sourceSnapshotReference: sourcePublication.reference().toJSON(),
      inputDescriptors: request.inputs.map((input) => input.toJSON()),
      executionLocator: executionLocator.toJSON(), plan: callPlan.toJSON(),
      callCost: call.callCost.toJSON(), responseAllowance: call.responseAllowance.toJSON() };
    base.physicalPromptFootprint = call.physicalPromptFootprint.toJSON();
    base.deliveryMode = call.deliveryMode;
  }
  try {
    if (!checkpoint) {
      flowManager.checkpointDraftStepExecution({ binding, stepResult, settlement, executionBinding,
        publicationLimits,
        artifactWrites: [...sourceWrites, progressWrite(binding, executionBinding.executionGeneration, "checkpoint",
          { ...base, phase: "checkpoint", budget: budget.snapshot() })] });
    }
    budget.consumeProviderCall();
    flowManager.claimDraftStepExecution({ binding, stepResult, settlement, executionBinding,
      publicationLimits,
      executionClaim: new DraftWorkerExecutionClaim(base.executionLocator),
      artifactWrites: [progressWrite(binding, executionBinding.executionGeneration, "claimed",
        { ...base, phase: "claimed", budget: budget.snapshot() })] });
  } catch (error) { rethrowStepSettlementFailure(error); }
}

export async function prepareSpecGateRepairServiceArguments({ ctx, request, handoffCoordinator,
  publicationLimits = new FlowArtifactCatalogSnapshotLimits() }, ConnectorClass) {
  if (request === undefined) return preparePublishedSpecGateRepairArguments({ ctx,
    state: ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId), handoffCoordinator, publicationLimits });
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
  if (preparation.facts.inputUnavailable !== null) {
    preparation.facts.inputUnavailable.assertRequest(request);
  } else if (context.mode === "locate") {
    const planError = changedLocationPlanError({ stepId: binding.stepId,
      attemptId: binding.attempt.id, context, locationPlan });
    if (planError) throw planError;
  } else if (context.mode === "repair") {
    const selections = SpecGateRepairBundle.fromJSON(context.bundle).selections();
    const proposal = preparation.facts.proposal;
    if (proposal.baseRevision !== context.baseRevision) {
      throw new Error("Spec Gate repair response changed its base revision");
    }
    if (proposal.stage === "spec-gate-repair-draft-return") {
      if (![proposal.decision, proposal.evidence, proposal.unresolvedBecause].every((value) => (
        typeof value === "string" && value.trim() !== ""
      )) || !selections.some((selection) => selection.unit.id === proposal.unitId)) {
        throw new Error("Spec Gate repair Draft return requires a selected unit and cited decision gap");
      }
    } else if (proposal.stage !== "spec-gate-repair-context-request"
      && (proposal.groups.length !== selections.length
      || proposal.groups.some((group, index) => !isDeepStrictEqual(
        group.findingIdentities,
        selections[index].unit.findings.map((finding) => finding.identity),
      )))) {
      throw new Error("Spec Gate repair proposal does not cover its selected atomic units");
    }
  } else if (!["navigate", "inspect"].includes(context.mode)
    || preparation.facts.proposal.stage !== "spec-gate-repair-context-request") {
    throw new Error("Spec Gate repair worker context mode is invalid");
  }
  let publicationReceipt = null;
  if (lifecycle.phase === "claimed") {
    const saved = readSpecGateRepairExecutionProgress({ flowManager: ctx.flowManager,
      state: ctx.flowManager.canonicalState(binding.specId), lifecycle });
    const { limit, budget } = saved;
    const proposal = preparation.facts.proposal;
    const responseCost = specGateRepairResponseCost(context, proposal);
    if (responseCost.characters > limit.maxResponseCharacters) {
      throw new Error("Spec Gate repair response exceeds its durable response limit");
    }
    if (responseCost.characters > saved.document.responseAllowance.characters
      || responseCost.items > saved.document.responseAllowance.items) {
      throw new Error("Spec Gate repair response exceeds its admitted response allowance");
    }
    budget.consumeAggregate(responseCost);
    const stepResult = new SpecGateRepairContextRequiredResult();
    try {
      publicationReceipt = ctx.flowManager.settleSpecStepResult({
        binding, stepResult, settlement: selectSettlement(binding.stepId, stepResult),
        publicationLimits,
        artifactWrites: [progressWrite(binding, lifecycle.executionGeneration, "publication", {
          ...saved.document, phase: "publication", budget: budget.snapshot(),
          responseCost: responseCost.toJSON(), context, proposal,
        })],
      }).receipt;
    } catch (error) { rethrowStepSettlementFailure(error); }
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
    proposal: preparation.facts.proposal });
  if (selected.continuation !== null) {
    return serviceArguments({ ctx, request, binding, preparation, handoffCoordinator,
      continuation: selected.continuation, publicationReceipt, publicationLimits });
  }
  const combined = preparation.withSpecGateRepairFacts(selected.facts);
  return serviceArguments({ ctx, request, binding, preparation: combined, handoffCoordinator,
    publicationReceipt, publicationLimits });
}
