import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FlowActivity } from "./current-flow-state.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{7,40}$/i;
const MANDATORY_REQUIREMENT_PRIORITIES = new Set(["must", "required", "blocking"]);
const REVIEW_DISPOSITIONS = new Set(["must-fix", "deferred", "informational"]);
const REVIEW_FINDING_CANONICAL_TUPLE_LENGTH = 4;
const DRAFT_REOPEN_ACTIVITY_OPERATIONS = new Set([
  "reopen_draft_preimplementation",
  "reopen_draft_task_addition",
  "reopen_draft_spec_correction",
]);
export function opensReviewFindingCycle(activity) {
  return DRAFT_REOPEN_ACTIVITY_OPERATIONS.has(activity.transition.operation);
}

export const REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS = 1200;

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value == null) return null;
  return requireString(value, field);
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireSha256(value, field) {
  const hash = requireString(value, field);
  if (!SHA256_RE.test(hash)) throw new Error(`${field} must be a lowercase SHA-256 string`);
  return hash;
}

function requireCommit(value, field) {
  const commit = requireString(value, field);
  if (!COMMIT_RE.test(commit)) throw new Error(`${field} must be a Git commit hash`);
  return commit;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ));
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeIdentityText(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  return text === "" ? null : text.toLowerCase();
}

function normalizeIdentityPath(value) {
  if (value == null) return null;
  const file = String(value).trim().replaceAll("\\", "/");
  return file === "" ? null : file;
}

function findingIdentity(value) {
  const finding = requireRecord(value, "finding");
  const requirementId = optionalString(finding.requirementId, "finding.requirementId");
  const guardrailId = optionalString(finding.guardrailId, "finding.guardrailId");
  const findingKey = optionalString(finding.findingKey, "finding.findingKey");
  const authoritative = requirementId !== null || guardrailId !== null;
  const identity = {
    scope: normalizeIdentityText(finding.scope),
    phase: normalizeIdentityText(finding.phase),
    taskId: normalizeIdentityText(finding.taskId),
    category: normalizeIdentityText(finding.category),
    failureMode: normalizeIdentityText(finding.failureMode),
    requirementId,
    guardrailId,
    findingKey: normalizeIdentityText(findingKey),
    file: normalizeIdentityPath(finding.file),
    location: normalizeIdentityText(finding.location),
    rootCause: normalizeIdentityText(finding.rootCause),
    title: authoritative ? null : normalizeIdentityText(finding.title),
    issue: authoritative ? null : normalizeIdentityText(finding.issue || finding.reason || finding.body),
  };
  const hasSemanticIdentity = Object.values(identity).some((item) => item !== null);
  if (!hasSemanticIdentity) {
    identity.findingId = requireString(finding.findingId, "finding.findingId");
  }
  return identity;
}

export class ReviewFindingFingerprint {
  constructor(value) {
    const fingerprint = value instanceof ReviewFindingFingerprint ? value.value : value;
    if (typeof fingerprint !== "string" || !SHA256_RE.test(fingerprint)) {
      throw new Error("finding fingerprint must be a lowercase SHA-256 string");
    }
    this.value = fingerprint;
    Object.freeze(this);
  }

  static fromFinding(value) {
    const finding = requireRecord(value, "finding");
    if (Object.hasOwn(finding, "fingerprint")) {
      return new ReviewFindingFingerprint(finding.fingerprint);
    }
    const digest = crypto
      .createHash("sha256")
      .update(stableStringify(findingIdentity(finding)))
      .digest("hex");
    return new ReviewFindingFingerprint(digest);
  }

  static fromCanonicalTuple(values) {
    if (
      !Array.isArray(values)
      || values.length !== REVIEW_FINDING_CANONICAL_TUPLE_LENGTH
      || values.some((value) => (
        typeof value !== "string"
        || value.trim() === ""
        || value.length > REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS
      ))
    ) {
      throw new Error(
        `finding canonical tuple must contain exactly ${REVIEW_FINDING_CANONICAL_TUPLE_LENGTH} non-empty strings`
        + ` of at most ${REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS} characters`,
      );
    }
    const digest = crypto
      .createHash("sha256")
      .update(stableStringify(values))
      .digest("hex");
    return new ReviewFindingFingerprint(digest);
  }

