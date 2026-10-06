import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FlowExecutionError } from "./flow-execution-error.js";
import {
  RequirementTestBudget, RequirementTestBundleLineage, RequirementTestExpectation, RequirementTestPlanPublication,
  RequirementTestPlan, RequirementTestSemanticFinding, RequirementTestSourceAttempt, RequirementTestWorkItem,
} from "../lib/requirement-test-lifecycle.js";
import {
  RequirementTestCandidateBundle, RequirementTestCandidateSource, RequirementTestGateObservation,
  RequirementTestReviewSource,
} from "../lib/requirement-test-artifacts.js";
import { SpecRevisionIdentity } from "../lib/spec-revision-identity.js";
import {
  ReviewWorkUnitManifest, ReviewWorkUnitSeal, ReviewWorkUnitOutputReceipt,
} from "../lib/review-work-unit-values.js";
import { ReviewEvidenceIdentity } from "../lib/review-evidence-values.js";
import { TestReviewRepairProgressEntry } from "../lib/test-review-repair-values.js";

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
  return error instanceof RequirementTestExternalBlockedError
    ? { kind: "requirement-test-external-blocked", ...error.toJSON() }
    : error instanceof FlowExecutionError
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
  if (kind === "requirement-test-external-blocked") {
    const error = FlowExecutionError.fromStored(details);
    return new RequirementTestExternalBlockedError(error.toJSON());
  }
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

