import {
  CanonicalFindingFingerprint,
  CanonicalFindingIdentity,
} from "./canonical-finding-identity.js";
import { GateAttemptIdentity, GateLineage } from "./gate-transition.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const GATE_PHASES = new Set(["draft", "spec", "task-spec", "task-impl", "integration"]);
const GATE_SCOPES = new Set(["flow", "task"]);
const GATE_RESULT_LOGICAL_KEYS = new Set([
  "draft.gate",
  "spec.gate",
  "test.requirement.gate",
  "task.gate",
  "impl.gate",
]);
const OUTCOME_DISPOSITIONS = new Set(["applied", "rejected-no-progress"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value, field) {
  return value == null ? null : requiredText(value, field);
}

function requiredDigest(value, field) {
  const digest = requiredText(value, field);
  if (!SHA256_RE.test(digest)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function exactKeys(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${field} has unknown fields`);
  return value;
}

function uniqueTyped(values, Type, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "an array" : "a non-empty array"}`);
  }
  const entries = values.map((value) => value instanceof Type ? value : new Type(value));
  return Object.freeze(entries);
}

function fingerprintValue(value, field = "Gate observation fingerprint") {
  if (value instanceof GateObservationFingerprint) return value.toString();
  return requiredDigest(value, field);
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((value) => expected.has(value));
}

/** The authority named by a Gate observation's semantic identity. */
export class GateObservationAuthority {
  constructor({ kind, id } = {}) {
    this.kind = CanonicalFindingIdentity.normalizeCasePreservingText(requiredText(kind, "Gate observation authority kind"));
    this.id = CanonicalFindingIdentity.normalizeCasePreservingText(requiredText(id, "Gate observation authority id"));
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind, id: this.id }; }
}

/** Canonical semantic fields used to identify one Gate observation across Attempts. */
export class GateObservationIdentity {
  constructor({ phase, scope, taskId = null, authority, failureMode, file = null, locator = null, cause } = {}) {
    const normalizedPhase = requiredText(phase, "Gate observation phase");
    if (!GATE_PHASES.has(normalizedPhase)) throw new Error("Gate observation phase is invalid");
    const normalizedScope = requiredText(scope, "Gate observation scope");
    if (!GATE_SCOPES.has(normalizedScope)) throw new Error("Gate observation scope is invalid");
    const normalizedTaskId = optionalText(taskId, "Gate observation taskId");
    if ((normalizedScope === "task") !== (normalizedTaskId !== null)) {
      throw new Error("Gate observation task scope requires exactly one taskId binding");
    }
    this.authority = authority instanceof GateObservationAuthority
      ? authority
      : new GateObservationAuthority(authority);
    this.canonical = new CanonicalFindingIdentity({
      phase: normalizedPhase,
      scope: normalizedScope,
      taskId: normalizedTaskId,
      authorityKind: this.authority.kind,
      authorityId: this.authority.id,
      failureMode: requiredText(failureMode, "Gate observation failureMode"),
      file,
      locator,
      cause: requiredText(cause, "Gate observation cause"),
    }, {
      caseFoldedFields: [],
      casePreservingFields: [
        "phase", "scope", "taskId", "authorityKind", "authorityId", "failureMode", "locator", "cause",
      ],
      pathFields: ["file"],
    });
    this.phase = this.canonical.fields.phase;
    this.scope = this.canonical.fields.scope;
    this.taskId = this.canonical.fields.taskId;
    this.failureMode = this.canonical.fields.failureMode;
    this.file = this.canonical.fields.file;
    this.locator = this.canonical.fields.locator;
    this.cause = this.canonical.fields.cause;
    Object.freeze(this);
  }

  static fromObservation(observation) {
    const source = observation instanceof GateObservation ? observation.toJSON() : observation;
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Gate observation identity requires an observation object");
    }
    const rootCause = optionalText(source.rootCause, "Gate observation rootCause");
    const observed = optionalText(source.observed, "Gate observation observed");
    if (rootCause === null && observed === null) {
      throw new Error("Gate observation requires rootCause or observed cause evidence");
    }
    return new GateObservationIdentity({
      phase: source.phase,
      scope: source.scope,
      taskId: source.taskId ?? null,
      authority: source.authority,
      failureMode: source.failureMode,
      file: source.file ?? null,
      locator: source.locator ?? null,
      cause: rootCause ?? observed,
    });
  }

  toJSON() {
    return {
      phase: this.phase,
      scope: this.scope,
      taskId: this.taskId,
      authority: this.authority.toJSON(),
      failureMode: this.failureMode,
      file: this.file,
      locator: this.locator,
      cause: this.cause,
    };
  }
}

/** SHA-256 identity calculated only from trusted Gate semantic fields. */
export class GateObservationFingerprint {
  constructor(value) {
    this.value = requiredDigest(
      value instanceof CanonicalFindingFingerprint ? value.toString() : value,
      "Gate observation fingerprint",
    );
    Object.freeze(this);
  }

