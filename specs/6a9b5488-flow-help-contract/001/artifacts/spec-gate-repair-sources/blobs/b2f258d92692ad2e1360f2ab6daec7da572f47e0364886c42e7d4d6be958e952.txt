/**
 * src/lib/flow-helpers.js
 *
 * Pure helpers and constants for Spec-Driven Development flow state.
 * No I/O, no git, no environmental coupling — safe to import anywhere.
 *
 * Stateful operations live in `src/lib/flow-manager.js` (and its internal
 * sub-services) accessed via `container.get("flowManager")`.
 */

import path from "path";
import {
  collectFlowLeafIds,
  collectTaskLeafIds,
  deriveFlowPhaseMap,
  buildInitialNestedSteps,
  buildInitialTaskSteps as buildTaskStepsFromDef,
} from "../flow/definition.js";
import { flattenSteps } from "../flow/lib/step-tree.js";
import { DEFAULT_FLOW_SPEC_DIR, FlowSpecLocation } from "./flow-workspace.js";

export const ACTIVE_FLOW_FILE = ".active-flow";
export const PREPARING_PREFIX = ".active-flow.";
export const PREPARING_SCAN_LIMIT = 100;

/** Spec-Driven Development workflow step IDs in order (flow level). Derived from definition. */
export const FLOW_STEPS = collectFlowLeafIds();

/** Step ID → phase mapping (flow level). Derived from definition. */
export const PHASE_MAP = deriveFlowPhaseMap();

/** Valid values for Task.origin. */
export const TASK_ORIGINS = ["plan", "integration"];

/** Valid values for Task.status. */
export const TASK_STATUSES = ["pending", "in_progress", "done", "skipped"];

/** Valid values for Task.steps[].status. */
export const TASK_STEP_STATUSES = ["pending", "in_progress", "done", "skipped"];

/** Task-level step sequence. Derived from TASK_DEFINITION. */
export const TASK_STEPS_PLAN = collectTaskLeafIds();

/** Task-level step → phase mapping. */
export const TASK_PHASE_MAP = Object.fromEntries(
  TASK_STEPS_PLAN.map((id) => [id, "task-impl"]),
);

/**
 * Read the explicit spec identity from a flow object or state.
 *
 * @param {{ specId?: string }|null|undefined} flowOrState
 * @returns {string|null}
 */
export function getSpecName(flowOrState) {
  return flowOrState?.specId ?? null;
}

/**
 * Resolve the absolute spec directory from a flow state and repo root.
 * Returns null if `state.specId` is missing.
 *
 * @param {{ specId?: string }|null|undefined} flowOrState
 * @param {string} root - Repository root (absolute)
 * @returns {string|null}
 */
export function getSpecDir(flowOrState, root, specRoot = DEFAULT_FLOW_SPEC_DIR) {
  if (!flowOrState?.specId) return null;
  return new FlowSpecLocation({
    repositoryRoot: root,
    specRoot,
    specId: flowOrState.specId,
  }).directory;
}

/**
 * Derive current phase from a flow state (task-aware).
 *
 * If the state has a current task with an in_progress step, returns the
 * task-level phase (e.g. "task-plan" / "task-impl"). Otherwise falls back
 * to the flow-level phase based on FLOW_STEPS.
 *
 * @param {object|null|undefined} state - Full flow state.
 * @returns {"plan"|"impl"|"finalize"|"sync"|"task-plan"|"task-impl"}
 */
export function derivePhase(state) {
  if (!state) return "plan";

  if (state.currentTaskId != null && Array.isArray(state.tasks)) {
    const task = state.tasks.find((t) => t.id === state.currentTaskId);
    if (task && Array.isArray(task.steps)) {
      const inProgress = task.steps.find((s) => s.status === "in_progress" && TASK_PHASE_MAP[s.id]);
      if (inProgress) return TASK_PHASE_MAP[inProgress.id];
    }
  }

  const steps = state.steps;
  if (!steps?.length) return "plan";
  const flat = Array.isArray(steps[0]?.children) ? flattenSteps(steps) : steps;
  const inProgress = flat.find((s) => s.status === "in_progress" && PHASE_MAP[s.id]);
  if (inProgress) return PHASE_MAP[inProgress.id];
  let lastDone = null;
  for (const s of flat) {
    if ((s.status === "done" || s.status === "skipped") && PHASE_MAP[s.id]) lastDone = s;
  }
  if (!lastDone) return "plan";
  return PHASE_MAP[lastDone.id];
}

/**
 * Build initial flow-level steps as a nested structure from the definition.
 */
export function buildInitialSteps() {
  return buildInitialNestedSteps();
}

/**
 * Build initial task-level steps array based on the task's origin.
 *
 * @param {"plan"|"integration"} origin
 * @returns {Array<{id:string, status:"pending"}>}
 */
