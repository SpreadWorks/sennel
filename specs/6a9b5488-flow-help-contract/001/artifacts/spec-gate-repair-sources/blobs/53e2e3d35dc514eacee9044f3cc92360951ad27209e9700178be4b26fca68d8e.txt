import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SourceMutationManifest } from "./worker-artifact-handoff.js";
import { TaskExecutionBudget } from "./task-execution-policy.js";

const SHA = /^[a-f0-9]{64}$/;
const text = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
};
const digest = (value, field) => {
  const result = text(value, field).toLowerCase();
  if (!SHA.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
};

/** Immutable lineage of one Task source Attempt. */
export { TaskExecutionBudget } from "./task-execution-policy.js";

export class TaskMutationLineage {
  constructor({ runId, specId, taskId, role, attempt, budget, sourceFingerprint, manifest, noChangeReason = null } = {}) {
    this.runId = text(runId, "Task mutation lineage runId");
    this.specId = text(specId, "Task mutation lineage specId");
    this.taskId = text(taskId, "Task mutation lineage taskId");
    this.role = text(role, "Task mutation lineage role");
    if (!new Set(["implementation", "repair"]).has(this.role)) throw new Error("Task mutation lineage role is invalid");
    if (!attempt || typeof attempt !== "object") throw new Error("Task mutation lineage Attempt is required");
    this.attempt = Object.freeze({ id: text(attempt.id, "Task mutation lineage Attempt id"), sequence: attempt.sequence });
    if (!Number.isSafeInteger(this.attempt.sequence) || this.attempt.sequence < 1) throw new Error("Task mutation lineage Attempt sequence is invalid");
    this.budget = budget instanceof TaskExecutionBudget ? budget : new TaskExecutionBudget(budget);
    this.sourceFingerprint = digest(sourceFingerprint, "Task mutation lineage sourceFingerprint");
    const parsedManifest = SourceMutationManifest.fromStored(manifest);
    if (parsedManifest.attempt.id !== this.attempt.id || parsedManifest.attempt.sequence !== this.attempt.sequence) {
      throw new Error("Task mutation lineage manifest does not bind its Attempt");
    }
    if (digest(sourceFingerprint, "Task mutation lineage sourceFingerprint") !== parsedManifest.digest) {
      throw new Error("Task mutation lineage sourceFingerprint must equal manifest digest");
    }
    this.manifest = Object.freeze(parsedManifest.toJSON());
    this.noChangeReason = noChangeReason == null ? null : text(noChangeReason, "Task mutation noChangeReason");
    this.paths = Object.freeze([...new Set(this.manifest.mutations.map((entry) => text(entry.path, "Task mutation path")))].sort());
    this.fingerprint = crypto.createHash("sha256").update(JSON.stringify(this.toJSON())).digest("hex");
    Object.freeze(this);
  }
  toJSON() { return { runId: this.runId, specId: this.specId, taskId: this.taskId, role: this.role, attempt: this.attempt, budget: this.budget.toJSON(), sourceFingerprint: this.sourceFingerprint, manifest: this.manifest, noChangeReason: this.noChangeReason }; }
}

/** Current Task-only allow-list; foreign Task lineages are rejected, never merged. */
export class TaskMutationLineageSet {
  constructor({ runId, specId, taskId, lineages = [] } = {}) {
    this.runId = text(runId, "Task lineage set runId"); this.specId = text(specId, "Task lineage set specId");
    this.taskId = text(taskId, "Task lineage set taskId");
    this.lineages = Object.freeze(lineages.map((value) => value instanceof TaskMutationLineage ? value : new TaskMutationLineage(value)));
    for (const lineage of this.lineages) {
      if (lineage.runId !== this.runId || lineage.specId !== this.specId || lineage.taskId !== this.taskId) throw new Error("Task mutation lineage is stale or belongs to another Task");
    }
    const implementations = this.lineages.filter((lineage) => lineage.role === "implementation");
    if (implementations.some((lineage, index) => lineage.budget.round !== index + 1)) {
      throw new Error("Task implementation lineage rounds are missing, duplicated, or out of order");
    }
    if (this.lineages.some((lineage) => !implementations.some((implementation) => implementation.budget.round === lineage.budget.round))) {
      throw new Error("Task repair lineage has no implementation round");
    }
    const budgetByRound = new Map(implementations.map((lineage) => [lineage.budget.round, JSON.stringify(lineage.budget.toJSON())]));
    if (this.lineages.some((lineage) => JSON.stringify(lineage.budget.toJSON()) !== budgetByRound.get(lineage.budget.round))) {
      throw new Error("Task repair lineage budget does not match its implementation round");
    }
    this.paths = Object.freeze([...new Set(this.lineages.flatMap((lineage) => lineage.paths))].sort());
    Object.freeze(this);
  }

  noChangeReasons() {
    return Object.freeze(this.lineages
      .filter((lineage) => lineage.paths.length === 0 && lineage.noChangeReason !== null)
      .map((lineage) => lineage.noChangeReason));
  }

  get currentBudget() { return this.lineages.at(-1)?.budget ?? null; }
}

/**
 * Rehydrate and verify one Task's immutable lineage publications from a
 * caller-owned canonical catalog snapshot. Both ordinary Store readers and
 * lock-scoped transition readers use this one authority-preserving loader.
 */
export function readTaskMutationLineagesFromCatalog({ state, catalog, activities, taskId, readCatalogedArtifact } = {}) {
  const id = text(taskId, "Task mutation lineage taskId");
  if (!state?.findNode?.(id)) throw new Error(`canonical Task is absent: ${id}`);
  if (!catalog || !Array.isArray(catalog.artifacts) || !Array.isArray(activities) || typeof readCatalogedArtifact !== "function") {
    throw new Error("Task mutation lineage loader requires canonical state, catalog, Activities and reader");
  }
  const lineages = catalog.artifacts
    .filter((entry) => entry.logicalKey === "task.mutation.lineage"
      && entry.relativePath.startsWith(`steps/impl/${id}/impl/mutation-lineage/`))
    .map((entry) => {
      const match = entry.relativePath.match(/mutation-lineage\/([^/]+)\.json$/);
      if (!match) throw new Error("Task mutation lineage catalog path is invalid");
      let document;
      try { document = JSON.parse(readCatalogedArtifact(entry).toString("utf8")); }
      catch (cause) { throw new Error(`Task mutation lineage is invalid JSON: ${cause.message}`); }
      const lineage = new TaskMutationLineage(document);
      const publication = activities.find((activity) => activity.id === entry.activityId) ?? null;
      const expectedProducer = lineage.role === "implementation" ? `${id}-impl` : `${id}-repair`;
      if (lineage.taskId !== id || lineage.runId !== state.runId || lineage.specId !== state.specId || lineage.attempt.id !== match[1]
        || publication?.nodeId !== expectedProducer || publication.attemptId !== lineage.attempt.id
        || publication.sequence !== lineage.attempt.sequence) {
        throw new Error("Task mutation lineage publication is inconsistent");
      }
      return lineage;
    })
    .sort((left, right) => left.budget.round - right.budget.round
      || left.role.localeCompare(right.role) || left.attempt.sequence - right.attempt.sequence || left.attempt.id.localeCompare(right.attempt.id));
  new TaskMutationLineageSet({ runId: state.runId, specId: state.specId, taskId: id, lineages });
  return Object.freeze(lineages);
}

/** Unaccepted source changes cannot be retried as ordinary tooling failures. */
export class TaskReviewSourceEffectRejection extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskReviewSourceEffectRejection";
    this.code = "TASK_REVIEW_SOURCE_EFFECT_REJECTED";
    this.retryable = false;
  }
}

