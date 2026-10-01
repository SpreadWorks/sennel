import {
  DRAFT_REVIEW_ARTIFACT_LIMIT,
  DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT,
  DraftReviewRoute,
} from "./draft-review-routes.js";
import { DraftArtifactRevision } from "./draft-artifact-promotion.js";
import { DraftReviewRevisionBinding } from "./draft-review-revision.js";
import { validateDraftRepairTriage } from "./draft-repair-operations.js";

const MAX_DRAFT_CHANGED_FIELD_PATHS = 20;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DRAFT_REVIEW_CLASSIFICATION_BY_ARRAY = Object.freeze({
  blockingFindings: "blocking",
  advisoryFindings: "advisory",
  repairTargets: "repair_target",
});
const DRAFT_TRIAGE_DECISIONS = new Set([
  "apply",
  "invalid",
  "already_resolved",
  "downgraded_to_non_blocking",
  "requires_user_decision",
]);
const DRAFT_REVIEW_ITEM_FIELDS = Object.freeze(["title", "target", "rationale", "evidence"]);
const DRAFT_TRIAGE_ITEM_FIELDS = Object.freeze(["title", "target", "decision", "rationale", "evidence"]);
const DRAFT_REPAIR_ITEM_FIELDS = Object.freeze(["title", "target", "rationale", "evidence"]);
const DRAFT_REVIEW_CLASSIFICATIONS = Object.freeze(["blocking", "advisory", "repair_target"]);
const DRAFT_REVIEW_FIELD_MAX_CHARS = 1000;
const DRAFT_REVIEW_TRUNCATION_SUFFIX = " [truncated]";

/** The triage decision contract shared by admission and worker authoring. */
export class DraftTriageDecision {
  constructor(value) {
    if (!DRAFT_TRIAGE_DECISIONS.has(value)) throw new Error("decision is invalid");
    this.value = value;
    Object.freeze(this);
  }

  get acceptsCompletion() { return this.value !== "requires_user_decision"; }

  assertAccepted() {
    if (!this.acceptsCompletion) throw new Error("decision requires user decision");
  }

  workerGuidance() {
    switch (this.value) {
      case "apply": return "Use apply only when supplied authoritative evidence supports a bounded Draft repair without new user input. Include exact existing allowedFieldPaths and the requiredFieldPaths subset; do not grant a whole object or unrelated fields.";
      case "invalid": return "Use invalid only for a finding outside the review criteria, contradicted by verified context, or requiring broader scope.";
      case "already_resolved": return "Use already_resolved only when the current immutable Draft already covers the finding.";
      case "downgraded_to_non_blocking": return "Use downgraded_to_non_blocking only for useful context that does not block the downstream Draft work.";
      case "requires_user_decision": return "requires_user_decision is recognized but rejected by handoff validation: a genuine new user choice has no successful triage completion or QA route. Stop and report the missing decision without sealing a successful payload. Preserve existing QA entries and prior answers; never force the finding into apply, invalid, already_resolved, or downgraded_to_non_blocking to obtain completion. Do not register or answer a new question from this step.";
    }
  }

