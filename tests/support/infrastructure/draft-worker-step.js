import RunDispatchCommand, {
  draftWorkerStepDefinition,
} from "../../../src/flow/lib/run-dispatch.js";

/** Complete a sealed Draft handoff through the production Connector/Step/Service path. */
export async function completeDraftWorkerThroughStep({ coordinator, ctx, request }) {
  const definition = await draftWorkerStepDefinition(request.stepId);
  if (definition === null) throw new Error(`no Draft Step is declared for ${request.stepId}`);
  const preparation = coordinator.prepareDraftWorker({ ctx, request });
  return new RunDispatchCommand({ handoffCoordinator: coordinator })
    .runDraftWorkerStep(ctx, request, definition, preparation);
}

/** Admit a conditional Draft execution before materializing its request. */
export async function prepareConditionalDraftWorkerThroughStep({ coordinator, ctx, state, invocation }) {
  const definition = await draftWorkerStepDefinition(invocation.action.nextAction.step);
  if (definition === null) throw new Error(`no Draft Step is declared for ${invocation.action.nextAction.step}`);
  return new RunDispatchCommand({ handoffCoordinator: coordinator }).prepareConditionalDraftWorker({
    ctx,
    state,
    invocation,
    definition,
    retrying: false,
  });
}
