import crypto from "node:crypto";
import { RepairFindingMutations } from "./repair-mutation-contract.js";

import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskReviewAccounting } from "./task-review-accounting.js";
import { ReviewFindingCycle } from "./finding-disposition-policy.js";
import { TaskStageArtifact } from "./task-review-stage-artifacts.js";
import { taskReviewStagePlanFromJSON } from "./task-review-stage-transition.js";

const SHA256 = /^[a-f0-9]{64}$/;

function isFingerprint(value) {
  return typeof value === "string" && SHA256.test(value);
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function exactKeys(value, allowed, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key))) throw new Error(`${field} has unknown fields`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function reviewFindingEvidence(finding) {
  return {
    findingId: finding.findingId,
    findingKey: finding.findingKey,
    fingerprint: finding.fingerprint,
    file: finding.file ?? null,
    location: finding.location ?? null,
    requirementId: finding.requirementId ?? null,
    issue: finding.issue,
    suggestion: finding.suggestion,
    rationale: finding.rationale,
    ...(typeof finding.priorRepairInsufficiency === "string" ? {
      priorRepairInsufficiency: finding.priorRepairInsufficiency,
    } : {}),
    ...(typeof finding.repairStrategy === "string" ? { repairStrategy: finding.repairStrategy } : {}),
  };
}

/** The current canonical implementation repair plus its parent-captured mutation lineage. */
export class CanonicalImplementationRepairRecord {
  constructor(value = {}) {
    exactKeys(value, new Set([
      "version", "appliedFindingKeys", "findingMutations", "summary", "recurrenceResolutions", "sourceMutationManifest",
    ]), "canonical implementation repair");
    if (value.version !== 1) throw new Error("canonical implementation repair version must be 1");
    if (!Array.isArray(value.appliedFindingKeys) || value.appliedFindingKeys.length === 0
      || value.appliedFindingKeys.some((entry) => typeof entry !== "string" || entry === "")
      || new Set(value.appliedFindingKeys).size !== value.appliedFindingKeys.length) {
      throw new Error("canonical implementation repair appliedFindingKeys are invalid");
    }
    this.findingMutations = new RepairFindingMutations(value.findingMutations);
    this.appliedFindingKeys = this.findingMutations.appliedFindingKeys;
    if (value.appliedFindingKeys.length !== this.appliedFindingKeys.length
      || value.appliedFindingKeys.some((findingKey) => !this.appliedFindingKeys.includes(findingKey))) {
      throw new Error("canonical implementation repair appliedFindingKeys must match findingMutations");
    }
    this.summary = requiredText(value.summary, "canonical implementation repair summary");
    const recurrenceResolutions = value.recurrenceResolutions ?? [];
    if (!Array.isArray(recurrenceResolutions)) {
      throw new Error("canonical implementation repair recurrenceResolutions are invalid");
    }
    this.recurrenceResolutions = deepFreeze(structuredClone(recurrenceResolutions));

    const manifest = value.sourceMutationManifest;
    exactKeys(manifest, new Set(["attempt", "baselineDigest", "mutations", "digest"]), "implementation repair mutation manifest");
    exactKeys(manifest.attempt, new Set(["id", "nodeId", "sequence"]), "implementation repair Attempt");
    if (manifest.attempt.nodeId !== "impl-repair"
      || typeof manifest.attempt.id !== "string" || manifest.attempt.id === ""
      || !Number.isSafeInteger(manifest.attempt.sequence) || manifest.attempt.sequence < 1
      || !isFingerprint(manifest.baselineDigest) || !isFingerprint(manifest.digest)
      || !Array.isArray(manifest.mutations)) {
      throw new Error("implementation repair mutation manifest is invalid");
    }
    for (const mutation of manifest.mutations) {
      exactKeys(mutation, new Set([
        "mutationId", "path", "changeKind",
        "beforeKind", "beforeMode", "beforeDigest",
        "afterKind", "afterMode", "afterDigest",
      ]), "implementation repair mutation");
      if (!isFingerprint(mutation.mutationId) || typeof mutation.path !== "string" || mutation.path === ""
        || !new Set(["added", "deleted", "content", "mode", "type"]).has(mutation.changeKind)
        || !new Set(["missing", "symlink", "directory", "file", "other"]).has(mutation.beforeKind)
        || !new Set(["missing", "symlink", "directory", "file", "other"]).has(mutation.afterKind)
        || (mutation.beforeMode !== null && (!Number.isSafeInteger(mutation.beforeMode) || mutation.beforeMode < 0 || mutation.beforeMode > 0o7777))
        || (mutation.afterMode !== null && (!Number.isSafeInteger(mutation.afterMode) || mutation.afterMode < 0 || mutation.afterMode > 0o7777))
        || (mutation.beforeDigest !== null && !isFingerprint(mutation.beforeDigest))
        || (mutation.afterDigest !== null && !isFingerprint(mutation.afterDigest))
        || (mutation.beforeKind === mutation.afterKind && mutation.beforeMode === mutation.afterMode && mutation.beforeDigest === mutation.afterDigest)) {
        throw new Error("implementation repair mutation is invalid");
      }
    }
    const unsignedManifest = {
      attempt: manifest.attempt,
      baselineDigest: manifest.baselineDigest,
      mutations: manifest.mutations,
    };
    const expectedDigest = crypto.createHash("sha256").update(stableStringify(unsignedManifest)).digest("hex");
    if (expectedDigest !== manifest.digest) throw new Error("implementation repair mutation manifest digest is invalid");
    this.findingMutations.assertManifest(manifest);
    this.sourceMutationManifest = deepFreeze(structuredClone(manifest));
    Object.freeze(this);
  }

  static capture({ repair, mutationManifest } = {}) {
    if (repair === null || typeof repair?.toJSON !== "function"
      || mutationManifest === null || typeof mutationManifest?.toJSON !== "function") {
      throw new Error("canonical implementation repair capture requires typed repair and mutation manifest");
    }
    return new CanonicalImplementationRepairRecord({
      ...repair.toJSON(),
      sourceMutationManifest: mutationManifest.toJSON(),
    });
  }

  static fromBytes(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("canonical implementation repair bytes must be a Buffer");
    return new CanonicalImplementationRepairRecord(JSON.parse(bytes.toString("utf8")));
  }

  assertActivity(activity, descriptor) {
    if (descriptor?.activityId !== activity?.id
      || activity?.nodeId !== "impl-repair"
      || activity?.transition?.operation !== "repair_implementation"
      || activity?.attemptId !== this.sourceMutationManifest.attempt.id
      || activity?.sequence !== this.sourceMutationManifest.attempt.sequence) {
      throw new Error("canonical implementation repair lacks its exact Activity and Attempt lineage");
    }
    return this;
  }

  toJSON() {
    return {
      version: 1,
      appliedFindingKeys: [...this.appliedFindingKeys],
      findingMutations: this.findingMutations.toJSON(),
      summary: this.summary,
      ...(this.recurrenceResolutions.length === 0 ? {} : {
        recurrenceResolutions: structuredClone(this.recurrenceResolutions),
      }),
      sourceMutationManifest: structuredClone(this.sourceMutationManifest),
    };
  }

  toRecurrenceEvidence(activity) {
    this.assertActivity(activity, { activityId: activity.id });
    return {
      summary: this.summary,
      appliedFindingKeys: [...this.appliedFindingKeys],
      recurrenceResolutions: structuredClone(this.recurrenceResolutions),
      activityId: activity.id,
      attempt: structuredClone(this.sourceMutationManifest.attempt),
      sourceFingerprint: this.sourceMutationManifest.digest,
      mutations: this.sourceMutationManifest.mutations.map((mutation) => ({
        path: mutation.path, changeKind: mutation.changeKind,
        beforeKind: mutation.beforeKind, beforeMode: mutation.beforeMode, beforeDigest: mutation.beforeDigest,
        afterKind: mutation.afterKind, afterMode: mutation.afterMode, afterDigest: mutation.afterDigest,
      })),
    };
  }
}

/** Immutable exact prior finding plus its already-canonical repair evidence. */
export class ReviewRecurrenceOccurrence {
  constructor({ attempt, finding, repair } = {}) {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("review recurrence occurrence Attempt is invalid");
    }
    if (finding === null || typeof finding !== "object" || !isFingerprint(finding.fingerprint)) {
      throw new Error("review recurrence occurrence finding is invalid");
    }
    if (repair === null || typeof repair !== "object" || Array.isArray(repair)) {
      throw new Error("review recurrence occurrence repair is invalid");
    }
    this.attempt = attempt;
    this.finding = deepFreeze(structuredClone(finding));
    this.repair = deepFreeze(structuredClone(repair));
    Object.freeze(this);
  }

  toJSON() {
    return {
      attempt: this.attempt,
      finding: structuredClone(this.finding),
      repair: structuredClone(this.repair),
    };
  }
}

