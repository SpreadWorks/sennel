import { LogicalRelativePath } from "../../lib/portable-path.js";

/** A renderable Task source fragment; raw authority stays in the snapshot codec. */
export class TaskSourcePresentation {
  constructor(relativePath) {
    if (new.target === TaskSourcePresentation) throw new Error("TaskSourcePresentation is abstract");
    this.path = LogicalRelativePath.from(relativePath, "Task source path").value;
  }

  static from(entry) {
    if (entry instanceof TaskSourcePresentation) return entry;
    if (entry?.status === "present") return new TaskSourceFilePresentation(entry);
    if (entry?.status === "directory") return new TaskSourceDirectoryPresentation(entry);
    if (entry?.status === "deleted") return new TaskSourceDeletionPresentation(entry);
    throw new Error(`Task source presentation status is invalid: ${entry?.path}`);
  }
}

export class TaskSourceFilePresentation extends TaskSourcePresentation {
  constructor({ path: relativePath, content } = {}) {
    super(relativePath);
    if (typeof content !== "string") throw new Error(`Task source content must be text: ${this.path}`);
    this.content = content;
    if (new.target === TaskSourceFilePresentation) Object.freeze(this);
  }
  get status() { return "present"; }
  toMarkdown() { return `## ${this.path}\n${this.content}`; }
}

export class TaskSourceDirectoryPresentation extends TaskSourcePresentation {
  constructor({ path: relativePath } = {}) {
    super(relativePath);
    if (new.target === TaskSourceDirectoryPresentation) Object.freeze(this);
  }
  get status() { return "directory"; }
  toMarkdown() { return `## ${this.path}\n(directory)`; }
}

export class TaskSourceDeletionPresentation extends TaskSourcePresentation {
  constructor({ path: relativePath } = {}) {
    super(relativePath);
    if (new.target === TaskSourceDeletionPresentation) Object.freeze(this);
  }
  get status() { return "deleted"; }
  toMarkdown() { return `## ${this.path}\n(deleted)`; }
}
