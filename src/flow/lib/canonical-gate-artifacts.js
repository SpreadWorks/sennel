/**
 * Version-1 gate persistence boundary.
 *
 * Gate evaluation keeps its existing prompt/result shape.  This module is
 * the only translation from that ephemeral result into producer-owned V1
 * artifacts, so no gate path guesses a legacy `*-gate-result.json` sibling.
 */

import crypto from "node:crypto";
import { GateFailureCategory, GateTransitionFacts } from "./gate-transition.js";
import {
  CanonicalCommandAttemptArtifactHistory,
  CanonicalCommandResultArtifact,
  CanonicalCommandResultPublication,
  attachCanonicalCommandResultArtifact,
  attachCanonicalCommandResultPublications,
} from "./canonical-command-result.js";
import { renderTaskMarkdown } from "../../spec/commands/render.js";

const GATE_PHASES = new Set(["draft", "spec", "task-spec", "task-impl", "integration"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function jsonObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function canonicalState(state) {
  if (state?.schemaRevision !== 3 || typeof state.specId !== "string" || state.specId === "") {
    throw new Error("canonical gate requires a Version-1 Flow state");
  }
  return state;
}

function canonicalPhase(value) {
  const phase = requiredText(value, "canonical gate phase");
  if (!GATE_PHASES.has(phase)) throw new Error(`unsupported canonical gate phase: ${phase}`);
  return phase;
}

function taskId(value) {
  return value == null ? null : requiredText(value, "canonical gate taskId");
}

function gateNodeId(phase, activeTaskId = null) {
  if (phase === "draft") return "draft-gate";
  if (phase === "spec" || phase === "task-spec") return "spec-gate";
  if (phase === "integration") return "impl-gate";
  return activeTaskId === null ? "impl-gate" : `${activeTaskId}-gate`;
}

export function canonicalGateLogicalKeys(phase, activeTaskId) {
  if (phase === "draft") return Object.freeze({ result: "draft.gate", source: "draft.gate.source", parameters: {} });
  if (phase === "spec" || phase === "task-spec") return Object.freeze({ result: "spec.gate", source: "spec.gate.source", parameters: {} });
  if (phase === "integration" || activeTaskId === null) {
    return Object.freeze({ result: "impl.gate", source: "impl.gate.source", parameters: {} });
  }
  return Object.freeze({
    result: "task.gate",
    source: "task.gate.source",
    parameters: Object.freeze({ taskId: activeTaskId }),
  });
}

function sourcePayload(result, phase, activeTaskId, lineage) {
  const artifacts = jsonObject(result?.artifacts || {}, "canonical gate result artifacts");
  return Object.freeze({
    version: 1,
    phase,
    ...(activeTaskId === null ? {} : { taskId: activeTaskId }),
    generatedAt: new Date().toISOString(),
    result: result.result || "fail",
    evaluations: Array.isArray(artifacts.evaluations) ? structuredClone(artifacts.evaluations) : [],
    observations: structuredClone(artifacts.nextAction?.diagnosis?.observations || []),
    issues: Array.isArray(artifacts.issues) ? [...artifacts.issues] : [],
    reasons: Array.isArray(artifacts.reasons) ? structuredClone(artifacts.reasons) : [],
    failureKind: artifacts.failureKind || null,
    failureCategory: artifacts.gateTransitionFailureCategory ?? null,
    lineage,
    ...(artifacts.sourceFingerprint == null ? {} : { sourceFingerprint: artifacts.sourceFingerprint }),
    ...(artifacts.failureCode == null ? {} : { failureCode: artifacts.failureCode }),
  });
}

export function canonicalGateRevision(state, nodeId) {
  const attempt = state.attempt;
  if (attempt == null || attempt.nodeId !== nodeId) {
    throw new Error("canonical Gate lineage requires the active producer Attempt");
  }
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      runId: state.runId,
      specId: state.specId,
      nodeId,
      attemptId: attempt.id,
      sequence: attempt.sequence,
    }))
    .digest("hex");
}

/** Stable issue-log id for one published Task Gate result. */
export function taskGateSettlementIssueLogId({ runId, nodeId, attempt, publicationActivityId, catalogFingerprint } = {}) {
  const attemptId = requiredText(attempt?.id, "Task Gate issue-log Attempt id");
  const sequence = Number.isSafeInteger(attempt?.sequence) && attempt.sequence > 0
    ? attempt.sequence
    : (() => { throw new Error("Task Gate issue-log Attempt sequence is invalid"); })();
  return `task-gate-${crypto.createHash("sha256").update(JSON.stringify({
    runId: requiredText(runId, "Task Gate issue-log runId"),
    nodeId: requiredText(nodeId, "Task Gate issue-log nodeId"),
    attemptId,
    sequence,
    publicationActivityId: requiredText(publicationActivityId, "Task Gate issue-log publication Activity id"),
    catalogFingerprint: requiredText(catalogFingerprint, "Task Gate issue-log catalog fingerprint"),
  })).digest("hex")}`;
}

