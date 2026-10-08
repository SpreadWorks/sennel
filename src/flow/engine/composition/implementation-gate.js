import { StepRegistration } from "./step-registration.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { TaskStepBinding } from "../connectors/task/task-step-binding.js";
import { ImplGateStep } from "../../steps/impl/impl-gate.js";
import { TaskGateStep } from "../../steps/task/task-gate.js";
import { ImplGateService } from "../../services/impl-gate-service.js";
import { TaskGateService } from "../../services/task-gate-service.js";
import { ImplGateInput } from "../../services/impl-gate-input.js";
import { TaskGateInput } from "../../services/task-gate-input.js";
import { ImplReviewGateSettlementWriter } from "../../services/impl-review-gate-settlement-writer.js";
import { TaskGateSettlementWriter } from "../../services/task-gate-settlement-writer.js";
import { GateStepObservation, ImplementationGateResultEvidence } from "../../lib/gate-observation-values.js";
import { ImplementationGateIssuePublication } from "../../lib/gate-issue-publication.js";
import { attachedCanonicalCommandResultArtifact } from "../../lib/canonical-command-result.js";
import { readProspectiveImplementationGateEvidence, readImplementationGateExecutionEvidence,
  readCurrentGateTransitionFacts } from "../../lib/gate-transition-facts.js";
import { gateStepExecutionContract } from "../../lib/execution-admission.js";

export function prepareImplGateServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const state = input.observed === undefined
    ? flowManager.canonicalState(input.binding?.specId ?? input.ctx?.flowState?.specId) : null;
  const binding = input.binding ?? (state === null ? null
    : new ImplStepBinding({ flowManager, specId: state.specId, stepId: "impl-gate" }));
  const executionEvidence = input.observed === undefined && input.commandResult === undefined
    ? readImplementationGateExecutionEvidence({ flowManager, binding }) : null;
  const acquired = input.observed !== undefined ? input : input.evidence instanceof ImplementationGateResultEvidence
    ? { ...input, binding, observed: new ImplGateInput(new GateStepObservation(input.evidence)) } : input.commandResult !== undefined
    ? prepareImplGatePublication({ ...input, flowManager, state, binding })
    : { binding, observed: new ImplGateInput(new GateStepObservation(executionEvidence)) };
  if (!(acquired.observed instanceof ImplGateInput)) throw new TypeError("Implementation Gate composition requires acquired input");
  return [new ImplGateInput(new GateStepObservation(acquired.observed.evidence)), new ImplReviewGateSettlementWriter({
    flowManager, binding: acquired.binding,
    commandResult: acquired.commandResult, gatePublication: acquired.gatePublication,
    gateDeferralPublication: acquired.gateDeferralPublication ?? null,
    nonblockingPublication: acquired.nonblockingPublication ?? null,
  })];
}

export function prepareTaskGateServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.ctx?.flowState?.specId;
  const binding = input.binding ?? new TaskStepBinding({ flowManager, specId,
    definitionStepId: "task-gate" });
  binding.assertCurrent();
  const publication = input.gatePublication ?? (input.commandResult == null ? null
    : flowManager.prepareImplCommandPublication({ binding, commandResult: input.commandResult,
        issuePublication: input.issuePublication ?? null }));
  const evidence = input.observed instanceof TaskGateInput ? input.observed.observation.evidence
    : input.evidence ?? (publication === null
    ? readImplementationGateExecutionEvidence({ flowManager, binding })
    : readProspectiveImplementationGateEvidence({ flowManager, binding,
        commandResult: input.commandResult, publication }));
  return [new TaskGateInput(new GateStepObservation(evidence)), new TaskGateSettlementWriter({ flowManager, binding,
    publication, commandResult: input.commandResult ?? null,
    gateDeferralPublication: input.gateDeferralPublication ?? null,
    nonblockingPublication: input.nonblockingPublication ?? null,
    executionBinding: input.executionBinding ?? null })];
}

export class ImplGatePublicationPreparation {
  constructor({ binding, observed, gatePublication, commandResult, issuePublication }) {
    if (!(binding instanceof ImplStepBinding) || !(observed instanceof ImplGateInput)
      || observed.evidence.publication?.producerActivityId !== gatePublication.selectedActivityId) {
      throw new TypeError("Implementation Gate publication requires its exact acquired producer");
    }
    Object.assign(this, { binding, observed, gatePublication, commandResult, issuePublication });
    Object.freeze(this);
  }
}