/** A recurrence identity and its bounded worker-facing preceding evidence. */
export class ReviewRecurrenceEntry {
  constructor({
    fingerprint,
    findingId,
    findingKey,
    recurrenceCount,
    previous,
    stillPresent = null,
  } = {}) {
    if (!isFingerprint(fingerprint)) throw new Error("review recurrence fingerprint is invalid");
    this.fingerprint = fingerprint;
    this.findingId = requiredText(findingId, "review recurrence findingId");
    this.findingKey = requiredText(findingKey, "review recurrence findingKey");
    this.previous = Object.freeze((previous || []).map((entry) => (
      entry instanceof ReviewRecurrenceOccurrence
        ? entry
        : new ReviewRecurrenceOccurrence(entry)
    )));
    this.recurrenceCount = recurrenceCount ?? this.previous.length;
    if (
      !Number.isSafeInteger(this.recurrenceCount)
      || this.recurrenceCount < 1
      || this.previous.length === 0
      || this.previous.length > this.recurrenceCount
    ) {
      throw new Error("review recurrence entry evidence is invalid");
    }
    if (stillPresent !== null && stillPresent !== true) {
      throw new Error("review recurrence stillPresent must be true or null");
    }
    this.stillPresent = stillPresent;
    Object.freeze(this);
  }

  toJSON() {
    return {
      fingerprint: this.fingerprint,
      findingId: this.findingId,
      findingKey: this.findingKey,
      recurrenceCount: this.recurrenceCount,
      ...(this.stillPresent === null ? {} : { stillPresent: true }),
      previous: this.previous.map((value) => value.toJSON()),
    };
  }
}

