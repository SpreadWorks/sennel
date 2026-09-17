/** Draft artifact operations for a Connector-bound Flow step. */
export class DraftService {
  constructor({ flowManager, binding }) {
    this.flowManager = flowManager;
    this.binding = binding;
  }

  /** Read the bound Draft revision as a DraftLifecycle. */
  readDraft() {
    throw new Error("DraftService.readDraft() is not implemented");
  }

  /** Publish the first complete Draft envelope from grouped initial content. */
  createDraft(initialContent) {
    throw new Error("DraftService.createDraft() is not implemented");
  }

  /** Validate and publish a revised DraftLifecycle. */
  saveDraft(draft) {
    throw new Error("DraftService.saveDraft() is not implemented");
  }

  /** Add one question through DraftQuestionLedger. */
  addQuestion(question) {
    throw new Error("DraftService.addQuestion() is not implemented");
  }

  /** Record a user's answer against the bound question revision. */
  answerQuestion(questionId, answer) {
    throw new Error("DraftService.answerQuestion() is not implemented");
  }

  /** Resolve a question using existing information or discard it with a reason. */
  resolveQuestion(questionId, resolution) {
    throw new Error("DraftService.resolveQuestion() is not implemented");
  }

  /** Apply typed repair operations and publish the resulting Draft revision. */
  applyRepair(operations) {
    throw new Error("DraftService.applyRepair() is not implemented");
  }

  /** Check the bound Draft against final completion requirements. */
  validateForCompletion() {
    throw new Error("DraftService.validateForCompletion() is not implemented");
  }
}
