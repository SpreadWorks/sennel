/** Canonical, exclusive persisted state for draft questions. */

const DIGEST = /^[a-f0-9]{64}$/;
const STATE_TYPES = new Map();
export const DRAFT_QUESTION_CATEGORIES = Object.freeze([
  "goal-confirmation",
  "impact-scope",
  "acceptance-criteria",
  "constraint-non-goal",
  "risk-migration-policy",
  "user-visible-behavior",
  "dependency-integration-boundary",
  "implementation-policy",
  "follow-up-coverage",
]);
const CATEGORIES = new Set(DRAFT_QUESTION_CATEGORIES);
const AMBIGUOUS_TOKENS = Object.freeze(["適切に", "必要なら", "できるだけ", "いい感じ", "なるべく", "適宜"]);

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}
function revision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}
function digest(value, field) {
  if (!DIGEST.test(text(value, field))) throw new Error(`${field} must be a SHA-256 digest`);
  return value;
}
function provenance(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new Error("draft question provenance must be a non-empty object");
  return Object.freeze(structuredClone(value));
}
function normalized(value) {
  return String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function hasAmbiguousWording(value) {
  return AMBIGUOUS_TOKENS.some((token) => normalized(value).includes(token));
}

function exactFields(input, fields, state) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("draft question state must be an object");
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`${state} contains unsupported field: ${key}`);
  if (Object.hasOwn(input, "state") && input.state !== state) throw new Error(`${state} state tag is invalid`);
}
const BASE_FIELDS = Object.freeze(["state", "id", "question", "category", "revision", "provenance", "evidenceDigest"]);

export class DraftQuestionState {
  constructor({ id, question, category, revision: questionRevision, provenance: source, evidenceDigest } = {}) {
    if (new.target === DraftQuestionState) throw new Error("DraftQuestionState is abstract");
    this.id = text(id, "draft question id");
    const idNumber = /^q([1-9]\d*)$/.exec(this.id)?.[1];
    if (idNumber === undefined || !Number.isSafeInteger(Number(idNumber)) || Number(idNumber) < 1) {
      throw new Error("draft question id must use a positive safe q<N> component");
    }
    this.question = text(question, "draft question text");
    this.category = text(category, "draft question category");
    if (!CATEGORIES.has(this.category)) throw new Error(`draft question category is invalid: ${this.category}`);
    this.revision = revision(questionRevision, "draft question revision");
    this.provenance = provenance(source);
    this.evidenceDigest = digest(evidenceDigest, "draft question evidenceDigest");
  }
  toJSON() {
    return {
      state: this.constructor.name,
      id: this.id,
      question: this.question,
      category: this.category,
      revision: this.revision,
      provenance: structuredClone(this.provenance),
      evidenceDigest: this.evidenceDigest,
    };
  }
}

export class CandidateQuestion extends DraftQuestionState {
  constructor(input = {}) {
    exactFields(input, BASE_FIELDS, "CandidateQuestion");
    super(input);
    Object.freeze(this);
  }
}

export class AwaitingUserAnswer extends DraftQuestionState {
  constructor(input = {}) {
    exactFields(input, BASE_FIELDS, "AwaitingUserAnswer");
    super(input);
    Object.freeze(this);
  }
}

export class ResolvedByExistingInformation extends DraftQuestionState {
  constructor(input = {}) {
    exactFields(input, [...BASE_FIELDS, "resolution"], "ResolvedByExistingInformation");
    super(input);
    this.resolution = text(input.resolution, "resolved question resolution");
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), resolution: this.resolution };
  }
}
export class AnsweredQuestion extends DraftQuestionState {
  constructor(input = {}) {
    exactFields(input, [...BASE_FIELDS, "answer", "why", "considered"], "AnsweredQuestion");
    super(input);
    this.answer = text(input.answer, "answered question answer");
    this.why = text(input.why, "answered question why");
    if (typeof input.considered !== "string") throw new Error("answered question considered must be a string");
    this.considered = input.considered;
    if (normalized(this.answer).replace(/\s/g, "").length < 8) throw new Error("answered question answer must not be shallow");
    Object.freeze(this);
  }
  toJSON() {
    return { ...super.toJSON(), answer: this.answer, why: this.why, considered: this.considered };
  }
}

export class DiscardedQuestion extends DraftQuestionState {
  constructor(input = {}) {
    exactFields(input, [...BASE_FIELDS, "reason"], "DiscardedQuestion");
    super(input);
    this.reason = text(input.reason, "discarded question reason");
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), reason: this.reason };
  }
}

