import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { filterByPhase, loadMergedGuardrails } from "../../lib/guardrail.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { CanonicalTaskContext } from "./task-canonical-context.js";
import { DraftReopenContext } from "./draft-reopen-context.js";

const SNAPSHOT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const CONTEXT_KINDS = new Set(["issue", "request", "guardrail", "project_overview", "reopen"]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requireDigest(value, field) {
  const result = requireString(value, field);
  if (!SHA256.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
}

function requireIssue(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive integer or null`);
  }
  return Number(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableDocument(value, field) {
  if (value == null || !["string", "object"].includes(typeof value)) {
    throw new Error(`${field} must be text or a JSON value`);
  }
  const copy = structuredClone(value);
  if (Buffer.byteLength(stableStringify(copy)) > MAX_CONTEXT_BYTES) {
    throw new Error(`${field} exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }
  return deepFreeze(copy);
}

function readContextText(filePath, field) {
  const text = captureRegularFile(filePath, { label: field, maxBytes: MAX_CONTEXT_BYTES })
    .text()
    .trim();
  if (!text) throw new Error(`${field} must not be empty`);
  return text;
}

export class WorkerContextBinding {
  constructor({ runId, specId, issue, dispatchInvocationId, actionDigest, targetDigest }) {
    this.runId = requireString(runId, "worker context binding runId");
    this.specId = requireString(specId, "worker context binding specId");
    this.issue = requireIssue(issue, "worker context binding issue");
    this.dispatchInvocationId = requireString(
      dispatchInvocationId,
      "worker context binding dispatchInvocationId",
    );
    this.actionDigest = requireDigest(actionDigest, "worker context binding actionDigest");
    this.targetDigest = requireDigest(targetDigest, "worker context binding targetDigest");
    Object.freeze(this);
  }

  static fromStored(value) {
    return new WorkerContextBinding(value || {});
  }

  matches(value) {
    try {
      const other = value instanceof WorkerContextBinding ? value : new WorkerContextBinding(value);
      return stableStringify(this.toJSON()) === stableStringify(other.toJSON());
    } catch (_) {
      return false;
    }
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      issue: this.issue,
      dispatchInvocationId: this.dispatchInvocationId,
      actionDigest: this.actionDigest,
      targetDigest: this.targetDigest,
    };
  }
}

class WorkerContextEntry {
  constructor(kind) {
    if (new.target === WorkerContextEntry) throw new Error("WorkerContextEntry is abstract");
    this.kind = requireString(kind, "worker context kind");
    if (!CONTEXT_KINDS.has(this.kind)) throw new Error(`unsupported worker context kind: ${this.kind}`);
  }
}

export class WorkerContextDocument extends WorkerContextEntry {
  constructor({ kind, document }) {
    super(kind);
    this.document = immutableDocument(document, `worker context ${this.kind}`);
    this.digest = digest(this.document);
    Object.freeze(this);
  }

  static fromStored(value) {
    const entry = new WorkerContextDocument(value || {});
    if (entry.digest !== value?.digest) throw new Error(`worker context ${entry.kind} digest is invalid`);
    return entry;
  }

  toJSON() {
    return {
      kind: this.kind,
      status: "available",
      digest: this.digest,
      document: this.document,
    };
  }
}

export class WorkerContextOmission extends WorkerContextEntry {
  constructor({ kind, reason }) {
    super(kind);
    this.reason = requireString(reason, `worker context ${this.kind} omission reason`);
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      status: "omitted",
      reason: this.reason,
    };
  }
}

function entryFromStored(value) {
  if (value?.status === "available") return WorkerContextDocument.fromStored(value);
  if (value?.status === "omitted") return new WorkerContextOmission(value);
  throw new Error("worker context entry status is invalid");
}

export class DraftInputAuthority {
  constructor(entry) {
    if (!(entry instanceof WorkerContextDocument) || !["issue", "request"].includes(entry.kind)) {
      throw new Error("draft input authority requires available Issue or request context");
    }
    this.kind = entry.kind;
    this.digest = entry.digest;
    Object.freeze(this);
  }

