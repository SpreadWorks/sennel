import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * Canonical Flow Version-1 metric reader.
 *
 * Metrics commands are read-only consumers of normal Flow runtime data. This
 * module centralizes discovery and catalog resolution so a report never
 * resurrects a root-level flow.json/spec.json convention on its own.
 */

import fs from "node:fs/promises";

import { FlowArtifactAttemptHistory } from "../../lib/flow-artifact-contract.js";
import { FlowSpecId } from "../../lib/flow-spec-id.js";
import { CanonicalSpecReview } from "../../flow/lib/spec-review-artifacts.js";

const REVIEW_PHASE_BY_LOGICAL_KEY = new Map([
  ["draft.questions.review", "draft-questions"],
  ["draft.coverage.review", "draft-coverage"],
  ["spec.review", "spec"],
  ["test.review", "test"],
  ["impl.review", "impl"],
  ["task.review", "impl"],
]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function jsonObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function frozenJson(value) {
  return Object.freeze(structuredClone(value));
}

function catalogDescriptor(entry) {
  if (entry === null || typeof entry !== "object" || typeof entry.toJSON !== "function") {
    throw new Error("canonical metric catalog requires typed descriptors");
  }
  return frozenJson(entry.toJSON());
}

function activityOperation(activity) {
  return activity?.transition?.operation ?? null;
}

function reviewTaskId(descriptor) {
  if (descriptor.logicalKey !== "task.review") return null;
  const match = descriptor.relativePath.match(/^steps\/impl\/([^/]+)\/review\/result\.json$/);
  if (match === null) throw new Error("canonical task review catalog path is invalid");
  return match[1];
}

function reviewHistoryPayload(entry) {
  const payload = entry?.payload
    ?? entry?.artifact?.payload
    ?? entry?.result?.artifact?.payload
    ?? entry?.result
    ?? null;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Object.freeze({});
  }
  return frozenJson(payload);
}

/** All attempts of one cataloged review producer result. */
export class CanonicalMetricsReviewHistory {
  constructor({ logicalKey, phase, taskId = null, attempts } = {}) {
    this.logicalKey = requiredText(logicalKey, "canonical review history logicalKey");
    this.phase = requiredText(phase, "canonical review history phase");
    this.taskId = taskId == null ? null : requiredText(taskId, "canonical review history taskId");
    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new Error("canonical review history requires one or more attempts");
    }
    let previous = 0;
    this.attempts = Object.freeze(attempts.map((entry, index) => {
      if (!Number.isSafeInteger(entry?.attempt) || entry.attempt <= previous) {
        throw new Error(`canonical review history attempt ${index + 1} is invalid`);
      }
      previous = entry.attempt;
      return Object.freeze({ attempt: entry.attempt, payload: reviewHistoryPayload(entry) });
    }));
    Object.freeze(this);
  }
}