/** Derived worker/status projection; this class owns no durable storage. */
export class ReviewRecurrenceHistory {
  constructor({ scope, entries = [] } = {}) {
    if (!new Set(["task", "implementation"]).has(scope)) {
      throw new Error("review recurrence scope is invalid");
    }
    this.scope = scope;
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof ReviewRecurrenceEntry ? entry : new ReviewRecurrenceEntry(entry)
    )));
    Object.freeze(this);
  }

  get empty() {
    return this.entries.length === 0;
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}

/** One Task Review candidate identified against immutable repair evidence. */
export class TaskReviewRecurrenceCandidate {
  constructor(finding = {}) {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("Task Review recurrence candidate must be an object");
    }
    if (!isFingerprint(finding.fingerprint)) {
      throw new Error("Task Review recurrence candidate fingerprint is invalid");
    }
    this.fingerprint = finding.fingerprint;
    this.findingKey = requiredText(finding.findingKey, "Task Review recurrence candidate findingKey");
    Object.freeze(this);
  }
}

/** Successful validation of candidate findings against frozen canonical recurrence history. */
export class TaskReviewRecurrenceValidation {
  constructor({ history, candidates } = {}) {
    if (!(history instanceof ReviewRecurrenceHistory) || history.scope !== "task") {
      throw new Error("Task Review recurrence validation requires task recurrence history");
    }
    if (!Array.isArray(candidates) || candidates.some((candidate) => !(candidate instanceof TaskReviewRecurrenceCandidate))) {
      throw new Error("Task Review recurrence validation requires typed candidates");
    }
    this.history = history;
    this.candidates = Object.freeze([...candidates]);
    Object.freeze(this);
  }
}

/**
 * Phase-owned recurrence contract. Its history is immutable canonical input;
 * callers may use it before cache acceptance as well as before promotion.
 */
export class TaskReviewRecurrenceContract {
  #entriesByFingerprint;

  constructor({ history } = {}) {
    if (!(history instanceof ReviewRecurrenceHistory) || history.scope !== "task") {
      throw new Error("Task Review recurrence contract requires task recurrence history");
    }
    this.history = history;
    this.#entriesByFingerprint = new Map(history.entries.map((entry) => [entry.fingerprint, entry]));
    Object.freeze(this);
  }

  validate(findings = []) {
    if (!Array.isArray(findings)) throw new Error("Task Review recurrence candidates must be an array");
    const candidates = findings.map((finding) => new TaskReviewRecurrenceCandidate(finding));
    for (const candidate of candidates) {
      const prior = this.#entriesByFingerprint.get(candidate.fingerprint) ?? null;
      if (prior === null) continue;
      if (candidate.findingKey !== prior.findingKey) {
        throw new Error("Task Review recurring findingKey does not match its exact canonical fingerprint");
      }
    }
    return new TaskReviewRecurrenceValidation({ history: this.history, candidates });
  }
}

class TaskReviewEvidenceRecord {
  constructor({ taskId, review, triage, repair, lineages }) {
    this.taskId = requiredText(taskId, "Task Review evidence taskId");
    if (!(review instanceof TaskStageArtifact) || !(review.history instanceof CanonicalCommandAttemptArtifactHistory)) {
      throw new Error("Task Review evidence requires canonical Attempt history");
    }
    if (triage !== null && !(triage instanceof TaskStageArtifact)) throw new Error("Task Review evidence triage is invalid");
    if (repair !== null && !(repair instanceof TaskStageArtifact)) throw new Error("Task Review evidence repair is invalid");
    if (!Array.isArray(lineages)) throw new Error("Task Review evidence lineages must be an array");
    this.history = review.history;
    this.review = review;
    this.triageHistory = triage?.history ?? null;
    this.triage = triage;
    this.repairHistory = repair?.history ?? null;
    this.lineages = Object.freeze([...lineages]);
    this.currentBudget = this.lineages.at(-1)?.budget ?? null;
    Object.freeze(this);
  }

  reviewFor(binding) {
    if (binding?.review?.logicalKey !== "task.review") return null;
    return this.history.attempts.find((review) => (
      review.attempt === binding.review.sequence
      && taskStagePayloadDigest(review.payload) === binding.review.payloadDigest
    )) ?? null;
  }

  triageFor(binding) {
    if (this.triageHistory === null || binding?.triage?.logicalKey !== "task.triage") return null;
    return this.triageHistory.attempts.find((triage) => (
      triage.attempt === binding.triage.sequence
      && taskStagePayloadDigest(triage.payload) === binding.triage.payloadDigest
    )) ?? null;
  }

  accountingFor(budget) {
    const nextBudget = this.lineages
      .filter((lineage) => lineage.role === "implementation")
      .find((lineage) => lineage.budget.round === budget.round + 1)?.budget ?? null;
    return new TaskReviewAccounting({
      taskId: this.taskId,
      budget,
      history: this.history,
      roundEndAttemptSequence: nextBudget?.reviewAttemptSequenceAtStart ?? null,
    });
  }
}

function taskIdFromCatalogEntry(entry) {
  const match = entry.relativePath.match(/^steps\/impl\/([^/]+)\/review\/result\.json$/);
  if (!match) throw new Error("canonical Task Review catalog path is invalid");
  return match[1];
}