  equals(other) {
    return other instanceof ReviewFindingFingerprint && other.value === this.value;
  }

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }
}

class ReviewFinding {
  constructor(value) {
    const finding = requireRecord(value, "finding");
    this.fingerprint = ReviewFindingFingerprint.fromFinding(finding);
    this.findingId = optionalString(finding.findingId, "finding.findingId") || this.fingerprint.value;
    this.category = optionalString(finding.category, "finding.category");
    this.requirementId = optionalString(finding.requirementId, "finding.requirementId");
    this.guardrailId = optionalString(finding.guardrailId, "finding.guardrailId");
    this.rationale = requireString(finding.rationale, "finding rationale");
    this.proposedDisposition = finding.disposition == null
      ? null
      : requireString(finding.disposition, "finding disposition");
    if (this.proposedDisposition && !REVIEW_DISPOSITIONS.has(this.proposedDisposition)) {
      throw new Error(`invalid finding disposition: ${this.proposedDisposition}`);
    }
    Object.freeze(this);
  }
}

class RequirementAuthority {
  constructor(value) {
    const requirement = requireRecord(value, "requirement");
    this.id = requireString(requirement.id, "requirement.id");
    this.priority = optionalString(requirement.priority, "requirement.priority")?.toLowerCase() || "must";
    Object.freeze(this);
  }

  get mandatory() {
    return MANDATORY_REQUIREMENT_PRIORITIES.has(this.priority);
  }
}

export class ReviewFindingCycle {
  constructor(input = {}) {
    const value = requireRecord(input, "review finding cycle");
    this.runId = optionalString(value.runId, "review finding cycle.runId");
    if (!Array.isArray(value.activities)) {
      throw new Error("review finding cycle.activities must be an array of canonical Activities");
    }
    const activities = value.activities.map((activity, index) => {
      try {
        return FlowActivity.canonical(activity);
      } catch (error) {
        throw new Error(`review finding cycle.activities[${index}] must be a canonical Activity: ${error.message}`);
      }
    });
    const latestReopen = activities.findLast(opensReviewFindingCycle);
    if (latestReopen !== undefined && latestReopen.timing === null) {
      throw new Error("draft reopen Activity requires timing facts");
    }
    this.planRewindAt = latestReopen?.timing?.finishedAt ?? null;
    Object.freeze(this);
  }

  static fromActivityLedger({ runId = null, activities = [] } = {}) {
    return new ReviewFindingCycle({ runId, activities });
  }

  matchesArtifact(value) {
    const artifact = requireRecord(value, "review finding artifact");
    const artifactRunId = optionalString(artifact.runId, "review finding artifact.runId");
    const artifactRewindAt = optionalString(
      artifact.planRewindAt,
      "review finding artifact.planRewindAt",
    );
    return (this.runId === null || artifactRunId === this.runId)
      && artifactRewindAt === this.planRewindAt;
  }

  toJSON() {
    return {
      ...(this.runId && { runId: this.runId }),
      planRewindAt: this.planRewindAt,
    };
  }
}

class GuardrailAuthority {
  constructor(value) {
    const guardrail = requireRecord(value, "guardrail");
    this.id = requireString(guardrail.id, "guardrail.id");
    this.severity = requireString(guardrail.severity, "guardrail.severity").toLowerCase();
    Object.freeze(this);
  }

  get blocking() {
    return this.severity === "blocking";
  }
}

export class ReviewFindingDisposition {
  constructor(input = {}) {
    if (new.target === ReviewFindingDisposition) {
      throw new Error("ReviewFindingDisposition is abstract");
    }
    const value = requireRecord(input, "disposition");
    this.fingerprint = new ReviewFindingFingerprint(value.fingerprint).value;
    this.rationale = requireString(value.rationale, "disposition rationale");
    this.findingId = optionalString(value.findingId, "disposition.findingId") || this.fingerprint;
    this.requirementId = optionalString(value.requirementId, "disposition.requirementId");
    this.guardrailId = optionalString(value.guardrailId, "disposition.guardrailId");
    this.repeatCount = requirePositiveInteger(value.repeatCount ?? 1, "disposition.repeatCount");
  }