for (const type of [CandidateQuestion, ResolvedByExistingInformation, AwaitingUserAnswer, AnsweredQuestion, DiscardedQuestion]) {
  STATE_TYPES.set(type.name, type);
}

export const DRAFT_QUESTION_STATE_TYPES = Object.freeze([
  Object.freeze({ state: "CandidateQuestion", Type: CandidateQuestion }),
  Object.freeze({ state: "ResolvedByExistingInformation", Type: ResolvedByExistingInformation }),
  Object.freeze({ state: "AwaitingUserAnswer", Type: AwaitingUserAnswer }),
  Object.freeze({ state: "AnsweredQuestion", Type: AnsweredQuestion }),
  Object.freeze({ state: "DiscardedQuestion", Type: DiscardedQuestion }),
]);

export function countDraftQuestionStates(questions) {
  return Object.fromEntries(DRAFT_QUESTION_STATE_TYPES.map(({ state, Type }) => [
    state,
    questions.filter((question) => question instanceof Type).length,
  ]));
}

function stateFrom(value) {
  if (value instanceof DraftQuestionState) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("draft question state must be an object");
  const Type = STATE_TYPES.get(value.state);
  if (!Type) throw new Error(`draft question state is invalid: ${value.state || "(missing)"}`);
  return new Type(value);
}

