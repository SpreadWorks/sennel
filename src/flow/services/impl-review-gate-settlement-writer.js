/** Save-only canonical publication of an implementation Review or Gate Result. */
export class ImplReviewGateSettlementWriter {
  #flowManager;
  #binding;
  #commandResult;
  #reviewPublication;
  #gatePublication;
  #executionBinding;
  #manifest;
  #failurePublication;
  #deferralPublication;
  #nonblockingPublication;
  constructor({ flowManager, binding, commandResult = null, reviewPublication = null,
    gatePublication = null, executionBinding = null, manifest = null, reviewFailurePublication = null, gateDeferralPublication = null, nonblockingPublication = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#reviewPublication = reviewPublication;
    this.#gatePublication = gatePublication;
    this.#executionBinding = executionBinding;
    this.#manifest = manifest;
    this.#failurePublication = reviewFailurePublication;
    this.#deferralPublication = gateDeferralPublication;
    this.#nonblockingPublication = nonblockingPublication;
  }
  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({ binding: this.#binding, stepResult, settlement,
      commandResult: this.#commandResult, reviewPublication: this.#reviewPublication,
      reviewFailurePublication: this.#failurePublication,
      gateDeferralPublication: this.#deferralPublication,
      nonblockingPublication: this.#nonblockingPublication,
      gatePublication: this.#gatePublication, executionBinding: this.#executionBinding, manifest: this.#manifest });
  }
}
