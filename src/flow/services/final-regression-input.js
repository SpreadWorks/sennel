import { FinalRegressionResultEvidence } from "../steps/acceptance/final-regression-result-evidence.js";
export class FinalRegressionInput {
  constructor({ evidence }) {
    if (!(evidence instanceof FinalRegressionResultEvidence)) throw new TypeError("FinalRegressionInput requires acquired typed evidence");
    this.evidence = evidence;
    this.stepId = evidence.stepId;
    Object.freeze(this);
  }
}
