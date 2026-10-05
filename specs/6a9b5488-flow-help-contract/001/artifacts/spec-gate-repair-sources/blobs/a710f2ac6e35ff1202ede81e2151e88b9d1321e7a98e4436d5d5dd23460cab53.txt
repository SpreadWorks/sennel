import crypto from "node:crypto";
import { CanonicalTaskRequirementMap } from "../../lib/canonical-task-requirement-map.js";
import { canonicalTaskContextKinds } from "./task-context-kinds.js";
import { CurrentTaskSourceSnapshot, captureCurrentTaskSource } from "./task-mutation-lineage.js";

export { CanonicalTaskRequirementMap } from "../../lib/canonical-task-requirement-map.js";
export { canonicalTaskContextKinds } from "./task-context-kinds.js";

const SOURCE_FINGERPRINT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requiredDigest(value, field) {
  const digest = requiredText(value, field).toLowerCase();
  if (!SOURCE_FINGERPRINT.test(digest)) throw new Error(`${field} must be a Git or SHA-256 fingerprint`);
  return digest;
}

function json(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskDocument(spec, taskId) {
  const task = spec.tasks.find((entry) => entry?.id === taskId) ?? null;
  if (task === null) throw new Error(`canonical current Task is absent from spec: ${taskId}`);
  return Object.freeze(structuredClone(task));
}

function uniqueTextArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  const entries = value.map((entry, index) => requiredText(entry, `${field}[${index}]`));
  if (new Set(entries).size !== entries.length) throw new Error(`${field} must not duplicate`);
  return Object.freeze(entries);
}

function projectedRequirements(value, { taskId, taskIds }) {
  if (!Array.isArray(value)) throw new Error("canonical Task projected requirements must be an array");
  const knownTaskIds = new Set(taskIds);
  const requirementIds = new Set();
  const requirements = value.map((entry, index) => {
    const requirement = json(entry, `canonical Task projected requirement[${index}]`);
    const id = requiredText(requirement.id, `canonical Task projected requirement[${index}].id`);
    if (requirementIds.has(id)) throw new Error(`canonical Task projected Requirement ids must be unique: ${id}`);
    requirementIds.add(id);
    const mappedTaskIds = uniqueTextArray(
      requirement.task_ids,
      `canonical Task projected requirement[${index}].task_ids`,
    );
    for (const mappedTaskId of mappedTaskIds) {
      if (!knownTaskIds.has(mappedTaskId)) {
        throw new Error(`canonical Task projected requirement[${index}].task_ids references unknown Task: ${mappedTaskId}`);
      }
    }
    if (!mappedTaskIds.includes(taskId)) {
      throw new Error(`canonical Task projected requirement[${index}] does not map current Task: ${taskId}`);
    }
    return Object.freeze({ ...structuredClone(requirement), id, task_ids: mappedTaskIds });
  });
  if (requirements.length === 0) throw new Error(`canonical Task has no mapped Requirements: ${taskId}`);
  return Object.freeze(requirements);
}

function contextFingerprint({ runId, specId, task, requirements, overview, sourceFingerprint }) {
  return crypto.createHash("sha256").update(stableJson({
    runId,
    specId,
    task,
    requirements,
    overview,
    sourceFingerprint,
  })).digest("hex");
}

/**
 * Worker-facing projection of a CanonicalTaskContext for one Task Step.
 *
 * The action descriptor, materialized Task context artifact, and worker
 * prompt all consume this object's Task input. Source is included only for
 * Steps whose static contract requires it and must match the same source
 * fingerprint that bound the Task context.
 */
export class CanonicalTaskWorkerContextProjection {
  constructor({ context, stepId, source = null } = {}) {
    if (!(context instanceof CanonicalTaskContext)) {
      throw new Error("canonical Task worker context requires a CanonicalTaskContext");
    }
    this.context = context;
    this.stepId = requiredText(stepId, "canonical Task worker Step id");
    this.kinds = canonicalTaskContextKinds(this.stepId);
    const requiresSource = this.kinds.includes("source");
    if (requiresSource && !(source instanceof CurrentTaskSourceSnapshot)) {
      throw new Error(`canonical Task worker context requires current source for ${this.stepId}`);
    }
    if (!requiresSource && source !== null) {
      throw new Error(`canonical Task worker context does not accept source for ${this.stepId}`);
    }
    if (source !== null && source.fingerprint !== context.sourceFingerprint) {
      throw new Error("canonical Task worker source does not match the Task context fingerprint");
    }
    this.source = source;
    this.task = context.readOnlyInput();
    Object.freeze(this);
  }