  static triageGuidance(route) {
    if (!(route instanceof DraftReviewRoute)) throw new TypeError("Draft triage guidance requires a DraftReviewRoute");
    const decisions = [...DRAFT_TRIAGE_DECISIONS].map((value) => new DraftTriageDecision(value));
    const accepted = decisions.filter((decision) => decision.acceptsCompletion);
    return [
      `${route.triageStepId} handoff accepts only these completed-item decisions: ${accepted.map((decision) => decision.value).join(", ")}. Accepted triage proceeds to ${route.repairStepId}; it does not reopen QA.`,
      ...decisions.map((decision) => decision.workerGuidance()),
    ].join("\n");
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function normalizeDraftReviewText(value, fallback) {
  const text = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  return text.length > DRAFT_REVIEW_FIELD_MAX_CHARS
    ? `${text.slice(0, DRAFT_REVIEW_FIELD_MAX_CHARS - DRAFT_REVIEW_TRUNCATION_SUFFIX.length)}${DRAFT_REVIEW_TRUNCATION_SUFFIX}`
    : text;
}

export class DraftReviewFinding {
  constructor({ title, target, rationale, evidence, classification }) {
    if (!DRAFT_REVIEW_CLASSIFICATIONS.includes(classification)) {
      throw new Error(`invalid draft review classification: ${classification}`);
    }
    this.title = normalizeDraftReviewText(title, "Untitled finding");
    this.target = normalizeDraftReviewText(target, "GLOBAL");
    this.rationale = normalizeDraftReviewText(rationale, "Recorded by draft review.");
    this.evidence = normalizeDraftReviewText(evidence, "Draft review output.");
    this.classification = classification;
    Object.freeze(this);
  }

  static fromStored(value, classification) {
    if (value instanceof DraftReviewFinding) {
      if (value.classification !== classification) {
        throw new Error(`draft review finding classification must be ${classification}`);
      }
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("draft review finding must be an object");
    }
    if (value.classification != null && value.classification !== classification) {
      throw new Error(`draft review finding classification must be ${classification}`);
    }
    return new DraftReviewFinding({ ...value, classification });
  }

  toJSON() {
    return {
      title: this.title,
      target: this.target,
      rationale: this.rationale,
      evidence: this.evidence,
      classification: this.classification,
    };
  }
}

function normalizeDraftReviewFindings(value, field, classification) {
  if (!Array.isArray(value)) throw new Error(`draft review ${field} must be an array`);
  if (value.length > DRAFT_REVIEW_ARTIFACT_LIMIT) {
    throw new Error(`draft review ${field} exceeds ${DRAFT_REVIEW_ARTIFACT_LIMIT} items`);
  }
  return Object.freeze(value.map((item) => DraftReviewFinding.fromStored(item, classification)));
}

export class DraftReviewArtifactDocument {
  constructor({
    phase,
    sourceDraft,
    sourceDraftRevision,
    generatedAt = new Date().toISOString(),
    verdict = null,
    summary = null,
    blockingFindings = [],
    advisoryFindings = [],
    repairTargets = [],
  }) {
    this.version = 2;
    this.phase = requireString(phase, "draft review phase");
    this.sourceDraft = requireString(sourceDraft, "draft review sourceDraft");
    this.sourceDraftRevision = DraftArtifactRevision.from(sourceDraftRevision).toJSON();
    this.generatedAt = requireString(generatedAt, "draft review generatedAt");
    this.blockingFindings = normalizeDraftReviewFindings(blockingFindings, "blockingFindings", "blocking");
    this.advisoryFindings = normalizeDraftReviewFindings(advisoryFindings, "advisoryFindings", "advisory");
    this.repairTargets = normalizeDraftReviewFindings(repairTargets, "repairTargets", "repair_target");
    const derivedVerdict = this.blockingFindings.length > 0
      ? "REJECTED"
      : this.advisoryFindings.length > 0 || this.repairTargets.length > 0
        ? "ADVISORY"
        : "PASS";
    if (verdict != null && verdict !== derivedVerdict) {
      throw new Error(`draft review verdict must be ${derivedVerdict}`);
    }
    this.verdict = derivedVerdict;
    this.summary = summary == null
      ? derivedVerdict === "PASS"
        ? "No draft review findings recorded."
        : `${this.blockingFindings.length} blocking, ${this.advisoryFindings.length} advisory, ${this.repairTargets.length} repair target finding(s) recorded.`
      : requireString(summary, "draft review summary");
    Object.freeze(this.sourceDraftRevision);
    Object.freeze(this);
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 2) {
      throw new Error("draft review artifact version must be 2");
    }
    return new DraftReviewArtifactDocument(value);
  }

  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      sourceDraft: this.sourceDraft,
      sourceDraftRevision: { ...this.sourceDraftRevision },
      generatedAt: this.generatedAt,
      verdict: this.verdict,
      summary: this.summary,
      blockingFindings: this.blockingFindings.map((item) => item.toJSON()),
      advisoryFindings: this.advisoryFindings.map((item) => item.toJSON()),
      repairTargets: this.repairTargets.map((item) => item.toJSON()),
    };
  }
}