function taskReviewRecords({ flowManager, state }) {
  return flowManager.artifactCatalog(state.specId).artifacts
    .filter((entry) => entry.logicalKey === "task.review")
    .map((entry) => {
      const taskId = taskIdFromCatalogEntry(entry);
      return new TaskReviewEvidenceRecord({
        taskId,
        review: new TaskStageArtifact({ flowManager, state, taskId, role: "review" }),
        triage: new TaskStageArtifact({ flowManager, state, taskId, role: "triage", optional: true }),
        repair: new TaskStageArtifact({ flowManager, state, taskId, role: "repair", optional: true }),
        lineages: flowManager.taskMutationLineages({ specId: state.specId, taskId }),
      });
    });
}

function taskStagePayloadDigest(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function taskRepairEvidence(stage, triage) {
  return {
    summary: stage.repair.summary,
    dispositions: structuredClone(triage.dispositions),
    appliedFindingKeys: [...stage.repair.appliedFindingKeys],
    recurrenceResolutions: structuredClone(stage.repair.recurrenceResolutions ?? []),
    sourceFingerprint: stage.sourceMutationManifest.digest,
    mutations: stage.sourceMutationManifest.mutations.map((mutation) => ({
      path: mutation.path,
      beforeKind: mutation.beforeKind,
      beforeMode: mutation.beforeMode,
      beforeDigest: mutation.beforeDigest,
      afterKind: mutation.afterKind,
      afterMode: mutation.afterMode,
      afterDigest: mutation.afterDigest,
      changeKind: mutation.changeKind,
    })),
  };
}

/** Acceptance receives only the parent-published triage and repair evidence. */
class TaskReviewAcceptanceEvidence {
  constructor({ stage, triage }) {
    if (stage?.binding?.reviewOrdinal !== 4 || stage?.unreviewedAfterRepair !== true
      || stage?.repair === null || typeof stage?.repair !== "object"
      || stage?.sourceMutationManifest === null || typeof stage?.sourceMutationManifest !== "object"
      || !Array.isArray(triage?.dispositions)) {
      throw new Error("Task Review Acceptance evidence requires the fourth canonical Task repair");
    }
    this.stage = deepFreeze(structuredClone(stage));
    this.triage = deepFreeze(structuredClone(triage));
    this.taskId = stage.taskId;
    this.unreviewedAfterRepair = true;
    Object.freeze(this);
  }

  toJSON() {
    return {
      taskId: this.stage.taskId,
      reviewAttempt: this.stage.binding.reviewOrdinal,
      unreviewedAfterRepair: true,
      findings: structuredClone(this.stage.reviewFindings),
      dispositions: structuredClone(this.triage.dispositions),
      repair: structuredClone(this.stage.repair),
      sourceMutationManifest: structuredClone(this.stage.sourceMutationManifest),
      binding: structuredClone(this.stage.binding),
      handoffDigest: this.stage.handoffDigest,
    };
  }
}

/** A normal-source rejection remains review evidence after triage declines every finding. */
class TaskAllRejectAcceptanceEvidence {
  constructor({ activity, plan, review, triage }) {
    if (plan.operation !== "triage-all-reject-to-gate"
      || plan.facts.sourceNoChange
      || plan.facts.triageDisposition !== "all-reject"
      || plan.facts.verdict !== "REJECTED"
      || review?.taskId !== plan.facts.binding.taskId
      || review?.verdict !== "REJECTED"
      || review?.canonicalTaskSource?.fingerprint !== plan.facts.binding.sourceFingerprint
      || triage?.taskId !== review.taskId
      || triage?.binding?.taskRound !== plan.facts.taskRound
      || triage?.binding?.sourceFingerprint !== plan.facts.binding.sourceFingerprint
      || triage?.binding?.review?.payloadDigest !== taskStagePayloadDigest(review)
      || !Array.isArray(triage?.reviewFindings)
      || !Array.isArray(triage?.dispositions)
      || triage.dispositions.length === 0
      || triage.dispositions.some((entry) => entry?.disposition !== "reject")) {
      throw new Error("Task all-reject Acceptance evidence requires the exact normal-source triage route");
    }
    const reviewFindingKeys = [...(review.blockingFindings ?? []), ...(review.nonBlockingImprovements ?? [])]
      .map((finding) => finding?.findingKey);
    const triageFindingKeys = triage.reviewFindings.map((finding) => finding?.findingKey);
    const dispositionFindingKeys = triage.dispositions.map((disposition) => disposition?.findingKey);
    if (new Set(reviewFindingKeys).size !== reviewFindingKeys.length
      || new Set(triageFindingKeys).size !== triageFindingKeys.length
      || new Set(dispositionFindingKeys).size !== dispositionFindingKeys.length
      || !sameStringMembers(reviewFindingKeys, triageFindingKeys)
      || !sameStringMembers(reviewFindingKeys, dispositionFindingKeys)) {
      throw new Error("Task all-reject Acceptance evidence does not retain every canonical finding");
    }
    this.taskId = review.taskId;
    this.taskRound = plan.facts.taskRound;
    this.activityId = activity.id;
    this.review = deepFreeze(structuredClone(review));
    this.triage = deepFreeze(structuredClone(triage));
    this.plan = deepFreeze(structuredClone(plan.toJSON()));
    Object.freeze(this);
  }

  toJSON() {
    return {
      taskId: this.taskId,
      taskRound: this.taskRound,
      allRejected: true,
      activityId: this.activityId,
      reviewVerdict: this.review.verdict,
      findings: [...this.review.blockingFindings, ...this.review.nonBlockingImprovements],
      dispositions: structuredClone(this.triage.dispositions),
      sourceFingerprint: this.triage.binding.sourceFingerprint,
      binding: structuredClone(this.triage.binding),
      review: {
        attempt: this.triage.binding.review.sequence,
        artifact: structuredClone(this.triage.binding.review),
      },
      triage: {
        attempt: structuredClone(this.triage.attempt),
        artifactDigest: this.plan.facts.binding.artifactDigest,
        payloadDigest: taskStagePayloadDigest(this.triage),
        handoffDigest: this.triage.handoffDigest,
      },
    };
  }
}

function isExactTriageStageCompletion({ activity, plan, stage }) {
  const binding = plan.facts.binding;
  return activity.transition?.operation === "advance_task_review_stage"
    && binding.stage === "triage"
    && binding.attemptId === stage.attempt?.id
    && binding.attemptSequence === stage.attempt?.sequence
    && binding.sourceFingerprint === stage.binding?.sourceFingerprint
    && plan.facts.taskRound === stage.binding?.taskRound
    && plan.facts.reviewResultCount === stage.binding?.reviewOrdinal
    && plan.facts.sameReviewBinding === true;
}

/** A no-change continuation is authoritative only after its stage transaction commits. */
class TaskNoChangeAcceptanceEvidence {
  constructor({ activity, plan, review, triage = null }) {
    const selection = plan.facts.noChangeContinuation;
    if (selection?.decision !== "continue"
      || !["review-no-change-complete", "triage-no-change-complete"].includes(plan.operation)
      || review?.canonicalTaskSource?.fingerprint !== selection.facts.source.fingerprint
      || review.taskId !== plan.facts.binding.taskId) {
      throw new Error("Task no-change Acceptance evidence requires a committed continuation and matching Review");
    }
    const selectedTriage = selection.facts.triage;
    if (selectedTriage === null) {
      if (triage !== null) throw new Error("Task no-change Acceptance evidence must not invent triage dispositions");
    } else {
      if (!(triage instanceof TaskStageArtifact)
        || triage.reference?.logicalKey !== "task.triage"
        || triage.reference.digest !== selectedTriage.artifactDigest
        || triage.reference.sequence !== plan.facts.binding.attemptSequence
        || triage.document?.taskId !== review.taskId
        || triage.document?.binding?.sourceFingerprint !== selection.facts.source.fingerprint
        || triage.document?.binding?.review?.digest !== selectedTriage.reviewArtifactDigest
        || !Array.isArray(triage.document?.dispositions)
        || triage.document.dispositions.length === 0
        || triage.document.dispositions.some((entry) => entry?.disposition !== "reject")) {
        throw new Error("Task no-change Acceptance evidence requires its exact all-reject triage producer payload");
      }
    }
    this.taskId = review.taskId;
    this.noChange = true;
    this.activityId = activity.id;
    this.continuation = deepFreeze(structuredClone(selection.toJSON()));
    this.review = deepFreeze(structuredClone(review));
    this.triage = selectedTriage === null ? null : deepFreeze(structuredClone(triage.document));
    Object.freeze(this);
  }

  toJSON() {
    return {
      taskId: this.taskId,
      noChange: true,
      activityId: this.activityId,
      continuation: structuredClone(this.continuation),
      findings: [...this.review.blockingFindings, ...this.review.nonBlockingImprovements],
      ...(this.triage === null ? {} : { dispositions: structuredClone(this.triage.dispositions) }),
      canonicalTaskSource: structuredClone(this.review.canonicalTaskSource),
    };
  }
}

/** Shared canonical reader used by Task worker prompt, Acceptance, and status. */
export class TaskReviewConvergenceEvidence {
  constructor({ flowManager, state, cycle } = {}) {
    if (!(cycle instanceof ReviewFindingCycle)) {
      throw new Error("Task Review convergence requires a ReviewFindingCycle");
    }
    this.flowManager = flowManager;
    this.state = state;
    this.cycle = cycle;
    this.records = Object.freeze(taskReviewRecords({ flowManager, state }));
    Object.freeze(this);
  }

  record(taskId) {
    return this.records.find((entry) => entry.taskId === taskId) ?? null;
  }

  recurrenceHistory(taskId) {
    const record = this.record(taskId);
    if (record === null || record.currentBudget === null) {
      return new ReviewRecurrenceHistory({ scope: "task" });
    }
    const grouped = new Map();
    for (const repair of record.repairHistory?.attempts ?? []) {
      const stage = repair.payload;
      const review = record.reviewFor(stage.binding);
      const triage = record.triageFor(stage.binding);
      if (review === null || triage === null || !this.cycle.matchesArtifact(review.payload)
        || stage.binding?.taskRound !== record.currentBudget.round
        || stage.binding?.triage?.payloadDigest !== taskStagePayloadDigest(triage.payload)
        || !Array.isArray(stage.repair?.appliedFindingKeys)) continue;
      for (const finding of stage.reviewFindings || []) {
        if (!stage.repair.appliedFindingKeys.includes(finding?.findingKey)) continue;
        if (!isFingerprint(finding?.fingerprint)) continue;
        const previous = grouped.get(finding.fingerprint) || [];
        previous.push(new ReviewRecurrenceOccurrence({
          attempt: review.attempt,
          finding: reviewFindingEvidence(finding),
          repair: taskRepairEvidence(stage, triage.payload),
        }));
        grouped.set(finding.fingerprint, previous);
      }
    }
    return new ReviewRecurrenceHistory({
      scope: "task",
      entries: [...grouped.entries()].map(([fingerprint, previous]) => ({
        fingerprint,
        findingId: previous.at(-1).finding.findingId,
        findingKey: previous.at(-1).finding.findingKey,
        previous,
      })),
    });
  }

  handoffs() {
    const handoffs = [];
    const activities = Object.freeze(this.flowManager.activityLedger(this.state.specId));
    for (const record of this.records) {
      for (const repair of record.repairHistory?.attempts ?? []) {
        const stage = repair.payload;
        const review = record.reviewFor(stage.binding);
        const triage = record.triageFor(stage.binding);
        if (review === null || triage === null || !this.cycle.matchesArtifact(review.payload)
          || stage.binding?.taskRound !== record.currentBudget?.round
          || stage.binding?.triage?.payloadDigest !== taskStagePayloadDigest(triage.payload)
          || stage.unreviewedAfterRepair !== true) continue;
        handoffs.push(new TaskReviewAcceptanceEvidence({ stage, triage: triage.payload }));
      }
      for (const triage of record.triageHistory?.attempts ?? []) {
        const stage = triage.payload;
        const review = record.reviewFor(stage.binding);
        const activity = activities.find((entry) => (
          entry.nodeId === `${record.taskId}-triage`
          && entry.attemptId === stage.attempt?.id
          && entry.sequence === stage.attempt?.sequence
          && entry.transition?.operation === "advance_task_review_stage"
          && entry.transition?.taskReviewStagePlan !== null
        )) ?? null;
        if (review === null || activity === null || !this.cycle.matchesArtifact(review.payload)
          || stage.binding?.taskRound !== record.currentBudget?.round) continue;
        const storedPlan = activity.transition?.taskReviewStagePlan;
        if (storedPlan === null || storedPlan === undefined) continue;
        const plan = taskReviewStagePlanFromJSON(storedPlan);
        if (plan.operation !== "triage-all-reject-to-gate"
          || !isExactTriageStageCompletion({ activity, plan, stage })) continue;
        handoffs.push(new TaskAllRejectAcceptanceEvidence({ activity, plan, review: review.payload, triage: stage }));
      }
    }
    for (const activity of activities) {
      const storedPlan = activity.transition?.taskReviewStagePlan;
      if (storedPlan?.facts.noChangeContinuation === null || storedPlan?.facts.noChangeContinuation === undefined) continue;
      const plan = taskReviewStagePlanFromJSON(storedPlan);
      const record = this.record(plan.facts.binding.taskId);
      if (record === null) continue;
      const stage = plan.facts.binding.stage;
      const producer = (stage === "review" ? record.history : record.triageHistory)?.attempts
        .find((entry) => entry.attempt === plan.facts.binding.attemptSequence);
      const triage = stage === "triage" ? record.triage : null;
      const review = stage === "review" ? producer : record.reviewFor(producer?.payload.binding);
      if (review === null || review === undefined || !this.cycle.matchesArtifact(review.payload)
        || plan.facts.taskRound !== record.currentBudget?.round) continue;
      handoffs.push(new TaskNoChangeAcceptanceEvidence({ activity, plan, review: review.payload, triage }));
    }
    return Object.freeze(handoffs);
  }

  status() {
    const fourthHandoffs = this.handoffs();
    return this.records.map((record) => {
      const review = record.history.current;
      const accounting = record.currentBudget === null
        ? null
        : record.accountingFor(record.currentBudget);
      const reviewAttempts = accounting?.completedReviewCount ?? null;
      const currentReview = reviewAttempts !== null
        && reviewAttempts > 0
        && this.cycle.matchesArtifact(review.payload);
      const recurrence = this.recurrenceHistory(record.taskId);
      const fourthRepairUnreviewed = fourthHandoffs.some((handoff) => (
        handoff.taskId === record.taskId && handoff.unreviewedAfterRepair
      ));
      return {
        taskId: record.taskId,
        reviewAttempts,
        recurringFindings: recurrence.entries
          .filter((entry) => entry.recurrenceCount > 1)
          .map((entry) => ({
            findingId: entry.findingId,
            fingerprint: entry.fingerprint,
            recurrenceCount: entry.recurrenceCount - 1,
          })),
        fourthRepairUnreviewed,
        ...(fourthHandoffs.some((handoff) => handoff.taskId === record.taskId && handoff.noChange) && { assurance: "advisory" }),
        finalVerdict: currentReview ? review.payload.verdict : null,
      };
    });
  }
}

function activityForDescriptor({ descriptor, activities, label }) {
  const activity = descriptor?.activityId === null || descriptor?.activityId === undefined
    ? null
    : activities.find((entry) => entry.id === descriptor.activityId) ?? null;
  if (activity === null) throw new Error(`${label} lacks its canonical Activity lineage`);
  return activity;
}

function implementationReviewHistory({ flowManager, state, activities }) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "impl.review",
    consumerNodeId: "system",
    optional: true,
  });
  if (source === null) return null;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "impl.review",
    bytes: source.bytes,
  });
  const activity = activityForDescriptor({
    descriptor: source.descriptor,
    activities,
    label: "canonical Implementation Review",
  });
  if (activity.nodeId !== "impl-review" || activity.sequence !== history.current.attempt) {
    throw new Error("canonical Implementation Review does not bind its current Attempt");
  }
  return Object.freeze({ history, descriptor: source.descriptor, activity });
}

