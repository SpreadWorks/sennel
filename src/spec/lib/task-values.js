const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_TASKS = 200;

export class TaskId {
  constructor(value) {
    const match = typeof value === "string" ? TASK_ID_PATTERN.exec(value) : null;
    if (match === null || match[0] !== value) {
      throw new Error(`invalid TaskId: ${JSON.stringify(value)}`);
    }
    this.value = value;
    Object.freeze(this);
  }

  toString() {
    return this.value;
  }
}

class ValidatedTask {
  constructor(source, id, parent) {
    Object.assign(this, source, { id, parent });
    Object.freeze(this);
  }
}

export class TaskCollection {
  #entries;
  #byId;

  constructor(tasks) {
    if (!Array.isArray(tasks)) throw new Error("task collection must be an array");
    if (tasks.length > MAX_TASKS) throw new Error(`task collection exceeds ${MAX_TASKS} entries`);

    const entries = [];
    const byId = new Map();
    for (const task of tasks) {
      const snapshot = { ...task };
      const id = new TaskId(snapshot.id);
      const parent = snapshot.parent == null ? null : new TaskId(snapshot.parent);
      if (byId.has(id.value)) throw new Error(`duplicate TaskId: ${id.value}`);
      const entry = new ValidatedTask(snapshot, id, parent);
      entries.push(entry);
      byId.set(id.value, entry);
    }

    for (const entry of entries) {
      if (entry.parent !== null && !byId.has(entry.parent.value)) {
        throw new Error(`task ${entry.id.value} references missing parent ${entry.parent.value}`);
      }
    }

    this.#entries = Object.freeze(entries);
    this.#byId = byId;
    Object.freeze(this);
  }

  get size() { return this.#entries.length; }

  get(id) {
    const taskId = id instanceof TaskId ? id : new TaskId(id);
    return this.#byId.get(taskId.value);
  }

  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }

  /** Parent-before-child admission order while preserving sibling proposal order. */
  admissionOrder() {
    const ordered = [];
    const visited = new Set();
    const visiting = new Set();
    const visit = (entry) => {
      if (visited.has(entry.id.value)) return;
      if (visiting.has(entry.id.value)) throw new Error(`Task parent graph contains a cycle at ${entry.id.value}`);
      visiting.add(entry.id.value);
      if (entry.parent !== null) visit(this.#byId.get(entry.parent.value));
      visiting.delete(entry.id.value);
      visited.add(entry.id.value);
      ordered.push(entry);
    };
    for (const entry of this.#entries) visit(entry);
    return Object.freeze(ordered);
  }
}
