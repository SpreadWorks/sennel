import {
  resolveSpecGateRepairExecution,
  SpecGateRepairExecutionFacts,
  SpecGateRepairExecutionStop,
  SpecGateRepairPublicationReplay,
  SpecGateRepairSealedReplay,
  SpecGateRepairCheckpointResume,
  SpecGateRepairExecutionFormatUnavailable,
} from "../definition.js";
import { readProgressBoundSpecGateRepairInput, readSpecGateRepairExecutionProgress } from "./spec-gate-repair-progress.js";
import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError } from "./worker-artifact-handoff.js";

class SpecGateRepairExecutionObservation {
  constructor(facts, request, checkpointActionRepositoryFingerprint) {
    this.facts = facts;
    this.request = request;
    this.checkpointActionRepositoryFingerprint = checkpointActionRepositoryFingerprint;
    Object.freeze(this);
  }
}

/** Read without creating requests, consuming budget, claiming or publishing. */
export function readSpecGateRepairExecutionFacts({ ctx, state,
  handoffCoordinator = new WorkerArtifactHandoffCoordinator() }) {
  const canonical = ctx.flowManager.canonicalState(state.specId);
  const execution = ctx.flowManager.draftStepExecutionState({ binding: {
    runId: canonical.runId, specId: canonical.specId,
    stepId: "spec-gate-repair", attempt: canonical.attempt,
  } });
  const lifecycle = execution.lifecycle;
  let publicationCompletion = null;
  let request = null;
  let checkpointActionRepositoryFingerprint = null;
  if (["checkpoint", "claimed", "publication"].includes(lifecycle?.phase)) {
    let saved;
    try {
      saved = readSpecGateRepairExecutionProgress({ flowManager: ctx.flowManager,
        state: canonical, lifecycle });
    } catch (error) {
      if (!(error instanceof WorkerArtifactHandoffError)
        || error.code !== "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE") throw error;
      const present = lifecycle.claim !== null && lifecycle.claim !== undefined
        && handoffCoordinator.hasSavedWorkerSubmission({ ctx, state: canonical, executionClaim: lifecycle.claim });
      return new SpecGateRepairExecutionObservation(new SpecGateRepairExecutionFacts({
        phase: lifecycle.phase, response: present ? "present" : "absent", formatAvailable: false,
      }), null, null);
    }
    if (lifecycle.phase === "checkpoint") {
      checkpointActionRepositoryFingerprint = saved.document.actionRepositoryFingerprint;
    }
    const progress = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
      state: canonical, executionRoot: ctx.executionRoot || ctx.root,
      executionLifecycle: lifecycle });
    publicationCompletion = progress.ledger.completion;
    if (lifecycle.phase !== "publication") {
      request = handoffCoordinator.restoreClaimedDraftRequest({ ctx, state: canonical, lifecycle,
        executionLocator: saved.executionLocator, actionFileDigest: saved.document.actionFileDigest });
    }
  }
  return new SpecGateRepairExecutionObservation(new SpecGateRepairExecutionFacts({
    phase: lifecycle?.phase ?? null, publicationCompletion,
    response: request === null ? "absent" : request.hasSealedSubmission() ? "sealed" : "unsealed",
  }), request, checkpointActionRepositoryFingerprint);
}

class SpecGateRepairExecutionSelection {
  constructor(observation) {
    this.decision = resolveSpecGateRepairExecution(observation.facts);
    this.request = observation.request;
    this.checkpointActionRepositoryFingerprint = observation.checkpointActionRepositoryFingerprint;
    Object.freeze(this);
  }
}

export function selectSpecGateRepairExecution(input) {
  return new SpecGateRepairExecutionSelection(readSpecGateRepairExecutionFacts(input));
}

export class SpecGateRepairWorkerExecution {
  constructor({ request, canonicalReplay = false, sealedReplay = false,
    callPlan = null, checkpointResume = false, checkpointActionRepositoryFingerprint = null }) {
    if (request === null && !canonicalReplay || sealedReplay && request === null
      || canonicalReplay && sealedReplay
      || checkpointResume && (canonicalReplay || sealedReplay || request === null || callPlan !== null)) {
      throw new TypeError("Gate repair execution requires one durable response source");
    }
    this.request = request;
    this.canonicalReplay = canonicalReplay;
    this.sealedReplay = sealedReplay;
    this.callPlan = callPlan;
    this.checkpointResume = checkpointResume;
    this.checkpointActionRepositoryFingerprint = checkpointActionRepositoryFingerprint;
    Object.freeze(this);
  }
}

/** Execution re-reads the same observations used by next-action before effects. */
export function planSpecGateRepairWorkerExecution(input) {
  const selected = selectSpecGateRepairExecution(input);
  if (selected.decision instanceof SpecGateRepairExecutionStop
    || selected.decision instanceof SpecGateRepairExecutionFormatUnavailable) {
    throw new WorkerArtifactHandoffError("recovery-required", selected.decision.code,
      selected.decision.reason, { retryable: false, recoveryPossible: false });
  }
  if (selected.decision instanceof SpecGateRepairPublicationReplay) {
    return new SpecGateRepairWorkerExecution({ request: null, canonicalReplay: true });
  }
  if (selected.decision instanceof SpecGateRepairSealedReplay) {
    return new SpecGateRepairWorkerExecution({ request: selected.request, sealedReplay: true });
  }
  if (selected.decision instanceof SpecGateRepairCheckpointResume) {
    return new SpecGateRepairWorkerExecution({ request: selected.request, checkpointResume: true,
      checkpointActionRepositoryFingerprint: selected.checkpointActionRepositoryFingerprint });
  }
  return new SpecGateRepairWorkerExecution(input.handoffCoordinator.planSpecGateRepairRequest(input));
}