  requiresRepair() {
    throw new Error("ReviewFindingDisposition.requiresRepair must be implemented");
  }

  toJSON() {
    return {
      findingId: this.findingId,
      fingerprint: this.fingerprint,
      disposition: this.disposition,
      rationale: this.rationale,
      requirementId: this.requirementId,
      guardrailId: this.guardrailId,
      repeatCount: this.repeatCount,
    };
  }
}

export class MustFixDisposition extends ReviewFindingDisposition {
  constructor(input = {}) {
    super(input);
    this.disposition = "must-fix";
    Object.freeze(this);
  }

  requiresRepair() {
    return true;
  }
}

export class DeferredDisposition extends ReviewFindingDisposition {
  constructor(input = {}) {
    super(input);
    this.disposition = "deferred";
    Object.freeze(this);
  }

  requiresRepair() {
    return false;
  }
}

export class InformationalDisposition extends ReviewFindingDisposition {
  constructor(input = {}) {
    super(input);
    this.disposition = "informational";
    Object.freeze(this);
  }

  requiresRepair() {
    return false;
  }
}

class ReviewEvidenceScope {
  constructor({ phase, taskId = null } = {}) {
    this.taskId = optionalString(taskId, "scope.taskId");
    this.phase = ReviewEvidenceScope.canonicalPhase(requireString(phase, "scope.phase"), this.taskId);
    Object.freeze(this);
  }

  static canonicalPhase(value, taskId) {
    const phase = value.trim().toLowerCase();
    if (taskId !== null && ["impl", "task-impl", "task-gate", "task-review"].includes(phase)) {
      return "task-review";
    }
    if (taskId === null && ["integration", "impl", "impl-gate", "impl-review"].includes(phase)) {
      return "impl-review";
    }
    if (taskId === null && phase === "spec-gate") return "spec";
    if (taskId === null && phase === "draft-gate") return "draft";
    return phase;
  }

  equals(other) {
    return other instanceof ReviewEvidenceScope
      && this.phase === other.phase
      && this.taskId === other.taskId;
  }

  toJSON() {
    return { phase: this.phase, taskId: this.taskId };
  }
}

export class RepairReference {
  constructor(value) {
    const repairRef = requireRecord(value, "repairRef");
    this.commit = repairRef.commit == null
      ? null
      : requireString(repairRef.commit, "repairRef.commit");
    if (this.commit !== null) this.commit = requireCommit(this.commit, "repairRef.commit");
    if (repairRef.files == null) {
      this.files = Object.freeze([]);
    } else {
      if (!Array.isArray(repairRef.files) || repairRef.files.length === 0) {
        throw new Error("repairRef.files must be a non-empty array");
      }
      this.files = Object.freeze(repairRef.files.map((file, index) => {
        const normalized = requireString(file, `repairRef.files[${index}]`).replaceAll("\\", "/");
        if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
          throw new Error(`repairRef.files[${index}] must be a repository-relative path`);
        }
        return normalized;
      }));
    }
    if (this.commit === null && this.files.length === 0) {
      throw new Error("repairRef requires commit or files");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...(this.commit && { commit: this.commit }),
      ...(this.files.length > 0 && { files: [...this.files] }),
    };
  }

  materializesAfter(root, reportedAt = null) {
    const repositoryRoot = path.resolve(requireString(root, "repair evidence root"));
    const findingTime = reportedAt === null ? null : Date.parse(requireString(reportedAt, "finding.reportedAt"));
    if (findingTime !== null && !Number.isFinite(findingTime)) return false;
    if (this.commit !== null) {
      try {
        execFileSync("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", this.commit, "HEAD"], {
          stdio: "ignore",
        });
        const committedAt = Date.parse(execFileSync(
          "git",
          ["-C", repositoryRoot, "show", "-s", "--format=%cI", this.commit],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim());
        if (Number.isFinite(committedAt) && (findingTime === null || committedAt + 999 >= findingTime)) {
          return true;
        }
      } catch {
        // A file reference may still provide material evidence.
      }
    }
    return this.files.length > 0 && this.files.every((file) => {
      const candidate = path.resolve(repositoryRoot, file);
      const relative = path.relative(repositoryRoot, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(candidate)) return false;
      try {
        const real = fs.realpathSync(candidate);
        const realRelative = path.relative(fs.realpathSync(repositoryRoot), real);
        const stat = fs.statSync(real);
        return !realRelative.startsWith("..")
          && !path.isAbsolute(realRelative)
          && stat.isFile()
          && (findingTime === null || stat.mtimeMs >= findingTime);
      } catch {
        return false;
      }
    });
  }
}

