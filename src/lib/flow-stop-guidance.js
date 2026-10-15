import { isDeepStrictEqual } from "node:util";
import { translate } from "./i18n.js";
import { AgentFailure, AgentFailurePersistenceContract } from "./agent-failure.js";
import { ProcessExecutionControlFailure, ProcessExecutionCommunicationAttempt } from "./process-execution-values.js";
import { FlowContinuation, UserActionPrompt, assertUserActionResultContract } from "../flow/lib/user-action-prompt.js";
import { StepOutcome, StepAttempt, ExternalBlockedOutcome, AwaitingDecisionOutcome } from "../flow/lib/step-outcome.js";
import { stableStringify, sha256 } from "../flow/lib/review-observation-values.js";
import { NextActionDirective, ExecuteContinuationDirective, SingleUserActionDirective,
  AwaitUserDecisionDirective, assertNextActionDirective } from "../flow/lib/next-action-directive.js";

const UNKNOWN = "unconfirmed";
const CODE = /^[A-Z][A-Z0-9_]{0,199}$/;
const FALLBACK = Object.freeze({
  explanation: "The Flow operation stopped ({{code}}). Inspect the returned diagnostic details for the original cause.",
  repair: "Provide error code {{code}} and the returned diagnostic details to the maintainer and request a fix before continuing.",
  automatic: "Continue using the selected directive and its existing execution authorization.",
  decision: "Answer the selected user decision before continuing.",
  external: "Complete the selected external task before continuing.",
  hostFilter: "Run the existing host review filter action: {{command}}. Submit its result through the selected directive before continuing.",
  privateText: "Provide the returned error code to the maintainer and request a diagnostic review before continuing.",
  privateDiagnostic: "Private diagnostic text was withheld.",
  unconfirmed: "unconfirmed",
});

function stableCode(value, fallback = "FLOW_OPERATION_STOPPED") {
  return typeof value === "string" && CODE.test(value) ? value
    : typeof fallback === "string" && CODE.test(fallback) ? fallback : "FLOW_OPERATION_STOPPED";
}
function safeText(value, fallback = "Flow diagnostic details are unavailable.", maxLength = 4000) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength
    || /owner[_-]?token|capabilit(?:y|ies)|\benv(?:ironment)?\s*[:=]/i.test(value)
    || /(?:^|\s)[A-Z][A-Z0-9_]*=|\n\s*at\s/.test(value)) return fallback;
  return value;
}
export { stableCode as publicFlowErrorCode, safeText as publicFlowErrorText };

function containsSyntaxFailure(error) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause instanceof SyntaxError) return true;
  }
  return false;
}

/** Native parser diagnostics can echo confidential input without a field label. */
export function publicFlowErrorMessage(error, fallback = "Flow diagnostic details are unavailable.") {
  if (containsSyntaxFailure(error)) return fallback;
  return safeText(error?.message ?? (typeof error === "string" ? error : null), fallback);
}

/** Public JSON projection never changes the in-memory execution authority. */
export function publicFlowStopValue(value, authority = false, text = translator(), actionText = false) {
  if (typeof value === "string") {
    if (value.trim() === "") return value;
    const publicText = safeText(value, null, Infinity);
    if (authority && publicText === null) throw new Error("FLOW_PUBLIC_AUTHORITY_SENSITIVE: execution authority cannot be published safely");
    return publicText ?? text(actionText ? "privateText" : "privateDiagnostic");
  }
  if (Array.isArray(value)) return value.map((entry) => publicFlowStopValue(entry, authority, text, actionText));
  if (value === null || typeof value !== "object") return value;
  if (typeof value.toJSON === "function") return publicFlowStopValue(value.toJSON(), authority, text, actionText);
  const source = value;
  const result = {};
  for (const [field, entry] of Object.entries(source)) {
    if (/^(owner[_-]?token|capabilit(?:y|ies)|env(?:ironment)?|stack)$/i.test(field)) {
      if (authority) throw new Error("FLOW_PUBLIC_AUTHORITY_SENSITIVE: execution authority contains private fields");
      continue;
    }
    const humanText = /^(reason|resumeInstruction|instruction|message|messages|recoveryHint|question|label|recommendationReason|description|preconditions|missingConditions)$/i.test(field);
    const actionText = /^(resumeInstruction|instruction|question|preconditions)$/i.test(field);
    // Dispatch nextAction objects retain descriptive metadata after their
    // directive is promoted. Continuation nextAction strings are authority.
    const executable = /^(command|binding|approvalToken)$/i.test(field)
      || field === "nextAction" && typeof entry === "string";
    result[field] = field === "code" ? stableCode(entry) : publicFlowStopValue(entry, humanText ? false : authority || executable, text, actionText);
  }
  return result;
}

