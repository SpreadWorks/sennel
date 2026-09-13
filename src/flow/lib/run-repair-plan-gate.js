import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import {
  inspectCanonicalPlanGateRepair,
  planGateRepairRouteForGateStep,
} from "./plan-gate-repair.js";
import { resolveGateTransition } from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";

export default class RunRepairPlanGateCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  execute(ctx) {
    const projectedState = ctx.flowState;
    if (projectedState?.schemaRevision !== 3 || typeof ctx.flowManager?.canonicalState !== "function") {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "CANONICAL_FLOW_REQUIRED",
        "plan gate repair requires a Version-1 Flow",
      );
    }
    const state = ctx.flowManager.canonicalState(ctx.specId ?? projectedState.specId);
    if (state === null) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "CANONICAL_FLOW_REQUIRED",
        "plan gate repair requires a Version-1 Flow",
      );
    }
    return this.#executeCanonical(ctx, state);
  }

  #executeCanonical(ctx, state) {
    const activeStepId = state.current === null ? null : state.current.at(-1);
    const route = planGateRepairRouteForGateStep(activeStepId);
    if (!route) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_STAGE_UNSUPPORTED",
        "plan gate repair requires a supported Gate to be in progress",
      );
    }
    const { phase } = route;
    let decision = null;
    if (phase === "draft" || phase === "spec" || phase === "task-impl") {
      try {
        const facts = readCurrentGateTransitionFacts({
          flowManager: ctx.flowManager,
          flowState: ctx.flowManager.loadReadOnly(state.specId),
          phase,
        });
        decision = facts === null ? null : resolveGateTransition(facts);
      } catch (error) {
        return Envelope.fail("run", "repair-plan-gate", "PLAN_GATE_REPAIR_EVIDENCE_MISSING", error.message);
      }
      if (decision?.disposition.operation !== "repair") {
        return Envelope.fail("run", "repair-plan-gate", "PLAN_GATE_REPAIR_NOT_ADMITTED",
          "Definition did not select repair for the current Gate action");
      }
    }
    let evidence;
    try {
      evidence = inspectCanonicalPlanGateRepair({ flowManager: ctx.flowManager, state });
    } catch (error) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_EVIDENCE_MISSING",
        `canonical ${phase} gate evidence is unavailable: ${error.message}`,
      );
    }
    if (evidence === null) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_EVIDENCE_MISSING",
        `no blocking ${phase} gate evidence is available for guarded repair`,
      );
    }
    let record;
    try {
      record = evidence.createRecord(state);
      ctx.flowManager.repairPlanGate({
        specId: state.specId,
        record,
        issueLog: evidence.issueLog,
        decision,
      });
    } catch (error) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        error.code || "PLAN_GATE_REPAIR_INVALID",
        error.message,
      );
    }
    return Envelope.ok("run", "repair-plan-gate", {
      repairedPhase: phase,
      previousStep: record.route.gateStepId,
      nextStep: record.targetStepId,
      sourceIssueLogId: record.sourceIssueLogId,
      resetSteps: [...record.route.resetStepIds],
    });
  }
}
