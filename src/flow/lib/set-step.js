/**
 * src/flow/lib/set-step.js
 *
 * Update a workflow step's status.
 * Side effects such as syncSpecTasks are driven by
 * the definition's sideEffects attribute — not hardcoded step IDs.
 */

import { FlowCommand } from "./base-command.js";
import { VALID_STEP_STATUSES } from "../../lib/constants.js";
import { container } from "../../lib/container.js";
import { Envelope } from "../../lib/flow-envelope.js";
import {
  findActiveNode,
  isDefinitionLifecycleOwnedStep,
  taskIdForResolvedStep,
} from "../definition.js";
import { findStepById } from "./step-tree.js";
import {
  NormalStepTransition,
  StepTransitionError,
} from "./step-transition-policy.js";
import { requiresWorkerArtifactHandoff } from "./flow-artifact-authority.js";
import { TaskStepIdentity } from "./task-step-identity.js";

function canonicalTargetId(activeNode, requestedId) {
  if (activeNode?.scope !== "task") return requestedId;
  if (["task-impl", "task-review", "task-triage", "task-repair", "task-gate"].includes(requestedId)) {
    return activeNode.stepId;
  }
  return requestedId;
}

export default class SetStepCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    const { id, status } = ctx;

    if (!id || !status) {
      return Envelope.fail("set", "step", "INVALID_USAGE", "usage: flow set step <id> <status>");
    }

    if (!VALID_STEP_STATUSES.includes(status)) {
      return Envelope.fail(
        "set",
        "step",
        "INVALID_STATUS",
        `invalid status: ${status} (valid: ${VALID_STEP_STATUSES.join(", ")})`,
      );
    }

    if (
      status === "done"
      && requiresWorkerArtifactHandoff(id)
    ) {
      return Envelope.fail(
        "set",
        "step",
        "FLOW_ARTIFACT_HANDOFF_REQUIRED",
        `${id} completion is owned by the parent dispatcher artifact handoff`,
        {
          classification: "invalid",
          retryBudgetConsumed: false,
          completionOwner: "parent-dispatcher",
        },
      );
    }

    const state = ctx.flowManager.load();
    if (state?.schemaRevision !== 3) {
      return Envelope.fail("set", "step", "CANONICAL_FLOW_REQUIRED", "active Flow must be backed by the canonical Version Store");
    }
    const activeNode = state ? findActiveNode(state) : null;
    const activeScope = activeNode?.scope === "task"
      ? state.tasks?.find((task) => task.id === activeNode.taskId)
      : state;
    const targetId = canonicalTargetId(activeNode, id);
    const taskIdentity = TaskStepIdentity.fromStateNode(state, targetId);
    const storedStep = activeScope
      ? findStepById(activeScope.steps || [], targetId)
      : null;
    let transition;
    try {
      transition = new NormalStepTransition({
        stepId: targetId,
        currentStepId: activeNode?.stepId,
        currentStatus: storedStep?.status,
        requestedStatus: status,
        lifecycleOwned: isDefinitionLifecycleOwnedStep({
          scope: activeNode?.scope || "flow",
          stepId: id,
        }) || ["review", "triage", "repair", "gate"].includes(taskIdentity?.role),
      });
    } catch (error) {
      const transitionError = error instanceof StepTransitionError
        ? error
        : new StepTransitionError(error.message);
      return Envelope.fail("set", "step", transitionError.code, transitionError.message);
    }

    // Pass specId so the mutator can locate flow.json by path even when the
    // current flowManager root has no .active-flow entry for this spec
    // (spec 251: main-repo authority during finalize-merge / sync / cleanup).
    // The resolved active step owns its parent scope; a non-matching id is a
    // flow-level mutation rather than an implicit current-task lookup.
    ctx.flowManager.updateStepStatus(transition, {
      ...(ctx.specId ? { specId: ctx.specId } : {}),
      taskId: taskIdForResolvedStep(activeNode, targetId),
    });
    if (container.has("logger")) {
      container.get("logger").event("flow-step-change", { step: id, status });
    }

    return { id, status };
  }
}