class ValidatingTestResult {
  constructor(value) {
    const result = requireRecord(value, "validatingTestResult");
    if (result.status !== "pass") throw new Error("validatingTestResult.status must be pass");
    this.findingFingerprint = requireSha256(
      result.findingFingerprint,
      "validatingTestResult.findingFingerprint",
    );
    this.reviewedTree = requireSha256(result.reviewedTree, "validatingTestResult.reviewedTree");
    Object.freeze(this);
  }

  matches({ findingFingerprint, reviewedTree } = {}) {
    return this.findingFingerprint === findingFingerprint && this.reviewedTree === reviewedTree;
  }
}

export class RepairEvidenceReference {
  constructor(input = {}) {
    const value = requireRecord(input, "repair evidence");
    this.normalizedFindingId = requireString(value.normalizedFindingId, "normalizedFindingId");
    this.findingFingerprint = requireSha256(value.findingFingerprint, "findingFingerprint");
    this.reviewedTree = requireSha256(value.reviewedTree, "reviewedTree");
    this.reviewedHead = requireCommit(value.reviewedHead, "reviewedHead");
    this.repairDiff = requireSha256(value.repairDiff, "repairDiff");
    this.validatingTestResult = new ValidatingTestResult(value.validatingTestResult);
    this.repairRef = value.repairRef instanceof RepairReference
      ? value.repairRef
      : new RepairReference(value.repairRef);
    const phase = value.phase ?? value.step ?? value.scope?.phase;
    const taskId = Object.hasOwn(value, "taskId") ? value.taskId : value.scope?.taskId;
    this.scope = value.scope instanceof ReviewEvidenceScope
      ? value.scope
      : new ReviewEvidenceScope({ phase, taskId });
    this.issueLogId = optionalString(value.issueLogId, "repair evidence.issueLogId");
    this.timestamp = requireString(value.timestamp, "repair evidence.timestamp");
    this.recordedAt = Date.parse(this.timestamp);
    if (!Number.isFinite(this.recordedAt)) {
      throw new Error("repair evidence.timestamp must be an ISO date-time");
    }
    Object.freeze(this);
  }

  matches({
    normalizedFindingId,
    phase,
    taskId = null,
    reportedAt = null,
    root = null,
    findingFingerprint = null,
    reviewedTree = null,
    reviewedHead = null,
    repairDiff = null,
  } = {}) {
    const scope = new ReviewEvidenceScope({ phase, taskId });
    if (this.normalizedFindingId !== normalizedFindingId || !this.scope.equals(scope)) return false;
    if (reportedAt !== null) {
      const findingTime = Date.parse(requireString(reportedAt, "finding.reportedAt"));
      if (!Number.isFinite(findingTime) || this.recordedAt < findingTime) return false;
    }
    if (
      findingFingerprint === null
      || reviewedTree === null
      || reviewedHead === null
      || repairDiff === null
    ) return false;
    if (
      this.findingFingerprint !== findingFingerprint
      || this.reviewedTree !== reviewedTree
      || this.reviewedHead !== reviewedHead
      || this.repairDiff !== repairDiff
      || !this.validatingTestResult.matches({ findingFingerprint, reviewedTree })
    ) return false;
    return root === null || this.repairRef.materializesAfter(root, reportedAt);
  }

  toJSON() {
    return {
      normalizedFindingId: this.normalizedFindingId,
      findingFingerprint: this.findingFingerprint,
      reviewedTree: this.reviewedTree,
      reviewedHead: this.reviewedHead,
      repairDiff: this.repairDiff,
      repairRef: this.repairRef.toJSON(),
      validatingTestResult: {
        status: "pass",
        findingFingerprint: this.validatingTestResult.findingFingerprint,
        reviewedTree: this.validatingTestResult.reviewedTree,
      },
      scope: this.scope.toJSON(),
      timestamp: this.timestamp,
      ...(this.issueLogId && { issueLogId: this.issueLogId }),
    };
  }
}