export function normalizeDraftReviewArtifactDocument(value) {
  return DraftReviewArtifactDocument.fromStored(value).toJSON();
}

function validateArtifactObject(issues, artifactName, artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    issues.push(`${artifactName}: artifact must be an object`);
    return false;
  }
  return true;
}

function validateRequiredString(issues, label, value) {
  if (typeof value !== "string" || value.trim() === "") issues.push(`${label} must be non-empty`);
}

function validateRequiredStringFields(issues, prefix, item, fields) {
  for (const field of fields) validateRequiredString(issues, `${prefix}.${field}`, item?.[field]);
}

function validateReviewRevision(
  issues,
  route,
  reviewFile,
  state,
  { requireCurrentRevision = false, validateBinding = true } = {},
) {
  const review = reviewFile.document;
  if (!validateArtifactObject(issues, `${route.reviewArtifact}: sourceDraftRevision`, review.sourceDraftRevision)) {
    issues.push(`${route.reviewArtifact}: version 2 requires sourceDraftRevision`);
    return;
  }
  validateRequiredStringFields(
    issues,
    `${route.reviewArtifact}: sourceDraftRevision`,
    review.sourceDraftRevision,
    ["runId", "specId", "sourceStepId", "digest", "finalizedAt"],
  );
  if (review.sourceDraftRevision.version !== 1) {
    issues.push(`${route.reviewArtifact}: sourceDraftRevision.version must be 1`);
  }
  if (!Number.isSafeInteger(review.sourceDraftRevision.byteLength) || review.sourceDraftRevision.byteLength < 1) {
    issues.push(`${route.reviewArtifact}: sourceDraftRevision.byteLength must be positive`);
  }
  if (!SHA256_PATTERN.test(review.sourceDraftRevision.digest || "")) {
    issues.push(`${route.reviewArtifact}: sourceDraftRevision.digest must be a SHA-256 digest`);
  }
  try {
    const revision = DraftArtifactRevision.from(review.sourceDraftRevision);
    revision.assertReviewSource(route.retryPhase);
    if (validateBinding) {
      revision.assertFlow(state);
      const stored = state?.draftReviewRevisions?.[route.retryPhase];
      if (stored && !requireCurrentRevision) {
        DraftReviewRevisionBinding.from(stored).assertMatches({ state, route, reviewFile, revision });
      } else {
        revision.assertCurrentReview(state, route.retryPhase);
      }
    }
  } catch (error) {
    issues.push(`${route.reviewArtifact}: invalid sourceDraftRevision: ${error.message}`);
  }
}

function validateDraftReviewRevisionBinding(issues, route, reviewFile, state, options = {}) {
  if (!reviewFile) {
    issues.push(`${route.reviewArtifact}: missing draft review artifact`);
    return false;
  }
  const review = reviewFile.document;
  if (!validateArtifactObject(issues, route.reviewArtifact, review)) return false;
  if (review.version !== 2) issues.push(`${route.reviewArtifact}: version must be 2`);
  if (review.version === 2) validateReviewRevision(issues, route, reviewFile, state, options);
  if (review.phase !== route.retryPhase) issues.push(`${route.reviewArtifact}: phase must be ${route.retryPhase}`);
  if (review.sourceDraft !== "draft.json") issues.push(`${route.reviewArtifact}: sourceDraft must be draft.json`);
  return true;
}

