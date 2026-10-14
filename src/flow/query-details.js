import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactSpecReviewActivityEvidenceDocument } from "../lib/flow-artifact-contract.js";
import { QueryError, canonicalJson, canonicalDigest, publicArtifactId, publicArtifactKey, ReferenceResolver } from "./query-values.js";
import { CanonicalSpecReview } from "./lib/spec-review-artifacts.js";
import { CanonicalDraftReviewObservation } from "./lib/canonical-review-artifacts.js";
import { DraftReviewArtifactDocument } from "./lib/draft-review-artifacts.js";
import { DRAFT_REVIEW_ROUTES } from "./lib/draft-review-routes.js";
import { CanonicalCommandAttemptArtifactHistory } from "./lib/canonical-command-result.js";
import { SpecRepairTarget, SpecRepairOperationBatch, specRepairProposalDigest } from "./lib/spec-repair-operations.js";
import { FlowActivity, NodeResult } from "./lib/current-flow-state.js";
import { SpecReviewExecutionRequiredResult, DraftQuestionsReviewExecutionRequiredResult,
  DraftCoverageReviewExecutionRequiredResult, DraftQuestionsReviewPassedResult,
  DraftQuestionsReviewFindingsResult, DraftCoverageReviewPassedResult,
  DraftCoverageReviewFindingsResult, SpecReviewPassedResult, SpecReviewAdvisoryResult,
  SpecReviewRejectedResult, SpecGateRepairContextRequiredResult, SpecGateRepairReadyForGateResult,
  SpecGateRepairReviewRequiredResult, stepResultDigest } from "./engine/step-result.js";
import { DraftStepExecutionLifecycle, DraftReviewExecutionBinding, DraftWorkerExecutionBinding, DraftStepSettlementReceipt } from "./definition.js";
import { ReviewWorkUnitTarget } from "./lib/review-work-unit-values.js";
import { draftQuestionsReviewResult, draftCoverageReviewResult } from "./steps/draft/draft-review-result.js";
import { specReviewResult } from "./steps/spec/spec-review-result.js";
import { StepConnectionReceipt } from "./lib/draft-completion-connector.js";
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
import { DRAFT_STEP_ERROR_RECOVERY_OPERATION } from "./lib/draft-worker-recovery.js";
import { validateRecordedGateObservation, canonicalGateFindingObservations, GateFindingSpecific } from "./query-gate-details.js";
import { QuerySpecGateRepairObservation } from "./query-spec-gate-repair-details.js";
import { RecordedRepairChange } from "./query-repair-change.js";
import { PlanGateRepairRecord } from "./lib/plan-gate-repair.js";
import { IssueLogDocument } from "./lib/issue-log-store.js";
import { FlowExecutionContract } from "./lib/flow-execution-contract.js";
import { readExecutionContractFromView } from "./lib/canonical-prompt-execution.js";

const GROUPS = Object.freeze(["evaluations", "findings", "repairs"]);
const GATE_KEYS = new Set(["draft.gate", "spec.gate", "task.gate", "impl.gate"]);
const SPEC_REVIEW_VERDICTS = new Set(["spec-review-passed", "spec-review-advisory", "spec-review-rejected"]);
const REVIEW_EXECUTION_RESULTS = Object.freeze([SpecReviewExecutionRequiredResult,
  DraftQuestionsReviewExecutionRequiredResult, DraftCoverageReviewExecutionRequiredResult]);
const DRAFT_REVIEW_TERMINAL_RESULTS = Object.freeze([DraftQuestionsReviewPassedResult,
  DraftQuestionsReviewFindingsResult, DraftCoverageReviewPassedResult, DraftCoverageReviewFindingsResult]);
