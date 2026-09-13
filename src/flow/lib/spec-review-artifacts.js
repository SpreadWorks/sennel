import crypto from "node:crypto";
import { FlowSpecRevision } from "../../lib/flow-version.js";
import { SpecRevisionIdentity } from "./spec-revision-identity.js";

const TRIAGE_DISPOSITIONS = new Set(["apply", "invalid", "already_resolved", "downgraded_to_non_blocking"]);
const BLOCKING_FINDING_KEYS = ["body", "findingId", "issue", "kind", "requiredChange", "target", "title", "whyBlocking"];
const IMPROVEMENT_FINDING_KEYS = ["body", "findingId", "improvement", "kind", "target", "title", "whyNonBlocking"];
const SPEC_REVIEW_DELTA_IDENTITY_SCHEMA = Object.freeze({
  type: "object",
  required: ["specId", "revision", "digest", "byteLength"],
  properties: {
    specId: { type: "string", pattern: "\\S" },
    revision: { type: "integer", minimum: 1 },
    digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    byteLength: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
});
const SPEC_TRIAGE_DELTA_PAYLOAD_SCHEMA = Object.freeze({
  type: "object",
  required: ["version", "stage", "identity", "baseReviewDigest", "findings", "operations"],
  properties: {
    version: { type: "integer", const: 2 },
    stage: { type: "string", const: "spec-triage" },
    identity: SPEC_REVIEW_DELTA_IDENTITY_SCHEMA,
    baseReviewDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    findings: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            required: ["findingId", "disposition", "evidence", "allowedTargets"],
            properties: {
              findingId: { type: "string", pattern: "\\S" },
              disposition: { type: "string", const: "apply" },
              evidence: { type: "string", pattern: "\\S" },
              allowedTargets: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["target", "operationKinds"],
                  properties: {
                    target: { type: "object", additionalProperties: true },
                    operationKinds: {
                      type: "array",
                      minItems: 1,
                      uniqueItems: true,
                      items: { type: "string", pattern: "\\S" },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["findingId", "disposition", "evidence"],
            properties: {
              findingId: { type: "string", pattern: "\\S" },
              disposition: {
                type: "string",
                enum: ["invalid", "already_resolved", "downgraded_to_non_blocking"],
              },
              evidence: { type: "string", pattern: "\\S" },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    operations: { type: "array", maxItems: 0 },
  },
  additionalProperties: false,
});
const SPEC_REPAIR_DELTA_PAYLOAD_SCHEMA = Object.freeze({
  type: "object",
  required: ["version", "stage", "identity", "baseReviewDigest", "findings", "operations"],
  properties: {
    version: { type: "integer", const: 2 },
    stage: { type: "string", const: "spec-repair" },
    identity: SPEC_REVIEW_DELTA_IDENTITY_SCHEMA,
    baseReviewDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    findings: { type: "array", maxItems: 0 },
    // Operation semantics are intentionally parent-owned. Invalid siblings
    // are audited and discarded without rejecting the complete delta.
    operations: { type: "array", items: { type: "object" } },
    scopeExpansions: { type: "array" },
  },
  additionalProperties: false,
});

/** Stable JSON is an identity format, rather than a presentation format. */
export function canonicalSpecReviewJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSpecReviewJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSpecReviewJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}
/** The digest is the exact cataloged JSON artifact bytes, not a compact surrogate. */
function reviewDigest(document) { return crypto.createHash("sha256").update(`${JSON.stringify(canonicalValue(document), null, 2)}\n`, "utf8").digest("hex"); }
function nonEmpty(value) { return typeof value === "string" && value.trim() !== ""; }
function artifactError(issues) { const error = new Error(issues.join("; ")); error.code = "SPEC_REVIEW_ARTIFACT_INVALID"; error.issues = Object.freeze([...issues]); return error; }
function requiredText(value, field) { if (!nonEmpty(value)) throw artifactError([`${field} requires non-empty text`]); return value.trim(); }
function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw artifactError([`${field} must be an object`]);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw artifactError([`${field} has an invalid schema`]);
}
function optionalKeys(value, required, optional, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw artifactError([`${field} has an invalid schema`]);
}

export { FlowSpecRevision as SpecRevision };
export { SpecRevisionIdentity } from "./spec-revision-identity.js";

/**
 * The first review of a revision is derived by the parent from its immutable
 * Spec snapshot.  It is an input seed, not a persisted placeholder: the
 * first spec-review confirmation is the only operation that may publish it.
 */
export function initialCanonicalSpecReview({ specId, revision, bytes } = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "", "utf8");
  return new CanonicalSpecReview({
    version: 2,
    identity: {
      specId: requiredText(specId, "initial spec review specId"),
      revision: FlowSpecRevision.from(revision).value,
      digest: crypto.createHash("sha256").update(source).digest("hex"),
      byteLength: source.length,
    },
    generation: 0,
    findings: [],
    audit: [],
  });
}

/** The full reviewer finding schema. Triage fields are the only mutable suffix. */
export class SpecReviewFinding {
  constructor(value) {
    const baseKeys = value?.kind === "blocking" ? BLOCKING_FINDING_KEYS : value?.kind === "improvement" ? IMPROVEMENT_FINDING_KEYS : null;
    if (baseKeys === null) throw artifactError(["spec review finding kind must be blocking or improvement"]);
    optionalKeys(value, baseKeys, ["disposition", "evidence", "allowedTargets"], "spec review finding");
    for (const key of baseKeys) requiredText(value[key], `spec review finding.${key}`);
    if (Object.hasOwn(value, "disposition")) {
      if (!TRIAGE_DISPOSITIONS.has(value.disposition) || !nonEmpty(value.evidence)) throw artifactError(["canonical spec review triage fields are invalid"]);
      if (value.disposition === "apply") {
        if (!Array.isArray(value.allowedTargets) || value.allowedTargets.length === 0) throw artifactError(["canonical apply finding requires allowedTargets"]);
        value.allowedTargets.forEach((target, index) => new SpecReviewAllowedTarget(target, `spec review finding.allowedTargets[${index}]`));
      } else if (Object.hasOwn(value, "allowedTargets")) throw artifactError(["only apply finding may declare allowedTargets"]);
    } else if (Object.hasOwn(value, "evidence") || Object.hasOwn(value, "allowedTargets")) throw artifactError(["untriaged finding cannot declare triage fields"]);
    this.value = Object.freeze(structuredClone(value)); Object.freeze(this);
  }
  get findingId() { return this.value.findingId; }
  withTriage(update) {
    if (!(update instanceof SpecTriageFindingUpdate)) throw artifactError(["triage update must be typed"]);
    const { disposition, evidence, allowedTargets, ...base } = this.value;
    return new SpecReviewFinding({ ...base, ...update.toJSON() });
  }
  toJSON() { return structuredClone(this.value); }
}

/** A typed triage capability. Detailed target/kind compatibility is checked again by repair. */
export class SpecReviewAllowedTarget {
  constructor(value, field = "allowedTargets") {
    exactKeys(value, ["operationKinds", "target"], field);
    if (!value.target || typeof value.target !== "object" || Array.isArray(value.target)) throw artifactError([`${field}.target must be an object`]);
    if (!Array.isArray(value.operationKinds) || value.operationKinds.length === 0 || value.operationKinds.some((kind) => !nonEmpty(kind)) || new Set(value.operationKinds).size !== value.operationKinds.length) throw artifactError([`${field}.operationKinds must be a non-empty unique string array`]);
    this.target = Object.freeze(structuredClone(value.target)); this.operationKinds = Object.freeze([...value.operationKinds]); Object.freeze(this);
  }
  toJSON() { return { target: structuredClone(this.target), operationKinds: [...this.operationKinds] }; }
}

/** Triage can classify an existing finding but never restate or change it. */
export class SpecTriageFindingUpdate {
  constructor(value) {
    optionalKeys(value, ["findingId", "disposition", "evidence"], ["allowedTargets"], "spec triage finding");
    this.findingId = requiredText(value.findingId, "spec triage finding.findingId");
    if (!TRIAGE_DISPOSITIONS.has(value.disposition)) throw artifactError(["spec triage finding disposition is invalid"]);
    this.disposition = value.disposition; this.evidence = requiredText(value.evidence, "spec triage finding.evidence");
    if (this.disposition === "apply") {
      if (!Array.isArray(value.allowedTargets) || value.allowedTargets.length === 0) throw artifactError(["spec triage apply finding requires allowedTargets"]);
      this.allowedTargets = Object.freeze(value.allowedTargets.map((target, index) => new SpecReviewAllowedTarget(target, `spec triage finding.allowedTargets[${index}]`)));
    } else if (Object.hasOwn(value, "allowedTargets")) throw artifactError(["only apply triage finding may declare allowedTargets"]);
    else this.allowedTargets = null;
    Object.freeze(this);
  }
  toJSON() { return { findingId: this.findingId, disposition: this.disposition, evidence: this.evidence, ...(this.allowedTargets === null ? {} : { allowedTargets: this.allowedTargets.map((target) => target.toJSON()) }) }; }
}

/** The worker-facing schema is stage-specific; equality with inputs is parent-owned. */
export function specTriageDeltaPayloadSchema() {
  return structuredClone(SPEC_TRIAGE_DELTA_PAYLOAD_SCHEMA);
}

/** The repair worker receives its full immutable-input-bound envelope. */
export function specRepairDeltaPayloadSchema() {
  return structuredClone(SPEC_REPAIR_DELTA_PAYLOAD_SCHEMA);
}

/**
 * Validate only the producer-controlled JSON shape. Finding meaning, target
 * authority, and canonical finding membership remain parent/gate concerns.
 */
export function validateSpecTriageDeltaFormat(document) {
  const delta = new SpecReviewDelta(document);
  if (delta.stage !== "spec-triage") {
    throw artifactError(["spec triage review delta has an invalid stage"]);
  }
  if (document.operations.length !== 0 || Object.hasOwn(document, "scopeExpansions")) {
    throw artifactError(["spec triage review delta must not declare repair operations or scope expansions"]);
  }
  for (const finding of document.findings) new SpecTriageFindingUpdate(finding);
  return delta;
}

/**
 * Validate the producer-controlled repair envelope only. Individual repair
 * operations stay independently discardable in the parent-owned applicator.
 */
export function validateSpecRepairDeltaFormat(document) {
  const delta = new SpecReviewDelta(document);
  if (delta.stage !== "spec-repair") {
    throw artifactError(["spec repair review delta has an invalid stage"]);
  }
  if (document.findings.length !== 0) {
    throw artifactError(["spec repair review delta must not update findings"]);
  }
  return delta;
}

/** The triage suffix is a value collection, not an untyped findings bag. */
export class SpecTriageFindingUpdateCollection {
  constructor(updates = []) {
    if (!Array.isArray(updates)) throw artifactError(["spec triage finding updates must be an array"]);
    this.findings = Object.freeze(updates.map((update) => (
      update instanceof SpecTriageFindingUpdate ? update : new SpecTriageFindingUpdate(update)
    )));
    if (new Set(this.findings.map((finding) => finding.findingId)).size !== this.findings.length) {
      throw artifactError(["spec triage finding updates must not duplicate findingId values"]);
    }
    Object.freeze(this);
  }
  byId(id) { return this.findings.find((finding) => finding.findingId === id) ?? null; }
  toJSON() { return this.findings.map((finding) => finding.toJSON()); }
}

export class SpecReviewFindingCollection {
  constructor(findings = []) {
    if (!Array.isArray(findings)) throw artifactError(["canonical spec review findings must be an array"]);
    this.findings = Object.freeze(findings.map((finding) => finding instanceof SpecReviewFinding ? finding.toJSON() : new SpecReviewFinding(finding).toJSON()));
    if (new Set(this.findings.map((finding) => finding.findingId)).size !== this.findings.length) throw artifactError(["canonical spec review findings must not duplicate findingId values"]);
    Object.freeze(this);
  }
  byId(id) { return this.findings.find((finding) => finding.findingId === id) ?? null; }
  replace(updates) { const values = new Map(updates.map((finding) => [finding.findingId, finding])); return new SpecReviewFindingCollection(this.findings.map((finding) => values.get(finding.findingId) ?? finding)); }
}

/** Parent-produced audit proof for one generation publication. */
export class SpecReviewAuditEntry {
  constructor(value) {
    optionalKeys(value,
      ["stage", "inputDigest", "relation", "outcome", "acceptedOperations", "discardedOperations", "appliedFindings", "operationDigest"],
      ["activityId"], "canonical spec review audit");
    if (!["spec-review", "spec-triage", "spec-repair"].includes(value.stage)
      || !/^[a-f0-9]{64}$/.test(value.inputDigest)
      || value.relation !== "revision-scoped-canonical-review"
      || !["replaced", "merged", "no-op"].includes(value.outcome)
      || !Array.isArray(value.acceptedOperations) || !Array.isArray(value.discardedOperations)
      || !Array.isArray(value.appliedFindings) || !/^[a-f0-9]{64}$/.test(value.operationDigest)
      || (Object.hasOwn(value, "activityId") && !nonEmpty(value.activityId))) {
      throw artifactError(["canonical spec review audit has invalid fields"]);
    }
    if (value.appliedFindings.some((id) => !nonEmpty(id))
      || new Set(value.appliedFindings).size !== value.appliedFindings.length
      || value.appliedFindings.some((id, index) => index > 0 && value.appliedFindings[index - 1] > id)) {
      throw artifactError(["canonical spec review audit appliedFindings must be sorted unique IDs"]);
    }
    const expectedDigest = reviewDigest({ acceptedOperations: value.acceptedOperations, discardedOperations: value.discardedOperations, appliedFindings: value.appliedFindings });
    if (value.operationDigest !== expectedDigest) throw artifactError(["canonical spec review audit operationDigest is forged"]);
    this.value = Object.freeze(structuredClone(value)); Object.freeze(this);
  }
  toJSON() { return structuredClone(this.value); }
}

export class CanonicalSpecReview {
  constructor(document) {
    const expected = ["version", "identity", "generation", "findings", "audit"];
    if (!document || typeof document !== "object" || Array.isArray(document) || Object.keys(document).length !== expected.length || expected.some((key) => !Object.hasOwn(document, key))) throw artifactError(["canonical review has an invalid schema"]);
    if (document.version !== 2) throw artifactError(["canonical review version must be 2"]);
    this.identity = new SpecRevisionIdentity(document.identity);
    if (!Number.isSafeInteger(document.generation) || document.generation < 0) throw artifactError(["canonical review generation must be a non-negative safe integer"]);
    this.generation = document.generation; this.findings = new SpecReviewFindingCollection(document.findings);
    if (!Array.isArray(document.audit)) throw artifactError(["canonical review audit must be an array"]);
    this.audit = Object.freeze(document.audit.map((entry) => new SpecReviewAuditEntry(entry).toJSON()));
    Object.freeze(this);
  }
  get digest() { return reviewDigest(this.toJSON()); }
  toJSON() { return canonicalValue({ version: 2, identity: this.identity.toJSON(), generation: this.generation, findings: this.findings.findings, audit: this.audit }); }
}

function discardedFinding(value, reason) { return Object.freeze({ findingId: typeof value?.findingId === "string" ? value.findingId : null, reason }); }
function discardedOperation(value, reason) { return Object.freeze({ findingIds: Array.isArray(value?.findingIds) ? value.findingIds.filter((id) => typeof id === "string") : [], kind: typeof value?.kind === "string" ? value.kind : null, target: value?.target && typeof value.target === "object" && !Array.isArray(value.target) ? structuredClone(value.target) : null, operationDigest: reviewDigest(value), reason }); }
function deduplicateFindingUpdates(values, invalid, label) {
  const groups = new Map();
  for (const value of values) {
    const id = value.findingId;
    const group = groups.get(id) ?? [];
    group.push(value); groups.set(id, group);
  }
  const unique = [];
  for (const group of groups.values()) {
    if (group.length === 1 || group.every((value) => canonicalSpecReviewJson(value.toJSON?.() ?? value) === canonicalSpecReviewJson(group[0].toJSON?.() ?? group[0]))) {
      unique.push(group[0]);
    } else {
      for (const value of group) invalid.push(discardedFinding(value, label));
    }
  }
  return unique;
}

/** Worker output is full-input-bound and stage-typed. Malformed individual pieces are discarded, not retried. */
export class SpecReviewDelta {
  constructor(document, {
    inheritedDiscardedFindings = [],
    inheritedDiscardedOperations = [],
  } = {}) {
    const expected = ["version", "stage", "identity", "baseReviewDigest", "findings", "operations"];
    if (!document || typeof document !== "object" || Array.isArray(document) || expected.some((key) => !Object.hasOwn(document, key)) || Object.keys(document).some((key) => !expected.includes(key) && key !== "scopeExpansions")) throw artifactError(["spec review delta has an invalid schema"]);
    if (document.version !== 2 || !["spec-review", "spec-triage", "spec-repair"].includes(document.stage)) throw artifactError(["spec review delta has an invalid stage"]);
    if (!Array.isArray(document.findings) || !Array.isArray(document.operations)) throw artifactError(["spec review delta findings and operations must be arrays"]);
    this.stage = document.stage; this.identity = new SpecRevisionIdentity(document.identity);
    if (typeof document.baseReviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(document.baseReviewDigest)) throw artifactError(["spec review delta requires baseReviewDigest"]);
    this.baseReviewDigest = document.baseReviewDigest;
    if (!Array.isArray(inheritedDiscardedFindings) || !Array.isArray(inheritedDiscardedOperations)) {
      throw new Error("spec review delta inherited audit entries must be arrays");
    }
    const invalidFindings = [...inheritedDiscardedFindings];
    if (this.stage === "spec-review") {
      const findings = [];
      for (const finding of document.findings) {
        try {
          if (Object.hasOwn(finding ?? {}, "disposition") || Object.hasOwn(finding ?? {}, "evidence") || Object.hasOwn(finding ?? {}, "allowedTargets")) throw artifactError(["spec-review cannot classify or authorize findings"]);
          findings.push(new SpecReviewFinding(finding).toJSON());
        } catch (cause) { invalidFindings.push(discardedFinding(finding, cause.message)); }
      }
      const typed = deduplicateFindingUpdates(findings.map((finding) => new SpecReviewFinding(finding)), invalidFindings, "conflicting duplicate finding");
      this.findings = new SpecReviewFindingCollection(typed);
    } else if (this.stage === "spec-triage") {
      const updates = [];
      for (const finding of document.findings) { try { updates.push(new SpecTriageFindingUpdate(finding)); } catch (cause) { invalidFindings.push(discardedFinding(finding, cause.message)); } }
      this.findings = new SpecTriageFindingUpdateCollection(
        deduplicateFindingUpdates(updates, invalidFindings, "conflicting duplicate triage update"),
      );
    } else {
      this.findings = new SpecReviewFindingCollection([]);
      for (const finding of document.findings) invalidFindings.push(discardedFinding(finding, "spec-repair cannot update findings"));
    }
    const invalidOperations = [...inheritedDiscardedOperations];
    this.operations = this.stage === "spec-repair" ? Object.freeze(structuredClone(document.operations)) : Object.freeze(document.operations.flatMap((operation) => { invalidOperations.push(discardedOperation(operation, `${this.stage} cannot propose repair operations`)); return []; }));
    if (document.scopeExpansions !== undefined && !Array.isArray(document.scopeExpansions)) throw artifactError(["spec review delta scopeExpansions must be an array when present"]);
    this.scopeExpansions = this.stage === "spec-repair" ? Object.freeze(structuredClone(document.scopeExpansions ?? [])) : Object.freeze([]);
    if (this.stage !== "spec-repair") for (const proposal of document.scopeExpansions ?? []) invalidFindings.push(discardedFinding(proposal, `scope expansion is not allowed in ${this.stage}`));
    this.discardedFindings = Object.freeze(invalidFindings); this.discardedOperations = Object.freeze(invalidOperations); Object.freeze(this);
  }
  assertCurrent(review) { if (!(review instanceof CanonicalSpecReview) || !this.identity.equals(review.identity) || this.baseReviewDigest !== review.digest) throw artifactError(["spec review delta is stale for the canonical revision or review digest"]); return review; }
  /** Parent-only filtering preserves parser audit while removing unpermitted siblings. */
  withPermittedFindings(findings) {
    if (!Array.isArray(findings)) throw new Error("spec review delta permitted findings must be an array");
    return new SpecReviewDelta(
      {
        ...this.toJSON(),
        findings: findings.map((finding) => finding.toJSON?.() ?? structuredClone(finding)),
      },
      {
        inheritedDiscardedFindings: this.discardedFindings,
        inheritedDiscardedOperations: this.discardedOperations,
      },
    );
  }
  toJSON() { return { version: 2, stage: this.stage, identity: this.identity.toJSON(), baseReviewDigest: this.baseReviewDigest, findings: this.stage === "spec-triage" ? this.findings.findings.map((finding) => finding.toJSON()) : structuredClone(this.findings.findings), operations: structuredClone(this.operations), ...(this.scopeExpansions.length === 0 ? {} : { scopeExpansions: structuredClone(this.scopeExpansions) }) }; }
}

/** Parent-only merge: valid independent work survives invalid sibling deltas. */
export function mergeSpecReviewDelta({ review, delta, acceptedOperations = [], discardedOperations = [], activityId = null } = {}) {
  const current = review instanceof CanonicalSpecReview ? review : new CanonicalSpecReview(review);
  const input = delta instanceof SpecReviewDelta ? delta : new SpecReviewDelta(delta); input.assertCurrent(current);
  const updates = []; const discarded = [...discardedOperations, ...input.discardedOperations, ...input.discardedFindings];
  if (input.stage === "spec-review") updates.push(...input.findings.findings);
  else if (input.stage === "spec-triage") for (const update of input.findings.findings) {
    const prior = current.findings.byId(update.findingId);
    if (prior === null) discarded.push(discardedFinding(update, "unknown finding"));
    else updates.push(new SpecReviewFinding(prior).withTriage(update).toJSON());
  }
  const nextFindings = input.stage === "spec-review" ? new SpecReviewFindingCollection(updates) : current.findings.replace(updates);
  const appliedFindings = [...new Set(acceptedOperations.flatMap((operation) => operation.findingIds ?? []))].sort();
  const operationDigest = reviewDigest({ acceptedOperations, discardedOperations: discarded, appliedFindings });
  const findingsChanged = JSON.stringify(nextFindings.findings) !== JSON.stringify(current.findings.findings);
  const outcome = input.stage === "spec-review"
    ? (findingsChanged ? "replaced" : "no-op")
    : (updates.length === 0 && acceptedOperations.length === 0 ? "no-op" : "merged");
  return new CanonicalSpecReview({ version: 2, identity: current.identity.toJSON(), generation: current.generation + 1, findings: nextFindings.findings, audit: [...current.audit, { stage: input.stage, inputDigest: input.baseReviewDigest, ...(activityId === null ? {} : { activityId }), relation: "revision-scoped-canonical-review", outcome, acceptedOperations: structuredClone(acceptedOperations), discardedOperations: structuredClone(discarded), appliedFindings, operationDigest }] });
}
