import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * Typed flow step outcomes and durable attempt records.
 *
 * Command/process output is interpreted once at the boundary. Flow control
 * after that boundary discriminates with `instanceof`, while `kind` exists
 * only in the persisted JSON representation.
 */

import { UserActionPrompt } from "./user-action-prompt.js";
import { RetryTargetRoute } from "./retry-target-route.js";
import { NONBLOCKING_SOURCE_STEPS } from "./nonblocking-route.js";
export { NONBLOCKING_SOURCE_STEPS };
export const NONBLOCKING_TEXT_MAX_LENGTH = 2_000;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireAttempt(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("step attempt must be a positive integer");
  }
  return value;
}

function requireNonblockingText(value, field) {
  const normalized = requireString(value, field).trim();
  if (normalized.length > NONBLOCKING_TEXT_MAX_LENGTH) {
    throw new Error(`${field} must be no longer than ${NONBLOCKING_TEXT_MAX_LENGTH} characters`);
  }
  return normalized;
}

function requireNonblockingStep(value, field) {
  const step = requireString(value, field).trim();
  if (!NONBLOCKING_SOURCE_STEPS.includes(step)) {
    throw new Error(`${field} is not an eligible nonblocking step`);
  }
  return step;
}

export class StepOutcome {
  constructor({
    terminal,
    nextAction = null,
    resumeInstruction = null,
    yieldsControl = false,
    prompt = null,
  }) {
    if (new.target === StepOutcome) throw new Error("StepOutcome is abstract");
    if (typeof terminal !== "boolean") throw new Error("step outcome terminal must be boolean");
    if (nextAction != null) requireString(nextAction, "nextAction");
    if (resumeInstruction != null) requireString(resumeInstruction, "resumeInstruction");
    if ((nextAction == null) === (resumeInstruction == null)) {
      throw new Error("step outcome requires exactly one nextAction or resumeInstruction");
    }
    this.terminal = terminal;
    this.nextAction = nextAction;
    this.resumeInstruction = resumeInstruction;
    if (typeof yieldsControl !== "boolean") throw new Error("step outcome yieldsControl must be boolean");
    this.yieldsControl = yieldsControl;
    this.prompt = prompt == null ? null : UserActionPrompt.fromStored(prompt);
    if (this.yieldsControl !== (this.prompt != null)) {
      throw new Error("step outcome yieldsControl requires exactly one valid UserActionPrompt");
    }
  }

  toJSON() {
    return {
      kind: this.kind,
      terminal: this.terminal,
      ...(this.nextAction ? { nextAction: this.nextAction } : {}),
      ...(this.resumeInstruction ? { resumeInstruction: this.resumeInstruction } : {}),
      ...(this.yieldsControl ? {
        yieldsControl: true,
        requiresUserAction: true,
        actionPrompt: this.prompt.toJSON(),
      } : {}),
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored step outcome must be an object");
    }
    const common = {
      nextAction: value.nextAction,
      resumeInstruction: value.resumeInstruction,
      prompt: value.actionPrompt,
    };
    if (value.kind === "retry") return new RetryOutcome({ nextAction: value.nextAction });
    if (value.kind === "decision") {
      return new DecisionOutcome({ decision: value.decision, nextAction: value.nextAction });
    }
    if (value.kind === "nonblocking-decision") return new NonBlockingDecisionOutcome(value);
    if (value.kind === "observed-nonpass") return new ObservedNonPassOutcome(value);
    if (value.kind === "defer") {
      return new DeferOutcome({ nextAction: value.nextAction, findingCount: value.findingCount });
    }
    if (value.kind === "external-blocked") {
      return new ExternalBlockedOutcome({
        reason: value.reason,
        failureCode: value.failureCode,
        retryable: value.retryable,
        recoveryHint: value.recoveryHint,
        recoveryCommand: value.recoveryCommand,
        ...common,
      });
    }
    if (value.kind === "awaiting-decision") {
      return new AwaitingDecisionOutcome({ reason: value.reason, ...common });
    }
    throw new Error(`unknown stored step outcome: ${value.kind}`);
  }
}

export class RetryOutcome extends StepOutcome {
  constructor({ nextAction }) {
    super({ terminal: false, nextAction });
    this.kind = "retry";
    Object.freeze(this);
  }
}

export class DecisionOutcome extends StepOutcome {
  constructor({ decision, nextAction }) {
    super({ terminal: true, nextAction });
    this.kind = "decision";
    this.decision = requireString(decision, "decision");
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), decision: this.decision };
  }
}