  static fromIdentity(identity) {
    if (!(identity instanceof GateObservationIdentity)) {
      throw new Error("Gate observation fingerprint requires a GateObservationIdentity");
    }
    return new GateObservationFingerprint(CanonicalFindingFingerprint.fromIdentity(identity.canonical));
  }

  static fromObservation(observation) {
    return GateObservationFingerprint.fromIdentity(GateObservationIdentity.fromObservation(observation));
  }

  equals(other) { return other instanceof GateObservationFingerprint && other.value === this.value; }
  toString() { return this.value; }
  toJSON() { return this.value; }
}

/** Immutable observation value. Any untrusted fingerprint field is deliberately ignored. */
export class GateObservation {
  constructor({
    phase, scope, taskId = null, authority, failureMode, file = null, locator = null,
    rootCause = null, observed = null, title = null,
  } = {}) {
    this.phase = requiredText(phase, "Gate observation phase");
    this.scope = requiredText(scope, "Gate observation scope");
    this.taskId = optionalText(taskId, "Gate observation taskId");
    this.authority = authority instanceof GateObservationAuthority
      ? authority
      : new GateObservationAuthority(authority);
    this.failureMode = requiredText(failureMode, "Gate observation failureMode");
    this.file = optionalText(file, "Gate observation file");
    this.locator = optionalText(locator, "Gate observation locator");
    this.rootCause = optionalText(rootCause, "Gate observation rootCause");
    this.observed = optionalText(observed, "Gate observation observed");
    this.title = optionalText(title, "Gate observation title");
    this.identity = GateObservationIdentity.fromObservation(this);
    this.fingerprint = GateObservationFingerprint.fromIdentity(this.identity);
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      scope: this.scope,
      taskId: this.taskId,
      authority: this.authority.toJSON(),
      failureMode: this.failureMode,
      file: this.file,
      locator: this.locator,
      rootCause: this.rootCause,
      observed: this.observed,
      title: this.title,
    };
  }
}

/** Exact canonical Gate evidence publication. */
export class GateEvidenceIdentity {
  constructor({ sourceAttempt, resultLogicalKey, publicationActivityId, catalogFingerprint, transitionLineage } = {}) {
    this.sourceAttempt = sourceAttempt instanceof GateAttemptIdentity
      ? sourceAttempt
      : new GateAttemptIdentity(sourceAttempt);
    this.resultLogicalKey = requiredText(resultLogicalKey, "Gate evidence result logical key");
    if (!GATE_RESULT_LOGICAL_KEYS.has(this.resultLogicalKey)) {
      throw new Error("Gate evidence result logical key is invalid");
    }
    this.publicationActivityId = requiredText(publicationActivityId, "Gate evidence publication Activity id");
    this.catalogFingerprint = requiredDigest(catalogFingerprint, "Gate evidence catalog fingerprint");
    this.transitionLineage = transitionLineage instanceof GateLineage
      ? transitionLineage
      : new GateLineage(transitionLineage);
    if (!this.transitionLineage.isCurrent
      || !this.sourceAttempt.matches(this.transitionLineage.canonicalAttempt)
      || this.catalogFingerprint !== this.transitionLineage.canonicalFingerprint) {
      throw new Error("Gate evidence identity does not match its transition lineage");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "sourceAttempt", "resultLogicalKey", "publicationActivityId", "catalogFingerprint", "transitionLineage",
    ], "Gate evidence identity");
    exactKeys(value.sourceAttempt, ["id", "sequence"], "Gate evidence source Attempt");
    exactKeys(value.transitionLineage, [
      "sourceAttempt", "canonicalAttempt", "sourceFingerprint", "canonicalFingerprint",
      "sourceRevisionFingerprint", "canonicalRevisionFingerprint",
    ], "Gate evidence transition lineage");
    exactKeys(value.transitionLineage.sourceAttempt, ["id", "sequence"], "Gate evidence lineage source Attempt");
    exactKeys(value.transitionLineage.canonicalAttempt, ["id", "sequence"], "Gate evidence lineage canonical Attempt");
    return new GateEvidenceIdentity(value);
  }

  matches(other) {
    return other instanceof GateEvidenceIdentity
      && this.sourceAttempt.matches(other.sourceAttempt)
      && this.resultLogicalKey === other.resultLogicalKey
      && this.publicationActivityId === other.publicationActivityId
      && this.catalogFingerprint === other.catalogFingerprint
      && JSON.stringify(this.transitionLineage.toJSON()) === JSON.stringify(other.transitionLineage.toJSON());
  }

  key() {
    return [
      this.resultLogicalKey,
      this.sourceAttempt.id,
      this.sourceAttempt.sequence,
      this.publicationActivityId,
      this.catalogFingerprint,
    ].join(":");
  }

  toJSON() {
    return {
      sourceAttempt: this.sourceAttempt.toJSON(),
      resultLogicalKey: this.resultLogicalKey,
      publicationActivityId: this.publicationActivityId,
      catalogFingerprint: this.catalogFingerprint,
      transitionLineage: this.transitionLineage.toJSON(),
    };
  }
}

