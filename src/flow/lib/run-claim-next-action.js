import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { CanonicalTestArtifactStore } from "./canonical-test-artifacts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  resolveCanonicalFinalRegressionTransition,
} from "./final-regression-transition-facts.js";
import { beginFinalRegressionRepairTransition } from "./final-regression-transition-application.js";
import GetNextActionCommand from "./get-next-action.js";
import {
  createConditionalWorkerSettlementPlan,
  resolveDraftTransition,
  resolveGateTransition,
  resolvePlanGateRepairWorkerTransition,
} from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { readDraftTransitionFacts } from "./draft-transition-facts.js";
import { canonicalPlanGateRepairForTarget } from "./plan-gate-repair.js";

function conditionalWorkerSettlement({ ctx, state, next }) {
  const stepId = state.current?.at(-1) ?? next?.nodeId ?? null;
  let disposition = null;
  let evidenceDigest = null;
  if (stepId === "draft-refine") {
    const facts = readDraftTransitionFacts({ flowManager: ctx.flowManager, flowState: ctx.flowState });
    disposition = facts === null ? null : resolveDraftTransition({ stepId, flowState: ctx.flowState, facts });
    evidenceDigest = facts?.sourceDigest ?? null;
  } else if (stepId === "draft-gate-repair") {
    const repair = canonicalPlanGateRepairForTarget({
      flowManager: ctx.flowManager,
      state: ctx.flowState,
      targetStepId: stepId,
    });
    disposition = resolvePlanGateRepairWorkerTransition({
      stepId,
      workerStatus: state.findNode(stepId)?.status,
      repair,
    });
  }
  if (disposition === null || !["skip-worker", "complete-worker"].includes(disposition.operation)) return null;
  return createConditionalWorkerSettlementPlan({ disposition, flowState: state, evidenceDigest });
}

/**
 * The only generic claim boundary for an ordinary Definition-selected worker
 * action.  Queries project this command but never invoke it; direct callers
 * re-read the Version Store here, before any worker or lifecycle hook can
 * create an Activity.
 */
export default class RunClaimNextActionCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    try {
      ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId);
      const typed = ctx.flowManager.canonicalState(ctx.specId);
      if (typed?.lifecycle.state !== "active") {
        throw new Error("Definition does not select a claimable action for an inactive Flow");
      }
      const next = typed?.nextAction() ?? null;
      const conditionalPlan = conditionalWorkerSettlement({ ctx, state: typed, next });
      if (conditionalPlan !== null) {
        const settled = ctx.flowManager.settleConditionalWorker({ specId: ctx.specId, plan: conditionalPlan });
        return Envelope.ok("run", "claim-next-action", {
          step: conditionalPlan.stepId,
          status: conditionalPlan.status,
          nextStep: settled.nextAction()?.nodeId ?? null,
        });
      }
      const projection = await new GetNextActionCommand().execute(ctx);
      const activeTaskStep = TaskStepIdentity.fromStateNode(ctx.flowState, typed?.current?.at(-1));
      const gatePhase = typed?.current?.at(-1) === "draft-gate"
        ? "draft"
        : typed?.current?.at(-1) === "spec-gate"
          ? "spec"
          : typed?.current?.at(-1) === "impl-gate"
            ? "integration"
          : activeTaskStep?.definitionId === "task-gate" ? "task-impl" : null;
      if (gatePhase !== null && projection?.directive?.actionId === "CLAIM_GATE_RETRY") {
        const facts = readCurrentGateTransitionFacts({ flowManager: ctx.flowManager, flowState: ctx.flowState, phase: gatePhase });
        if (facts === null) throw new Error("current Gate retry observation is unavailable");
        const decision = resolveGateTransition(facts);
        const claimed = ctx.flowManager.retryGateTransition({ specId: ctx.specId, decision });
        return Envelope.ok("run", "claim-next-action", {
          step: claimed.current?.at(-1) ?? null,
          attemptId: claimed.attempt?.id ?? null,
          attempt: claimed.attempt?.sequence ?? null,
        });
      }
      if (typed?.current?.at(-1) === "final-regression" && typed.attempt?.failure !== null) {
        if (projection?.directive?.actionId !== "FINAL_REGRESSION_REPAIR") {
          throw new Error("Definition does not project a claimable final-regression repair");
        }
        const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state: typed });
        const decision = resolveCanonicalFinalRegressionTransition({
          flowManager: ctx.flowManager,
          specId: ctx.specId,
          changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
            root: ctx.executionRoot || ctx.root,
            relativeSpecFile: store.location.relativeSpecFile,
          }),
        });
        if (decision.disposition.operation !== "repair") {
          throw new Error(`Definition does not select a claimable final-regression repair: ${decision.disposition.operation}`);
        }
        const claimed = beginFinalRegressionRepairTransition({
          flowManager: ctx.flowManager,
          specId: ctx.specId,
          decision,
        });
        return Envelope.ok("run", "claim-next-action", {
          step: claimed.current?.at(-1) ?? null,
          attemptId: claimed.attempt?.id ?? null,
          attempt: claimed.attempt?.sequence ?? null,
        });
      }
      if (next === null || !["start", "recover", "retry"].includes(next.operation)) {
        throw new Error("Definition does not select a claimable ordinary next action");
      }
      if (projection?.directive?.actionId !== "CLAIM_NEXT_ACTION") {
        throw new Error("Definition does not project an ordinary claim command");
      }
      const claimed = ctx.flowManager.beginNextAction(ctx.specId);
      return Envelope.ok("run", "claim-next-action", {
        step: claimed.current?.at(-1) ?? null,
        attemptId: claimed.attempt?.id ?? null,
        attempt: claimed.attempt?.sequence ?? null,
      });
    } catch (error) {
      return Envelope.fail("run", "claim-next-action", error.code || "NEXT_ACTION_CLAIM_NOT_ADMITTED", error.message);
    }
  }
}