/** Stable publisher Activity id for the one issue-log effect of a Task Gate result. */
export function taskGateSettlementIssueLogActivityId({ issueLogId } = {}) {
  return `task-gate-issue-log-${crypto.createHash("sha256")
    .update(requiredText(issueLogId, "Task Gate issue-log id"))
    .digest("hex")}`;
}

/** Stable Activity id for one Task Gate result's reset or increment metric. */
export function taskGateSettlementMetricActivityId({ publicationActivityId, nodeId, attempt, operation } = {}) {
  const attemptId = requiredText(attempt?.id, "Task Gate metric Attempt id");
  const sequence = Number.isSafeInteger(attempt?.sequence) && attempt.sequence > 0
    ? attempt.sequence
    : (() => { throw new Error("Task Gate metric Attempt sequence is invalid"); })();
  if (operation !== "increment" && operation !== "reset") {
    throw new Error("Task Gate metric operation is invalid");
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    publicationActivityId: requiredText(publicationActivityId, "Task Gate metric publication Activity id"),
    nodeId: requiredText(nodeId, "Task Gate metric nodeId"),
    attempt: { id: attemptId, sequence },
    operation,
  })).digest("hex");
  return `task-gate-metric-${digest}`;
}

/**
 * Catalog-only reader for V1 gate inputs.  Gate consumers obtain opaque
 * bytes from FlowManager; only this boundary parses the established JSON
 * contracts and never derives a Version directory.
 */
export class CanonicalGateInputStore {
  constructor({ flowManager, state, nodeId } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical gate input store requires FlowManager.readArtifact");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.nodeId = requiredText(nodeId, "canonical gate input nodeId");
    Object.freeze(this);
  }

  readJson(logicalKey, { parameters = {}, optional = false, consumerNodeId = this.nodeId } = {}) {
    const resolved = this.flowManager.readArtifact({
      specId: this.state.specId,
      logicalKey,
      parameters,
      consumerNodeId,
      optional,
    });
    if (resolved === null) return null;
    try {
      return Object.freeze(JSON.parse(resolved.bytes.toString("utf8")));
    } catch (error) {
      throw new Error(`canonical ${logicalKey} must be JSON: ${error.message}`);
    }
  }

  spec() { return jsonObject(this.readJson("spec.record"), "canonical spec.json"); }
  issueLog() {
    // A fresh Flow has no issue facts until the first producer records one.
    // Treat that catalog absence as the canonical empty log, not as a reason
    // to synthesize a root file before a gate actually needs to write it.
    return jsonObject(this.readJson("issue.log", { optional: true }) ?? { entries: [] }, "canonical issue-log.json");
  }
  draft() { return jsonObject(this.readJson("draft"), "canonical draft"); }

  task(activeTaskId = this.state.currentTaskId) {
    const id = taskId(activeTaskId);
    if (id === null) throw new Error("canonical task gate requires an active Task");
    const task = this.state.tasks?.find((entry) => entry.id === id) ?? null;
    if (task === null) throw new Error(`canonical gate Task is absent: ${id}`);
    return Object.freeze({ id, document: Object.freeze(structuredClone(task)), markdown: renderTaskMarkdown(task) });
  }

  attemptResult(logicalKey, { parameters = {}, consumerNodeId = this.nodeId, optional = false } = {}) {
    const resolved = this.flowManager.readArtifact({
      specId: this.state.specId,
      logicalKey,
      parameters,
      consumerNodeId,
      optional,
    });
    if (resolved === null) return null;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: resolved.bytes });
    return Object.freeze({ attempt: history.current.attempt, payload: history.current.payload });
  }

  /**
   * Read the active gate producer's own result history. This is intentionally
   * distinct from a consumer read: recovery verifies the failed producer
   * Attempt without expanding the result artifact's downstream allowlist.
   */
  activeAttemptResult(logicalKey, { parameters = {}, optional = false } = {}) {
    const resolved = this.flowManager.readProducerArtifact({
      specId: this.state.specId,
      nodeId: this.nodeId,
      logicalKey,
      parameters,
      optional,
    });
    if (resolved === null) return null;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: resolved.bytes });
    return Object.freeze({
      attempt: history.current.attempt,
      payload: history.current.payload,
      descriptor: resolved.descriptor,
      relativePath: resolved.relativePath,
    });
  }
}

/**
 * Attaches a normal gate result to the active Attempt.  The registry then
 * confirms it in the same Store transaction as the Activity and catalog.
 */
export class CanonicalGatePromotion {
  constructor({ state, phase, nodeId = null, activeTaskId = null } = {}) {
    this.state = canonicalState(state);
    this.phase = canonicalPhase(phase);
    this.taskId = taskId(activeTaskId);
    this.nodeId = nodeId == null ? gateNodeId(this.phase, this.taskId) : requiredText(nodeId, "canonical gate nodeId");
    if (gateNodeId(this.phase, this.taskId) !== this.nodeId) {
      throw new Error("canonical gate phase and Task scope do not own the producer node");
    }
    if (this.state.current?.at(-1) !== this.nodeId) {
      throw new Error(`canonical gate requires active Attempt for ${this.nodeId}`);
    }
    this.keys = canonicalGateLogicalKeys(this.phase, this.taskId);
    Object.freeze(this);
  }