export function buildInitialTaskSteps(origin) {
  if (origin !== "plan" && origin !== "integration") {
    throw new Error(`unknown task origin: ${origin}`);
  }
  return buildTaskStepsFromDef();
}

/**
 * Return true if a task is in a terminal state (done or skipped).
 *
 * Spec 226: centralizing this predicate avoids drift between call sites
 * that check completion status (completeTask parent propagation,
 * findNextPendingTask leaf preference, etc.).
 *
 * @param {string | undefined | null} status
 * @returns {boolean}
 */
export function isTaskTerminalStatus(status) {
  return status === "done" || status === "skipped";
}

/**
 * Complete one task and propagate terminal state through its parent chain.
 * Callers own any subsequent task promotion; keeping that separate preserves
 * the existing completion/promotion boundary.
 */
export function completeTaskInState(state, taskId) {
  if (!state || typeof state !== "object") throw new Error("flow state is required");
  const task = (state.tasks || []).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  const finishedAt = new Date().toISOString();
  for (const step of task.steps || []) {
    if (step.status !== "in_progress") continue;
    step.status = "done";
    step.finishedAt = finishedAt;
  }
  task.status = "done";
  if (state.currentTaskId === taskId) state.currentTaskId = null;

  const tasks = state.tasks || [];
  const byId = new Map();
  const childrenByParent = new Map();
  for (const candidate of tasks) {
    byId.set(candidate.id, candidate);
    if (candidate.parent != null) {
      if (!childrenByParent.has(candidate.parent)) childrenByParent.set(candidate.parent, []);
      childrenByParent.get(candidate.parent).push(candidate);
    }
  }
  let parentId = task.parent;
  let hops = 0;
  while (parentId != null && hops <= tasks.length) {
    const parent = byId.get(parentId);
    if (!parent) break;
    const siblings = childrenByParent.get(parentId) || [];
    if (!siblings.every((candidate) => isTaskTerminalStatus(candidate.status)) || parent.status === "done") break;
    parent.status = "done";
    if (state.currentTaskId === parent.id) state.currentTaskId = null;
    parentId = parent.parent;
    hops += 1;
  }
  return task;
}

/**
 * Forest-aware lookup of the next task to run.
 *
 * Spec 226: Walks `tasks[]` in DFS pre-order, respecting the array order for
 * siblings (deterministic per spec.json.tasks[] order), and returns the first
 * pending task whose children (if any) are all done or skipped. That is,
 * returns the deepest pending leaf in document order.
 *
 * For a flat list (all parent=null), returns the first pending task in array
 * order. For an empty list, returns null.
 *
 * @param {Array<{id:string, parent?:string|null, status:string}>} tasks
 * @returns {object|null} the task entry, or null if no pending task exists
 */
export function findNextPendingTask(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const childrenOf = new Map();
  for (const t of tasks) childrenOf.set(t.id, []);
  for (const t of tasks) {
    if (t.parent != null && childrenOf.has(t.parent)) {
      childrenOf.get(t.parent).push(t);
    }
  }

  const roots = tasks.filter((t) => t.parent == null);

  function visit(task) {
    const kids = childrenOf.get(task.id) || [];
    for (const c of kids) {
      const found = visit(c);
      if (found) return found;
    }
    // Leaf-preference: pick this task only if all children are done/skipped.
    if (task.status === "pending") {
      const allKidsDone = kids.every((c) => isTaskTerminalStatus(c.status));
      if (allKidsDone) return task;
    }
    return null;
  }

  for (const root of roots) {
    const found = visit(root);
    if (found) return found;
  }
  return null;
}

/**
 * Promote the next pending task's id into `state.currentTaskId` (no-op if
 * currentTaskId is already set or no pending tasks remain).
 *
 * Direct callers are limited to task synchronization, the combined
 * completion/promotion state helper, and get-next-action's repair fallback.
 * completeTask itself must NOT call this (responsibility separation).
 *
 * Mutates `state` in place. Returns the promoted task id or null.
 *
 * @param {object} state - flow state with tasks[] and currentTaskId
 * @returns {string|null}
 */
export function promoteNextPending(state) {
  if (!state || typeof state !== "object") return null;
  if (state.currentTaskId != null) return null;
  if (!Array.isArray(state.tasks) || state.tasks.length === 0) return null;

  const next = findNextPendingTask(state.tasks);
  if (!next) return null;

  state.currentTaskId = next.id;
  if (next.status === "pending") next.status = "in_progress";
  return next.id;
}

/** Complete one task and promote its deterministic successor in one state mutation. */
export function completeTaskAndPromoteInState(state, taskId, checkpoint = () => {}) {
  if (typeof checkpoint !== "function") throw new Error("task transition checkpoint must be a function");
  completeTaskInState(state, taskId);
  checkpoint({ phase: "after-task-completion", taskId });
  const promoted = promoteNextPending(state);
  checkpoint({ phase: "after-next-task-promotion", taskId, promotedTaskId: promoted });
  return promoted;
}
