/**
 * Task-scope cursor enforcement shared by implementation dispatchers.
 */

import { findNextPendingTask, isTaskTerminalStatus } from "../../lib/flow-helpers.js";
import { flattenSteps } from "./step-tree.js";

export const BROAD_STEPS = Object.freeze(["implement", "impl-review", "impl-gate"]);
const BROAD_MODE_LEDGER_PREFIX = "sennel.broad-mode.v1:";

/** Immutable audited broad-mode fact stored as a typed Activity note. */
export class BroadModeLedgerEntry {
  constructor({ step, reason, ts, currentTaskId = null } = {}) {
    if (!BROAD_STEPS.includes(step)) throw new Error(`invalid broad mode step: ${step}`);
    if (typeof reason !== "string" || reason.trim() === "") throw new Error("broad mode reason is required");
    if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) throw new Error("broad mode timestamp is required");
    if (currentTaskId !== null && (typeof currentTaskId !== "string" || currentTaskId.trim() === "")) {
      throw new Error("broad mode currentTaskId must be null or a string");
    }
    this.step = step;
    this.reason = reason.trim();
    this.ts = ts;
    this.currentTaskId = currentTaskId;
    Object.freeze(this);
  }

  toJSON() { return { step: this.step, reason: this.reason, ts: this.ts, currentTaskId: this.currentTaskId }; }
  toActivityText() { return `${BROAD_MODE_LEDGER_PREFIX}${JSON.stringify(this.toJSON())}`; }
  static fromActivityNote(note) {
    if (typeof note?.text !== "string" || !note.text.startsWith(BROAD_MODE_LEDGER_PREFIX)) return null;
    return new BroadModeLedgerEntry(JSON.parse(note.text.slice(BROAD_MODE_LEDGER_PREFIX.length)));
  }
}

function broadModeHistory(state) {
  return (Array.isArray(state?.notes) ? state.notes : [])
    .map((note) => BroadModeLedgerEntry.fromActivityNote(note))
    .filter((entry) => entry !== null)
    .map((entry) => entry.toJSON());
}

export class TaskScopeDecision {
  constructor({ kind, task = null, record = null, reason = "" }) {
    this.kind = kind;
    this.task = task;
    this.record = record;
    this.reason = reason;
    Object.freeze(this);
  }

  get ok() {
    return this.kind === "flow" || this.kind === "task" || this.kind === "broad";
  }

  get promotable() {
    return this.kind === "promote";
  }

  get blocked() {
    return this.kind === "blocked"
      || this.kind === "invalid-current-task"
      || this.kind === "invalid-review-scope";
  }
}

function taskHasInProgressStep(task) {
  return Array.isArray(task?.steps) && task.steps.some((s) => s.status === "in_progress");
}

function isActionableTask(task) {
  return typeof task?.spec === "string" && task.spec.trim() !== "";
}

function hasTaskWork(state) {
  return Array.isArray(state?.tasks)
    && state.tasks.some((t) => isActionableTask(t) && !isTaskTerminalStatus(t.status));
}

function hasInProgressTask(state) {
  return Array.isArray(state?.tasks)
    && state.tasks.some((t) => isActionableTask(t) && t.status === "in_progress");
}

function hasAnyInProgressTaskStep(state) {
  return Array.isArray(state?.tasks)
    && state.tasks.some((t) => isActionableTask(t) && taskHasInProgressStep(t));
}

function findNextPendingActionableTask(tasks) {
  return findNextPendingTask(tasks.filter((task) => isActionableTask(task)));
}

export function latestBroadModeRecord(state, step) {
  const history = broadModeHistory(state);
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.step !== step) continue;
    if (entry.currentTaskId !== (state.currentTaskId ?? null)) continue;
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") continue;
    return entry;
  }
  return null;
}

export function buildBoundedBroadModeHistory(state, limit) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  const history = broadModeHistory(state);
  const entries = history.slice(-max).map((entry) => ({
    step: entry.step,
    reason: entry.reason,
    ts: entry.ts,
    currentTaskId: entry.currentTaskId ?? null,
  }));
  return {
    entries,
    total: history.length,
    truncated: Math.max(0, history.length - entries.length),
  };
}

export function createBroadModeRecord(state, step, reason) {
  return new BroadModeLedgerEntry({
    step: String(step || "").trim(),
    reason: String(reason || "").trim(),
    ts: new Date().toISOString(),
    currentTaskId: state?.currentTaskId ?? null,
  });
}