/** One blocking/non-blocking observation bound to one exact Gate publication. */
export class GateObservationOccurrence {
  constructor({ evidence, observation, blocking = true } = {}) {
    this.evidence = evidence instanceof GateEvidenceIdentity ? evidence : GateEvidenceIdentity.fromJSON(evidence);
    this.observation = observation instanceof GateObservation ? observation : new GateObservation(observation);
    this.fingerprint = this.observation.fingerprint;
    this.blocking = requiredBoolean(blocking, "Gate observation occurrence blocking");
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["evidence", "observation", "fingerprint", "blocking"], "Gate observation occurrence");
    const occurrence = new GateObservationOccurrence(value);
    if (fingerprintValue(value.fingerprint) !== occurrence.fingerprint.toString()) {
      throw new Error("Gate observation occurrence fingerprint does not match its semantic observation");
    }
    return occurrence;
  }

  key() { return `${this.evidence.key()}:${this.fingerprint}`; }

  toJSON() {
    return {
      evidence: this.evidence.toJSON(),
      observation: this.observation.toJSON(),
      fingerprint: this.fingerprint.toString(),
      blocking: this.blocking,
    };
  }
}

/** A blocking observation selected for one repair cycle. */
export class GateRepairObservationRequest {
  constructor({ fingerprint, recurrenceCount = 0, priorStrategy = null } = {}) {
    this.fingerprint = new GateObservationFingerprint(fingerprintValue(fingerprint));
    this.recurrenceCount = nonNegativeInteger(recurrenceCount, "Gate repair observation recurrenceCount");
    this.priorStrategy = optionalText(priorStrategy, "Gate repair observation priorStrategy");
    if ((this.recurrenceCount > 0) !== (this.priorStrategy !== null)) {
      throw new Error("recurring Gate repair observations require exactly one prior strategy");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      fingerprint: this.fingerprint.toString(),
      recurrenceCount: this.recurrenceCount,
      priorStrategy: this.priorStrategy,
    };
  }
}

class GateRepairObservationResult {
  constructor({ fingerprint, strategy, summary, priorRepairInsufficiency = null } = {}) {
    this.fingerprint = new GateObservationFingerprint(fingerprintValue(fingerprint));
    this.strategy = requiredText(strategy, "Gate repair observation strategy");
    this.summary = requiredText(summary, "Gate repair observation summary");
    this.priorRepairInsufficiency = optionalText(priorRepairInsufficiency, "Gate repair observation priorRepairInsufficiency");
  }

  validateRequest(request) {
    if (!(request instanceof GateRepairObservationRequest)
      || !this.fingerprint.equals(request.fingerprint)) {
      throw new Error("Gate repair observation result does not match its request");
    }
    if (request.recurrenceCount > 0
      && (this.priorRepairInsufficiency === null || this.strategy === request.priorStrategy)) {
      throw new Error("recurring Gate repair result requires priorRepairInsufficiency and a different strategy");
    }
  }
}

/** Per-observation claim for an artifact repair. */
export class ArtifactGateRepairObservationResult extends GateRepairObservationResult {
  constructor({ deltaIds = [], ...value } = {}) {
    super(value);
    if (!Array.isArray(deltaIds)) throw new Error("artifact Gate repair result deltaIds must be an array");
    this.deltaIds = Object.freeze(deltaIds.map((id) => requiredDigest(id, "artifact Gate repair deltaId")));
    if (new Set(this.deltaIds).size !== this.deltaIds.length) {
      throw new Error("artifact Gate repair result deltaIds must be unique");
    }
    Object.freeze(this);
  }

  changeIds() { return this.deltaIds; }
  toJSON() {
    return {
      fingerprint: this.fingerprint.toString(), strategy: this.strategy, summary: this.summary,
      priorRepairInsufficiency: this.priorRepairInsufficiency, deltaIds: [...this.deltaIds],
    };
  }
}

/** Per-observation claim for a source repair. */
export class SourceGateRepairObservationResult extends GateRepairObservationResult {
  constructor({ mutationIds = [], ...value } = {}) {
    super(value);
    if (!Array.isArray(mutationIds)) throw new Error("source Gate repair result mutationIds must be an array");
    this.mutationIds = Object.freeze(mutationIds.map((id) => requiredDigest(id, "source Gate repair mutationId")));
    if (new Set(this.mutationIds).size !== this.mutationIds.length) {
      throw new Error("source Gate repair result mutationIds must be unique");
    }
    Object.freeze(this);
  }