  promote(result) {
    jsonObject(result, "canonical gate result");
    result.artifacts ||= {};
    result.artifacts.phase = this.phase;
    if (this.taskId !== null) {
      if (typeof result.artifacts.sourceFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(result.artifacts.sourceFingerprint)) {
        throw new Error("canonical Task Gate result requires a current source fingerprint");
      }
      result.artifacts.taskId = this.taskId;
    }
    if (result.result === "fail") {
      result.artifacts.gateTransitionFailureCategory = GateFailureCategory
        .fromObservedGateResult(result)
        .toJSON();
    }
    const lineage = canonicalGateRevision(this.state, this.nodeId);
    result.artifacts.gateTransitionLineage = lineage;
    result.artifacts.gateTransitionAttemptId = this.state.attempt.id;
    result.artifacts.gateTransitionAttemptSequence = this.state.attempt.sequence;
    attachCanonicalCommandResultArtifact(result, new CanonicalCommandResultArtifact({
      logicalKey: this.keys.result,
      payload: result,
    }));
    // Source artifacts are failure evidence used for retry/deferral.  A PASS
    // is fully represented by its producer result history and deliberately
    // does not create a duplicate "source" view.
    if (result.result === "fail" && result.artifacts.gateTransitionFailureCategory.category === "semantic") {
      attachCanonicalCommandResultPublications(result, [new CanonicalCommandResultPublication({
        logicalKey: this.keys.source,
        parameters: this.keys.parameters,
        mediaType: "application/json",
        payload: sourcePayload(result, this.phase, this.taskId, lineage),
      })]);
    }
    return result;
  }
}

/**
 * Rehydrates the exact result of a current Gate Attempt when publication
 * completed but its registry post hook did not.  This has deliberately
 * narrower authority than CanonicalGatePromotion: it attaches the immutable
 * result-history payload only, never recreates source evidence or evaluates a
 * Gate a second time.
 */
export class CanonicalGatePublishedResultRecovery {
  constructor({ flowManager, state, phase, nodeId = null, activeTaskId = null, facts, recoveryDecision = null } = {}) {
    if (!flowManager || typeof flowManager.readProducerArtifact !== "function") {
      throw new Error("canonical Gate publication recovery requires FlowManager producer reads");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.phase = canonicalPhase(phase);
    this.taskId = taskId(activeTaskId);
    this.nodeId = nodeId == null ? gateNodeId(this.phase, this.taskId) : requiredText(nodeId, "canonical Gate recovery nodeId");
    if (gateNodeId(this.phase, this.taskId) !== this.nodeId) {
      throw new Error("canonical Gate publication recovery phase and Task scope do not own the producer node");
    }
    if (this.state.current?.at(-1) !== this.nodeId || this.state.attempt?.nodeId !== this.nodeId) {
      throw new Error("canonical Gate publication recovery requires the active producer Attempt");
    }
    if (!(facts instanceof GateTransitionFacts)) {
      throw new Error("canonical Gate publication recovery requires a current recoverable Gate result");
    }
    if (facts.scope === "task") {
      if (recoveryDecision?.facts !== facts || recoveryDecision?.disposition?.operation !== "reconcile") {
        throw new Error("Task Gate settlement recovery requires its exact Definition reconciliation decision");
      }
    } else if (!facts.postPublication.requiresReconciliation) {
      throw new Error("canonical Gate publication recovery requires a current recoverable Gate result");
    }
    if (facts.phase !== this.phase || facts.target.stepId !== this.nodeId
      || facts.target.taskId !== this.taskId
      || facts.currentAttempt.id !== this.state.attempt.id
      || facts.currentAttempt.sequence !== this.state.attempt.sequence) {
      throw new Error("canonical Gate publication recovery facts do not match the active Attempt");
    }
    this.keys = canonicalGateLogicalKeys(this.phase, this.taskId);
    this.facts = facts;
    Object.freeze(this);
  }

  rehydrate() {
    const input = new CanonicalGateInputStore({
      flowManager: this.flowManager,
      state: this.state,
      nodeId: this.nodeId,
    }).activeAttemptResult(this.keys.result, { parameters: this.keys.parameters });
    if (input.attempt !== this.facts.currentAttempt.sequence
      || input.descriptor.hash !== this.facts.catalogPublication.fingerprint
      || input.descriptor.activityId !== this.facts.catalogPublication.producerActivityId
      || input.relativePath !== this.facts.catalogPublication.artifactId) {
      throw new Error("canonical Gate publication recovery result does not match the selected catalog publication");
    }
    const result = structuredClone(input.payload);
    attachCanonicalCommandResultArtifact(result, new CanonicalCommandResultArtifact({
      logicalKey: this.keys.result,
      payload: result,
    }));
    return result;
  }
}

export function canonicalGateNodeId({ phase, taskId = null } = {}) {
  return gateNodeId(canonicalPhase(phase), taskId);
}
