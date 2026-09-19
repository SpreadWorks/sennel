import { createHash } from "node:crypto";

import { validateDraftLifecycleForCompletion } from "./draft-lifecycle.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCES = new Set(["coverage-pass", "coverage-repair"]);
const CONNECTOR_TOKEN = Symbol("draft-completion-connector");
const RECEIPT_TOKEN = Symbol("draft-completion-receipt");

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value, field) {
  const resolved = requiredText(value, field);
  if (!SHA256.test(resolved)) throw new Error(`${field} must be a SHA-256 digest`);
  return resolved;
}

function canonicalByteLength(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function jsonObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return freezeJson(structuredClone(value));
}

function exactObject(value, fields, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((key) => !fields.includes(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  return value;
}

/** Immutable identity of the Activity/Attempt that produced or consumes evidence. */
export class DraftCompletionAttemptIdentity {
  constructor(value, field = "draft completion Attempt") {
    exactObject(value, ["id", "sequence"], field);
    this.id = requiredText(value.id, `${field}.id`);
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
      throw new Error(`${field}.sequence is invalid`);
    }
    this.sequence = value.sequence;
    Object.freeze(this);
  }

  toJSON() { return { id: this.id, sequence: this.sequence }; }
}

/** A revision is always represented by canonical bytes, never a free-form JSON blob. */
export class DraftCompletionRevision {
  constructor(value, field = "draft completion revision") {
    exactObject(value, ["digest", "byteLength"], field);
    this.digest = canonicalDigest(value.digest, `${field}.digest`);
    this.byteLength = canonicalByteLength(value.byteLength, `${field}.byteLength`);
    Object.freeze(this);
  }

  toJSON() { return { digest: this.digest, byteLength: this.byteLength }; }
}

/** One cataloged publication and the Activity/Attempt that made it authoritative. */
export class DraftCompletionCatalogBinding {
  constructor(value, field = "draft completion catalog binding") {
    exactObject(value, ["logicalKey", "digest", "byteLength", "activityId", "attempt", "revision"], field);
    this.logicalKey = requiredText(value.logicalKey, `${field}.logicalKey`);
    this.digest = canonicalDigest(value.digest, `${field}.digest`);
    this.byteLength = canonicalByteLength(value.byteLength, `${field}.byteLength`);
    this.activityId = requiredText(value.activityId, `${field}.activityId`);
    this.attempt = value.attempt instanceof DraftCompletionAttemptIdentity
      ? value.attempt
      : new DraftCompletionAttemptIdentity(value.attempt, `${field}.attempt`);
    this.revision = value.revision === null
      ? null
      : value.revision instanceof DraftCompletionRevision
        ? value.revision
        : new DraftCompletionRevision(value.revision, `${field}.revision`);
    if (this.revision !== null && (
      this.revision.digest !== this.digest || this.revision.byteLength !== this.byteLength
    )) {
      throw new Error(`${field}.revision must identify the cataloged bytes`);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      digest: this.digest,
      byteLength: this.byteLength,
      activityId: this.activityId,
      attempt: this.attempt.toJSON(),
      revision: this.revision?.toJSON() ?? null,
    };
  }
}

/** Explicitly records a relevant lineage slot that has no canonical publication. */
export class DraftCompletionAbsentLineage {
  constructor(value, field = "draft completion absent lineage") {
    exactObject(value, ["logicalKey", "reason"], field);
    this.logicalKey = requiredText(value.logicalKey, `${field}.logicalKey`);
    this.reason = requiredText(value.reason, `${field}.reason`);
    Object.freeze(this);
  }

  toJSON() { return { logicalKey: this.logicalKey, reason: this.reason }; }
}

function lineageSlot(value, logicalKey, field) {
  const slot = value instanceof DraftCompletionCatalogBinding || value instanceof DraftCompletionAbsentLineage
    ? value
    : value?.reason !== undefined
      ? new DraftCompletionAbsentLineage(value, field)
      : new DraftCompletionCatalogBinding(value, field);
  if (slot.logicalKey !== logicalKey) throw new Error(`${field} has an invalid logicalKey`);
  return slot;
}

/** Typed, fixed-shape provenance for all evidence considered by the connector. */
export class DraftCompletionLineage {
  constructor(value) {
    exactObject(value, [
      "questionsReview", "questionsRefine", "coverageReview", "coverageTriage", "coverageRepair", "canonicalDraft",
    ], "draft completion lineage");
    this.questionsReview = lineageSlot(value.questionsReview, "draft.questions.review", "draft completion questionsReview");
    // This is the one draft publication selected as the refine provenance; it
    // is deliberately not an unbounded list of every historical draft descriptor.
    this.questionsRefine = lineageSlot(value.questionsRefine, "draft", "draft completion questionsRefine");
    this.coverageReview = lineageSlot(value.coverageReview, "draft.coverage.review", "draft completion coverageReview");
    this.coverageTriage = lineageSlot(value.coverageTriage, "draft.coverage.triage", "draft completion coverageTriage");
    this.coverageRepair = lineageSlot(value.coverageRepair, "draft.coverage.repair", "draft completion coverageRepair");
    this.canonicalDraft = lineageSlot(value.canonicalDraft, "draft", "draft completion canonicalDraft");
    Object.freeze(this);
  }

  toJSON() {
    return {
      questionsReview: this.questionsReview.toJSON(), questionsRefine: this.questionsRefine.toJSON(),
      coverageReview: this.coverageReview.toJSON(), coverageTriage: this.coverageTriage.toJSON(),
      coverageRepair: this.coverageRepair.toJSON(), canonicalDraft: this.canonicalDraft.toJSON(),
    };
  }
}

/** Typed decision summary; canonical artifacts remain the source of full triage and repair documents. */
export class DraftCompletionDecisionEvidence {
  constructor(value) {
    exactObject(value, ["reviewVerdict", "reviewDraftRevision", "source", "eligibilityIssues", "triageArtifactDigest", "repairArtifactDigest", "discardedOperationCount"], "draft completion decision evidence");
    this.reviewVerdict = requiredText(value.reviewVerdict, "draft completion decision reviewVerdict");
    this.reviewDraftRevision = value.reviewDraftRevision === null
      ? null
      : value.reviewDraftRevision instanceof DraftCompletionRevision
        ? value.reviewDraftRevision
        : new DraftCompletionRevision(value.reviewDraftRevision, "draft completion decision reviewDraftRevision");
    this.source = requiredText(value.source, "draft completion decision source");
    if (!SOURCES.has(this.source)) throw new Error("draft completion decision source is invalid");
    if (!Array.isArray(value.eligibilityIssues) || value.eligibilityIssues.some((issue) => typeof issue !== "string")) {
      throw new Error("draft completion decision eligibilityIssues is invalid");
    }
    this.eligibilityIssues = Object.freeze([...value.eligibilityIssues]);
    this.triageArtifactDigest = value.triageArtifactDigest === null ? null : canonicalDigest(value.triageArtifactDigest, "draft completion decision triageArtifactDigest");
    this.repairArtifactDigest = value.repairArtifactDigest === null ? null : canonicalDigest(value.repairArtifactDigest, "draft completion decision repairArtifactDigest");
    if (!Number.isSafeInteger(value.discardedOperationCount) || value.discardedOperationCount < 0) {
      throw new Error("draft completion decision discardedOperationCount is invalid");
    }
    this.discardedOperationCount = value.discardedOperationCount;
    Object.freeze(this);
  }

  toJSON() {
    return {
      reviewVerdict: this.reviewVerdict,
      reviewDraftRevision: this.reviewDraftRevision?.toJSON() ?? null,
      source: this.source,
      eligibilityIssues: [...this.eligibilityIssues],
      triageArtifactDigest: this.triageArtifactDigest,
      repairArtifactDigest: this.repairArtifactDigest,
      discardedOperationCount: this.discardedOperationCount,
    };
  }
}

function triageRequiresUserDecision(triage) {
  return Array.isArray(triage?.items)
    && triage.items.some((item) => item?.decision === "requires_user_decision");
}

function repairEligibilityIssues(repair) {
  if (repair === null) return ["coverage repair audit is required"];
  const audit = repair.audit;
  if (audit === null || typeof audit !== "object" || Array.isArray(audit)) {
    return ["coverage repair audit is invalid"];
  }
  const issues = [];
  if (!Array.isArray(audit.envelopeErrors) || audit.envelopeErrors.length > 0) {
    issues.push("coverage repair envelope is incomplete");
  }
  if (audit.baseRevisionMatches !== true) issues.push("coverage repair base revision is stale");
  if (!Array.isArray(audit.missingRequiredTargets) || audit.missingRequiredTargets.length > 0) {
    issues.push("coverage repair has missing required targets");
  }
  if (!Array.isArray(audit.lifecycleIssues) || audit.lifecycleIssues.length > 0) {
    issues.push("coverage repair retains lifecycle issues");
  }
  return issues;
}

/**
 * Immutable canonical facts at the one draft-coverage-repair to draft-gate
 * connection. Facts describe the already observed review or repair outcome;
 * they do not select a route or mutate a draft.
 */
export class DraftCompletionFacts {
  constructor({
    source,
    sourceStepId,
    targetStepId,
    draft,
    draftDigest,
    draftByteLength,
    reviewDraftDigest = null,
    reviewArtifactDigest,
    triageArtifactDigest = null,
    questionsReviewArtifactDigest,
    reviewVerdict,
    triage = null,
    repair = null,
  } = {}) {
    this.source = requiredText(source, "draft completion source");
    if (!SOURCES.has(this.source)) throw new Error("draft completion source is invalid");
    this.sourceStepId = requiredText(sourceStepId, "draft completion source step");
    this.targetStepId = requiredText(targetStepId, "draft completion target step");
    if (!((this.source === "coverage-pass" && this.sourceStepId === "draft-coverage-review")
      || this.sourceStepId === "draft-coverage-repair") || this.targetStepId !== "draft-gate") {
      throw new Error("draft completion connector has an invalid source or target");
    }
    this.draft = jsonObject(draft, "draft completion draft");
    this.draftDigest = canonicalDigest(draftDigest, "draft completion draft digest");
    this.draftByteLength = canonicalByteLength(draftByteLength, "draft completion draft byteLength");
    this.draftDocumentDigest = digest(this.draft);
    this.reviewVerdict = requiredText(reviewVerdict, "draft completion review verdict");
    this.reviewDraftDigest = typeof reviewDraftDigest === "string" && SHA256.test(reviewDraftDigest)
      ? reviewDraftDigest
      : null;
    this.reviewArtifactDigest = canonicalDigest(reviewArtifactDigest, "draft completion review artifact digest");
    this.triageArtifactDigest = triageArtifactDigest === null ? null : canonicalDigest(triageArtifactDigest, "draft completion triage artifact digest");
    this.questionsReviewArtifactDigest = canonicalDigest(
      questionsReviewArtifactDigest,
      "draft completion questions review artifact digest",
    );
    this.triage = triage === null ? null : jsonObject(triage, "draft completion triage");
    this.repair = repair === null ? null : jsonObject(repair, "draft completion repair");
    this.triageDocumentDigest = this.triage === null ? null : digest(this.triage);
    this.repairDocumentDigest = this.repair === null ? null : digest(this.repair);
    if ((this.triageArtifactDigest === null) !== (this.triage === null)) {
      throw new Error("draft completion triage document and publication digest must be supplied together");
    }
    this.eligibilityIssues = Object.freeze(this.#eligibilityIssues());
    Object.freeze(this);
  }

  #eligibilityIssues() {
    const issues = [];
    issues.push(...validateDraftLifecycleForCompletion(this.draft));
    if (this.reviewDraftDigest === null || this.reviewDraftDigest !== this.draftDigest) {
      issues.push("coverage review is stale for the canonical draft revision");
    }
    if (this.source === "coverage-pass") {
      if (this.reviewVerdict !== "PASS") issues.push("coverage review did not pass");
      if ((this.triage === null) !== (this.repair === null)) {
        issues.push("coverage pass operational triage and repair evidence must be supplied together");
      }
      if (triageRequiresUserDecision(this.triage)) issues.push("coverage completion requires user decision");
      if (this.repair !== null) issues.push(...repairEligibilityIssues(this.repair));
      return issues;
    }
    if (!new Set(["ADVISORY", "REJECTED"]).has(this.reviewVerdict)) {
      issues.push("coverage repair requires a non-pass coverage review");
    }
    if (this.triageArtifactDigest === null) issues.push("coverage repair triage publication is required");
    if (this.triage === null) issues.push("coverage repair triage is required");
    if (triageRequiresUserDecision(this.triage)) issues.push("coverage repair requires user decision");
    issues.push(...repairEligibilityIssues(this.repair));
    return issues;
  }

  get eligible() { return this.eligibilityIssues.length === 0; }

  toJSON() {
    return {
      source: this.source,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      draftDigest: this.draftDigest,
      draftByteLength: this.draftByteLength,
      draftDocumentDigest: this.draftDocumentDigest,
      reviewVerdict: this.reviewVerdict,
      reviewDraftDigest: this.reviewDraftDigest,
      reviewArtifactDigest: this.reviewArtifactDigest,
      triageArtifactDigest: this.triageArtifactDigest,
      questionsReviewArtifactDigest: this.questionsReviewArtifactDigest,
      triageDocumentDigest: this.triageDocumentDigest,
      repairDocumentDigest: this.repairDocumentDigest,
      eligibilityIssues: [...this.eligibilityIssues],
    };
  }
}

/** A sealed Definition-selected connector for an eligible canonical draft. */
export class DraftCompletionConnector {
  constructor(token, facts) {
    if (token !== CONNECTOR_TOKEN || !(facts instanceof DraftCompletionFacts)) {
      throw new Error("DraftCompletionConnector is created only by the definition resolver");
    }
    if (!facts.eligible) throw new Error("DraftCompletionConnector requires eligible canonical facts");
    this.source = facts.source;
    this.sourceStepId = facts.sourceStepId;
    this.targetStepId = facts.targetStepId;
    this.expectedDraftDigest = facts.draftDigest;
    this.expectedDraftByteLength = facts.draftByteLength;
    this.expectedDraftDocumentDigest = facts.draftDocumentDigest;
    this.reviewVerdict = facts.reviewVerdict;
    this.reviewDraftDigest = facts.reviewDraftDigest;
    this.receiptId = createHash("sha256").update(stableJson({
      source: this.source,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      expectedDraftDigest: this.expectedDraftDigest,
      expectedDraftByteLength: this.expectedDraftByteLength,
      expectedDraftDocumentDigest: this.expectedDraftDocumentDigest,
      reviewVerdict: this.reviewVerdict,
      reviewDraftDigest: this.reviewDraftDigest,
    })).digest("hex");
    Object.freeze(this);
  }

  applyTo(draft) {
    if (draftCompletionDocumentDigest(draft) !== this.expectedDraftDocumentDigest) {
      throw new Error("draft completion connector rejected a stale draft revision");
    }
    return structuredClone(draft);
  }

  toJSON() {
    return {
      connector: "draft-completion",
      source: this.source,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      expectedDraftDigest: this.expectedDraftDigest,
      expectedDraftByteLength: this.expectedDraftByteLength,
      expectedDraftDocumentDigest: this.expectedDraftDocumentDigest,
      reviewVerdict: this.reviewVerdict,
      reviewDraftDigest: this.reviewDraftDigest,
      receiptId: this.receiptId,
    };
  }
}

/**
 * Immutable, durable evidence for a Definition-owned Step connection.  This
 * is deliberately not an artifact-ref flag: it binds the selected connector
 * to the source Attempt, the exact input/output revisions, and every review and
 * repair publication that informed the decision.
 */
export class StepConnectionReceipt {
  constructor(token, {
    connector, sourceAttempt, draftInput, draftOutput,
    lineage, decisionEvidence,
  } = {}) {
    if (token !== RECEIPT_TOKEN || !(connector instanceof DraftCompletionConnector)) {
      throw new Error("StepConnectionReceipt is created only by the connector transition plan");
    }
    this.kind = "draft-completion";
    this.source = connector.source;
    this.sourceStepId = connector.sourceStepId;
    this.targetStepId = connector.targetStepId;
    this.sourceAttempt = sourceAttempt instanceof DraftCompletionAttemptIdentity
      ? sourceAttempt : new DraftCompletionAttemptIdentity(sourceAttempt, "draft completion sourceAttempt");
    this.draftInput = draftInput instanceof DraftCompletionRevision
      ? draftInput : new DraftCompletionRevision(draftInput, "draft completion draftInput");
    this.draftOutput = draftOutput instanceof DraftCompletionRevision
      ? draftOutput : new DraftCompletionRevision(draftOutput, "draft completion draftOutput");
    this.lineage = lineage instanceof DraftCompletionLineage ? lineage : new DraftCompletionLineage(lineage);
    this.decisionEvidence = decisionEvidence instanceof DraftCompletionDecisionEvidence
      ? decisionEvidence : new DraftCompletionDecisionEvidence(decisionEvidence);
    assertReceiptConsistency(this);
    this.id = createHash("sha256").update(stableJson({
      kind: this.kind, source: this.source, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId,
      sourceAttempt: this.sourceAttempt.toJSON(), draftInput: this.draftInput.toJSON(), draftOutput: this.draftOutput.toJSON(),
      lineage: this.lineage.toJSON(), decisionEvidence: this.decisionEvidence.toJSON(),
    })).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind, id: this.id, source: this.source,
      sourceStepId: this.sourceStepId, targetStepId: this.targetStepId,
      sourceAttempt: this.sourceAttempt.toJSON(),
      draftInput: this.draftInput.toJSON(), draftOutput: this.draftOutput.toJSON(),
      lineage: this.lineage.toJSON(), decisionEvidence: this.decisionEvidence.toJSON(),
    };
  }

  /** Exact replay identity excludes transaction-local Activity ids but binds every selected fact and output byte. */
  matchesReplay({ connector, facts, publishedDraft, repairArtifactBytes = null } = {}) {
    if (!(facts instanceof DraftCompletionFacts)) return false;
    if (!(connector instanceof DraftCompletionConnector)) return false;
    const outputBytes = Buffer.from(`${JSON.stringify(publishedDraft, null, 2)}\n`, "utf8");
    const repairArtifactDigest = repairArtifactBytes === null
      ? null
      : createHash("sha256").update(repairArtifactBytes).digest("hex");
    const lineageDigest = (slot) => slot instanceof DraftCompletionCatalogBinding ? slot.digest : null;
    return this.kind === "draft-completion"
      && this.source === facts.source
      && this.sourceStepId === facts.sourceStepId
      && this.targetStepId === facts.targetStepId
      && this.draftInput.digest === facts.draftDigest
      && this.draftInput.byteLength === facts.draftByteLength
      && this.draftOutput.digest === createHash("sha256").update(outputBytes).digest("hex")
      && this.draftOutput.byteLength === outputBytes.length
      && this.decisionEvidence.reviewVerdict === facts.reviewVerdict
      && (this.decisionEvidence.reviewDraftRevision?.digest ?? null) === facts.reviewDraftDigest
      && (this.decisionEvidence.reviewDraftRevision?.byteLength ?? null)
        === (facts.reviewDraftDigest === null ? null : facts.draftByteLength)
      && this.decisionEvidence.source === facts.source
      && stableJson(this.decisionEvidence.eligibilityIssues) === stableJson([...facts.eligibilityIssues])
      && this.decisionEvidence.triageArtifactDigest === facts.triageArtifactDigest
      && this.decisionEvidence.repairArtifactDigest === repairArtifactDigest
      && this.decisionEvidence.discardedOperationCount === (facts.repair?.discardedOperations?.length ?? 0)
      && lineageDigest(this.lineage.questionsReview) === facts.questionsReviewArtifactDigest
      && lineageDigest(this.lineage.coverageReview) === facts.reviewArtifactDigest
      && lineageDigest(this.lineage.coverageTriage) === facts.triageArtifactDigest
      && lineageDigest(this.lineage.coverageRepair) === repairArtifactDigest;
  }

  /**
   * Restore the draft-owned typed view of a receipt read from an Activity.
   * The Activity ledger intentionally persists plain JSON, but consumers that
   * need to reason about completion evidence must not fall back to untyped
   * property access.  Recompute the content-bound id while hydrating so a
   * changed lineage cannot masquerade as the original receipt.
   */
  static fromJSON(value) {
    if (value instanceof StepConnectionReceipt) return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("draft completion receipt must be an object");
    }
    exactObject(value, [
      "kind", "id", "source", "sourceStepId", "targetStepId", "sourceAttempt",
      "draftInput", "draftOutput", "lineage", "decisionEvidence",
    ], "draft completion receipt");
    const receipt = Object.create(StepConnectionReceipt.prototype);
    receipt.kind = requiredText(value.kind, "draft completion receipt kind");
    if (receipt.kind !== "draft-completion") {
      throw new Error("draft completion receipt kind is invalid");
    }
    receipt.source = requiredText(value.source, "draft completion receipt source");
    if (!SOURCES.has(receipt.source)) throw new Error("draft completion receipt source is invalid");
    receipt.sourceStepId = requiredText(value.sourceStepId, "draft completion receipt source step");
    receipt.targetStepId = requiredText(value.targetStepId, "draft completion receipt target step");
    if (!["draft-coverage-review", "draft-coverage-repair"].includes(receipt.sourceStepId) || receipt.targetStepId !== "draft-gate") {
      throw new Error("draft completion receipt route is invalid");
    }
    receipt.sourceAttempt = new DraftCompletionAttemptIdentity(value.sourceAttempt, "draft completion receipt sourceAttempt");
    receipt.draftInput = new DraftCompletionRevision(value.draftInput, "draft completion receipt draftInput");
    receipt.draftOutput = new DraftCompletionRevision(value.draftOutput, "draft completion receipt draftOutput");
    receipt.lineage = new DraftCompletionLineage(value.lineage);
    receipt.decisionEvidence = new DraftCompletionDecisionEvidence(value.decisionEvidence);
    assertReceiptConsistency(receipt);
    const id = requiredText(value.id, "draft completion receipt id");
    const expectedId = createHash("sha256").update(stableJson({
      kind: receipt.kind, source: receipt.source, sourceStepId: receipt.sourceStepId, targetStepId: receipt.targetStepId,
      sourceAttempt: receipt.sourceAttempt.toJSON(), draftInput: receipt.draftInput.toJSON(), draftOutput: receipt.draftOutput.toJSON(),
      lineage: receipt.lineage.toJSON(), decisionEvidence: receipt.decisionEvidence.toJSON(),
    })).digest("hex");
    if (id !== expectedId) throw new Error("draft completion receipt content digest is invalid");
    receipt.id = id;
    return Object.freeze(receipt);
  }
}

