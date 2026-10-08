import { resolveMaxAttempts, resolveToolingMaxAttempts } from "../definition.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import {
  requireObject, requireString, requireNullableTaskId, requireTreeSha, requireSha256,
} from "./review-evidence-values.js";
export { ReviewProvenance, ReviewEvidenceIdentity, MAX_REVIEW_AUTHORED_STRING_CHARS } from "./review-evidence-values.js";
import {
  REVIEW_DISPOSITIONS, MAX_REVIEW_FINDINGS, ReviewFinding, ReviewDisposition,
  ReviewEvidence, ReviewToolingOutcome, requireInteger, requireBoolean, freezeArray, deepFreeze,
} from "./review-observation-values.js";
export {
  REVIEW_EVIDENCE_VERSION, MAX_REVIEW_EVIDENCE_BYTES, MAX_REVIEW_FINDINGS,
  ReviewFinding, ReviewDisposition, ReviewEvidence, ReviewToolingOutcome,
} from "./review-observation-values.js";

export const REVIEW_NODE_ID_BY_PHASE = Object.freeze({
  "draft-questions": "draft-questions-review",
  "draft-coverage": "draft-coverage-review",
  spec: "spec-review",
  test: "test-review",
  impl: "impl-review",
});
const REVIEW_TOOLING_MAX_ATTEMPTS = 1;

export function artifactPhaseMatchesReviewTarget(artifactPhase, phase) {
  if (artifactPhase === phase) return true;
  return (artifactPhase === "draft-questions-review" && phase === "draft-questions")
    || (artifactPhase === "draft-coverage-review" && phase === "draft-coverage");
}

export class ReviewRecoveryIdentity {
  constructor({
    runId = null,
    hasIssue = null,
    issue = null,
    specId = null,
    phase = null,
    taskId = null,
    treeSha,
    targetStateDigest = null,
    targetBindingDigest = null,
    dispatchInvocationId = null,
  } = {}) {
    this.runId = runId == null ? null : requireString(runId, "runId");
    this.hasIssue = hasIssue == null ? null : requireBoolean(hasIssue, "hasIssue");
    this.issue = issue == null ? null : requireInteger(issue, "issue", { min: 1 });
    if (this.hasIssue === false && this.issue != null) {
      throw new Error("no-Issue review recovery identity cannot include issue");
    }
    if (this.hasIssue === true && this.issue == null) {
      throw new Error("Issue-bearing review recovery identity requires issue");
    }
    this.specId = specId == null ? null : requireString(specId, "specId");
    this.phase = phase == null ? null : requireString(phase, "phase");
    this.taskId = requireNullableTaskId(taskId);
    this.treeSha = requireTreeSha(treeSha);
    this.targetStateDigest = targetStateDigest == null
      ? null
      : requireSha256(targetStateDigest, "targetStateDigest");
    this.targetBindingDigest = targetBindingDigest == null
      ? null
      : requireSha256(targetBindingDigest, "targetBindingDigest");
    this.dispatchInvocationId = dispatchInvocationId == null
      ? null
      : requireString(dispatchInvocationId, "dispatchInvocationId");
    Object.freeze(this);
  }

  changedFrom(previous) {
    if (!(previous instanceof ReviewRecoveryIdentity)) {
      throw new Error("previous review recovery identity must be a ReviewRecoveryIdentity");
    }
    for (const field of [
      "runId",
      "hasIssue",
      "issue",
      "specId",
      "phase",
      "taskId",
      "treeSha",
      "targetStateDigest",
      "targetBindingDigest",
    ]) {
      if (this[field] == null || previous[field] == null) continue;
      if (this[field] !== previous[field]) return true;
    }
    return false;
  }
}

export class ReviewTargetState {
  constructor({ digest, entries } = {}) {
    this.digest = requireSha256(digest, "review target state digest");
    if (!Array.isArray(entries)) throw new Error("review target state entries must be an array");
    const paths = new Set();
    this.entries = freezeArray(entries.map((entry, index) => {
      const path = requireString(entry?.path, `review target state entries[${index}].path`);
      if (paths.has(path)) throw new Error(`review target state entries contain duplicate path: ${path}`);
      paths.add(path);
      return Object.freeze({
        path,
        contentHash: requireSha256(entry?.contentHash, `review target state entries[${index}].contentHash`),
        mode: requireString(entry?.mode, `review target state entries[${index}].mode`),
      });
    }).sort((left, right) => left.path.localeCompare(right.path)));
    Object.freeze(this);
  }

  static fromRepairFingerprint(fingerprint) {
    return new ReviewTargetState({
      digest: fingerprint?.hash,
      entries: fingerprint?.entries,
    });
  }