export class NonBlockingDecisionOutcome extends StepOutcome {
  constructor({ action, sourceStep, sourceAttempt, evidenceRef, evidenceDigest, rationale, remainingRisk = null, nextAction }) {
    if (!["repair", "retry", "continue"].includes(action)) throw new Error("invalid nonblocking decision action");
    sourceStep = requireNonblockingStep(sourceStep, "sourceStep");
    if (!Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1) throw new Error("sourceAttempt must be a positive integer");
    if (typeof evidenceRef !== "string" || evidenceRef.trim() === "") throw new Error("evidenceRef is required");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error("evidenceDigest must be SHA-256");
    rationale = requireNonblockingText(rationale, "rationale");
    if (action === "continue") remainingRisk = requireNonblockingText(remainingRisk, "remainingRisk");
    else if (remainingRisk != null) remainingRisk = requireNonblockingText(remainingRisk, "remainingRisk");
    super({ terminal: action === "continue", nextAction: requireString(nextAction, "nextAction") });
    this.kind = "nonblocking-decision";
    this.action = action;
    this.sourceStep = sourceStep;
    this.sourceAttempt = sourceAttempt;
    this.evidenceRef = evidenceRef;
    this.evidenceDigest = evidenceDigest;
    this.rationale = rationale;
    this.remainingRisk = remainingRisk;
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), action: this.action, sourceStep: this.sourceStep, sourceAttempt: this.sourceAttempt, evidenceRef: this.evidenceRef, evidenceDigest: this.evidenceDigest, rationale: this.rationale, ...(this.remainingRisk && { remainingRisk: this.remainingRisk }) };
  }
}

export class ObservedNonPassOutcome extends StepOutcome {
  constructor({ sourceStep, evidenceRef, evidenceDigest, resultKind, nextAction = "refresh-next-action" }) {
    sourceStep = requireNonblockingStep(sourceStep, "sourceStep");
    if (typeof evidenceRef !== "string" || evidenceRef.trim() === "") throw new Error("evidenceRef is required");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error("evidenceDigest must be SHA-256");
    if (!["quality", "tooling", "unavailable"].includes(resultKind)) throw new Error("observed non-pass resultKind is invalid");
    super({ terminal: false, nextAction });
    this.kind = "observed-nonpass";
    this.sourceStep = sourceStep;
    this.evidenceRef = evidenceRef;
    this.evidenceDigest = evidenceDigest;
    this.resultKind = resultKind;
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), sourceStep: this.sourceStep, evidenceRef: this.evidenceRef, evidenceDigest: this.evidenceDigest, resultKind: this.resultKind };
  }
}

export class DeferOutcome extends StepOutcome {
  constructor({ nextAction, findingCount = 0 }) {
    super({ terminal: true, nextAction });
    if (!Number.isSafeInteger(findingCount) || findingCount < 0) {
      throw new Error("defer findingCount must be a non-negative integer");
    }
    this.kind = "defer";
    this.findingCount = findingCount;
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), findingCount: this.findingCount };
  }
}

class StoppedOutcome extends StepOutcome {
  constructor({ reason, resumeInstruction, prompt = null }) {
    const normalizedReason = requireString(reason, "reason");
    const normalizedInstruction = requireString(resumeInstruction, "resumeInstruction");
    super({
      terminal: true,
      resumeInstruction: normalizedInstruction,
      yieldsControl: prompt != null,
      prompt,
    });
    this.reason = normalizedReason;
  }

  toJSON() {
    return { ...super.toJSON(), reason: this.reason };
  }
}

export class ExternalBlockedOutcome extends StoppedOutcome {
  constructor(input = {}) {
    super({ ...input, prompt: null });
    this.kind = "external-blocked";
    this.failureCode = input.failureCode == null
      ? "EXTERNAL_BLOCKED"
      : requireString(input.failureCode, "failureCode");
    if (input.retryable != null && typeof input.retryable !== "boolean") {
      throw new Error("external-blocked retryable must be boolean");
    }
    this.retryable = input.retryable === true;
    this.recoveryHint = input.recoveryHint == null
      ? this.resumeInstruction
      : requireString(input.recoveryHint, "recoveryHint");
    this.recoveryCommand = input.recoveryCommand == null
      ? null
      : requireString(input.recoveryCommand, "recoveryCommand");
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      failureCode: this.failureCode,
      retryable: this.retryable,
      recoveryHint: this.recoveryHint,
      ...(this.recoveryCommand && { recoveryCommand: this.recoveryCommand }),
    };
  }
}

export class AwaitingDecisionOutcome extends StoppedOutcome {
  constructor(input) {
    if (input?.prompt == null) {
      throw new Error("awaiting-decision outcome requires a UserActionPrompt");
    }
    super(input);
    this.kind = "awaiting-decision";
    Object.freeze(this);
  }
}

