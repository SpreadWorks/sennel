/** Read-only facts for the definition-owned draft question ledger boundary. */
import { DraftLifecycle } from "./draft-lifecycle.js";
import { DraftQuestionLedger } from "./draft-question-ledger.js";

export class DraftQuestionFact {
  constructor({ id, question, revision, publication, evidenceDigest } = {}) {
    if (typeof id !== "string" || id.trim() === "") throw new Error("draft question id must be a non-empty string");
    if (typeof question !== "string" || question.trim() === "") throw new Error("draft question text must be a non-empty string");
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("draft question revision is invalid");
    this.id = id; this.question = question; this.revision = revision;
    this.publication = typeof publication === "string" && publication.trim() !== "" ? publication : null;
    this.evidenceDigest = typeof evidenceDigest === "string" && /^[a-f0-9]{64}$/.test(evidenceDigest) ? evidenceDigest : null;
    Object.freeze(this);
  }
}
export class DraftTransitionFacts {
  constructor({ ledger, workerStatus = "pending", origin = "canonical", sourceDigest = null, sourceByteLength = null, nextQuestion = null, candidateQuestion = null } = {}) {
    if (!(ledger instanceof DraftQuestionLedger)) throw new Error("draft transition facts require a typed ledger");
    if (nextQuestion !== null && !(nextQuestion instanceof DraftQuestionFact)) throw new Error("draft transition facts require a typed next question");
    if (candidateQuestion !== null && !(candidateQuestion instanceof DraftQuestionFact)) throw new Error("draft transition facts require a typed candidate question");
    if (!["pending", "invalidated", "in_progress"].includes(workerStatus)) throw new Error("draft transition facts worker status is invalid");
    if (!["canonical", "sealed-worker-output"].includes(origin)) throw new Error("draft transition facts origin is invalid");
    if (sourceDigest !== null && !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error("draft transition facts source digest is invalid");
    if ((sourceDigest === null) !== (sourceByteLength === null)
      || (sourceByteLength !== null && (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0))) {
      throw new Error("draft transition facts source byte length is invalid");
    }
    this.ledger = ledger; this.workerStatus = workerStatus; this.origin = origin; this.sourceDigest = sourceDigest; this.sourceByteLength = sourceByteLength; this.nextQuestion = nextQuestion; this.candidateQuestion = candidateQuestion; Object.freeze(this);
  }
  static fromDraft(draft, { workerStatus = "pending", origin = "canonical", sourceDigest = null, sourceByteLength = null } = {}) {
    if (!(draft instanceof DraftLifecycle)) throw new Error("draft transition facts require a DraftLifecycle");
    if (draft.questionLedger === null) throw new Error(draft.validateQuestionStructure().join("; "));
    const question = draft.questionLedger.nextAwaiting();
    const candidate = draft.questionLedger.nextCandidate();
    return new DraftTransitionFacts({ ledger: draft.questionLedger, workerStatus, origin, sourceDigest, sourceByteLength, nextQuestion: question === null ? null : new DraftQuestionFact(question), candidateQuestion: candidate === null ? null : new DraftQuestionFact(candidate) });
  }
}