export function assertAuditedBroadMode(decision, step) {
  if (decision?.kind !== "broad") return null;
  const record = decision.record;
  if (!record || record.step !== step || typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new Error(`audited broad mode record is required before broad ${step} execution`);
  }
  return {
    step: record.step,
    reason: record.reason,
    ts: record.ts,
    currentTaskId: record.currentTaskId ?? null,
  };
}

export function evaluateTaskScope(state, step) {
  if (!hasTaskWork(state)) return new TaskScopeDecision({ kind: "flow" });

  if (state.currentTaskId != null) {
    const task = Array.isArray(state.tasks)
      ? state.tasks.find((t) => t.id === state.currentTaskId)
      : null;
    if (!task) {
      return new TaskScopeDecision({
        kind: "invalid-current-task",
        reason: `currentTaskId '${state.currentTaskId}' does not match any task`,
      });
    }
    return new TaskScopeDecision({ kind: "task", task });
  }

  const record = latestBroadModeRecord(state, step);
  if (record) return new TaskScopeDecision({ kind: "broad", record });

  const next = findNextPendingActionableTask(state.tasks);
  if (next && !hasInProgressTask(state) && !hasAnyInProgressTaskStep(state)) {
    return new TaskScopeDecision({ kind: "promote", task: next });
  }

  return new TaskScopeDecision({
    kind: "blocked",
    reason: "task work remains but currentTaskId is null and safe promotion is not possible",
  });
}

function activeFlowImplReviews(state) {
  return flattenSteps(Array.isArray(state?.steps) ? state.steps : [])
    .filter((step) => step.id === "impl-review" && step.status === "in_progress");
}

function activeTaskImplReviews(state) {
  if (!Array.isArray(state?.tasks)) return [];
  return state.tasks.filter((task) => (
    isActionableTask(task)
    && !isTaskTerminalStatus(task.status)
    && Array.isArray(task.steps)
    && task.steps.some((step) => step.id === "task-review" && step.status === "in_progress")
  ));
}

function invalidImplReviewScope(reason) {
  return new TaskScopeDecision({ kind: "invalid-review-scope", reason });
}

export function resolveImplReviewScope(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const currentTask = state?.currentTaskId == null
    ? null
    : tasks.find((task) => task.id === state.currentTaskId) || null;
  if (state?.currentTaskId != null && !currentTask) {
    return new TaskScopeDecision({
      kind: "invalid-current-task",
      reason: `currentTaskId '${state.currentTaskId}' does not match any task`,
    });
  }

  const flowReviews = activeFlowImplReviews(state);
  const taskReviews = activeTaskImplReviews(state);
  if (flowReviews.length === 1 && taskReviews.length === 0) {
    if (currentTask || !hasTaskWork(state)) {
      return new TaskScopeDecision({ kind: "flow" });
    }
    const record = latestBroadModeRecord(state, "impl-review");
    if (record) return new TaskScopeDecision({ kind: "broad", record });
    return new TaskScopeDecision({
      kind: "blocked",
      reason: "task work remains but currentTaskId is null and broad impl-review is not audited",
    });
  }

  if (flowReviews.length === 0 && taskReviews.length === 1) {
    const reviewTask = taskReviews[0];
    if (currentTask?.id === reviewTask.id) {
      return new TaskScopeDecision({ kind: "task", task: reviewTask });
    }
    return invalidImplReviewScope(
      `active task-review belongs to '${reviewTask.id}' but currentTaskId is '${state?.currentTaskId ?? "null"}'`,
    );
  }

  if (flowReviews.length > 0 && taskReviews.length > 0) {
    return invalidImplReviewScope("flow impl-review and task-review are active at the same time");
  }
  if (taskReviews.length > 1) {
    return invalidImplReviewScope("multiple task-review steps are active at the same time");
  }
  return invalidImplReviewScope("no single active impl-review scope could be resolved");
}

export function taskScopeViolationMessages(decision, step) {
  const reason = decision?.reason || "task cursor is required";
  return [
    `${reason}.`,
    `Restore a task cursor with: sennel flow run start-task --task-id <task-id>`,
    `For intentional broad ${step} work, first run: sennel flow set broad on --step ${step} --reason "<reason>"`,
  ];
}