export class StepAttempt {
  constructor({ runId, taskId = null, stepId, attempt, outcome, recordedAt = new Date().toISOString() }) {
    this.runId = requireString(runId, "runId");
    if (taskId != null) requireString(taskId, "taskId");
    this.taskId = taskId;
    this.stepId = requireString(stepId, "stepId");
    this.attempt = requireAttempt(attempt);
    if (!(outcome instanceof StepOutcome)) throw new Error("StepAttempt outcome must be a StepOutcome");
    this.outcome = outcome;
    this.recordedAt = requireString(recordedAt, "recordedAt");
    Object.freeze(this);
  }

  sameIdentity(other) {
    const sameAttempt = other instanceof StepAttempt
      && this.runId === other.runId
      && this.taskId === other.taskId
      && this.stepId === other.stepId
      && this.attempt === other.attempt;
    if (!sameAttempt) return false;
    // A check observation and its evidence-bound nonblocking decision are
    // separate durable facts from the check's ordinary outcome. All ordinary
    // outcome writes, including two decisions, retain the original
    // one-outcome-per-attempt replacement semantics.
    const pair = new Set([this.outcome.kind, other.outcome.kind]);
    if (this.outcome.kind === other.outcome.kind) return true;
    return !pair.has("observed-nonpass") && !pair.has("nonblocking-decision");
  }

  toJSON() {
    return {
      runId: this.runId,
      taskId: this.taskId,
      stepId: this.stepId,
      attempt: this.attempt,
      outcome: this.outcome.toJSON(),
      recordedAt: this.recordedAt,
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored StepAttempt must be an object");
    }
    return new StepAttempt({
      ...value,
      outcome: StepOutcome.fromStored(value.outcome),
    });
  }
}

export class StepAttemptLog {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new Error("stepAttempts must be an array");
    this.entries = entries.map((entry) => entry instanceof StepAttempt ? entry : StepAttempt.fromStored(entry));
  }

  record(attempt) {
    if (!(attempt instanceof StepAttempt)) throw new Error("StepAttempt is required");
    const index = this.entries.findIndex((entry) => entry.sameIdentity(attempt));
    if (index >= 0) this.entries.splice(index, 1);
    this.entries.push(attempt);
    return attempt;
  }

  latestForRun(runId) {
    return this.entries.findLast((entry) => entry.runId === runId) || null;
  }

  latest({ runId, taskId = null, stepId }) {
    return this.entries.findLast((entry) => (
      entry.runId === runId && entry.taskId === taskId && entry.stepId === stepId
    )) || null;
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}

export function persistStepAttempt(ctx, attempt, routeOptions) {
  void ctx;
  void routeOptions;
  if (!(attempt instanceof StepAttempt)) throw new Error("StepAttempt is required");
  // Attempt history is producer-owned catalog content. The Store publishes it
  // with the command result; this adapter only exposes the typed value to the
  // lifecycle envelope.
  return attempt;
}

export function recordStepAttempt(ctx, { stepId, attempt, outcome, result = null, routeOptions = undefined }) {
  if (ctx?.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || !ctx.flowState.runId) {
    throw new Error("recordStepAttempt requires an active canonical Flow state");
  }
  const record = new StepAttempt({
    runId: ctx.flowState.runId,
    taskId: ctx.flowState.currentTaskId ?? null,
    stepId,
    attempt,
    outcome,
  });
  persistStepAttempt(ctx, record, routeOptions);
  if (result && typeof result === "object") {
    result.stepAttempt = record.toJSON();
    result.artifacts = {
      ...(result.artifacts || {}),
      stepOutcome: outcome.toJSON(),
    };
  }
  return record;
}

export function retryResetTimestampForStep(flowState, stepId) {
  const route = RetryTargetRoute.forStep(stepId);
  if (!route) return -Infinity;
  return (flowState.metrics || [])
    .filter((entry) => (
      entry?.phase === route.phase
      && entry?.counter === route.counter
      && entry?.reset === true
    ))
    .map((entry) => Date.parse(entry.ts))
    .filter(Number.isFinite)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), -Infinity);
}

export function nextStepAttemptNumber(flowState, stepId) {
  if (flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
    throw new Error("nextStepAttemptNumber requires an active canonical Flow state");
  }
  const find = (steps) => {
    for (const step of steps || []) {
      if (step.id === stepId) return step;
      const nested = find(step.children || step.steps || []);
      if (nested) return nested;
    }
    return null;
  };
  const node = find(flowState.steps)
    || flowState.tasks?.map((task) => find(task.steps)).find(Boolean)
    || null;
  // A post-hook runs after its confirmation Activity, so the authoritative
  // node sequence is the just-recorded attempt rather than a mutable counter.
  return node?.attemptSequence || 1;
}
