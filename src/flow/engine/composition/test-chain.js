import { TestChainInput } from "../../services/test-chain-input.js";
import { TestChainSettlementWriter } from "../../services/test-chain-settlement-writer.js";
import { TestChainResultEvidence } from "../../lib/test-chain-values.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { NonGateTargetBinding, NonGateRetryMetrics } from "../../lib/non-gate-transition.js";
import { TestChainTransitionSnapshot, readTestChainTransitionFactsFromSnapshot } from "../../lib/test-chain-transition-facts.js";
import { testChainStepExecutionContract } from "../../lib/test-chain-transition-facts.js";
import { StepRegistration } from "./step-registration.js";
import { TestChainService } from "../../services/test-chain-service.js";
import { TestExecuteStep } from "../../steps/impl/test-execute.js";
import { TestResultReviewStep } from "../../steps/impl/test-result-review.js";

export function prepareTestChainServiceArguments(input, _ConnectorClass, stepId) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const acquired = input.preparation ?? (input.observed === undefined ? prepareTestChainPublication({ ...input, flowManager,
    state: flowManager.canonicalState(input.binding?.specId ?? input.ctx?.flowState?.specId) }) : input);
  if (!(acquired.observed instanceof TestChainInput) || acquired.observed.stepId !== stepId) {
    throw new TypeError("Test-chain composition requires acquired evidence for its registered leaf");
  }
  return [new TestChainInput(acquired.observed), new TestChainSettlementWriter({
    flowManager, binding: acquired.binding,
    commandResult: acquired.commandResult, testChainPublication: acquired.testChainPublication,
    nonblockingPublication: acquired.nonblockingPublication ?? null,
  })];
}

const registrations = Object.freeze([
  new StepRegistration({ stepId: "test-execute", StepClass: TestExecuteStep,
    ServiceClass: TestChainService, prepareServiceArguments: prepareTestChainServiceArguments,
    executionContract: testChainStepExecutionContract }),
  new StepRegistration({ stepId: "test-result-review", StepClass: TestResultReviewStep,
    ServiceClass: TestChainService, prepareServiceArguments: prepareTestChainServiceArguments,
    executionContract: testChainStepExecutionContract }),
]);
export function testChainStepRegistration(stepId) { return registrations.find((entry) => entry.stepId === stepId) ?? null; }

export function acquireTestChainInput(facts) {
  return new TestChainInput({ evidence: TestChainResultEvidence.fromTransitionFacts(facts) });
}

export class TestChainPublicationPreparation {
  constructor({ binding, observed, testChainPublication, commandResult }) {
    if (!(observed instanceof TestChainInput) || observed.stepId !== binding.stepId) {
      throw new TypeError("Test-chain publication preparation requires its bound typed input");
    }
    Object.assign(this, { binding, observed, testChainPublication, commandResult });
    Object.freeze(this);
  }
}

export class TestChainExecutionPreparation {
  constructor({ binding, observed }) {
    if (!(binding instanceof ImplStepBinding) || !(observed instanceof TestChainInput)
      || binding.stepId !== "test-execute" || !observed.evidence.executionRequired) {
      throw new TypeError("Test execution preparation requires its exact request Attempt");
    }
    this.binding = binding;
    this.observed = observed;
    Object.freeze(this);
  }
}

export function prepareTestExecutionRequest({ flowManager, state }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "test-execute" });
  return new TestChainExecutionPreparation({ binding, observed: acquireTestExecutionInput({ state }) });
}

/** Build request facts from the canonical active Attempt without claiming success. */
export function acquireTestExecutionInput({ state }) {
  const contract = state.definition.contractForNode(state.findNode("test-execute"));
  return new TestChainInput({ evidence: new TestChainResultEvidence({
    identity: new NonGateTargetBinding({ runId: state.runId, specId: state.specId,
      stepId: "test-execute", attempt: state.attempt }),
    retry: new NonGateRetryMetrics({ used: state.attempt.consumption.semantic,
      maximum: Math.max(1, contract.semanticRetryLimit) }),
  }) });
}

/** Reuse the canonical test-chain reader over the exact future publication. */
export function prepareTestChainPublication({ flowManager, state, commandResult, binding = null }) {
  const selectedBinding = binding ?? new ImplStepBinding({ flowManager, specId: state.specId, stepId: state.current.at(-1) });
  const publication = flowManager.prepareImplCommandPublication({ binding: selectedBinding, commandResult });
  const facts = readTestChainTransitionFactsFromSnapshot({
    snapshot: new TestChainTransitionSnapshot(publication),
    readCatalogedArtifact: (descriptor) => publication.readCatalogedArtifact(descriptor),
    readRuntimeArtifact: (input) => publication.readRuntimeArtifact(input),
  });
  return new TestChainPublicationPreparation({ binding: selectedBinding, observed: acquireTestChainInput(facts), testChainPublication: publication, commandResult });
}
