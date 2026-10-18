import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import {
  FlowDispatchInvocation, FlowDispatchSession, FlowDispatchTarget,
  UnapprovedFlowDispatchAuthorization,
} from "../../../src/flow/lib/dispatch-invocation.js";
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
export async function prepareConditionalDraftWorkerThroughStep({ coordinator, ctx, state, invocationId }) {
  const executionContext = { ...ctx, flowState: state, flowCommandBoundary: true, expectBinding: FlowTargetBinding.capture({
    flowState: state, mainRoot: ctx.mainRoot ?? ctx.root, authorityRoot: ctx.executionRoot ?? ctx.root,
  }).serialize() };
  const target = FlowDispatchTarget.captureContext(executionContext);
  const session = new FlowDispatchSession({ id: invocationId, target });
  const dispatcher = new RunDispatchCommand({ handoffCoordinator: coordinator });
  const nextAction = target.assertNextActionBinding(await new GetNextActionCommand().execute(executionContext));
  const action = dispatcher.captureAction(executionContext, session, nextAction, 0, "action-capture");
  const invocation = new FlowDispatchInvocation({ session, action,
    authorization: new UnapprovedFlowDispatchAuthorization(action) });
  const definition = draftWorkerStepRegistration(action.nextAction.step);
  if (definition === null) throw new Error(`no Draft Step is declared for ${action.nextAction.step}`);
  return dispatcher.prepareConditionalDraftWorker({
    ctx: executionContext,
    state,
    invocation,
    definition,
    retrying: false,
  });
}
