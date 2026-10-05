function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

/** Sole, deterministic Requirement-to-Task association for a canonical Spec. */
export class CanonicalTaskRequirementMap {
  #byTaskId;

  constructor(spec) {
    const document = object(spec, "canonical spec");
    if (!Array.isArray(document.requirements) || !Array.isArray(document.tasks)) {
      throw new Error("canonical spec requires tasks and requirements arrays");
    }
    const tasks = document.tasks;
    const ids = tasks.map((task, index) => requiredText(task?.id, `canonical task[${index}].id`));
    if (new Set(ids).size !== ids.length) throw new Error("canonical spec Task ids must be unique");
    const known = new Set(ids);
    const mapped = new Map(ids.map((id) => [id, []]));
    const requirementIds = new Set();
    this.requirements = Object.freeze(document.requirements.map((requirement, index) => {
      const item = object(requirement, `canonical requirement[${index}]`);
      const requirementId = requiredText(item.id, `canonical requirement[${index}].id`);
      if (requirementIds.has(requirementId)) {
        throw new Error(`canonical spec Requirement ids must be unique: ${requirementId}`);
      }
      requirementIds.add(requirementId);
      if (!Array.isArray(item.task_ids) || item.task_ids.length === 0) {
        throw new Error(`canonical requirement[${index}].task_ids must be a non-empty array`);
      }
      const taskIds = item.task_ids.map((id) => requiredText(id, `canonical requirement[${index}].task_ids`));
      if (new Set(taskIds).size !== taskIds.length) throw new Error(`canonical requirement[${index}].task_ids must not duplicate`);
      for (const taskId of taskIds) {
        if (!known.has(taskId)) {
          throw new Error(`canonical requirement[${index}].task_ids references unknown Task: ${taskId}`);
        }
      }
      const copy = Object.freeze({ ...structuredClone(item), id: requirementId, task_ids: Object.freeze([...taskIds]) });
      taskIds.forEach((taskId) => mapped.get(taskId)?.push(copy));
      return copy;
    }));
    for (const [taskId, requirements] of mapped) {
      if (requirements.length === 0) {
        throw new Error(`canonical Task has no mapped Requirements: ${taskId}`);
      }
    }
    this.#byTaskId = new Map([...mapped.entries()].map(([taskId, requirements]) => [taskId, Object.freeze(requirements)]));
    Object.freeze(this);
  }

  forTask(taskId) {
    const id = requiredText(taskId, "canonical Task id");
    if (!this.#byTaskId.has(id)) throw new Error(`canonical Task is absent: ${id}`);
    return this.#byTaskId.get(id);
  }
}
