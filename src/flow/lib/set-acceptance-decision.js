import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { FlowCommand } from "./base-command.js";
import { CanonicalAcceptanceDecision } from "./canonical-acceptance-artifacts.js";
import { acceptanceStepRegistration } from "../engine/composition/acceptance.js";
import { prepareAcceptanceDecisionInput } from "../engine/composition/acceptance-review-decision.js";

export function executeAcceptanceDecisionInput(input) {
  const registration = acceptanceStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Acceptance decision requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

export default class SetAcceptanceDecisionCommand extends FlowCommand {
  execute(ctx) {
    return this.executeSelectedAcceptance(null, { ctx });
  }
  executeSelectedAcceptance(_selection, { ctx }) {
    if (!ctx.choice) throw new Error("usage: flow set acceptance-decision --choice <choice>");
    const state = ctx.flowManager.loadReadOnly(ctx.flowState?.specId);
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) throw new Error("acceptance decision requires a Version-1 Flow");
    const result = new CanonicalAcceptanceDecision({ flowManager: ctx.flowManager, state, choice: ctx.choice }).resolve();
    const preparation = prepareAcceptanceDecisionInput({ flowManager: ctx.flowManager,
      state: ctx.flowManager.canonicalState(state.specId), commandResult: result });
    const outcome = executeAcceptanceDecisionInput({ ctx, flowManager: ctx.flowManager, stepId: "acceptance-decision", preparation, commandResult: result });
    return outcome instanceof Promise ? outcome.then(() => result) : result;
  }
}