/** A single resolved V1 Flow observed by metrics readers. */
export class CanonicalMetricsFlow {
  constructor({ flowManager, specId, state, location, activities, catalog } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical metrics Flow requires FlowManager catalog readers");
    }
    this.flowManager = flowManager;
    this.specId = FlowSpecId.from(requiredText(specId, "canonical metrics specId")).toString();
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
      throw new Error(`canonical metrics Flow requires schemaRevision ${CURRENT_FLOW_SCHEMA_REVISION}`);
    }
    if (!location || typeof location.relativeSpecFile !== "string") {
      throw new Error("canonical metrics Flow requires a resolved Version location");
    }
    if (!Array.isArray(activities)) {
      throw new Error("canonical metrics Flow requires an Activity ledger");
    }
    if (!catalog || !Array.isArray(catalog.artifacts)) {
      throw new Error("canonical metrics Flow requires an artifact catalog");
    }
    this.state = frozenJson(state);
    this.location = location;
    this.activities = Object.freeze(activities.map((activity) => frozenJson(activity)));
    this.artifacts = Object.freeze(catalog.artifacts.map(catalogDescriptor));
    Object.freeze(this);
  }

  /** Resolve one durable input under the explicit system-consumer grant. */
  readArtifact(logicalKey, { parameters = {}, optional = false } = {}) {
    return this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey: requiredText(logicalKey, "canonical metric artifact key"),
      parameters,
      consumerNodeId: "system",
      optional,
    });
  }

  /** Resolve and parse a durable JSON input from its catalog descriptor. */
  readJson(logicalKey, { parameters = {}, optional = false } = {}) {
    const artifact = this.readArtifact(logicalKey, { parameters, optional });
    if (artifact === null) return null;
    try {
      return frozenJson(JSON.parse(artifact.bytes.toString("utf8")));
    } catch (error) {
      throw new Error(`canonical ${logicalKey} is invalid JSON: ${error.message}`);
    }
  }

  specRecord() {
    return jsonObject(this.readJson("spec.record"), "canonical spec.record");
  }

  issueLog() {
    return jsonObject(this.readJson("issue.log", { optional: true }) ?? { entries: [] }, "canonical issue.log");
  }

  artifactByteLength(logicalKey, options = {}) {
    const artifact = this.readArtifact(logicalKey, options);
    return artifact === null ? null : artifact.bytes.length;
  }

  /** The finalization date is an Activity fact, never a state-field fallback. */
  finalizedAt() {
    const finalized = [...this.activities].reverse().find((activity) => activityOperation(activity) === "finalize_flow") ?? null;
    return finalized?.timing?.finishedAt ?? null;
  }

  /** Activity-derived public metric observations from the canonical reader view. */
  metricEntries() {
    return Object.freeze([...(this.state.metrics ?? [])].map((entry) => frozenJson(entry)));
  }

  countMetric({ phase, counter }) {
    const wantedPhase = requiredText(phase, "canonical metric phase");
    const wantedCounter = requiredText(counter, "canonical metric counter");
    let count = 0;
    for (const entry of this.metricEntries()) {
      if (entry.phase !== wantedPhase || entry.counter !== wantedCounter) continue;
      if (entry.reset === true) count = 0;
      count += Number(entry.delta ?? 0);
    }
    return count;
  }

  reviewConfirmationCount() {
    return this.activities.filter((activity) => (
      activityOperation(activity) === "confirm_attempt"
      && /(?:^|-)review$/.test(activity.nodeId)
    )).length;
  }

  testAssetCount() {
    return this.artifacts.filter((artifact) => artifact.relativePath.startsWith("artifacts/tests/")).length;
  }

  /**
   * Resolve every review result via its catalog descriptor. No review-history
   * directory, copied latest view, or inferred Version path participates in
   * the metrics projection.
   */
  reviewHistories() {
    const histories = [];
    for (const descriptor of this.artifacts) {
      const phase = REVIEW_PHASE_BY_LOGICAL_KEY.get(descriptor.logicalKey) ?? null;
      if (phase === null) continue;
      if (descriptor.logicalKey === "spec.review") {
        const match = descriptor.relativePath.match(/^revisions\/(\d+)\/review\.json$/);
        if (match === null) throw new Error("canonical spec.review catalog path is invalid");
        const resolved = this.readArtifact("spec.review", { parameters: { revision: match[1] } });
        let review;
        try {
          review = new CanonicalSpecReview(JSON.parse(resolved.bytes.toString("utf8")));
        } catch (error) {
          throw new Error(`canonical spec.review is invalid: ${error.message}`);
        }
        const publication = this.activities.find((activity) => (
          activityOperation(activity) === "confirm_attempt"
          && activity.nodeId === "spec-review"
          && activity.reviewPublication?.reviewDigest === descriptor.hash
        )) ?? null;
        histories.push(new CanonicalMetricsReviewHistory({
          logicalKey: "spec.review",
          phase,
          attempts: [{
            attempt: publication?.sequence ?? review.generation + 1,
            payload: {
              blockingFindings: review.findings.findings.filter((finding) => finding.kind === "blocking"),
              nonBlockingImprovements: review.findings.findings.filter((finding) => finding.kind === "improvement"),
            },
          }],
        }));
        continue;
      }
      const taskId = reviewTaskId(descriptor);
      const resolved = this.readArtifact(descriptor.logicalKey, {
        ...(taskId === null ? {} : { parameters: { taskId } }),
      });
      let parsed;
      try {
        parsed = JSON.parse(resolved.bytes.toString("utf8"));
      } catch (error) {
        throw new Error(`canonical ${descriptor.logicalKey} review history is invalid JSON: ${error.message}`);
      }
      let history;
      try {
        history = FlowArtifactAttemptHistory.fromJSON(parsed);
      } catch (error) {
        throw new Error(`canonical ${descriptor.logicalKey} review history is invalid: ${error.message}`);
      }
      histories.push(new CanonicalMetricsReviewHistory({
        logicalKey: descriptor.logicalKey,
        phase,
        taskId,
        attempts: history.attempts.map((entry) => entry.toJSON()),
      }));
    }
    return Object.freeze(histories);
  }

  /**
   * Cache material derived only from authority already resolved by this
   * object. Paths name a V1 logical input, not an inferred filesystem file.
   */
  revisionInput() {
    const content = JSON.stringify({
      state: this.state,
      activities: this.activities,
      artifacts: this.artifacts,
      spec: this.specRecord(),
      issueLog: this.issueLog(),
    });
    return Object.freeze({
      relativePath: this.location.relativePath("metrics-input.json"),
      content,
    });
  }
}

