import { createHash } from "node:crypto";
import { FlowExecutionError } from "./flow-execution-error.js";

export const STEP_RESULT_TYPE = Object.freeze({
  COMPLETED: "completed",
  BRANCH_REQUIRED: "branch-required",
  LOOP_REQUIRED: "loop-required",
  USER_INPUT_REQUIRED: "user-input-required",
  ERROR: "error",
});

const DEFINITION_TOKEN = Symbol("StepResult definition");
const registryByKind = new Map();
const registryByStep = new Map();

function requireRegisteredStepId(stepId) {
  if (!registryByStep.has(stepId)) throw new TypeError(`unknown Step: ${stepId}`);
  return stepId;
}

function immutableErrorData(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(copy);
}

function storedError(error) {
  return error instanceof FlowExecutionError
    ? { kind: "flow", ...error.toJSON() }
    : {
        kind: "generic",
        message: error.message,
        ...(typeof error.code === "string" && error.code !== "" ? { code: error.code } : {}),
        ...(error.data === undefined ? {} : { data: structuredClone(error.data) }),
      };
}

function rehydrateError(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stored Step Result error is invalid");
  }
  const { kind, ...details } = value;
  if (kind === "flow") return FlowExecutionError.fromStored(details);
  if (kind === "generic" && typeof details.message === "string"
    && Object.keys(details).every((field) => ["message", "code", "data"].includes(field))
    && (details.code === undefined || (typeof details.code === "string" && details.code !== ""))) {
    const error = new Error(details.message);
    if (details.code !== undefined) error.code = details.code;
    if (details.data !== undefined) error.data = structuredClone(details.data);
    return error;
  }
  throw new TypeError("stored Step Result error is invalid");
}

/** Immutable semantic result produced by one executable Flow Step. */
export class StepResult {
  #stepId;
  #kind;
  #type;
  #error;

  constructor(token, { stepId, kind, type, error = null } = {}) {
    if (new.target === StepResult) throw new TypeError("StepResult is abstract");
    if (token !== DEFINITION_TOKEN) throw new TypeError("StepResult subclasses must use their declared contract");
    this.#stepId = requireRegisteredStepId(stepId);
    if (typeof kind !== "string" || kind === "") throw new TypeError("StepResult kind is required");
    if (!Object.values(STEP_RESULT_TYPE).includes(type)) throw new TypeError("StepResult type is invalid");
    if ((type === STEP_RESULT_TYPE.ERROR) !== (error instanceof Error)) {
      throw new TypeError("StepResult error must match its fixed type");
    }
    this.#kind = kind;
    this.#type = type;
    if (error instanceof FlowExecutionError || error === null) {
      this.#error = error;
    } else {
      const copy = new Error(error.message);
      if (typeof error.code === "string" && error.code !== "") copy.code = error.code;
      if (error.data !== undefined) copy.data = immutableErrorData(error.data);
      this.#error = Object.freeze(copy);
    }
    Object.freeze(this);
  }

