import { Envelope } from "../../lib/flow-envelope.js";
import { resolveGateTransition } from "../definition.js";
import { FlowCommand } from "./base-command.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { TaskStepIdentity } from "./task-step-identity.js";

/** Persist only the already Definition-selected exhausted Gate settlement. */
export default class RunSettleGateTransitionCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }

  execute(ctx) {
    try {
      const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState?.specId);
      const stepId = state?.current?.at(-1);
      const taskStep = TaskStepIdentity.fromStateNode(ctx.flowManager.loadReadOnly(state.specId), stepId);
      const phase = stepId === "spec-gate" ? "spec"
        : stepId === "impl-gate" ? "integration"
        : taskStep?.definitionId === "task-gate" ? "task-impl" : null;
      if (phase === null) throw new Error("Definition does not select a settleable Gate");
      const facts = readCurrentGateTransitionFacts({
        flowManager: ctx.flowManager, flowState: ctx.flowManager.loadReadOnly(state.specId), phase,
      });
      if (facts === null) throw new Error("current canonical Gate observation is unavailable");
      const decision = resolveGateTransition(facts);
      if (decision.disposition.operation !== "defer") {
        throw new Error(`Definition does not select Gate defer: ${decision.disposition.operation}`);
      }
      ctx.flowManager.settleGateTransition({ specId: state.specId, decision });
      return Envelope.ok("run", "settle-gate-transition", { phase, settled: true });
    } catch (error) {
      return Envelope.fail("run", "settle-gate-transition", error.code || "GATE_SETTLEMENT_NOT_ADMITTED", error.message);
    }
  }
}
