import crypto from "node:crypto";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { canonicalGateLogicalKeys, canonicalGateRevision } from "./canonical-gate-artifacts.js";
import { GateAttemptIdentity } from "./gate-transition.js";
import {
  GateEvidenceIdentity,
  GateObservationCycleReader,
  GateObservationOccurrence,
  GateObservationRepair,
  PlanGateRepairOutcome,
} from "./gate-observation-convergence.js";
import { PlanGateRepairObservation, PlanGateRepairRecord } from "./plan-gate-repair.js";

const OUTCOME_PATH = /^artifacts\/plan-gate-repairs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/outcome\.json$/;
const REPAIR_ID = /^plan-gate-repair-([a-f0-9]{64})$/;
const ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS = new Set([
  "publish_artifacts",
  "confirm_attempt",
  "fail_attempt",
]);

function requiredObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function json(bytes, field) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${field} bytes must be a Buffer`);
  try {
    return requiredObject(JSON.parse(bytes.toString("utf8")), field);
  } catch (error) {
    throw new Error(`${field} must be canonical JSON: ${error.message}`);
  }
}

function exactDescriptor(catalog, resolved, logicalKey) {
  const matches = catalog.artifacts.filter((descriptor) => (
    descriptor.logicalKey === logicalKey
    && descriptor.relativePath === resolved.relativePath
    && descriptor.hash === resolved.descriptor?.hash
    && descriptor.activityId === resolved.descriptor?.activityId
  ));
  if (matches.length !== 1) throw new Error(`${logicalKey} does not match one exact catalog descriptor`);
  return matches[0];
}

function taskIdForGateNode(nodeId) {
  if (typeof nodeId !== "string" || !nodeId.endsWith("-gate") || nodeId === "impl-gate") return null;
  const taskId = nodeId.slice(0, -"-gate".length);
  return ["draft", "spec", "test"].includes(taskId) ? null : taskId;
}

function gateNodeFor(phase, taskId) {
  if (phase === "draft") return "draft-gate";
  if (phase === "spec" || phase === "task-spec") return "spec-gate";
  if (phase === "integration") return "impl-gate";
  return taskId === null ? null : `${taskId}-gate`;
}

function gateConsumer(logicalKey) {
  return new Map([
    ["draft.gate", "spec"],
    ["spec.gate", "approval"],
    ["task.gate", "task-impl"],
    ["impl.gate", "report"],
  ]).get(logicalKey);
}

function sourceConsumer(logicalKey) {
  return new Map([
    ["draft.gate.source", "draft-gate"],
    ["spec.gate.source", "spec-gate"],
    ["task.gate.source", "task-gate"],
    ["impl.gate.source", "impl-gate"],
  ]).get(logicalKey);
}

function matchingAttemptActivity(activity, { nodeId, attempt, operations = null } = {}) {
  return activity?.nodeId === nodeId
    && activity.attemptId === attempt.id
    && activity.sequence === attempt.sequence
    && (operations === null || operations.has(activity.transition?.operation));
}

function activityAttemptKey(nodeId, attempt) {
  return JSON.stringify([nodeId, attempt?.id, attempt?.sequence]);
}

function repairActivityFor(record, activities) {
  const matches = activities.filter((activity) => {
    const references = activity?.references?.repairs;
    return activity?.transition?.operation === "plan_gate_repair"
      && activity.nodeId === record.targetStepId
      && Array.isArray(references)
      && references.length === 1
      && references[0]?.id === record.idempotencyKey
      && references[0]?.label === record.sourceIssueLogId;
  });
  if (matches.length !== 1) {
    throw new Error("canonical plan Gate repair record requires one exact plan_gate_repair Activity reference");
  }
  const activity = matches[0];
  const targetAttempt = activity.transition?.attempt;
  if (targetAttempt?.nodeId !== record.targetStepId
    || activity.attemptId !== targetAttempt.id
    || activity.sequence !== targetAttempt.sequence) {
    throw new Error("canonical plan Gate repair Activity has a mismatched target Attempt");
  }
  return Object.freeze({ activity, targetAttempt: { id: targetAttempt.id, sequence: targetAttempt.sequence } });
}

function recordFingerprint(record) {
  const match = record.idempotencyKey.match(REPAIR_ID);
  if (match === null) throw new Error("canonical plan Gate repair record fingerprint is unavailable");
  return match[1];
}

function outcomeDescriptors(catalog) {
  return catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "plan.gate.repair.outcome");
}

function attemptHistoryFingerprint(document, throughAttempt) {
  const bytes = Buffer.from(`${JSON.stringify({
    attempts: document.attempts.filter((entry) => entry.attempt <= throughAttempt),
  }, null, 2)}\n`, "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function gateResultPayloadMatchesScope(payload, { phase, route } = {}) {
  const taskId = taskIdForGateNode(route?.gateStepId);
  return payload?.artifacts?.phase === phase
    && (taskId === null
      ? !Object.hasOwn(payload.artifacts, "taskId")
      : payload.artifacts.taskId === taskId);
}

function gateResultPublicationFor(activities, { nodeId, attempt, currentActivityId = null } = {}) {
  const publications = activities.filter((activity) => matchingAttemptActivity(activity, {
    nodeId,
    attempt,
    operations: ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS,
  }));
  if (publications.length !== 1) {
    throw new Error("canonical post-repair Gate result requires one exact publication Activity");
  }
  if (currentActivityId !== null && publications[0].id !== currentActivityId) {
    throw new Error("current canonical post-repair Gate result does not match its catalog publication");
  }
  return publications[0];
}

function attemptSettlement(activities, { nodeId, attempt } = {}) {
  const matching = activities.filter((activity) => matchingAttemptActivity(activity, { nodeId, attempt }));
  if (matching.some((activity) => activity.transition?.operation === "defer_failed_gate")) return "deferred";
  if (matching.some((activity) => (
    activity.transition?.operation === "continue_nonblocking"
    || activity.transition?.nonblocking?.kind === "decision"
  ))) return "nonblocking-advisory";
  return null;
}

/** A concise, exact-scope Gate result observed after one applied repair. */
class PostRepairGateResult {
  constructor({ result, attempt, publicationActivityId, settlement = null } = {}) {
    if (!["pass", "fail", "recovered"].includes(result)) {
      throw new Error("post-repair Gate result is invalid");
    }
    if (settlement !== null && !["deferred", "nonblocking-advisory"].includes(settlement)) {
      throw new Error("post-repair Gate settlement is invalid");
    }
    if (settlement !== null && result !== "fail") {
      throw new Error("post-repair Gate settlement requires a failed result");
    }
    this.result = result;
    this.attempt = attempt instanceof GateAttemptIdentity ? attempt : new GateAttemptIdentity(attempt);
    if (typeof publicationActivityId !== "string" || publicationActivityId === "") {
      throw new Error("post-repair Gate publication Activity id is required");
    }
    this.publicationActivityId = publicationActivityId;
    this.settlement = settlement;
    Object.freeze(this);
  }

  toJSON() {
    return {
      result: this.result,
      attempt: this.attempt.toJSON(),
      publicationActivityId: this.publicationActivityId,
      ...(this.settlement === null ? {} : { settlement: this.settlement }),
    };
  }
}

/** Status-safe projection of the latest canonical repair outcome. */
class GateObservationRepairStatus {
  constructor(outcome) {
    if (!(outcome instanceof PlanGateRepairOutcome)) {
      throw new Error("Gate observation repair status requires a canonical outcome");
    }
    this.disposition = outcome.disposition;
    this.changedEvidence = outcome.report.beforeEvidenceDigest !== outcome.report.outputEvidenceDigest;
    this.targetAttempt = outcome.targetAttempt instanceof GateAttemptIdentity
      ? outcome.targetAttempt
      : new GateAttemptIdentity(outcome.targetAttempt);
    Object.freeze(this);
  }

  toJSON() {
    return {
      disposition: this.disposition,
      changedEvidence: this.changedEvidence,
      targetAttempt: this.targetAttempt.toJSON(),
    };
  }
}

/**
 * Canonical-only adapter from Version Store publications to typed Gate cycle rows.
 * v2 repair records remain the durable occurrence history; persisted Gate
 * result prefixes are reconstructed only to authenticate each source record.
 */
export class CanonicalGateObservationCycle {
  #gateResultHistory = new Map();
  #activitiesByAttempt;

  constructor({ flowManager, state } = {}) {
    if (!flowManager
      || typeof flowManager.artifactCatalog !== "function"
      || typeof flowManager.readArtifact !== "function"
      || typeof flowManager.activityLedger !== "function") {
      throw new Error("canonical Gate observation cycle requires FlowManager catalog readers");
    }
    if (state?.schemaRevision !== 3 || typeof state.specId !== "string" || state.specId === "") {
      throw new Error("canonical Gate observation cycle requires a Version-1 Flow state");
    }
    this.flowManager = flowManager;
    this.state = state;
    this.catalog = flowManager.artifactCatalog(state.specId);
    this.activities = Object.freeze([...flowManager.activityLedger(state.specId)]);
    this.#activitiesByAttempt = new Map();
    for (const activity of this.activities) {
      const key = activityAttemptKey(activity.nodeId, {
        id: activity.attemptId,
        sequence: activity.sequence,
      });
      const matches = this.#activitiesByAttempt.get(key) ?? [];
      matches.push(activity);
      this.#activitiesByAttempt.set(key, matches);
    }
    for (const [key, matches] of this.#activitiesByAttempt) {
      this.#activitiesByAttempt.set(key, Object.freeze(matches));
    }
    if (!Array.isArray(this.catalog?.artifacts)) throw new Error("canonical Gate observation cycle requires an artifact catalog");
    Object.freeze(this);
  }

  #attemptActivities(nodeId, attempt) {
    return this.#activitiesByAttempt.get(activityAttemptKey(nodeId, attempt)) ?? [];
  }

  #gateResult(keys) {
    const cacheKey = JSON.stringify([keys.result, keys.parameters]);
    if (this.#gateResultHistory.has(cacheKey)) return this.#gateResultHistory.get(cacheKey);
    const resolved = this.flowManager.readArtifact({
      specId: this.state.specId,
      logicalKey: keys.result,
      parameters: keys.parameters,
      consumerNodeId: gateConsumer(keys.result),
      optional: true,
    });
    const value = resolved === null ? null : Object.freeze({
      resolved,
      descriptor: exactDescriptor(this.catalog, resolved, keys.result),
      document: json(resolved.bytes, "canonical Gate result history"),
      history: CanonicalCommandAttemptArtifactHistory.fromBytes({
        logicalKey: keys.result,
        bytes: resolved.bytes,
      }),
    });
    this.#gateResultHistory.set(cacheKey, value);
    return value;
  }

  #issueLog() {
    const resolved = this.flowManager.readArtifact({
      specId: this.state.specId,
      logicalKey: "issue.log",
      consumerNodeId: "flow",
      optional: true,
    });
    if (resolved === null) return Object.freeze({ entries: Object.freeze([]) });
    exactDescriptor(this.catalog, resolved, "issue.log");
    const document = json(resolved.bytes, "canonical Gate observation issue.log");
    if (!Array.isArray(document.entries)) throw new Error("canonical Gate observation issue.log must contain entries");
    return document;
  }

  #records(issueLog) {
    return issueLog.entries
      .filter((entry) => entry?.kind === "plan-gate-repair")
      .map((entry) => {
        const record = PlanGateRepairRecord.fromIssueLogEntry(entry);
        record.assertFlow(this.state);
        const source = issueLog.entries.find((candidate) => candidate?.issueLogId === record.sourceIssueLogId) ?? null;
        if (!record.matchesIssueLogEntry(source)) {
          throw new Error("canonical plan Gate repair source evidence changed or is missing");
        }
        return Object.freeze({ record, ...repairActivityFor(record, this.activities) });
      });
  }

  #outcomes(records) {
    const byId = new Map(records.map((entry) => [entry.record.idempotencyKey, entry]));
    const descriptors = outcomeDescriptors(this.catalog);
    const seen = new Set();
    return descriptors.map((descriptor) => {
      const pathMatch = descriptor.relativePath.match(OUTCOME_PATH);
      if (pathMatch === null || seen.has(pathMatch[1])) {
        throw new Error("plan Gate repair outcome catalog identity is malformed or duplicated");
      }
      const repairId = pathMatch[1];
      seen.add(repairId);
      const expected = FLOW_ARTIFACT_CONTRACTS.resolve("plan.gate.repair.outcome", { repairId });
      if (expected.relativePath !== descriptor.relativePath) {
        throw new Error("plan Gate repair outcome path does not match its collection identity");
      }
      const resolved = this.flowManager.readArtifact({
        specId: this.state.specId,
        logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId },
        consumerNodeId: "system",
      });
      const exact = exactDescriptor(this.catalog, resolved, "plan.gate.repair.outcome");
      const outcome = PlanGateRepairOutcome.fromJSON(json(resolved.bytes, "plan Gate repair outcome"));
      if (outcome.repairId !== repairId || outcome.publicationActivityId !== exact.activityId) {
        throw new Error("plan Gate repair outcome does not match its catalog publication");
      }
      const repair = byId.get(repairId);
      if (repair === undefined) throw new Error("plan Gate repair outcome has no v2 repair record");
      if (outcome.repairRecordFingerprint !== recordFingerprint(repair.record)
        || outcome.sourceEvidence.matches(repair.record.evidenceIdentity) === false
        || outcome.targetAttempt.id !== repair.targetAttempt.id
        || outcome.targetAttempt.sequence !== repair.targetAttempt.sequence) {
        throw new Error("plan Gate repair outcome has stale repair lineage");
      }
      const publications = this.activities.filter((activity) => activity.id === exact.activityId);
      if (publications.length !== 1 || !matchingAttemptActivity(publications[0], {
        nodeId: repair.record.targetStepId,
        attempt: outcome.targetAttempt,
        operations: ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS,
      })) {
        throw new Error("plan Gate repair outcome publication Activity is stale or mismatched");
      }
      return Object.freeze({ outcome, repair });
    });
  }

  #currentOccurrenceRows() {
    const nodeId = this.state.current?.at(-1) ?? null;
    const attempt = this.state.attempt;
    if (nodeId === null || attempt === null || attempt.failure === null || !nodeId.endsWith("-gate")) return [];
    const taskId = taskIdForGateNode(nodeId);
    const phase = nodeId === "draft-gate" ? "draft"
      : nodeId === "spec-gate" ? null
        : nodeId === "impl-gate" ? "integration" : "task-impl";
    const candidatePhases = phase === null ? ["spec", "task-spec"] : [phase];
    for (const candidatePhase of candidatePhases) {
      const keys = canonicalGateLogicalKeys(candidatePhase, taskId);
      const resultHistory = this.#gateResult(keys);
      if (resultHistory === null) continue;
      const { descriptor, history } = resultHistory;
      const payload = history.current.payload;
      const requiresTransitionBinding = taskId !== null || candidatePhase === "integration";
      if (history.current.attempt !== attempt.sequence
        || payload?.result !== "fail"
        || payload?.artifacts?.phase !== candidatePhase
        || gateNodeFor(candidatePhase, taskId) !== nodeId
        || (requiresTransitionBinding && (
          payload?.artifacts?.gateTransitionAttemptId !== attempt.id
          || payload?.artifacts?.gateTransitionAttemptSequence !== attempt.sequence
          || payload?.artifacts?.gateTransitionLineage !== canonicalGateRevision(this.state, nodeId)
        ))) {
        throw new Error("current canonical failed Gate result has stale Attempt or lineage binding");
      }
      const publication = this.activities.filter((activity) => activity.id === descriptor.activityId);
      if (publication.length !== 1 || !matchingAttemptActivity(publication[0], {
        nodeId,
        attempt,
        operations: ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS,
      })) throw new Error("current canonical failed Gate result has a mismatched publication Activity");
      const failures = this.activities.filter((activity) => matchingAttemptActivity(activity, {
        nodeId,
        attempt,
        operations: new Set(["fail_attempt", "record_failure"]),
      }) && activity.failure?.category === attempt.failure?.category
        && activity.failure?.code === attempt.failure?.code);
      if (failures.length !== 1) {
        throw new Error("current canonical failed Gate result has no exact failure Activity");
      }

      const source = this.flowManager.readArtifact({
        specId: this.state.specId,
        logicalKey: keys.source,
        parameters: keys.parameters,
        consumerNodeId: sourceConsumer(keys.source),
        optional: true,
      });
      let sourceFingerprint = descriptor.hash;
      let sourceRevisionFingerprint = null;
      let canonicalRevisionFingerprint = null;
      if (source !== null) {
        const sourceDescriptor = exactDescriptor(this.catalog, source, keys.source);
        const sourceDocument = json(source.bytes, "canonical Gate source");
        if (sourceDocument.phase !== candidatePhase
          || sourceDocument.result !== "fail"
          || (taskId !== null && sourceDocument.taskId !== taskId)
          || sourceDocument.lineage !== payload.artifacts.gateTransitionLineage) {
          throw new Error("current canonical Gate source has stale lineage");
        }
        const sourcePublication = this.activities.filter((activity) => activity.id === sourceDescriptor.activityId);
        if (sourcePublication.length !== 1 || !matchingAttemptActivity(sourcePublication[0], {
          nodeId,
          attempt,
          operations: ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS,
        })) throw new Error("current canonical Gate source has a mismatched publication Activity");
        sourceFingerprint = sourceDescriptor.hash;
        sourceRevisionFingerprint = sourceDocument.lineage;
        canonicalRevisionFingerprint = payload.artifacts.gateTransitionLineage;
      } else if (taskId !== null || candidatePhase === "integration") {
        throw new Error("current canonical semantic Gate failure requires source evidence");
      }
      const evidence = new GateEvidenceIdentity({
        sourceAttempt: { id: attempt.id, sequence: attempt.sequence },
        resultLogicalKey: keys.result,
        publicationActivityId: descriptor.activityId,
        catalogFingerprint: descriptor.hash,
        transitionLineage: {
          sourceAttempt: { id: attempt.id, sequence: attempt.sequence },
          canonicalAttempt: { id: attempt.id, sequence: attempt.sequence },
          sourceFingerprint,
          canonicalFingerprint: descriptor.hash,
          sourceRevisionFingerprint,
          canonicalRevisionFingerprint,
        },
      });
      const raw = payload?.artifacts?.nextAction?.diagnosis?.observations ?? [];
      if (!Array.isArray(raw)) throw new Error("current canonical failed Gate observations must be an array");
      return raw.filter((observation) => observation?.severity === "blocking").map((observation) => (
        new GateObservationOccurrence({
          evidence,
          observation: new PlanGateRepairObservation({
            ...observation,
            phase: candidatePhase,
            scope: taskId === null ? "flow" : "task",
            taskId,
          }).canonical,
          blocking: true,
        })
      ));
    }
    return [];
  }

  #repairSourceResult(recordEntry) {
    const { record, activity: repairActivity } = recordEntry;
    const taskId = taskIdForGateNode(record.route.gateStepId);
    const keys = canonicalGateLogicalKeys(record.phase, taskId);
    if (keys.result !== record.evidenceIdentity.resultLogicalKey) {
      throw new Error("plan Gate repair record has an inconsistent exact-scope result key");
    }
    const resultHistory = this.#gateResult(keys);
    if (resultHistory === null) {
      throw new Error("canonical Gate repair source result history is unavailable");
    }
    const { descriptor, document, history } = resultHistory;
    const source = history.attempts.find((entry) => entry.attempt === record.evidenceIdentity.sourceAttempt.sequence) ?? null;
    if (source === null
      || source.payload?.result !== "fail"
      || !gateResultPayloadMatchesScope(source.payload, record)) {
      throw new Error("canonical Gate attempt history no longer contains the repair source result");
    }
    const sourceAttempt = record.evidenceIdentity.sourceAttempt;
    if (source.payload?.artifacts?.gateTransitionAttemptId !== sourceAttempt.id
      || source.payload?.artifacts?.gateTransitionAttemptSequence !== sourceAttempt.sequence) {
      throw new Error("canonical Gate repair source history has a mismatched Attempt identity");
    }
    if (source.payload?.artifacts?.gateTransitionLineage
      !== record.evidenceIdentity.transitionLineage.canonicalRevisionFingerprint) {
      throw new Error("canonical Gate repair source history has mismatched transition lineage");
    }
    const reconstructedFingerprint = attemptHistoryFingerprint(document, sourceAttempt.sequence);
    if (reconstructedFingerprint !== record.evidenceIdentity.catalogFingerprint) {
      throw new Error("canonical Gate repair source history has a mismatched catalog fingerprint");
    }
    const sourcePublications = this.#attemptActivities(record.route.gateStepId, sourceAttempt)
      .filter((activity) => activity.id === record.evidenceIdentity.publicationActivityId
        && ATTEMPT_ARTIFACT_PUBLICATION_OPERATIONS.has(activity.transition?.operation));
    if (sourcePublications.length !== 1) {
      throw new Error("canonical Gate repair source has no exact publication Activity");
    }
    if (!Number.isSafeInteger(sourcePublications[0].confirmationOrder)
      || !Number.isSafeInteger(repairActivity.confirmationOrder)
      || sourcePublications[0].confirmationOrder >= repairActivity.confirmationOrder) {
      throw new Error("canonical Gate repair source publication is not prior to its repair Activity");
    }
    return resultHistory;
  }

  #postRepairGateResult(recordEntry, resultHistory) {
    const { record, activity: repairActivity } = recordEntry;
    const { descriptor, history } = resultHistory;
    const next = history.attempts
      .filter((entry) => entry.attempt > record.evidenceIdentity.sourceAttempt.sequence
        && gateResultPayloadMatchesScope(entry.payload, record))
      .at(-1) ?? null;
    if (next === null) return null;
    const exactAttempt = {
      id: next.payload?.artifacts?.gateTransitionAttemptId,
      sequence: next.payload?.artifacts?.gateTransitionAttemptSequence,
    };
    if (typeof exactAttempt.id !== "string" || exactAttempt.id === ""
      || exactAttempt.sequence !== next.attempt) {
      throw new Error("canonical post-repair Gate result has no exact Attempt binding");
    }
    const attemptActivities = this.#attemptActivities(record.route.gateStepId, exactAttempt);
    const publication = gateResultPublicationFor(attemptActivities, {
      nodeId: record.route.gateStepId,
      attempt: exactAttempt,
      ...(next === history.current ? { currentActivityId: descriptor.activityId } : {}),
    });
    if (!Number.isSafeInteger(repairActivity.confirmationOrder)
      || !Number.isSafeInteger(publication.confirmationOrder)
      || publication.confirmationOrder <= repairActivity.confirmationOrder) {
      throw new Error("canonical post-repair Gate result is not subsequent to its repair Activity");
    }
    return new PostRepairGateResult({
      result: next.payload.result,
      attempt: exactAttempt,
      publicationActivityId: publication.id,
      settlement: attemptSettlement(attemptActivities, { nodeId: record.route.gateStepId, attempt: exactAttempt }),
    });
  }

  #readMaterial({ includeStatus = false } = {}) {
    const issueLog = this.#issueLog();
    const records = this.#records(issueLog);
    const outcomes = this.#outcomes(records);
    const occurrences = records.flatMap(({ record }) => record.observations.map((observation) => (
      new GateObservationOccurrence({ evidence: record.evidenceIdentity, observation: observation.canonical, blocking: true })
    )));
    for (const occurrence of this.#currentOccurrenceRows()) {
      if (!occurrences.some((candidate) => candidate.key() === occurrence.key())) occurrences.push(occurrence);
    }

    const completedByRepairId = new Map(outcomes.map((entry) => [entry.outcome.repairId, entry]));
    const repairs = [];
    for (const recordEntry of records.sort((left, right) => (
      left.record.evidenceIdentity.sourceAttempt.sequence - right.record.evidenceIdentity.sourceAttempt.sequence
    ))) {
      const completed = completedByRepairId.get(recordEntry.record.idempotencyKey);
      if (completed === undefined) continue;
      repairs.push(new GateObservationRepair({
        repairId: recordEntry.record.idempotencyKey,
        sourceEvidence: recordEntry.record.evidenceIdentity,
        targetAttempt: recordEntry.targetAttempt,
        publicationActivityId: recordEntry.activity.id,
        recordFingerprint: recordFingerprint(recordEntry.record),
        handoffRevision: completed.outcome.handoffRevision,
        requests: recordEntry.record.observationRequests,
      }));
    }
    const readModel = new GateObservationCycleReader({
      occurrences,
      repairs,
      outcomes: outcomes.map((entry) => entry.outcome),
    }).read();
    if (!includeStatus) {
      return Object.freeze({ readModel, postRepairResults: new Map(), occurrenceSettlements: new Map() });
    }
    const sourceResultsByRepairId = new Map(records.map((recordEntry) => ([
      recordEntry.record.idempotencyKey,
      this.#repairSourceResult(recordEntry),
    ])));
    const postRepairResults = new Map();
    for (const recordEntry of records) {
      const completed = completedByRepairId.get(recordEntry.record.idempotencyKey);
      if (completed?.outcome.disposition === "applied") {
        postRepairResults.set(recordEntry.record.idempotencyKey, this.#postRepairGateResult(
          recordEntry,
          sourceResultsByRepairId.get(recordEntry.record.idempotencyKey),
        ));
      }
    }
    const occurrenceSettlements = new Map();
    for (const occurrence of occurrences) {
      const nodeId = gateNodeFor(occurrence.observation.phase, occurrence.observation.taskId);
      const settlement = attemptSettlement(this.#attemptActivities(nodeId, occurrence.evidence.sourceAttempt), {
        nodeId,
        attempt: occurrence.evidence.sourceAttempt,
      });
      if (settlement !== null) occurrenceSettlements.set(occurrence.evidence.key(), settlement);
    }
    return Object.freeze({ readModel, postRepairResults, occurrenceSettlements });
  }

  read() {
    return this.#readMaterial().readModel;
  }

  status() {
    const material = this.#readMaterial({ includeStatus: true });
    return new GateObservationConvergenceStatus(
      material.readModel,
      material.postRepairResults,
      material.occurrenceSettlements,
    );
  }
}

class GateObservationConvergenceEntry {
  constructor(cycle, postRepairResults, occurrenceSettlements) {
    const lastOccurrence = cycle.occurrences.at(-1);
    const orderedOutcomes = [...cycle.outcomes].sort((left, right) => (
      left.sourceAttempt.sequence - right.sourceAttempt.sequence
    ));
    const lastOutcome = orderedOutcomes.at(-1) ?? null;
    this.phase = lastOccurrence.observation.phase;
    this.taskId = lastOccurrence.observation.taskId;
    this.fingerprint = cycle.fingerprint.toString();
    this.occurrenceCount = cycle.occurrenceCount;
    this.repairCount = cycle.repairCount;
    this.recurrenceCount = cycle.recurrenceCount;
    this.sourceAttempt = lastOccurrence.evidence.sourceAttempt;
    this.repair = lastOutcome === null ? null : new GateObservationRepairStatus(lastOutcome);
    this.nextGate = lastOutcome === null ? null : (postRepairResults.get(lastOutcome.repairId) ?? null);
    this.finalDisposition = this.#finalDisposition(
      lastOutcome,
      occurrenceSettlements.get(lastOccurrence.evidence.key()) ?? null,
    );
    Object.freeze(this);
  }

  #finalDisposition(lastOutcome, occurrenceSettlement) {
    if (occurrenceSettlement !== null) return occurrenceSettlement;
    if (lastOutcome === null) return "open";
    if (lastOutcome.disposition === "rejected-no-progress") return "blocked-no-progress";
    const changedEvidence = lastOutcome.report.beforeEvidenceDigest !== lastOutcome.report.outputEvidenceDigest;
    if (lastOutcome.disposition !== "applied" || !changedEvidence) return "open";
    if (this.nextGate === null) return "repaired-awaiting-gate";
    if (this.nextGate.settlement === "deferred") return "deferred";
    if (this.nextGate.settlement === "nonblocking-advisory") return "nonblocking-advisory";
    return this.nextGate.result === "pass" ? "passed" : "open";
  }

  toJSON() {
    return {
      phase: this.phase,
      taskId: this.taskId,
      fingerprint: this.fingerprint,
      occurrenceCount: this.occurrenceCount,
      repairCount: this.repairCount,
      recurrenceCount: this.recurrenceCount,
      sourceAttempt: this.sourceAttempt.toJSON(),
      repair: this.repair?.toJSON() ?? null,
      nextGate: this.nextGate?.toJSON() ?? null,
      finalDisposition: this.finalDisposition,
    };
  }
}

/** Read-only status projection reconstructed from canonical persisted facts. */
export class GateObservationConvergenceStatus {
  constructor(readModel, postRepairResults = new Map(), occurrenceSettlements = new Map()) {
    this.readModel = readModel;
    this.entries = Object.freeze(readModel.cycles.map((cycle) => (
      new GateObservationConvergenceEntry(cycle, postRepairResults, occurrenceSettlements)
    )));
    Object.freeze(this);
  }

  static fromCanonical({ flowManager, state } = {}) {
    return new CanonicalGateObservationCycle({ flowManager, state }).status();
  }

  get empty() { return this.entries.length === 0; }

  toJSON() {
    return {
      occurrenceCount: this.readModel.occurrenceCount,
      repairCount: this.readModel.repairCount,
      recurrenceCount: this.readModel.recurrenceCount,
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }
}

class GateObservationRecurrenceEntry {
  constructor({ request, cycle, sourceEvidence } = {}) {
    const fingerprint = request.fingerprint.toString();
    const priorOccurrences = cycle.occurrences.filter((occurrence) => (
      occurrence.fingerprint.toString() === fingerprint
      && occurrence.evidence.resultLogicalKey === sourceEvidence.resultLogicalKey
      && occurrence.evidence.sourceAttempt.sequence < sourceEvidence.sourceAttempt.sequence
    ));
    const priorOutcomes = cycle.outcomes.filter((outcome) => (
      outcome.sourceEvidence.resultLogicalKey === sourceEvidence.resultLogicalKey
      && outcome.sourceAttempt.sequence < sourceEvidence.sourceAttempt.sequence
      && outcome.report.results.some((result) => result.fingerprint.toString() === fingerprint)
    )).sort((left, right) => right.sourceAttempt.sequence - left.sourceAttempt.sequence);
    const priorOutcome = priorOutcomes.at(0) ?? null;
    const priorResult = priorOutcome?.report.results
      .find((result) => result.fingerprint.toString() === fingerprint) ?? null;
    if (request.recurrenceCount !== priorOccurrences.length
      || request.priorStrategy !== (priorResult?.strategy ?? null)) {
      throw new Error("Gate recurrence handoff does not match its exact prior cycle");
    }
    this.fingerprint = fingerprint;
    this.occurrenceCount = cycle.occurrenceCount;
    this.repairCount = cycle.repairCount;
    this.recurrenceCount = request.recurrenceCount;
    this.priorStrategy = request.priorStrategy;
    this.previousCycle = request.recurrenceCount === 0 ? null : Object.freeze({
      occurrence: priorOccurrences.sort((left, right) => (
        left.evidence.sourceAttempt.sequence - right.evidence.sourceAttempt.sequence
      )).at(-1).toJSON(),
      outcome: priorOutcome.toJSON(),
    });
    Object.freeze(this);
  }

  toJSON() {
    return {
      fingerprint: this.fingerprint,
      occurrenceCount: this.occurrenceCount,
      repairCount: this.repairCount,
      recurrenceCount: this.recurrenceCount,
      priorStrategy: this.priorStrategy,
      previousCycle: this.previousCycle,
    };
  }
}

/** Typed, transient worker input with one prior cycle and cumulative counts. */
export class GateObservationRecurrenceHandoff {
  constructor({ record = null, readModel } = {}) {
    if (readModel === null || typeof readModel?.find !== "function") {
      throw new Error("Gate recurrence handoff requires a canonical cycle read model");
    }
    this.version = 1;
    this.phase = record?.phase ?? null;
    this.targetStepId = record?.targetStepId ?? null;
    this.sourceEvidence = record?.evidenceIdentity ?? null;
    this.entries = Object.freeze(record === null ? [] : record.observationRequests.map((request) => {
      const cycle = readModel.find(request.fingerprint);
      if (cycle === null) throw new Error("selected Gate repair observation is absent from its canonical cycle");
      return new GateObservationRecurrenceEntry({
        request,
        cycle,
        sourceEvidence: record.evidenceIdentity,
      });
    }));
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      targetStepId: this.targetStepId,
      sourceEvidence: this.sourceEvidence?.toJSON() ?? null,
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }
}
