import {
  StepErrorResult, RequirementTestToolingEvidence, RequirementTestExternalBlockedError,
} from "../../engine/step-result.js";

/** Common acquired failure classifications; persistence failures never enter this path. */
export function requirementTestFailureResult(input, ToolingResult, ExternalResult) {
  const operands = input.resultOperands();
  if (input.error instanceof RequirementTestExternalBlockedError) {
    if (ExternalResult === null) throw new TypeError("This Requirement leaf has no external-blocked Result");
    return new ExternalResult({ ...operands, evidence: input.evidence, error: input.error });
  }
  if (input.error !== null) return new StepErrorResult(input.stepId, input.error, operands);
  if (input.evidence instanceof RequirementTestToolingEvidence) {
    return new ToolingResult({ ...operands, evidence: input.evidence });
  }
  return null;
}