function assertReceiptConsistency(receipt) {
  if (receipt.decisionEvidence.source !== receipt.source) {
    throw new Error("draft completion receipt decision source is inconsistent");
  }
  if (!(receipt.lineage.canonicalDraft instanceof DraftCompletionCatalogBinding)
    || receipt.lineage.canonicalDraft.digest !== receipt.draftInput.digest
    || receipt.lineage.canonicalDraft.byteLength !== receipt.draftInput.byteLength) {
    throw new Error("draft completion receipt canonical draft lineage is inconsistent");
  }
}

export function createDraftCompletionReceipt({ connector, sourceAttempt, draftInput, publishedDraft, publishedDraftBytes = null, lineage, decisionEvidence } = {}) {
  if (!(connector instanceof DraftCompletionConnector)) throw new Error("draft completion receipt requires a DraftCompletionConnector");
  const bytes = publishedDraftBytes === null
    ? Buffer.from(`${JSON.stringify(publishedDraft, null, 2)}\n`, "utf8")
    : Buffer.from(publishedDraftBytes);
  return new StepConnectionReceipt(RECEIPT_TOKEN, {
    connector, sourceAttempt, draftInput,
    draftOutput: { digest: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length },
    lineage, decisionEvidence,
  });
}

export function createDraftCompletionConnector(facts) {
  return new DraftCompletionConnector(CONNECTOR_TOKEN, facts);
}

