import { FLOW_ARTIFACT_CONTRACTS } from "../lib/flow-artifact-contract.js";
import { QueryError, canonicalJson, canonicalDigest, publicArtifactId, publicArtifactKey, ReferenceResolver } from "./query-values.js";
import { CanonicalSpecReview } from "./lib/spec-review-artifacts.js";
import { DraftReviewArtifactDocument } from "./lib/draft-review-artifacts.js";
import { DRAFT_REVIEW_ROUTES } from "./lib/draft-review-routes.js";
import { CanonicalCommandAttemptArtifactHistory } from "./lib/canonical-command-result.js";
import { SpecRepairTarget, SpecRepairOperationBatch, specRepairProposalDigest } from "./lib/spec-repair-operations.js";
import { ActivityReviewPublication, NodeResult } from "./lib/current-flow-state.js";
import { SpecReviewExecutionRequiredResult } from "./engine/step-result.js";
import { TaskStepIdentity } from "./lib/task-step-identity.js";
import { ImplementationSourceEvidence } from "./lib/source-effect-values.js";
import { SourceHandoffSettlement } from "./lib/worker-artifact-handoff.js";
import { NextAction } from "./lib/observation.js";
import { FlowFindingsArtifact } from "./lib/flow-findings.js";
import { canonicalSourceFindingObservations, findSourceFinding } from "./lib/flow-finding-source.js";
import { canonicalGateLogicalKeys, canonicalGateNodeId, canonicalGateRevision } from "./lib/canonical-gate-artifacts.js";
import { GateAttemptIdentity, GateFailureCategory } from "./lib/gate-transition.js";
import { GateEvaluationScope } from "./lib/run-gate.js";
import { AgentResponseProtocolEvidence } from "../lib/agent-response-protocol.js";

const GROUPS = Object.freeze(["evaluations", "findings", "repairs"]);
const GATE_KEYS = new Set(["draft.gate", "spec.gate", "task.gate", "impl.gate"]);
const SPEC_REVIEW_VERDICTS = new Set(["spec-review-passed", "spec-review-advisory", "spec-review-rejected"]);
// These ledger operations record lifecycle/administrative facts and cannot
// produce review, evaluation, or repair observations.
const NON_DETAIL_OPERATIONS = new Set([
  "create_flow", "add_task", "add_approval_task", "start_attempt", "retry_attempt", "retry_gate_attempt",
  "retry_recovery_attempt", "update_attempt", "fail_attempt", "record_failure", "rewind", "recover_attempt",
  "park_flow", "resume_flow", "finalize_flow", "set_policy", "activate_nonblocking", "update_spec_record",
  "begin_outbox", "reopen_outbox", "complete_outbox", "fail_outbox", "record_dispatch_approval",
  "record_metric", "record_note", "record_nonblocking", "skip_finalize_downstream", "reset_finalize_downstream",
]);
// Positive producer inventory, using persisted Step IDs from definition.js:
// prepare/{branch,prepare-spec}: PlanPreparationService adopts Git/Version preparation.
// draft/{draft,draft-refine}, spec/spec: publish document candidates/answers.
// test/approval: records user approval and initializes the test lifecycle.
// acceptance/report: ReportResultEvidence records document publication/delivery.
// finalize/*: finalizationResultForEvidence records Git/docs/worktree operations.
// Review, triage, repair, test generation/execution and acceptance decisions are
// deliberately absent: those contracts can retain evaluations or finding changes.
const NON_DETAIL_STEPS = new Set([
  "branch", "prepare-spec", "draft", "draft-refine", "spec", "approval", "report",
  "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup",
]);
// SourceStepMeaning and SourceWorkerEffect permit issue/repair observations for
// source Steps. Only these concrete saved Results prove a non-detail operation;
// an untyped completion, task Gate repair, or quality issue cannot use this path.
const NON_DETAIL_SOURCE_RESULTS = new Set([
  "implement-worker-required", "implement-applied", "implement-existing-completion",
  "task-impl-worker-required",
]);

function unavailable(reason, referenceId, message, cause) {
  throw new QueryError("DETAIL_UNAVAILABLE", "/canonical", message, { reason, referenceId, cause });
}
function exactFields(value, allowed, referenceId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The producer contains unsupported semantic fields");
  }
}
function assertRecordedProducerValue(value, interpreted, referenceId) {
  if (JSON.stringify(canonicalJson(interpreted.toJSON())) !== JSON.stringify(canonicalJson(value))) {
    unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The producer requires normalization of missing or unsupported recorded fields");
  }
}
function requireRetainedText(value, referenceId) {
  if (typeof value === "string" && value.endsWith(" [truncated]")) {
    unavailable("SOURCE_TRUNCATED", referenceId, "The producer retained a truncated detail");
  }
  if (value !== null && typeof value === "object") for (const entry of Object.values(value)) requireRetainedText(entry, referenceId);
}
function outcome(nativeValue, referenceId) {
  const values = { PASS: "passed", ADVISORY: "advisory", REJECTED: "failed", pass: "passed", fail: "failed", skip: "skipped", passed: "passed", failed: "failed", skipped: "skipped", incomplete: "incomplete", "spec-review-passed": "passed", "spec-review-advisory": "advisory", "spec-review-rejected": "failed" };
  if (!Object.hasOwn(values, nativeValue)) unavailable("STATUS_NOT_SUPPORTED", referenceId, "The recorded evaluation outcome is unsupported");
  return values[nativeValue];
}