/** Detect presentation drift only; this hash grants no execution authority. */
export function flowStopPresentationDigest(directive, nextAction, text = translator()) {
  return sha256(stableStringify({ directive: publicFlowStopValue(directive, false, text),
    nextAction: publicFlowStopValue(nextAction, false, text) }));
}

/** Locate already-selected public directives; this does not classify or select routes. */
export function selectedFlowStopDirective(data) {
  const direct = data?.directive == null ? null : NextActionDirective.fromStored(data.directive);
  const nested = data?.dispatch && data.nextAction?.directive != null
    ? NextActionDirective.fromStored(data.nextAction.directive) : null;
  if (direct !== null && nested !== null && direct !== nested) {
    throw new Error("FLOW_STOP_GUIDANCE_CONFLICT: competing direct and dispatch directives");
  }
  return direct ?? nested;
}

/** Catalog failure must never replace the original operational failure. */
function translator(injected) {
  let t = injected;
  try { t ??= translate(); } catch { /* Fixed minimal catalog below. */ }
  return (key, params = {}, fallback = "explanation") => {
    for (const candidate of new Set([key, Object.hasOwn(FALLBACK, key) ? key : fallback])) {
      const full = `messages:flowStop.${candidate}`;
      try {
        const value = t?.(full, params);
        if (typeof value === "string" && value !== full && value !== full.slice("messages:".length)
          && !/\{\{\w+\}\}/.test(value) && safeText(value, null) !== null) return value;
      } catch { /* Missing locale or arguments use the same safe fallback. */ }
    }
    const template = FALLBACK[key] ?? FALLBACK[fallback];
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? UNKNOWN);
  };
}

/** Acquired execution facts only; never reads state or selects a recovery route. */
export class FlowStopFacts {
  constructor({ operation = UNKNOWN, completion = UNKNOWN, persistence = UNKNOWN, stop = UNKNOWN,
    attemptCount = UNKNOWN, maxAttempts = UNKNOWN, budgetMs = UNKNOWN, elapsedMs = UNKNOWN,
    acceptance = UNKNOWN, communicationAttempts = [] } = {}) {
    for (const [field, value] of Object.entries({ operation, completion, persistence, stop, acceptance })) {
      if (typeof value !== "string" || value.trim() === "" || value.length > 200) throw new TypeError(`Flow stop ${field} must be a bounded fact`);
      this[field] = safeText(value, UNKNOWN);
    }
    for (const [field, value] of Object.entries({ attemptCount, maxAttempts, budgetMs, elapsedMs })) {
      if (value !== UNKNOWN && (!Number.isFinite(value) || value < 0)) throw new TypeError(`Flow stop ${field} must be observed or unconfirmed`);
      if (["attemptCount", "maxAttempts"].includes(field) && value !== UNKNOWN && !Number.isSafeInteger(value)) {
        throw new TypeError(`Flow stop ${field} must be an observed integer`);
      }
      this[field] = value;
    }
    if (!Array.isArray(communicationAttempts)) throw new TypeError("Flow stop attempts must be an array");
    this.communicationAttempts = Object.freeze(communicationAttempts.map((attempt) =>
      attempt instanceof ProcessExecutionCommunicationAttempt ? attempt : ProcessExecutionCommunicationAttempt.fromStored(attempt)));
    Object.freeze(this);
  }
  toJSON() { return { ...this, communicationAttempts: this.communicationAttempts.map((attempt) => attempt.toJSON()) }; }
}

class FlowStopCause {
  constructor({ kind, code, recoveryHint = UNKNOWN }) {
    this.kind = kind; this.code = stableCode(code);
    this.recoveryHint = safeText(recoveryHint, UNKNOWN);
    Object.freeze(this);
  }
  toJSON() { return { kind: this.kind, code: this.code, recoveryHint: this.recoveryHint }; }
}

function typedFailure(error, data) {
  const seen = new Set();
  for (let candidate = error; candidate && !seen.has(candidate); candidate = candidate.cause) {
    seen.add(candidate);
    if (candidate instanceof ProcessExecutionControlFailure || candidate instanceof AgentFailure) return candidate;
  }
  if (data?.processExecutionControlFailure) {
    try { return ProcessExecutionControlFailure.fromStored(data.processExecutionControlFailure); } catch { /* Invalid evidence cannot become an observed fact. */ }
  }
  for (const stored of [data?.agentFailure, data]) {
    try {
      if (AgentFailurePersistenceContract.fromPersisted(stored) !== null) return AgentFailure.from(stored);
    } catch { /* Unvalidated provider data cannot become a typed cause. */ }
  }
  return null;
}