function validateDraftReviewArtifact(issues, route, reviewFile, state, options = {}) {
  if (!reviewFile) return void validateDraftReviewRevisionBinding(issues, route, reviewFile, state, options);
  const review = reviewFile.document;
  if (!validateArtifactObject(issues, route.reviewArtifact, review)) return;
  for (const field of ["version", "phase", "sourceDraft", "generatedAt", "verdict", "summary", "blockingFindings", "advisoryFindings", "repairTargets"]) {
    if (!(field in review)) issues.push(`${route.reviewArtifact}: missing field ${field}`);
  }
  validateDraftReviewRevisionBinding(issues, route, reviewFile, state, options);
  validateRequiredString(issues, `${route.reviewArtifact}: generatedAt`, review.generatedAt);
  validateRequiredString(issues, `${route.reviewArtifact}: summary`, review.summary);
  if (!["PASS", "ADVISORY", "REJECTED"].includes(review.verdict)) {
    issues.push(`${route.reviewArtifact}: verdict must be PASS, ADVISORY, or REJECTED`);
  }
  for (const [arrayField, classification] of Object.entries(DRAFT_REVIEW_CLASSIFICATION_BY_ARRAY)) {
    const items = review[arrayField];
    if (!Array.isArray(items)) {
      issues.push(`${route.reviewArtifact}: ${arrayField} must be an array`);
      continue;
    }
    if (items.length > DRAFT_REVIEW_ARTIFACT_LIMIT) {
      issues.push(`${route.reviewArtifact}: ${arrayField} must contain at most ${DRAFT_REVIEW_ARTIFACT_LIMIT} items`);
    }
    for (let index = 0; index < Math.min(items.length, DRAFT_REVIEW_ARTIFACT_LIMIT); index += 1) {
      const item = items[index];
      const prefix = `${route.reviewArtifact}: ${arrayField}[${index}]`;
      validateRequiredStringFields(issues, prefix, item, DRAFT_REVIEW_ITEM_FIELDS);
      if (item?.classification !== classification) issues.push(`${prefix}.classification must be ${classification}`);
    }
  }
  const blockingCount = Array.isArray(review.blockingFindings) ? review.blockingFindings.length : 0;
  const advisoryCount = Array.isArray(review.advisoryFindings) ? review.advisoryFindings.length : 0;
  const repairTargetCount = Array.isArray(review.repairTargets) ? review.repairTargets.length : 0;
  if (review.verdict === "PASS" && blockingCount + advisoryCount + repairTargetCount > 0) {
    issues.push(`${route.reviewArtifact}: PASS cannot include findings`);
  }
  if (review.verdict === "ADVISORY" && blockingCount > 0) {
    issues.push(`${route.reviewArtifact}: ADVISORY cannot include blocking findings`);
  }
  if (review.verdict === "ADVISORY" && advisoryCount + repairTargetCount === 0) {
    issues.push(`${route.reviewArtifact}: ADVISORY requires advisory findings or repair targets`);
  }
  if (review.verdict === "REJECTED" && blockingCount === 0) {
    issues.push(`${route.reviewArtifact}: REJECTED requires at least one blocking finding`);
  }
}

function draftFindingTitleTargetKey(item) {
  return [item?.title || "", item?.target || ""].join("\0");
}