  hasChangedEntryWithin(next, matchesPath) {
    if (!(next instanceof ReviewTargetState)) throw new Error("next review target state must be a ReviewTargetState");
    if (typeof matchesPath !== "function") throw new Error("review target-state path matcher is required");
    const nextByPath = new Map(next.entries.map((entry) => [entry.path, entry]));
    const previousByPath = new Map(this.entries.map((entry) => [entry.path, entry]));
    return this.entries.some((entry) => {
      const nextEntry = nextByPath.get(entry.path);
      return matchesPath(entry.path) && (
        nextEntry == null
        || nextEntry.contentHash !== entry.contentHash
        || nextEntry.mode !== entry.mode
      );
    }) || next.entries.some((entry) => matchesPath(entry.path) && !previousByPath.has(entry.path));
  }

  toJSON() {
    return {
      digest: this.digest,
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }
}

export class ReviewEvidenceReference {
  constructor(input = {}) {
    requireObject(input, "review evidence reference");
    this.evidenceId = requireString(
      input.evidenceId || input.evidenceRef || input.identity?.evidenceDigest,
      "evidenceId",
    );
    const disposition = input.disposition instanceof ReviewDisposition
      ? input.disposition.value
      : input.disposition;
    if (!REVIEW_DISPOSITIONS.has(disposition)) {
      throw new Error(`invalid referenced review disposition: ${disposition}`);
    }
    this.disposition = disposition;
    Object.freeze(this);
  }

  toJSON() {
    return { evidenceId: this.evidenceId, disposition: this.disposition };
  }
}

export class ReviewHandoffFinding {
  constructor(input = {}) {
    const value = input instanceof ReviewFinding
      ? input.toJSON()
      : structuredClone(requireObject(input, "handoff finding"));
    value.findingId = requireString(value.findingId, "handoff finding.findingId");
    deepFreeze(value);
    for (const [key, entry] of Object.entries(value)) this[key] = entry;
    Object.freeze(this);
  }

  toJSON() {
    return structuredClone(Object.fromEntries(Object.entries(this)));
  }
}

function normalizeHandoffFindings(value) {
  if (!Array.isArray(value)) throw new Error("handoffFindings must be an array");
  if (value.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`handoff finding count exceeds ${MAX_REVIEW_FINDINGS}`);
  }
  return freezeArray(value.map((entry) => (
    entry instanceof ReviewHandoffFinding ? entry : new ReviewHandoffFinding(entry)
  )));
}

export class ReviewBlocker {
  constructor(input = {}) {
    requireObject(input, "review blocker");
    this.kind = requireString(input.kind, "blocker.kind");
    this.reason = requireString(input.reason, "blocker.reason");
    Object.freeze(this);
  }

  toJSON() {
    return { kind: this.kind, reason: this.reason };
  }
}

function normalizeEvidenceReference(value) {
  if (value == null) return null;
  if (value instanceof ReviewEvidence || value instanceof ReviewEvidenceReference) return value;
  return new ReviewEvidenceReference(value);
}

function dispositionValue(evidence) {
  if (evidence instanceof ReviewEvidence) return evidence.disposition.value;
  return evidence?.disposition ?? null;
}

export class ReviewConvergenceState {
  constructor(input = {}) {
    requireObject(input, "review convergence state");
    this.phase = requireString(input.phase, "phase");
    this.taskId = requireNullableTaskId(input.taskId);
    this.treeSha = requireTreeSha(input.treeSha);
    this.semanticAttempts = requireInteger(input.semanticAttempts, "semanticAttempts");
    this.semanticMaxAttempts = requireInteger(input.semanticMaxAttempts, "semanticMaxAttempts", { min: 1 });
    if (this.semanticAttempts > this.semanticMaxAttempts) {
      throw new Error("semanticAttempts exceeds semanticMaxAttempts");
    }
    this.toolingAttempts = requireInteger(input.toolingAttempts, "toolingAttempts");
    this.toolingMaxAttempts = requireInteger(input.toolingMaxAttempts, "toolingMaxAttempts", { min: 1 });
    if (this.toolingAttempts > this.toolingMaxAttempts) {
      throw new Error("toolingAttempts exceeds toolingMaxAttempts");
    }
    this.evidence = normalizeEvidenceReference(input.evidence);
    this.finalizedEvidenceAvailable = requireBoolean(
      input.finalizedEvidenceAvailable,
      "finalizedEvidenceAvailable",
    );
    this.handoffFindings = normalizeHandoffFindings(input.handoffFindings || []);
    this.blocker = input.blocker == null
      ? null
      : input.blocker instanceof ReviewBlocker ? input.blocker : new ReviewBlocker(input.blocker);
    this.toolingOutcome = input.toolingOutcome == null
      ? null
      : input.toolingOutcome instanceof ReviewToolingOutcome
        ? input.toolingOutcome
        : new ReviewToolingOutcome(input.toolingOutcome);
    Object.freeze(this);
  }

