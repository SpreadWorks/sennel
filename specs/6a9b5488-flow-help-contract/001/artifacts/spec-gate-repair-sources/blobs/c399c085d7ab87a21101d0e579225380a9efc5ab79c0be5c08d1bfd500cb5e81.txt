/**
 * src/flow/lib/run-complete-task.js
 *
 * FlowCommand: `flow run complete-task [--task-id <id>]` — manually complete
 * a task after its canonical child Steps are complete.
 *
 * Parent status is derived from child Step confirmations. This command only
 * verifies that canonical fact; it never writes a second Task authority.
 */

import { FlowCommand } from "./base-command.js";
import { FlowManager } from "../../lib/flow-manager.js";
import { Envelope } from "../../lib/flow-envelope.js";

function soleJustCompletedTaskId(flowManager, state) {
  if (typeof flowManager.activityLedger !== "function") return null;
  const latest = flowManager.activityLedger(state.specId).at(-1) ?? null;
  if (latest?.transition?.operation !== "confirm_attempt") return null;
  const candidate = (state.tasks || []).find((task) => (
    task.id && latest.nodeId === `${task.id}-gate`
      && task.status === "done"
      && (task.steps || []).every((step) => ["done", "skipped"].includes(step.status))
  )) ?? null;
  return candidate?.id ?? null;
}

export class RunCompleteTaskCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    const { root } = ctx;
    const fm = ctx.flowManager || new FlowManager({ root, mainRoot: root, inWorktree: false });
    const state = ctx.flowState || fm.load();
    if (!state) {
      return Envelope.fail("run", "complete-task", "NO_ACTIVE_FLOW", "no active flow found");
    }

    const explicit = typeof ctx.taskId === "string" && ctx.taskId.trim()
      ? ctx.taskId.trim()
      : null;
    // A terminal task-gate clears the active Attempt and projects its Task as
    // done before this verification command runs. Resolve only the Task whose
    // immediately preceding Activity confirmed that gate; older done Tasks
    // must never become an implicit command target.
    const justCompleted = soleJustCompletedTaskId(fm, state);
    const taskId = explicit || state.currentTaskId
      || justCompleted;
    if (!taskId) {
      return Envelope.fail(
        "run",
        "complete-task",
        "NO_TASK_TARGET",
        "no currentTaskId and --task-id not specified",
      );
    }

    const task = (state.tasks || []).find((t) => t.id === taskId);
    if (!task) {
      return Envelope.fail(
        "run",
        "complete-task",
        "UNKNOWN_TASK_ID",
        `unknown task id: ${taskId}`,
      );
    }
    let completed;
    try {
      completed = fm.completeTask(taskId, { ...(ctx.specId ? { specId: ctx.specId } : {}) });
    } catch (error) {
      return Envelope.fail("run", "complete-task", "TASK_COMPLETE_INVALID", error.message);
    }
    const promoted = (completed.tasks || []).find((candidate) => candidate.status === "pending")?.id ?? null;
    const nextAction = promoted
      ? `next task ${promoted} is pending; run sennel flow get next-action`
      : "no pending tasks remain; continue with integration verification";

    return Envelope.ok("run", "complete-task", {
      completedTaskId: taskId,
      nextTaskId: promoted,
      nextAction,
      taskId,
      completed: true,
      promoted,
    });
  }
}

export default RunCompleteTaskCommand;
