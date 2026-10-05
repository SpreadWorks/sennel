/**
 * src/flow/lib/run-start-task.js
 *
 * FlowCommand: `flow run start-task --task-id <id>` — claim the
 * definition-owned first Step of a pending Task through a typed Attempt.
 *
 * Spec 226: thin wrapper. Validation (unknown id / invalid status transition)
 * is delegated to the canonical Version Store primitive via `throw`. The CLI layer only
 * resolves arguments and formats the envelope.
 */

import { FlowCommand } from "./base-command.js";
import { FlowManager } from "../../lib/flow-manager.js";
import { Envelope } from "../../lib/flow-envelope.js";

export class RunStartTaskCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    const taskId = typeof ctx.taskId === "string" && ctx.taskId.trim()
      ? ctx.taskId.trim()
      : null;
    if (!taskId) {
      return Envelope.fail("run", "start-task", "MISSING_TASK_ID", "--task-id is required");
    }

    const { root } = ctx;
    const fm = ctx.flowManager || new FlowManager({ root, mainRoot: root, inWorktree: false });
    const state = ctx.flowState || fm.load();
    if (!state) {
      return Envelope.fail("run", "start-task", "NO_ACTIVE_FLOW", "no active flow found");
    }

    const task = (state.tasks || []).find((t) => t.id === taskId);
    if (!task) {
      return Envelope.fail("run", "start-task", "UNKNOWN_TASK_ID", `unknown task id: ${taskId}`);
    }
    if (task.status === "done") {
      return Envelope.fail(
        "run",
        "start-task",
        "TASK_ALREADY_DONE",
        `task ${taskId} already done (cannot restart)`,
      );
    }

    try {
      fm.startTask(taskId, { ...(ctx.specId ? { specId: ctx.specId } : {}) });
    } catch (error) {
      return Envelope.fail("run", "start-task", error.code || "TASK_START_INVALID", error.message);
    }

    return Envelope.ok("run", "start-task", {
      taskId,
      currentTaskId: taskId,
      status: "in_progress",
    });
  }
}

export default RunStartTaskCommand;