/** Enumerates only canonical V1 Flow roots beneath one configured spec root. */
export class CanonicalMetricsFlowIndex {
  constructor(flows = []) {
    if (!Array.isArray(flows) || flows.some((flow) => !(flow instanceof CanonicalMetricsFlow))) {
      throw new Error("canonical metrics Flow index requires CanonicalMetricsFlow values");
    }
    const ids = new Set();
    for (const flow of flows) {
      if (ids.has(flow.specId)) throw new Error(`canonical metrics Flow index duplicates ${flow.specId}`);
      ids.add(flow.specId);
    }
    this.flows = Object.freeze([...flows].sort((left, right) => left.specId.localeCompare(right.specId)));
    Object.freeze(this);
  }

  static async read({ flowManager, specRoot, maxFlows = 5000 } = {}) {
    if (!flowManager
      || typeof flowManager.loadReadOnly !== "function"
      || typeof flowManager.specLocation !== "function"
      || typeof flowManager.activityLedger !== "function"
      || typeof flowManager.artifactCatalog !== "function") {
      throw new Error("canonical metrics Flow index requires FlowManager Version Store readers");
    }
    const directory = requiredText(specRoot, "canonical metrics spec root");
    if (!Number.isSafeInteger(maxFlows) || maxFlows < 1) {
      throw new Error("canonical metrics Flow index maxFlows must be a positive safe integer");
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return new CanonicalMetricsFlowIndex();
      throw error;
    }
    const flows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let specId;
      try {
        specId = FlowSpecId.from(entry.name).toString();
      } catch {
        // A non-Flow directory is not an authority candidate. A valid ID with
        // malformed V1 data deliberately falls through and fails closed.
        continue;
      }
      const state = flowManager.loadReadOnly(specId);
      if (state === null) continue;
      if (flows.length >= maxFlows) {
        throw new Error(`canonical Flow count exceeds limit (${maxFlows})`);
      }
      flows.push(new CanonicalMetricsFlow({
        flowManager,
        specId,
        state,
        location: flowManager.specLocation(specId),
        activities: flowManager.activityLedger(specId),
        catalog: flowManager.artifactCatalog(specId),
      }));
    }
    return new CanonicalMetricsFlowIndex(flows);
  }
}