  changeIds() { return this.mutationIds; }
  toJSON() {
    return {
      fingerprint: this.fingerprint.toString(), strategy: this.strategy, summary: this.summary,
      priorRepairInsufficiency: this.priorRepairInsufficiency, mutationIds: [...this.mutationIds],
    };
  }
}

/** Parent-observed artifact deltas for a plan repair. */
export class ArtifactGateRepairLineage {
  constructor({ deltaIds = [] } = {}) {
    if (!Array.isArray(deltaIds)) throw new Error("artifact Gate repair lineage deltaIds must be an array");
    this.deltaIds = Object.freeze(deltaIds.map((id) => requiredDigest(id, "artifact Gate repair lineage deltaId")));
    if (new Set(this.deltaIds).size !== this.deltaIds.length) {
      throw new Error("artifact Gate repair lineage deltaIds must be unique");
    }
    Object.freeze(this);
  }

  get kind() { return "artifact"; }
  changeIds() { return this.deltaIds; }
  toJSON() { return { kind: this.kind, deltaIds: [...this.deltaIds] }; }
}

/** One parent-observed source mutation. */
export class GateRepairMutationLineageEntry {
  constructor({ mutationId, path } = {}) {
    this.mutationId = requiredDigest(mutationId, "source Gate repair lineage mutationId");
    this.path = CanonicalFindingIdentity.normalizePath(requiredText(path, "source Gate repair lineage path"));
    if (this.path.startsWith("/") || this.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("source Gate repair lineage path must be project-relative and normalized");
    }
    Object.freeze(this);
  }

  toJSON() { return { mutationId: this.mutationId, path: this.path }; }
}

/** Parent-observed source mutations and whether they still describe the current checkout. */
export class SourceGateRepairLineage {
  constructor({ currentCheckout, mutations = [] } = {}) {
    this.currentCheckout = requiredBoolean(currentCheckout, "source Gate repair lineage currentCheckout");
    this.mutations = uniqueTyped(mutations, GateRepairMutationLineageEntry, "source Gate repair lineage mutations");
    if (new Set(this.mutations.map((entry) => entry.mutationId)).size !== this.mutations.length
      || new Set(this.mutations.map((entry) => entry.path)).size !== this.mutations.length) {
      throw new Error("source Gate repair lineage mutations must have unique ids and paths");
    }
    Object.freeze(this);
  }

  get kind() { return "source"; }
  changeIds() { return Object.freeze(this.mutations.map((entry) => entry.mutationId)); }
  toJSON() {
    return {
      kind: this.kind,
      currentCheckout: this.currentCheckout,
      mutations: this.mutations.map((entry) => entry.toJSON()),
    };
  }
}

/** Worker repair claims bound to the parent-observed artifact/source change lineage. */
export class GateRepairReport {
  constructor({ beforeEvidenceDigest, outputEvidenceDigest, summary, requests, results, lineage } = {}) {
    this.beforeEvidenceDigest = requiredDigest(beforeEvidenceDigest, "Gate repair report before evidence digest");
    this.outputEvidenceDigest = requiredDigest(outputEvidenceDigest, "Gate repair report output evidence digest");
    this.summary = requiredText(summary, "Gate repair report summary");
    this.requests = uniqueTyped(requests, GateRepairObservationRequest, "Gate repair report requests", { allowEmpty: false });
    if (new Set(this.requests.map((entry) => entry.fingerprint.toString())).size !== this.requests.length) {
      throw new Error("Gate repair report requests must contain each blocking fingerprint exactly once");
    }
    if (!(lineage instanceof ArtifactGateRepairLineage) && !(lineage instanceof SourceGateRepairLineage)) {
      throw new Error("Gate repair report requires typed artifact or source lineage");
    }
    this.lineage = lineage;
    const Result = lineage instanceof ArtifactGateRepairLineage
      ? ArtifactGateRepairObservationResult
      : SourceGateRepairObservationResult;
    this.results = uniqueTyped(results, Result, "Gate repair report results", { allowEmpty: false });
    const requested = this.requests.map((entry) => entry.fingerprint.toString());
    const reported = this.results.map((entry) => entry.fingerprint.toString());
    if (new Set(reported).size !== reported.length || !sameSet(requested, reported)) {
      throw new Error("Gate repair report requires exactly one result per requested blocking fingerprint");
    }
    const requestByFingerprint = new Map(this.requests.map((entry) => [entry.fingerprint.toString(), entry]));
    for (const result of this.results) result.validateRequest(requestByFingerprint.get(result.fingerprint.toString()));
    const claimedChanges = [...new Set(this.results.flatMap((entry) => entry.changeIds()))];
    if (!sameSet(this.lineage.changeIds(), claimedChanges)) {
      throw new Error("Gate repair report observation claims do not match the parent change union");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "beforeEvidenceDigest", "outputEvidenceDigest", "summary", "requests", "results", "lineage",
    ], "Gate repair report");
    exactKeys(value.lineage, value.lineage?.kind === "artifact"
      ? ["kind", "deltaIds"]
      : ["kind", "currentCheckout", "mutations"], "Gate repair report lineage");
    if (!Array.isArray(value.requests) || !Array.isArray(value.results)) {
      throw new Error("Gate repair report requests and results must be arrays");
    }
    for (const request of value.requests) {
      exactKeys(request, ["fingerprint", "recurrenceCount", "priorStrategy"], "Gate repair observation request");
    }
    let lineage;
    let Result;
    if (value.lineage.kind === "artifact") {
      lineage = new ArtifactGateRepairLineage(value.lineage);
      Result = ArtifactGateRepairObservationResult;
      for (const result of value.results) {
        exactKeys(result, [
          "fingerprint", "strategy", "summary", "priorRepairInsufficiency", "deltaIds",
        ], "artifact Gate repair observation result");
      }
    } else if (value.lineage.kind === "source") {
      lineage = new SourceGateRepairLineage(value.lineage);
      Result = SourceGateRepairObservationResult;
      if (!Array.isArray(value.lineage.mutations)) {
        throw new Error("source Gate repair lineage mutations must be an array");
      }
      for (const mutation of value.lineage.mutations) {
        exactKeys(mutation, ["mutationId", "path"], "source Gate repair lineage mutation");
      }
      for (const result of value.results) {
        exactKeys(result, [
          "fingerprint", "strategy", "summary", "priorRepairInsufficiency", "mutationIds",
        ], "source Gate repair observation result");
      }
    } else {
      throw new Error("Gate repair report lineage kind is invalid");
    }
    return new GateRepairReport({
      ...value,
      lineage,
      results: value.results.map((entry) => new Result(entry)),
    });
  }

  get kind() { return this.lineage.kind; }
  toJSON() {
    return {
      beforeEvidenceDigest: this.beforeEvidenceDigest,
      outputEvidenceDigest: this.outputEvidenceDigest,
      summary: this.summary,
      requests: this.requests.map((entry) => entry.toJSON()),
      results: this.results.map((entry) => entry.toJSON()),
      lineage: this.lineage.toJSON(),
    };
  }
}

