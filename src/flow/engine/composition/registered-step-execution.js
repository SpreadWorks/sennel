import { flowLeafIdsBetween } from "../../definition.js";
import { draftStepRegistration, draftWorkerStepRegistration } from "./draft.js";
import { specStepRegistration, specWorkerStepRegistration } from "./spec.js";

const registeredPhaseSteps = new Set(flowLeafIdsBetween("draft", "spec-gate-repair"));

/** A targeted Definition leaf may never fall through to another phase's executor. */
export function workerStepExecutionRegistration(stepId) {
  const registration = draftWorkerStepRegistration(stepId) ?? specWorkerStepRegistration(stepId);
  if (registration === null && registeredPhaseSteps.has(stepId)) {
    throw new Error(`Definition leaf ${stepId} has no registered worker execution contract`);
  }
  return registration;
}

export function flowStepExecutionRegistration(stepId) {
  const registration = draftStepRegistration(stepId) ?? specStepRegistration(stepId);
  if (registration === null && registeredPhaseSteps.has(stepId)) {
    throw new Error(`Definition leaf ${stepId} has no registered execution contract`);
  }
  return registration;
}

export function gateStepExecutionRegistration(phase) {
  if (phase === "draft") return flowStepExecutionRegistration("draft-gate");
  if (phase === "spec" || phase === "task-spec") return flowStepExecutionRegistration("spec-gate");
  return null;
}

export function reviewStepExecutionRegistration(phase) {
  if (phase === "draft-questions") return flowStepExecutionRegistration("draft-questions-review");
  if (phase === "draft-coverage") return flowStepExecutionRegistration("draft-coverage-review");
  if (phase === "spec") return flowStepExecutionRegistration("spec-review");
  return null;
}