class DetailGroups {
  constructor(make) { for (const group of GROUPS) this[group] = make(group); }
  toJSON() { return Object.fromEntries(GROUPS.map((group) => [group, this[group]?.toJSON?.() ?? this[group].map((entry) => entry?.toJSON?.() ?? entry)])); }
}
class DetailCoverage {
  constructor(availability, count = 0) {
    this.availability = availability;
    this.reason = availability === "available" ? null : availability === "not-applicable" ? "NOT_APPLICABLE" : "PRODUCER_DID_NOT_RECORD";
    this.count = count;
    Object.freeze(this);
  }
  toJSON() { return { availability: this.availability, reason: this.reason, count: this.count }; }
}
class DetailBinding {
  constructor(reference, ids) {
    if (ids.length === 0) unavailable("REFERENCE_NOT_RESOLVED", reference.id, "The recorded detail reference has no retained observation");
    this.reference = reference;
    this.ids = ids;
  }
  toJSON() { return { reference: { id: this.reference.id, label: this.reference.label ?? null }, detailIds: [...this.ids], availability: "available", reason: null }; }
}
export class QueryActivityDetails {
  constructor({ entities, bindings, applicable, notRecorded }) {
    this.detailRefs = new DetailGroups((group) => entities[group].map((entity) => entity.id));
    this.referenceBindings = new DetailGroups((group) => bindings[group]);
    this.detailCoverage = new DetailGroups((group) => new DetailCoverage(applicable.has(group) ? "available" : notRecorded.has(group) ? "not-recorded" : "not-applicable", entities[group].length));
    Object.freeze(this);
  }
  toJSON() { return { detailRefs: this.detailRefs.toJSON(), referenceBindings: this.referenceBindings.toJSON(), detailCoverage: this.detailCoverage.toJSON() }; }
}
class DetailSource {
  constructor({ descriptor, activity, flowVersionId, entryId, observationId, pointer = "", format = "json" }) {
    this.artifactId = publicArtifactId(descriptor);
    this.artifactKey = publicArtifactKey(descriptor, flowVersionId);
    this.relativePath = descriptor.relativePath;
    this.hash = descriptor.hash;
    this.producerActivityId = activity.id;
    this.nodeId = activity.nodeId;
    this.attemptId = activity.attemptId;
    this.sourceEntryId = entryId;
    this.observationId = observationId;
    this.format = format;
    this.jsonPointer = format === "jsonl" ? null : pointer;
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}
class DetailStatus {
  constructor(value = null, nativeValue = null) {
    if (value === null && nativeValue !== null) unavailable("STATUS_NOT_SUPPORTED", nativeValue, "A recorded native status requires an explicit public status mapping");
    this.value = value;
    this.nativeValue = nativeValue;
    Object.freeze(this);
  }
  toJSON() { return { value: this.value, availability: this.value === null ? "not-recorded" : "available",
    reason: this.value === null ? "PRODUCER_DID_NOT_RECORD" : null, nativeValue: this.nativeValue }; }
}
class DetailEntity {
  constructor({ kind, source, flowVersionId, identity = null }) {
    this.source = source;
    this.id = `${kind}:${canonicalDigest({ flowVersionId, producerActivityId: source.producerActivityId,
      observationId: source.observationId, ...(identity === null ? { sourceEntryId: source.sourceEntryId } : { identity: identity.toJSON() }) })}`;
    this.kind = kind;
    this.supportingSources = [];
    this.activityIds = [source.producerActivityId];
    this.evaluationIds = [];
    this.findingIds = [];
    this.repairIds = [];
  }
  commonJSON() { return { id: this.id, kind: this.kind, source: this.source.toJSON(), supportingSources: this.supportingSources.map((source) => source.toJSON()),
    activityIds: [...this.activityIds], evaluationIds: [...this.evaluationIds], findingIds: [...this.findingIds], repairIds: [...this.repairIds] }; }
}
class EvaluationCriterion {
  constructor(value, referenceId) {
    exactFields(value, ["guardrail_id", "result", "reason", "category", "title", "observations", "authority"], referenceId);
    if (value.observations !== undefined && (!Array.isArray(value.observations) || value.observations.length !== 0)) {
      unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "Gate finding semantics have no declared public detail variant");
    }
    this.id = value.guardrail_id;
    this.reason = value.reason;
    this.title = detailText(value.title, referenceId);
    this.category = detailText(value.category, referenceId);
    this.authority = detailText(value.authority, referenceId);
    if (this.authority !== null && this.authority !== "mechanical") {
      unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The recorded Gate criterion authority is unsupported");
    }
    this.result = outcome(value.result, referenceId);
  }
  toJSON() { return { id: this.id, title: this.title, category: this.category, authority: this.authority, expected: null, observed: null, evidence: this.reason ?? null, result: this.result }; }
}
function detailText(value, referenceId) {
  if (value !== undefined && value !== null && typeof value !== "string") unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The producer detail requires a recorded string");
  return value ?? null;
}
class GateReason {
  constructor(value, referenceId) {
    exactFields(value, ["verdict", "detail", "guardrail_id", "category", "where"], referenceId);
    if (typeof value.verdict !== "string" || typeof value.detail !== "string") unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The Gate reason has no supported recorded verdict or detail");
    this.verdict = value.verdict;
    this.detail = value.detail;
    this.guardrailId = detailText(value.guardrail_id, referenceId);
    this.category = detailText(value.category, referenceId);
    this.where = detailText(value.where, referenceId);
  }
  toJSON() { return { ...this }; }
}
class GateEvaluationSpecific {
  constructor(payload, nextAction, referenceId) {
    for (const field of ["target", "level", "phase", "failureKind", "failureCode", "taskId", "sourceFingerprint"]) this[field] = detailText(payload[field], referenceId);
    if (this.sourceFingerprint !== null && !/^[a-f0-9]{64}$/.test(this.sourceFingerprint)) {
      unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "The Gate source fingerprint is invalid");
    }
    this.failureCategory = null;
    if (payload.gateTransitionFailureCategory !== undefined) {
      exactFields(payload.gateTransitionFailureCategory, ["category", "code"], referenceId);
      const failure = new GateFailureCategory(payload.gateTransitionFailureCategory);
      assertRecordedProducerValue(payload.gateTransitionFailureCategory, failure, referenceId);
      this.failureCategory = failure.toJSON();
    }
    this.evaluationScope = null;
    if (payload.evaluationScope !== undefined) {
      const scope = GateEvaluationScope.fromJSON(payload.evaluationScope);
      assertRecordedProducerValue(payload.evaluationScope, scope, referenceId);
      if (scope.phase !== this.phase || scope.taskId !== this.taskId || scope.sourceFingerprint !== this.sourceFingerprint) {
        unavailable("SOURCE_GENERATION_NOT_RETAINED", referenceId, "The Gate evaluation scope does not bind the recorded result");
      }
      this.evaluationScope = scope.toJSON();
    }
    for (const field of ["reasons", "issues", "warnings"]) {
      if (payload[field] != null && !Array.isArray(payload[field])) unavailable("PRODUCER_NOT_SUPPORTED", referenceId, `Gate ${field} must be a recorded collection`);
    }
    this.reasons = payload.reasons == null ? null : payload.reasons.map((value) => new GateReason(value, referenceId));
    for (const field of ["issues", "warnings"]) {
      this[field] = payload[field] == null ? null : payload[field].map((value) => {
        if (typeof value !== "string") unavailable("PRODUCER_NOT_SUPPORTED", referenceId, `Gate ${field} require recorded text`);
        return value;
      });
    }
    this.prescription = nextAction?.prescription ?? null;
    this.diagnosisSummary = nextAction?.diagnosis.summary ?? null;
  }
  toJSON() { return { schemaId: "gate-evaluation@1", ...this, reasons: this.reasons?.map((reason) => reason.toJSON()) ?? null }; }
}
class EvaluationDetail extends DetailEntity {
  constructor({ source, flowVersionId, nativeCode, summary = null, explanation = null, criteria = [], specific = null }) {
    super({ kind: "evaluation", source, flowVersionId });
    this.result = outcome(nativeCode, source.sourceEntryId);
    this.nativeCode = nativeCode;
    this.summary = summary;
    this.explanation = explanation;
    this.criteria = criteria;
    this.specific = specific;
  }
  toJSON() { return { ...this.commonJSON(), title: null, summary: this.summary, explanation: this.explanation,
    result: { outcome: this.result, nativeCode: this.nativeCode }, criteria: this.criteria.map((criterion) => criterion.toJSON()), specific: this.specific?.toJSON() ?? null }; }
}
class SpecFindingSpecific {
  constructor(value) { this.value = value; }
  toJSON() {
    const value = this.value;
    return { schemaId: "spec-review-finding@1", kind: value.kind, issue: value.issue ?? null, requiredChange: value.requiredChange ?? null,
      whyBlocking: value.whyBlocking ?? null, improvement: value.improvement ?? null, whyNonBlocking: value.whyNonBlocking ?? null,
      target: value.target, triage: value.disposition === undefined ? null : { disposition: value.disposition, evidence: value.evidence,
        allowedTargets: (value.allowedTargets ?? []).map((permission) => ({ target: publicRepairTarget(permission.target), operationKinds: permission.operationKinds })) } };
  }
}
class DraftFindingSpecific {
  constructor(value) { this.value = value; }
  toJSON() { const value = this.value; return { schemaId: "draft-finding@1", classification: value.classification, target: value.target, rationale: value.rationale, evidence: value.evidence }; }
}
class FindingDetail extends DetailEntity {
  constructor({ source, flowVersionId, observation, draft = false }) {
    super({ kind: "finding", source, flowVersionId, identity: observation.identity });
    this.identity = observation.identity;
    this.findingKey = `finding:${canonicalDigest({ flowVersionId, identity: this.identity.toJSON() })}`;
    this.finding = observation.finding;
    this.draft = draft;
    this.specific = draft ? new DraftFindingSpecific(this.finding) : new SpecFindingSpecific(this.finding);
  }
  toJSON() {
    const value = this.finding;
    return { ...this.commonJSON(), identity: this.identity.toJSON(), findingKey: this.findingKey,
      title: value.title, description: this.draft ? value.rationale : value.body, expected: null, observed: null,
      severity: this.draft ? (value.classification === "blocking" ? "blocking" : "advisory") : (value.kind === "blocking" ? "blocking" : "advisory"),
      status: new DetailStatus(value.disposition === undefined ? null : "triaged", value.disposition ?? null).toJSON(),
      currentState: null, specific: this.specific.toJSON(), reason: value.whyBlocking ?? value.whyNonBlocking ?? value.rationale ?? null,
      recommendation: value.requiredChange ?? value.improvement ?? null, evidence: value.evidence ?? null };
  }
}
class RepairItemTarget {
  constructor(value) {
    this.entity = value.entity ?? value.collection ?? null;
    this.id = value.id ?? null;
    this.field = value.field ?? null;
    this.collection = value.collection ?? null;
    this.position = value.position ?? null;
    if (this.position !== null && (!Number.isSafeInteger(this.position) || this.position < 0)) unavailable("PRODUCER_NOT_SUPPORTED", this.collection, "The recorded repair target position is unsupported");
    this.relativePath = null;
    this.jsonPointer = null;
    Object.freeze(this);
  }
  static fromOperation(operation) {
    if (operation.target == null) return new RepairItemTarget({});
    const native = SpecRepairTarget.fromJSON(operation.target, "detail repair target");
    const target = native.toJSON();
    return new RepairItemTarget(Object.hasOwn(target, "collection")
      ? { ...target, id: native.conflictKey(operation.expectedDigest) } : target);
  }
  toJSON() { return { ...this }; }
}
class RepairItem {
  constructor({ id, referenceId = id, target, operationKind, status, reason = null, findingIds = [] }) {
    Object.assign(this, { id, referenceId, target: target instanceof RepairItemTarget ? target : new RepairItemTarget(target), operationKind, status, reason, findingIds });
  }
  matchesReference(id) { return this.id === id || this.referenceId === id; }
  toJSON() { return { id: this.id, target: this.target.toJSON(), operationKind: this.operationKind,
    status: this.status.toJSON(), adoptedReason: this.status.value === "discarded" ? null : this.reason,
    discardedReason: this.status.value === "discarded" ? this.reason : null, evidence: [], findingIds: [...this.findingIds] }; }
}
class RepairStatus extends DetailStatus {
  constructor(items, nativeValue, skipped) {
    let value;
    if (skipped !== null && nativeValue === "continue_nonblocking") value = "skipped";
    else if (nativeValue === "merged" && items.some((item) => item.status.value === "applied")) value = "applied";
    else if (nativeValue === "no-op" && items.every((item) => item.status.value === "discarded")) value = items.length ? "discarded" : "skipped";
    else unavailable("STATUS_NOT_SUPPORTED", nativeValue, "The recorded repair outcome has no supported status mapping");
    super(value, nativeValue);
  }
}
class RepairDetail extends DetailEntity {
  constructor({ source, flowVersionId, items, nativeValue = null, skipped = null }) {
    super({ kind: "repair", source, flowVersionId });
    this.items = items;
    this.nativeValue = nativeValue;
    this.skipped = skipped;
    this.status = new RepairStatus(items, nativeValue, skipped);
    if (skipped !== null) this.kind = "lifecycle-skip";
  }
  toJSON() { return { ...this.commonJSON(), title: null, description: null, reason: this.skipped?.rationale ?? null,
    status: this.status.toJSON(),
    currentState: null, items: this.items.map((item) => item.toJSON()), specific: this.skipped === null ? null : this.skipped.toJSON() }; }
}
class LifecycleSkipSpecific {
  constructor(decision) { this.decision = decision; this.rationale = decision.rationale; }
  toJSON() { const value = this.decision; return { schemaId: "ledger-skip@1", operation: "continue_nonblocking", sourceStep: value.sourceStep,
    sourceAttempt: value.sourceAttempt, evidenceRef: value.evidenceRef, evidenceDigest: value.evidenceDigest,
    resultKind: value.resultKind, action: "continue", rationale: value.rationale, remainingRisk: value.remainingRisk ?? null }; }
}
class ProducerDetails {
  constructor() { this.entities = new DetailGroups(() => []); this.applicable = new Set(); this.notRecorded = new Set(); }
  add(group, entity) {
    this.applicable.add(group);
    const existing = this.entities[group].find((entry) => entry.id === entity.id);
    if (existing) {
      if (JSON.stringify(canonicalJson(existing.toJSON())) !== JSON.stringify(canonicalJson(entity.toJSON()))) unavailable("AMBIGUOUS_REFERENCE", entity.id, "Producer finding identity is ambiguous");
      return existing;
    }
    this.entities[group].push(entity);
    return entity;
  }
}