function currentImplementationRepair({ flowManager, state, activities }) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "impl.repair",
    consumerNodeId: "system",
    optional: true,
  });
  if (source === null) return null;
  const activity = activityForDescriptor({
    descriptor: source.descriptor,
    activities,
    label: "canonical implementation repair",
  });
  const record = CanonicalImplementationRepairRecord.fromBytes(source.bytes)
    .assertActivity(activity, source.descriptor);
  return Object.freeze({ record, descriptor: source.descriptor, activity });
}

function currentImplementationTriage({ flowManager, state, activities }) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "impl.triage",
    consumerNodeId: "impl-repair",
    optional: true,
  });
  if (source === null) return null;
  const activity = activityForDescriptor({
    descriptor: source.descriptor,
    activities,
    label: "canonical implementation triage",
  });
  if (activity.nodeId !== "impl-triage"
    || activity.transition?.operation !== "triage_implementation_for_repair") {
    throw new Error("canonical implementation triage lacks its repair-route Activity lineage");
  }
  const value = JSON.parse(source.bytes.toString("utf8"));
  if (!Array.isArray(value?.dispositions)) {
    throw new Error("canonical implementation triage dispositions are invalid");
  }
  const appliedFindingKeys = value.dispositions
    .filter((entry) => entry?.disposition === "apply")
    .map((entry) => requiredText(entry?.findingKey, "canonical implementation triage findingKey"));
  if (new Set(appliedFindingKeys).size !== appliedFindingKeys.length) {
    throw new Error("canonical implementation triage applies duplicate finding keys");
  }
  const activityFindingKeys = activity.references?.findings?.map((entry) => entry.id) ?? [];
  if (!containsStringMembers(activityFindingKeys, appliedFindingKeys)) {
    throw new Error("canonical implementation triage apply set lacks its Activity finding lineage");
  }
  return Object.freeze({ value: deepFreeze(structuredClone(value)), descriptor: source.descriptor, activity, appliedFindingKeys: Object.freeze(appliedFindingKeys) });
}

