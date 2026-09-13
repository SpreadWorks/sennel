/**
 * Acceptance value objects shared by the Version-1 catalog reader and worker.
 * Persistence belongs exclusively to CanonicalAcceptanceArtifactStore.
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { validateSchema } from "../../lib/schema-validate.js";

const SCHEMA_PATH = fileURLToPath(new URL("../schemas/acceptance-review.schema.json", import.meta.url));
const STATUSES = new Set(["met", "notMet", "notVerifiable"]);
const DISPOSITIONS = new Set(["fixed", "not_needed", "false_positive", "pre_existing", "still_open", "blocking"]);

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function strings(value, field, empty = false) {
  if (!Array.isArray(value) || (!empty && value.length === 0)) throw new Error(`${field} must be an array`);
  return Object.freeze(value.map((entry, index) => text(entry, `${field}[${index}]`)));
}

export function changedPathsFromDiff(diff) {
  return [...new Set([...String(diff || "").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
    .flatMap((match) => [match[1], match[2]]))];
}

export class MechanicalBlocker {
  constructor({ blockerId, kind, summary, detail = null } = {}) {
    this.blockerId = text(blockerId, "blockerId");
    this.kind = text(kind, "kind");
    this.summary = text(summary, "summary");
    this.detail = detail == null ? null : text(detail, "detail");
    Object.freeze(this);
  }
  toJSON() { return { blockerId: this.blockerId, kind: this.kind, summary: this.summary, ...(this.detail && { detail: this.detail }) }; }
}

export class AcceptanceTestEvidenceProjection {
  constructor(artifacts = {}) {
    const fields = {
      "test-execute-result.json": ["version", "summary", "regression", "repairFingerprint"],
      "test-result-review.json": ["verdict", "checked_items", "result_file_path", "raw_output_path", "repairFingerprint"],
      "impl-review.json": ["version", "phase", "verdict", "summary", "blockingFindings", "nonBlockingImprovements", "repairFingerprint"],
      "impl-gate-result.json": ["verdict", "phase", "issues", "evaluations", "observations", "repairFingerprint"],
      "retro.json": ["mode", "date", "summary", "requirements", "repairFingerprint"],
    };
    this.artifacts = Object.freeze(Object.fromEntries(Object.entries(fields).flatMap(([name, allowed]) => {
      const source = artifacts[name];
      return source == null ? [] : [[name, structuredClone(Object.fromEntries(allowed
        .filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]])))]];
    })));
    Object.freeze(this);
  }
  toJSON() { return structuredClone(this.artifacts); }
}

class Judgment {
  constructor(input = {}) {
    this.requirementId = text(input.requirementId, "requirementId");
    this.status = text(input.status, "status");
    if (!STATUSES.has(this.status)) throw new Error("invalid acceptance judgment status");
    this.requestRefs = strings(input.requestRefs, "requestRefs");
    this.requirementRefs = strings(input.requirementRefs, "requirementRefs");
    const canMiss = this.status === "notVerifiable";
    this.diffRefs = strings(input.diffRefs || [], "diffRefs", canMiss);
    this.repairRefs = strings(input.repairRefs, "repairRefs");
    this.testRefs = strings(input.testRefs || [], "testRefs", canMiss);
    this.missingEvidence = strings(input.missingEvidence || [], "missingEvidence", !canMiss);
    if (canMiss !== (this.missingEvidence.length > 0)) throw new Error("acceptance missingEvidence does not match status");
    Object.freeze(this);
  }
  toJSON() { return { requirementId:this.requirementId,status:this.status,requestRefs:[...this.requestRefs],requirementRefs:[...this.requirementRefs],diffRefs:[...this.diffRefs],repairRefs:[...this.repairRefs],testRefs:[...this.testRefs],missingEvidence:[...this.missingEvidence] }; }
}

export class AcceptanceEvidenceBindings {
  constructor(context) {
    this.ids = Object.freeze([...context.requirementIds]);
    this.diff = Object.freeze(changedPathsFromDiff(context.evidence.diff).map((entry) => `diff:${entry}`));
    this.repair = Object.freeze([context.evidence.repairEvidence.ref]);
    Object.freeze(this);
  }
  validate(input) {
    const judgment = new Judgment(input);
    if (!this.ids.includes(judgment.requirementId)) throw new Error(`unknown requirement judgment: ${judgment.requirementId}`);
    if (judgment.requestRefs.some((ref) => ref !== "flow.request")
      || judgment.requirementRefs.some((ref) => ref !== `spec.json#${judgment.requirementId}`)
      || judgment.diffRefs.some((ref) => !this.diff.includes(ref))
      || judgment.repairRefs.some((ref) => !this.repair.includes(ref))) throw new Error("acceptance judgment contains an unbound evidence reference");
    return judgment;
  }
  validateDeferredDisposition(input, finding) {
    if (input?.findingId !== finding.findingId || !DISPOSITIONS.has(input?.finalDisposition)) throw new Error("invalid deferred finding disposition");
    const refs = strings(input.evidenceRefs, "deferred evidenceRefs");
    const source = `${finding.sourceArtifact}#${finding.sourceFindingId}`;
    if (!refs.includes(source)) throw new Error(`${finding.findingId}: evidenceRefs must cite ${source}`);
    return { ...finding, finalDisposition: input.finalDisposition, evidenceRefs: [...refs] };
  }
}

/** Stable, route-bound identities for acceptance-driven implementation repair. */
export class AcceptanceRepairFindingSet {
  constructor(artifact = {}) {
    const judgments = Array.isArray(artifact.requirementJudgments) ? artifact.requirementJudgments : [];
    const blockers = Array.isArray(artifact.hardBlockers) ? artifact.hardBlockers : [];
    const requirementKeys = judgments
      .filter((judgment) => judgment?.status === "notMet")
      .map((judgment, index) => `requirement:${text(judgment?.requirementId, `acceptance requirement judgment[${index}].requirementId`)}`);
    const blockerKeys = blockers.map((blocker, index) => (
      `hard-blocker:${text(blocker?.findingId, `acceptance hardBlockers[${index}].findingId`)}`
    ));
    this.keys = Object.freeze([...requirementKeys, ...blockerKeys]);
    if (new Set(this.keys).size !== this.keys.length) {
      throw new Error("acceptance repair findings must have unique stable identities");
    }
    Object.freeze(this);
  }
  toJSON() { return [...this.keys]; }
}

