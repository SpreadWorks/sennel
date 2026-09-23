import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import {
  inspectCanonicalPlanGateRepair,
  planGateRepairRouteForGateStep,
} from "./plan-gate-repair.js";
import { resolveGateTransition } from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { CanonicalGateObservationCycle } from "./canonical-gate-observation-cycle.js";

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
    const route = planGateRepairRouteForGateStep(state.current?.at(-1));
    if (route === null) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_STAGE_UNSUPPORTED",
        "the current step is not a supported plan Gate repair source",
      );
    }
    if (route.phase === "draft" || route.phase === "spec") {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_STAGE_UNSUPPORTED",
        `${route.phase} Gate repair is selected and persisted by its StepResult settlement`,
      );
    }
    let evidence;
    try {
      evidence = inspectCanonicalPlanGateRepair({ flowManager: ctx.flowManager, state });
    } catch (error) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_NOT_ADMITTED",
        `Definition cannot admit the current plan Gate evidence: ${error.message}`,
      );
    }
    if (evidence === null) {
      return Envelope.fail(
        "run",
        "repair-plan-gate",
        "PLAN_GATE_REPAIR_NOT_ADMITTED",
        "Definition did not select current blocking plan Gate evidence for repair",
      );
    }
    const { phase } = evidence.route;
    let decision = null;
    if (phase === "task-impl") {
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
    let record;
    try {
      record = evidence.createRecord(state, {
        gateFacts: decision.facts,
        connector: decision.plan.repairConnector,
        cycleReadModel: new CanonicalGateObservationCycle({
          flowManager: ctx.flowManager,
          state,
        }).read(),
      });
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