  toJSON() {
    return Object.freeze({
      kinds: [...this.kinds],
      task: this.task,
      ...(this.source === null ? {} : { source: this.source.toJSON() }),
    });
  }
}

/** A stable current-Task context projected into every worker-facing surface. */
export class CanonicalTaskContext {
  constructor({ state, spec, sourceFingerprint } = {}) {
    const flow = json(state, "canonical Flow state");
    this.runId = requiredText(flow.runId, "canonical Flow runId");
    this.specId = requiredText(flow.specId, "canonical Flow specId");
    this.taskId = requiredText(flow.currentTaskId, "canonical Flow currentTaskId");
    const document = structuredClone(json(spec, "canonical spec"));
    if (!Array.isArray(document.tasks)) throw new Error("canonical spec tasks must be an array");
    this.taskIds = Object.freeze(document.tasks.map((entry, index) => requiredText(entry?.id, `canonical task[${index}].id`)));
    this.task = taskDocument(document, this.taskId);
    this.requirements = new CanonicalTaskRequirementMap(document).forTask(this.taskId);
    if (this.requirements.length === 0) throw new Error(`canonical Task has no mapped Requirements: ${this.taskId}`);
    this.overview = Object.freeze(structuredClone(json(document.overview, "canonical spec overview")));
    this.sourceFingerprint = requiredDigest(sourceFingerprint, "canonical Task source fingerprint");
    this.fingerprint = contextFingerprint(this);
    Object.freeze(this);
  }

  /** Rebuild and validate the intentionally task-scoped worker projection. */
  static fromReadOnlyInput(value) {
    const document = json(value, "canonical Task read-only input");
    const lineage = json(document.lineage, "canonical Task read-only input lineage");
    const context = Object.create(CanonicalTaskContext.prototype);
    context.runId = requiredText(lineage.runId, "canonical Task read-only input runId");
    context.specId = requiredText(lineage.specId, "canonical Task read-only input specId");
    context.taskId = requiredText(lineage.taskId, "canonical Task read-only input taskId");
    context.taskIds = uniqueTextArray(lineage.taskIds, "canonical Task read-only input taskIds");
    if (!context.taskIds.includes(context.taskId)) {
      throw new Error("canonical Task read-only input taskIds must include current Task");
    }
    const task = json(document.task, "canonical Task read-only input task");
    if (requiredText(task.id, "canonical Task read-only input task.id") !== context.taskId) {
      throw new Error("canonical Task read-only input task.id must match current Task");
    }
    context.task = Object.freeze(structuredClone(task));
    context.requirements = projectedRequirements(document.requirements, context);
    context.overview = Object.freeze(structuredClone(json(document.overview, "canonical Task read-only input overview")));
    context.sourceFingerprint = requiredDigest(
      lineage.sourceFingerprint,
      "canonical Task read-only input source fingerprint",
    );
    context.fingerprint = contextFingerprint(context);
    if (context.fingerprint !== requiredDigest(document.fingerprint, "canonical Task read-only input fingerprint")) {
      throw new Error("canonical Task read-only input fingerprint is invalid");
    }
    return Object.freeze(context);
  }

  /** Capture the complete read-only Task boundary before any worker lease or mutation. */
  static capture({ root, flowManager, state, taskId, spec = null, source = null } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical Task context capture requires FlowManager catalog reads");
    }
    const currentTaskId = requiredText(taskId, "canonical Task context taskId");
    const document = spec ?? (() => {
      const source = flowManager.readArtifact({
        specId: state?.specId,
        logicalKey: "spec.record",
        consumerNodeId: state?.currentNodeId ?? state?.current?.at?.(-1),
      });
      try {
        return JSON.parse(source.bytes.toString("utf8"));
      } catch (cause) {
        throw new Error(`canonical Task spec input is invalid JSON: ${cause.message}`);
      }
    })();
    const currentSource = source ?? captureCurrentTaskSource({ root, flowManager, state, taskId: currentTaskId });
    return new CanonicalTaskContext({
      state: { runId: state?.runId, specId: state?.specId, currentTaskId },
      spec: document,
      sourceFingerprint: currentSource.fingerprint,
    });
  }

  readOnlyInput() {
    return Object.freeze({
      task: structuredClone(this.task),
      requirements: structuredClone(this.requirements),
      overview: structuredClone(this.overview),
      fingerprint: this.fingerprint,
      lineage: Object.freeze({
        runId: this.runId,
        specId: this.specId,
        taskId: this.taskId,
        taskIds: [...this.taskIds],
        sourceFingerprint: this.sourceFingerprint,
      }),
    });
  }

  projectWorkerContext({ stepId, source = null } = {}) {
    return new CanonicalTaskWorkerContextProjection({ context: this, stepId, source });
  }
}
