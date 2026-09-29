import {
  resolveSpecGateRepairExecution,
  SpecGateRepairExecutionFacts,
  SpecGateRepairExecutionStop,
  SpecGateRepairPublicationReplay,
  SpecGateRepairSealedReplay,
} from "../definition.js";
import { readProgressBoundSpecGateRepairInput } from "./spec-gate-repair-progress.js";
import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError } from "./worker-artifact-handoff.js";

class SpecGateRepairExecutionObservation {
  constructor(facts, request) {
    this.facts = facts;
    this.request = request;
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
  if (lifecycle?.phase === "claimed" || lifecycle?.phase === "publication") {
    const progress = readProgressBoundSpecGateRepairInput({ flowManager: ctx.flowManager,
      state: canonical, executionRoot: ctx.executionRoot || ctx.root,
      executionLifecycle: lifecycle });
    publicationCompletion = progress.ledger.completion;
    if (lifecycle.phase === "claimed") {
      request = handoffCoordinator.restoreClaimedDraftRequest({ ctx, state: canonical, lifecycle });
    }
  }
  return new SpecGateRepairExecutionObservation(new SpecGateRepairExecutionFacts({
    phase: lifecycle?.phase ?? null, publicationCompletion,
    response: request === null ? "absent" : request.hasSealedSubmission() ? "sealed" : "unsealed",
  }), request);
}

class SpecGateRepairExecutionSelection {
  constructor(observation) {
    this.decision = resolveSpecGateRepairExecution(observation.facts);
    this.request = observation.request;
    Object.freeze(this);
  }
}

export function selectSpecGateRepairExecution(input) {
  return new SpecGateRepairExecutionSelection(readSpecGateRepairExecutionFacts(input));
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

/** Execution re-reads the same observations used by next-action before effects. */
export function planSpecGateRepairWorkerExecution(input) {
  const selected = selectSpecGateRepairExecution(input);
  if (selected.decision instanceof SpecGateRepairExecutionStop) {
    throw new WorkerArtifactHandoffError("recovery-required", selected.decision.code,
      selected.decision.reason, { retryable: false, recoveryPossible: false });
  }
  if (selected.decision instanceof SpecGateRepairPublicationReplay) {
    return new SpecGateRepairWorkerExecution({ request: null, canonicalReplay: true });
  }
  if (selected.decision instanceof SpecGateRepairSealedReplay) {
    return new SpecGateRepairWorkerExecution({ request: selected.request, sealedReplay: true });
  }
  return new SpecGateRepairWorkerExecution({ request: input.handoffCoordinator.createRequest(input) });
}