  get stepId() { return this.#stepId; }
  get kind() { return this.#kind; }
  get type() { return this.#type; }
  get error() { return this.#error; }

  async persist(service) {
    if (service === null || typeof service !== "object" || typeof service.persistStepResult !== "function") {
      throw new TypeError("StepResult persistence requires a Step service");
    }
    return service.persistStepResult(this);
  }

  toJSON() {
    return {
      kind: this.#kind,
      type: this.#type,
      ...(this.#error === null ? {} : { error: storedError(this.#error) }),
    };
  }

  static fromStored(stepId, value) {
    return rehydrateStepResult(stepId, value);
  }
}

/** Return the canonical digest used to bind a persisted Result to its receipt. */
export function stepResultDigest(result) {
  if (!(result instanceof StepResult)) throw new TypeError("StepResult digest requires a StepResult");
  return createHash("sha256")
    .update(JSON.stringify(result.toJSON()))
    .digest("hex");
}

function declareResult(ResultClass, { stepId, kind, type }) {
  if (typeof stepId !== "string" || stepId === "") throw new TypeError("StepResult Step is required");
  if (registryByKind.has(kind)) throw new Error(`duplicate Step Result kind: ${kind}`);
  const entry = Object.freeze({ ResultClass, stepId, kind, type });
  registryByKind.set(kind, entry);
  const entries = registryByStep.get(stepId) ?? [];
  entries.push(entry);
  registryByStep.set(stepId, entries);
  return entry;
}

function resultClass(className, definition) {
  const ResultClass = { [className]: class extends StepResult {
    constructor() { super(DEFINITION_TOKEN, definition); }
  } }[className];
  declareResult(ResultClass, definition);
  return ResultClass;
}

function errorResultClass(className, definition) {
  const ResultClass = { [className]: class extends StepResult {
    constructor(error) {
      if (!(error instanceof Error)) throw new TypeError(`${className} requires an Error`);
      super(DEFINITION_TOKEN, { ...definition, error });
    }
  } }[className];
  declareResult(ResultClass, definition);
  return ResultClass;
}

export const DraftCreatedResult = resultClass("DraftCreatedResult", {
  stepId: "draft", kind: "draft-created", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecCreatedResult = resultClass("SpecCreatedResult", {
  stepId: "spec", kind: "spec-created", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecPlanGateRepairAppliedResult = resultClass("SpecPlanGateRepairAppliedResult", {
  stepId: "spec", kind: "spec-plan-gate-repair-applied", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecPlanGateRepairNoProgressResult = errorResultClass("SpecPlanGateRepairNoProgressResult", {
  stepId: "spec", kind: "spec-plan-gate-repair-no-progress", type: STEP_RESULT_TYPE.ERROR,
});
export const SpecTriageCompletedResult = resultClass("SpecTriageCompletedResult", {
  stepId: "spec-triage", kind: "spec-triage-completed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecRepairChangedResult = resultClass("SpecRepairChangedResult", {
  stepId: "spec-repair", kind: "spec-repair-changed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecRepairUnchangedResult = resultClass("SpecRepairUnchangedResult", {
  stepId: "spec-repair", kind: "spec-repair-unchanged", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGatePassedResult = resultClass("SpecGatePassedResult", {
  stepId: "spec-gate", kind: "spec-gate-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGateRepairRequiredResult = resultClass("SpecGateRepairRequiredResult", {
  stepId: "spec-gate", kind: "spec-gate-repair-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecGateRetryRequiredResult = resultClass("SpecGateRetryRequiredResult", {
  stepId: "spec-gate", kind: "spec-gate-retry-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecGateDeferredResult = resultClass("SpecGateDeferredResult", {
  stepId: "spec-gate", kind: "spec-gate-deferred", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGateAwaitingDecisionResult = resultClass("SpecGateAwaitingDecisionResult", {
  stepId: "spec-gate", kind: "spec-gate-awaiting-decision", type: STEP_RESULT_TYPE.USER_INPUT_REQUIRED,
});
export const SpecGateRecoveredResult = resultClass("SpecGateRecoveredResult", {
  stepId: "spec-gate", kind: "spec-gate-recovered", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const TaskSpecGatePassedResult = resultClass("TaskSpecGatePassedResult", {
  stepId: "spec-gate", kind: "task-spec-gate-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const TaskSpecGateRepairRequiredResult = resultClass("TaskSpecGateRepairRequiredResult", {
  stepId: "spec-gate", kind: "task-spec-gate-repair-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const TaskSpecGateRetryRequiredResult = resultClass("TaskSpecGateRetryRequiredResult", {
  stepId: "spec-gate", kind: "task-spec-gate-retry-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const TaskSpecGateDeferredResult = resultClass("TaskSpecGateDeferredResult", {
  stepId: "spec-gate", kind: "task-spec-gate-deferred", type: STEP_RESULT_TYPE.COMPLETED,
});
export const TaskSpecGateAwaitingDecisionResult = resultClass("TaskSpecGateAwaitingDecisionResult", {
  stepId: "spec-gate", kind: "task-spec-gate-awaiting-decision", type: STEP_RESULT_TYPE.USER_INPUT_REQUIRED,
});
export const TaskSpecGateRecoveredResult = resultClass("TaskSpecGateRecoveredResult", {
  stepId: "spec-gate", kind: "task-spec-gate-recovered", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecGateBlockedResult = errorResultClass("SpecGateBlockedResult", {
  stepId: "spec-gate", kind: "spec-gate-blocked", type: STEP_RESULT_TYPE.ERROR,
});
export const TaskSpecGateBlockedResult = errorResultClass("TaskSpecGateBlockedResult", {
  stepId: "spec-gate", kind: "task-spec-gate-blocked", type: STEP_RESULT_TYPE.ERROR,
});
export const SpecReviewExecutionRequiredResult = resultClass("SpecReviewExecutionRequiredResult", {
  stepId: "spec-review", kind: "spec-review-execution-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecReviewPassedResult = resultClass("SpecReviewPassedResult", {
  stepId: "spec-review", kind: "spec-review-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecReviewAdvisoryResult = resultClass("SpecReviewAdvisoryResult", {
  stepId: "spec-review", kind: "spec-review-advisory", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecReviewRejectedResult = resultClass("SpecReviewRejectedResult", {
  stepId: "spec-review", kind: "spec-review-rejected", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftQuestionsReviewExecutionRequiredResult = resultClass("DraftQuestionsReviewExecutionRequiredResult", {
  stepId: "draft-questions-review", kind: "draft-questions-review-execution-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftQuestionsReviewPassedResult = resultClass("DraftQuestionsReviewPassedResult", {
  stepId: "draft-questions-review", kind: "draft-questions-review-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftQuestionsReviewFindingsResult = resultClass("DraftQuestionsReviewFindingsResult", {
  stepId: "draft-questions-review", kind: "draft-questions-review-findings", type: STEP_RESULT_TYPE.BRANCH_REQUIRED,
});
export const DraftQuestionsTriageCompletedResult = resultClass("DraftQuestionsTriageCompletedResult", {
  stepId: "draft-questions-triage", kind: "draft-questions-triage-completed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftQuestionsRepairChangedResult = resultClass("DraftQuestionsRepairChangedResult", {
  stepId: "draft-questions-repair", kind: "draft-questions-repair-changed", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftQuestionsRepairUnchangedResult = resultClass("DraftQuestionsRepairUnchangedResult", {
  stepId: "draft-questions-repair", kind: "draft-questions-repair-unchanged", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftRefineWorkerRequiredResult = resultClass("DraftRefineWorkerRequiredResult", {
  stepId: "draft-refine", kind: "draft-refine-worker-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftRefineAwaitingAnswerResult = resultClass("DraftRefineAwaitingAnswerResult", {
  stepId: "draft-refine", kind: "draft-refine-awaiting-answer", type: STEP_RESULT_TYPE.USER_INPUT_REQUIRED,
});
export const DraftRefineCompletedResult = resultClass("DraftRefineCompletedResult", {
  stepId: "draft-refine", kind: "draft-refine-completed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftCoverageReviewExecutionRequiredResult = resultClass("DraftCoverageReviewExecutionRequiredResult", {
  stepId: "draft-coverage-review", kind: "draft-coverage-review-execution-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftCoverageReviewPassedResult = resultClass("DraftCoverageReviewPassedResult", {
  stepId: "draft-coverage-review", kind: "draft-coverage-review-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftCoverageReviewFindingsResult = resultClass("DraftCoverageReviewFindingsResult", {
  stepId: "draft-coverage-review", kind: "draft-coverage-review-findings", type: STEP_RESULT_TYPE.BRANCH_REQUIRED,
});
export const DraftCoverageTriageCompletedResult = resultClass("DraftCoverageTriageCompletedResult", {
  stepId: "draft-coverage-triage", kind: "draft-coverage-triage-completed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftCoverageRepairChangedResult = resultClass("DraftCoverageRepairChangedResult", {
  stepId: "draft-coverage-repair", kind: "draft-coverage-repair-changed", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftCoverageRepairUnchangedResult = resultClass("DraftCoverageRepairUnchangedResult", {
  stepId: "draft-coverage-repair", kind: "draft-coverage-repair-unchanged", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftGatePassedResult = resultClass("DraftGatePassedResult", {
  stepId: "draft-gate", kind: "draft-gate-passed", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftGateCarryForwardResult = resultClass("DraftGateCarryForwardResult", {
  stepId: "draft-gate", kind: "draft-gate-carry-forward", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftGateRepairRequiredResult = resultClass("DraftGateRepairRequiredResult", {
  stepId: "draft-gate", kind: "draft-gate-repair-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftGateRepairWorkerRequiredResult = resultClass("DraftGateRepairWorkerRequiredResult", {
  stepId: "draft-gate-repair", kind: "draft-gate-repair-worker-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const DraftGateRepairAppliedResult = resultClass("DraftGateRepairAppliedResult", {
  stepId: "draft-gate-repair", kind: "draft-gate-repair-applied", type: STEP_RESULT_TYPE.COMPLETED,
});
export const DraftGateRepairCarryForwardResult = resultClass("DraftGateRepairCarryForwardResult", {
  stepId: "draft-gate-repair", kind: "draft-gate-repair-carry-forward", type: STEP_RESULT_TYPE.COMPLETED,
});

const errorDefinitionByStep = new Map([...registryByStep.keys()].map((stepId) => [stepId, Object.freeze({
  stepId,
  kind: `${stepId}-error`,
  type: STEP_RESULT_TYPE.ERROR,
})]));

export class StepErrorResult extends StepResult {
  constructor(stepId, error) {
    if (!(error instanceof Error)) throw new TypeError("StepErrorResult requires an Error");
    const definition = errorDefinitionByStep.get(requireRegisteredStepId(stepId));
    super(DEFINITION_TOKEN, { ...definition, error });
  }
}
for (const definition of errorDefinitionByStep.values()) declareResult(StepErrorResult, definition);

export const STEP_RESULT_REGISTRY = Object.freeze([...registryByKind.values()]);

export function rehydrateStepResult(stepId, value) {
  requireRegisteredStepId(stepId);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stored StepResult must be an object");
  }
  const entry = registryByKind.get(value.kind);
  if (entry === undefined || entry.stepId !== stepId || value.type !== entry.type) {
    throw new TypeError("stored StepResult kind, type, and Step do not match");
  }
  const expectedFields = entry.type === STEP_RESULT_TYPE.ERROR ? "error,kind,type" : "kind,type";
  if (Object.keys(value).sort().join(",") !== expectedFields) {
    throw new TypeError("stored StepResult fields are invalid");
  }
  return entry.type === STEP_RESULT_TYPE.ERROR
    ? entry.ResultClass === StepErrorResult
      ? new StepErrorResult(stepId, rehydrateError(value.error))
      : new entry.ResultClass(rehydrateError(value.error))
    : new entry.ResultClass();
}

export function stepResultKinds(stepId) {
  requireRegisteredStepId(stepId);
  return Object.freeze((registryByStep.get(stepId) ?? []).map(({ kind }) => kind));
}
