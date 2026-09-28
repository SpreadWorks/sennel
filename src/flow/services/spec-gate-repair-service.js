import { CanonicalFlowArtifactBaseline } from "../lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state-conflict-error.js";
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
  SpecGateRepairDraftReturnRequiredResult } from "../engine/step-result.js";
import { DraftReopenContext } from "../lib/draft-reopen-context.js";
import { readProgressBoundSpecGateRepairInput, SPEC_GATE_REPAIR_REQUEST_LIMIT, latestRepairBudget } from "../lib/spec-gate-repair-progress.js";
import { readSpecGateRepairInput } from "../lib/spec-gate-repair-input.js";
import { nextSpecGateRepairEvidence, SpecGateRepairContextExpansion } from "../lib/spec-gate-repair-evidence.js";
import { canonicalWorkerExecutionClaimForStored, WorkerArtifactHandoffError } from "../lib/worker-artifact-handoff.js";
import { isDeepStrictEqual } from "node:util";

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

export class SpecGateRepairWorkerExecution {
  constructor({ request, canonicalReplay = false, sealedReplay = false }) {
    if (request === null && !canonicalReplay || sealedReplay && request === null
      || canonicalReplay && sealedReplay) {
      throw new TypeError("Gate repair execution requires one durable response source");
    }
    this.request = request;
    this.canonicalReplay = canonicalReplay;
    this.sealedReplay = sealedReplay;
    Object.freeze(this);
  }
}

/** Parent-owned bounded proposal publication; the worker never writes canonical Spec bytes. */
export class SpecGateRepairService {
  #selection = null;
  #outcome = null;
  #publication = null;