function recordedAttempt(data) {
  return data?.stepAttempt == null ? null : data.stepAttempt instanceof StepAttempt
    ? data.stepAttempt : StepAttempt.fromStored(data.stepAttempt);
}

function recordedOutcome(data, attempt = recordedAttempt(data)) {
  const stored = data?.artifacts?.stepOutcome;
  const artifactOutcome = stored == null ? null : stored instanceof StepOutcome ? stored : StepOutcome.fromStored(stored);
  if (attempt !== null && artifactOutcome !== null && !isDeepStrictEqual(attempt.outcome.toJSON(), artifactOutcome.toJSON())) {
    throw new Error("FLOW_STOP_GUIDANCE_CONFLICT: stored Attempt and artifact outcomes disagree");
  }
  return attempt?.outcome ?? artifactOutcome;
}

export function hasStoppedStepOutcome(data) {
  const outcome = recordedOutcome(data);
  return outcome instanceof ExternalBlockedOutcome || outcome instanceof AwaitingDecisionOutcome;
}

export function flowStopDiagnosticCode(data) {
  const directive = selectedFlowStopDirective(data);
  const outcome = recordedOutcome(data);
  const fallback = directive?.kind === "await_task_review_filter" ? "FLOW_HOST_ACTION_REQUIRED"
    : directive?.requiresUserAction === true || directive?.prompt != null || data?.actionPrompt != null || outcome?.prompt != null
      ? "FLOW_AWAITING_USER_ACTION" : "FLOW_OPERATION_STOPPED";
  return stableCode(directive?.code, stableCode(outcome?.failureCode, fallback));
}

function observedFacts(failure, supplied, operation, attempt) {
  if (supplied !== null && !(supplied instanceof FlowStopFacts)) throw new TypeError("Flow stop facts require FlowStopFacts");
  const observed = attempt === null ? {} : { attemptCount: attempt.attempt };
  if (failure instanceof ProcessExecutionControlFailure && failure.communication !== null) {
    const communication = failure.communication;
    Object.assign(observed, { operation: communication.operation, attemptCount: communication.attempts.length,
      budgetMs: communication.budgetMs, elapsedMs: communication.elapsedMs,
      acceptance: communication.acceptance === "unknown" ? UNKNOWN : communication.acceptance,
      stop: communication.stopConfirmation === "confirmed" ? "confirmed" : UNKNOWN,
      communicationAttempts: communication.attempts });
  } else if (failure instanceof AgentFailure) {
    Object.assign(observed, { attemptCount: failure.attemptCount, maxAttempts: failure.maxAttempts });
    if (failure.stopEvidence) observed.stop = failure.stopEvidence.confirmed ? "confirmed" : UNKNOWN;
    if (Number.isFinite(failure.timeoutMs)) observed.budgetMs = failure.timeoutMs;
  }
  if (supplied !== null) {
    for (const [field, value] of Object.entries(supplied.toJSON())) {
      if (value !== UNKNOWN && (field !== "communicationAttempts" || value.length > 0)) observed[field] = value;
    }
  }
  if (!Object.hasOwn(observed, "operation") && operation !== null) {
    observed.operation = typeof operation === "string" && operation.length <= 200 ? safeText(operation, UNKNOWN) : UNKNOWN;
  }
  return new FlowStopFacts(observed);
}

class FlowStopActionPresentation {
  constructor({ kind, instruction, preconditions }) {
    if (!["automatic", "single_user_action", "user_decision", "external_work"].includes(kind)
      || typeof instruction !== "string" || instruction.trim() === "" || !Array.isArray(preconditions)) {
      throw new TypeError("Flow stop action presentation requires a concrete action and prerequisite list");
    }
    this.kind = kind;
    this.instruction = instruction;
    this.preconditions = Object.freeze([...preconditions]);
    Object.freeze(this);
  }
  toJSON() { return { kind: this.kind, instruction: this.instruction, preconditions: [...this.preconditions] }; }
  static fromStored(value) {
    if (!value || Object.keys(value).sort().join(",") !== "instruction,kind,preconditions"
      || safeText(value.instruction, null, Infinity) !== value.instruction
      || !Array.isArray(value.preconditions)
      || value.preconditions.some((condition) => typeof condition !== "string" || safeText(condition, null, Infinity) !== condition)) {
      throw new TypeError("Stored Flow action presentation must contain safe public text");
    }
    return new FlowStopActionPresentation(value);
  }
}