const SPEC_REVIEW_TERMINAL_RESULTS = Object.freeze([SpecReviewPassedResult, SpecReviewAdvisoryResult, SpecReviewRejectedResult]);
// These ledger operations record lifecycle/administrative facts and cannot
// produce review, evaluation, or repair observations.
const NON_DETAIL_OPERATIONS = new Set([
  DRAFT_STEP_ERROR_RECOVERY_OPERATION,
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
    if (value.observations !== undefined) {
      if (!Array.isArray(value.observations)) unavailable("PRODUCER_NOT_SUPPORTED", referenceId, "Gate observations must be a recorded array");
      for (const observation of value.observations) validateRecordedGateObservation(observation);
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
class GateFindingDetail extends FindingDetail {
  constructor(input) {
    super(input);
    this.specific = new GateFindingSpecific(this.finding);
  }
  toJSON() {
    const value = this.finding;
    return { ...super.toJSON(), title: value.requirementRef, description: value.observed, observed: value.observed,
      severity: value.severity, reason: value.failureMode, recommendation: null, evidence: null };
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
  constructor({ id, referenceId = id, target, operationKind, status, reason = null, findingIds = [], change = null }) {
    if (change !== null && !(change instanceof RecordedRepairChange)) throw new TypeError("Repair item requires its typed recorded change");
    Object.assign(this, { id, referenceId, target: target instanceof RepairItemTarget ? target : new RepairItemTarget(target), operationKind, status, reason, findingIds, change });
  }
  matchesReference(id) { return this.id === id || this.referenceId === id; }
  static idFor(source, flowVersionId, jsonPointer) {
    return `repair-item:${canonicalDigest({ flowVersionId, producerActivityId: source.producerActivityId,
      observationId: source.observationId, jsonPointer })}`;
  }
  toJSON() { return { id: this.id, target: this.target.toJSON(), operationKind: this.operationKind,
    status: this.status.toJSON(), adoptedReason: this.status.value === "discarded" ? null : this.reason,
    discardedReason: this.status.value === "discarded" ? this.reason : null, evidence: [], findingIds: [...this.findingIds],
    change: this.change?.toJSON() ?? null }; }
}
class RepairStatus extends DetailStatus {
  constructor(items, nativeValue, skipped) {
    let value;
    if (skipped !== null && nativeValue === "continue_nonblocking") value = "skipped";
    else if (nativeValue === "plan_gate_repair" && items.length === 0) value = "planned";
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
  matchesReference(id) { return this.id === id || this.items.some((item) => item.matchesReference(id)); }
  toJSON() { return { ...this.commonJSON(), title: null, description: null, reason: this.skipped?.rationale ?? null,
    status: this.status.toJSON(),
    currentState: null, items: this.items.map((item) => item.toJSON()), specific: this.skipped === null ? null : this.skipped.toJSON() }; }
}
class PlannedGateRepairDetail extends RepairDetail {
  constructor({ source, flowVersionId, record, reason }) {
    super({ source, flowVersionId, items: [], nativeValue: "plan_gate_repair" });
    this.record = record;
    this.reason = reason;
  }
  matchesReference(id) { return id === this.record.idempotencyKey || super.matchesReference(id); }
  toJSON() { return { ...super.toJSON(), reason: this.reason }; }
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
    this.activities = activities.map((activity) => FlowActivity.canonical(activity));
    this.resolver = new ReferenceResolver(catalog);
    this.details = new Map();
    this.entities = new DetailGroups(() => new Map());
    this.resolving = new Set();
    this.histories = new Map();
    this.draftReviews = new Map();
    this.specReviews = new Map();
  }
  source(descriptor, activity, entryId, observationId, pointer = "", format = "json") {
    return new DetailSource({ descriptor, activity, flowVersionId: this.flowVersionId, entryId, observationId, pointer, format });
  }
  producerStepId(activity) {
    // Fixed leaves retain their canonical node ID. Task leaves are translated
    // only through their saved membership; qualified display keys are not IDs.
    return TaskStepIdentity.fromStateNode(this.state, activity.nodeId)?.definitionId ?? activity.nodeId;
  }
  specReviewSource(activity) {
    if (activity.reviewPublication == null) return null;
    if (this.specReviews.has(activity.id)) return this.specReviews.get(activity.id);
    if (activity.result?.stepResult != null) this.stepSettlementReceipt(activity);
    const publicationPath = FLOW_ARTIFACT_CONTRACTS.resolve("spec.review", {
      revision: String(activity.reviewPublication.identity.revision).padStart(3, "0"),
    }).relativePath;
    const retained = this.catalog.artifacts.filter((entry) => entry.logicalKey === "activity.evidence"
      && entry.activityId === activity.id).map((descriptor) => {
        const document = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence").contentContract.assertCatalogAssociation({
          bytes: this.readCatalogedArtifact(descriptor), descriptor, activity });
        if (!(document instanceof FlowArtifactSpecReviewActivityEvidenceDocument)) return null;
        document.assertActivity(activity, { specId: this.state.specId });
        if (document.source.path !== publicationPath) {
          unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The retained Spec Review names a different canonical revision");
        }
        return new RetainedSpecReviewSource({ descriptor, review: document.review,
          sourceArtifact: publicationPath, pointer: "/review" });
      }).filter((entry) => entry !== null);
    if (retained.length > 1) unavailable("AMBIGUOUS_REFERENCE", activity.id, "The Spec Review has multiple retained Activity observations");
    if (retained.length === 1) {
      this.specReviews.set(activity.id, retained[0]);
      return retained[0];
    }
    const descriptor = this.resolver.resolve({ kind: "path", id: publicationPath },
      "Spec Review publication", { optional: true });
    if (descriptor?.logicalKey !== "spec.review") return null;
    if (descriptor.activityId !== activity.id) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id,
      "The Spec Review generation for this Activity is not retained");
    const review = new CanonicalSpecReview(this.read(descriptor));
    if (activity.reviewPublication.generation !== review.generation
      || activity.reviewPublication.reviewDigest !== review.digest) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id,
      "The Spec Review generation for this Activity is not retained");
    activity.reviewPublication.assertReview(review, { specId: this.state.specId,
      revision: review.identity.revision.value, bytes: this.readCatalogedArtifact(descriptor) });
    const source = new RetainedSpecReviewSource({ descriptor, review, sourceArtifact: publicationPath, pointer: "" });
    this.specReviews.set(activity.id, source);
    return source;
  }
  reviewLifecycle(activity) {
    const stepResult = activity.result?.stepResult;
    const execution = REVIEW_EXECUTION_RESULTS.some((Result) => stepResult instanceof Result);
    const terminal = [...DRAFT_REVIEW_TERMINAL_RESULTS, ...SPEC_REVIEW_TERMINAL_RESULTS]
      .some((Result) => stepResult instanceof Result);
    if (!execution && !terminal) return null;
    const receipt = activity.result.draftSettlementReceipt;
    const lifecycle = this.stepExecutionLifecycle(activity);
    if (activity.transition.operation === "complete_draft_completion") {
      const connection = StepConnectionReceipt.fromJSON(activity.transition.stepConnectionReceipt?.toJSON?.()
        ?? activity.transition.stepConnectionReceipt);
      if (!(stepResult instanceof DraftCoverageReviewPassedResult) || connection.source !== "coverage-pass"
        || connection.sourceStepId !== activity.nodeId || connection.sourceAttempt.id !== activity.attemptId
        || connection.sourceAttempt.sequence !== activity.sequence) {
        unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Draft Review completion connector does not bind its source Review");
      }
    }
    if (!(lifecycle.binding instanceof DraftReviewExecutionBinding)
      || (execution ? activity.transition.operation !== "record_draft_step_settlement"
        || receipt.settlementKind !== "execution" || !["checkpoint", "claimed", "publication"].includes(lifecycle.phase)
        : !["confirm_attempt", "complete_draft_completion"].includes(activity.transition.operation)
          || receipt.settlementKind === "execution" || lifecycle.phase !== "terminal")) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Review execution Activity does not match its saved lifecycle binding");
    }
    return lifecycle;
  }
  stepSettlementReceipt(activity) {
    const result = activity.result instanceof NodeResult ? activity.result : new NodeResult(activity.result);
    return DraftStepSettlementReceipt.assertStored(result.draftSettlementReceipt, { result: result.stepResult,
      binding: { runId: this.state.runId, specId: this.state.specId, stepId: activity.nodeId,
        attempt: { id: activity.attemptId, sequence: activity.sequence } } });
  }
  stepExecutionLifecycle(activity) {
    const receipt = this.stepSettlementReceipt(activity);
    return DraftStepExecutionLifecycle.fromJSON(receipt.executionLifecycle?.toJSON?.() ?? receipt.executionLifecycle);
  }
  read(descriptor) {
    const bytes = this.readCatalogedArtifact(descriptor);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch (cause) { throw new QueryError("CANONICAL_RECORD_INCONSISTENT", "/canonical", "Captured detail artifact is not JSON", { referenceId: descriptor.relativePath, cause }); }
  }
  readCatalogedArtifact(descriptor) {
    if (!this.artifactBytes.has(descriptor.relativePath)) throw new QueryDetailArtifactRequired(descriptor);
    const bytes = this.artifactBytes.get(descriptor.relativePath);
    if (!Buffer.isBuffer(bytes)) throw new QueryError("CANONICAL_RECORD_UNREADABLE", "/canonical", "Captured detail artifact bytes are missing", { referenceId: descriptor.relativePath });
    return bytes;
  }
  forActivity(activity) {
    activity = FlowActivity.canonical(activity);
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
      || (group === "repairs" && entity.matchesReference(reference.id))
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
    if (this.projectExecutionClaim(activity, projected) !== null) return projected;
    if (producerStepId === "spec-gate-repair") return this.projectSpecGateRepair(activity, projected);
    const reviewLifecycle = this.reviewLifecycle(activity);
    if (["checkpoint", "claimed"].includes(reviewLifecycle?.phase)) {
      if (activity.reviewPublication != null || GROUPS.some((group) => activity.references[group].length !== 0)) {
        unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "A Review execution claim cannot own a detail observation");
      }
      return projected;
    }
    const draftRoute = DRAFT_REVIEW_ROUTES.find((route) => route.reviewStepId === producerStepId);
    if (draftRoute && reviewLifecycle !== null) return this.projectCanonicalDraftReview(activity, draftRoute, reviewLifecycle, projected);
    if (draftRoute && activity.result?.stepResult != null) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Draft Review has no supported saved execution or terminal Result");
    }
    const taskGatePath = producerStepId === "task-gate" ? FLOW_ARTIFACT_CONTRACTS.resolve("task.gate", {
      taskId: TaskStepIdentity.fromStateNode(this.state, activity.nodeId).taskId,
    }).relativePath : null;
    const reviewSource = this.specReviewSource(activity);
    if (activity.reviewPublication != null && reviewSource === null) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The recorded Spec Review publication is not retained");
    }
    // Repair can own both the old revision and its rebased destination. Only
    // the revision named by the saved publication describes this observation.
    const descriptors = this.catalog.artifacts.filter((descriptor) => descriptor.logicalKey !== "spec.review"
      && (descriptor.activityId === activity.id
      || ((GATE_KEYS.has(descriptor.logicalKey) || DRAFT_REVIEW_ROUTES.some((route) => route.reviewLogicalKey === descriptor.logicalKey))
        && descriptor.slot.publicationStep === producerStepId && activity.result !== null
        && (descriptor.logicalKey !== "task.gate" || descriptor.relativePath === taskGatePath))));
    let handled = false;
    if (reviewSource !== null) { this.projectSpecReview(activity, reviewSource, projected); handled = true; }
    for (const descriptor of descriptors) {
      if (DRAFT_REVIEW_ROUTES.some((route) => route.reviewLogicalKey === descriptor.logicalKey)) { this.projectDraftReview(activity, descriptor, projected); handled = true; }
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
  projectExecutionClaim(activity, projected) {
    if (activity.transition.operation !== "publish_artifacts") return null;
    const publications = this.catalog.artifacts.filter((descriptor) => descriptor.activityId === activity.id
      && !["flow.state", "flow.activities"].includes(descriptor.logicalKey));
    if (publications.length !== 1 || publications[0].logicalKey !== "execution.contract") return null;
    if (activity.result !== null
      || activity.reviewPublication !== null || GROUPS.some((group) => activity.references[group].length !== 0)) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "An execution contract claim cannot own a detail observation");
    }
    const document = this.read(publications[0]);
    exactFields(document, ["id", "contract"], activity.id);
    const contract = FlowExecutionContract.fromJSON(document.contract);
    const task = TaskStepIdentity.fromStateNode(this.state, activity.nodeId);
    if (contract.runId !== this.state.runId || contract.specId !== this.state.specId
      || contract.stepId !== this.producerStepId(activity) || contract.taskId !== (task?.taskId ?? null)
      || FLOW_ARTIFACT_CONTRACTS.resolve("execution.contract", contract.parameters).relativePath !== publications[0].relativePath) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The execution contract claim does not bind the selected Flow and Step");
    }
    // Historical claims use the captured catalog and bytes, without checking
    // today's runtime or the inputs that subsequent publications have advanced.
    readExecutionContractFromView(this, contract, { current: false });
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
    const lifecycle = this.reviewLifecycle(activity);
    const candidates = this.activities.filter((entry) => entry.id !== activity.id && entry.nodeId === activity.nodeId
      && entry.attemptId !== null && entry.attemptId === activity.attemptId && entry.sequence === activity.sequence
      && entry.confirmationOrder < activity.confirmationOrder && entry.reviewPublication?.stage === "spec-review")
      .filter((entry) => {
        if (lifecycle !== null) {
          const publication = this.reviewLifecycle(entry);
          if (publication?.phase !== "publication" || !publication.terminal().equals(lifecycle)) return false;
        }
        const source = this.specReviewSource(entry);
        return source?.descriptor.activityId === entry.id
          && (referenced.length === 0 || referenced.some((descriptor) => descriptor.relativePath === source.sourceArtifact));
      });
    if (candidates.length !== 1) unavailable(candidates.length === 0 ? "SOURCE_GENERATION_NOT_RETAINED" : "AMBIGUOUS_REFERENCE",
      activity.id, "Spec Review confirmation does not resolve to one retained publication in its exact Attempt");
    // The producer resolver checks the catalog binding, generation, identity,
    // digest and bytes. A lifecycle 'passed' result never supplies a verdict.
    this.includeActivityDetails(candidates[0], projected);
    const publication = candidates[0];
    const source = this.specReviewSource(publication);
    this.projectSpecReviewVerdict(activity, source, publication, projected);
  }
  includeActivityDetails(activity, projected) {
    const details = this.forActivity(activity);
    for (const group of GROUPS) {
      for (const id of details.detailRefs[group]) projected.add(group, this.entities[group].get(id));
      const coverage = details.detailCoverage[group].availability;
      if (coverage === "available") projected.applicable.add(group);
      else if (coverage === "not-recorded") projected.notRecorded.add(group);
    }
    return details;
  }
  projectSpecReviewVerdict(activity, retained, publication, projected) {
    const verdict = activity.result?.stepResult?.kind;
    if (!SPEC_REVIEW_VERDICTS.has(verdict)) {
      const executionPublication = activity.id === publication.id
        && publication.reviewPublication?.stage === "spec-review"
        && this.reviewLifecycle(activity)?.phase === "publication";
      if (!executionPublication && this.producerStepId(activity) === "spec-review") projected.notRecorded.add("evaluations");
      return;
    }
    if (stepResultDigest(activity.result.stepResult) !== stepResultDigest(specReviewResult(retained.review))) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Spec Review terminal Result does not match its recorded publication");
    }
    const evaluation = projected.add("evaluations", new EvaluationDetail({ source: this.ledgerSource(activity),
      flowVersionId: this.flowVersionId, nativeCode: verdict, summary: activity.result.summary ?? null }));
    const observationId = `generation:${publication.reviewPublication.generation}`;
    evaluation.supportingSources.push(this.source(retained.descriptor, publication, observationId, observationId, retained.pointer));
    projected.notRecorded.delete("evaluations");
    // A separate terminal observation references the earlier findings without
    // rewriting them. Their JSON and closure must not depend on page order.
    if (activity.id === publication.id) this.linkEvaluation(evaluation, projected.entities.findings);
    else evaluation.findingIds = projected.entities.findings.map((finding) => finding.id);
  }
  projectSpecReview(activity, retained, projected) {
    const { descriptor, review } = retained;
    const document = review.toJSON();
    for (const finding of document.findings ?? []) {
      if (finding.disposition !== undefined && !["apply", "invalid", "already_resolved", "downgraded_to_non_blocking"].includes(finding.disposition)) {
        unavailable("STATUS_NOT_SUPPORTED", finding.findingId, "The stored Spec Review disposition is unsupported");
      }
    }
    const observationId = `generation:${review.generation}`;
    const observations = canonicalSourceFindingObservations({ artifact: document, sourceStep: "spec-review", sourceArtifact: retained.sourceArtifact });
    projected.applicable.add("findings");
    for (const observation of observations) {
      if (!findSourceFinding(document, observation.identity)) unavailable("REFERENCE_NOT_RESOLVED", observation.identity.sourceFindingId, "Exact finding identity is unresolved");
      requireRetainedText(observation.finding, observation.identity.sourceFindingId);
      const source = this.source(descriptor, activity, observation.identity.sourceFindingId, observationId, retained.pointer + observation.jsonPointer);
      projected.add("findings", new FindingDetail({ source, flowVersionId: this.flowVersionId, observation }));
    }
    this.projectSpecReviewVerdict(activity, retained, activity, projected);
    if (this.producerStepId(activity) === "spec-repair") this.projectRepairAudit(activity, retained, projected);
  }
  payload(activity, descriptor) {
    const document = this.read(descriptor);
    if (Array.isArray(document.attempts)) {
      const record = this.attemptRecord(activity, descriptor);
      return new ProducerPayload(record.payload, `/attempts/${record.index}/artifact/payload`, `attempt:${activity.attemptId}`);
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
    this.projectDraftReviewDocument(activity, descriptor, record, review, projected);
  }
  history(descriptor) {
    if (!this.histories.has(descriptor.relativePath)) {
      this.read(descriptor);
      this.histories.set(descriptor.relativePath, CanonicalCommandAttemptArtifactHistory.fromBytes({
        logicalKey: descriptor.logicalKey, bytes: this.artifactBytes.get(descriptor.relativePath) }));
    }
    return this.histories.get(descriptor.relativePath);
  }
  attemptRecord(activity, descriptor) {
    const record = this.history(descriptor).atAttempt(activity.sequence);
    if (record === null) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The producer Attempt payload is not retained");
    return record;
  }
  projectCanonicalDraftReview(activity, route, lifecycle, projected) {
    if (lifecycle.phase === "terminal") {
      const candidates = this.activities.filter((entry) => entry.id !== activity.id
        && entry.nodeId === activity.nodeId && entry.attemptId === activity.attemptId && entry.sequence === activity.sequence
        && entry.confirmationOrder < activity.confirmationOrder)
        .filter((entry) => {
          const publication = this.reviewLifecycle(entry);
          return publication?.phase === "publication" && publication.terminal().equals(lifecycle);
        });
      if (candidates.length !== 1) unavailable(candidates.length === 0 ? "SOURCE_GENERATION_NOT_RETAINED" : "AMBIGUOUS_REFERENCE",
        activity.id, "Draft Review terminal does not resolve to one publication in its exact execution binding");
      const publication = candidates[0];
      this.includeActivityDetails(publication, projected);
      const review = this.draftReviews.get(publication.id);
      const expected = route.key === "questions" ? draftQuestionsReviewResult(review.document) : draftCoverageReviewResult(review.document);
      if (stepResultDigest(activity.result.stepResult) !== stepResultDigest(expected)) {
        unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Draft Review terminal Result does not match its recorded verdict");
      }
      return projected;
    }
    const path = FLOW_ARTIFACT_CONTRACTS.resolve(route.reviewLogicalKey).relativePath;
    const descriptor = this.resolver.resolve({ kind: "path", id: path }, "Draft Review publication", { optional: true });
    if (!descriptor) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Draft Review publication is not retained");
    if (descriptor.logicalKey !== route.reviewLogicalKey || descriptor.slot.publicationStep !== route.reviewStepId) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Draft Review catalog does not match its producer route");
    }
    const history = this.history(descriptor);
    const current = history.currentRecord;
    const latest = this.activities.find((entry) => entry.id === descriptor.activityId);
    if (!latest || latest.nodeId !== route.reviewStepId || latest.sequence !== current.attempt
      || current.nodeId !== route.reviewStepId || this.reviewLifecycle(latest)?.phase !== "publication") {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Draft Review history does not bind its latest catalog publication");
    }
    const record = this.attemptRecord(activity, descriptor);
    requireRetainedText(record.payload, activity.id);
    const review = new CanonicalDraftReviewObservation({ payload: record.payload, state: this.state, route });
    review.assertTarget(new ReviewWorkUnitTarget(lifecycle.binding.target.toJSON()));
    if (review.settlementPublication(record).digest !== activity.result.draftSettlementReceipt.publicationDigest) {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Draft Review payload does not match its saved publication receipt");
    }
    this.draftReviews.set(activity.id, review);
    this.projectDraftReviewDocument(activity, descriptor,
      new ProducerPayload(record.payload, `/attempts/${record.index}/artifact/payload`, `attempt:${activity.attemptId}`), review.document, projected);
    return projected;
  }
  projectDraftReviewDocument(activity, descriptor, record, review, projected) {
    const value = review.toJSON();
    const source = this.source(descriptor, activity, descriptor.logicalKey, record.observationId, record.pointer);
    const evaluation = projected.add("evaluations", new EvaluationDetail({ source, flowVersionId: this.flowVersionId, nativeCode: value.verdict, summary: value.summary }));
    projected.applicable.add("findings");
    for (const observation of canonicalSourceFindingObservations({ artifact: value, sourceStep: this.producerStepId(activity), sourceArtifact: descriptor.relativePath })) {
      const findingSource = this.source(descriptor, activity, observation.identity.sourceFindingId, record.observationId, record.pointer + observation.jsonPointer);
      projected.add("findings", new FindingDetail({ source: findingSource, flowVersionId: this.flowVersionId, observation, draft: true }));
    }
    this.linkEvaluation(evaluation, projected.entities.findings);
  }
  gateRepairPlan(activity, repairId) {
    const descriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "issue.log");
    if (!descriptor) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate repair plan history is not retained");
    const document = new IssueLogDocument(this.read(descriptor));
    const matches = document.entries.map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === "plan-gate-repair" && entry.issueLogId === repairId);
    if (matches.length !== 1) unavailable(matches.length === 0 ? "REFERENCE_NOT_RESOLVED" : "AMBIGUOUS_REFERENCE",
      repairId, "The Gate repair does not resolve to one saved plan");
    const { entry, index } = matches[0];
    exactFields(entry, ["kind", "step", "phase", "reason", "observations", "timestamp", "planGateRepair", "issueLogId"], activity.id);
    requireRetainedText(entry, activity.id);
    const record = PlanGateRepairRecord.fromIssueLogEntry(entry);
    record.assertFlow(this.state);
    assertRecordedProducerValue(entry.planGateRepair, record, activity.id);
    const sourceEntry = document.entries.find((candidate) => candidate.issueLogId === record.sourceIssueLogId);
    if (!record.matchesIssueLogEntry(sourceEntry)) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id,
      "The Gate repair source observation is missing or changed");
    return new RetainedGateRepairPlan({ descriptor, record, entry, pointer: `/entries/${index}/planGateRepair` });
  }
  projectGateRepairPlan(activity, projected) {
    if (activity.references.repairs.length !== 1) unavailable("PRODUCER_NOT_SUPPORTED", activity.id,
      "The Gate repair planning Activity requires its exact plan reference");
    const reference = activity.references.repairs[0];
    const plan = this.gateRepairPlan(activity, reference.id);
    if (plan.record.evidenceIdentity.publicationActivityId !== activity.id
      || plan.record.route.gateStepId !== activity.nodeId || reference.label !== plan.record.sourceIssueLogId) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate repair plan does not bind its source Activity");
    }
    const source = this.source(plan.descriptor, activity, plan.record.idempotencyKey,
      `repair-plan:${plan.record.idempotencyKey}`, plan.pointer);
    const repair = projected.add("repairs", new PlannedGateRepairDetail({ source, flowVersionId: this.flowVersionId,
      record: plan.record, reason: plan.entry.reason }));
    repair.findingIds = projected.entities.findings.filter((finding) => finding.finding.severity === "blocking").map((finding) => finding.id);
  }
  projectSpecGateRepair(activity, projected) {
    const result = activity.result?.stepResult;
    const lifecycle = this.stepExecutionLifecycle(activity);
    if (!(lifecycle.binding instanceof DraftWorkerExecutionBinding)) unavailable("PRODUCER_NOT_SUPPORTED", activity.id,
      "The Gate repair Activity has no saved worker execution binding");
    if (result instanceof SpecGateRepairContextRequiredResult) {
      if (activity.transition.operation !== "record_draft_step_settlement"
        || activity.result.draftSettlementReceipt.settlementKind !== "execution"
        || !["checkpoint", "claimed", "publication"].includes(lifecycle.phase)
        || GROUPS.some((group) => activity.references[group].length !== 0)) {
        unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Gate repair execution Activity contains unsupported completion semantics");
      }
      return projected;
    }
    if (!(result instanceof SpecGateRepairReadyForGateResult || result instanceof SpecGateRepairReviewRequiredResult)
      || lifecycle.phase !== "terminal" || activity.transition.operation !== "confirm_attempt") {
      unavailable("PRODUCER_NOT_SUPPORTED", activity.id, "The Gate repair has no supported recorded terminal Result");
    }
    const publications = this.activities.filter((entry) => entry.nodeId === activity.nodeId
      && entry.attemptId === activity.attemptId && entry.sequence === activity.sequence
      && entry.confirmationOrder < activity.confirmationOrder && entry.result?.stepResult instanceof SpecGateRepairContextRequiredResult)
      .filter((entry) => {
        const published = this.stepExecutionLifecycle(entry);
        return published.phase === "publication" && published.terminal().equals(lifecycle);
      });
    if (publications.length !== 1) unavailable(publications.length === 0 ? "SOURCE_GENERATION_NOT_RETAINED" : "AMBIGUOUS_REFERENCE",
      activity.id, "The Gate repair terminal has no exact worker publication");
    const path = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.audit", { attemptId: activity.attemptId }).relativePath;
    const descriptor = this.resolver.resolve({ kind: "path", id: path }, "Gate repair audit", { optional: true });
    if (!descriptor || descriptor.activityId !== activity.id) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id,
      "The Gate repair audit for this Activity is not retained");
    const audit = this.read(descriptor);
    const plan = this.gateRepairPlan(activity, audit.repairId);
    const baseSpecDescriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "spec.snapshot"
      && `sha256:${entry.hash}` === audit.baseRevision);
    if (!baseSpecDescriptor) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate repair Spec baseline is not retained");
    // The baseline is content-addressed. Identical revision snapshots prove
    // the same bytes; this does not select a historical producer by proximity.
    this.readCatalogedArtifact(baseSpecDescriptor);
    const observation = new QuerySpecGateRepairObservation({ audit, state: this.state, activity, descriptor,
      repairRecord: plan.record, baseSpecDescriptor });
    const gate = this.activities.find((entry) => entry.id === observation.sourceEvidence.publicationActivityId
      && entry.confirmationOrder < activity.confirmationOrder);
    if (!gate) unavailable("REFERENCE_NOT_RESOLVED", activity.id, "The Gate repair source Activity is not retained");
    if (gate.nodeId !== "spec-gate" || !observation.sourceEvidence.sourceAttempt.matches(
      new GateAttemptIdentity({ id: gate.attemptId, sequence: gate.sequence }))) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The Gate repair does not bind its original Gate Attempt");
    }
    const gateDetails = this.forActivity(gate);
    const findings = gateDetails.detailRefs.findings.map((id) => this.entities.findings.get(id));
    const source = this.source(descriptor, activity, activity.id, `attempt:${activity.attemptId}`);
    const items = observation.entries.map((entry) => {
      const findingIds = entry.identities.map((identity) => {
        const matches = findings.filter((finding) => finding.identity.equals(identity));
        if (matches.length !== 1) unavailable(matches.length === 0 ? "REFERENCE_NOT_RESOLVED" : "AMBIGUOUS_REFERENCE",
          identity.sourceFindingId, "The Gate repair finding does not resolve to its exact source observation");
        return matches[0].id;
      });
      return new RepairItem({ id: RepairItem.idFor(source, this.flowVersionId, entry.jsonPointer), referenceId: entry.referenceId,
        target: entry.target === null ? {} : RepairItemTarget.fromOperation(entry.operation.toJSON()),
        operationKind: entry.operationKind, status: new DetailStatus(entry.status, entry.status), reason: entry.reason, findingIds,
        change: entry.status === "applied" ? new RecordedRepairChange(entry.operation) : null });
    });
    const repair = projected.add("repairs", new RepairDetail({ source, flowVersionId: this.flowVersionId, items, nativeValue: "merged" }));
    repair.findingIds = [...new Set(items.flatMap((item) => item.findingIds))];
    repair.supportingSources.push(this.source(plan.descriptor, gate, plan.record.idempotencyKey,
      `repair-plan:${plan.record.idempotencyKey}`, plan.pointer));
    return projected;
  }
  projectGate(activity, descriptor, projected) {
    const record = this.payload(activity, descriptor);
    const value = record.value;
    exactFields(value, ["result", "changed", "artifacts", "summary", "reason"], activity.id);
    const payload = value.artifacts;
    exactFields(payload, ["target", "level", "phase", "evaluations", "nextAction", "reasons", "issues", "failureKind", "failureCode",
      "gateTransitionAttemptId", "gateTransitionAttemptSequence", "gateTransitionLineage", "taskId", "sourceFingerprint",
      "gateTransitionFailureCategory", "evaluationScope", "responseProtocolEvidence", "warnings", "observations"], activity.id);
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
    const source = this.source(descriptor, activity, descriptor.logicalKey, record.observationId, record.pointer);
    const evaluation = projected.add("evaluations", new EvaluationDetail({ source, flowVersionId: this.flowVersionId, nativeCode: value.result,
      summary: value.summary ?? null, explanation: value.reason ?? null,
      specific: new GateEvaluationSpecific(payload, nextAction, activity.id),
      criteria: payload.evaluations.map((entry) => new EvaluationCriterion(entry, activity.id)) }));
    projected.applicable.add("findings");
    for (const observation of canonicalGateFindingObservations({ artifact: value,
      sourceStep: this.producerStepId(activity), sourceArtifact: descriptor.relativePath })) {
      const findingSource = this.source(descriptor, activity, observation.identity.sourceFindingId,
        record.observationId, record.pointer + observation.jsonPointer);
      projected.add("findings", new GateFindingDetail({ source: findingSource, flowVersionId: this.flowVersionId, observation }));
    }
    this.linkEvaluation(evaluation, projected.entities.findings);
    if (activity.transition.operation === "plan_gate_repair") this.projectGateRepairPlan(activity, projected);
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
  projectRepairAudit(activity, retained, projected) {
    const { descriptor, review } = retained;
    const audit = review.audit.at(-1);
    // assertReview already binds the descriptor-owned generation, exact bytes
    // and final audit. The producer's optional audit Activity is supplemental.
    if (audit.stage !== "spec-repair" || (audit.activityId !== undefined && audit.activityId !== activity.id)) unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The repair audit is not bound to this Activity");
    const source = this.source(descriptor, activity, activity.id, `generation:${review.generation}`, `${retained.pointer}/audit/${review.audit.length - 1}`);
    const inputPublications = this.activities.filter((entry) => entry.confirmationOrder < activity.confirmationOrder
      && entry.reviewPublication?.reviewDigest === audit.inputDigest);
    if (inputPublications.length > 1) unavailable("AMBIGUOUS_REFERENCE", activity.id, "The repair input has multiple recorded Review publications");
    const inputFindings = inputPublications.length === 1
      ? this.forActivity(inputPublications[0]).detailRefs.findings.map((id) => this.entities.findings.get(id))
      : projected.entities.findings;
    if (inputPublications.length === 0 && activity.result?.stepResult != null) {
      unavailable("SOURCE_GENERATION_NOT_RETAINED", activity.id, "The repair input Review publication is not retained");
    }
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
          const matches = inputFindings.filter((finding) => finding.identity.sourceFindingId === id);
          if (matches.length !== 1) unavailable("AMBIGUOUS_REFERENCE", id, "Repair finding identity cannot be resolved from its retained generation");
          return matches[0].id;
        });
        // This pointer addresses the exact audit bytes already bound to the
        // saved publication generation. It never uses a current array to
        // reconstruct an unretained observation. Repeated proposals retain
        // distinct items even when the producer stored the same digest.
        const id = RepairItem.idFor(source, this.flowVersionId, `${source.jsonPointer}/${collection}/${position}`);
        items.push(new RepairItem({ id, referenceId: operation.operationDigest ?? specRepairProposalDigest(operation), target,
          operationKind: operation.kind ?? null, status: new DetailStatus(status, status), reason: operation.reason ?? null, findingIds: findings,
          change: status === "applied" ? new RecordedRepairChange(accepted.operations[position]) : null }));
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
/** Storage address and semantic identity are distinct for retained observations. */
class RetainedSpecReviewSource {
  constructor({ descriptor, review, sourceArtifact, pointer }) {
    if (!(review instanceof CanonicalSpecReview) || typeof sourceArtifact !== "string" || typeof pointer !== "string") {
      throw new TypeError("Retained Spec Review requires its canonical value and source addresses");
    }
    Object.assign(this, { descriptor, review, sourceArtifact, pointer });
    Object.freeze(this);
  }
}
class RetainedGateRepairPlan {
  constructor({ descriptor, record, entry, pointer }) {
    if (!(record instanceof PlanGateRepairRecord)) throw new TypeError("Retained Gate repair requires its canonical plan");
    Object.assign(this, { descriptor, record, entry, pointer });
    Object.freeze(this);
  }
}

function publicRepairTarget(value) {
  const target = SpecRepairTarget.fromJSON(value, "detail repair target").toJSON();
  return Object.hasOwn(target, "collection") ? { ...target, position: target.position ?? null } : target;
}