  get disposition() {
    return dispositionValue(this.evidence);
  }

  get remainingSemanticAttempts() {
    return this.semanticMaxAttempts - this.semanticAttempts;
  }

  get remainingToolingAttempts() {
    return this.toolingMaxAttempts - this.toolingAttempts;
  }

  get semanticHandoffReady() {
    return this.disposition === "REJECTED"
      && this.remainingSemanticAttempts === 0
      && this.evidence != null;
  }

  toJSON() {
    return {
      phase: this.phase,
      taskId: this.taskId,
      treeSha: this.treeSha,
      semanticAttempts: this.semanticAttempts,
      semanticMaxAttempts: this.semanticMaxAttempts,
      toolingAttempts: this.toolingAttempts,
      toolingMaxAttempts: this.toolingMaxAttempts,
      evidence: this.evidence?.toJSON() ?? null,
      finalizedEvidenceAvailable: this.finalizedEvidenceAvailable,
      handoffFindings: this.handoffFindings.map((finding) => finding.toJSON()),
      blocker: this.blocker?.toJSON() ?? null,
      toolingOutcome: this.toolingOutcome?.toJSON() ?? null,
    };
  }
}

export class ReviewPermittedOperation {
  constructor({ state, handoffFindings = null, blocker = null } = {}) {
    if (new.target === ReviewPermittedOperation) throw new Error("ReviewPermittedOperation is abstract");
    if (!(state instanceof ReviewConvergenceState)) {
      throw new Error("state must be a ReviewConvergenceState");
    }
    if ((handoffFindings == null) === (blocker == null)) {
      throw new Error("review operation must expose exactly one of handoffFindings or blocker");
    }
    this.remainingSemanticAttempts = state.remainingSemanticAttempts;
    this.remainingToolingAttempts = state.remainingToolingAttempts;
    this.handoffFindings = handoffFindings == null ? null : normalizeHandoffFindings(handoffFindings);
    this.blocker = blocker == null
      ? null
      : blocker instanceof ReviewBlocker ? blocker : new ReviewBlocker(blocker);
    this.requiresApproval = false;
  }

  toJSON() {
    return {
      kind: this.kind,
      remainingSemanticAttempts: this.remainingSemanticAttempts,
      remainingToolingAttempts: this.remainingToolingAttempts,
      ...(this.handoffFindings == null
        ? { blocker: this.blocker.toJSON() }
        : { handoffFindings: this.handoffFindings.map((finding) => finding.toJSON()) }),
      requiresApproval: this.requiresApproval,
    };
  }
}

export class RetryReview extends ReviewPermittedOperation {
  constructor({ state, budgetKind, requiresChangedEvidence, blocker } = {}) {
    super({ state, blocker });
    if (budgetKind !== "semantic" && budgetKind !== "tooling") {
      throw new Error("retry review budgetKind must be semantic or tooling");
    }
    this.kind = "retry_review";
    this.budgetKind = budgetKind;
    this.requiresChangedEvidence = requireBoolean(requiresChangedEvidence, "requiresChangedEvidence");
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      budgetKind: this.budgetKind,
      requiresChangedEvidence: this.requiresChangedEvidence,
    };
  }
}

export class RegisterAlternativeEvidence extends ReviewPermittedOperation {
  constructor({ state, blocker } = {}) {
    super({ state, blocker });
    this.kind = "register_alternative_evidence";
    Object.freeze(this);
  }
}

export class MoveToAcceptance extends ReviewPermittedOperation {
  constructor({ state, handoffFindings = [] } = {}) {
    super({ state, handoffFindings });
    this.kind = "move_to_acceptance";
    Object.freeze(this);
  }
}

export class StopAsBlocker extends ReviewPermittedOperation {
  constructor({ state, blocker } = {}) {
    super({ state, blocker });
    if (!this.blocker) throw new Error("stop_as_blocker requires a blocker");
    this.kind = "stop_as_blocker";
    Object.freeze(this);
  }
}

function retryBlocker(state, budgetKind) {
  if (state.blocker) return state.blocker;
  if (budgetKind === "semantic") {
    return new ReviewBlocker({
      kind: "semantic_remediation_required",
      reason: "Blocking review findings require changed evidence before review can continue.",
    });
  }
  return new ReviewBlocker({
    kind: "tooling_retry_required",
    reason: "Review tooling failed and the bounded retry remains available.",
  });
}