export class ImplementationGatePublicationPreparation {
  constructor({ binding, evidence, gatePublication, issuePublication, commandResult }) {
    if (!(evidence instanceof ImplementationGateResultEvidence)
      || evidence.publication.producerActivityId !== gatePublication.selectedActivityId
      || evidence.identity.runId !== binding.runId || evidence.identity.specId !== binding.specId
      || evidence.stepId !== binding.stepId || evidence.identity.attempt.id !== binding.attempt.id
      || evidence.identity.attempt.sequence !== binding.attempt.sequence
      || issuePublication !== null && (!(issuePublication instanceof ImplementationGateIssuePublication)
        || !issuePublication.matches(binding))) {
      throw new TypeError("Implementation Gate acquisition requires its exact publication and issue identity");
    }
    Object.assign(this, { binding, evidence, gatePublication, issuePublication, commandResult });
    Object.freeze(this);
  }
}

/** Acquire the owning issue entry and its final Gate observation on one future Activity. */
export function prepareImplementationGatePublication({ ctx, binding, commandResult, IssueEntryClass }) {
  const flowManager = ctx.flowManager;
  const state = binding.assertCurrent();
  const provisional = flowManager.prepareImplCommandPublication({ binding, commandResult });
  const artifact = attachedCanonicalCommandResultArtifact(commandResult);
  const taskScope = binding.stepId === "task-gate";
  const phase = taskScope ? "task-impl" : "integration";
  let issuePublication = null;
  let gatePublication = provisional;
  if (["pass", "fail"].includes(artifact.payload.result)) {
    const flowState = flowManager.loadReadOnly(state.specId);
    const facts = taskScope ? readCurrentGateTransitionFacts({ flowManager, flowState,
      phase, root: ctx.root, prospectivePublication: provisional }) : null;
    const entry = new IssueEntryClass({ ctx: { ...ctx, flowState }, result: commandResult,
      prospectiveFacts: facts, prospectivePublication: taskScope ? provisional : null }).toJSON();
    issuePublication = new ImplementationGateIssuePublication({ binding, entry, facts });
    gatePublication = flowManager.prepareImplCommandPublication({ binding, commandResult,
      issuePublication, selectedActivityId: provisional.selectedActivityId });
  }
  const evidence = readProspectiveImplementationGateEvidence({ flowManager, binding, commandResult,
    publication: gatePublication, root: ctx.root });
  return new ImplementationGatePublicationPreparation({ binding, evidence, gatePublication, issuePublication, commandResult });
}

export function prepareImplGatePublication({ flowManager, state, commandResult, root = null, binding = null,
  issuePublication = null, gatePublication = null }) {
  const selectedBinding = binding ?? new ImplStepBinding({ flowManager, specId: state.specId, stepId: "impl-gate" });
  const publication = gatePublication ?? flowManager.prepareImplCommandPublication({ binding: selectedBinding, commandResult, issuePublication });
  const evidence = readProspectiveImplementationGateEvidence({ flowManager, binding: selectedBinding,
    commandResult, publication, root });
  return new ImplGatePublicationPreparation({ binding: selectedBinding, observed: new ImplGateInput(new GateStepObservation(evidence)),
    gatePublication: publication, commandResult, issuePublication });
}

/** Primary phase arrays and explicit acceptance reuse these exact Gate registrations. */
export const implementationGateStepRegistrations = Object.freeze([
  new StepRegistration({ stepId: "impl-gate", StepClass: ImplGateStep,
    ServiceClass: ImplGateService, prepareServiceArguments: prepareImplGateServiceArguments,
    executionContract: gateStepExecutionContract }),
  new StepRegistration({ stepId: "task-gate", StepClass: TaskGateStep,
    ServiceClass: TaskGateService, prepareServiceArguments: prepareTaskGateServiceArguments,
    executionContract: gateStepExecutionContract }),
]);
const byId = new Map(implementationGateStepRegistrations.map((registration) => [registration.stepId, registration]));
export function implementationGateStepRegistration(stepId) { return byId.get(stepId) ?? null; }