function sameStringMembers(left, right) {
  return left.length === right.length && new Set(left).size === left.length
    && left.every((entry) => right.includes(entry));
}

function containsStringMembers(values, expected) {
  return new Set(values).size === values.length
    && expected.every((entry) => values.includes(entry));
}

/** Exact flow-level recurrence handoff derived from impl.review history + impl.repair. */
export class ImplementationReviewRepairRecurrence {
  constructor({ flowManager, state, cycle } = {}) {
    if (!(cycle instanceof ReviewFindingCycle)) {
      throw new Error("Implementation repair recurrence requires a ReviewFindingCycle");
    }
    this.cycle = cycle;
    this.activities = Object.freeze(flowManager.activityLedger(state.specId));
    this.reviewEvidence = implementationReviewHistory({ flowManager, state, activities: this.activities });
    this.attemptHistory = this.reviewEvidence?.history ?? null;
    this.precedingRepair = this.attemptHistory === null
      ? null
      : currentImplementationRepair({ flowManager, state, activities: this.activities });
    this.currentTriage = this.attemptHistory === null
      ? null
      : currentImplementationTriage({ flowManager, state, activities: this.activities });
    this.history = this.#deriveHistory();
    Object.freeze(this);
  }

  #deriveHistory() {
    if (
      this.attemptHistory === null
      || this.attemptHistory.attempts.length < 2
      || !this.cycle.matchesArtifact(this.attemptHistory.current.payload)
    ) {
      return new ReviewRecurrenceHistory({ scope: "implementation" });
    }
    // A completed current repair follows the current Review.  It is useful to
    // status and later gates, but cannot be predecessor evidence for another
    // repair worker, so the worker-only projection is deliberately empty.
    if (this.precedingRepair === null || this.currentTriage === null
      || this.precedingRepair.activity.confirmationOrder >= this.reviewEvidence.activity.confirmationOrder) {
      return new ReviewRecurrenceHistory({ scope: "implementation" });
    }
    const previousReview = this.attemptHistory.attempts.at(-2);
    if (!this.cycle.matchesArtifact(previousReview.payload)) {
      return new ReviewRecurrenceHistory({ scope: "implementation" });
    }
    const previousReviewActivity = this.activities.findLast((activity) => (
      activity.nodeId === "impl-review"
      && activity.sequence === previousReview.attempt
      && activity.confirmationOrder < this.reviewEvidence.activity.confirmationOrder
    )) ?? null;
    const repairActivity = this.precedingRepair.activity;
    const precedingTriageActivity = this.activities.findLast((activity) => (
      activity.nodeId === "impl-triage"
      && activity.transition?.operation === "triage_implementation_for_repair"
      && activity.confirmationOrder > (previousReviewActivity?.confirmationOrder ?? Number.MAX_SAFE_INTEGER)
      && activity.confirmationOrder < repairActivity.confirmationOrder
    )) ?? null;
    const repairFindingKeys = repairActivity.references?.findings?.map((entry) => entry.id) ?? [];
    const precedingTriageFindingKeys = precedingTriageActivity?.references?.findings?.map((entry) => entry.id) ?? [];
    const currentTriageActivity = this.currentTriage.activity;
    if (previousReviewActivity === null
      || previousReviewActivity.confirmationOrder >= repairActivity.confirmationOrder
      || repairActivity.confirmationOrder >= this.reviewEvidence.activity.confirmationOrder
      || precedingTriageActivity === null
      || currentTriageActivity.confirmationOrder <= this.reviewEvidence.activity.confirmationOrder
      || !sameStringMembers(repairFindingKeys, this.precedingRepair.record.appliedFindingKeys)
      || !containsStringMembers(precedingTriageFindingKeys, this.precedingRepair.record.appliedFindingKeys)) {
      throw new Error("implementation recurrence repair is not bound to the immediately preceding Review lineage");
    }
    const entries = [];
    for (const finding of this.attemptHistory.current.payload.blockingFindings || []) {
      if (
        !isFingerprint(finding?.fingerprint)
        || !this.currentTriage.appliedFindingKeys.includes(finding.findingKey)
        || !this.precedingRepair.record.appliedFindingKeys.includes(finding.findingKey)
      ) {
        continue;
      }
      const previousFinding = (previousReview.payload?.blockingFindings || [])
        .find((candidate) => candidate?.fingerprint === finding.fingerprint) ?? null;
      if (previousFinding === null) continue;
      const priorOccurrences = this.attemptHistory.attempts
        .slice(0, -1)
        .filter((review) => this.cycle.matchesArtifact(review.payload))
        .filter((review) => (review.payload?.blockingFindings || [])
          .some((candidate) => candidate?.fingerprint === finding.fingerprint));
      entries.push(new ReviewRecurrenceEntry({
        fingerprint: finding.fingerprint,
        findingId: finding.findingId,
        findingKey: finding.findingKey,
        recurrenceCount: priorOccurrences.length,
        stillPresent: true,
        previous: [new ReviewRecurrenceOccurrence({
          attempt: previousReview.attempt,
          finding: reviewFindingEvidence(previousFinding),
          repair: this.precedingRepair.record.toRecurrenceEvidence(repairActivity),
        })],
      }));
    }
    return new ReviewRecurrenceHistory({ scope: "implementation", entries });
  }

  toJSON() {
    return this.history.toJSON();
  }

  status() {
    return new ImplementationReviewRecurrenceStatus({ attemptHistory: this.attemptHistory, cycle: this.cycle }).toJSON();
  }
}

