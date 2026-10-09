import { TaskStepBinding } from "../../../src/flow/engine/connectors/task/task-step-binding.js";
import { ImplStepBinding } from "../../../src/flow/engine/connectors/impl/impl-step-binding.js";
import { implementationGateStepRegistration, prepareImplementationGatePublication }
  from "../../../src/flow/engine/composition/implementation-gate.js";
import { GateIssueLogEntry } from "../../../src/flow/lib/run-gate.js";

/** Assemble the production Task Gate publication without committing it. */
function prepareGateScenario({ repository, manager, specId, commandResult }, binding, phase) {
  const ctx = { root: repository, mainRoot: repository, executionRoot: repository,
    specId, flowManager: manager, flowState: manager.loadReadOnly(specId), phase };
  const publication = prepareImplementationGatePublication({ ctx, binding, commandResult,
    IssueEntryClass: GateIssueLogEntry });
  const registration = implementationGateStepRegistration(binding.stepId);
  const prepared = registration.create({ flowManager: manager, specId, binding,
    commandResult, evidence: publication.evidence, gatePublication: publication.gatePublication,
    issuePublication: publication.issuePublication });
  return Object.freeze({ binding, publication, prepared });
}

export function prepareTaskGateScenario(input) {
  return prepareGateScenario(input, new TaskStepBinding({ flowManager: input.manager,
    specId: input.specId, definitionStepId: "task-gate" }), "task-impl");
}

export function prepareIntegrationGateScenario(input) {
  return prepareGateScenario(input, new ImplStepBinding({ flowManager: input.manager,
    specId: input.specId, stepId: "impl-gate" }), "integration");
}

/** Save only through the actual registered Step, Service and selected Store. */
export function executeTaskGateScenario(input) {
  const preparation = prepareTaskGateScenario(input);
  return preparation.prepared.step.execute();
}

export function executeIntegrationGateScenario(input) {
  return prepareIntegrationGateScenario(input).prepared.step.execute();
}