export function isDraftCompletionConnector(value) {
  return value instanceof DraftCompletionConnector;
}

/** Read a catalog descriptor as Definition evidence without granting an
 * unrelated worker direct access to the artifact body. */
export function readDraftCompletionCatalogDigest({ flowManager, specId, logicalKey } = {}) {
  const artifactDigest = flowManager.readCanonicalTransitionView({
    specId,
    read: (view) => view.catalog.artifacts.find((artifact) => artifact.logicalKey === logicalKey)?.hash ?? null,
  });
  if (artifactDigest === null) throw new Error(`draft completion requires canonical ${logicalKey} lineage`);
  return artifactDigest;
}

/** Read only the cataloged coverage PASS evidence and its exact draft input. */
export function readCoveragePassDraftCompletionFacts({ flowManager, specId, sourceStepId = "draft-coverage-review" } = {}) {
  const draft = flowManager.readArtifact({
    specId, logicalKey: "draft", consumerNodeId: sourceStepId,
  });
  const review = flowManager.readArtifact({
    specId, logicalKey: "draft.coverage.review", consumerNodeId: sourceStepId,
  });
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "draft.coverage.review", bytes: review.bytes,
  });
  const document = history.attempts.at(-1)?.payload ?? null;
  if (document === null) throw new Error("coverage review history has no current document");
  const questionsReviewArtifactDigest = readDraftCompletionCatalogDigest({
    flowManager, specId, logicalKey: "draft.questions.review",
  });
  return new DraftCompletionFacts({
    source: "coverage-pass",
    sourceStepId,
    targetStepId: "draft-gate",
    draft: JSON.parse(draft.bytes.toString("utf8")),
    draftDigest: draft.descriptor.hash,
    draftByteLength: draft.descriptor.size,
    reviewVerdict: document.verdict,
    reviewDraftDigest: document.sourceDraftRevision?.digest ?? null,
    reviewArtifactDigest: review.descriptor.hash,
    questionsReviewArtifactDigest,
  });
}

export function draftCompletionDocumentDigest(draft) {
  return digest(jsonObject(draft, "draft completion document"));
}
