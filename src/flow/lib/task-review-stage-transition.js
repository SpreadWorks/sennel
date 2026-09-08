import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = new Set(["review", "triage", "repair"]);
const VERDICTS = new Set(["PASS", "ADVISORY", "REJECTED"]);
const TRIAGE_DISPOSITIONS = new Set(["apply", "all-reject"]);
const OPERATIONS = new Set([
  "review-to-gate",
  "review-to-triage",
  "review-no-change-complete",
  "triage-to-repair",
  "triage-all-reject-to-gate",
  "triage-no-change-correction",
  "triage-no-change-complete",
  "task-rounds-exhausted",
  "repair-to-review",
  "repair-unreviewed-to-gate",
]);
const TOKEN = Symbol("task-review-stage-transition");

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function digest(value, field) {
  const resolved = text(value, field);
  if (!SHA256.test(resolved)) throw new Error(`${field} must be a SHA-256 digest`);
  return resolved;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class TaskReviewStageBinding {
  constructor({ runId, specId, taskId, stage, attemptId, attemptSequence, sourceFingerprint, artifactDigest, catalogFingerprint } = {}) {
    this.runId = text(runId, "Task Review stage binding runId");
    this.specId = text(specId, "Task Review stage binding specId");
    this.taskId = text(taskId, "Task Review stage binding taskId");
    this.stage = text(stage, "Task Review stage binding stage");
    if (!STAGES.has(this.stage)) throw new Error("Task Review stage binding stage is invalid");
    this.attemptId = text(attemptId, "Task Review stage binding attemptId");
    if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 1) {
      throw new Error("Task Review stage binding attemptSequence must be a positive integer");
    }
    this.attemptSequence = attemptSequence;
    this.sourceFingerprint = digest(sourceFingerprint, "Task Review stage binding sourceFingerprint");
    this.artifactDigest = digest(artifactDigest, "Task Review stage binding artifactDigest");
    this.catalogFingerprint = digest(catalogFingerprint, "Task Review stage binding catalogFingerprint");
    Object.freeze(this);
  }

  get sourceStepId() { return `${this.taskId}-${this.stage}`; }

  matches(other) {
    return other instanceof TaskReviewStageBinding
      && stableJson(this.toJSON()) === stableJson(other.toJSON());
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      taskId: this.taskId,
      stage: this.stage,
      attemptId: this.attemptId,
      attemptSequence: this.attemptSequence,
      sourceFingerprint: this.sourceFingerprint,
      artifactDigest: this.artifactDigest,
      catalogFingerprint: this.catalogFingerprint,
    };
  }
}

/** Canonical inputs from which Definition may select a no-change continuation. */
export class TaskNoChangeContinuationFacts {
  constructor({ source, review, triage = null, acceptance } = {}) {
    if (source === null || typeof source !== "object" || Array.isArray(source)
      || !Array.isArray(source.allowList) || source.allowList.some((entry) => typeof entry !== "string")
      || !Array.isArray(source.reasons) || source.reasons.length === 0
      || source.reasons.some((reason) => typeof reason !== "string" || reason.trim() === "")) {
      throw new Error("Task no-change continuation source is invalid");
    }
    this.source = Object.freeze({
      fingerprint: digest(source.fingerprint, "Task no-change source fingerprint"),
      allowList: Object.freeze([...source.allowList]),
      reasons: Object.freeze(source.reasons.map((reason) => reason.trim())),
    });
    if (review === null || typeof review !== "object" || Array.isArray(review)
      || !VERDICTS.has(review.verdict) || review.canonical !== true) {
      throw new Error("Task no-change continuation review is invalid");
    }
    this.review = Object.freeze({
      verdict: review.verdict,
      canonical: true,
      artifactDigest: digest(review.artifactDigest, "Task no-change Review artifact digest"),
      sourceFingerprint: digest(review.sourceFingerprint, "Task no-change Review source fingerprint"),
    });
    if (triage !== null) {
      if (typeof triage !== "object" || Array.isArray(triage) || triage.disposition !== "all-reject") {
        throw new Error("Task no-change continuation triage must be an all-reject result");
      }
      this.triage = Object.freeze({
        disposition: triage.disposition,
        artifactDigest: digest(triage.artifactDigest, "Task no-change triage artifact digest"),
        reviewArtifactDigest: digest(triage.reviewArtifactDigest, "Task no-change triage Review digest"),
        sourceFingerprint: digest(triage.sourceFingerprint, "Task no-change triage source fingerprint"),
      });
    } else {
      this.triage = null;
    }
    if (acceptance === null || typeof acceptance !== "object" || Array.isArray(acceptance)) {
      throw new Error("Task no-change continuation Acceptance binding is invalid");
    }
    this.acceptance = Object.freeze({
      handoffId: text(acceptance.handoffId, "Task no-change Acceptance handoffId"),
      reviewArtifactDigest: digest(acceptance.reviewArtifactDigest, "Task no-change Acceptance Review digest"),
      sourceFingerprint: digest(acceptance.sourceFingerprint, "Task no-change Acceptance source fingerprint"),
    });
    Object.freeze(this);
  }

