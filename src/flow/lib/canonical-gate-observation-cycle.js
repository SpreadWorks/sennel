import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { canonicalGateLogicalKeys, canonicalGateRevision } from "./canonical-gate-artifacts.js";
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

/**
 * Canonical-only adapter from Version Store publications to typed Gate cycle rows.
 * Historical Gate result hashes are deliberately not reconstructed: v2 repair
 * records are the durable source occurrence history.
 */
export class CanonicalGateObservationCycle {
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
    if (!Array.isArray(this.catalog?.artifacts)) throw new Error("canonical Gate observation cycle requires an artifact catalog");
    Object.freeze(this);
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
        operations: new Set(["publish_artifacts", "confirm_attempt", "fail_attempt"]),
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
      const resolved = this.flowManager.readArtifact({
        specId: this.state.specId,
        logicalKey: keys.result,
        parameters: keys.parameters,
        consumerNodeId: gateConsumer(keys.result),
        optional: true,
      });
      if (resolved === null) continue;
      const descriptor = exactDescriptor(this.catalog, resolved, keys.result);
      const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: keys.result, bytes: resolved.bytes });
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
        operations: new Set(["publish_artifacts", "confirm_attempt", "fail_attempt"]),
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
          operations: new Set(["publish_artifacts", "confirm_attempt", "fail_attempt"]),
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

  read() {
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
      // The immutable outcome is the first canonical source of a worker
      // handoff revision. A requested but unfinished repair remains visible as
      // an occurrence without fabricating a repair binding.
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
    return new GateObservationCycleReader({
      occurrences,
      repairs,
      outcomes: outcomes.map((entry) => entry.outcome),
    }).read();
  }
}

class GateObservationConvergenceEntry {
  constructor(cycle) {
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
    this.lastEvidence = lastOccurrence.evidence;
    this.lastOutcome = lastOutcome;
    this.finalDisposition = lastOutcome?.disposition ?? null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      taskId: this.taskId,
      fingerprint: this.fingerprint,
      occurrenceCount: this.occurrenceCount,
      repairCount: this.repairCount,
      recurrenceCount: this.recurrenceCount,
      lastEvidence: this.lastEvidence.toJSON(),
      lastOutcome: this.lastOutcome?.toJSON() ?? null,
      ...(this.finalDisposition === null ? {} : { finalDisposition: this.finalDisposition }),
    };
  }
}

/** Read-only status projection reconstructed from canonical persisted facts. */
export class GateObservationConvergenceStatus {
  constructor(readModel) {
    this.readModel = readModel;
    this.entries = Object.freeze(readModel.cycles.map((cycle) => new GateObservationConvergenceEntry(cycle)));
    Object.freeze(this);
  }

  static fromCanonical({ flowManager, state } = {}) {
    return new GateObservationConvergenceStatus(
      new CanonicalGateObservationCycle({ flowManager, state }).read(),
    );
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