  static select(entries) {
    const issue = entries.find((entry) => entry.kind === "issue");
    const request = entries.find((entry) => entry.kind === "request");
    if (issue instanceof WorkerContextDocument) return new DraftInputAuthority(issue);
    if (request instanceof WorkerContextDocument) return new DraftInputAuthority(request);
    throw new Error("draft worker context requires linked Issue content or a Flow request");
  }

  static fromStored(value, entries) {
    const selected = DraftInputAuthority.select(entries);
    if (selected.kind !== value?.kind || selected.digest !== value?.digest) {
      throw new Error("draft input authority does not match its context entry");
    }
    return selected;
  }

  toJSON() {
    return { kind: this.kind, digest: this.digest };
  }
}

function issueContext(state, issueText = null) {
  if (state.issue == null) {
    return new WorkerContextOmission({ kind: "issue", reason: "no-linked-issue" });
  }
  const body = requireString(issueText, "linked Issue context").trim();
  return new WorkerContextDocument({
    kind: "issue",
    document: { number: requireIssue(state.issue, "Flow issue"), body },
  });
}

function requestContext(state) {
  if (typeof state.request !== "string" || state.request.trim() === "") {
    return new WorkerContextOmission({ kind: "request", reason: "no-flow-request" });
  }
  return new WorkerContextDocument({ kind: "request", document: state.request.trim() });
}

function guardrailContext(executionRoot) {
  const guardrails = filterByPhase(loadMergedGuardrails(executionRoot), "draft").map((guardrail) => ({
    id: guardrail.id,
    title: guardrail.title,
    body: guardrail.body.trim(),
    meta: guardrail.meta,
  }));
  return guardrails.length > 0
    ? new WorkerContextDocument({ kind: "guardrail", document: { phase: "draft", guardrails } })
    : new WorkerContextOmission({ kind: "guardrail", reason: "no-draft-guardrails" });
}

function projectOverviewContext(executionRoot) {
  const overviewPath = path.join(executionRoot, "docs", "overview.md");
  if (!fs.existsSync(overviewPath)) {
    return new WorkerContextOmission({ kind: "project_overview", reason: "docs-overview-unavailable" });
  }
  return new WorkerContextDocument({
    kind: "project_overview",
    document: readContextText(overviewPath, "project overview context"),
  });
}

function reopenContext(reopen) {
  return reopen instanceof DraftReopenContext
    ? new WorkerContextDocument({ kind: "reopen", document: reopen.toJSON() })
    : new WorkerContextOmission({ kind: "reopen", reason: "no-draft-reopen" });
}

export class DraftWorkerContextSnapshot {
  constructor({ binding, inputAuthority, entries, digest: expectedDigest = null }) {
    if (!(binding instanceof WorkerContextBinding)) {
      throw new Error("draft worker context requires a WorkerContextBinding");
    }
    if (!(inputAuthority instanceof DraftInputAuthority)) {
      throw new Error("draft worker context requires a DraftInputAuthority");
    }
    if (!Array.isArray(entries) || entries.length !== CONTEXT_KINDS.size) {
      throw new Error("draft worker context requires one entry for every context kind");
    }
    const byKind = new Map(entries.map((entry) => [entry.kind, entry]));
    if (byKind.size !== CONTEXT_KINDS.size || [...CONTEXT_KINDS].some((kind) => !byKind.has(kind))) {
      throw new Error("draft worker context kinds are incomplete or duplicated");
    }
    this.version = SNAPSHOT_VERSION;
    this.kind = "draft";
    this.binding = binding;
    this.inputAuthority = inputAuthority;
    this.entries = Object.freeze([...CONTEXT_KINDS].map((kind) => byKind.get(kind)));
    this.digest = digest(this.unsignedJSON());
    if (expectedDigest != null && this.digest !== expectedDigest) {
      throw new Error("draft worker context snapshot digest is invalid");
    }
    Object.freeze(this);
  }

  static materialize({ executionRoot, state, invocation, issueText = null, reopen = null }) {
    const binding = new WorkerContextBinding({
      runId: state.runId,
      specId: state.specId,
      issue: state.issue ?? null,
      dispatchInvocationId: invocation.id,
      actionDigest: invocation.action.digest,
      targetDigest: invocation.target?.digest,
    });
    const entries = [
      issueContext(state, issueText),
      requestContext(state),
      guardrailContext(executionRoot),
      projectOverviewContext(executionRoot),
      reopenContext(reopen),
    ];
    return new DraftWorkerContextSnapshot({
      binding,
      inputAuthority: DraftInputAuthority.select(entries),
      entries,
    });
  }

