import {
  SpecReviewPassedResult,
  SpecReviewAdvisoryResult,
  SpecReviewRejectedResult,
  SpecReviewExecutionRequiredResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { CanonicalSpecReview } from "../../lib/spec-review-artifacts.js";
import { ReviewWorkUnitManifest, ReviewWorkUnitOutput } from "../../lib/review-work-unit-values.js";

/** Select the execution or accepted-review meaning from canonical typed facts. */
export function specReviewResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("spec-review", facts);
  if (facts instanceof ReviewWorkUnitManifest) {
    const semanticInputs = facts.inputs.filter((input) => !["review.execution-options", "review.guardrails"].includes(input.logicalKey));
    if (facts.phase !== "spec" || facts.nodeId !== "spec-review" || facts.taskId !== null
      || !facts.output.equals(ReviewWorkUnitOutput.forReview({ phase: "spec" }))
      || semanticInputs.length !== 2
      || !facts.inputs.some((input) => input.logicalKey === "spec.record")
      || !facts.inputs.some((input) => input.logicalKey === "spec.review")) {
      throw new TypeError("Spec Review work unit does not declare its canonical inputs and delta output");
    }
    return new SpecReviewExecutionRequiredResult();
  }
  if (!(facts instanceof CanonicalSpecReview)
    || facts.audit.at(-1)?.stage !== "spec-review") {
    throw new TypeError("Spec Review Result requires an accepted canonical review");
  }
  const findings = facts.findings.findings;
  if (findings.some((finding) => finding.kind === "blocking")) return new SpecReviewRejectedResult();
  if (findings.some((finding) => finding.kind === "improvement")) return new SpecReviewAdvisoryResult();
  return new SpecReviewPassedResult();
}