function declareResult(ResultClass, { stepId, kind, type }, operands = null) {
  if (typeof stepId !== "string" || stepId === "") throw new TypeError("StepResult Step is required");
  if (registryByKind.has(kind)) throw new Error(`duplicate Step Result kind: ${kind}`);
  const entry = Object.freeze({ ResultClass, stepId, kind, type, ...(operands === null ? {} : { operands: Object.freeze({ ...operands }) }) });
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
export const BranchPreparedResult = resultClass("BranchPreparedResult", {
  stepId: "branch", kind: "branch-prepared", type: STEP_RESULT_TYPE.COMPLETED,
});
export const BranchNotRequiredResult = resultClass("BranchNotRequiredResult", {
  stepId: "branch", kind: "branch-not-required", type: STEP_RESULT_TYPE.COMPLETED,
});
export const PrepareSpecReadyResult = resultClass("PrepareSpecReadyResult", {
  stepId: "prepare-spec", kind: "prepare-spec-ready", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecCreatedResult = resultClass("SpecCreatedResult", {
  stepId: "spec", kind: "spec-created", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGateRepairReadyForGateResult = resultClass("SpecGateRepairReadyForGateResult", {
  stepId: "spec-gate-repair", kind: "spec-gate-repair-ready-for-gate", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGateRepairReviewRequiredResult = resultClass("SpecGateRepairReviewRequiredResult", {
  stepId: "spec-gate-repair", kind: "spec-gate-repair-review-required", type: STEP_RESULT_TYPE.COMPLETED,
});
export const SpecGateRepairContextRequiredResult = resultClass("SpecGateRepairContextRequiredResult", {
  stepId: "spec-gate-repair", kind: "spec-gate-repair-context-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecGateRepairDraftReturnRequiredResult = resultClass("SpecGateRepairDraftReturnRequiredResult", {
  stepId: "spec-gate-repair", kind: "spec-gate-repair-draft-return-required", type: STEP_RESULT_TYPE.LOOP_REQUIRED,
});
export const SpecGateRepairNoProgressResult = errorResultClass("SpecGateRepairNoProgressResult", {
  stepId: "spec-gate-repair", kind: "spec-gate-repair-no-progress", type: STEP_RESULT_TYPE.ERROR,
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

// Result operands are projections of canonical values, never a second facts authority.
const REQUIREMENT_TEST_LEAVES = new Set(["test-generate", "test-review", "test-repair", "test-gate"]);
const REQUIREMENT_TEST_STATUSES = new Set(["pending", "in_progress", "candidate_saved", "reviewed", "promoted", "deferred"]);

function exactResultFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new TypeError(`${label} has invalid fields`);
  }
  return value;
}

function resultText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} requires text`);
  return value;
}

function typedOperand(value, ValueClass, label) {
  if (!(value instanceof ValueClass)) throw new TypeError(`${label} requires ${ValueClass.name}`);
  return value;
}

function sameValue(left, right) { return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON()); }

/** Exact source Attempt, plan publication and selected Requirement lineage. */
export class RequirementTestResultBinding {
  constructor(value) {
    exactResultFields(value, ["runId", "specId", "leaf", "attempt", "specRecordPublication", "planPublication", "requirementId", "specRevision", "status", "candidate"], "Requirement test Result binding");
    this.runId = resultText(value.runId, "binding.runId");
    this.specId = resultText(value.specId, "binding.specId");
    if (!REQUIREMENT_TEST_LEAVES.has(value.leaf)) throw new TypeError("binding leaf is invalid");
    this.leaf = value.leaf;
    this.attempt = typedOperand(value.attempt, RequirementTestSourceAttempt, "binding.attempt");
    this.specRecordPublication = typedOperand(value.specRecordPublication, RequirementTestResultPublication, "binding.specRecordPublication");
    if (this.specRecordPublication.logicalKey !== "spec.record") throw new TypeError("binding Spec publication must identify spec.record");
    this.planPublication = typedOperand(value.planPublication, RequirementTestPlanPublication, "binding.planPublication");
    this.requirementId = resultText(value.requirementId, "binding.requirementId");
    this.specRevision = typedOperand(value.specRevision, SpecRevisionIdentity, "binding.specRevision");
    if (!REQUIREMENT_TEST_STATUSES.has(value.status)) throw new TypeError("binding status is invalid");
    this.status = value.status;
    this.candidate = value.candidate === null ? null : typedOperand(value.candidate, RequirementTestBundleLineage, "binding.candidate");
    if (this.specId !== this.specRevision.specId || (this.candidate !== null
      && (this.candidate.requirementId !== this.requirementId || !this.candidate.specRevision.equals(this.specRevision)))) {
      throw new TypeError("binding Requirement and Spec must match candidate lineage");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactResultFields(value, ["runId", "specId", "leaf", "attempt", "specRecordPublication", "planPublication", "requirementId", "specRevision", "status", "candidate"], "stored Requirement test Result binding");
    exactResultFields(value.planPublication, ["logicalKey", "relativePath", "hash", "size", "activityId"], "stored plan publication");
    return new RequirementTestResultBinding({
      ...value, attempt: RequirementTestSourceAttempt.fromJSON(value.attempt),
      specRecordPublication: RequirementTestResultPublication.fromJSON(value.specRecordPublication),
      planPublication: RequirementTestPlanPublication.fromDescriptor(value.planPublication),
      specRevision: new SpecRevisionIdentity(value.specRevision),
      candidate: value.candidate === null ? null : RequirementTestBundleLineage.fromJSON(value.candidate),
    });
  }

  toJSON() {
    return { runId: this.runId, specId: this.specId, leaf: this.leaf, attempt: this.attempt.toJSON(),
      specRecordPublication: this.specRecordPublication.toJSON(),
      planPublication: this.planPublication.toJSON(), requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(), status: this.status, candidate: this.candidate?.toJSON() ?? null };
  }
}

/** Identity/status projection; expectation and candidate content remain in the plan. */
export class RequirementTestResultFrontierItem {
  constructor(value) {
    exactResultFields(value, ["requirementId", "specRevision", "status"], "Requirement frontier item");
    this.requirementId = resultText(value.requirementId, "frontier.requirementId");
    this.specRevision = typedOperand(value.specRevision, SpecRevisionIdentity, "frontier.specRevision");
    if (!REQUIREMENT_TEST_STATUSES.has(value.status)) throw new TypeError("frontier status is invalid");
    this.status = value.status;
    Object.freeze(this);
  }
  static fromWorkItem(item) {
    typedOperand(item, RequirementTestWorkItem, "frontier work item");
    return new RequirementTestResultFrontierItem({ requirementId: item.requirementId, specRevision: item.specRevision, status: item.status });
  }
  static fromJSON(value) {
    exactResultFields(value, ["requirementId", "specRevision", "status"], "stored frontier item");
    return new RequirementTestResultFrontierItem({ ...value, specRevision: new SpecRevisionIdentity(value.specRevision) });
  }
  toJSON() { return { requirementId: this.requirementId, specRevision: this.specRevision.toJSON(), status: this.status }; }
}

export class RequirementTestResultFrontier {
  constructor(value) {
    exactResultFields(value, ["staged", "pending"], "Requirement test Result frontier");
    for (const group of ["staged", "pending"]) {
      if (!Array.isArray(value[group])) throw new TypeError(`frontier.${group} requires an array`);
      this[group] = Object.freeze(value[group].map((item) => item instanceof RequirementTestResultFrontierItem
        ? item : RequirementTestResultFrontierItem.fromWorkItem(item)));
    }
    if (this.pending.some((item) => item.status !== "pending")
      || this.staged.some((item) => !["candidate_saved", "reviewed"].includes(item.status))) {
      throw new TypeError("frontier groups do not match their statuses");
    }
    const items = [...this.staged, ...this.pending];
    if (new Set(items.map((item) => item.requirementId)).size !== items.length) throw new TypeError("frontier duplicates a Requirement");
    if (items.some((item) => !item.specRevision.equals(items[0].specRevision))) throw new TypeError("frontier mixes Spec revisions");
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["staged", "pending"], "stored Requirement test Result frontier");
    if (!Array.isArray(value.staged) || !Array.isArray(value.pending)) throw new TypeError("stored frontier groups require arrays");
    return new RequirementTestResultFrontier({ staged: value.staged.map(RequirementTestResultFrontierItem.fromJSON), pending: value.pending.map(RequirementTestResultFrontierItem.fromJSON) });
  }

  static fromPlan(plan, activeRequirementId) {
    typedOperand(plan, RequirementTestPlan, "Requirement frontier plan");
    if (!plan.workItems.some((item) => item.requirementId === activeRequirementId)) {
      throw new TypeError("Requirement frontier active identity is absent from its plan");
    }
    const remaining = plan.workItems.filter((item) => item.requirementId !== activeRequirementId);
    return new RequirementTestResultFrontier({
      staged: remaining.filter((item) => ["candidate_saved", "reviewed"].includes(item.status)),
      pending: remaining.filter((item) => item.status === "pending"),
    });
  }

  toJSON() { return { staged: this.staged.map((item) => item.toJSON()), pending: this.pending.map((item) => item.toJSON()) }; }
}

export class RequirementTestRetryState {
  constructor(value) {
    exactResultFields(value, ["budget", "autoApprove", "findings"], "Requirement test retry state");
    this.budget = typedOperand(value.budget, RequirementTestBudget, "retry budget");
    if (typeof value.autoApprove !== "boolean") throw new TypeError("retry autoApprove requires a boolean");
    this.autoApprove = value.autoApprove;
    if (!Array.isArray(value.findings)) throw new TypeError("retry findings require an array");
    this.findings = Object.freeze(value.findings.map((item) => typedOperand(item, RequirementTestSemanticFinding, "retry finding")));
    if (new Set(this.findings.map((item) => JSON.stringify(item.toJSON()))).size !== this.findings.length) throw new TypeError("retry findings duplicate an identity");
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["budget", "autoApprove", "findings"], "stored Requirement test retry state");
    if (!Array.isArray(value.findings)) throw new TypeError("stored retry findings require an array");
    return new RequirementTestRetryState({ ...value, budget: RequirementTestBudget.fromJSON(value.budget), findings: value.findings.map(RequirementTestSemanticFinding.fromJSON) });
  }
  toJSON() { return { budget: this.budget.toJSON(), autoApprove: this.autoApprove, findings: this.findings.map((item) => item.toJSON()) }; }
}

/** Catalog metadata for one actual evidence publication. */
export class RequirementTestResultPublication {
  constructor(value) {
    exactResultFields(value, ["logicalKey", "relativePath", "hash", "size", "activityId"], "Result publication");
    this.logicalKey = resultText(value.logicalKey, "publication.logicalKey");
    this.relativePath = resultText(value.relativePath, "publication.relativePath");
    if (this.relativePath.startsWith("/") || this.relativePath.includes("\\") || this.relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("publication path is invalid");
    if (typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)) throw new TypeError("publication hash is invalid");
    if (!Number.isSafeInteger(value.size) || value.size < 0) throw new TypeError("publication size is invalid");
    this.hash = value.hash;
    this.size = value.size;
    this.activityId = resultText(value.activityId, "publication.activityId");
    Object.freeze(this);
  }
  static fromDescriptor(descriptor) { return new RequirementTestResultPublication(Object.fromEntries(["logicalKey", "relativePath", "hash", "size", "activityId"].map((field) => [field, descriptor[field]]))); }
  static fromJSON(value) { return new RequirementTestResultPublication(value); }
  toJSON() { return { logicalKey: this.logicalKey, relativePath: this.relativePath, hash: this.hash, size: this.size, activityId: this.activityId }; }
}

export class ApprovalResultEvidence {
  constructor(value) {
    exactResultFields(value, ["runId", "specId", "attempt", "specRevision", "approved", "testsRequired"], "approval evidence");
    this.runId = resultText(value.runId, "approval.runId");
    this.specId = resultText(value.specId, "approval.specId");
    this.attempt = typedOperand(value.attempt, RequirementTestSourceAttempt, "approval.attempt");
    this.specRevision = typedOperand(value.specRevision, SpecRevisionIdentity, "approval.specRevision");
    if (this.specId !== this.specRevision.specId || typeof value.approved !== "boolean" || typeof value.testsRequired !== "boolean") throw new TypeError("approval evidence is invalid");
    this.approved = value.approved;
    this.testsRequired = value.testsRequired;
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["runId", "specId", "attempt", "specRevision", "approved", "testsRequired"], "stored approval evidence");
    return new ApprovalResultEvidence({ ...value, attempt: RequirementTestSourceAttempt.fromJSON(value.attempt), specRevision: new SpecRevisionIdentity(value.specRevision) });
  }
  toJSON() { return { runId: this.runId, specId: this.specId, attempt: this.attempt.toJSON(), specRevision: this.specRevision.toJSON(), approved: this.approved, testsRequired: this.testsRequired }; }
}

export class RequirementTestReviewExecutionEvidence {
  constructor(value) {
    exactResultFields(value, ["manifest", "source"], "Review execution evidence");
    this.manifest = typedOperand(value.manifest, ReviewWorkUnitManifest, "Review manifest");
    this.source = typedOperand(value.source, RequirementTestReviewSource, "Review source");
    if (this.manifest.phase !== "test" || this.manifest.nodeId !== "test-review" || this.source.runId !== this.manifest.runId || this.source.specRevision.specId !== this.manifest.specId) throw new TypeError("Review execution source does not match its manifest");
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["manifest", "source", "workUnit"], "stored Review execution evidence");
    const restored = new RequirementTestReviewExecutionEvidence({ manifest: new ReviewWorkUnitManifest(value.manifest), source: RequirementTestReviewSource.fromJSON(value.source) });
    if (!isDeepStrictEqual(value.workUnit, restored.toJSON().workUnit)) throw new TypeError("Review execution identity does not match its manifest");
    return restored;
  }
  toJSON() { return { manifest: this.manifest.toJSON(), source: this.source.toJSON(), workUnit: { manifestDigest: this.manifest.digest, inputDigest: this.manifest.inputDigest, target: this.manifest.target.toJSON() } }; }
}

export class RequirementTestReviewEvidence {
  constructor(value) {
    exactResultFields(value, ["manifest", "seal", "source", "identity", "workerOutput", "publication", "evidencePublication", "verdict", "semanticFinding"], "Review Result evidence");
    this.manifest = typedOperand(value.manifest, ReviewWorkUnitManifest, "Review manifest");
    this.seal = typedOperand(value.seal, ReviewWorkUnitSeal, "Review seal").assertManifest(this.manifest);
    this.source = typedOperand(value.source, RequirementTestReviewSource, "Review source");
    this.identity = typedOperand(value.identity, ReviewEvidenceIdentity, "Review identity");
    this.workerOutput = typedOperand(value.workerOutput, ReviewWorkUnitOutputReceipt, "Review output receipt");
    this.publication = typedOperand(value.publication, RequirementTestResultPublication, "Review publication");
    this.evidencePublication = typedOperand(value.evidencePublication, RequirementTestResultPublication, "Review evidence publication");
    this.verdict = value.verdict;
    this.semanticFinding = value.semanticFinding === null
      ? null : typedOperand(value.semanticFinding, RequirementTestSemanticFinding, "Review semantic finding");
    if (!["PASS", "ADVISORY", "REJECTED"].includes(this.verdict) || this.manifest.phase !== "test" || this.manifest.nodeId !== "test-review"
      || this.source.runId !== this.manifest.runId || this.source.specRevision.specId !== this.manifest.specId
      || this.identity.phase !== "test" || this.identity.treeSha !== this.manifest.target.treeSha
      || this.workerOutput.digest !== this.seal.output.digest || this.workerOutput.byteLength !== this.seal.output.byteLength
      || this.workerOutput.mediaType !== this.manifest.output.mediaType || this.publication.logicalKey !== "test.requirement.review"
      || this.evidencePublication.logicalKey !== "review.evidence"
      || (this.verdict === "REJECTED") !== (this.semanticFinding !== null)
      || (this.semanticFinding !== null && (this.semanticFinding.requirementId !== this.source.requirementId
        || this.semanticFinding.bundleRevision !== this.source.bundleRevision))) {
      throw new TypeError("Review evidence does not match its sealed publication");
    }
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["manifest", "seal", "source", "identity", "workerOutput", "publication", "evidencePublication", "verdict", "semanticFinding"], "stored Review Result evidence");
    return new RequirementTestReviewEvidence({ ...value, manifest: new ReviewWorkUnitManifest(value.manifest), seal: new ReviewWorkUnitSeal(value.seal), source: RequirementTestReviewSource.fromJSON(value.source), identity: new ReviewEvidenceIdentity(value.identity), workerOutput: new ReviewWorkUnitOutputReceipt(value.workerOutput), publication: RequirementTestResultPublication.fromJSON(value.publication), evidencePublication: RequirementTestResultPublication.fromJSON(value.evidencePublication), semanticFinding: value.semanticFinding === null ? null : RequirementTestSemanticFinding.fromJSON(value.semanticFinding) });
  }
  toJSON() { return { manifest: this.manifest.toJSON(), seal: this.seal.toJSON(), source: this.source.toJSON(), identity: this.identity.toJSON(), workerOutput: this.workerOutput.toJSON(), publication: this.publication.toJSON(), evidencePublication: this.evidencePublication.toJSON(), verdict: this.verdict, semanticFinding: this.semanticFinding?.toJSON() ?? null }; }
}

export class RequirementTestGateEvidence {
  constructor(value) {
    exactResultFields(value, ["observation", "publication", "expectation"], "Gate Result evidence");
    this.observation = typedOperand(value.observation, RequirementTestGateObservation, "Gate observation");
    this.publication = typedOperand(value.publication, RequirementTestResultPublication, "Gate publication");
    this.expectation = typedOperand(value.expectation, RequirementTestExpectation, "Gate expectation");
    if (this.publication.logicalKey !== "test.requirement.gate") throw new TypeError("Gate publication is invalid");
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["observation", "publication", "expectation"], "stored Gate Result evidence");
    return new RequirementTestGateEvidence({ observation: RequirementTestGateObservation.fromJSON(value.observation), publication: RequirementTestResultPublication.fromJSON(value.publication), expectation: RequirementTestExpectation.from(value.expectation) });
  }
  toJSON() { return { observation: this.observation.toJSON(), publication: this.publication.toJSON(), expectation: this.expectation.toJSON() }; }
}

export class RequirementTestToolingEvidence {
  constructor(value) {
    exactResultFields(value, ["reason", "stage"], "Requirement tooling evidence");
    this.reason = resultText(value.reason, "tooling.reason");
    this.stage = resultText(value.stage, "tooling.stage");
    Object.freeze(this);
  }
  static fromJSON(value) { return new RequirementTestToolingEvidence(value); }
  toJSON() { return { reason: this.reason, stage: this.stage }; }
}

/** Immutable metadata projection of a validated canonical bounded repair checkpoint. */
export class RequirementTestRepairProgressIdentity {
  constructor(value) {
    exactResultFields(value, ["sourceArtifactDigest", "sourceEvidenceId", "sourceCandidate", "coordinatorAttempt", "entries", "stagedSources"], "repair progress identity");
    this.sourceArtifactDigest = value.sourceArtifactDigest;
    this.sourceEvidenceId = value.sourceEvidenceId;
    for (const field of ["sourceArtifactDigest", "sourceEvidenceId"]) {
      if (typeof this[field] !== "string" || !/^[a-f0-9]{64}$/.test(this[field])) throw new TypeError(`repair progress ${field} is invalid`);
    }
    this.sourceCandidate = typedOperand(value.sourceCandidate, RequirementTestCandidateBundle, "repair progress source candidate");
    this.coordinatorAttempt = typedOperand(value.coordinatorAttempt, RequirementTestSourceAttempt, "repair progress coordinator");
    if (!Array.isArray(value.entries) || value.entries.length === 0 || !Array.isArray(value.stagedSources) || value.stagedSources.length === 0) throw new TypeError("repair progress requires finding entries and staged identities");
    this.entries = Object.freeze(value.entries.map((entry) => typedOperand(entry, TestReviewRepairProgressEntry, "repair progress entry")));
    this.stagedSources = Object.freeze(value.stagedSources.map((source) => typedOperand(source, RequirementTestCandidateSource, "repair staged source identity")));
    if (new Set(this.entries.map((entry) => entry.findingId)).size !== this.entries.length
      || new Set(this.stagedSources.map((source) => source.testPath)).size !== this.stagedSources.length) {
      throw new TypeError("repair progress identity duplicates a finding or staged source");
    }
    this.digest = createHash("sha256").update(JSON.stringify(this.#projection())).digest("hex");
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactResultFields(value, ["sourceArtifactDigest", "sourceEvidenceId", "sourceCandidate", "coordinatorAttempt", "entries", "stagedSources", "digest"], "stored repair progress identity");
    if (!Array.isArray(value.entries) || !Array.isArray(value.stagedSources)) throw new TypeError("stored repair progress collections are invalid");
    const { digest, ...projection } = value;
    const restored = new RequirementTestRepairProgressIdentity({ ...projection, sourceCandidate: RequirementTestCandidateBundle.fromJSON(value.sourceCandidate), coordinatorAttempt: RequirementTestSourceAttempt.fromJSON(value.coordinatorAttempt), entries: value.entries.map((entry) => new TestReviewRepairProgressEntry(entry)), stagedSources: value.stagedSources.map(RequirementTestCandidateSource.fromJSON) });
    if (restored.digest !== digest) throw new TypeError("repair progress metadata digest does not match its checkpoint");
    return restored;
  }
  #projection() { return { sourceArtifactDigest: this.sourceArtifactDigest, sourceEvidenceId: this.sourceEvidenceId, sourceCandidate: this.sourceCandidate.toJSON(), coordinatorAttempt: this.coordinatorAttempt.toJSON(), entries: this.entries.map((entry) => entry.toJSON()), stagedSources: this.stagedSources.map((source) => source.toJSON()) }; }
  toJSON() { return { ...this.#projection(), digest: this.digest }; }
}

export class RequirementTestExternalBlockedError extends FlowExecutionError {}

function assertResultSource(binding, source) {
  if (binding.candidate === null || binding.requirementId !== source.requirementId
    || !binding.specRevision.equals(source.specRevision) || binding.candidate.bundleRevision !== source.bundleRevision
    || !sameValue(binding.candidate.sourceAttempt, source.sourceAttempt)) throw new TypeError("Result evidence and binding source identity do not match");
}

function validateRequirementResult(definition, values) {
  const { binding, frontier, retryState, candidateBundle, evidence, progressIdentity, semanticFinding } = values;
  if (binding === undefined) {
    if (evidence.approved !== (definition.kind !== "approval-awaiting-user")
      || (definition.kind === "approval-confirmed-with-tests" && !evidence.testsRequired)
      || (definition.kind === "approval-confirmed-without-tests" && evidence.testsRequired)) throw new TypeError("approval Result contradicts its evidence");
    return;
  }
  if (binding.leaf !== definition.stepId || [...frontier.staged, ...frontier.pending].some((item) => !item.specRevision.equals(binding.specRevision))) throw new TypeError("Result binding does not match its leaf and frontier");
  if (retryState.findings.some((finding) => finding.requirementId !== binding.requirementId)) throw new TypeError("Result retry finding belongs to another Requirement");
  if (progressIdentity !== undefined) {
    if (!sameValue(progressIdentity.coordinatorAttempt, binding.attempt)) throw new TypeError("repair progress coordinator does not match Result Attempt");
    assertResultSource(binding, { requirementId: progressIdentity.sourceCandidate.bundle.requirementId, specRevision: progressIdentity.sourceCandidate.bundle.specRevision, bundleRevision: progressIdentity.sourceCandidate.bundle.revision, sourceAttempt: progressIdentity.sourceCandidate.bundle.lineage.sourceAttempt });
  }
  if (candidateBundle !== undefined) {
    const { bundle } = candidateBundle;
    const expectedRevision = definition.stepId === "test-generate"
      ? 1
      : (binding.candidate?.bundleRevision ?? 0) + 1;
    const expectedPredecessor = definition.stepId === "test-generate"
      ? null
      : binding.candidate?.bundleRevision ?? null;
    if (!new Set(["test-generate", "test-repair"]).has(definition.stepId)
      || bundle.requirementId !== binding.requirementId
      || !bundle.specRevision.equals(binding.specRevision)
      || bundle.revision !== expectedRevision
      || bundle.lineage.predecessorRevision !== expectedPredecessor
      || !sameValue(binding.attempt, bundle.lineage.sourceAttempt)
      || (definition.stepId === "test-generate" && binding.candidate !== null
        && !sameValue(binding.candidate, bundle.lineage))) {
      throw new TypeError("Result candidate does not match its selected producer Attempt and source revision");
    }
  }
  const structuralRejection = definition.kind === "test-generate-structural-rejected"
    || definition.kind === "test-repair-structural-rejected";
  if (structuralRejection !== (semanticFinding instanceof RequirementTestSemanticFinding)
    || (structuralRejection && (semanticFinding.requirementId !== binding.requirementId
      || semanticFinding.bundleRevision !== candidateBundle.bundle.revision))) {
    throw new TypeError("structural Result must bind its exact candidate finding identity");
  }
  if (evidence instanceof RequirementTestReviewExecutionEvidence || evidence instanceof RequirementTestReviewEvidence) {
    assertResultSource(binding, evidence.source);
    if (binding.runId !== evidence.manifest.runId || binding.specId !== evidence.manifest.specId || binding.attempt.id !== evidence.manifest.attemptId) throw new TypeError("Review work unit does not match Result Attempt");
    if (evidence instanceof RequirementTestReviewEvidence) {
      const verdict = { "test-review-passed": "PASS", "test-review-advisory": "ADVISORY", "test-review-rejected": "REJECTED" }[definition.kind];
      if (evidence.verdict !== verdict) throw new TypeError("Review Result contradicts sealed verdict");
      if (evidence.semanticFinding !== null && evidence.semanticFinding.requirementId !== binding.requirementId) {
        throw new TypeError("Review semantic finding belongs to another Requirement");
      }
    }
  }
  if (evidence instanceof RequirementTestGateEvidence) {
    assertResultSource(binding, evidence.observation);
    const tooling = definition.kind === "test-gate-tooling-unavailable";
    if (tooling !== (evidence.observation.kind === "tooling_failure")) throw new TypeError("Gate Result contradicts tooling observation");
    const expected = evidence.expectation.toJSON() === "fail" ? "assertion_failed" : "assertion_passed";
    const compatible = evidence.observation.kind === expected;
    if (!tooling && compatible !== (definition.kind === "test-gate-compatible")) throw new TypeError("Gate Result contradicts its recorded expectation");
  }
}

function operandResultClass(className, definition, codecs, ErrorClass = null) {
  const fields = Object.keys(codecs);
  const ResultClass = { [className]: class extends StepResult {
    #values;
    constructor(values) {
      exactResultFields(values, [...fields, ...(ErrorClass === null ? [] : ["error"])], className);
      for (const [field, Codec] of Object.entries(codecs)) typedOperand(values[field], Codec, `${className}.${field}`);
      if (ErrorClass !== null) {
        typedOperand(values.error, ErrorClass, `${className}.error`);
        if (values.error.runId !== values.binding.runId || values.error.stepId !== definition.stepId || values.error.attemptId !== values.binding.attempt.id) throw new TypeError("external blocking error does not match Result source binding");
      }
      validateRequirementResult(definition, values);
      super(DEFINITION_TOKEN, { ...definition, ...(ErrorClass === null ? {} : { error: values.error }) });
      this.#values = Object.freeze(Object.fromEntries(fields.map((field) => [field, values[field]])));
    }
    operand(field) { return this.#values[field]; }
    toJSON() { return { ...super.toJSON(), ...Object.fromEntries(fields.map((field) => [field, this.#values[field].toJSON()])) }; }
  } }[className];
  for (const field of fields) Object.defineProperty(ResultClass.prototype, field, { get() { return this.operand(field); } });
  declareResult(ResultClass, definition, codecs);
  return ResultClass;
}

const testOperands = Object.freeze({ binding: RequirementTestResultBinding, frontier: RequirementTestResultFrontier, retryState: RequirementTestRetryState });
const testResultClass = (name, stepId, suffix, type, field, Codec, ErrorClass = null) => operandResultClass(name, { stepId, kind: `${stepId}-${suffix}`, type }, { ...testOperands, [field]: Codec }, ErrorClass);
export const ApprovalAwaitingUserResult = operandResultClass("ApprovalAwaitingUserResult", { stepId: "approval", kind: "approval-awaiting-user", type: STEP_RESULT_TYPE.USER_INPUT_REQUIRED }, { evidence: ApprovalResultEvidence });
export const ApprovalConfirmedWithTestsResult = operandResultClass("ApprovalConfirmedWithTestsResult", { stepId: "approval", kind: "approval-confirmed-with-tests", type: STEP_RESULT_TYPE.COMPLETED }, { evidence: ApprovalResultEvidence });
export const ApprovalConfirmedWithoutTestsResult = operandResultClass("ApprovalConfirmedWithoutTestsResult", { stepId: "approval", kind: "approval-confirmed-without-tests", type: STEP_RESULT_TYPE.COMPLETED }, { evidence: ApprovalResultEvidence });
export const TestGenerateCandidateSavedResult = testResultClass("TestGenerateCandidateSavedResult", "test-generate", "candidate-saved", STEP_RESULT_TYPE.COMPLETED, "candidateBundle", RequirementTestCandidateBundle);
export const TestGenerateStructuralRejectedResult = operandResultClass("TestGenerateStructuralRejectedResult", { stepId: "test-generate", kind: "test-generate-structural-rejected", type: STEP_RESULT_TYPE.BRANCH_REQUIRED }, { ...testOperands, candidateBundle: RequirementTestCandidateBundle, semanticFinding: RequirementTestSemanticFinding });
export const TestRepairProgressSavedResult = testResultClass("TestRepairProgressSavedResult", "test-repair", "progress-saved", STEP_RESULT_TYPE.LOOP_REQUIRED, "progressIdentity", RequirementTestRepairProgressIdentity);
export const TestRepairCandidateSavedResult = testResultClass("TestRepairCandidateSavedResult", "test-repair", "candidate-saved", STEP_RESULT_TYPE.COMPLETED, "candidateBundle", RequirementTestCandidateBundle);
export const TestRepairStructuralRejectedResult = operandResultClass("TestRepairStructuralRejectedResult", { stepId: "test-repair", kind: "test-repair-structural-rejected", type: STEP_RESULT_TYPE.BRANCH_REQUIRED }, { ...testOperands, candidateBundle: RequirementTestCandidateBundle, semanticFinding: RequirementTestSemanticFinding });
export const TestReviewExecutionRequiredResult = testResultClass("TestReviewExecutionRequiredResult", "test-review", "execution-required", STEP_RESULT_TYPE.LOOP_REQUIRED, "evidence", RequirementTestReviewExecutionEvidence);
export const TestReviewPassedResult = testResultClass("TestReviewPassedResult", "test-review", "passed", STEP_RESULT_TYPE.COMPLETED, "evidence", RequirementTestReviewEvidence);
export const TestReviewAdvisoryResult = testResultClass("TestReviewAdvisoryResult", "test-review", "advisory", STEP_RESULT_TYPE.COMPLETED, "evidence", RequirementTestReviewEvidence);
export const TestReviewRejectedResult = testResultClass("TestReviewRejectedResult", "test-review", "rejected", STEP_RESULT_TYPE.BRANCH_REQUIRED, "evidence", RequirementTestReviewEvidence);
export const TestGateCompatibleResult = testResultClass("TestGateCompatibleResult", "test-gate", "compatible", STEP_RESULT_TYPE.COMPLETED, "evidence", RequirementTestGateEvidence);
export const TestGateIncompatibleResult = testResultClass("TestGateIncompatibleResult", "test-gate", "incompatible", STEP_RESULT_TYPE.BRANCH_REQUIRED, "evidence", RequirementTestGateEvidence);
export const TestGenerateToolingUnavailableResult = testResultClass("TestGenerateToolingUnavailableResult", "test-generate", "tooling-unavailable", STEP_RESULT_TYPE.LOOP_REQUIRED, "evidence", RequirementTestToolingEvidence);
export const TestReviewToolingUnavailableResult = testResultClass("TestReviewToolingUnavailableResult", "test-review", "tooling-unavailable", STEP_RESULT_TYPE.LOOP_REQUIRED, "evidence", RequirementTestToolingEvidence);
export const TestRepairToolingUnavailableResult = testResultClass("TestRepairToolingUnavailableResult", "test-repair", "tooling-unavailable", STEP_RESULT_TYPE.LOOP_REQUIRED, "evidence", RequirementTestToolingEvidence);
export const TestGateToolingUnavailableResult = testResultClass("TestGateToolingUnavailableResult", "test-gate", "tooling-unavailable", STEP_RESULT_TYPE.LOOP_REQUIRED, "evidence", RequirementTestGateEvidence);
export const TestGenerateExternalBlockedResult = testResultClass("TestGenerateExternalBlockedResult", "test-generate", "external-blocked", STEP_RESULT_TYPE.ERROR, "evidence", RequirementTestToolingEvidence, RequirementTestExternalBlockedError);
export const TestReviewExternalBlockedResult = testResultClass("TestReviewExternalBlockedResult", "test-review", "external-blocked", STEP_RESULT_TYPE.ERROR, "evidence", RequirementTestToolingEvidence, RequirementTestExternalBlockedError);
export const TestRepairExternalBlockedResult = testResultClass("TestRepairExternalBlockedResult", "test-repair", "external-blocked", STEP_RESULT_TYPE.ERROR, "evidence", RequirementTestToolingEvidence, RequirementTestExternalBlockedError);

const errorDefinitionByStep = new Map([...registryByStep.keys()].map((stepId) => {
  const operands = stepId === "approval"
    ? { evidence: ApprovalResultEvidence }
    : REQUIREMENT_TEST_LEAVES.has(stepId) ? testOperands : null;
  return [stepId, Object.freeze({
    stepId,
    kind: `${stepId}-error`,
    type: STEP_RESULT_TYPE.ERROR,
    ...(operands === null ? {} : { operands: Object.freeze({ ...operands }) }),
  })];
}));

export class StepErrorResult extends StepResult {
  #values;

  constructor(stepId, error, values = {}) {
    if (!(error instanceof Error)) throw new TypeError("StepErrorResult requires an Error");
    const definition = errorDefinitionByStep.get(requireRegisteredStepId(stepId));
    const codecs = definition.operands ?? {};
    exactResultFields(values, Object.keys(codecs), `${stepId} Error Result operands`);
    for (const [field, Codec] of Object.entries(codecs)) typedOperand(values[field], Codec, `${stepId} Error Result ${field}`);
    if (REQUIREMENT_TEST_LEAVES.has(stepId)) validateRequirementResult(definition, values);
    super(DEFINITION_TOKEN, { ...definition, error });
    this.#values = Object.freeze({ ...values });
  }

  get evidence() { return this.#values.evidence; }
  get binding() { return this.#values.binding; }
  get frontier() { return this.#values.frontier; }
  get retryState() { return this.#values.retryState; }

  toJSON() {
    return { ...super.toJSON(), ...Object.fromEntries(Object.entries(this.#values)
      .map(([field, value]) => [field, value.toJSON()])) };
  }
}
for (const definition of errorDefinitionByStep.values()) {
  declareResult(StepErrorResult, definition, definition.operands ?? null);
}

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
  const expectedFields = ["kind", "type", ...(entry.type === STEP_RESULT_TYPE.ERROR ? ["error"] : []), ...Object.keys(entry.operands ?? {})].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expectedFields) {
    throw new TypeError("stored StepResult fields are invalid");
  }
  if (entry.operands !== undefined) {
    const operands = Object.fromEntries(Object.entries(entry.operands).map(([field, Codec]) => {
      const restored = Codec.fromJSON(value[field]);
      if (!isDeepStrictEqual(restored.toJSON(), value[field])) throw new TypeError(`stored Result ${field} is not exact canonical evidence`);
      return [field, restored];
    }));
    if (entry.type === STEP_RESULT_TYPE.ERROR && entry.ResultClass === StepErrorResult) {
      return new StepErrorResult(stepId, rehydrateError(value.error), operands);
    }
    if (entry.type === STEP_RESULT_TYPE.ERROR) operands.error = rehydrateError(value.error);
    return new entry.ResultClass(operands);
  }
  return entry.type === STEP_RESULT_TYPE.ERROR
    ? entry.ResultClass === StepErrorResult
      ? new StepErrorResult(stepId, rehydrateError(value.error), {})
      : new entry.ResultClass(rehydrateError(value.error))
    : new entry.ResultClass();
}

export function stepResultKinds(stepId) {
  requireRegisteredStepId(stepId);
  return Object.freeze((registryByStep.get(stepId) ?? []).map(({ kind }) => kind));
}
