import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { resolveGateNextAction } from "./gate-transition-application.js";
import { TaskStepIdentity } from "./task-step-identity.js";

/** Persist only the already Definition-selected exhausted Gate settlement. */
export default class RunSettleGateTransitionCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }

  execute(ctx) {
    try {
      const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState?.specId);
      const stepId = state?.current?.at(-1);
      const taskStep = TaskStepIdentity.fromStateNode(ctx.flowManager.loadReadOnly(state.specId), stepId);
      const phase = stepId === "impl-gate" ? "integration"
        : taskStep?.definitionId === "task-gate" ? "task-impl" : null;
      if (phase === null) throw new Error("Definition does not select a settleable Gate");
      const selection = resolveGateNextAction({
        flowManager: ctx.flowManager, flowState: ctx.flowManager.loadReadOnly(state.specId), phase, root: ctx.root,
      });
      const decision = selection?.decision;
      if (decision == null) throw new Error("current canonical Gate observation is unavailable");
      if (decision.disposition.operation !== "defer") {
        throw new Error(`Definition does not select Gate defer: ${decision.disposition.operation}`);
      }
      ctx.flowManager.settleGateTransition({ specId: state.specId, decision, stepResult: selection.result,
        settlement: selection.settlement, settlementReceipt: selection.receipt });
      return Envelope.ok("run", "settle-gate-transition", { phase, settled: true });
    } catch (error) {
      return Envelope.fail("run", "settle-gate-transition", error.code || "GATE_SETTLEMENT_NOT_ADMITTED", error.message);
    }
  }
}
