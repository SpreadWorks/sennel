import fs from "node:fs";
import path from "node:path";
import { TaskCollection, TaskId } from "./task-values.js";

export class TaskOutputPath {
  constructor(tasksDir, taskId) {
    if (typeof tasksDir !== "string" || tasksDir.length === 0) {
      throw new Error("TaskOutputPath requires a tasks directory");
    }
    if (!(taskId instanceof TaskId)) {
      throw new Error("TaskOutputPath requires a TaskId");
    }

    const resolvedTasksDir = path.resolve(tasksDir);
    const candidate = path.resolve(resolvedTasksDir, `${taskId.value}.md`);
    if (path.dirname(candidate) !== resolvedTasksDir) {
      throw new Error(`TaskOutputPath is not confined to ${resolvedTasksDir}`);
    }

    this.value = candidate;
    Object.freeze(this);
  }
}

/**
 * Resolves regenerated human-facing views below the Version-local runtime
 * area.  `spec.json` remains the only durable Spec authority; Markdown is an
 * on-demand view and must never become an unclassified catalog artifact.
 */
export class SpecRenderOutputLocation {
  constructor({ specDir, specMarkdownFile = null } = {}) {
    if (typeof specDir !== "string" || specDir.trim() === "") {
      throw new Error("SpecRenderOutputLocation requires a spec directory");
    }
    this.specDir = path.resolve(specDir);
    this.runtimeDirectory = path.join(this.specDir, ".runtime", "spec-render");
    this.specMarkdownFile = specMarkdownFile == null
      ? path.join(this.runtimeDirectory, "spec.md")
      : path.resolve(specMarkdownFile);
    this.tasksDirectory = path.join(this.runtimeDirectory, "tasks");
    Object.freeze(this);
  }
}

class TaskRenderEntry {
  constructor(task, outputPath, markdown) {
    this.task = task;
    this.outputPath = outputPath;
    this.markdown = markdown;
    Object.freeze(this);
  }
}

export class TaskRenderPlan {
  #entries;

  constructor({ collection, tasksDir, renderTask }) {
    if (!(collection instanceof TaskCollection)) {
      throw new Error("TaskRenderPlan requires a TaskCollection");
    }
    if (typeof renderTask !== "function") {
      throw new Error("TaskRenderPlan requires a task renderer");
    }

    const entries = [];
    for (const task of collection) {
      const outputPath = new TaskOutputPath(tasksDir, task.id);
      entries.push(new TaskRenderEntry(task, outputPath, renderTask(task)));
    }
    this.#entries = Object.freeze(entries);
    Object.freeze(this);
  }

  get size() {
    return this.#entries.length;
  }

  [Symbol.iterator]() {
    return this.#entries[Symbol.iterator]();
  }
}

class SpecRenderMeta {
  constructor({ title, featureBranch, created, input }) {
    this.title = title;
    this.featureBranch = featureBranch;
    this.created = created;
    this.status = "Draft";
    this.input = input;
    Object.freeze(this);
  }
}

export class SpecRenderContext {
  #meta;

  constructor({ root, specDir, specJsonPath, flowState = null }) {
    if (!root || !specDir || !specJsonPath) {
      throw new Error("SpecRenderContext requires root, specDir, and specJsonPath");
    }

    const resolvedRoot = path.resolve(root);
    const resolvedSpecDir = path.resolve(specDir);
    const resolvedSpecJsonPath = path.resolve(specJsonPath);
    if (path.dirname(resolvedSpecJsonPath) !== resolvedSpecDir) {
      throw new Error("SpecRenderContext spec.json must belong to the selected spec directory");
    }
    const matchingFlow = flowState !== null
      && typeof flowState === "object"
      && !Array.isArray(flowState)
      && typeof flowState.specId === "string"
      && flowState.specId !== ""
      ? flowState
      : null;
    const title = matchingFlow?.specId || path.basename(resolvedSpecDir);

    this.#meta = new SpecRenderMeta({
      title,
      featureBranch: matchingFlow?.featureBranch || `feature/${title}`,
      created: fs.statSync(resolvedSpecJsonPath).mtime.toISOString().slice(0, 10),
      input: matchingFlow?.issue ? `GitHub Issue #${matchingFlow.issue}` : "User request",
    });
    Object.freeze(this);
  }

  toRenderMeta() {
    return this.#meta;
  }
}