/** Canonical repair request binding consumed by the occurrence-cycle reader. */
export class GateObservationRepair {
  constructor({
    repairId, sourceEvidence, targetAttempt, publicationActivityId,
    recordFingerprint, handoffRevision, requests,
  } = {}) {
    this.repairId = requiredText(repairId, "Gate observation repair id");
    this.sourceEvidence = sourceEvidence instanceof GateEvidenceIdentity
      ? sourceEvidence
      : GateEvidenceIdentity.fromJSON(sourceEvidence);
    this.targetAttempt = targetAttempt instanceof GateAttemptIdentity
      ? targetAttempt
      : new GateAttemptIdentity(targetAttempt);
    this.publicationActivityId = requiredText(publicationActivityId, "Gate observation repair publication Activity id");
    this.recordFingerprint = requiredDigest(recordFingerprint, "Gate observation repair record fingerprint");
    this.handoffRevision = requiredDigest(handoffRevision, "Gate observation repair handoff revision");
    this.requests = uniqueTyped(requests, GateRepairObservationRequest, "Gate observation repair requests", { allowEmpty: false });
    if (new Set(this.requests.map((entry) => entry.fingerprint.toString())).size !== this.requests.length) {
      throw new Error("Gate observation repair requests must contain each fingerprint exactly once");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "repairId", "sourceEvidence", "targetAttempt", "publicationActivityId",
      "recordFingerprint", "handoffRevision", "requests",
    ], "Gate observation repair");
    exactKeys(value.targetAttempt, ["id", "sequence"], "Gate observation repair target Attempt");
    if (!Array.isArray(value.requests)) throw new Error("Gate observation repair requests must be an array");
    for (const request of value.requests) {
      exactKeys(request, ["fingerprint", "recurrenceCount", "priorStrategy"], "Gate repair observation request");
    }
    return new GateObservationRepair(value);
  }

  toJSON() {
    return {
      repairId: this.repairId,
      sourceEvidence: this.sourceEvidence.toJSON(),
      targetAttempt: this.targetAttempt.toJSON(),
      publicationActivityId: this.publicationActivityId,
      recordFingerprint: this.recordFingerprint,
      handoffRevision: this.handoffRevision,
      requests: this.requests.map((entry) => entry.toJSON()),
    };
  }
}

