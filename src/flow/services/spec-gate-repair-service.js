import { CanonicalFlowArtifactBaseline, CurrentFlowStateConflictError } from "../lib/current-flow-state.js";
import { StepResult, StepErrorResult, SpecGateRepairNoProgressResult } from "../engine/step-result.js";
import { SpecWorkerStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { settleSpecStepResult, StepErrorDecision, StepRoute } from "../definition.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { SpecGateRepairWorkerFacts, SpecGateRepairSelection,
  SpecGateRepairContinuationFacts } from "../lib/spec-gate-repair-worker-facts.js";
import {
  DraftWorkerExecutionBinding, DraftWorkerExecutionClaim, settleSpecStepResult as selectSettlement,
} from "../definition.js";
import { SpecGateRepairContextRequiredResult,
  SpecGateRepairAwaitingDecisionResult } from "../engine/step-result.js";
import { readProgressBoundSpecGateRepairInput, SPEC_GATE_REPAIR_REQUEST_LIMIT, latestRepairBudget } from "../lib/spec-gate-repair-progress.js";
import { nextSpecGateRepairEvidence, SpecGateRepairContextExpansion } from "../lib/spec-gate-repair-evidence.js";
import { canonicalWorkerExecutionClaimForStored } from "../lib/worker-artifact-handoff.js";
import { isDeepStrictEqual } from "node:util";