  toJSON() {
    return {
      source: { fingerprint: this.source.fingerprint, allowList: [...this.source.allowList], reasons: [...this.source.reasons] },
      review: { ...this.review },
      triage: this.triage === null ? null : { ...this.triage },
      acceptance: { ...this.acceptance },
    };
  }
}

/** Explicit Definition decision persisted with the stage artifact and Acceptance handoff. */
export class TaskNoChangeContinuationSelection {
  constructor(token, facts) {
    if (token !== TOKEN || !(facts instanceof TaskNoChangeContinuationFacts)) {
      throw new Error("Task no-change continuations are selected only by Definition");
    }
    this.facts = facts;
    this.decision = "continue";
    this.reason = facts.source.reasons.join("; ");
    this.eligible = true;
    this.acceptanceHandoffId = facts.acceptance.handoffId;
    Object.freeze(this);
  }

  toJSON() {
    return {
      decision: this.decision,
      reason: this.reason,
      acceptanceHandoffId: this.acceptanceHandoffId,
      facts: this.facts.toJSON(),
    };
  }
}

function taskNoChangeContinuationFromJSON(value) {
  if (value?.decision === "continue") {
    const selection = new TaskNoChangeContinuationSelection(TOKEN, new TaskNoChangeContinuationFacts(value.facts));
    if (value.reason !== selection.reason || value.acceptanceHandoffId !== selection.acceptanceHandoffId) {
      throw new Error("Task no-change continuation decision is invalid");
    }
    return selection;
  }
  throw new Error("Task no-change continuation requires a Definition selection");
}

export function selectTaskNoChangeContinuation(input) {
  const facts = input instanceof TaskNoChangeContinuationFacts
    ? input
    : new TaskNoChangeContinuationFacts(input);
  if (facts.source.allowList.length !== 0) throw new Error("Task no-change continuation requires an empty allow-list");
  if (facts.review.sourceFingerprint !== facts.source.fingerprint
    || facts.acceptance.sourceFingerprint !== facts.source.fingerprint
    || facts.acceptance.reviewArtifactDigest !== facts.review.artifactDigest) {
    throw new Error("Task no-change continuation source or Review binding does not match");
  }
  if (facts.review.verdict === "REJECTED") {
    if (facts.triage === null
      || facts.triage.sourceFingerprint !== facts.source.fingerprint
      || facts.triage.reviewArtifactDigest !== facts.review.artifactDigest) {
      throw new Error("rejected Task no-change continuation requires its bound all-reject triage");
    }
  } else if (facts.triage !== null) {
    throw new Error("PASS or ADVISORY Task no-change continuation must not invent triage evidence");
  }
  return new TaskNoChangeContinuationSelection(TOKEN, facts);
}

