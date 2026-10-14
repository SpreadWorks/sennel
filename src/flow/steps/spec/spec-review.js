import { Step } from "../../engine/step.js";
import { SpecReviewService } from "../../services/spec-review-service.js";
import { ReviewWorkUnitManifest } from "../../lib/review-work-unit-values.js";
import { specReviewResult } from "./spec-review-result.js";

export class SpecReviewStep extends Step {
  static dependencies = [SpecReviewService];

  #service;

  constructor(service) {
    super();
    if (!(service instanceof SpecReviewService)) throw new TypeError("SpecReviewService is required");
    this.#service = service;
  }

  async _execute() {
    const facts = this.#service.inspectReview();
    let result;
    if (facts instanceof ReviewWorkUnitManifest) {
      // Work-unit and admission errors must refuse execution before provider.
      result = specReviewResult(facts);
    } else {
      try {
        result = specReviewResult(facts);
      } catch (error) {
        result = specReviewResult(error);
      }
    }
    await result.persist(this.#service);
    return result;
  }
}
