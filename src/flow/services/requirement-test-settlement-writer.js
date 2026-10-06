import { RequirementTestDeferredReceipt } from "../lib/requirement-test-artifacts.js";
import { DeferredFlowFindingsPublication } from "../lib/flow-findings.js";
import { RequirementTestResultBinding } from "../engine/step-result.js";

/** Additional publications selected by the same typed Result, such as deferral evidence. */
export class RequirementTestSettlementPublication {
  constructor({ artifactWrites = [], artifactRemovals = [], artifactBaselines = [],
    deferredReceipt = null, findingsPublication = null } = {}) {
    if (!Array.isArray(artifactWrites) || !Array.isArray(artifactRemovals)
      || !Array.isArray(artifactBaselines)
      || (deferredReceipt !== null && !(deferredReceipt instanceof RequirementTestDeferredReceipt))
      || (findingsPublication !== null && !(findingsPublication instanceof DeferredFlowFindingsPublication))) {
      throw new TypeError("Requirement settlement publication requires typed deferred evidence and artifact lists");
    }
    this.artifactWrites = Object.freeze([...artifactWrites]);
    this.artifactRemovals = Object.freeze([...artifactRemovals]);
    this.artifactBaselines = Object.freeze([...artifactBaselines]);
    this.deferredReceipt = deferredReceipt;
    this.findingsPublication = findingsPublication;
    Object.freeze(this);
  }
}

/** Save-only access to the atomic canonical Requirement-test settlement transaction. */
export class RequirementTestSettlementWriter {
  #flowManager;
  #specId;
  #binding;
  #commandResult;
  #artifactWrites;
  #artifactRemovals;
  #artifactBaselines;
  #deferredReceipt;
  #findingsPublication;
  #activityId;
  #result;
  #references;

  constructor({ flowManager, specId, binding, commandResult = null, artifactWrites = [],
    artifactRemovals = [], artifactBaselines = [], deferredReceipt = null,
    findingsPublication = null, activityId = null, result = null, references = undefined } = {}) {
    if (!(binding instanceof RequirementTestResultBinding)) throw new TypeError("Requirement writer requires its acquired source binding");
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#artifactWrites = artifactWrites;
    this.#artifactRemovals = artifactRemovals;
    this.#artifactBaselines = artifactBaselines;
    this.#deferredReceipt = deferredReceipt;
    this.#findingsPublication = findingsPublication;
    this.#activityId = activityId;
    this.#result = result;
    this.#references = references;
  }

  settle({ stepResult, settlement, publication = new RequirementTestSettlementPublication() }) {
    if (!(publication instanceof RequirementTestSettlementPublication)) throw new TypeError("Requirement writer requires its selected typed publication");
    return this.#flowManager.commitSpecStepResult({ specId: this.#specId,
      binding: { runId: this.#binding.runId, specId: this.#binding.specId,
        stepId: this.#binding.leaf, attempt: this.#binding.attempt },
      stepResult, settlement, commandResult: this.#commandResult,
      artifactWrites: [...this.#artifactWrites, ...publication.artifactWrites],
      artifactRemovals: [...this.#artifactRemovals, ...publication.artifactRemovals],
      artifactBaselines: [...this.#artifactBaselines, ...publication.artifactBaselines],
      selectedActivityId: this.#activityId,
      deferredReceipt: publication.deferredReceipt ?? this.#deferredReceipt,
      findingsPublication: publication.findingsPublication ?? this.#findingsPublication,
      activityId: this.#activityId,
      result: this.#result, references: this.#references });
  }
}