function presentDirective(directive, text) {
  if (directive.kind === "await_task_review_filter") return new FlowStopActionPresentation({ kind: "external_work",
    instruction: text("hostFilter", { command: directive.command }), preconditions: [] });
  if (directive.kind === "single_user_action") return new FlowStopActionPresentation({ kind: directive.category,
    instruction: safeText(directive.instruction, text("privateText")),
    preconditions: directive.preconditions.map((condition) => safeText(condition, text("privateText"))) });
  if (directive.prompt) return new FlowStopActionPresentation({ kind: "user_decision", instruction: safeText(directive.prompt.question, text("privateText")), preconditions: [] });
  if (directive.requiresUserAction) return new FlowStopActionPresentation({ kind: "single_user_action",
    instruction: safeText(directive.question ?? directive.instruction, text("privateText")), preconditions: [] });
  if (directive.kind === "blocked") return new FlowStopActionPresentation({ kind: "external_work",
    instruction: safeText(directive.resumeInstruction, text("privateText")),
    preconditions: (directive.diagnostic?.missingConditions ?? []).map((condition) => safeText(condition, text("privateText"))) });
  return new FlowStopActionPresentation({ kind: "automatic", instruction: directive.instruction == null
    ? text("automatic") : safeText(directive.instruction, text("privateText")), preconditions: [] });
}

/** Presentation references, but never duplicates, the selected execution authority. */
export class FlowStopGuidance {
  constructor({ code, cause, explanation, facts, directive, text, presentation = null }) {
    if (!(directive instanceof NextActionDirective) || !(facts instanceof FlowStopFacts) || !(cause instanceof FlowStopCause)) {
      throw new TypeError("Flow stop guidance requires typed facts, cause and directive");
    }
    Object.defineProperty(this, "directive", { value: directive });
    Object.defineProperty(this, "text", { value: text });
    this.schemaVersion = 1;
    this.code = stableCode(code);
    this.cause = cause;
    this.explanation = explanation;
    this.currentState = facts;
    if (presentation !== null && !(presentation instanceof FlowStopActionPresentation)) throw new TypeError("Flow guidance presentation must be typed");
    this.nextAction = presentation ?? presentDirective(directive, text);
    this.presentationDigest = flowStopPresentationDigest(directive, this.nextAction, text);
    this.diagnosticReference = this.code;
    Object.freeze(this);
  }
  assertDirective(directive) {
    if (directive !== this.directive || this.presentationDigest !== flowStopPresentationDigest(directive, this.nextAction, this.text)) {
      throw new Error("FLOW_STOP_GUIDANCE_CONFLICT: guidance must reference the sole selected directive");
    }
  }
  toJSON() {
    this.assertDirective(this.directive);
    return { schemaVersion: this.schemaVersion, code: this.code, cause: this.cause.toJSON(),
      explanation: this.explanation, currentState: this.currentState.toJSON(),
      nextAction: this.nextAction.toJSON(), diagnosticReference: this.diagnosticReference,
      presentationDigest: this.presentationDigest };
  }
  static fromStored(value, { directive } = {}) {
    if (value instanceof FlowStopGuidance) { value.assertDirective(directive); return value; }
    if (!value || value.schemaVersion !== 1 || value.code !== stableCode(value.code)
      || value.diagnosticReference !== value.code || typeof value.cause?.kind !== "string"
      || !/^[a-z_]{1,100}$/.test(value.cause.kind) || value.cause.code !== stableCode(value.cause.code)
      || typeof value.presentationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.presentationDigest)) {
      throw new TypeError("Stored Flow stop guidance has invalid diagnostic identity");
    }
    // Stored presentation is already public and is bound to the selected
    // directive. Do not reload or reinterpret its original locale catalog.
    const text = translator(() => undefined);
    const restored = new FlowStopGuidance({ code: value.code, cause: new FlowStopCause(value.cause),
      explanation: safeText(value.explanation, text("explanation", { code: value.code })),
      facts: new FlowStopFacts(value.currentState), directive, text,
      presentation: FlowStopActionPresentation.fromStored(value.nextAction) });
    if (!isDeepStrictEqual(restored.toJSON(), value)) {
      throw new Error("FLOW_STOP_GUIDANCE_CONFLICT: stored guidance differs from the selected directive or facts");
    }
    return restored;
  }
}

