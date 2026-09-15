/**
 * src/flow/lib/review-failure.js
 *
 * Review failure taxonomy and recovery state helpers.
 */

import { reviewPhaseForFlowStepId } from "./review-route.js";
import {
  AgentFailure,
  AgentFailurePersistenceContract,
  AgentProcessStopEvidence,
  AgentProviderCompletionEvidence,
} from "../../lib/agent-failure.js";
import { PromptBatchingError } from "../../lib/prompt-batching.js";
import { PRODUCT } from "../../lib/product.js";

export const REVIEW_FAILURE_MARKER_PREFIX = `${PRODUCT.env("REVIEW_FAILURE")} `;

const CLASSIFICATIONS = Object.freeze([
  "review_verdict_failure",
  "subprocess_failure",
  "provider_failure",
  "input_size_failure",
  "schema_failure",
  "publication_failure",
  "max_attempts_exceeded",
]);

const MARKER_CLASSIFICATIONS = Object.freeze([
  "provider_failure",
  "input_size_failure",
  "schema_failure",
]);
const DEFAULT_SCHEMA_FAILURE_MAX_ATTEMPTS = 2;
const INPUT_SIZE_PROMPT_FAILURE_CODES = Object.freeze([
  "PROMPT_ELEMENT_TOO_LARGE",
  "PROMPT_PARTITION_NO_PROGRESS",
  "PROMPT_FIXED_CONTEXT_TOO_LARGE",
  "PROMPT_BATCH_OVERFLOW",
  "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
  "PROMPT_BATCH_COUNT_EXCEEDED",
]);
function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function cleanReason(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function retryResetCommand(phase) {
  return `sennel flow set retry reset review ${phase} --reason <text> --yes`;
}

function retryReviewCommand(phase) {
  return phase === "impl"
    ? "sennel flow run review"
    : `sennel flow run review --phase ${phase}`;
}

export function reviewPhaseForStepId(stepId) {
  return stepId === "task-review" ? "impl" : reviewPhaseForFlowStepId(stepId);
}

function matchesInputSizeFailure(text) {
  return /prompt.*too large|input.*too large|context.*length|maximum context|token limit/i.test(text);
}

export class ReviewFailure {
  constructor(input = {}) {
    const classification = requireString(input.classification, "classification");
    if (!CLASSIFICATIONS.includes(classification)) {
      throw new Error(`unknown review failure classification: ${classification}`);
    }
    this.phase = requireString(input.phase || "impl", "phase");
    this.classification = classification;
    this.reason = input.reason ? String(input.reason) : null;
    this.retryBudgetConsumed = input.retryBudgetConsumed === true;
    this.recoveryHint = input.recoveryHint ? String(input.recoveryHint) : null;
    this.recoveryCommand = input.recoveryCommand ? String(input.recoveryCommand) : null;
    this.failureCode = input.failureCode ? requireString(input.failureCode, "failureCode") : null;
    if (input.retryable != null && typeof input.retryable !== "boolean") {
      throw new Error("review failure retryable must be boolean");
    }
    this.retryable = input.retryable === true;
    this.agentFailureKind = input.agentFailureKind ? requireString(input.agentFailureKind, "agentFailureKind") : null;
    this.agentStopEvidence = input.agentStopEvidence == null
      ? null
      : AgentProcessStopEvidence.from(input.agentStopEvidence);
    this.agentProviderCompletionEvidence = input.agentProviderCompletionEvidence == null
      ? null
      : AgentProviderCompletionEvidence.from(input.agentProviderCompletionEvidence);
    if (this.agentStopEvidence !== null && this.failureCode !== "AGENT_TIMEOUT") {
      throw new Error("review agent stop evidence belongs only to AGENT_TIMEOUT failures");
    }
    if (this.failureCode === "AGENT_TIMEOUT" && this.agentStopEvidence === null) {
      throw new Error("review AGENT_TIMEOUT failure requires process stop evidence");
    }
    if (this.failureCode === "AGENT_TIMEOUT" && this.retryable !== this.agentStopEvidence.confirmed) {
      throw new Error("review AGENT_TIMEOUT retry policy must match its process stop evidence");
    }
    if (this.agentProviderCompletionEvidence !== null && this.failureCode === "AGENT_TIMEOUT") {
      throw new Error("normal provider completion evidence cannot belong to AGENT_TIMEOUT");
    }
    if (this.agentProviderCompletionEvidence !== null && classification !== "provider_failure") {
      throw new Error("provider completion evidence belongs only to provider failures");
    }
    if (this.agentProviderCompletionEvidence !== null
      && this.agentProviderCompletionEvidence.signal !== null
      && this.retryable) {
      throw new Error("signaled provider completion evidence cannot be retryable");
    }
    this.attemptCount = input.attemptCount ?? null;
    this.maxAttempts = input.maxAttempts ?? null;
    if ((this.attemptCount == null) !== (this.maxAttempts == null)) {
      throw new Error("review agent attemptCount and maxAttempts must be provided together");
    }
    if (this.attemptCount != null && (
      !Number.isSafeInteger(this.attemptCount)
      || this.attemptCount < 1
      || !Number.isSafeInteger(this.maxAttempts)
      || this.maxAttempts < this.attemptCount
    )) {
      throw new Error("review agent attempts must be positive integers within maxAttempts");
    }
    if (this.agentProviderCompletionEvidence !== null && (
      this.attemptCount !== this.agentProviderCompletionEvidence.attemptCount
      || this.maxAttempts !== this.agentProviderCompletionEvidence.maxAttempts
    )) {
      throw new Error("review agent attempts must match provider completion evidence");
    }
    if (this.agentProviderCompletionEvidence !== null && this.agentFailureKind === null) {
      throw new Error("provider completion evidence requires an AgentFailure kind");
    }
    const stableContract = this.failureCode === null
      ? null
      : AgentFailurePersistenceContract.fromPersisted({
          code: this.failureCode,
          message: this.reason || "persisted Review Agent failure",
          attemptCount: this.attemptCount ?? 1,
          maxAttempts: this.maxAttempts ?? 1,
          providerCompletionEvidence: this.agentProviderCompletionEvidence,
          stopEvidence: this.agentStopEvidence,
        });
    if (this.agentProviderCompletionEvidence !== null && stableContract === null) {
      throw new Error("provider completion evidence requires a recognized stable AgentFailure code");
    }
    stableContract?.assertFacts({
      retryable: this.retryable,
      agentFailureKind: this.agentFailureKind,
    });
    this.exitCode = input.exitCode ?? null;
    this.signal = input.signal ?? null;
    this.killed = input.killed === true;
    this.attempts = input.attempts ?? null;
    this.max = input.max ?? null;
    this.targetReview = input.targetReview ? String(input.targetReview) : null;
    this.validationError = input.validationError ? String(input.validationError) : null;
    this.currentAttempt = input.currentAttempt ?? null;
    this.maximumAttempts = input.maximumAttempts ?? null;
    if (classification === "schema_failure") {
      requireString(this.targetReview, "targetReview");
      requireString(this.validationError, "validationError");
      if (!Number.isInteger(this.currentAttempt) || this.currentAttempt < 1) {
        throw new Error("currentAttempt must be a positive integer");
      }
      if (!Number.isInteger(this.maximumAttempts) || this.maximumAttempts < this.currentAttempt) {
        throw new Error("maximumAttempts must be an integer greater than or equal to currentAttempt");
      }
    }
  }

  static classifications() {
    return [...CLASSIFICATIONS];
  }

  static reviewVerdictFailure({ phase, reason = "review verdict failed" } = {}) {
    return new ReviewFailure({
      phase,
      classification: "review_verdict_failure",
      reason,
      retryBudgetConsumed: true,
    });
  }

  static subprocessFailure({ phase, exitCode = null, signal = null, killed = false, stderr = "" } = {}) {
    const reason = signal
      ? `subprocess signal: ${signal}`
      : killed
        ? "subprocess killed"
        : cleanReason(stderr, "subprocess failed");
    return new ReviewFailure({
      phase,
      classification: "subprocess_failure",
      reason,
      retryBudgetConsumed: false,
      exitCode,
      signal,
      killed,
    });
  }

  static providerFailure({
    phase,
    reason,
    recoveryHint,
    recoveryCommand,
    failureCode = "AGENT_UNKNOWN_PROVIDER_FAILURE",
    retryable = false,
    agentFailureKind = "unknown_provider",
    agentStopEvidence = null,
    agentProviderCompletionEvidence = null,
    attemptCount = null,
    maxAttempts = null,
  } = {}) {
    return new ReviewFailure({
      phase,
      classification: "provider_failure",
      reason: requireString(reason, "reason"),
      retryBudgetConsumed: false,
      recoveryHint: requireString(recoveryHint, "recoveryHint"),
      recoveryCommand: requireString(recoveryCommand, "recoveryCommand"),
      failureCode,
      retryable,
      agentFailureKind,
      agentStopEvidence,
      agentProviderCompletionEvidence,
      attemptCount,
      maxAttempts,
    });
  }

  static fromAgentFailure({ phase = "impl", failure, recoveryCommand = null } = {}) {
    if (!(failure instanceof AgentFailure)) throw new Error("AgentFailure is required");
    return ReviewFailure.providerFailure({
      phase,
      reason: failure.message,
      recoveryHint: failure.recoveryHint,
      recoveryCommand: recoveryCommand || retryReviewCommand(phase),
      failureCode: failure.code,
      retryable: failure.retryable,
      agentFailureKind: failure.kind,
      agentStopEvidence: failure.stopEvidence ?? null,
      agentProviderCompletionEvidence: failure.providerCompletionEvidence ?? null,
      attemptCount: failure.attemptCount,
      maxAttempts: failure.maxAttempts,
    });
  }

  static inputSizeFailure({ phase, reason, recoveryHint, recoveryCommand, failureCode = null } = {}) {
    return new ReviewFailure({
      phase,
      classification: "input_size_failure",
      reason: requireString(reason, "reason"),
      retryBudgetConsumed: false,
      recoveryHint: requireString(recoveryHint, "recoveryHint"),
      recoveryCommand: requireString(recoveryCommand, "recoveryCommand"),
      failureCode,
    });
  }

  static fromPromptBatchingFailure({ phase = "impl", failure, recoveryCommand = null } = {}) {
    if (!(failure instanceof PromptBatchingError)) {
      throw new Error("PromptBatchingError is required");
    }
    if (!INPUT_SIZE_PROMPT_FAILURE_CODES.includes(failure.code)) return null;
    return ReviewFailure.inputSizeFailure({
      phase,
      reason: cleanReason(failure.message, "review input is too large"),
      recoveryHint: "Reduce or partition the canonical review input before retrying.",
      recoveryCommand: recoveryCommand || retryReviewCommand(phase),
      failureCode: failure.code,
    });
  }

  static schemaFailure({
    phase = "impl",
    targetReview,
    validationError,
    currentAttempt = 1,
    maximumAttempts = DEFAULT_SCHEMA_FAILURE_MAX_ATTEMPTS,
  } = {}) {
    return new ReviewFailure({
      phase,
      classification: "schema_failure",
      reason: `${requireString(targetReview, "targetReview")} output schema validation failed`,
      retryBudgetConsumed: false,
      targetReview,
      validationError: requireString(validationError, "validationError"),
      currentAttempt,
      maximumAttempts,
    });
  }

  static maxAttemptsExceeded({ phase, attempts, max } = {}) {
    const safePhase = requireString(phase, "phase");
    return new ReviewFailure({
      phase: safePhase,
      classification: "max_attempts_exceeded",
      attempts,
      max,
      retryBudgetConsumed: false,
      recoveryHint: "Reset the review retry counter before retrying this phase.",
      recoveryCommand: retryResetCommand(safePhase),
    });
  }

  static publicationFailure({ phase = "impl", reason } = {}) {
    return new ReviewFailure({ phase, classification: "publication_failure", reason: requireString(reason, "reason"),
      failureCode: "TASK_REVIEW_PUBLICATION_UNAVAILABLE", retryable: false, retryBudgetConsumed: false });
  }

  static fromMarkerLine(line) {
    if (typeof line !== "string" || !line.startsWith(REVIEW_FAILURE_MARKER_PREFIX)) return null;
    try {
      const data = JSON.parse(line.slice(REVIEW_FAILURE_MARKER_PREFIX.length));
      if (!MARKER_CLASSIFICATIONS.includes(data?.classification)) return null;
      if (data.classification === "schema_failure") {
        return ReviewFailure.schemaFailure({
          phase: data.phase,
          targetReview: data.targetReview,
          validationError: data.validationError,
          currentAttempt: data.currentAttempt,
          maximumAttempts: data.maximumAttempts,
        });
      }
      if (!data.phase || !data.reason || !data.recoveryHint || !data.recoveryCommand) return null;
      return new ReviewFailure({
        phase: data.phase,
        classification: data.classification,
        reason: data.reason,
        retryBudgetConsumed: false,
        recoveryHint: data.recoveryHint,
        recoveryCommand: data.recoveryCommand,
        failureCode: data.failureCode,
        retryable: data.retryable,
        agentFailureKind: data.agentFailureKind,
        agentStopEvidence: data.agentStopEvidence,
        agentProviderCompletionEvidence: data.agentProviderCompletionEvidence,
        attemptCount: data.attemptCount,
        maxAttempts: data.maxAttempts,
      });
    } catch (_) {
      return null;
    }
  }

  static fromMessage({ phase = "impl", message = "", recoveryCommand = null } = {}) {
    const text = String(message || "");
    const command = recoveryCommand || retryReviewCommand(phase);
    if (matchesInputSizeFailure(text)) {
      return ReviewFailure.inputSizeFailure({
        phase,
        reason: cleanReason(text.split(/\r?\n/)[0], "review input is too large"),
        recoveryHint: "Reduce review input before retrying.",
        recoveryCommand: command,
      });
    }
    return null;
  }

  static fromSubprocessResult({ phase, result } = {}) {
    const stderr = String(result?.stderr || "");
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      const marker = ReviewFailure.fromMarkerLine(trimmed);
      if (marker) return marker;
    }
    return ReviewFailure.subprocessFailure({
      phase,
      exitCode: result?.status ?? null,
      signal: result?.signal ?? null,
      killed: result?.killed === true,
      stderr,
    });
  }

  shouldRetrySubprocess({ attempt, maxAttempts } = {}) {
    if (this.classification !== "subprocess_failure" && this.classification !== "schema_failure") return false;
    if (this.classification === "subprocess_failure" && (this.signal || this.killed)) return false;
    return Number(attempt) < Number(maxAttempts);
  }

  withAttempts({ currentAttempt, maximumAttempts } = {}) {
    if (this.classification !== "schema_failure") return this;
    return ReviewFailure.schemaFailure({
      phase: this.phase,
      targetReview: this.targetReview,
      validationError: this.validationError,
      currentAttempt,
      maximumAttempts,
    });
  }

  requiresImmediateBlock() {
    return this.classification === "provider_failure" || this.classification === "input_size_failure";
  }

  toEnvelopeCode() {
    return this.failureCode || this.classification.toUpperCase();
  }

  toExecutionError(cause = null) {
    const error = new Error(this.reason || `${this.classification} during ${this.phase} Review`, cause === null ? undefined : { cause });
    error.code = this.toEnvelopeCode();
    error.retryable = this.retryable;
    error.reviewFailure = this;
    error.agentFailureKind = this.agentFailureKind;
    error.attemptCount = this.attemptCount;
    error.maxAttempts = this.maxAttempts;
    if (this.agentStopEvidence !== null) error.stopEvidence = this.agentStopEvidence;
    if (this.agentProviderCompletionEvidence !== null) {
      error.providerCompletionEvidence = this.agentProviderCompletionEvidence;
    }
    return error;
  }

  toEnvelopeData() {
    const data = {
      phase: this.phase,
      classification: this.classification,
      ...(this.reason && { reason: this.reason }),
      retryBudgetConsumed: this.retryBudgetConsumed,
      ...(this.recoveryHint && { recoveryHint: this.recoveryHint }),
      ...(this.recoveryCommand && { recoveryCommand: this.recoveryCommand }),
      ...(this.failureCode && { failureCode: this.failureCode }),
      retryable: this.retryable,
      ...(this.agentFailureKind && { agentFailureKind: this.agentFailureKind }),
      ...(this.agentStopEvidence !== null && { agentStopEvidence: this.agentStopEvidence.toJSON() }),
      ...(this.agentProviderCompletionEvidence !== null && {
        agentProviderCompletionEvidence: this.agentProviderCompletionEvidence.toJSON(),
      }),
      ...(this.attemptCount != null && { attemptCount: this.attemptCount }),
      ...(this.maxAttempts != null && { maxAttempts: this.maxAttempts }),
    };
    if (this.classification === "max_attempts_exceeded") {
      data.attempts = this.attempts;
      data.max = this.max;
    }
    if (this.classification === "schema_failure") {
      data.targetReview = this.targetReview;
      data.validationError = this.validationError;
      data.currentAttempt = this.currentAttempt;
      data.maximumAttempts = this.maximumAttempts;
    }
    return data;
  }

  toMarkerLine() {
    if (!MARKER_CLASSIFICATIONS.includes(this.classification)) {
      throw new Error(`classification cannot be emitted as review marker: ${this.classification}`);
    }
    return REVIEW_FAILURE_MARKER_PREFIX + JSON.stringify({
      phase: this.phase,
      classification: this.classification,
      reason: this.reason,
      ...(this.classification === "schema_failure" ? {
        targetReview: this.targetReview,
        validationError: this.validationError,
        currentAttempt: this.currentAttempt,
        maximumAttempts: this.maximumAttempts,
      } : {
        recoveryHint: this.recoveryHint,
        recoveryCommand: this.recoveryCommand,
        ...(this.failureCode && { failureCode: this.failureCode }),
        retryable: this.retryable,
        ...(this.agentFailureKind && { agentFailureKind: this.agentFailureKind }),
        ...(this.agentStopEvidence !== null && { agentStopEvidence: this.agentStopEvidence.toJSON() }),
        ...(this.agentProviderCompletionEvidence !== null && {
          agentProviderCompletionEvidence: this.agentProviderCompletionEvidence.toJSON(),
        }),
        ...(this.attemptCount != null && { attemptCount: this.attemptCount }),
        ...(this.maxAttempts != null && { maxAttempts: this.maxAttempts }),
      }),
    });
  }

  requiresIssueLog(options = {}) {
    return options.workaroundApplied === true
      || options.manualRecoveryRequired === true
      || options.specDecisionChanged === true;
  }
}