export class TaskReviewStageFacts {
  constructor({
    binding,
    taskRound,
    reviewResultCount,
    verdict = null,
    mustFixCount = null,
    sourceNoChange = false,
    triageDisposition = null,
    repairChanged = null,
    sameReviewBinding = false,
    noChangeContinuation = null,
    acceptanceCarryForwardReady = false,
    reason = null,
  } = {}) {
    this.binding = binding instanceof TaskReviewStageBinding ? binding : new TaskReviewStageBinding(binding);
    if (!Number.isSafeInteger(taskRound) || taskRound < 1 || taskRound > 2) throw new Error("Task Review stage round must be 1 or 2");
    if (!Number.isSafeInteger(reviewResultCount) || reviewResultCount < 1 || reviewResultCount > 4) {
      throw new Error("Task Review stage result count must be between 1 and 4");
    }
    if (verdict !== null && !VERDICTS.has(verdict)) throw new Error("Task Review stage verdict is invalid");
    if (mustFixCount !== null && (!Number.isSafeInteger(mustFixCount) || mustFixCount < 0)) {
      throw new Error("Task Review stage mustFixCount is invalid");
    }
    if (typeof sourceNoChange !== "boolean" || typeof sameReviewBinding !== "boolean"
      || typeof acceptanceCarryForwardReady !== "boolean") {
      throw new Error("Task Review stage boolean facts are invalid");
    }
    if (triageDisposition !== null && !TRIAGE_DISPOSITIONS.has(triageDisposition)) {
      throw new Error("Task Review stage triage disposition is invalid");
    }
    if (repairChanged !== null && typeof repairChanged !== "boolean") throw new Error("Task Review stage repairChanged is invalid");
    this.taskRound = taskRound;
    this.reviewResultCount = reviewResultCount;
    this.verdict = verdict;
    this.mustFixCount = mustFixCount;
    this.sourceNoChange = sourceNoChange;
    this.triageDisposition = triageDisposition;
    this.repairChanged = repairChanged;
    this.sameReviewBinding = sameReviewBinding;
    this.noChangeContinuation = noChangeContinuation === null
      ? null
      : noChangeContinuation instanceof TaskNoChangeContinuationSelection
        ? noChangeContinuation
        : taskNoChangeContinuationFromJSON(noChangeContinuation);
    this.acceptanceCarryForwardReady = acceptanceCarryForwardReady;
    this.reason = reason == null ? null : text(reason, "Task Review stage reason");
    this.#assertStageShape();
    this.#assertContinuationBinding();
    Object.freeze(this);
  }

  #assertContinuationBinding() {
    if (this.noChangeContinuation !== null) {
      if (!this.sourceNoChange
        || this.noChangeContinuation.facts.source.fingerprint !== this.binding.sourceFingerprint) {
        throw new Error("Task no-change continuation does not bind the stage source");
      }
      const producerDigest = this.binding.stage === "review"
        ? this.noChangeContinuation.facts.review.artifactDigest
        : this.binding.stage === "triage"
          ? this.noChangeContinuation.facts.triage?.artifactDigest ?? null
          : null;
      if (producerDigest !== this.binding.artifactDigest) {
        throw new Error("Task no-change continuation does not bind the stage artifact");
      }
    }
    if (this.binding.stage !== "repair" && this.acceptanceCarryForwardReady) {
      throw new Error("only Task repair may carry unreviewed Acceptance evidence");
    }
  }

  #assertStageShape() {
    const stage = this.binding.stage;
    if (stage === "review") {
      if (this.verdict === null || this.mustFixCount === null || this.triageDisposition !== null || this.repairChanged !== null) {
        throw new Error("Task Review facts do not match the review stage");
      }
      if ((this.verdict === "REJECTED") !== (this.mustFixCount > 0)) {
        throw new Error("Task Review REJECTED verdict must carry must-fix findings");
      }
      return;
    }
    if (stage === "triage") {
      if (this.verdict !== "REJECTED" || this.mustFixCount === null || this.mustFixCount < 1
        || this.triageDisposition === null || this.repairChanged !== null || !this.sameReviewBinding) {
        throw new Error("Task Review facts do not match the triage stage");
      }
      if (this.reason === null) throw new Error("Task Review triage requires a canonical reason");
      return;
    }
    if (this.verdict !== "REJECTED" || this.mustFixCount === null || this.mustFixCount < 1
      || this.triageDisposition !== "apply" || this.repairChanged !== true || !this.sameReviewBinding) {
      throw new Error("Task Review facts do not match the repair stage");
    }
  }

  fingerprint() { return createHash("sha256").update(stableJson(this.toJSON())).digest("hex"); }

  toJSON() {
    return {
      binding: this.binding.toJSON(),
      taskRound: this.taskRound,
      reviewResultCount: this.reviewResultCount,
      verdict: this.verdict,
      mustFixCount: this.mustFixCount,
      sourceNoChange: this.sourceNoChange,
      triageDisposition: this.triageDisposition,
      repairChanged: this.repairChanged,
      sameReviewBinding: this.sameReviewBinding,
      noChangeContinuation: this.noChangeContinuation?.toJSON() ?? null,
      acceptanceCarryForwardReady: this.acceptanceCarryForwardReady,
      reason: this.reason,
    };
  }
}