/** Capture must hydrate this cataloged input before retrying the projection. */
export class QueryDetailArtifactRequired extends Error {
  constructor(descriptor) {
    super(`Detail projection requires captured artifact bytes: ${descriptor.relativePath}`);
    this.name = "QueryDetailArtifactRequired";
    this.descriptor = descriptor;
  }
}

/** Read-only detail resolution over exactly the bytes admitted by query capture. */
export class QueryDetailIndex {
  constructor({ state, activities, catalog, artifactBytes, snapshotId, flowVersionId = state.flowVersionId }) {
    Object.assign(this, { state, activities, catalog, artifactBytes, snapshotId, flowVersionId });
    this.resolver = new ReferenceResolver(catalog);
    this.details = new Map();
    this.entities = new DetailGroups(() => new Map());
    this.resolving = new Set();
  }
  source(descriptor, activity, entryId, observationId, pointer = "", format = "json") {
    return new DetailSource({ descriptor, activity, flowVersionId: this.flowVersionId, entryId, observationId, pointer, format });
  }
  producerStepId(activity) {
    // Fixed leaves retain their canonical node ID. Task leaves are translated
    // only through their saved membership; qualified display keys are not IDs.
    return TaskStepIdentity.fromStateNode(this.state, activity.nodeId)?.definitionId ?? activity.nodeId;
  }
  specReviewDescriptor(activity) {
    if (activity.reviewPublication == null) return null;
    const publicationPath = FLOW_ARTIFACT_CONTRACTS.resolve("spec.review", {
      revision: String(activity.reviewPublication.identity.revision).padStart(3, "0"),
    }).relativePath;
    const descriptor = this.resolver.resolve({ kind: "path", id: publicationPath },
      "Spec Review publication", { optional: true });
    return descriptor?.logicalKey === "spec.review" ? descriptor : null;
  }
  specReviewExecutionPhase(activity) {
    if (activity.result?.stepResult?.kind !== "spec-review-execution-required") return null;
    const result = activity.result instanceof NodeResult ? activity.result : new NodeResult(activity.result);
    const receipt = result.draftSettlementReceipt;
    const lifecycle = receipt.executionLifecycle;
    // These persisted execution selections reserve, claim, and publish the
    // work. Only the separate terminal Result owns the Review verdict.
    if (!(result.stepResult instanceof SpecReviewExecutionRequiredResult)
      || activity.transition.operation !== "record_draft_step_settlement"
      || receipt.settlementKind !== "execution" || lifecycle?.binding.kind !== "review"
      || !["checkpoint", "claimed", "publication"].includes(lifecycle.phase)
      || receipt.binding.runId !== this.state.runId || receipt.binding.specId !== this.state.specId
      || receipt.binding.stepId !== activity.nodeId
      || receipt.binding.attemptId !== activity.attemptId || receipt.binding.attemptSequence !== activity.sequence) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Review execution Activity does not match its saved lifecycle binding");
    }
    return lifecycle.phase;
  }
  read(descriptor) {
    if (!this.artifactBytes.has(descriptor.relativePath)) throw new QueryDetailArtifactRequired(descriptor);
    const bytes = this.artifactBytes.get(descriptor.relativePath);
    if (!Buffer.isBuffer(bytes)) throw new QueryError("CANONICAL_RECORD_UNREADABLE", "/canonical", "Captured detail artifact bytes are missing", { referenceId: descriptor.relativePath });
    try { return JSON.parse(bytes.toString("utf8")); }
    catch (cause) { throw new QueryError("CANONICAL_RECORD_INCONSISTENT", "/canonical", "Captured detail artifact is not JSON", { referenceId: descriptor.relativePath, cause }); }
  }
  forActivity(activity) {
    if (this.details.has(activity.id)) return this.details.get(activity.id);
    if (this.resolving.has(activity.id)) unavailable("AMBIGUOUS_REFERENCE", activity.id, "Cyclic unresolved producer references");
    this.resolving.add(activity.id);
    let projected;
    try { projected = this.project(activity); } catch (cause) {
      this.resolving.delete(activity.id);
      if (cause instanceof QueryError || cause instanceof QueryDetailArtifactRequired) throw cause;
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The recorded detail does not match its producer contract", cause);
    }
    const bindings = new DetailGroups(() => []);
    for (const group of GROUPS) {
      for (const entity of projected.entities[group]) {
        const previous = this.entities[group].get(entity.id);
        if (previous && JSON.stringify(previous.toJSON()) !== JSON.stringify(entity.toJSON())) unavailable("AMBIGUOUS_REFERENCE", entity.id, "A detail identity resolves to multiple observations");
        this.entities[group].set(entity.id, entity);
      }
      const seen = new Map();
      for (const reference of activity.references[group]) {
        if (seen.has(reference.id)) {
          if (seen.get(reference.id) !== reference.label) unavailable("AMBIGUOUS_REFERENCE", reference.id, "A detail reference has conflicting labels");
          continue;
        }
        seen.set(reference.id, reference.label);
        const ids = this.resolveReference(activity, reference, group, projected);
        for (const id of ids) if (!projected.entities[group].some((entity) => entity.id === id)) projected.entities[group].push(this.entities[group].get(id));
        projected.applicable.add(group);
        bindings[group].push(new DetailBinding(reference, ids));
      }
    }
    const details = new QueryActivityDetails({ entities: projected.entities, bindings, applicable: projected.applicable, notRecorded: projected.notRecorded });
    this.details.set(activity.id, details);
    this.resolving.delete(activity.id);
    return details;
  }
  resolveReference(activity, reference, group, projected) {
    const descriptors = reference.label === null ? [] : this.resolver.matchingDescriptors(reference, "Activity detail reference");
    if (descriptors.length > 1) unavailable("AMBIGUOUS_REFERENCE", reference.id, "A detail reference resolves to multiple artifacts");
    let candidates = projected.entities[group].filter((entity) => entity.source.sourceEntryId === reference.id
      || (group === "findings" && entity.identity.sourceFindingId === reference.id)
      || (group === "repairs" && entity.items.some((item) => item.matchesReference(reference.id)))
      || descriptors.some((descriptor) => descriptor.relativePath === entity.source.relativePath));
    if (group === "findings" && descriptors.length === 0
      && new Set(candidates.map((entity) => entity.identity.toString())).size > 1) {
      unavailable("AMBIGUOUS_REFERENCE", reference.id, "A finding reference does not determine a complete source identity");
    }
    if (candidates.length === 0 && descriptors.length === 1) {
      const producer = this.activities.find((entry) => entry.id === descriptors[0].activityId);
      if (producer && producer.id !== activity.id && producer.confirmationOrder <= activity.confirmationOrder) {
        this.forActivity(producer);
        candidates = [...this.entities[group].values()].filter((entity) => entity.source.producerActivityId === producer.id && entity.source.relativePath === descriptors[0].relativePath);
      }
    }
    if (candidates.length === 0 && group === "findings") {
      const mirrorDescriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "flow.findings");
      if (mirrorDescriptor) {
        const mirror = new FlowFindingsArtifact(this.read(mirrorDescriptor));
        const identities = mirror.entries.filter((entry) => entry.findingId === reference.id).map((entry) => entry.sourceIdentity());
        if (identities.length > 1) unavailable("AMBIGUOUS_REFERENCE", reference.id, "The finding mirror reference has multiple source identities");
        if (identities.length === 1) {
          const identity = identities[0];
          const sourceDescriptor = this.catalog.artifacts.find((entry) => entry.relativePath === identity.sourceArtifact);
          if (!sourceDescriptor) throw new QueryError("CANONICAL_RECORD_INCONSISTENT", "/canonical", "The referenced canonical finding source is missing", { referenceId: identity.sourceArtifact });
          const producer = this.activities.find((entry) => entry.id === sourceDescriptor.activityId);
          if (producer && producer.id !== activity.id && producer.confirmationOrder <= activity.confirmationOrder) this.forActivity(producer);
          candidates = [...this.entities.findings.values()].filter((entry) => entry.identity.equals(identity));
        }
      }
    }
    return candidates.map((entity) => entity.id);
  }
  closureFor(details) {
    const queue = (Array.isArray(details) ? details : [details]).flatMap((detail) => GROUPS.flatMap((group) => detail.detailRefs[group].map((id) => [group, id])));
    const result = new DetailGroups(() => []);
    const visited = new Set();
    while (queue.length) {
      const [group, id] = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const entity = this.entities[group].get(id);
      if (!entity) unavailable("REFERENCE_NOT_RESOLVED", id, "The detail dependency closure is incomplete");
      result[group].push(entity.toJSON());
      for (const [target, field] of [["evaluations", "evaluationIds"], ["findings", "findingIds"], ["repairs", "repairIds"]]) {
        for (const dependency of entity[field]) queue.push([target, dependency]);
      }
    }
    return result.toJSON();
  }
  project(activity) {
    const projected = new ProducerDetails();
    const producerStepId = this.producerStepId(activity);
    if (activity.transition.operation === "continue_nonblocking") return this.projectSkip(activity, projected);
    if (NON_DETAIL_OPERATIONS.has(activity.transition.operation)) return projected;
    const reviewExecutionPhase = this.specReviewExecutionPhase(activity);
    if (["checkpoint", "claimed"].includes(reviewExecutionPhase)) {
      if (activity.reviewPublication != null) unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "A Review execution claim cannot own a publication observation");
      return projected;
    }
    const taskGatePath = producerStepId === "task-gate" ? FLOW_ARTIFACT_CONTRACTS.resolve("task.gate", {
      taskId: TaskStepIdentity.fromStateNode(this.state, activity.nodeId).taskId,
    }).relativePath : null;
    const reviewDescriptor = this.specReviewDescriptor(activity);
    if (activity.reviewPublication != null && reviewDescriptor === null) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The recorded Spec Review publication is not retained");
    }
    // Repair can own both the old revision and its rebased destination. Only
    // the revision named by the saved publication describes this observation.
    const descriptors = this.catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "spec.review"
      ? descriptor === reviewDescriptor
      : descriptor.activityId === activity.id
      || ((GATE_KEYS.has(descriptor.logicalKey) || DRAFT_REVIEW_ROUTES.some((route) => route.reviewLogicalKey === descriptor.logicalKey))
        && descriptor.slot.publicationStep === producerStepId && activity.result !== null
        && (descriptor.logicalKey !== "task.gate" || descriptor.relativePath === taskGatePath)));
    let handled = false;
    for (const descriptor of descriptors) {
      if (descriptor.logicalKey === "spec.review" && activity.reviewPublication !== null) { this.projectSpecReview(activity, descriptor, projected); handled = true; }
      else if (DRAFT_REVIEW_ROUTES.some((route) => route.reviewLogicalKey === descriptor.logicalKey)) { this.projectDraftReview(activity, descriptor, projected); handled = true; }
      else if (GATE_KEYS.has(descriptor.logicalKey)) { this.projectGate(activity, descriptor, projected); handled = true; }
    }
    if (!handled && producerStepId === "spec-review" && activity.result !== null) {
      this.includeSpecReviewPublication(activity, projected);
      handled = true;
    }
    if (!handled && producerStepId === "task-impl" && activity.result?.stepResult?.kind === "task-impl-no-change") {
      this.projectTaskSourceNoChange(activity, projected);
      handled = true;
    }
    if (!handled && !NON_DETAIL_STEPS.has(producerStepId)
      && !NON_DETAIL_SOURCE_RESULTS.has(activity.result?.stepResult?.kind)) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "No supported retained detail producer exists for this Activity");
    }
    return projected;
  }
  projectTaskSourceNoChange(activity, projected) {
    const saved = activity.result.stepResult.evidence;
    const evidence = ImplementationSourceEvidence.fromJSON(saved);
    evidence.assertResultKind(activity.result.stepResult.kind);
    if (JSON.stringify(canonicalJson(evidence.toJSON())) !== JSON.stringify(canonicalJson(saved?.toJSON?.() ?? saved))
      || evidence.stepId !== "task-impl" || evidence.runId !== this.state.runId || evidence.specId !== this.state.specId
      || evidence.nodeId !== activity.nodeId || evidence.attemptId !== activity.attemptId || evidence.attemptSequence !== activity.sequence
      || evidence.qualityIssueCount !== 0 || evidence.mutationCount !== 0 || evidence.appliedFindingKeys.length !== 0) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The saved source evidence does not prove an empty implementation observation");
    }
    const settlements = this.catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "source.handoff.settlement" && descriptor.activityId === activity.id);
    if (settlements.length !== 1) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The source confirmation requires its retained accepted settlement");
    const settlement = SourceHandoffSettlement.fromStored(this.read(settlements[0]));
    const identity = settlement.identity;
    if (settlement.kind !== "accepted" || settlement.handoffDigest !== evidence.handoffDigest
      || identity.runId !== evidence.runId || identity.specId !== evidence.specId || identity.stepId !== evidence.stepId
      || identity.nodeId !== evidence.nodeId || identity.attempt.id !== evidence.attemptId || identity.attempt.sequence !== evidence.attemptSequence) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The source settlement does not bind this recorded implementation evidence");
    }
    // confirmSourceWorkerHandoff publishes an immutable outcome in the same
    // transaction whenever SourceWorkerEffect.gateRepair is non-null. Its
    // absence in this complete catalog proves this confirmation had no repair;
    // an empty reference list alone is never that proof.
    if (this.catalog.artifacts.some((descriptor) => descriptor.logicalKey === "plan.gate.repair.outcome" && descriptor.activityId === activity.id)) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "Source Gate repair details require a supported public repair variant");
    }
    projected.applicable.add("findings");
  }
  includeSpecReviewPublication(activity, projected) {
    const referenced = (activity.result.artifactRefs ?? []).flatMap((reference) => this.resolver.matchingDescriptors(reference, "Spec Review result reference"))
      .filter((descriptor) => descriptor.logicalKey === "spec.review");
    const candidates = this.activities.filter((entry) => entry.id !== activity.id && entry.nodeId === activity.nodeId
      && entry.attemptId !== null && entry.attemptId === activity.attemptId && entry.sequence === activity.sequence
      && entry.confirmationOrder < activity.confirmationOrder && entry.reviewPublication?.stage === "spec-review")
      .filter((entry) => {
        const descriptor = this.specReviewDescriptor(entry);
        return descriptor?.activityId === entry.id && (referenced.length === 0 || referenced.includes(descriptor));
      });
    if (candidates.length !== 1) unavailable(candidates.length === 0 ? "SOURCE_GENERATION_NOT_RETAINED" : "AMBIGUOUS_REFERENCE",
      activity.id, "Spec Review confirmation does not resolve to one retained publication in its exact Attempt");
    // The producer resolver checks the catalog binding, generation, identity,
    // digest and bytes. A lifecycle 'passed' result never supplies a verdict.
    const details = this.forActivity(candidates[0]);
    for (const group of GROUPS) {
      for (const id of details.detailRefs[group]) projected.add(group, this.entities[group].get(id));
      const coverage = details.detailCoverage[group].availability;
      if (coverage === "available") projected.applicable.add(group);
      else if (coverage === "not-recorded") projected.notRecorded.add(group);
    }
    const publication = candidates[0];
    const descriptor = this.specReviewDescriptor(publication);
    this.projectSpecReviewVerdict(activity, descriptor, publication, projected);
  }
  projectSpecReviewVerdict(activity, descriptor, publication, projected) {
    const verdict = activity.result?.stepResult?.kind;
    if (!SPEC_REVIEW_VERDICTS.has(verdict)) {
      const executionPublication = activity.id === publication.id
        && publication.reviewPublication?.stage === "spec-review"
        && this.specReviewExecutionPhase(activity) === "publication";
      if (!executionPublication && this.producerStepId(activity) === "spec-review") projected.notRecorded.add("evaluations");
      return;
    }
    const evaluation = projected.add("evaluations", new EvaluationDetail({ source: this.ledgerSource(activity),
      flowVersionId: this.flowVersionId, nativeCode: verdict, summary: activity.result.summary ?? null }));
    const observationId = `generation:${publication.reviewPublication.generation}`;
    evaluation.supportingSources.push(this.source(descriptor, publication, observationId, observationId));
    projected.notRecorded.delete("evaluations");
    // A separate terminal observation references the earlier findings without
    // rewriting them. Their JSON and closure must not depend on page order.
    if (activity.id === publication.id) this.linkEvaluation(evaluation, projected.entities.findings);
    else evaluation.findingIds = projected.entities.findings.map((finding) => finding.id);
  }
  projectSpecReview(activity, descriptor, projected) {
    const document = this.read(descriptor);
    let review;
    for (const finding of document.findings ?? []) {
      if (finding.disposition !== undefined && !["apply", "invalid", "already_resolved", "downgraded_to_non_blocking"].includes(finding.disposition)) {
        unavailable("STATUS_NOT_SUPPORTED", finding.findingId, "The stored Spec Review disposition is unsupported");
      }
    }
    try { review = new CanonicalSpecReview(document); }
    catch (cause) { unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "Canonical Spec Review detail cannot be interpreted", cause); }
    if (!activity.reviewPublication || descriptor.activityId !== activity.id
      || activity.reviewPublication.generation !== review.generation || activity.reviewPublication.reviewDigest !== review.digest) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Spec Review generation for this Activity is not retained");
    }
    (activity.reviewPublication instanceof ActivityReviewPublication ? activity.reviewPublication : new ActivityReviewPublication(activity.reviewPublication)).assertReview(review, { specId: this.state.specId,
      revision: review.identity.revision.value, bytes: this.artifactBytes.get(descriptor.relativePath) });
    const observationId = `generation:${review.generation}`;
    const observations = canonicalSourceFindingObservations({ artifact: document, sourceStep: "spec-review", sourceArtifact: descriptor.relativePath });
    projected.applicable.add("findings");
    for (const observation of observations) {
      if (!findSourceFinding(document, observation.identity)) unavailable("REFERENCE_NOT_RESOLVED", observation.identity.sourceFindingId, "Exact finding identity is unresolved");
      requireRetainedText(observation.finding, observation.identity.sourceFindingId);
      const source = this.source(descriptor, activity, observation.identity.sourceFindingId, observationId, observation.jsonPointer);
      projected.add("findings", new FindingDetail({ source, flowVersionId: this.flowVersionId, observation }));
    }
    this.projectSpecReviewVerdict(activity, descriptor, activity, projected);
    if (this.producerStepId(activity) === "spec-repair") this.projectRepairAudit(activity, descriptor, review, projected);
  }
  payload(activity, descriptor) {
    const document = this.read(descriptor);
    if (Array.isArray(document.attempts)) {
      const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: descriptor.logicalKey, bytes: this.artifactBytes.get(descriptor.relativePath) });
      const index = history.attempts.findIndex((entry) => entry.attempt === activity.sequence);
      if (index < 0) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The producer Attempt payload is not retained");
      return new ProducerPayload(history.attempts[index].payload, `/attempts/${index}/artifact/payload`, `attempt:${activity.attemptId}`);
    }
    if (descriptor.activityId !== activity.id) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The producer Activity payload is not retained");
    return new ProducerPayload(document, "", `activity:${activity.id}`);
  }
  projectDraftReview(activity, descriptor, projected) {
    const record = this.payload(activity, descriptor);
    const value = record.value;
    exactFields(value, ["version", "phase", "sourceDraft", "sourceDraftRevision", "generatedAt", "verdict", "summary", "blockingFindings", "advisoryFindings", "repairTargets"], activity.id);
    requireRetainedText(value, activity.id);
    for (const field of ["blockingFindings", "advisoryFindings", "repairTargets"]) for (const finding of value[field] ?? []) {
      exactFields(finding, ["title", "target", "rationale", "evidence", "classification"], activity.id);
    }
    const review = DraftReviewArtifactDocument.fromStored(value);
    // fromStored normalizes producer inputs; public history must retain bytes,
    // never silently add defaults or shorten a previously stored value.
    assertRecordedProducerValue(value, review, activity.id);
    const source = this.source(descriptor, activity, descriptor.logicalKey, record.observationId, record.pointer);
    const evaluation = projected.add("evaluations", new EvaluationDetail({ source, flowVersionId: this.flowVersionId, nativeCode: value.verdict, summary: value.summary }));
    projected.applicable.add("findings");
    for (const observation of canonicalSourceFindingObservations({ artifact: value, sourceStep: this.producerStepId(activity), sourceArtifact: descriptor.relativePath })) {
      const findingSource = this.source(descriptor, activity, observation.identity.sourceFindingId, record.observationId, record.pointer + observation.jsonPointer);
      projected.add("findings", new FindingDetail({ source: findingSource, flowVersionId: this.flowVersionId, observation, draft: true }));
    }
    this.linkEvaluation(evaluation, projected.entities.findings);
  }
  projectGate(activity, descriptor, projected) {
    const record = this.payload(activity, descriptor);
    const value = record.value;
    exactFields(value, ["result", "changed", "artifacts", "summary", "reason"], activity.id);
    const payload = value.artifacts;
    exactFields(payload, ["target", "level", "phase", "evaluations", "nextAction", "reasons", "issues", "failureKind", "failureCode",
      "gateTransitionAttemptId", "gateTransitionAttemptSequence", "gateTransitionLineage", "taskId", "sourceFingerprint",
      "gateTransitionFailureCategory", "evaluationScope", "responseProtocolEvidence", "warnings"], activity.id);
    if (!payload || !Array.isArray(payload.evaluations)) unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Gate producer has no supported recorded evaluation payload");
    this.assertGateBinding(activity, descriptor, payload);
    if (payload.gateTransitionFailureCategory !== undefined && value.result !== "fail") {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "A Gate failure category requires a recorded failure");
    }
    if (payload.responseProtocolEvidence !== undefined) {
      // Execution protocol evidence is internal; validate its known contract
      // without exposing attempts, errors, or raw provider diagnostics.
      assertRecordedProducerValue(payload.responseProtocolEvidence,
        AgentResponseProtocolEvidence.from(payload.responseProtocolEvidence), activity.id);
    }
    requireRetainedText(value, activity.id);
    let nextAction = null;
    if (payload.nextAction !== undefined) {
      exactFields(payload.nextAction, ["diagnosis", "prescription"], activity.id);
      exactFields(payload.nextAction.diagnosis, ["summary", "observations"], activity.id);
      const recorded = NextAction.fromJSON(payload.nextAction);
      assertRecordedProducerValue(payload.nextAction, recorded, activity.id);
      nextAction = recorded;
    }
    // Gate observations/diagnosis have no finding variant in the public schema.
    if ((payload.observations?.length ?? 0) || (payload.nextAction?.diagnosis?.observations?.length ?? 0)) unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "Gate finding semantics have no declared public detail variant");
    const source = this.source(descriptor, activity, descriptor.logicalKey, record.observationId, record.pointer);
    projected.add("evaluations", new EvaluationDetail({ source, flowVersionId: this.flowVersionId, nativeCode: value.result,
      summary: value.summary ?? null, explanation: value.reason ?? null,
      specific: new GateEvaluationSpecific(payload, nextAction, activity.id),
      criteria: payload.evaluations.map((entry) => new EvaluationCriterion(entry, activity.id)) }));
    projected.applicable.add("findings");
  }
  assertGateBinding(activity, descriptor, payload) {
    const taskIdentity = TaskStepIdentity.fromStateNode(this.state, activity.nodeId);
    const taskId = taskIdentity?.taskId ?? null;
    if ((payload.taskId ?? null) !== taskId
      || (taskId !== null && typeof payload.sourceFingerprint !== "string")) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate payload belongs to a different Task scope");
    }
    if (payload.phase !== undefined) {
      const keys = canonicalGateLogicalKeys(payload.phase, taskId);
      if (canonicalGateNodeId({ phase: payload.phase, taskId }) !== activity.nodeId
        || keys.result !== descriptor.logicalKey
        || FLOW_ARTIFACT_CONTRACTS.resolve(keys.result, keys.parameters).relativePath !== descriptor.relativePath) {
        unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate payload does not bind its producer scope");
      }
    }
    if (["gateTransitionAttemptId", "gateTransitionAttemptSequence", "gateTransitionLineage"].some((field) => Object.hasOwn(payload, field))) {
      const attempt = new GateAttemptIdentity({ id: activity.attemptId, sequence: activity.sequence });
      const recorded = new GateAttemptIdentity({ id: payload.gateTransitionAttemptId, sequence: payload.gateTransitionAttemptSequence });
      if (!attempt.matches(recorded) || payload.gateTransitionLineage !== canonicalGateRevision({
        runId: this.state.runId, specId: this.state.specId, attempt: { ...attempt.toJSON(), nodeId: activity.nodeId },
      }, activity.nodeId)) {
        unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate payload does not bind the exact producer Attempt");
      }
    }
  }
  ledgerSource(activity) {
    const descriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "flow.activities");
    if (!descriptor) throw new QueryError("CANONICAL_RECORD_INCONSISTENT", "/canonical", "The confirmed Activity ledger is not cataloged");
    return this.source(descriptor, activity, activity.id, activity.id, null, "jsonl");
  }
  projectSkip(activity, projected) {
    const decision = activity.transition.nonblocking;
    if (decision?.action !== "continue") unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "Only recorded lifecycle continuation has a public skip variant");
    const source = this.ledgerSource(activity);
    const items = activity.references.repairs.map((reference) => new RepairItem({ id: reference.id, target: { entity: "node", id: reference.id },
      operationKind: "skip", status: new DetailStatus("skipped", "continue_nonblocking"), reason: decision.rationale }));
    projected.add("repairs", new RepairDetail({ source, flowVersionId: this.flowVersionId, items,
      nativeValue: "continue_nonblocking", skipped: new LifecycleSkipSpecific(decision) }));
    return projected;
  }
  projectRepairAudit(activity, descriptor, review, projected) {
    const audit = review.audit.at(-1);
    // assertReview already binds the descriptor-owned generation, exact bytes
    // and final audit. The producer's optional audit Activity is supplemental.
    if (audit.stage !== "spec-repair" || (audit.activityId !== undefined && audit.activityId !== activity.id)) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The repair audit is not bound to this Activity");
    const source = this.source(descriptor, activity, activity.id, `generation:${review.generation}`, `/audit/${review.audit.length - 1}`);
    const accepted = new SpecRepairOperationBatch({ version: 2, stage: "spec-repair", identity: review.identity.toJSON(),
      baseReviewDigest: audit.inputDigest, findings: [], operations: audit.acceptedOperations });
    if (accepted.discardedOperations.length) unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "An accepted repair operation has unsupported semantics");
    const items = [];
    for (const [collection, operations, status] of [
      ["acceptedOperations", accepted.operations.map((operation) => operation.toJSON()), "applied"],
      ["discardedOperations", audit.discardedOperations, "discarded"],
    ]) {
      for (const [position, operation] of operations.entries()) {
        exactFields(operation, ["kind", "target", "findingIds", "replacement", "edits", "expectedDigest", "reason", "operationDigest", "findingId", "attempt"], activity.id);
        // applySpecRepairOperations records the worker batch attempt on
        // discarded audit entries; it is not the enclosing Flow Attempt.
        if (operation.attempt !== undefined && (!Number.isSafeInteger(operation.attempt) || operation.attempt < 1)) {
          unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The repair audit worker attempt is invalid");
        }
        const target = RepairItemTarget.fromOperation(operation);
        const findingIds = operation.findingIds ?? (operation.findingId == null ? [] : [operation.findingId]);
        const findings = findingIds.map((id) => {
          const matches = projected.entities.findings.filter((finding) => finding.identity.sourceFindingId === id);
          if (matches.length !== 1) unavailable("AMBIGUOUS_REFERENCE", id, "Repair finding identity cannot be resolved from its retained generation");
          return matches[0].id;
        });
        // This pointer addresses the exact audit bytes already bound to the
        // saved publication generation. It never uses a current array to
        // reconstruct an unretained observation. Repeated proposals retain
        // distinct items even when the producer stored the same digest.
        const id = `repair-item:${canonicalDigest({ flowVersionId: this.flowVersionId,
          producerActivityId: source.producerActivityId, observationId: source.observationId,
          jsonPointer: `${source.jsonPointer}/${collection}/${position}` })}`;
        items.push(new RepairItem({ id, referenceId: operation.operationDigest ?? specRepairProposalDigest(operation), target,
          operationKind: operation.kind ?? null, status: new DetailStatus(status, status), reason: operation.reason ?? null, findingIds: findings }));
      }
    }
    const repair = projected.add("repairs", new RepairDetail({ source, flowVersionId: this.flowVersionId, items, nativeValue: audit.outcome }));
    repair.findingIds = [...new Set(items.flatMap((item) => item.findingIds))];
  }
  linkEvaluation(evaluation, findings) {
    evaluation.findingIds = findings.map((finding) => finding.id);
    for (const finding of findings) finding.evaluationIds.push(evaluation.id);
  }
}
class ProducerPayload {
  constructor(value, pointer, observationId) { Object.assign(this, { value, pointer, observationId }); Object.freeze(this); }
}

function publicRepairTarget(value) {
  const target = SpecRepairTarget.fromJSON(value, "detail repair target").toJSON();
  return Object.hasOwn(target, "collection") ? { ...target, position: target.position ?? null } : target;
}