/** Read-only status projection. It intentionally has no repair-lineage role. */
export class ImplementationReviewRecurrenceStatus {
  constructor({ attemptHistory, cycle } = {}) {
    if (attemptHistory !== null && !(attemptHistory instanceof CanonicalCommandAttemptArtifactHistory)) {
      throw new Error("implementation recurrence status requires canonical Review history");
    }
    if (!(cycle instanceof ReviewFindingCycle)) {
      throw new Error("implementation recurrence status requires a ReviewFindingCycle");
    }
    this.attemptHistory = attemptHistory;
    this.cycle = cycle;
    Object.freeze(this);
  }

  static fromCanonical({ flowManager, state, cycle } = {}) {
    const activities = flowManager.activityLedger(state.specId);
    return new ImplementationReviewRecurrenceStatus({
      attemptHistory: implementationReviewHistory({ flowManager, state, activities })?.history ?? null,
      cycle,
    });
  }

  toJSON() {
    if (this.attemptHistory === null) return null;
    const current = this.attemptHistory.current.payload;
    if (!this.cycle.matchesArtifact(current)) return { recurringFindings: [], finalVerdict: null };
    const occurrences = new Map();
    for (const review of this.attemptHistory.attempts) {
      if (!this.cycle.matchesArtifact(review.payload)) continue;
      const seen = new Set();
      for (const finding of review.payload?.blockingFindings || []) {
        if (!isFingerprint(finding?.fingerprint) || seen.has(finding.fingerprint)) continue;
        const previous = occurrences.get(finding.fingerprint) ?? { findingId: finding.findingId, fingerprint: finding.fingerprint, count: 0 };
        occurrences.set(finding.fingerprint, { findingId: finding.findingId, fingerprint: finding.fingerprint, count: previous.count + 1 });
        seen.add(finding.fingerprint);
      }
    }
    return {
      recurringFindings: [...occurrences.values()].filter((entry) => entry.count > 1).map((entry) => ({
        findingId: entry.findingId, fingerprint: entry.fingerprint, recurrenceCount: entry.count - 1,
      })),
      finalVerdict: current.verdict,
    };
  }
}

/** Exact current apply findings joined to prior repairs in this Task review cycle. */
export class TaskRepairRecurrence {
  constructor({ flowManager, state, taskId, findings, dispositions }) {
    const cycle = ReviewFindingCycle.fromActivityLedger({
      runId: state.runId, activities: flowManager.activityLedger(state.specId),
    });
    const history = new TaskReviewConvergenceEvidence({ flowManager, state, cycle }).recurrenceHistory(taskId);
    const applied = new Set(dispositions.filter((entry) => entry.disposition === "apply").map((entry) => entry.findingKey));
    const prior = new Map(history.entries.map((entry) => [entry.fingerprint, entry]));
    this.entries = Object.freeze(findings.filter((finding) => applied.has(finding.findingKey) && prior.has(finding.fingerprint))
      .map((finding) => new ReviewRecurrenceEntry({
        ...prior.get(finding.fingerprint).toJSON(), findingId: finding.findingId, findingKey: finding.findingKey, stillPresent: true,
      })));
    Object.freeze(this);
  }

  toJSON() { return { version: 1, scope: "task", entries: this.entries.map((entry) => entry.toJSON()) }; }
}
