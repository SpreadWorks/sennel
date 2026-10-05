import { isDeepStrictEqual } from "node:util";
import { AnsweredQuestion, DraftQuestionLedger,
  ResolvedByExistingInformation } from "./draft-question-ledger.js";

/** The durable input carried from a guarded Draft reopen to its next worker. */
export class DraftReopenContext {
  constructor({ reason, route, source, previousDraft = null, draftAttemptId = null } = {}) {
    if (typeof reason !== "string" || reason.trim() === "" || reason.includes("\0")) {
      throw new TypeError("Draft reopen reason must be nonempty text");
    }
    if (!["preimplementation", "task-addition", "spec-correction"].includes(route)) {
      throw new TypeError("Draft reopen route is invalid");
    }
    if (source === null || typeof source !== "object" || Array.isArray(source)
      || typeof source.stepId !== "string" || typeof source.attemptId !== "string"
      || !Number.isSafeInteger(source.attemptSequence) || source.attemptSequence < 1) {
      throw new TypeError("Draft reopen requires its source Attempt");
    }
    this.reason = reason;
    this.route = route;
    this.source = Object.freeze(structuredClone(source));
    this.previousDraft = previousDraft === null ? null : Object.freeze(structuredClone(previousDraft));
    this.draftAttemptId = draftAttemptId;
    Object.freeze(this);
  }

  withDraftAttempt(attemptId) {
    if (typeof attemptId !== "string" || attemptId === "") throw new TypeError("Draft reopen target Attempt is required");
    return new DraftReopenContext({ ...this.toJSON(), draftAttemptId: attemptId });
  }

  toJSON() {
    return { reason: this.reason, route: this.route, source: this.source,
      previousDraft: this.previousDraft, draftAttemptId: this.draftAttemptId };
  }

  toIssueLogEntry() {
    if (this.draftAttemptId === null) throw new TypeError("Draft reopen target Attempt is required");
    return { step: "draft", reason: `reopen-draft ${this.route}: ${this.reason}`,
      trigger: this.source.trigger ?? `Draft reopened from ${this.source.stepId}`,
      resolution: `definition-owned draft replacement started after ${this.source.stepId}`,
      ...(this.source.issueLogEvidence === undefined ? {} : { evidence: this.source.issueLogEvidence }),
      draftReopen: this.toJSON() };
  }

  matchesRequest(other) {
    return other instanceof DraftReopenContext && this.reason === other.reason
      && this.route === other.route && isDeepStrictEqual(this.source, other.source);
  }

  assertCandidateDraft(draft) {
    if (this.route !== "preimplementation" || this.source.stepId !== "spec-gate-repair"
      || this.previousDraft?.questionLedger == null) return;
    const previous = DraftQuestionLedger.from(this.previousDraft.questionLedger);
    const current = DraftQuestionLedger.from(draft?.questionLedger);
    const retained = previous.questions.filter((question) => question instanceof AnsweredQuestion
      || question instanceof ResolvedByExistingInformation);
    for (const question of retained) {
      if (!isDeepStrictEqual(current.questions.find((entry) => entry.id === question.id), question)) {
        throw new Error(`reopened Draft changed a prior resolved question: ${question.id}`);
      }
    }
  }

  static fromIssueLog(document, attemptId) {
    const value = document?.entries?.findLast((entry) => entry?.draftReopen?.draftAttemptId === attemptId)?.draftReopen;
    return value === undefined ? null : new DraftReopenContext(value);
  }

  static fromSourceIssueLog(document, sourceAttemptId) {
    const value = document?.entries?.findLast((entry) => (
      entry?.draftReopen?.source?.attemptId === sourceAttemptId
    ))?.draftReopen;
    return value === undefined ? null : new DraftReopenContext(value);
  }
}
