const TASK_STEP_ROLES = Object.freeze(["impl", "review", "triage", "repair", "gate"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Stable identity for one materialized Task lifecycle leaf.
 *
 * The definition owns aliases such as `task-gate`; the Version state owns the
 * globally unique node id `<taskId>-gate`.  This type is the only translation
 * boundary between those two identities.
 */
export class TaskStepIdentity {
  constructor({ taskId, role } = {}) {
    this.taskId = requiredText(taskId, "Task Step taskId");
    this.role = requiredText(role, "Task Step role");
    if (!TASK_STEP_ROLES.includes(this.role)) {
      throw new TypeError(`unsupported Task Step role: ${this.role}`);
    }
    Object.freeze(this);
  }

  get nodeId() { return `${this.taskId}-${this.role}`; }
  get definitionId() { return `task-${this.role}`; }

  matchesNode(nodeId) { return nodeId === this.nodeId; }

  static fromTaskNode(task, nodeId) {
    if (!task || !Array.isArray(task.steps)) return null;
    if (!task.steps.some((step) => step.id === nodeId)) return null;
    for (const role of TASK_STEP_ROLES) {
      const identity = new TaskStepIdentity({ taskId: task.id, role });
      if (identity.matchesNode(nodeId)) return identity;
    }
    return null;
  }

  static fromStateNode(state, nodeId) {
    if (!Array.isArray(state?.tasks) || typeof nodeId !== "string") return null;
    for (const task of state.tasks) {
      const identity = TaskStepIdentity.fromTaskNode(task, nodeId);
      if (identity !== null) return identity;
    }
    return null;
  }

  static active(state) {
    const nodeId = state?.currentNodeId
      ?? state?.tasks?.find((task) => task.id === state?.currentTaskId)
        ?.steps?.find((step) => step.status === "in_progress")?.id
      ?? null;
    return TaskStepIdentity.fromStateNode(state, nodeId);
  }
}
