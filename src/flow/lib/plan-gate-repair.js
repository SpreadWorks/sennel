import crypto from "node:crypto";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalGateInputStore } from "./canonical-gate-artifacts.js";
import { canonicalRepairAttemptOwner } from "./repair-attempt-lineage.js";
import {
  GateEvidenceIdentity,
  GateObservation,
  GateObservationCycleReadModel,
  GateObservationRepair,
  GateRepairObservationRequest,
} from "./gate-observation-convergence.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXT_LENGTH = 4000;
const MAX_OBSERVATIONS = 64;

function requiredString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function requiredDigest(value, field) {
  const digest = requiredString(value, field, 64);
  if (!SHA256.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function requiredTimestamp(value, field) {
  const timestamp = requiredString(value, field, 100);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`);
  return timestamp;
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

function issueLogDocument(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.entries)) {
    throw new Error("canonical plan gate repair issue-log must contain entries");
  }
  return value;
}

function repairIdentity(record) {
  return {
    version: record.version,
    runId: record.runId,
    specId: record.specId,
    issue: record.issue,
    phase: record.phase,
    connector: record.connector.toJSON(),
    evidenceIdentity: record.evidenceIdentity.toJSON(),
    sourceIssueLogId: record.sourceIssueLogId,
    sourceEntryDigest: record.sourceEntryDigest,
    observationFingerprints: [...record.observationFingerprints],
    observationRequests: record.observationRequests.map((entry) => entry.toJSON()),
  };
}

export class PlanGateRepairLocation {
  constructor(input = {}) {
    this.file = requiredString(input.file, "plan gate repair location file", 1000);
    this.locator = input.locator == null
      ? null
      : requiredString(input.locator, "plan gate repair location locator", 1000);
    Object.freeze(this);
  }

  toJSON() {
    const location = { file: this.file };
    if (this.locator != null) location.locator = this.locator;
    return location;
  }
}

export class PlanGateRepairObservation {
  constructor(input = {}) {
    this.kind = requiredString(input.kind || "violation", "plan gate repair observation kind", 100);
    this.failureMode = requiredString(
      input.failureMode || "gate-failure",
      "plan gate repair observation failureMode",
      200,
    );
    this.requirementRef = requiredString(
      input.requirementRef,
      "plan gate repair observation requirementRef",
      500,
    );
    this.where = input.where == null ? null : new PlanGateRepairLocation(input.where);
    this.observed = requiredString(input.observed, "plan gate repair observation observed");
    this.severity = requiredString(input.severity, "plan gate repair observation severity", 100);
    if (this.severity !== "blocking") {
      throw new Error("plan gate repair observations must be blocking");
    }
    const refs = Array.isArray(input.refs) ? input.refs : [];
    this.refs = Object.freeze(refs.map((ref, index) => (
      requiredString(ref, `plan gate repair observation refs[${index}]`, 500)
    )));
    this.authority = Object.freeze({
      kind: requiredString(input.authority?.kind ?? "requirement", "plan gate repair observation authority kind", 100),
      id: requiredString(input.authority?.id ?? this.requirementRef, "plan gate repair observation authority id", 500),
    });
    this.rootCause = input.rootCause == null
      ? null
      : requiredString(input.rootCause, "plan gate repair observation rootCause");
    this.canonical = new GateObservation({
      phase: input.phase,
      scope: input.scope,
      taskId: input.taskId ?? null,
      authority: this.authority,
      failureMode: this.failureMode,
      file: this.where?.file ?? null,
      locator: this.where?.locator ?? null,
      rootCause: this.rootCause,
      observed: this.observed,
      title: input.title ?? null,
    });
    this.fingerprint = this.canonical.fingerprint;
    if (input.fingerprint !== undefined && input.fingerprint !== this.fingerprint.toString()) {
      throw new Error("plan gate repair observation fingerprint does not match its canonical identity");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      failureMode: this.failureMode,
      requirementRef: this.requirementRef,
      where: this.where?.toJSON() ?? null,
      observed: this.observed,
      severity: this.severity,
      refs: [...this.refs],
      authority: this.authority,
      rootCause: this.rootCause,
      fingerprint: this.fingerprint.toString(),
    };
  }
}

/** Persisted projection of the Definition-sealed repair connector. */
export class PlanGateRepairConnectorBinding {
  constructor(input = {}, evidenceIdentity = null) {
    const evidence = evidenceIdentity instanceof GateEvidenceIdentity
      ? evidenceIdentity
      : GateEvidenceIdentity.fromJSON(evidenceIdentity);
    this.phase = requiredString(input.phase, "plan Gate repair connector phase", 100);
    this.sourceGateStepId = requiredString(input.sourceGateStepId, "plan Gate repair connector sourceGateStepId", 100);
    this.sourceAttempt = evidence.sourceAttempt;
    if (stableStringify(input.sourceAttempt) !== stableStringify(this.sourceAttempt.toJSON())) {
      throw new Error("plan Gate repair connector source Attempt does not match its evidence");
    }
    this.resultLogicalKey = requiredString(input.resultLogicalKey, "plan Gate repair connector resultLogicalKey", 100);
    this.resultArtifactId = requiredString(input.resultArtifactId, "plan Gate repair connector resultArtifactId", 1000);
    this.catalogFingerprint = requiredDigest(input.catalogFingerprint, "plan Gate repair connector catalogFingerprint");
    this.targetStepId = requiredString(input.targetStepId, "plan Gate repair connector targetStepId", 100);
    if (!Array.isArray(input.resetStepIds) || input.resetStepIds.length === 0) {
      throw new Error("plan Gate repair connector resetStepIds must be a non-empty array");
    }
    this.resetStepIds = Object.freeze(input.resetStepIds.map((stepId, index) => (
      requiredString(stepId, `plan Gate repair connector resetStepIds[${index}]`, 100)
    )));
    this.taskLifecycle = input.taskLifecycle == null ? null : Object.freeze(structuredClone(input.taskLifecycle));
    const route = planGateRepairRouteForGateStep(this.sourceGateStepId);
    if (route === null || route.phase !== this.phase || route.targetStepId !== this.targetStepId
      || stableStringify(route.resetStepIds) !== stableStringify(this.resetStepIds)
      || this.resultLogicalKey !== planGateRepairResultLogicalKey(route)
      || !this.sourceAttempt.matches(evidence.sourceAttempt)
      || this.catalogFingerprint !== evidence.catalogFingerprint) {
      throw new Error("plan Gate repair connector does not match its evidence and canonical route");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      sourceGateStepId: this.sourceGateStepId,
      sourceAttempt: this.sourceAttempt.toJSON(),
      resultLogicalKey: this.resultLogicalKey,
      resultArtifactId: this.resultArtifactId,
      catalogFingerprint: this.catalogFingerprint,
      targetStepId: this.targetStepId,
      resetStepIds: [...this.resetStepIds],
      taskLifecycle: this.taskLifecycle,
    };
  }
}

export class PlanGateRepairRoute {
  constructor({ phase, gateStepId, targetStepId, resetStepIds }) {
    this.phase = requiredString(phase, "plan gate repair phase", 100);
    this.gateStepId = requiredString(gateStepId, "plan gate repair gateStepId", 100);
    this.targetStepId = requiredString(targetStepId, "plan gate repair targetStepId", 100);
    if (!Array.isArray(resetStepIds) || resetStepIds.length === 0) {
      throw new Error("plan gate repair resetStepIds must be a non-empty array");
    }
    this.resetStepIds = Object.freeze(resetStepIds.map((stepId, index) => (
      requiredString(stepId, `plan gate repair resetStepIds[${index}]`, 100)
    )));
    if (this.resetStepIds[0] !== this.targetStepId || !this.resetStepIds.includes(this.gateStepId)) {
      throw new Error(`plan gate repair route is inconsistent for ${this.phase}`);
    }
    Object.freeze(this);
  }

  requestedStatus(stepId) {
    if (!this.resetStepIds.includes(stepId)) throw new Error(`step is outside plan gate repair route: ${stepId}`);
    return stepId === this.targetStepId ? "in_progress" : "pending";
  }
}

function taskRoute(taskId) {
  return new PlanGateRepairRoute({
    phase: "task-impl",
    gateStepId: `${taskId}-gate`,
    targetStepId: `${taskId}-impl`,
    resetStepIds: [`${taskId}-impl`, `${taskId}-review`, `${taskId}-triage`, `${taskId}-repair`, `${taskId}-gate`],
  });
}

function taskIdForMaterializedStep(stepId, role) {
  if (typeof stepId !== "string" || !stepId.endsWith(`-${role}`)) return null;
  const taskId = stepId.slice(0, -(`-${role}`.length));
  return taskId === "" || taskId === "impl" ? null : taskId;
}

const ROUTES = Object.freeze([
  new PlanGateRepairRoute({
    phase: "draft",
    gateStepId: "draft-gate",
    targetStepId: "draft-gate-repair",
    resetStepIds: ["draft-gate-repair", "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"],
  }),
  new PlanGateRepairRoute({
    phase: "spec",
    gateStepId: "spec-gate",
    targetStepId: "spec",
    resetStepIds: ["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate"],
  }),
]);

const ROUTE_BY_PHASE = new Map(ROUTES.map((route) => [route.phase, route]));
const ROUTE_BY_TARGET = new Map(ROUTES.map((route) => [route.targetStepId, route]));
const ROUTE_BY_GATE = new Map(ROUTES.map((route) => [route.gateStepId, route]));
const EVIDENCE_BY_PHASE = new Map([
  ["draft", Object.freeze({ logicalKey: "draft.gate", failureCode: null })],
  ["spec", Object.freeze({ logicalKey: "spec.gate", failureCode: null })],
  ["task-impl", Object.freeze({ logicalKey: "task.gate", failureCode: null })],
]);

export function planGateRepairRouteForPhase(phase) {
  return ROUTE_BY_PHASE.get(phase) || null;
}

export function planGateRepairRouteForTargetStep(stepId) {
  const taskId = taskIdForMaterializedStep(stepId, "impl");
  return ROUTE_BY_TARGET.get(stepId) || (taskId === null ? null : taskRoute(taskId));
}

/** Resolve repair eligibility from the active producer gate, never a target worker. */
export function planGateRepairRouteForGateStep(stepId) {
  const taskId = taskIdForMaterializedStep(stepId, "gate");
  return ROUTE_BY_GATE.get(stepId) || (taskId === null ? null : taskRoute(taskId));
}

export function planGateRepairResultLogicalKey(route) {
  if (!(route instanceof PlanGateRepairRoute)) {
    throw new Error("plan gate repair result requires a typed route");
  }
  return EVIDENCE_BY_PHASE.get(route.phase)?.logicalKey ?? null;
}

export function isPlanGateRepairEligibleFailure(state, route) {
  if (!(route instanceof PlanGateRepairRoute)) {
    throw new Error("plan gate repair eligibility requires a typed route");
  }
  if (state.current === null || state.current.at(-1) !== route.gateStepId || state.attempt === null) return false;
  const expected = EVIDENCE_BY_PHASE.get(route.phase);
  const failure = state.attempt.failure;
  if (
    expected === undefined
    || failure?.category !== "semantic"
    || (expected.failureCode !== null && failure.code !== expected.failureCode)
  ) return false;
  // Definition owns whether this evidence may select repair.  The inspector
  // only proves that the active failed Attempt has a current repair receipt.
  return true;
}

function matchingCurrentGateResult({ state, route, gateResult, catalog, activities }) {
  const logicalKey = planGateRepairResultLogicalKey(route);
  if (gateResult === null || gateResult.descriptor === undefined || gateResult.relativePath === undefined) return false;
  const descriptor = catalog.artifacts.find((artifact) => (
    artifact.relativePath === gateResult.relativePath
    && artifact.logicalKey === logicalKey
    && artifact.hash === gateResult.descriptor.hash
    && artifact.activityId === gateResult.descriptor.activityId
  )) ?? null;
  if (descriptor === null) return false;
  if (route.phase === "task-impl") {
    const taskId = route.gateStepId.slice(0, -"-gate".length);
    const expected = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, { taskId });
    if (descriptor.relativePath !== expected.relativePath) return false;
  }
  const published = activities.find((activity) => activity.id === descriptor.activityId) ?? null;
  const failed = activities.find((activity) => (
    activity.transition.operation === "fail_attempt"
    && activity.nodeId === route.gateStepId
    && activity.attemptId === state.attempt.id
    && activity.sequence === state.attempt.sequence
    && activity.failure?.category === state.attempt.failure.category
    && activity.failure?.code === state.attempt.failure.code
  )) ?? null;
  return gateResult.attempt === state.attempt.sequence
    && published !== null
    && published.nodeId === route.gateStepId
    && published.attemptId === state.attempt.id
    && published.sequence === state.attempt.sequence
    && failed !== null
    && published.confirmationOrder <= failed.confirmationOrder;
}

function matchingGateIssueLogEntry(entry, route, gateResult) {
  const payload = gateResult.payload;
  const observations = payload?.artifacts?.nextAction?.diagnosis?.observations ?? [];
  const taskId = route.phase === "task-impl" ? route.gateStepId.slice(0, -"-gate".length) : null;
  const receipt = entry?.gateReceipt;
  const taskReceiptMatches = taskId === null || (
    entry.taskId === taskId
    && entry.step === route.gateStepId
    && receipt?.attempt?.id === payload?.artifacts?.gateTransitionAttemptId
    && receipt?.attempt?.sequence === payload?.artifacts?.gateTransitionAttemptSequence
    && receipt?.lineage?.canonicalRevisionFingerprint === payload?.artifacts?.gateTransitionLineage
    && receipt?.catalogFingerprint === gateResult.descriptor?.hash
  );
  return typeof entry?.issueLogId === "string"
    && entry.issueLogId !== ""
    && entry.step === route.gateStepId
    && entry.phase === route.phase
    && taskReceiptMatches
    && entry.trigger === "gate post hook (auto)"
    && stableStringify(entry.observations ?? []) === stableStringify(observations)
    && entry.observations?.some((observation) => observation?.severity === "blocking") === true;
}

/**
 * Resolve the single durable source entry for a currently failed plan gate.
 *
 * Eligibility is deliberately derived from existing Version-1 provenance:
 * the active failed Attempt, its result-history sequence, the result
 * artifact's catalog Activity, and the latest matching issue-log entry derived from
 * that result.  Neither the directive planner nor the repair command may
 * turn an older issue-log observation into recovery authority for a fresh
 * Attempt at the same gate.
 */
function latestPlanGateRepairIssueLogEntry({ state, issueLog, gateResult, catalog, activities } = {}) {
  if (state.current === null) return null;
  const activeStepId = state.current.at(-1);
  const route = planGateRepairRouteForGateStep(activeStepId);
  if (route === null) return null;
  if (!isPlanGateRepairEligibleFailure(state, route)) return null;
  if (!matchingCurrentGateResult({ state, route, gateResult, catalog, activities })) return null;
  return [...issueLog.entries].reverse().find((entry) => (
    matchingGateIssueLogEntry(entry, route, gateResult)
  )) ?? null;
}

/**
 * The one inspection boundary shared by next-action and the mutation command.
 * It resolves all read-side facts from the producer's current failed Attempt;
 * callers receive no repair authority when any part of that provenance is
 * stale, malformed, or belongs to a replacement Attempt.
 */
class CanonicalPlanGateRepairEvidence {
  constructor({ route, issueLog, source } = {}) {
    if (!(route instanceof PlanGateRepairRoute)) {
      throw new Error("canonical plan gate repair evidence requires a typed route");
    }
    issueLogDocument(issueLog);
    if (typeof source?.issueLogId !== "string" || source.issueLogId === "") {
      throw new Error("canonical plan gate repair evidence requires an identified issue-log entry");
    }
    this.route = route;
    this.issueLog = issueLog;
    this.source = source;
    Object.freeze(this);
  }

  get reason() {
    return this.source.reason
      || `The ${this.route.phase} gate recorded blocking observations that require a governed artifact revision.`;
  }

  createRecord(state, { gateFacts, connector, cycleReadModel } = {}) {
    return PlanGateRepairRecord.create({
      state,
      issueLogEntry: this.source,
      gateFacts,
      connector,
      cycleReadModel,
    });
  }
}

export function inspectCanonicalPlanGateRepair({ flowManager, state } = {}) {
  if (state.current === null) return null;
  const route = planGateRepairRouteForGateStep(state.current.at(-1));
  if (route === null || !isPlanGateRepairEligibleFailure(state, route)) return null;
  const inputs = new CanonicalGateInputStore({
    flowManager,
    state,
    nodeId: route.gateStepId,
  });
  const issueLog = inputs.issueLog();
  const catalog = flowManager.artifactCatalog(state.specId);
  const activities = flowManager.activityLedger(state.specId);
  const source = latestPlanGateRepairIssueLogEntry({
    state,
    issueLog,
    gateResult: inputs.activeAttemptResult(planGateRepairResultLogicalKey(route), {
      parameters: route.phase === "task-impl" ? { taskId: route.gateStepId.slice(0, -"-gate".length) } : {},
      optional: true,
    }),
    catalog,
    activities,
  });
  if (source === null) return null;
  return new CanonicalPlanGateRepairEvidence({ route, issueLog, source });
}

export class PlanGateRepairRecord {
  constructor(input = {}) {
    if (input.version !== 2) throw new Error("plan gate repair version must be 2");
    this.version = 2;
    this.runId = requiredString(input.runId, "plan gate repair runId", 500);
    this.specId = requiredString(input.specId, "plan gate repair specId", 500);
    this.issue = input.issue == null ? null : Number(input.issue);
    if (this.issue != null && (!Number.isSafeInteger(this.issue) || this.issue <= 0)) {
      throw new Error("plan gate repair issue must be a positive integer or null");
    }
    this.phase = requiredString(input.phase, "plan gate repair phase", 100);
    this.evidenceIdentity = input.evidenceIdentity instanceof GateEvidenceIdentity
      ? input.evidenceIdentity
      : GateEvidenceIdentity.fromJSON(input.evidenceIdentity);
    this.connector = input.connector instanceof PlanGateRepairConnectorBinding
      ? input.connector
      : new PlanGateRepairConnectorBinding(input.connector, this.evidenceIdentity);
    this.targetStepId = this.connector.targetStepId;
    this.route = planGateRepairRouteForTargetStep(this.targetStepId);
    if (this.route === null || this.phase !== this.connector.phase) {
      throw new Error("plan gate repair target does not match its phase");
    }
    this.sourceIssueLogId = requiredString(
      input.sourceIssueLogId,
      "plan gate repair sourceIssueLogId",
      500,
    );
    this.sourceEntryDigest = requiredDigest(
      input.sourceEntryDigest,
      "plan gate repair sourceEntryDigest",
    );
    if (!Array.isArray(input.observations) || input.observations.length === 0) {
      throw new Error("plan gate repair requires blocking observations");
    }
    if (input.observations.length > MAX_OBSERVATIONS) {
      throw new Error(`plan gate repair observations exceed ${MAX_OBSERVATIONS}`);
    }
    const taskId = this.phase === "task-impl"
      ? this.route.gateStepId.slice(0, -"-gate".length)
      : null;
    this.observations = Object.freeze(input.observations.map((observation) => new PlanGateRepairObservation({
      ...(observation instanceof PlanGateRepairObservation ? observation.toJSON() : observation),
      phase: this.phase,
      scope: taskId === null ? "flow" : "task",
      taskId,
    })));
    this.observationFingerprints = Object.freeze(this.observations.map((observation) => (
      observation.fingerprint.toString()
    )));
    if (new Set(this.observationFingerprints).size !== this.observationFingerprints.length) {
      throw new Error("plan gate repair observations must have unique canonical fingerprints");
    }
    if (!Array.isArray(input.observationFingerprints)
      || stableStringify(input.observationFingerprints) !== stableStringify(this.observationFingerprints)) {
      throw new Error("plan gate repair observation fingerprints do not match canonical observations");
    }
    if (!Array.isArray(input.observationRequests) || input.observationRequests.length !== this.observations.length) {
      throw new Error("plan gate repair requires one recurrence-bound request per observation");
    }
    this.observationRequests = Object.freeze(input.observationRequests.map((entry) => (
      entry instanceof GateRepairObservationRequest ? entry : new GateRepairObservationRequest(entry)
    )));
    if (stableStringify(this.observationRequests.map((entry) => entry.fingerprint.toString()).sort())
      !== stableStringify([...this.observationFingerprints].sort())) {
      throw new Error("plan gate repair requests do not match canonical observation fingerprints");
    }
    this.requestedAt = requiredTimestamp(input.requestedAt, "plan gate repair requestedAt");
    Object.freeze(this);
  }

  static create({ state, issueLogEntry, gateFacts, connector, cycleReadModel, requestedAt = new Date().toISOString() }) {
    if (gateFacts === null || typeof gateFacts !== "object" || connector === null || typeof connector !== "object") {
      throw new Error("plan gate repair creation requires Definition-selected Gate facts and connector");
    }
    const evidenceIdentity = new GateEvidenceIdentity({
      sourceAttempt: gateFacts.currentAttempt,
      resultLogicalKey: connector.resultLogicalKey,
      publicationActivityId: gateFacts.catalogPublication?.producerActivityId,
      catalogFingerprint: gateFacts.catalogPublication?.fingerprint,
      transitionLineage: gateFacts.lineage,
    });
    const connectorBinding = new PlanGateRepairConnectorBinding(
      typeof connector.toJSON === "function" ? connector.toJSON() : connector,
      evidenceIdentity,
    );
    const observations = (issueLogEntry?.observations || [])
      .filter((observation) => observation?.severity === "blocking");
    const taskId = connectorBinding.phase === "task-impl"
      ? connectorBinding.sourceGateStepId.slice(0, -"-gate".length)
      : null;
    const typedObservations = observations.map((observation) => new PlanGateRepairObservation({
      ...observation,
      phase: connectorBinding.phase,
      scope: taskId === null ? "flow" : "task",
      taskId,
    }));
    if (!(cycleReadModel instanceof GateObservationCycleReadModel)) {
      throw new Error("plan gate repair creation requires the canonical Gate observation cycle");
    }
    const observationRequests = typedObservations.map((observation) => {
      const cycle = cycleReadModel.find(observation.fingerprint);
      if (cycle === null || !cycle.occurrences.some((occurrence) => (
        occurrence.blocking
        && occurrence.evidence.matches(evidenceIdentity)
        && occurrence.fingerprint.equals(observation.fingerprint)
      ))) {
        throw new Error("plan gate repair observation is absent from the exact canonical Gate cycle");
      }
      const priorOccurrences = cycle.occurrences.filter((occurrence) => (
        occurrence.evidence.resultLogicalKey === evidenceIdentity.resultLogicalKey
        && occurrence.evidence.sourceAttempt.sequence < evidenceIdentity.sourceAttempt.sequence
      ));
      const priorOutcome = [...cycle.outcomes]
        .filter((outcome) => (
          outcome.sourceEvidence.resultLogicalKey === evidenceIdentity.resultLogicalKey
          && outcome.sourceAttempt.sequence < evidenceIdentity.sourceAttempt.sequence
          && outcome.report.results.some((result) => result.fingerprint.equals(observation.fingerprint))
        ))
        .sort((left, right) => right.sourceAttempt.sequence - left.sourceAttempt.sequence)
        .at(0) ?? null;
      const priorStrategy = priorOutcome?.report.results
        .find((result) => result.fingerprint.equals(observation.fingerprint))?.strategy ?? null;
      if ((priorOccurrences.length > 0) !== (priorStrategy !== null)) {
        throw new Error("recurring plan gate observation lacks its exact prior repair outcome");
      }
      return new GateRepairObservationRequest({
        fingerprint: observation.fingerprint,
        recurrenceCount: priorOccurrences.length,
        priorStrategy,
      });
    });
    return new PlanGateRepairRecord({
      version: 2,
      runId: state?.runId,
      specId: state?.specId,
      issue: state?.issue ?? null,
      phase: connectorBinding.phase,
      connector: connectorBinding,
      evidenceIdentity,
      sourceIssueLogId: issueLogEntry?.issueLogId,
      sourceEntryDigest: digest(issueLogEntry),
      observations: typedObservations,
      observationFingerprints: typedObservations.map((observation) => observation.fingerprint.toString()),
      observationRequests,
      requestedAt,
    });
  }

  static from(value) {
    return value instanceof PlanGateRepairRecord ? value : new PlanGateRepairRecord(value);
  }

  /**
   * A stable issue-log identity permits crash replay without creating a second
   * repair record.  The timestamp is an observation, not a second identity.
   */
  get idempotencyKey() {
    return `plan-gate-repair-${this.fingerprint}`;
  }

  get fingerprint() { return digest(repairIdentity(this)); }

  /** Durable, cataloged evidence appended with the recovery Activity. */
  issueLogEntry() {
    return {
      kind: "plan-gate-repair",
      step: this.route.gateStepId,
      phase: this.phase,
      reason: `Guarded ${this.phase} gate repair rewound to ${this.targetStepId}.`,
      observations: this.observations.map((observation) => observation.toJSON()),
      timestamp: this.requestedAt,
      planGateRepair: this.toJSON(),
    };
  }

  /**
   * Append this immutable repair fact to an already catalog-resolved issue
   * log.  It is intentionally a document transformation only: the Version
   * Store publishes it atomically with the rewind Activity.
   */
  appendToIssueLog(value) {
    const document = issueLogDocument(value);
    const entries = document.entries.map((entry) => structuredClone(entry));
    const existing = entries.find((entry) => entry?.issueLogId === this.idempotencyKey) ?? null;
    if (existing !== null) {
      const restored = PlanGateRepairRecord.fromIssueLogEntry(existing);
      if (stableStringify(repairIdentity(restored)) !== stableStringify(repairIdentity(this))) {
        throw new Error("canonical plan gate repair issue-log identity conflicts with an existing record");
      }
      return Object.freeze({ entries: Object.freeze(entries) });
    }
    entries.push({ ...this.issueLogEntry(), issueLogId: this.idempotencyKey });
    return Object.freeze({ entries: Object.freeze(entries) });
  }

  activityReference() {
    return Object.freeze({ id: this.idempotencyKey, label: this.sourceIssueLogId });
  }

  static fromIssueLogEntry(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.kind !== "plan-gate-repair") {
      throw new Error("canonical plan gate repair issue-log entry is invalid");
    }
    const record = PlanGateRepairRecord.from(value.planGateRepair);
    if (value.issueLogId !== record.idempotencyKey) {
      throw new Error("canonical plan gate repair issue-log identity is invalid");
    }
    return record;
  }

  /**
   * Resolve the one repair record governing the currently active replacement
   * Attempt lineage. A historical issue-log entry is never enough by itself:
   * it must be referenced by the lineage owner and its source evidence must
   * still be present, which prevents stale repair context leaking into a
   * later visit to the same Step.
   */
  static resolveCanonical({ state, targetStepId, activities, issueLog }) {
    if (planGateRepairRouteForTargetStep(targetStepId) === null || state?.current?.at(-1) !== targetStepId || state?.attempt == null) {
      return null;
    }
    if (!Array.isArray(activities)) throw new Error("canonical plan gate repair requires an Activity ledger");
    const document = issueLogDocument(issueLog);
    const rewind = canonicalRepairAttemptOwner({ state, activities, targetStepId });
    if (rewind?.transition?.operation !== "plan_gate_repair") return null;
    if (!Array.isArray(rewind.references?.repairs) || rewind.references.repairs.length !== 1) {
      throw new Error("canonical plan gate repair Activity requires exactly one repair reference");
    }
    const reference = rewind.references.repairs[0];
    const entry = document.entries.find((candidate) => candidate?.issueLogId === reference?.id) ?? null;
    if (entry === null) {
      throw new Error("canonical plan gate repair Activity references missing issue-log evidence");
    }
    const record = PlanGateRepairRecord.fromIssueLogEntry(entry);
    record.assertFlow(state);
    if (record.targetStepId !== targetStepId || reference.label !== record.sourceIssueLogId) {
      throw new Error("canonical plan gate repair Activity reference is inconsistent");
    }
    const source = document.entries.find((candidate) => candidate?.issueLogId === record.sourceIssueLogId) ?? null;
    if (!record.matchesIssueLogEntry(source)) {
      throw new Error("canonical plan gate repair source evidence changed or is missing");
    }
    return record;
  }

  observationRepair({ state, activities, handoffRevision }) {
    const rewind = canonicalRepairAttemptOwner({ state, activities, targetStepId: this.targetStepId });
    if (rewind?.transition?.operation !== "plan_gate_repair"
      || rewind.references?.repairs?.[0]?.id !== this.idempotencyKey) {
      throw new Error("plan Gate repair replacement Attempt has no exact publication Activity");
    }
    const targetAttempt = rewind.transition.attempt;
    return new GateObservationRepair({
      repairId: this.idempotencyKey,
      sourceEvidence: this.evidenceIdentity,
      targetAttempt,
      publicationActivityId: rewind.id,
      recordFingerprint: this.fingerprint,
      handoffRevision,
      requests: this.observationRequests,
    });
  }

  assertFlow(state) {
    if (
      state?.runId !== this.runId
      || state?.specId !== this.specId
      || (state?.issue ?? null) !== this.issue
    ) {
      throw new Error("plan gate repair does not match Flow identity");
    }
  }

  matchesIssueLogEntry(entry) {
    return entry?.issueLogId === this.sourceIssueLogId
      && digest(entry) === this.sourceEntryDigest;
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      specId: this.specId,
      issue: this.issue,
      phase: this.phase,
      targetStepId: this.targetStepId,
      connector: this.connector.toJSON(),
      evidenceIdentity: this.evidenceIdentity.toJSON(),
      sourceIssueLogId: this.sourceIssueLogId,
      sourceEntryDigest: this.sourceEntryDigest,
      observations: this.observations.map((observation) => observation.toJSON()),
      observationFingerprints: [...this.observationFingerprints],
      observationRequests: this.observationRequests.map((entry) => entry.toJSON()),
      requestedAt: this.requestedAt,
    };
  }

  toWorkerJSON() {
    return {
      version: this.version,
      phase: this.phase,
      targetStepId: this.targetStepId,
      connector: this.connector.toJSON(),
      evidenceIdentity: this.evidenceIdentity.toJSON(),
      sourceIssueLogId: this.sourceIssueLogId,
      sourceEntryDigest: this.sourceEntryDigest,
      observations: this.observations.map((observation) => observation.toJSON()),
      observationFingerprints: [...this.observationFingerprints],
      observationRequests: this.observationRequests.map((entry) => entry.toJSON()),
    };
  }
}

/**
 * Catalog-only lookup for the repair context injected into a replacement
 * worker.  The caller's Step id is the consumer authorization; neither this
 * resolver nor its callers infer a Version directory or read issue-log.json
 * directly.
 */
export function canonicalPlanGateRepairForTarget({ flowManager, state, targetStepId } = {}) {
  if (state?.schemaRevision !== 3 || planGateRepairRouteForTargetStep(targetStepId) === null) return null;
  if (!flowManager || typeof flowManager.readArtifact !== "function" || typeof flowManager.activityLedger !== "function") {
    throw new Error("canonical plan gate repair requires the Version Store catalog and Activity readers");
  }
  const resolved = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "issue.log",
    consumerNodeId: targetStepId,
    optional: true,
  });
  if (resolved === null) return null;
  let issueLog;
  try {
    issueLog = JSON.parse(resolved.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`canonical plan gate repair issue-log must be JSON: ${error.message}`);
  }
  const typedState = typeof flowManager.canonicalState === "function"
    ? flowManager.canonicalState(state.specId)
    : state;
  return PlanGateRepairRecord.resolveCanonical({
    state: typedState,
    targetStepId,
    activities: flowManager.activityLedger(state.specId),
    issueLog,
  });
}
