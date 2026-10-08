import { implementationGateStepRegistration } from "./implementation-gate.js";
import { TestChainService } from "../../services/test-chain-service.js";
import { ImplReviewService } from "../../services/impl-review-service.js";
import { sourceStepRegistration } from "./source-step.js";
import { testChainStepRegistration } from "./test-chain.js";
import { implReviewStepRegistration,
  prepareImplReviewExecutionClaim } from "./impl-review-gate.js";
import { commitReviewExecutionClaim } from "../../lib/spec-review-operations.js";
import { ImplReviewExecutionRequiredResult } from "../step-result.js";
import { TestChainReceiptReplay } from "../../lib/test-chain-transition-facts.js";

export const implStepRegistrations = Object.freeze([
  sourceStepRegistration("implement"),
  testChainStepRegistration("test-execute"),
  testChainStepRegistration("test-result-review"),
  implReviewStepRegistration,
  sourceStepRegistration("impl-triage"),
  sourceStepRegistration("impl-repair"),
  implementationGateStepRegistration("impl-gate"),
]);

const byId = new Map(implStepRegistrations.map((registration) => [registration.stepId, registration]));
export function implStepRegistration(stepId) { return byId.get(stepId) ?? null; }

export async function claimImplReviewExecution(input) {
  const acquired = prepareImplReviewExecutionClaim(input);
  if (acquired.claim.needsCheckpoint) {
    const prepared = await implStepRegistration("impl-review").create({
      flowManager: input.flowManager, binding: acquired.binding, observed: acquired.observed,
      executionBinding: acquired.claim.executionBinding,
    });
    const selected = await prepared.step.execute();
    if (!(selected instanceof ImplReviewExecutionRequiredResult)) throw new Error("Implementation Review Step did not select execution");
  }
  return commitReviewExecutionClaim(acquired.claim);
}

export async function completeImplReviewPublication(input) {
  const prepared = await implStepRegistration("impl-review").create(input);
  if (prepared.completed === true) return prepared;
  await prepared.step.execute();
  return prepared.dependency(ImplReviewService).settlementOutcome;
}

export function consumeTestChainExecution(input) {
  const registration = implStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Test-chain consumption requires its registered Step");
  const selection = input.selection;
  return registration.executionContract.execute(selection, { ...input, registration });
}

function replayTestChainReceipt(receipt) {
  if (!(receipt instanceof TestChainReceiptReplay)) throw new TypeError("Test-chain replay requires authenticated receipt acquisition");
  receipt.assertCurrent();
  return receipt.receipt;
}

export function recoverTestChainExecution(input) {
  const registration = implStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Test-chain recovery requires its registered Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Test-chain recovery requires its selected registration");
  if (selection.receipt !== null) return replayTestChainReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}