export class TaskReviewStageStepEffect {
  constructor({ stepId, status, reason = null } = {}) {
    this.stepId = text(stepId, "Task Review stage effect stepId");
    this.status = text(status, "Task Review stage effect status");
    if (!["done", "skipped", "invalidated"].includes(this.status)) throw new Error("Task Review stage effect status is invalid");
    this.reason = reason == null ? null : text(reason, "Task Review stage effect reason");
    if ((this.status === "skipped") !== (this.reason !== null)) {
      throw new Error("Task Review skipped effect requires exactly one reason");
    }
    Object.freeze(this);
  }
  toJSON() { return { stepId: this.stepId, status: this.status, reason: this.reason }; }
}

export class TaskReviewStageTransitionPlan {
  constructor(token, { facts, operation, effects, targetStepId = null, reviewBudgetConsumed = 0, acceptanceUnreviewed = false, terminalReason = null } = {}) {
    if (token !== TOKEN || !(facts instanceof TaskReviewStageFacts)) throw new Error("Task Review stage plans are created only by Definition");
    if (!OPERATIONS.has(operation)) throw new Error("Task Review stage plan operation is invalid");
    if (!Array.isArray(effects) || effects.some((effect) => !(effect instanceof TaskReviewStageStepEffect))) {
      throw new Error("Task Review stage plan effects must be typed");
    }
    if (targetStepId !== null) text(targetStepId, "Task Review stage plan targetStepId");
    if (![0, 1].includes(reviewBudgetConsumed)) throw new Error("Task Review stage review budget effect is invalid");
    if (reviewBudgetConsumed !== (facts.binding.stage === "review" ? 1 : 0)) {
      throw new Error("only Task Review result publication consumes the Review semantic budget");
    }
    if (typeof acceptanceUnreviewed !== "boolean") throw new Error("Task Review acceptance handoff must be boolean");
    this.facts = facts;
    this.operation = operation;
    this.effects = Object.freeze([...effects]);
    this.targetStepId = targetStepId;
    this.reviewBudgetConsumed = reviewBudgetConsumed;
    this.acceptanceUnreviewed = acceptanceUnreviewed;
    this.continuationDecision = new Set(["review-no-change-complete", "triage-no-change-complete"]).has(operation)
      ? "continue"
      : null;
    this.terminalReason = terminalReason == null ? null : text(terminalReason, "Task Review stage terminal reason");
    this.identity = createHash("sha256").update(stableJson({
      facts: facts.toJSON(), operation, effects: effects.map((effect) => effect.toJSON()), targetStepId,
      reviewBudgetConsumed, acceptanceUnreviewed, terminalReason: this.terminalReason,
      continuationDecision: this.continuationDecision,
    })).digest("hex");
    Object.freeze(this);
  }

  matches(other) { return other instanceof TaskReviewStageTransitionPlan && this.identity === other.identity; }

  toJSON() {
    return {
      facts: this.facts.toJSON(), operation: this.operation,
      effects: this.effects.map((effect) => effect.toJSON()), targetStepId: this.targetStepId,
      reviewBudgetConsumed: this.reviewBudgetConsumed, acceptanceUnreviewed: this.acceptanceUnreviewed,
      continuationDecision: this.continuationDecision,
      terminalReason: this.terminalReason, identity: this.identity,
    };
  }
}

function effects(taskId, entries) {
  return entries.map(([role, status, reason = null]) => new TaskReviewStageStepEffect({
    stepId: `${taskId}-${role}`, status, reason,
  }));
}

export function createTaskReviewStageTransitionPlan(facts, input) {
  return new TaskReviewStageTransitionPlan(TOKEN, { facts, ...input });
}

export function taskReviewStageEffects(taskId, entries) { return effects(taskId, entries); }

export function taskReviewStagePlanFromJSON(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Task Review stage plan is invalid");
  const facts = new TaskReviewStageFacts(value.facts);
  const plan = new TaskReviewStageTransitionPlan(TOKEN, {
    facts,
    operation: value.operation,
    effects: (value.effects || []).map((effect) => new TaskReviewStageStepEffect(effect)),
    targetStepId: value.targetStepId,
    reviewBudgetConsumed: value.reviewBudgetConsumed,
    acceptanceUnreviewed: value.acceptanceUnreviewed,
    terminalReason: value.terminalReason,
  });
  if (value.identity !== plan.identity) throw new Error("Task Review stage plan identity is invalid");
  return plan;
}