export class IssueLogRepairEvidenceSource {
  constructor(input = []) {
    const entries = Array.isArray(input) ? input : requireRecord(input, "issue log").entries;
    if (!Array.isArray(entries)) throw new Error("issue log entries must be an array");
    const evidence = [];
    const invalidProofClaims = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (!hasRepairProofClaimFields(entry)) continue;
      try {
        evidence.push(new RepairEvidenceReference(entry));
      } catch (error) {
        invalidProofClaims.push(new InvalidRepairEvidenceClaim(entry, error));
      }
    }
    this.entries = Object.freeze(evidence);
    this.invalidProofClaims = Object.freeze(invalidProofClaims);
    Object.freeze(this);
  }

  find({
    normalizedFindingId,
    phase,
    taskId = null,
    reportedAt = null,
    root = null,
    findingFingerprint = null,
    reviewedTree = null,
    reviewedHead = null,
    repairDiff = null,
  } = {}) {
    const id = requireString(normalizedFindingId, "normalizedFindingId");
    if (this.invalidProofClaims.some((claim) => claim.normalizedFindingId === id)) return null;
    const matches = this.entries.filter((entry) => entry.matches({
      normalizedFindingId: id,
      phase,
      taskId,
      reportedAt,
      root,
      findingFingerprint,
      reviewedTree,
      reviewedHead,
      repairDiff,
    }));
    return matches.length === 1 ? matches[0] : null;
  }
}

class InvalidRepairEvidenceClaim {
  constructor(entry, error) {
    this.normalizedFindingId = optionalString(entry.normalizedFindingId, "invalid repair evidence.normalizedFindingId");
    this.reason = error instanceof Error ? error.message : String(error);
    Object.freeze(this);
  }
}

function hasRepairProofClaimFields(entry) {
  return [
    "findingFingerprint",
    "reviewedTree",
    "reviewedHead",
    "repairDiff",
    "validatingTestResult",
    "phase",
    "taskId",
  ].some((field) => Object.hasOwn(entry, field));
}

class GateFinding {
  constructor(value) {
    const finding = new ReviewFinding(value);
    const disposition = requireString(value.disposition, "finding disposition");
    const common = {
      findingId: finding.findingId,
      fingerprint: finding.fingerprint.value,
      rationale: finding.rationale,
      requirementId: finding.requirementId,
      guardrailId: finding.guardrailId,
      repeatCount: value.repeatCount ?? 1,
    };
    if (disposition === "must-fix") this.disposition = new MustFixDisposition(common);
    else if (disposition === "deferred") this.disposition = new DeferredDisposition(common);
    else if (disposition === "informational") this.disposition = new InformationalDisposition(common);
    else throw new Error(`invalid finding disposition: ${disposition}`);
    this.findingId = finding.findingId;
    this.fingerprint = finding.fingerprint.value;
    this.requirementId = finding.requirementId;
    this.guardrailId = finding.guardrailId;
    this.reportedAt = optionalString(value.reportedAt, "finding.reportedAt");
    this.explicitDecision = value.explicitDecision == null
      ? null
      : new ExplicitFindingDecision(value.explicitDecision, this.fingerprint);
    Object.freeze(this);
  }

  get isAuthoritativeMustFix() {
    return this.disposition instanceof MustFixDisposition
      && (this.requirementId !== null || this.guardrailId !== null);
  }

  toJSON() {
    return this.disposition.toJSON();
  }
}

class ExplicitFindingDecision {
  constructor(value, findingFingerprint) {
    const decision = requireRecord(value, "explicitDecision");
    if (!["allow", "defer"].includes(decision.kind)) {
      throw new Error("explicitDecision.kind must be allow or defer");
    }
    if (requireSha256(decision.findingFingerprint, "explicitDecision.findingFingerprint") !== findingFingerprint) {
      throw new Error("explicitDecision.findingFingerprint must match the finding fingerprint");
    }
    this.kind = decision.kind;
    this.findingFingerprint = findingFingerprint;
    Object.freeze(this);
  }
}