class NormalizedFlowStopResult {
  constructor({ data, guidance }) {
    this.data = data;
    this.directive = guidance.directive;
    this.guidance = guidance;
    guidance.assertDirective(data.directive);
    Object.freeze(this);
  }
}

export function buildFlowStopGuidance({ code, error = null, data = null, directive = null,
  operation = null, facts = null, t = null } = {}) {
  const text = translator(t);
  const publicCode = stableCode(code ?? error?.code);
  const failure = typedFailure(error, data);
  const selected = directive ?? (data?.directive == null ? null : NextActionDirective.fromStored(data.directive));
  const external = failure instanceof AgentFailure && failure.requiresExternalIntervention;
  const chosen = selected ?? new SingleUserActionDirective({ actionId: external ? "RESOLVE_PROVIDER_EXTERNAL_FAILURE" : "REQUEST_FLOW_DIAGNOSTIC_REPAIR",
    instruction: external ? text(`actions.${failure.kind}`, { code: publicCode }, "repair") : text("repair", { code: publicCode }),
    reason: text("explanation", { code: publicCode }) });
  const cause = new FlowStopCause({ kind: failure instanceof ProcessExecutionControlFailure ? "process_control"
    : failure instanceof AgentFailure ? failure.kind : error === null ? "reported_failure" : "unclassified_failure",
  code: failure?.primaryCause?.code ?? failure?.code
    ?? stableCode(error?.code, containsSyntaxFailure(error) ? "SYNTAX_ERROR" : publicCode),
  recoveryHint: failure instanceof AgentFailure ? failure.recoveryHint : UNKNOWN });
  const explanationKey = failure instanceof ProcessExecutionControlFailure ? "processControl"
    : failure instanceof AgentFailure ? `causes.${failure.kind}` : `codes.${publicCode}`;
  const explanation = text(explanationKey, { code: publicCode, causeCode: cause.code });
  return new FlowStopGuidance({ code: publicCode, cause, explanation,
    facts: observedFacts(failure, facts, operation, recordedAttempt(data)), directive: chosen, text });
}

/** Normalize selected legacy projections once, preserving their actual authority. */
export function normalizeFlowStopResult(data, options = {}) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : data == null ? {} : { result: data };
  assertNextActionDirective(source);
  assertUserActionResultContract(source);
  let directive = selectedFlowStopDirective(source);
  const attempt = recordedAttempt(source);
  const outcome = recordedOutcome(source, attempt);
  if (options.directive != null) {
    if (directive !== null && directive !== options.directive) throw new Error("FLOW_STOP_GUIDANCE_CONFLICT: competing selected directives");
    directive = options.directive;
  }
  if (directive === null && source.continuation != null) {
    directive = new ExecuteContinuationDirective({ continuation: FlowContinuation.fromStored(source.continuation) });
  } else if (directive === null && source.actionPrompt != null) {
    directive = new AwaitUserDecisionDirective({ prompt: UserActionPrompt.fromStored(source.actionPrompt) });
  } else if (directive === null && outcome?.prompt != null) {
    directive = new AwaitUserDecisionDirective({ prompt: outcome.prompt, reason: outcome.reason });
  } else if (directive === null && outcome?.resumeInstruction != null) {
    directive = new SingleUserActionDirective({ actionId: "RESOLVE_SELECTED_STEP_STOP", instruction: outcome.resumeInstruction,
      reason: outcome.reason });
  } else if (directive === null && outcome?.nextAction != null) {
    directive = new ExecuteContinuationDirective({ continuation: new FlowContinuation({ actionId: "CONTINUE_SELECTED_STEP_OUTCOME",
      nextAction: outcome.nextAction, instruction: outcome.nextAction, reason: outcome.reason ?? "The Step selected this continuation." }) });
  }
  const guidance = buildFlowStopGuidance({ ...options, data: attempt === null ? source : { ...source, stepAttempt: attempt }, directive });
  if (source.guidance != null) {
    if (!(source.guidance instanceof FlowStopGuidance)) throw new TypeError("Flow guidance must be a FlowStopGuidance");
    source.guidance.assertDirective(guidance.directive);
  }
  const normalized = { ...source };
  for (const field of ["continuation", "actionPrompt", "yieldsControl", "requiresUserAction", "guidance"]) delete normalized[field];
  normalized.directive = guidance.directive;
  if (source.dispatch && source.nextAction?.directive != null) {
    normalized.nextAction = { ...source.nextAction };
    delete normalized.nextAction.directive;
  }
  return new NormalizedFlowStopResult({ data: normalized, guidance });
}
