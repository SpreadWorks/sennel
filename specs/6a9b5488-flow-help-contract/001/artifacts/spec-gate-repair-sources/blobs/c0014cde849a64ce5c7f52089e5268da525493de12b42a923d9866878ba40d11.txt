const ACTION_ID = /^[A-Z][A-Z0-9_]{2,79}$/;
const MAX_TEXT_LENGTH = 4000;
const MAX_CHOICES = 12;
const MAX_IMPACT_PATHS = 100;

function requireString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_IMPACT_PATHS) {
    throw new Error(`${field} exceeds ${MAX_IMPACT_PATHS} entries`);
  }
  const normalized = value.map((entry, index) => requireString(entry, `${field}[${index}]`, 500));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

export class UserActionImpact {
  constructor({ retains = [], changes = [], deletes = [] } = {}) {
    this.retains = Object.freeze(normalizeStringList(retains, "impact.retains"));
    this.changes = Object.freeze(normalizeStringList(changes, "impact.changes"));
    this.deletes = Object.freeze(normalizeStringList(deletes, "impact.deletes"));
    if (this.retains.length + this.changes.length + this.deletes.length === 0) {
      throw new Error("impact must describe at least one retained, changed, or deleted target");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      retains: [...this.retains],
      changes: [...this.changes],
      deletes: [...this.deletes],
    };
  }

  static fromStored(value) {
    return value instanceof UserActionImpact ? value : new UserActionImpact(value);
  }
}

export class UserActionChoice {
  constructor({
    actionId,
    label,
    nextAction = null,
    stateTransition = null,
    impact,
    reason = null,
  }) {
    this.actionId = requireString(actionId, "choice.actionId", 80);
    if (!ACTION_ID.test(this.actionId)) {
      throw new Error("choice.actionId must be a stable uppercase action token");
    }
    this.label = requireString(label, "choice.label", 300);
    this.nextAction = nextAction == null
      ? null
      : requireString(nextAction, "choice.nextAction");
    this.stateTransition = stateTransition == null
      ? null
      : requireString(stateTransition, "choice.stateTransition", 200);
    if (this.nextAction == null && this.stateTransition == null) {
      throw new Error("choice requires an executable nextAction or stateTransition");
    }
    this.impact = UserActionImpact.fromStored(impact);
    this.reason = reason == null ? null : requireString(reason, "choice.reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      actionId: this.actionId,
      label: this.label,
      nextAction: this.nextAction,
      stateTransition: this.stateTransition,
      impact: this.impact.toJSON(),
      reason: this.reason,
    };
  }

  static fromStored(value) {
    return value instanceof UserActionChoice ? value : new UserActionChoice(value);
  }
}

export class UserActionPrompt {
  constructor({
    question,
    choices,
    recommendedActionId,
    recommendationReason,
  }) {
    this.requiresUserAction = true;
    this.question = requireString(question, "prompt.question");
    if (!Array.isArray(choices) || choices.length < 2 || choices.length > MAX_CHOICES) {
      throw new Error(`prompt.choices must contain 2 through ${MAX_CHOICES} materially different choices`);
    }
    this.choices = Object.freeze(choices.map((choice) => UserActionChoice.fromStored(choice)));
    const actionIds = this.choices.map((choice) => choice.actionId);
    if (new Set(actionIds).size !== actionIds.length) {
      throw new Error("prompt choice actionIds must be unique");
    }
    const materialOutcomes = this.choices.map((choice) => JSON.stringify({
      nextAction: choice.nextAction,
      stateTransition: choice.stateTransition,
    }));
    if (new Set(materialOutcomes).size !== materialOutcomes.length) {
      throw new Error("prompt choices must describe materially different outcomes");
    }
    this.recommendedActionId = requireString(
      recommendedActionId,
      "prompt.recommendedActionId",
      80,
    );
    if (!actionIds.includes(this.recommendedActionId)) {
      throw new Error("prompt.recommendedActionId must reference an existing choice");
    }
    this.recommendationReason = requireString(
      recommendationReason,
      "prompt.recommendationReason",
    );
    Object.freeze(this);
  }

  toJSON() {
    return {
      requiresUserAction: true,
      question: this.question,
      choices: this.choices.map((choice) => choice.toJSON()),
      recommendedActionId: this.recommendedActionId,
      recommendationReason: this.recommendationReason,
    };
  }

  static fromStored(value) {
    return value instanceof UserActionPrompt ? value : new UserActionPrompt(value);
  }
}

export class FlowContinuation {
  constructor({
    actionId,
    nextAction,
    instruction,
    reason,
  }) {
    this.actionId = requireString(actionId, "continuation.actionId", 80);
    if (!ACTION_ID.test(this.actionId)) {
      throw new Error("continuation.actionId must be a stable uppercase action token");
    }
    this.nextAction = requireString(nextAction, "continuation.nextAction");
    this.instruction = requireString(instruction, "continuation.instruction");
    this.reason = requireString(reason, "continuation.reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      actionId: this.actionId,
      nextAction: this.nextAction,
      instruction: this.instruction,
      reason: this.reason,
    };
  }

  static fromStored(value) {
    return value instanceof FlowContinuation ? value : new FlowContinuation(value);
  }
}

export function guardFlagsForState(state) {
  if (!state) return "";
  const shellToken = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
  return [
    ...(state.runId ? [`--expect-run-id ${shellToken(state.runId)}`] : []),
    ...(state.specId ? [`--expect-spec ${shellToken(state.specId)}`] : []),
    ...(Object.hasOwn(state, "issue")
      ? [state.issue == null ? "--expect-no-issue" : `--expect-issue ${state.issue}`]
      : []),
  ].join(" ");
}

export function attachUserActionPrompt(target, prompt) {
  const validated = UserActionPrompt.fromStored(prompt);
  const data = target?.data && typeof target.data === "object" && !Array.isArray(target.data)
    ? target.data
    : {};
  target.data = {
    ...data,
    yieldsControl: true,
    requiresUserAction: true,
    actionPrompt: validated.toJSON(),
  };
  return target;
}

export function attachFlowContinuation(target, continuation) {
  const validated = FlowContinuation.fromStored(continuation);
  const data = target?.data && typeof target.data === "object" && !Array.isArray(target.data)
    ? target.data
    : {};
  target.data = {
    ...data,
    yieldsControl: false,
    requiresUserAction: false,
    continuation: validated.toJSON(),
  };
  return target;
}

export function assertUserActionResultContract(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  if (data.continuation != null) {
    if (data.yieldsControl === true || data.requiresUserAction === true) {
      throw new Error("INTERNAL_USER_ACTION_CONTRACT: continuation cannot require user action");
    }
    FlowContinuation.fromStored(data.continuation);
  }
  if (data.yieldsControl !== true) return;
  if (data.requiresUserAction !== true) {
    throw new Error("INTERNAL_USER_ACTION_CONTRACT: yieldsControl requires requiresUserAction");
  }
  UserActionPrompt.fromStored(data.actionPrompt);
}