export class ReviewFindingGateArtifact {
  constructor(input = {}, { source = "impl-review.json" } = {}) {
    const artifact = requireRecord(input, source);
    if (artifact.version !== 1) throw new Error(`${source}.version must be 1`);
    if (artifact.phase !== "impl") throw new Error(`${source}.phase must be impl`);
    this.generatedAt = requireString(artifact.generatedAt, `${source}.generatedAt`);
    if (!Number.isFinite(Date.parse(this.generatedAt))) {
      throw new Error(`${source}.generatedAt must be an ISO date-time`);
    }
    this.taskId = optionalString(artifact.taskId, `${source}.taskId`);
    this.runId = optionalString(artifact.runId, `${source}.runId`);
    this.planRewindAt = optionalString(artifact.planRewindAt, `${source}.planRewindAt`);
    if (this.planRewindAt !== null && !Number.isFinite(Date.parse(this.planRewindAt))) {
      throw new Error(`${source}.planRewindAt must be an ISO date-time`);
    }
    if (!Array.isArray(artifact.blockingFindings) || !Array.isArray(artifact.nonBlockingImprovements)) {
      throw new Error(`${source} finding buckets must be arrays`);
    }
    const typedFinding = (finding) => {
      const identity = {
        ...finding,
        scope: this.taskId === null ? "flow" : "task",
        phase: this.taskId === null ? "impl-review" : "task-review",
        taskId: this.taskId,
        category: finding?.failureMode,
      };
      delete identity.findingId;
      delete identity.fingerprint;
      delete identity.repeatCount;
      const expectedFingerprint = ReviewFindingFingerprint.fromFinding(identity).value;
      if (finding?.fingerprint !== expectedFingerprint || finding?.findingId !== expectedFingerprint) {
        throw new Error(`${source} finding fingerprint does not match its stable identity`);
      }
      return new GateFinding({ ...finding, reportedAt: this.generatedAt });
    };
    this.blockingFindings = Object.freeze(artifact.blockingFindings.map((finding) => (
      typedFinding(finding)
    )));
    this.nonBlockingImprovements = Object.freeze(artifact.nonBlockingImprovements.map((finding) => (
      typedFinding(finding)
    )));
    const expectedVerdict = this.blockingFindings.length > 0
      ? "REJECTED"
      : this.nonBlockingImprovements.length > 0 ? "ADVISORY" : "PASS";
    if (artifact.verdict !== expectedVerdict) {
      throw new Error(`${source}.verdict does not match its finding buckets`);
    }
    const summary = requireRecord(artifact.summary, `${source}.summary`);
    if (
      summary.blocking !== this.blockingFindings.length
      || summary.nonBlocking !== this.nonBlockingImprovements.length
      || summary.total !== this.blockingFindings.length + this.nonBlockingImprovements.length
    ) {
      throw new Error(`${source}.summary does not match its finding buckets`);
    }
    this.findings = Object.freeze([...this.blockingFindings, ...this.nonBlockingImprovements]);
    Object.freeze(this);
  }
}

class FindingGateBlock {
  constructor(finding, reason) {
    if (!(finding instanceof GateFinding)) throw new Error("gate block finding must be typed");
    this.finding = finding;
    this.reason = requireString(reason, "gate block reason");
    Object.freeze(this);
  }

  toJSON() {
    return { finding: this.finding.toJSON(), reason: this.reason };
  }
}

export class FindingGateDecision {
  constructor({ phase, taskId = null, blocks = [], evidence = [] } = {}) {
    this.scope = new ReviewEvidenceScope({ phase, taskId });
    if (!Array.isArray(blocks) || blocks.some((block) => !(block instanceof FindingGateBlock))) {
      throw new Error("gate decision blocks must be typed FindingGateBlock values");
    }
    if (!Array.isArray(evidence) || evidence.some((entry) => !(entry instanceof RepairEvidenceReference))) {
      throw new Error("gate decision evidence must be typed RepairEvidenceReference values");
    }
    this.blocks = Object.freeze([...blocks]);
    this.evidence = Object.freeze([...evidence]);
    this.allowed = this.blocks.length === 0;
    this.blocking = !this.allowed;
    this.issues = Object.freeze(this.blocks.map((block) => block.reason));
    Object.freeze(this);
  }

