import { DraftStepBinding, DraftWorkerStepBinding } from "../engine/connectors/draft/draft-step-binding.js";
import { DraftLifecycle, nextDraftQaId } from "../lib/draft-lifecycle.js";
import { CandidateQuestion, DraftQuestionLedger, ResolvedByExistingInformation } from "../lib/draft-question-ledger.js";
import { DRAFT_ARTIFACT_WRITER_STEPS } from "../lib/draft-artifact-promotion.js";
import { applyDraftRepairOperations } from "../lib/draft-repair-operations.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";

function canonicalBytes(draft) {
  return Buffer.from(`${JSON.stringify(draft.raw, null, 2)}\n`, "utf8");
}

/** Draft artifact operations for one exact Connector-bound Flow Step. */
export class DraftService {
  constructor({ flowManager, binding }) {
    if (!flowManager || typeof flowManager.readArtifact !== "function" || typeof flowManager.publishArtifacts !== "function") {
      throw new TypeError("DraftService requires the canonical FlowManager artifact surface");
    }
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    this.flowManager = flowManager;
    this.binding = binding;
  }

  /** Return the exact sealed worker capability for this bound Draft Step. */
  workerRequest() {
    if (!(this.binding instanceof DraftWorkerStepBinding)) {
      throw new Error("Draft worker request requires a bound Draft worker Step");
    }
    this.binding.assertCurrent();
    return this.binding.request;
  }

  /** Read the typed context captured with the exact worker request. */
  workerContext() {
    return this.workerRequest().contextSnapshot;
  }

  /** Read the bound Draft revision as a DraftLifecycle. */
  readDraft() {
    return this.#source().draft;
  }

  /** Publish the first complete Draft envelope from grouped initial content. */
  createDraft(initialContent) {
    if (!(this.binding instanceof DraftWorkerStepBinding) || this.binding.stepId !== "draft") {
      throw new Error("initial Draft publication requires the bound draft worker Step");
    }
    if (this.#sealedDraftInput() !== null) {
      throw new Error("initial Draft publication cannot replace a sealed Draft revision");
    }
    return this.#publish(new DraftLifecycle(initialContent));
  }

  /** Validate and publish a revised DraftLifecycle. */
  saveDraft(draft) {
    if (!(draft instanceof DraftLifecycle)) throw new TypeError("DraftService.saveDraft() requires a DraftLifecycle");
    const source = this.#source();
    return this.#publish(draft, source);
  }

  /** Add one question through DraftQuestionLedger. */
  addQuestion(question) {
    if (!(question instanceof CandidateQuestion)) {
      throw new TypeError("DraftService.addQuestion() requires a CandidateQuestion");
    }
    const source = this.#source();
    const expectedId = nextDraftQaId(source.draft.raw);
    if (question.id !== expectedId || question.revision !== 0) {
      throw new Error("new Draft question must use the next canonical id at revision 0");
    }
    const ledger = source.draft.questionLedger;
    const next = new DraftQuestionLedger({
      revision: ledger.revision + 1,
      publication: ledger.publication,
      evidenceDigest: ledger.evidenceDigest,
      questions: [...ledger.questions, question],
    });
    return this.#publish(new DraftLifecycle(source.draft.withQuestionLedger(next)), source);
  }

  /** Record a user's answer against the bound question revision. */
  answerQuestion(questionId, answer) {
    const source = this.#source();
    const current = source.draft.nextUnresolvedQuestion();
    if (current === null || current.id !== questionId) {
      throw new Error("Draft answer does not match the bound awaiting question");
    }
    const next = source.draft.questionLedger.answer(questionId, current.revision, answer);
    return this.#publish(new DraftLifecycle(source.draft.withQuestionLedger(next)), source);
  }

  /** Resolve a question using existing information or discard it with a reason. */
  resolveQuestion(questionId, resolution) {
    const source = this.#source();
    const current = source.draft.nextUnresolvedQuestion();
    if (current === null || current.id !== questionId) {
      throw new Error("Draft resolution does not match the bound awaiting question");
    }
    const next = resolution instanceof ResolvedByExistingInformation
      ? this.#resolveFromExistingInformation(source.draft.questionLedger, current, resolution)
      : source.draft.questionLedger.discard(questionId, current.revision, resolution);
    return this.#publish(new DraftLifecycle(source.draft.withQuestionLedger(next)), source);
  }

