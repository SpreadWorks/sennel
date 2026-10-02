import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffReference } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { reserveSpecGateRepairWorkerCall } from "../../../src/flow/engine/composition/spec-gate-repair.js";

/** These component fixtures use the bounded reference itself as their actual instruction. */
class FixtureSpecGateRepairWork {
  constructor(request) { this.request = request; }
  static forAdmission(invocation, request) { return new FixtureSpecGateRepairWork(request); }
  workerInvocation() { return null; }
  prompt() { return JSON.stringify(new WorkerArtifactHandoffReference(this.request)); }
}

export function createFixtureSpecGateRepairCallPlan({ ctx, request }) {
  return new WorkerArtifactHandoffCoordinator().planSpecGateRepairRequest({
    ctx, state: ctx.flowManager.loadReadOnly(request.specId), invocation: request.invocation,
    workerInstructions: request.workerInstructions, generatedAt: request.generatedAt,
    dispatchWorkClass: FixtureSpecGateRepairWork,
  }).callPlan;
}

export function reserveFixtureSpecGateRepairWorkerCall({ ctx, request, prompt }) {
  const state = ctx.flowManager.canonicalState(request.specId);
  const lifecycle = ctx.flowManager.draftStepExecutionState({ binding: {
    runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt,
  } }).lifecycle;
  const callPlan = lifecycle?.phase === "checkpoint" ? null
    : createFixtureSpecGateRepairCallPlan({ ctx, request });
  return reserveSpecGateRepairWorkerCall({ ctx, request, prompt, callPlan });
}
