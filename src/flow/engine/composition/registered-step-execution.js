import { flowLeafIdsBetween } from "../../definition.js";
import { draftStepRegistration, draftWorkerStepRegistration } from "./draft.js";
import { specStepRegistration, specWorkerStepRegistration } from "./spec.js";
import { prepareStepRegistration } from "./prepare.js";
import { requirementTestStepRegistration, requirementTestWorkerStepRegistration } from "./test.js";

const registeredPhaseSteps = new Set(flowLeafIdsBetween("branch", "test-gate"));

/** A targeted Definition leaf may never fall through to another phase's executor. */
export function workerStepExecutionRegistration(stepId) {
  const registration = requirementTestWorkerStepRegistration(stepId) ?? draftWorkerStepRegistration(stepId)
    ?? specWorkerStepRegistration(stepId);
  if (registration === null && registeredPhaseSteps.has(stepId)) {
    throw new Error(`Definition leaf ${stepId} has no registered worker execution contract`);
  }
  return registration;
}

export function flowStepExecutionRegistration(stepId) {
  const registration = requirementTestStepRegistration(stepId) ?? prepareStepRegistration(stepId)
    ?? draftStepRegistration(stepId) ?? specStepRegistration(stepId);
  if (registration === null && registeredPhaseSteps.has(stepId)) {
    throw new Error(`Definition leaf ${stepId} has no registered execution contract`);
  }
  return registration;
}

export function gateStepExecutionRegistration(phase) {
  if (phase === "draft") return flowStepExecutionRegistration("draft-gate");
  if (phase === "test") return flowStepExecutionRegistration("test-gate");
  if (phase === "spec" || phase === "task-spec") return flowStepExecutionRegistration("spec-gate");
  return null;
}

export function reviewStepExecutionRegistration(phase) {
  if (phase === "test") return flowStepExecutionRegistration("test-review");
  if (phase === "draft-questions") return flowStepExecutionRegistration("draft-questions-review");
  if (phase === "draft-coverage") return flowStepExecutionRegistration("draft-coverage-review");
  if (phase === "spec") return flowStepExecutionRegistration("spec-review");
  return null;
}