  /** Apply typed repair operations and publish the resulting Draft revision. */
  applyRepair(operations) {
    if (!(this.binding instanceof DraftWorkerStepBinding)) {
      throw new Error("Draft repair requires a sealed worker handoff binding");
    }
    const route = draftReviewRouteForStepId(this.binding.stepId);
    if (route === null || route.repairStepId !== this.binding.stepId) {
      throw new Error("Draft repair requires a Definition-selected review repair Step");
    }
    if (route.key === "coverage") {
      throw new Error("coverage Draft repair requires the canonical draft completion connector");
    }
    const source = this.#source();
    const request = this.workerRequest();
    const triage = request.inputs.find((input) => input.name === route.triageArtifact);
    if (triage === undefined) throw new Error("Draft repair handoff is missing its sealed triage input");
    const result = applyDraftRepairOperations({
      draft: source.draft.raw,
      triage: triage.document,
      repair: operations,
      inputRevision: request.inputRevision,
      phase: this.binding.stepId,
    });
    const draft = new DraftLifecycle(result.draft);
    this.#publish(draft, source, [{
      logicalKey: "draft.questions.repair",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(result.audit, null, 2)}\n`, "utf8"),
    }]);
    return Object.freeze({ draft, audit: result.audit });
  }

  /** Check the bound Draft against final completion requirements. */
  validateForCompletion() {
    return this.readDraft().validateForCompletion();
  }

  #sealedDraftInput() {
    if (!(this.binding instanceof DraftWorkerStepBinding)) return null;
    return this.workerRequest().inputs.find((input) => input.name === "draft.json") ?? null;
  }

  #source() {
    this.binding.assertCurrent();
    const resolved = this.flowManager.readArtifact({
      specId: this.binding.specId,
      logicalKey: "draft",
      consumerNodeId: this.binding.stepId,
    });
    const sealed = this.#sealedDraftInput();
    if (sealed !== null && (resolved.descriptor.hash !== sealed.digest || resolved.descriptor.size !== sealed.byteLength)) {
      throw new Error("Draft artifact no longer matches the sealed worker input revision");
    }
    try {
      return Object.freeze({
        descriptor: resolved.descriptor,
        draft: new DraftLifecycle(JSON.parse(resolved.bytes.toString("utf8"))),
      });
    } catch (cause) {
      throw new Error(`canonical Draft is invalid: ${cause.message}`, { cause });
    }
  }

  #publish(draft, source = null, additionalWrites = []) {
    if (!(this.binding instanceof DraftWorkerStepBinding)
      || !DRAFT_ARTIFACT_WRITER_STEPS.includes(this.binding.stepId)) {
      throw new Error("Draft publication requires a bound Draft writer Step");
    }
    const issues = draft.validateForPublication();
    if (issues.length > 0) throw new Error(`Draft publication is incomplete: ${issues.join("; ")}`);
    this.binding.assertCurrent();
    this.flowManager.publishArtifacts({
      specId: this.binding.specId,
      nodeId: this.binding.stepId,
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: canonicalBytes(draft) }, ...additionalWrites],
      ...(source === null ? {} : {
        artifactBaselines: [{ logicalKey: "draft", digest: source.descriptor.hash, byteLength: source.descriptor.size }],
      }),
    });
    return draft;
  }

  #resolveFromExistingInformation(ledger, current, resolution) {
    if (resolution.id !== current.id || resolution.revision !== current.revision + 1
      || resolution.question !== current.question || resolution.category !== current.category
      || resolution.evidenceDigest !== current.evidenceDigest
      || JSON.stringify(resolution.provenance) !== JSON.stringify(current.provenance)) {
      throw new Error("existing-information resolution does not match the bound awaiting question revision");
    }
    const next = new DraftQuestionLedger({
      revision: ledger.revision + 1,
      publication: ledger.publication,
      evidenceDigest: ledger.evidenceDigest,
      questions: ledger.questions.map((question) => question === current ? resolution : question),
    });
    return next;
  }
}