/** Immutable parent decision about whether a plan-Gate repair made canonical progress. */
export class PlanGateRepairOutcome {
  constructor({
    repairId, repairRecordFingerprint, sourceEvidence, sourceAttempt, targetAttempt,
    publicationActivityId, handoffRevision, disposition, report,
  } = {}) {
    this.repairId = requiredText(repairId, "plan Gate repair outcome repair id");
    this.repairRecordFingerprint = requiredDigest(repairRecordFingerprint, "plan Gate repair outcome record fingerprint");
    this.sourceEvidence = sourceEvidence instanceof GateEvidenceIdentity
      ? sourceEvidence
      : GateEvidenceIdentity.fromJSON(sourceEvidence);
    this.sourceAttempt = sourceAttempt instanceof GateAttemptIdentity
      ? sourceAttempt
      : new GateAttemptIdentity(sourceAttempt);
    if (!this.sourceAttempt.matches(this.sourceEvidence.sourceAttempt)) {
      throw new Error("plan Gate repair outcome source Attempt does not match source evidence");
    }
    this.targetAttempt = targetAttempt instanceof GateAttemptIdentity
      ? targetAttempt
      : new GateAttemptIdentity(targetAttempt);
    this.publicationActivityId = requiredText(publicationActivityId, "plan Gate repair outcome publication Activity id");
    this.handoffRevision = requiredDigest(handoffRevision, "plan Gate repair outcome handoff revision");
    this.disposition = requiredText(disposition, "plan Gate repair outcome disposition");
    if (!OUTCOME_DISPOSITIONS.has(this.disposition)) throw new Error("plan Gate repair outcome disposition is invalid");
    this.report = report instanceof GateRepairReport ? report : GateRepairReport.fromJSON(report);

    const changedDigest = this.report.beforeEvidenceDigest !== this.report.outputEvidenceDigest;
    const changes = this.report.lineage.changeIds();
    if (this.disposition === "applied") {
      if (this.report.lineage instanceof ArtifactGateRepairLineage && (!changedDigest || changes.length === 0)) {
        throw new Error("applied artifact Gate repair requires a changed evidence digest and delta lineage");
      }
      if (this.report.lineage instanceof SourceGateRepairLineage
        && (!changedDigest || !this.report.lineage.currentCheckout || changes.length === 0)) {
        throw new Error("applied source Gate repair requires changed evidence and non-empty current-checkout mutation lineage");
      }
    } else if (changedDigest
      || (this.report.lineage instanceof ArtifactGateRepairLineage && changes.length > 0)) {
      throw new Error("rejected-no-progress Gate repair must not contain changed evidence or artifact deltas");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "version", "repairId", "repairRecordFingerprint", "sourceEvidence", "sourceAttempt", "targetAttempt",
      "publicationActivityId", "handoffRevision", "disposition", "report",
    ], "plan Gate repair outcome");
    if (value.version !== 1) throw new Error("plan Gate repair outcome version must be 1");
    exactKeys(value.sourceAttempt, ["id", "sequence"], "plan Gate repair outcome source Attempt");
    exactKeys(value.targetAttempt, ["id", "sequence"], "plan Gate repair outcome target Attempt");
    return new PlanGateRepairOutcome(value);
  }

  assertRepair(repair) {
    if (!(repair instanceof GateObservationRepair)
      || this.repairId !== repair.repairId
      || this.repairRecordFingerprint !== repair.recordFingerprint
      || !this.sourceEvidence.matches(repair.sourceEvidence)
      || !this.sourceAttempt.matches(repair.sourceEvidence.sourceAttempt)
      || !this.targetAttempt.matches(repair.targetAttempt)
      || this.handoffRevision !== repair.handoffRevision
      || !sameSet(
        this.report.requests.map((entry) => entry.fingerprint.toString()),
        repair.requests.map((entry) => entry.fingerprint.toString()),
      )) {
      throw new Error("plan Gate repair outcome does not match its exact repair binding");
    }
    return this;
  }

  toJSON() {
    return {
      version: 1,
      repairId: this.repairId,
      repairRecordFingerprint: this.repairRecordFingerprint,
      sourceEvidence: this.sourceEvidence.toJSON(),
      sourceAttempt: this.sourceAttempt.toJSON(),
      targetAttempt: this.targetAttempt.toJSON(),
      publicationActivityId: this.publicationActivityId,
      handoffRevision: this.handoffRevision,
      disposition: this.disposition,
      report: this.report.toJSON(),
    };
  }
}

/** Parent-owned outcome before the canonical Store assigns its Activity id. */
export class PlanGateRepairOutcomeDraft {
  constructor({ repair, disposition, report } = {}) {
    if (!(repair instanceof GateObservationRepair)) {
      throw new Error("plan Gate repair outcome draft requires a typed repair binding");
    }
    this.repair = repair;
    this.disposition = requiredText(disposition, "plan Gate repair outcome draft disposition");
    if (!OUTCOME_DISPOSITIONS.has(this.disposition)) {
      throw new Error("plan Gate repair outcome draft disposition is invalid");
    }
    this.report = report instanceof GateRepairReport ? report : GateRepairReport.fromJSON(report);
    Object.freeze(this);
  }