export function deriveAcceptanceReviewVerdict(artifact = {}) {
  if ((artifact.mechanicalBlockers || []).length) return "blocked";
  // A failed requirement is repairable even when the same evidence also
  // contains hard blockers. The dedicated repair route binds both finding
  // sets; a hard blocker alone remains a user-decision boundary.
  if ((artifact.requirementJudgments || []).some((entry) => entry.status === "notMet")) return "repair_required";
  if ((artifact.requirementJudgments || []).some((entry) => entry.status === "notVerifiable") || (artifact.hardBlockers || []).length) return "user_decision_required";
  return "pass";
}

export function validateAcceptanceReviewArtifact(artifact, { requirementIds = null } = {}) {
  const errors = validateSchema(artifact, JSON.parse(awaitedSchema()));
  if (errors.length) throw new Error(`acceptance-review schema validation failed: ${errors.join("; ")}`);
  const ids = artifact.requirementJudgments.map((entry) => new Judgment(entry).requirementId);
  const expected = requirementIds || ids;
  if (new Set(ids).size !== ids.length || ids.length !== expected.length || expected.some((id) => !ids.includes(id))) throw new Error("acceptance requirement judgment coverage is invalid");
  if (artifact.verdict !== deriveAcceptanceReviewVerdict(artifact)) throw new Error("acceptance-review verdict must match derived verdict");
  new AcceptanceRepairFindingSet(artifact);
  return artifact;
}

function awaitedSchema() { return fs.readFileSync(SCHEMA_PATH, "utf8"); }

export function artifactFromAcceptanceJudgments({ context, requirementJudgments, deferredFindingDispositions = [] }) {
  const blocked = context.mechanicalBlockers.length > 0;
  const bindings = blocked ? null : new AcceptanceEvidenceBindings(context);
  const judgments = blocked ? context.requirementIds.map((requirementId) => new Judgment({ requirementId, status:"notVerifiable", requestRefs:["flow.request"], requirementRefs:[`spec.json#${requirementId}`], diffRefs:[], repairRefs:[context.evidence.repairEvidence.ref], testRefs:[], missingEvidence:["Mechanical evidence is unavailable."] }).toJSON()) : requirementJudgments.map((entry) => bindings.validate(entry).toJSON());
  const byId = new Map(deferredFindingDispositions.map((entry) => [entry.findingId, entry]));
  const deferredFindings = context.deferredFindings.map((finding) => byId.has(finding.findingId) ? bindings.validateDeferredDisposition(byId.get(finding.findingId), finding) : finding);
  const artifact = { version:2, repairFingerprint:context.fingerprint.hash, mechanicalBlockers:context.mechanicalBlockers, hardBlockers:blocked ? [] : deferredFindings.filter((entry) => ["still_open","blocking"].includes(entry.finalDisposition)), requirementJudgments:judgments, deferredFindings, userDecision:null };
  return { ...artifact, verdict: deriveAcceptanceReviewVerdict(artifact) };
}