function validateDraftTriageArtifact(issues, route, review, triageFile) {
  if (!triageFile) {
    issues.push(`${route.triageArtifact}: missing draft triage artifact`);
    return [];
  }
  const triage = triageFile.document;
  if (!validateArtifactObject(issues, route.triageArtifact, triage)) return [];
  if (triage.version !== 1) issues.push(`${route.triageArtifact}: version must be 1`);
  if (triage.phase !== route.triageStepId) issues.push(`${route.triageArtifact}: phase must be ${route.triageStepId}`);
  if (triage.sourceReview !== route.reviewArtifact) issues.push(`${route.triageArtifact}: sourceReview must be ${route.reviewArtifact}`);
  validateRequiredString(issues, `${route.triageArtifact}: summary`, triage.summary);
  if (!Array.isArray(triage.items)) {
    issues.push(`${route.triageArtifact}: items must be an array`);
    return [];
  }
  if (triage.items.length > DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT) {
    issues.push(`${route.triageArtifact}: items must contain at most ${DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT} items`);
  }
  const triageItems = triage.items.slice(0, DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT);
  const requiredItems = [
    ...(Array.isArray(review.blockingFindings) ? review.blockingFindings.slice(0, DRAFT_REVIEW_ARTIFACT_LIMIT) : []),
    ...(Array.isArray(review.repairTargets) ? review.repairTargets.slice(0, DRAFT_REVIEW_ARTIFACT_LIMIT) : []),
  ];
  const requiredCounts = new Map();
  const requiredItemsByKey = new Map();
  for (const item of requiredItems) {
    const key = draftFindingTitleTargetKey(item);
    requiredCounts.set(key, (requiredCounts.get(key) || 0) + 1);
    if (!requiredItemsByKey.has(key)) requiredItemsByKey.set(key, item);
  }
  const triageCounts = new Map();
  for (let index = 0; index < triageItems.length; index += 1) {
    const item = triageItems[index];
    const prefix = `${route.triageArtifact}: items[${index}]`;
    const key = draftFindingTitleTargetKey(item);
    const seenCount = (triageCounts.get(key) || 0) + 1;
    triageCounts.set(key, seenCount);
    const requiredCount = requiredCounts.get(key) || 0;
    if (requiredCount === 0) {
      issues.push(`${prefix} must match a blocking finding or repair target from ${route.reviewArtifact}`);
    } else if (seenCount > requiredCount) {
      issues.push(`${prefix} exceeds matching source review item count`);
    }
    validateRequiredStringFields(issues, prefix, item, DRAFT_TRIAGE_ITEM_FIELDS);
    try { new DraftTriageDecision(item?.decision).assertAccepted(); }
    catch (error) { issues.push(`${prefix}.${error.message}`); }
    if (item?.decision === "apply") {
      if (!Array.isArray(item.allowedFieldPaths)) issues.push(`${prefix}.allowedFieldPaths must be an array`);
      if (!Array.isArray(item.requiredFieldPaths)) issues.push(`${prefix}.requiredFieldPaths must be an array`);
    }
  }
  for (const [key, requiredCount] of requiredCounts) {
    if ((triageCounts.get(key) || 0) < requiredCount) {
      issues.push(`${route.triageArtifact}: missing item for ${requiredItemsByKey.get(key).title}`);
    }
  }
  for (const issue of validateDraftRepairTriage(triage)) issues.push(`${route.triageArtifact}: ${issue}`);
  return triageItems;
}