  seal(publicationActivityId) {
    const outcome = new PlanGateRepairOutcome({
      repairId: this.repair.repairId,
      repairRecordFingerprint: this.repair.recordFingerprint,
      sourceEvidence: this.repair.sourceEvidence,
      sourceAttempt: this.repair.sourceEvidence.sourceAttempt,
      targetAttempt: this.repair.targetAttempt,
      publicationActivityId,
      handoffRevision: this.repair.handoffRevision,
      disposition: this.disposition,
      report: this.report,
    });
    return outcome.assertRepair(this.repair);
  }
}

/** All exact occurrences and repair cycles for one semantic observation. */
export class GateObservationCycle {
  constructor({ fingerprint, occurrences, repairs, outcomes } = {}) {
    this.fingerprint = new GateObservationFingerprint(fingerprintValue(fingerprint));
    this.occurrences = uniqueTyped(occurrences, GateObservationOccurrence, "Gate observation cycle occurrences", { allowEmpty: false });
    this.repairs = uniqueTyped(repairs, GateObservationRepair, "Gate observation cycle repairs");
    this.outcomes = uniqueTyped(outcomes, PlanGateRepairOutcome, "Gate observation cycle outcomes");
    const expected = this.fingerprint.toString();
    if (this.occurrences.some((entry) => entry.fingerprint.toString() !== expected)
      || this.repairs.some((entry) => !entry.requests.some((request) => request.fingerprint.toString() === expected))
      || this.outcomes.some((entry) => !entry.report.requests.some((request) => request.fingerprint.toString() === expected))) {
      throw new Error("Gate observation cycle entries must share one fingerprint");
    }
    Object.freeze(this);
  }

  get occurrenceCount() { return this.occurrences.length; }
  get repairCount() { return this.repairs.length; }
  get recurrenceCount() { return Math.max(0, this.occurrenceCount - 1); }

  toJSON() {
    return {
      fingerprint: this.fingerprint.toString(),
      occurrenceCount: this.occurrenceCount,
      repairCount: this.repairCount,
      recurrenceCount: this.recurrenceCount,
      occurrences: this.occurrences.map((entry) => entry.toJSON()),
      repairs: this.repairs.map((entry) => entry.toJSON()),
      outcomes: this.outcomes.map((entry) => entry.toJSON()),
    };
  }
}

/** Immutable aggregate returned by one canonical cycle read. */
export class GateObservationCycleReadModel {
  constructor(cycles = []) {
    this.cycles = uniqueTyped(cycles, GateObservationCycle, "Gate observation cycles");
    Object.freeze(this);
  }

  get occurrenceCount() { return this.cycles.reduce((total, cycle) => total + cycle.occurrenceCount, 0); }
  get repairCount() { return this.cycles.reduce((total, cycle) => total + cycle.repairCount, 0); }
  get recurrenceCount() { return this.cycles.reduce((total, cycle) => total + cycle.recurrenceCount, 0); }

  find(fingerprint) {
    const expected = fingerprintValue(fingerprint);
    return this.cycles.find((cycle) => cycle.fingerprint.toString() === expected) ?? null;
  }

  toJSON() {
    return {
      occurrenceCount: this.occurrenceCount,
      repairCount: this.repairCount,
      recurrenceCount: this.recurrenceCount,
      cycles: this.cycles.map((cycle) => cycle.toJSON()),
    };
  }
}

/**
 * Sole domain join for Gate observations, repair records and outcomes.
 * Callers supply canonical rows; this reader rejects every inferred or stale
 * relationship rather than reconstructing it from filenames or ordering.
 */
export class GateObservationCycleReader {
  constructor({ occurrences = [], repairs = [], outcomes = [] } = {}) {
    if (!Array.isArray(occurrences) || occurrences.some((entry) => !(entry instanceof GateObservationOccurrence))) {
      throw new Error("Gate observation cycle reader requires typed occurrences");
    }
    if (!Array.isArray(repairs) || repairs.some((entry) => !(entry instanceof GateObservationRepair))) {
      throw new Error("Gate observation cycle reader requires typed repairs");
    }
    if (!Array.isArray(outcomes) || outcomes.some((entry) => !(entry instanceof PlanGateRepairOutcome))) {
      throw new Error("Gate observation cycle reader requires typed outcomes");
    }
    this.occurrences = Object.freeze([...occurrences]);
    this.repairs = Object.freeze([...repairs]);
    this.outcomes = Object.freeze([...outcomes]);
    Object.freeze(this);
  }

  static fromCanonical({ observationRows = [], repairRows = [], outcomeRows = [] } = {}) {
    if (!Array.isArray(observationRows) || !Array.isArray(repairRows) || !Array.isArray(outcomeRows)) {
      throw new Error("Gate observation canonical rows must be arrays");
    }
    return new GateObservationCycleReader({
      occurrences: observationRows.map((row) => GateObservationOccurrence.fromJSON(row)),
      repairs: repairRows.map((row) => GateObservationRepair.fromJSON(row)),
      outcomes: outcomeRows.map((row) => PlanGateRepairOutcome.fromJSON(row)),
    });
  }

