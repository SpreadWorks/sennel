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
    if (typeof nodeId !== "string") return null;
    if (Array.isArray(state?.tasks)) {
      for (const task of state.tasks) {
        const identity = TaskStepIdentity.fromTaskNode(task, nodeId);
        if (identity !== null) return identity;
      }
      return null;
    }
    if (typeof state?.findNode !== "function" || state.root === undefined || state.definition === undefined) return null;
    const node = state.findNode(nodeId);
    const definition = node === null ? null : state.definition.definitionNodeFor(node);
    const role = typeof definition?.id === "string" && definition.id.startsWith("task-")
      ? definition.id.slice("task-".length)
      : null;
    const task = state.definition.pathFor(state.root, nodeId)
      ?.map((id) => state.findNode(id))
      .find((candidate) => candidate?.kind === "task") ?? null;
    return task === null || !TASK_STEP_ROLES.includes(role)
      ? null
      : new TaskStepIdentity({ taskId: task.id, role });
  }

  static active(state) {
    const nodeId = state?.currentNodeId
      ?? state?.tasks?.find((task) => task.id === state?.currentTaskId)
        ?.steps?.find((step) => step.status === "in_progress")?.id
      ?? null;
    return TaskStepIdentity.fromStateNode(state, nodeId);
  }
}
