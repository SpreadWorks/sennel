import { StepResult } from "../engine/step-result.js";
import { settleSpecStepResult } from "../definition.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { SpecGatePublicationIntent, SpecGatePublicationVersion } from "../lib/spec-gate-prospective.js";
import { readProspectiveSpecGateFacts, SpecGateAdmissionRefusal } from "../lib/gate-transition-facts.js";
import { SpecGateIssuePublication } from "../lib/gate-issue-publication.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state.js";
import { SpecGateResultSelection } from "../steps/spec/spec-gate-result.js";

/** Owns evaluation evidence and the canonical Spec Gate settlement boundary. */
export class SpecGateService {
  #publication;
  #selection = null;

  constructor({ flowManager, binding, commandResult, issuePublication = null } = {}) {
    if (!flowManager || typeof flowManager.settleSpecStepResult !== "function"
      || binding?.stepId !== "spec-gate" || binding.flowManager !== flowManager) {
      throw new TypeError("SpecGateService requires a bound prospective Gate observation");
    }
    if (issuePublication !== null && !(issuePublication instanceof SpecGateIssuePublication)) {
      throw new TypeError("SpecGateService requires typed issue evidence");
    }
    try {
      const version = flowManager.readCanonicalTransitionView({
        specId: binding.specId,
        read: (view) => new SpecGatePublicationVersion({ binding, view }),
      });
      const facts = readProspectiveSpecGateFacts({
        flowManager, binding, commandResult, issuePublication,
      });
      // Facts readers consume canonical evidence through the existing APIs.
      // Reject a mixed observation if any publication changed during that read.
      flowManager.readCanonicalTransitionView({ specId: binding.specId, read: (view) => version.assert(view) });
      this.#publication = new SpecGatePublicationIntent({
        facts, issue: issuePublication, version, binding, commandResult,
      });
    } catch (cause) {
      if (!(cause instanceof CurrentFlowStateConflictError)) throw cause;
      throw new SpecGateAdmissionRefusal("Spec Gate inputs changed while reading prospective facts", cause);
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.commandResult = commandResult;
    this.issuePublication = issuePublication;
    Object.freeze(this);
  }

  assertGateResultAdmission() {
    try {
      this.flowManager.readCanonicalTransitionView({
        specId: this.binding.specId, read: (view) => this.#publication.assert(view),
      });
      this.#publication.assertPublication({ binding: this.binding, commandResult: this.commandResult });
    } catch (cause) { throw new SpecGateAdmissionRefusal("Spec Gate inputs changed before Result selection", cause); }
  }
  inspectGateFacts() { return this.#publication.facts; }
  inspectGatePublication() { return this.#publication; }

  acceptGateResultSelection(selection) {
    if (!(selection instanceof SpecGateResultSelection) || selection.publication !== this.#publication) {
      throw new TypeError("Spec Gate Service requires the Step selection for its exact publication");
    }
    if (this.#selection !== null) this.#selection.assertResult(selection.result);
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("SpecGateService requires its bound Result");
    }
    if (this.#selection === null) throw new TypeError("Spec Gate Result requires a sealed Step selection");
    this.#selection.assertResult(stepResult);
    const input = {
      binding: this.binding,
      stepResult,
      settlement: settleSpecStepResult(this.binding.stepId, stepResult),
      commandResult: this.commandResult,
      gatePublication: this.#selection,
    };
    try {
      const committed = this.flowManager.settleSpecStepResult(input);
      return committed.receipt;
    } catch (error) {
      const receipt = this.flowManager.findStepSettlementReceipt(input);
      if (receipt !== null) return receipt;
      throw new StepPersistenceFailure(error);
    }
  }
}