  read() {
    const occurrenceKeys = this.occurrences.map((entry) => entry.key());
    if (new Set(occurrenceKeys).size !== occurrenceKeys.length) {
      throw new Error("Gate observation cycle contains duplicate occurrence claims");
    }
    const occurrenceSequences = this.occurrences.map((entry) => [
      entry.fingerprint.toString(),
      entry.evidence.resultLogicalKey,
      entry.evidence.sourceAttempt.sequence,
    ].join(":"));
    if (new Set(occurrenceSequences).size !== occurrenceSequences.length) {
      throw new Error("Gate observation cycle contains conflicting Attempt occurrence claims");
    }
    const repairIds = this.repairs.map((entry) => entry.repairId);
    if (new Set(repairIds).size !== repairIds.length
      || new Set(this.repairs.map((entry) => `${entry.targetAttempt.id}:${entry.targetAttempt.sequence}`)).size !== this.repairs.length) {
      throw new Error("Gate observation cycle contains duplicate repair claims");
    }
    const outcomeIds = this.outcomes.map((entry) => entry.repairId);
    if (new Set(outcomeIds).size !== outcomeIds.length) {
      throw new Error("Gate observation cycle contains duplicate outcome claims");
    }

    const repairClaimKeys = [];
    for (const repair of this.repairs) {
      for (const request of repair.requests) {
        const sourceOccurrence = this.occurrences.find((occurrence) => (
          occurrence.blocking
          && occurrence.evidence.matches(repair.sourceEvidence)
          && occurrence.fingerprint.equals(request.fingerprint)
        ));
        if (sourceOccurrence === undefined) {
          throw new Error("Gate observation repair has stale or unbound source evidence");
        }
        repairClaimKeys.push(`${repair.sourceEvidence.key()}:${request.fingerprint}`);
        const priorOccurrences = this.occurrences.filter((occurrence) => (
          occurrence.fingerprint.equals(request.fingerprint)
          && occurrence.evidence.resultLogicalKey === repair.sourceEvidence.resultLogicalKey
          && occurrence.evidence.sourceAttempt.sequence < repair.sourceEvidence.sourceAttempt.sequence
        ));
        if (request.recurrenceCount !== priorOccurrences.length) {
          throw new Error("Gate observation repair recurrence count does not match canonical occurrences");
        }
        if (request.recurrenceCount > 0) {
          const priorRepair = [...this.repairs]
            .filter((candidate) => (
              candidate.sourceEvidence.resultLogicalKey === repair.sourceEvidence.resultLogicalKey
              && candidate.sourceEvidence.sourceAttempt.sequence < repair.sourceEvidence.sourceAttempt.sequence
              && candidate.requests.some((entry) => entry.fingerprint.equals(request.fingerprint))
            ))
            .sort((left, right) => right.sourceEvidence.sourceAttempt.sequence - left.sourceEvidence.sourceAttempt.sequence)
            .find((candidate) => this.outcomes.some((entry) => entry.repairId === candidate.repairId));
          const priorOutcome = priorRepair === undefined
            ? null
            : this.outcomes.find((entry) => entry.repairId === priorRepair.repairId);
          const priorResult = priorOutcome?.report.results.find((entry) => entry.fingerprint.equals(request.fingerprint));
          if (priorResult === undefined || request.priorStrategy !== priorResult.strategy) {
            throw new Error("Gate observation repair prior strategy does not match the latest exact repair outcome");
          }
        }
      }
    }
    if (new Set(repairClaimKeys).size !== repairClaimKeys.length) {
      throw new Error("Gate observation cycle contains duplicate source repair claims");
    }
    const repairById = new Map(this.repairs.map((entry) => [entry.repairId, entry]));
    for (const outcome of this.outcomes) {
      const repair = repairById.get(outcome.repairId);
      if (repair === undefined) throw new Error("plan Gate repair outcome has no canonical repair record");
      outcome.assertRepair(repair);
    }

    const fingerprints = [...new Set(this.occurrences.map((entry) => entry.fingerprint.toString()))].sort();
    return new GateObservationCycleReadModel(fingerprints.map((fingerprint) => {
      const occurrences = this.occurrences
        .filter((entry) => entry.fingerprint.toString() === fingerprint)
        .sort((left, right) => left.evidence.sourceAttempt.sequence - right.evidence.sourceAttempt.sequence);
      const repairs = this.repairs.filter((repair) => (
        repair.requests.some((request) => request.fingerprint.toString() === fingerprint)
      ));
      const repairIdsForFingerprint = new Set(repairs.map((repair) => repair.repairId));
      const outcomes = this.outcomes.filter((outcome) => repairIdsForFingerprint.has(outcome.repairId));
      return new GateObservationCycle({ fingerprint, occurrences, repairs, outcomes });
    }));
  }
}
