/** Draft artifact validation; DraftQuestionLedger is the sole question authority. */
import {
  AwaitingUserAnswer,
  CandidateQuestion,
  countDraftQuestionStates,
  DraftQuestionLedger,
  DRAFT_QUESTION_CATEGORIES,
} from "./draft-question-ledger.js";

export const DRAFT_LEGACY_QA_ERROR = "draft.json question schema changed; regenerate questionLedger through the guarded draft path";
export const DRAFT_QA_CATEGORIES = DRAFT_QUESTION_CATEGORIES;

const TOP_LEVEL_FIELDS = new Set([
  "devType", "goal", "analysis", "decisionMap", "scopeVerification", "impactOnExisting", "questionLedger", "openQuestions",
]);
const DEV_TYPES = new Set(["feature", "bugfix", "refactor", "docs", "chore", "test", "other"]);
const DECISION_MAP_FIELDS = Object.freeze([
  "knownFacts", "decisionPoints", "resolvedByProjectRules", "requiresUserJudgment", "deferredToSpec",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** A Draft-owned delegation, deliberately not a free-form specification hole. */
export class DeferredToSpecEntry {
  static fields() { return Object.freeze(["boundary", "relevance", "owner"]); }

  static repairGuidance() {
    return `Each decisionMap.deferredToSpec entry has exactly ${this.fields().join(", ")}. boundary and relevance are non-empty strings; owner is spec. Put inventory, retained behavior, and verification details in those existing text values; never add entry fields.`;
  }

  constructor(value) {
    if (!isObject(value)) throw new Error("deferredToSpec entry must be an object");
    const allowed = new Set(DeferredToSpecEntry.fields());
    const extra = unknownFields(value, allowed);
    if (extra.length > 0) throw new Error(`deferredToSpec entry has unknown field \"${extra[0]}\"`);
    this.boundary = isNonEmptyString(value.boundary) ? value.boundary.trim() : null;
    this.relevance = isNonEmptyString(value.relevance) ? value.relevance.trim() : null;
    this.owner = value.owner === "spec" ? "spec" : null;
    if (this.boundary === null || this.relevance === null || this.owner === null) {
      throw new Error("deferredToSpec entry requires boundary, relevance, and owner: spec");
    }
    Object.freeze(this);
  }

  toJSON() { return { boundary: this.boundary, relevance: this.relevance, owner: this.owner }; }
}

function unknownFields(value, allowed) {
  return Object.keys(value).filter((field) => !allowed.has(field));
}

class DraftDecisionMap {
  constructor(raw) {
    this.raw = raw;
    Object.freeze(this);
  }

  validate() {
    if (!isObject(this.raw)) return ["missing decisionMap object"];
    const issues = [];
    for (const field of unknownFields(this.raw, new Set(DECISION_MAP_FIELDS))) {
      issues.push(`decisionMap: unknown field "${field}"`);
    }
    for (const field of DECISION_MAP_FIELDS) {
      const values = this.raw[field];
      if (!Array.isArray(values)) {
        issues.push(`decisionMap.${field} must be an array`);
        continue;
      }
      values.forEach((value, index) => {
        if (field === "deferredToSpec") {
          try { new DeferredToSpecEntry(value); } catch (error) { issues.push(`decisionMap.${field}[${index}] ${error.message}`); }
        } else if (!isNonEmptyString(value)) {
          issues.push(`decisionMap.${field}[${index}] must be a non-empty string`);
        }
      });
    }
    return issues;
  }
}

export class DraftLifecycle {
  constructor(raw) {
    if (!isObject(raw)) throw new Error("draft must be a non-null object");
    this.raw = structuredClone(raw);
    this.decisionMap = new DraftDecisionMap(this.raw.decisionMap);
    this.questionLedger = this.#parseLedger();
    Object.freeze(this);
  }

  #parseLedger() {
    if (Object.hasOwn(this.raw, "qa")) throw new Error(DRAFT_LEGACY_QA_ERROR);
    if (!Object.hasOwn(this.raw, "questionLedger")) return null;
    try {
      return DraftQuestionLedger.from(this.raw.questionLedger);
    } catch {
      return null;
    }
  }

  validateQuestionStructure() {
    if (Object.hasOwn(this.raw, "qa")) return [DRAFT_LEGACY_QA_ERROR];
    if (!Object.hasOwn(this.raw, "questionLedger") || this.raw.questionLedger === undefined) return ["missing questionLedger object"];
    return DraftQuestionLedger.validationIssues(this.raw.questionLedger);
  }

  validate() {
    return this.#validate({
      allowCandidateQuestions: false,
      allowAwaitingQuestions: false,
    });
  }

  /** Intermediate canonical publications retain a complete envelope while questions may still be active. */
  validateForPublication() {
    return this.#validate({
      allowCandidateQuestions: true,
      allowAwaitingQuestions: true,
    });
  }

  /** Writers may hand candidates to later draft stages, but may not leave an unanswered user prompt behind. */
  validateForWriterCompletion() {
    return this.#validate({
      allowCandidateQuestions: true,
      allowAwaitingQuestions: false,
    });
  }

  /** Final connector selection requires every draft-owned question to be resolved. */
  validateForCompletion() {
    return this.#validate({
      allowCandidateQuestions: false,
      allowAwaitingQuestions: false,
    });
  }

  #validate({ allowCandidateQuestions, allowAwaitingQuestions }) {
    const issues = [];
    for (const field of unknownFields(this.raw, TOP_LEVEL_FIELDS)) {
      if (field !== "qa") issues.push(`unknown field "${field}"`);
    }
    if (!isNonEmptyString(this.raw.devType) || !DEV_TYPES.has(this.raw.devType)) {
      issues.push(`invalid devType "${this.raw.devType || ""}" (expected one of: ${[...DEV_TYPES].join(", ")})`);
    }
    if (!isNonEmptyString(this.raw.goal)) issues.push("missing or empty goal");
    if (!isObject(this.raw.analysis)) {
      issues.push("missing analysis object");
    } else {
      for (const field of ["problem", "proposedApproach", "validation"]) {
        if (!isNonEmptyString(this.raw.analysis[field])) issues.push(`missing or empty analysis.${field}`);
      }
    }
    issues.push(...this.decisionMap.validate());
    issues.push(...this.validateQuestionStructure());
    if (this.questionLedger !== null) {
      this.questionLedger.questions.forEach((question, index) => {
        if (!allowCandidateQuestions && question instanceof CandidateQuestion) {
          issues.push(`questionLedger.questions[${index}]: state CandidateQuestion blocks spec generation`);
        }
        if (!allowAwaitingQuestions && question instanceof AwaitingUserAnswer) {
          issues.push(`questionLedger.questions[${index}]: state AwaitingUserAnswer blocks spec generation`);
        }
      });
    }
    return issues;
  }

  nextUnresolvedQuestion() {
    if (this.questionLedger === null) throw new Error(this.validateQuestionStructure().join("; "));
    return this.questionLedger.nextAwaiting();
  }

  withQuestionLedger(questionLedger) {
    return {
      ...this.raw,
      questionLedger: DraftQuestionLedger.from(questionLedger).toJSON(),
    };
  }
}