function progressWrite(binding, generation, phase, document) {
  return { logicalKey: "spec.gate.repair.progress",
    parameters: { attemptId: binding.attempt.id, generation: String(generation), phase },
    mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8") };
}

/** Parent-owned bounded proposal publication; the worker never writes canonical Spec bytes. */
export class SpecGateRepairService {
  #selection = null;
  #outcome = null;
  #publication = null;

  /** The claimed budget is committed before a provider-visible call. */
  static reserveWorkerCall({ ctx, request, prompt }) {
    const binding = new SpecWorkerStepBinding({ request });
    const flowManager = ctx.flowManager;
    const { limit, budget } = latestRepairBudget({ flowManager, specId: binding.specId,
      attemptId: binding.attempt.id, baseRevision: request.inputs.find((entry) => (
        entry.name === "spec-gate-repair-context.json"
      ))?.document?.baseRevision, consumerNodeId: binding.stepId });
    const inputCharacters = request.inputs.reduce((total, input) => total + input.byteLength, 0);
    if (typeof prompt !== "string" || prompt.length + inputCharacters > limit.maxRequestCharacters) {
      throw new Error("Spec Gate repair prompt exceeds its durable request limit");
    }
    budget.assertCanExecute(1);
    if (budget.providerCallCount + 1 > limit.maxBatchCount) {
      throw new Error("Spec Gate repair exceeds its durable batch limit");
    }
    const selectedContext = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json")?.document;
    if (selectedContext?.mode === "evidence" && selectedContext.evidenceDepth > 0) {
      budget.consumeSynthesisCalls(1);
    }
    budget.consumeAggregate({ characters: prompt.length + inputCharacters,
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

  static async prepare({ ctx, request, Connector, handoffCoordinator }) {
    const preparation = handoffCoordinator.prepareSpecWorker({ ctx, request });
    if (preparation.completed) return preparation;
    const binding = await new Connector(request).connect();
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
    const alreadyPublished = lifecycle.phase === "publication";
    if (context.mode === "locate") {
      const batch = locationPlan?.batches[context.batchIndex];
      const allowed = new Set(context.tableOfContents.map((entry) => entry.id));
      const exactIdentity = context.finding.identity;
      const proposal = preparation.facts.proposal;
      if (batch?.digest !== context.batchDigest || proposal.baseRevision !== context.baseRevision
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
      } else if (proposal.stage === "spec-gate-repair-user-input") {
        if (typeof proposal.question !== "string" || proposal.question.trim() === "") {
          throw new Error("Spec Gate repair user decision requires a question");
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
    if (alreadyPublished) {
      const saved = ledger.publication;
      if (saved?.requestDigest !== request.requestDigest
        || !isDeepStrictEqual(saved.context, context)
        || !isDeepStrictEqual(saved.proposal, preparation.facts.proposal)) {
        throw new Error("Spec Gate repair replay differs from its durable worker response");
      }
    }
    const refreshed = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
      state: ctx.flowManager.canonicalState(binding.specId), executionRoot: request.executionRoot });
    const continuation = new SpecGateRepairContinuationFacts({ input: refreshed.source,
      ledger: refreshed.ledger, locationPlan: refreshed.locationPlan,
      proposal: preparation.facts.proposal });
    if (continuation.unresolvedLocationCount > 0
      || context.mode === "evidence" || continuation.decisionRequired
      || continuation.additionalContextRequested
      || continuation.completedUnitCount < continuation.unitCount) {
      return new this({ ctx, request, binding, preparation, handoffCoordinator,
        continuation, publicationReceipt });
    }
    const priorGroups = ledger.groups();
    const aggregate = { ...preparation.facts.proposal,
      groups: [...priorGroups, ...preparation.facts.proposal.groups] };
    const combined = preparation.withSpecGateRepairFacts(new SpecGateRepairWorkerFacts({
      input: source, proposal: aggregate,
    }));
    return new this({ ctx, request, binding, preparation: combined, handoffCoordinator,
      publicationReceipt });
  }

  constructor({ ctx, request, binding, preparation, handoffCoordinator,
    continuation = null, publicationReceipt = null }) {
    if (!(binding instanceof SpecWorkerStepBinding) || binding.stepId !== "spec-gate-repair"
      || binding.flowManager !== ctx?.flowManager
      || !(preparation?.facts instanceof SpecGateRepairWorkerFacts)
      || preparation.request !== request
      || typeof handoffCoordinator?.completeSpecWorkerHandoff !== "function") {
      throw new TypeError("Spec Gate repair service requires its exact sealed handoff");
    }
    this.ctx = ctx;
    this.request = request;
    this.binding = binding;
    this.preparation = preparation;
    this.handoffCoordinator = handoffCoordinator;
    this.continuation = continuation;
    this.publicationReceipt = publicationReceipt;
  }

  inspectWorkerCompletion() {
    this.binding.assertCurrent();
    return this.preparation.facts;
  }

  adoptWorkerSelection(facts, selection) {
    if (facts !== this.preparation.facts || !(selection instanceof SpecGateRepairSelection)
      || selection.facts !== facts) throw new TypeError("Spec Gate repair selection changed after handoff");
    this.binding.assertCurrent();
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== "spec-gate-repair"
      || (!(stepResult instanceof StepErrorResult || stepResult instanceof SpecGateRepairNoProgressResult
        || stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairAwaitingDecisionResult)
        && this.#selection?.result !== stepResult)) {
      throw new TypeError("Spec Gate repair settlement requires its Step-selected Result");
    }
    const settlement = settleSpecStepResult(this.binding.stepId, stepResult);
    if (this.continuation !== null) {
      if (!(stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairAwaitingDecisionResult)) {
        throw new TypeError("Gate repair continuation requires a Step-selected Result");
      }
      const receipt = stepResult instanceof SpecGateRepairAwaitingDecisionResult
        ? this.ctx.flowManager.settleSpecStepResult({ binding: this.binding,
          stepResult, settlement }).receipt
        : this.publicationReceipt ?? this.ctx.flowManager.readCurrentStepSettlement({
          specId: this.binding.specId, stepId: this.binding.stepId,
        })?.receipt;
      this.#outcome = this.handoffCoordinator.completeSpecWorkerHandoff({
        request: this.request, preparation: this.preparation, stepResult, receipt,
      });
      return this.#outcome.receipt;
    }
    const error = settlement instanceof StepErrorDecision;
    if (!error && !(settlement instanceof StepRoute)) throw new TypeError("Spec Gate repair requires its selected route");
    if (!error && await new settlement.connector().connect() !== settlement.targetStepId) {
      throw new TypeError("Spec Gate repair connector disagrees with its route");
    }
    const input = this.preparation.facts.input;
    this.#publication ??= error ? {
      lifecycleResult: null, references: undefined, artifactWrites: [], artifactBaselines: [],
    } : {
      ...this.preparation.settlementPublication(this.handoffCoordinator.now),
      specRecord: this.#selection.publication,
      artifactWrites: [{
        logicalKey: "spec.gate.repair.audit",
        parameters: { attemptId: this.binding.attempt.id },
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(this.#selection.audit, null, 2)}\n`, "utf8"),
      }],
      artifactBaselines: [new CanonicalFlowArtifactBaseline({
        logicalKey: "spec.record",
        digest: input.baseRevision.slice("sha256:".length),
        byteLength: input.specByteLength,
      })],
    };
    const settlementInput = {
      binding: this.binding, stepResult, settlement,
      specGateRepairSelection: this.#selection,
      ...this.#publication,
    };
    const replayed = this.#outcome !== null;
    let committed;
    try {
      if (!replayed) this.handoffCoordinator.faultInjector({
        phase: "before-worker-handoff-publication", stepId: "spec-gate-repair",
      });
      committed = this.ctx.flowManager.settleSpecStepResult(settlementInput);
    } catch (cause) {
      if (cause instanceof CurrentFlowStateConflictError) throw cause;
      const receipt = this.ctx.flowManager.findStepSettlementReceipt(settlementInput);
      if (receipt === null) throw new StepPersistenceFailure(cause);
      committed = { receipt };
    }
    this.#outcome = this.handoffCoordinator.completeSpecWorkerHandoff({
      request: this.request, preparation: this.preparation,
      stepResult, receipt: committed.receipt, replayed,
    });
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
}