  allowsPass() {
    return this.allowed;
  }

  toJSON() {
    return {
      result: this.allowed ? "pass" : "blocking",
      scope: this.scope.toJSON(),
      blocks: this.blocks.map((block) => block.toJSON()),
      evidence: this.evidence.map((entry) => entry.toJSON()),
    };
  }
}

export class FindingDispositionPolicy {
  constructor({ maxOccurrences } = {}) {
    this.maxOccurrences = requirePositiveInteger(maxOccurrences, "maxOccurrences");
    Object.freeze(this);
  }

  classify({ finding, requirement = null, guardrail = null, repeatCount } = {}) {
    const candidate = new ReviewFinding(finding);
    const requirementAuthority = requirement == null ? null : new RequirementAuthority(requirement);
    const guardrailAuthority = guardrail == null ? null : new GuardrailAuthority(guardrail);
    const occurrences = requirePositiveInteger(repeatCount, "repeatCount");

    if (
      requirementAuthority
      && candidate.requirementId !== null
      && candidate.requirementId !== requirementAuthority.id
    ) {
      throw new Error("finding requirementId does not match requirement authority");
    }
    if (
      guardrailAuthority
      && candidate.guardrailId !== null
      && candidate.guardrailId !== guardrailAuthority.id
    ) {
      throw new Error("finding guardrailId does not match guardrail authority");
    }

    const mandatory = requirementAuthority?.mandatory === true || guardrailAuthority?.blocking === true;
    const expectedProposal = mandatory ? "must-fix" : "informational";
    if (mandatory && candidate.proposedDisposition !== null && candidate.proposedDisposition !== expectedProposal) {
      throw new Error(
        `finding disposition ${candidate.proposedDisposition} conflicts with policy disposition ${expectedProposal}`,
      );
    }

    const dispositionInput = {
      findingId: candidate.findingId,
      fingerprint: candidate.fingerprint.value,
      rationale: candidate.rationale,
      requirementId: requirementAuthority?.id ?? candidate.requirementId,
      guardrailId: guardrailAuthority?.id ?? candidate.guardrailId,
      repeatCount: occurrences,
    };
    if (!mandatory) return new InformationalDisposition(dispositionInput);
    return new MustFixDisposition(dispositionInput);
  }

  evaluateGate({
    findings,
    issueLogEntries = [],
    phase,
    taskId = null,
    root = null,
    reviewedTree = null,
    reviewedHead = null,
    repairDiff = null,
  } = {}) {
    if (!Array.isArray(findings)) throw new Error("gate findings must be an array");
    const scope = new ReviewEvidenceScope({ phase, taskId });
    const evidenceSource = issueLogEntries instanceof IssueLogRepairEvidenceSource
      ? issueLogEntries
      : new IssueLogRepairEvidenceSource(issueLogEntries);
    const blocks = [];
    const evidence = [];

    for (const rawFinding of findings) {
      const finding = rawFinding instanceof GateFinding ? rawFinding : new GateFinding(rawFinding);
      if (finding.explicitDecision !== null) continue;
      if (!(finding.disposition instanceof MustFixDisposition)) continue;
      if (!finding.isAuthoritativeMustFix) {
        blocks.push(new FindingGateBlock(
          finding,
          `must-fix finding ${finding.findingId} has no requirementId or guardrailId authority`,
        ));
        continue;
      }
      const matched = evidenceSource.find({
        normalizedFindingId: finding.findingId,
        phase: scope.phase,
        taskId: scope.taskId,
        reportedAt: finding.reportedAt,
        root,
        findingFingerprint: finding.fingerprint,
        reviewedTree,
        reviewedHead,
        repairDiff,
      });
      if (!matched) {
        blocks.push(new FindingGateBlock(
          finding,
          `must-fix finding ${finding.findingId} is missing matching repair evidence`,
        ));
        continue;
      }
      evidence.push(matched);
    }

    return new FindingGateDecision({
      phase: scope.phase,
      taskId: scope.taskId,
      blocks,
      evidence,
    });
  }
}