export function parseDraftLifecycle(raw) {
  return new DraftLifecycle(raw);
}

export function validateDraftLifecycle(raw) {
  try {
    return parseDraftLifecycle(raw).validate();
  } catch (error) {
    return [error.message];
  }
}

export function validateDraftLifecycleForPublication(raw) {
  try {
    return parseDraftLifecycle(raw).validateForPublication();
  } catch (error) {
    return [error.message];
  }
}

export function validateDraftLifecycleForCompletion(raw) {
  try {
    return parseDraftLifecycle(raw).validateForCompletion();
  } catch (error) {
    return [error.message];
  }
}

export function countDraftLifecycleQa(raw) {
  const lifecycle = parseDraftLifecycle(raw);
  if (lifecycle.questionLedger === null) throw new Error(lifecycle.validateQuestionStructure().join("; "));
  return countDraftQuestionStates(lifecycle.questionLedger.questions);
}

export function nextDraftQaId(raw) {
  const lifecycle = parseDraftLifecycle(raw);
  if (lifecycle.questionLedger === null) throw new Error(lifecycle.validateQuestionStructure().join("; "));
  const last = lifecycle.questionLedger.questions.at(-1);
  if (last === undefined) return "q1";
  const number = Number(last.id.slice(1));
  if (!Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER) {
    throw new Error("draft question id sequence is exhausted");
  }
  return `q${number + 1}`;
}
