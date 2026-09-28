import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { draftWorkerStepRegistration } from "../../../src/flow/engine/composition/draft.js";

/** Complete a sealed Draft handoff through the production Connector/Step/Service path. */
export async function completeDraftWorkerThroughStep({ coordinator, ctx, request }) {
  const definition = draftWorkerStepRegistration(request.stepId);
  if (definition === null) throw new Error(`no Draft Step is declared for ${request.stepId}`);
  const preparation = coordinator.prepareDraftWorker({ ctx, request });
  return new RunDispatchCommand({ handoffCoordinator: coordinator })
    .runDraftWorkerStep(ctx, request, definition, preparation);
}

/** Admit a conditional Draft execution before materializing its request. */
export async function prepareConditionalDraftWorkerThroughStep({ coordinator, ctx, state, invocation }) {
  const definition = draftWorkerStepRegistration(invocation.action.nextAction.step);
  if (definition === null) throw new Error(`no Draft Step is declared for ${invocation.action.nextAction.step}`);
  return new RunDispatchCommand({ handoffCoordinator: coordinator }).prepareConditionalDraftWorker({
    ctx,
    state,
    invocation,
    definition,
    retrying: false,
  });
}