  static fromStored(value) {
    if (value?.version !== SNAPSHOT_VERSION || value?.kind !== "draft" || !Array.isArray(value.entries)) {
      throw new Error("draft worker context snapshot schema is invalid");
    }
    const entries = value.entries.map(entryFromStored);
    return new DraftWorkerContextSnapshot({
      binding: WorkerContextBinding.fromStored(value.binding),
      inputAuthority: DraftInputAuthority.fromStored(value.inputAuthority, entries),
      entries,
      digest: requireDigest(value.digest, "draft worker context digest"),
    });
  }

  assertBinding(value) {
    if (!this.binding.matches(value)) throw new Error("draft worker context binding is stale");
    return this;
  }

  unsignedJSON() {
    return {
      version: this.version,
      kind: this.kind,
      binding: this.binding.toJSON(),
      inputAuthority: this.inputAuthority.toJSON(),
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }

  toJSON() {
    return { ...this.unsignedJSON(), digest: this.digest };
  }
}

/** Immutable Task context carried through claim, dispatch, and publication. */
export class TaskWorkerContextSnapshot {
  constructor({ binding, context, digest: expectedDigest = null } = {}) {
    if (!(binding instanceof WorkerContextBinding)) throw new Error("Task worker context requires a WorkerContextBinding");
    if (!(context instanceof CanonicalTaskContext)) throw new Error("Task worker context requires a CanonicalTaskContext");
    this.version = SNAPSHOT_VERSION;
    this.kind = "task";
    this.binding = binding;
    this.context = context;
    this.digest = digest(this.unsignedJSON());
    if (expectedDigest !== null && this.digest !== expectedDigest) throw new Error("Task worker context snapshot digest is invalid");
    Object.freeze(this);
  }

  static materialize({ state, invocation, flowManager, sourceFingerprint } = {}) {
    const taskId = invocation?.action?.nextAction?.taskId;
    const source = flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "spec.record",
      consumerNodeId: "task-impl",
    });
    let spec;
    try { spec = JSON.parse(source.bytes.toString("utf8")); }
    catch (cause) { throw new Error(`canonical Task context spec is invalid JSON: ${cause.message}`); }
    return new TaskWorkerContextSnapshot({
      binding: new WorkerContextBinding({
        runId: state.runId,
        specId: state.specId,
        issue: state.issue ?? null,
        dispatchInvocationId: invocation.id,
        actionDigest: invocation.action.digest,
        targetDigest: invocation.target?.digest,
      }),
      context: new CanonicalTaskContext({
        state: { runId: state.runId, specId: state.specId, currentTaskId: taskId },
        spec,
        sourceFingerprint,
      }),
    });
  }

  static fromStored(value) {
    if (value?.version !== SNAPSHOT_VERSION || value?.kind !== "task") throw new Error("Task worker context snapshot schema is invalid");
    return new TaskWorkerContextSnapshot({
      binding: WorkerContextBinding.fromStored(value.binding),
      context: CanonicalTaskContext.fromReadOnlyInput(value.context),
      digest: requireDigest(value.digest, "Task worker context digest"),
    });
  }

  /**
   * Rebuild the canonical Task inputs at publication time while retaining the
   * source identity captured before the worker received its lease. Source
   * mutations are validated separately by the parent-held mutation baseline;
   * they must not make the worker's own Task context look stale.
   */
  rebuildCapturedContext({ state, flowManager } = {}) {
    return TaskWorkerContextSnapshot.materialize({
      state,
      invocation: {
        id: this.binding.dispatchInvocationId,
        action: {
          digest: this.binding.actionDigest,
          nextAction: { taskId: this.context.taskId },
        },
        target: { digest: this.binding.targetDigest },
      },
      flowManager,
      sourceFingerprint: this.context.sourceFingerprint,
    });
  }

  assertBinding(value) {
    if (!this.binding.matches(value)) throw new Error("Task worker context binding is stale");
    return this;
  }

  unsignedJSON() {
    return { version: this.version, kind: this.kind, binding: this.binding.toJSON(), context: this.context.readOnlyInput() };
  }

  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
}