export class DraftQuestionLedger {
  constructor({ revision: ledgerRevision, questions, publication, evidenceDigest } = {}) {
    const input = arguments[0] ?? {};
    const issues = DraftQuestionLedger.validationIssues(input);
    if (issues.length > 0) throw new Error(issues.join("; "));
    this.revision = revision(ledgerRevision, "draft question ledger revision");
    this.questions = Object.freeze(questions.map(stateFrom));
    this.publication = text(publication, "draft question ledger publication");
    this.evidenceDigest = digest(evidenceDigest, "draft question ledger evidenceDigest");
    Object.freeze(this);
  }
  static validationIssues(input) {
    const issues = [];
    if (input === null || typeof input !== "object" || Array.isArray(input)) return ["draft question ledger must be an object"];
    for (const key of Object.keys(input)) {
      if (!["revision", "questions", "publication", "evidenceDigest"].includes(key)) issues.push(`DraftQuestionLedger contains unsupported field: ${key}`);
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) issues.push("draft question ledger revision must be a non-negative safe integer");
    if (typeof input.publication !== "string" || input.publication.trim() === "") issues.push("draft question ledger publication must be a non-empty string");
    if (typeof input.evidenceDigest !== "string" || !DIGEST.test(input.evidenceDigest)) issues.push("draft question ledger evidenceDigest must be a SHA-256 digest");
    if (!Array.isArray(input.questions)) {
      issues.push("draft question ledger questions must be an array");
      return issues;
    }
    const ids = new Set();
    const questions = new Set();
    let previous = -1;
    input.questions.forEach((rawValue, index) => {
      const prefix = `questionLedger.questions[${index}]`;
      const raw = rawValue instanceof DraftQuestionState ? rawValue.toJSON() : rawValue;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push(`${prefix} must be an object`);
        return;
      }
      const state = raw.state;
      const fieldsByState = {
        CandidateQuestion: BASE_FIELDS,
        AwaitingUserAnswer: BASE_FIELDS,
        ResolvedByExistingInformation: [...BASE_FIELDS, "resolution"],
        AnsweredQuestion: [...BASE_FIELDS, "answer", "why", "considered"],
        DiscardedQuestion: [...BASE_FIELDS, "reason"],
      };
      const expected = fieldsByState[state];
      if (expected === undefined) {
        issues.push(`${prefix}: invalid state "${state || ""}"`);
        return;
      }
      for (const key of Object.keys(raw)) if (!expected.includes(key)) issues.push(`${prefix}: unknown field "${key}" (unsupported field for ${state})`);
      for (const field of expected) if (!Object.hasOwn(raw, field)) issues.push(`${prefix}: ${field} is required for ${state}`);
      if (typeof raw.id !== "string" || !/^q[1-9]\d*$/.test(raw.id)) issues.push(`${prefix}: id must match q<N>`);
      else {
        const number = Number(raw.id.slice(1));
        if (!Number.isSafeInteger(number) || number < 1) issues.push(`${prefix}: id numeric component must be a positive safe integer`);
        if (ids.has(raw.id)) issues.push(`${prefix}: duplicate id "${raw.id}"`);
        ids.add(raw.id);
        if (number <= previous) issues.push(`${prefix}: ids must preserve stable q<N> order`);
        previous = number;
      }
      if (typeof raw.question !== "string" || raw.question.trim() === "") issues.push(`${prefix}: question must be a non-empty string`);
      if (!CATEGORIES.has(raw.category)) issues.push(`${prefix}: invalid category "${raw.category || ""}"`);
      if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) issues.push(`${prefix}: revision must be a non-negative safe integer`);
      if (raw.provenance === null || typeof raw.provenance !== "object" || Array.isArray(raw.provenance) || Object.keys(raw.provenance).length === 0) issues.push(`${prefix}: provenance must be a non-empty object`);
      if (typeof raw.evidenceDigest !== "string" || !DIGEST.test(raw.evidenceDigest)) issues.push(`${prefix}: evidenceDigest must be a SHA-256 digest`);
      for (const field of ["question", "resolution", "answer", "why", "reason"]) {
        if (Object.hasOwn(raw, field) && (typeof raw[field] !== "string" || raw[field].trim() === "")) issues.push(`${prefix}: ${field} must be a non-empty string`);
        if (Object.hasOwn(raw, field) && hasAmbiguousWording(raw[field])) issues.push(`${prefix}: ${field} contains ambiguous wording`);
      }
      if (Object.hasOwn(raw, "considered") && typeof raw.considered !== "string") issues.push(`${prefix}: considered must be a string`);
      if (Object.hasOwn(raw, "considered") && hasAmbiguousWording(raw.considered)) issues.push(`${prefix}: considered contains ambiguous wording`);
      if (state === "AnsweredQuestion") {
        if (typeof raw.answer === "string" && normalized(raw.answer).replace(/\s/g, "").length < 8) issues.push(`${prefix}: answer must not be shallow`);
      }
      if (state !== "DiscardedQuestion" && typeof raw.question === "string") {
        const question = normalized(raw.question);
        if (question !== "" && questions.has(question)) issues.push(`${prefix}: duplicate question`);
        questions.add(question);
      }
    });
    return issues;
  }
  static from(value) { return value instanceof DraftQuestionLedger ? value : new DraftQuestionLedger(value); }
  awaiting() { return this.questions.filter((question) => question instanceof AwaitingUserAnswer); }
  nextAwaiting() { return this.awaiting()[0] ?? null; }
  nextCandidate() { return this.questions.find((question) => question instanceof CandidateQuestion) ?? null; }
  transitionCandidate(questionId, expectedRevision) {
    const candidate = this.questions.find((question) => question.id === questionId);
    if (!(candidate instanceof CandidateQuestion) || candidate.revision !== expectedRevision) throw new Error("draft candidate promotion does not match the current question revision");
    return this.#replace(candidate, new AwaitingUserAnswer({ ...candidate.toJSON(), state: "AwaitingUserAnswer", revision: candidate.revision + 1 }));
  }
  answer(questionId, expectedRevision, { answer, why, considered = "" } = {}) {
    const question = this.#currentAwaiting(questionId, expectedRevision);
    return this.#replace(question, new AnsweredQuestion({ ...question.toJSON(), state: "AnsweredQuestion", answer, why, considered, revision: question.revision + 1 }));
  }
  discard(questionId, expectedRevision, reason) {
    const question = this.#currentAwaiting(questionId, expectedRevision);
    return this.#replace(question, new DiscardedQuestion({ ...question.toJSON(), state: "DiscardedQuestion", reason, revision: question.revision + 1 }));
  }
  #currentAwaiting(questionId, expectedRevision) {
    const question = this.nextAwaiting();
    if (!(question instanceof AwaitingUserAnswer) || question.id !== questionId || question.revision !== expectedRevision) throw new Error("draft question action does not match the current awaiting question revision");
    return question;
  }
  #replace(current, replacement) { return new DraftQuestionLedger({ revision: this.revision + 1, publication: this.publication, evidenceDigest: this.evidenceDigest, questions: this.questions.map((question) => question === current ? replacement : question) }); }
  toJSON() { return { revision: this.revision, publication: this.publication, evidenceDigest: this.evidenceDigest, questions: this.questions.map((question) => question.toJSON()) }; }
}