  /** Choose the worker effect from durable execution state before any new request is created. */
  static planWorkerExecution({ ctx, state, invocation, workerInstructions, handoffCoordinator }) {
    const canonical = ctx.flowManager.canonicalState(state.specId);
    const execution = ctx.flowManager.draftStepExecutionState({ binding: {
      runId: canonical.runId, specId: canonical.specId,
      stepId: "spec-gate-repair", attempt: canonical.attempt,
    } });
    const lifecycle = execution.lifecycle;
    if (lifecycle?.phase === "claimed" || lifecycle?.phase === "publication") {
      const progress = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
        state: canonical, executionRoot: ctx.executionRoot || ctx.root,
        executionLifecycle: lifecycle });
      if (lifecycle.phase === "publication" && progress.ledger.completion !== null) {
        return new SpecGateRepairWorkerExecution({ request: handoffCoordinator.createRequest({
          ctx, state, invocation, workerInstructions,
        }) });
      }
      if (lifecycle.phase === "publication") {
        return new SpecGateRepairWorkerExecution({ request: null, canonicalReplay: true });
      }
      const request = handoffCoordinator.restoreClaimedDraftRequest({ ctx, state, lifecycle });
      if (lifecycle.phase === "claimed" && (request === null || !request.hasSealedSubmission())) {
        throw new WorkerArtifactHandoffError("recovery-required", "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE",
          "claimed Spec Gate repair has no exact sealed worker response",
          { retryable: false, recoveryPossible: false });
      }
      return new SpecGateRepairWorkerExecution({ request,
        sealedReplay: request.hasSealedSubmission() });
    }
    return new SpecGateRepairWorkerExecution({ request: handoffCoordinator.createRequest({
      ctx, state, invocation, workerInstructions,
    }) });
  }

  static async resumePublished({ ctx, state: requestedState, handoffCoordinator }) {
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
    return new this({ ctx, request: null, binding, preparation: null,
      facts, handoffCoordinator, continuation,
      publicationReceipt: ctx.flowManager.readCurrentStepSettlement({
        specId: state.specId, stepId: "spec-gate-repair",
      }).receipt });
  }

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
      throw new Error("Spec Gate repair exceeds its durable batch limit");
    }
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
      return new this({ ctx, request, binding, preparation, handoffCoordinator,
        continuation: selected.continuation, publicationReceipt });
    }
    const combined = preparation.withSpecGateRepairFacts(selected.facts);
    return new this({ ctx, request, binding, preparation: combined, handoffCoordinator,
      publicationReceipt });
  }

  constructor({ ctx, request, binding, preparation, handoffCoordinator,
    facts = preparation?.facts ?? null, continuation = null, publicationReceipt = null }) {
    if (!(binding instanceof SpecWorkerStepBinding) || binding.stepId !== "spec-gate-repair"
      || binding.flowManager !== ctx?.flowManager
      || !(facts instanceof SpecGateRepairWorkerFacts)
      || (request === null ? preparation !== null : preparation?.request !== request)
      || typeof handoffCoordinator?.completeSpecWorkerHandoff !== "function") {
      throw new TypeError("Spec Gate repair service requires its exact sealed handoff");
    }
    this.ctx = ctx;
    this.request = request;
    this.binding = binding;
    this.preparation = preparation;
    this.facts = facts;
    this.handoffCoordinator = handoffCoordinator;
    this.continuation = continuation;
    this.publicationReceipt = publicationReceipt;
  }

  inspectWorkerCompletion() {
    this.binding.assertCurrent();
    return this.facts;
  }

  adoptWorkerSelection(facts, selection) {
    if (facts !== this.facts || !(selection instanceof SpecGateRepairSelection)
      || selection.facts !== facts) throw new TypeError("Spec Gate repair selection changed after handoff");
    this.binding.assertCurrent();
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== "spec-gate-repair"
      || (!(stepResult instanceof StepErrorResult || stepResult instanceof SpecGateRepairNoProgressResult
        || stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairDraftReturnRequiredResult)
        && this.#selection?.result !== stepResult)) {
      throw new TypeError("Spec Gate repair settlement requires its Step-selected Result");
    }
    const settlement = settleSpecStepResult(this.binding.stepId, stepResult);
    if (this.continuation !== null && !(stepResult instanceof StepErrorResult)) {
      if (!(stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairDraftReturnRequiredResult)) {
        throw new TypeError("Gate repair continuation requires a Step-selected Result");
      }
      let committed;
      if (stepResult instanceof SpecGateRepairDraftReturnRequiredResult) {
        if (!(settlement instanceof StepRoute) || settlement.targetStepId !== "draft"
          || await new settlement.connector().connect() !== "draft") {
          throw new TypeError("Spec Gate repair Draft return requires its Definition route");
        }
        committed = this.ctx.flowManager.settleSpecStepResult({ binding: this.binding,
          stepResult, settlement,
          artifactBaselines: [new CanonicalFlowArtifactBaseline({
            logicalKey: "spec.record",
            digest: this.facts.input.baseRevision.slice("sha256:".length),
            byteLength: this.facts.input.specByteLength,
          })],
          draftReturn: new DraftReopenContext({
            route: "preimplementation",
            reason: this.facts.proposal.decision,
            source: { stepId: this.binding.stepId, attemptId: this.binding.attempt.id,
              attemptSequence: this.binding.attempt.sequence,
              baseRevision: this.facts.input.baseRevision,
              specByteLength: this.facts.input.specByteLength,
              repairId: this.facts.input.repair.idempotencyKey,
              selectedUnitIds: this.facts.input.context.units().map((unit) => unit.id),
              findingIdentities: this.facts.input.context.units().flatMap((unit) => (
                unit.findings.map((finding) => finding.identity.toJSON())
              )),
              evidence: this.facts.proposal.evidence,
              unresolvedBecause: this.facts.proposal.unresolvedBecause,
            },
          }) });
      } else {
        committed = this.ctx.flowManager.completeSpecGateRepairProgress({ binding: this.binding,
          stepResult, settlement, publicationReceipt: this.publicationReceipt });
      }
      const receipt = committed.receipt;
      const outcome = this.request === null ? { completed: true, replayed: true,
        stepId: this.binding.stepId, stepResult, receipt, settlementReceipt: receipt }
        : this.handoffCoordinator.completeSpecWorkerHandoff({
          request: this.request, preparation: this.preparation, stepResult, receipt,
        });
      if (this.request === null) this.handoffCoordinator.cleanupCompletedSpecGateRepairHandoff({
        ctx: this.ctx, receipt,
      });
      this.#outcome = { ...outcome, partialProgressReceipt: committed.newlyCompleted ? receipt : null };
      return this.#outcome.receipt;
    }
    const error = settlement instanceof StepErrorDecision;
    if (!error && !(settlement instanceof StepRoute)) throw new TypeError("Spec Gate repair requires its selected route");
    if (!error && await new settlement.connector().connect() !== settlement.targetStepId) {
      throw new TypeError("Spec Gate repair connector disagrees with its route");
    }
    const input = this.facts.input;
    this.#publication ??= error ? {
      lifecycleResult: null, references: undefined, artifactWrites: [], artifactBaselines: [],
    } : {
      ...(this.preparation?.settlementPublication(this.handoffCoordinator.now) ?? {}),
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
    this.#outcome = this.request === null ? { completed: true, replayed: true,
      stepId: this.binding.stepId, stepResult, receipt: committed.receipt,
      settlementReceipt: committed.receipt }
      : this.handoffCoordinator.completeSpecWorkerHandoff({
        request: this.request, preparation: this.preparation,
        stepResult, receipt: committed.receipt, replayed,
      });
    if (this.request === null) this.handoffCoordinator.cleanupCompletedSpecGateRepairHandoff({
      ctx: this.ctx, receipt: committed.receipt,
    });
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
  get partialProgressReceipt() { return this.#outcome?.partialProgressReceipt ?? null; }
}