function validateDraftRepairArtifact(issues, route, triageItems, repairFile) {
  if (!repairFile) {
    issues.push(`${route.repairArtifact}: missing draft repair artifact`);
    return;
  }
  const repair = repairFile.document;
  if (!validateArtifactObject(issues, route.repairArtifact, repair)) return;
  if (repair.version === 2) {
    if (repair.phase !== route.repairStepId) issues.push(`${route.repairArtifact}: phase must be ${route.repairStepId}`);
    if (repair.sourceTriage !== route.triageArtifact) issues.push(`${route.repairArtifact}: sourceTriage must be ${route.triageArtifact}`);
    if (!Array.isArray(repair.acceptedOperations)) issues.push(`${route.repairArtifact}: acceptedOperations must be an array`);
    if (!Array.isArray(repair.discardedOperations)) issues.push(`${route.repairArtifact}: discardedOperations must be an array`);
    if (!repair.audit || typeof repair.audit !== "object" || Array.isArray(repair.audit)) issues.push(`${route.repairArtifact}: audit must be an object`);
    return;
  }
  if (repair.version !== 1) issues.push(`${route.repairArtifact}: version must be 1`);
  if (repair.phase !== route.repairStepId) issues.push(`${route.repairArtifact}: phase must be ${route.repairStepId}`);
  if (repair.sourceTriage !== route.triageArtifact) issues.push(`${route.repairArtifact}: sourceTriage must be ${route.triageArtifact}`);
  validateRequiredString(issues, `${route.repairArtifact}: summary`, repair.summary);
  if (!Array.isArray(repair.items)) {
    issues.push(`${route.repairArtifact}: items must be an array`);
    return;
  }
  if (repair.items.length > DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT) {
    issues.push(`${route.repairArtifact}: items must contain at most ${DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT} items`);
  }
  const repairItems = repair.items.slice(0, DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT);
  const applyItems = triageItems.filter((item) => item?.decision === "apply");
  const applyCounts = new Map();
  const applyItemsByKey = new Map();
  for (const item of applyItems) {
    const key = draftFindingTitleTargetKey(item);
    applyCounts.set(key, (applyCounts.get(key) || 0) + 1);
    if (!applyItemsByKey.has(key)) applyItemsByKey.set(key, item);
  }
  if (repairItems.length !== applyItems.length) {
    issues.push(`${route.repairArtifact}: items length must match apply triage items length`);
  }
  const repairCounts = new Map();
  for (let index = 0; index < repairItems.length; index += 1) {
    const item = repairItems[index];
    const prefix = `${route.repairArtifact}: items[${index}]`;
    const key = draftFindingTitleTargetKey(item);
    const seenCount = (repairCounts.get(key) || 0) + 1;
    repairCounts.set(key, seenCount);
    validateRequiredStringFields(issues, prefix, item, DRAFT_REPAIR_ITEM_FIELDS);
    const applyCount = applyCounts.get(key) || 0;
    if (applyCount === 0) issues.push(`${prefix} must match an apply triage item`);
    else if (seenCount > applyCount) issues.push(`${prefix} exceeds matching apply triage item count`);
    if (!Array.isArray(item?.changedFieldPaths)) {
      issues.push(`${prefix}.changedFieldPaths must be an array`);
    } else if (item.changedFieldPaths.length > MAX_DRAFT_CHANGED_FIELD_PATHS) {
      issues.push(`${prefix}.changedFieldPaths must contain at most ${MAX_DRAFT_CHANGED_FIELD_PATHS} items`);
    } else {
      for (let changedIndex = 0; changedIndex < item.changedFieldPaths.length; changedIndex += 1) {
        validateRequiredString(issues, `${prefix}.changedFieldPaths[${changedIndex}]`, item.changedFieldPaths[changedIndex]);
      }
    }
  }
  for (const [key, applyCount] of applyCounts) {
    if ((repairCounts.get(key) || 0) < applyCount) {
      issues.push(`${route.repairArtifact}: missing item for apply triage ${applyItemsByKey.get(key).title}`);
    }
  }
}

export class DraftReviewEvidenceSet {
  constructor({ route, state, reviewFile, triageFile = null, repairFile = null }) {
    this.route = route;
    this.state = state;
    this.reviewFile = reviewFile;
    this.triageFile = triageFile;
    this.repairFile = repairFile;
    Object.freeze(this);
  }

  validateReview(options = {}) {
    const issues = [];
    validateDraftReviewArtifact(issues, this.route, this.reviewFile, this.state, options);
    return issues;
  }

  validateRevisionBinding(options = {}) {
    const issues = [];
    validateDraftReviewRevisionBinding(issues, this.route, this.reviewFile, this.state, options);
    return issues;
  }

  validateThrough(stepId = this.route.repairStepId, options = {}) {
    const issues = this.validateReview(options);
    if (!this.reviewFile) return { issues, triage: null };
    const triageItems = validateDraftTriageArtifact(
      issues,
      this.route,
      this.reviewFile.document,
      this.triageFile,
    );
    if (stepId === this.route.repairStepId) {
      validateDraftRepairArtifact(issues, this.route, triageItems, this.repairFile);
    }
    return { issues, triage: this.triageFile?.document ?? null };
  }
}
