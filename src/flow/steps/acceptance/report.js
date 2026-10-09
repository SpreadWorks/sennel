import { Step } from "../../engine/step.js";
import { ReportDeliveryRequiredResult, ReportGeneratedResult } from "../../engine/step-result.js";
import { ReportService } from "../../services/report-service.js";
import { ReportResultEvidence } from "./report-values.js";
export function reportResult(input) {
  const evidence = input.evidence;
  if (!(evidence instanceof ReportResultEvidence)) throw new TypeError("Report requires acquired evidence");
  return evidence.delivery === "pending" ? new ReportDeliveryRequiredResult({ evidence }) : new ReportGeneratedResult({ evidence });
}
export class ReportStep extends Step {
  static dependencies = [ReportService];
  #service;
  constructor(service) { super(); if (!(service instanceof ReportService)) throw new TypeError("ReportService is required"); this.#service = service; }
  async _execute() { const result = reportResult(this.#service.inspectInput()); await result.persist(this.#service); return result; }
}