function alternativeEvidenceBlocker(state) {
  return state.blocker || new ReviewBlocker({
    kind: "alternative_evidence_required",
    reason: "Finalized review evidence is available and its failed projection must be recovered without rerunning the reviewer.",
  });
}

export function resolveReviewPermittedOperation(state) {
  if (!(state instanceof ReviewConvergenceState)) {
    throw new Error("state must be a ReviewConvergenceState");
  }
  // Once canonical REJECTED evidence has exhausted the semantic budget, its
  // acceptance handoff remains authoritative. A later provider invocation is
  // invalid and any tooling outcome from that invocation must not replace the
  // already-complete semantic route with tooling recovery.
  if (state.semanticHandoffReady) {
    return new MoveToAcceptance({ state, handoffFindings: state.handoffFindings });
  }
  if (state.toolingOutcome) {
    if (state.finalizedEvidenceAvailable) {
      return new RegisterAlternativeEvidence({ state, blocker: alternativeEvidenceBlocker(state) });
    }
    if (state.remainingToolingAttempts > 0) {
      return new RetryReview({
        state,
        budgetKind: "tooling",
        requiresChangedEvidence: false,
        blocker: retryBlocker(state, "tooling"),
      });
    }
    return new StopAsBlocker({
      state,
      blocker: state.blocker || new ReviewBlocker({
        kind: "tooling_attempts_exhausted",
        reason: "Review tooling attempts are exhausted and no finalized evidence is available.",
      }),
    });
  }
  if (state.disposition === "PASS" || state.disposition === "ADVISORY") {
    return new MoveToAcceptance({ state, handoffFindings: state.handoffFindings });
  }
  if (state.disposition === "REJECTED") {
    if (state.remainingSemanticAttempts > 0) {
      return new RetryReview({
        state,
        budgetKind: "semantic",
        requiresChangedEvidence: true,
        blocker: retryBlocker(state, "semantic"),
      });
    }
    return new MoveToAcceptance({ state, handoffFindings: state.handoffFindings });
  }
  if (state.finalizedEvidenceAvailable) {
    return new RegisterAlternativeEvidence({ state, blocker: alternativeEvidenceBlocker(state) });
  }
  if (state.remainingToolingAttempts > 0) {
    return new RetryReview({
      state,
      budgetKind: "tooling",
      requiresChangedEvidence: false,
      blocker: retryBlocker(state, "tooling"),
    });
  }
  return new StopAsBlocker({
    state,
    blocker: state.blocker || new ReviewBlocker({
      kind: "tooling_attempts_exhausted",
      reason: "Review tooling attempts are exhausted and no finalized evidence is available.",
    }),
  });
}

export function nextReviewToolingOutcome(state, input = {}) {
  if (!(state instanceof ReviewConvergenceState)) {
    throw new Error("state must be a ReviewConvergenceState");
  }
  return new ReviewToolingOutcome({
    ...input,
    attempt: state.toolingOutcome == null ? 1 : state.toolingAttempts + 2,
    maxAttempts: state.toolingMaxAttempts + 1,
  });
}

export function canonicalizeReviewEvidence(evidence) {
  if (!(evidence instanceof ReviewEvidence)) throw new Error("ReviewEvidence is required");
  return evidence.canonicalText;
}

export function buildReviewHandoffFindings(evidence, { sourceStep = null } = {}) {
  if (!(evidence instanceof ReviewEvidence)) throw new Error("ReviewEvidence is required");
  if (evidence.disposition.value === "PASS") return [];
  const resolvedSourceStep = sourceStep || (evidence.taskId == null
    ? REVIEW_NODE_ID_BY_PHASE[evidence.phase]
    : "task-review");
  const canonicalEvidenceRef = evidence.taskId == null
    ? FLOW_ARTIFACT_CONTRACTS.reviewEvidence({
      reviewStep: REVIEW_NODE_ID_BY_PHASE[evidence.phase],
      digest: evidence.identity.evidenceDigest,
    }).relativePath
    : FLOW_ARTIFACT_CONTRACTS.reviewEvidence({
      taskId: evidence.taskId,
      digest: evidence.identity.evidenceDigest,
    }).relativePath;
  return evidence.findings.map((finding) => new ReviewHandoffFinding({
    ...finding.toJSON(),
    sourceStep: resolvedSourceStep,
    phase: evidence.phase,
    taskId: evidence.taskId,
    treeSha: evidence.treeSha,
    provenance: evidence.provenance.toJSON(),
    evidenceDigest: evidence.identity.evidenceDigest,
    canonicalEvidenceRef,
    reviewDisposition: evidence.disposition.value,
    finalDispositionOwner: "acceptance-review",
  }));
}
