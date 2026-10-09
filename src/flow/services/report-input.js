import { ReportResultEvidence } from "../steps/acceptance/report-values.js";
export class ReportInput {
  constructor({ evidence }) {
    if (!(evidence instanceof ReportResultEvidence)) throw new TypeError("ReportInput requires acquired typed evidence");
    this.evidence = evidence;
    this.stepId = evidence.stepId;
    Object.freeze(this);
  }
}