class CurrentTaskSourceEntry {
  constructor(relativePath) {
    if (new.target === CurrentTaskSourceEntry) throw new Error("CurrentTaskSourceEntry is abstract");
    const normalized = text(relativePath, "Task source path").split(path.sep).join("/");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`Task source path is unsafe: ${relativePath}`);
    }
    this.path = normalized;
  }
}

export class CurrentTaskSourceFile extends CurrentTaskSourceEntry {
  constructor({ path: relativePath, content } = {}) {
    super(relativePath);
    if (typeof content !== "string") throw new Error(`Task source content must be text: ${this.path}`);
    this.content = content;
    Object.freeze(this);
  }
  toJSON() { return { path: this.path, status: "present", content: this.content }; }
}

export class CurrentTaskSourceDeletion extends CurrentTaskSourceEntry {
  constructor({ path: relativePath } = {}) {
    super(relativePath);
    Object.freeze(this);
  }
  toJSON() { return { path: this.path, status: "deleted" }; }
}

/** Current contents of only the paths authorized by one Task's validated Attempt manifests. */
export class CurrentTaskSourceSnapshot {
  constructor({ lineageSet, entries = [] } = {}) {
    if (!(lineageSet instanceof TaskMutationLineageSet)) throw new Error("Task source snapshot requires a lineage set");
    this.runId = lineageSet.runId;
    this.specId = lineageSet.specId;
    this.taskId = lineageSet.taskId;
    this.lineageFingerprints = Object.freeze(lineageSet.lineages.map((lineage) => lineage.fingerprint));
    this.noChangeReasons = lineageSet.noChangeReasons();
    this.entries = Object.freeze(entries.map((entry) => {
      if (entry instanceof CurrentTaskSourceFile || entry instanceof CurrentTaskSourceDeletion) return entry;
      return entry?.status === "deleted"
        ? new CurrentTaskSourceDeletion(entry)
        : new CurrentTaskSourceFile(entry);
    }));
    const actual = this.entries.map((entry) => entry.path);
    if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify([...lineageSet.paths])) {
      throw new Error("Task source snapshot does not match its manifest allow-list");
    }
    this.fingerprint = crypto.createHash("sha256").update(JSON.stringify(this.unsignedJSON())).digest("hex");
    Object.freeze(this);
  }

  static capture({ root, lineageSet } = {}) {
    if (!(lineageSet instanceof TaskMutationLineageSet)) throw new Error("Task source capture requires a lineage set");
    const repositoryRoot = path.resolve(text(root, "Task source root"));
    const entries = lineageSet.paths.map((relativePath) => {
      const absolute = path.resolve(repositoryRoot, relativePath);
      if (absolute === repositoryRoot || !absolute.startsWith(`${repositoryRoot}${path.sep}`)) {
        throw new Error(`Task source path escapes repository: ${relativePath}`);
      }
      if (!fs.existsSync(absolute)) return new CurrentTaskSourceDeletion({ path: relativePath });
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task source is not a regular file: ${relativePath}`);
      return new CurrentTaskSourceFile({ path: relativePath, content: fs.readFileSync(absolute, "utf8") });
    });
    return new CurrentTaskSourceSnapshot({ lineageSet, entries });
  }

  unsignedJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      taskId: this.taskId,
      lineageFingerprints: [...this.lineageFingerprints],
      noChangeReasons: [...this.noChangeReasons],
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }

  toJSON() { return { ...this.unsignedJSON(), fingerprint: this.fingerprint }; }
}

export function captureCurrentTaskSource({ root, flowManager, state, taskId } = {}) {
  return CurrentTaskSourceSnapshot.capture({
    root,
    lineageSet: new TaskMutationLineageSet({
      runId: state.runId,
      specId: state.specId,
      taskId,
      lineages: flowManager.taskMutationLineages({ specId: state.specId, taskId }),
    }),
  });
}
