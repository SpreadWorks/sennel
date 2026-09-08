import crypto from "node:crypto";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalGateInputStore } from "./canonical-gate-artifacts.js";
import { CanonicalTestSourceRevision } from "./canonical-test-artifacts.js";
import { canonicalRepairAttemptOwner } from "./repair-attempt-lineage.js";

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
    targetStepId: record.targetStepId,
    sourceIssueLogId: record.sourceIssueLogId,
    sourceEntryDigest: record.sourceEntryDigest,
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
    targetStepId: "draft-refine",
    resetStepIds: ["draft-refine", "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"],
  }),
  new PlanGateRepairRoute({
    phase: "spec",
    gateStepId: "spec-gate",
    targetStepId: "spec",
    resetStepIds: ["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate"],
  }),
  new PlanGateRepairRoute({
    phase: "test",
    gateStepId: "scenario-validity",
    targetStepId: "test",
    resetStepIds: ["test", "scenario-validity"],
  }),
]);

const ROUTE_BY_PHASE = new Map(ROUTES.map((route) => [route.phase, route]));
const ROUTE_BY_TARGET = new Map(ROUTES.map((route) => [route.targetStepId, route]));
const ROUTE_BY_GATE = new Map(ROUTES.map((route) => [route.gateStepId, route]));
const EVIDENCE_BY_PHASE = new Map([
  ["draft", Object.freeze({ logicalKey: "draft.gate", failureCode: null })],
  ["spec", Object.freeze({ logicalKey: "spec.gate", failureCode: null })],
  ["task-impl", Object.freeze({ logicalKey: "task.gate", failureCode: null })],
  ["test", Object.freeze({ logicalKey: "scenario.validity", failureCode: "SCENARIO_VALIDITY_REJECTED" })],
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

function planGateRepairResultLogicalKey(route) {
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

export function scenarioValidityBlockingEntries(summary) {
  if (!Array.isArray(summary)) throw new Error("scenario-validity summary must be an array");
  return Object.freeze(summary
    .map((entry, index) => ({ entry, index }))
    .map((value) => Object.freeze(value))
    .filter(({ entry }) => entry.classification !== "expected_fail"));
}

export function scenarioValidityRepairObservations(blocking) {
  if (!Array.isArray(blocking)) throw new Error("scenario-validity blocking entries must be an array");
  return blocking
    .slice(0, MAX_OBSERVATIONS)
    .map(({ entry, index }) => ({
      kind: "violation",
      failureMode: entry.classification,
      requirementRef: entry.id,
      where: {
        file: entry.evidence.test_file,
        locator: entry.evidence.test_name,
      },
      observed: `Scenario validity classified ${entry.id} as ${entry.classification} before implementation.`,
      severity: "blocking",
      refs: [`scenario.validity#summary.${index}`],
    }));
}

function matchingScenarioIssueLogEntry(entry, route, payload) {
  let observations;
  try {
    observations = scenarioValidityRepairObservations(scenarioValidityBlockingEntries(payload.summary));
  } catch {
    return false;
  }
  if (observations.length === 0) return false;
  return typeof entry?.issueLogId === "string"
    && entry.issueLogId !== ""
    && entry.step === route.gateStepId
    && entry.phase === route.phase
    && entry.trigger === "scenario-validity found a test-design blocker before implementation"
    && entry.sourceArtifact === "scenario.validity"
    && stableStringify(entry.observations) === stableStringify(observations);
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
    route.phase === "test"
      ? matchingScenarioIssueLogEntry(entry, route, gateResult.payload)
      : matchingGateIssueLogEntry(entry, route, gateResult)
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

  createRecord(state) {
    return PlanGateRepairRecord.create({
      state,
      phase: this.route.phase,
      issueLogEntry: this.source,
      route: this.route,
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
  if (route.phase === "test") {
    const revision = CanonicalTestSourceRevision.fromCatalog({ state, catalog, activities });
    if (source.testRevisionDigest !== revision.digest) return null;
  }
  return new CanonicalPlanGateRepairEvidence({ route, issueLog, source });
}

export class PlanGateRepairRecord {
  constructor(input = {}) {
    if (input.version !== 1) throw new Error("plan gate repair version must be 1");
    this.version = 1;
    this.runId = requiredString(input.runId, "plan gate repair runId", 500);
    this.specId = requiredString(input.specId, "plan gate repair specId", 500);
    this.issue = input.issue == null ? null : Number(input.issue);
    if (this.issue != null && (!Number.isSafeInteger(this.issue) || this.issue <= 0)) {
      throw new Error("plan gate repair issue must be a positive integer or null");
    }
    this.phase = requiredString(input.phase, "plan gate repair phase", 100);
    this.targetStepId = requiredString(input.targetStepId, "plan gate repair targetStepId", 100);
    this.route = this.phase === "task-impl"
      ? planGateRepairRouteForTargetStep(this.targetStepId)
      : planGateRepairRouteForPhase(this.phase);
    if (!this.route) throw new Error(`unsupported plan gate repair phase: ${this.phase}`);
    if (this.targetStepId !== this.route.targetStepId) {
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
    this.observations = Object.freeze(input.observations.map((observation) => (
      observation instanceof PlanGateRepairObservation
        ? observation
        : new PlanGateRepairObservation(observation)
    )));
    this.requestedAt = requiredTimestamp(input.requestedAt, "plan gate repair requestedAt");
    Object.freeze(this);
  }

  static create({ state, phase, issueLogEntry, route = null, requestedAt = new Date().toISOString() }) {
    const selectedRoute = route || planGateRepairRouteForPhase(phase);
    if (!selectedRoute) throw new Error(`unsupported plan gate repair phase: ${phase}`);
    const observations = (issueLogEntry?.observations || [])
      .filter((observation) => observation?.severity === "blocking");
    return new PlanGateRepairRecord({
      version: 1,
      runId: state?.runId,
      specId: state?.specId,
      issue: state?.issue ?? null,
      phase,
      targetStepId: selectedRoute.targetStepId,
      sourceIssueLogId: issueLogEntry?.issueLogId,
      sourceEntryDigest: digest(issueLogEntry),
      observations,
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
    return `plan-gate-repair-${digest(repairIdentity(this))}`;
  }

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
    if (rewind?.transition?.operation === "repair_scenario_validity") {
      if (!Array.isArray(rewind.references?.repairs) || rewind.references.repairs.length !== 1) {
        throw new Error("canonical scenario repair Activity requires exactly one repair reference");
      }
      const reference = rewind.references.repairs[0];
      const source = document.entries.find((candidate) => candidate?.issueLogId === reference?.id) ?? null;
      if (source === null || reference.label !== source.issueLogId) {
        throw new Error("canonical scenario repair Activity references missing issue-log evidence");
      }
      const record = PlanGateRepairRecord.create({
        state,
        phase: "test",
        issueLogEntry: source,
        requestedAt: source.timestamp,
      });
      record.assertFlow(state);
      if (record.targetStepId !== targetStepId) {
        throw new Error("canonical scenario repair target is inconsistent");
      }
      return record;
    }
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
      sourceIssueLogId: this.sourceIssueLogId,
      sourceEntryDigest: this.sourceEntryDigest,
      observations: this.observations.map((observation) => observation.toJSON()),
      requestedAt: this.requestedAt,
    };
  }

  toWorkerJSON() {
    return {
      phase: this.phase,
      targetStepId: this.targetStepId,
      sourceIssueLogId: this.sourceIssueLogId,
      sourceEntryDigest: this.sourceEntryDigest,
      observations: this.observations.map((observation) => observation.toJSON()),
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
