import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { ArtifactWorkerRecoveryEvidence, ArtifactWorkerRecoveryReceipt } from "../../src/flow/lib/artifact-worker-recovery-values.js";
import { ArtifactWorkerInputContinuation } from "../../src/flow/lib/artifact-worker-input-continuation.js";
import { DraftWorkerRecoveryCheckpoint } from "../../src/flow/lib/draft-worker-recovery-checkpoint.js";
import { DraftConditionalWorkerExecutionBinding, DraftWorkerExecutionBinding, DraftWorkerExecutionClaim,
  DraftStepExecutionLifecycle, DraftStepExecutionState, DraftStepSettlementReceipt,
  DraftStepSettlementPublication, settleDraftStepResult } from "../../src/flow/definition.js";
import { DraftRefineWorkerRequiredResult } from "../../src/flow/engine/step-result.js";
import { assertDraftSettlementReceiptTransition } from "../../src/flow/lib/current-flow-state.js";

const digest = "a".repeat(64);
const contentDigest = "b".repeat(64);
function fixture({ phase = "claimed", legacy = false, generation = 0, requestDigest = digest } = {}) {
  const binding = { runId: "run", specId: "spec", stepId: "draft-refine",
    attempt: { id: "attempt", nodeId: "draft-refine", sequence: 1 } };
  const sourceContract = new FlowExecutionContract({ runId: binding.runId, specId: binding.specId,
    stepId: binding.stepId, attemptId: binding.attempt.id, attemptSequence: binding.attempt.sequence,
    generation: 0, inputRevision: digest, runtimeRevision: "c".repeat(64),
    promptDigest: digest, schemaDigest: digest });
  const targetContract = new FlowExecutionContract({ ...sourceContract.toJSON(),
    generation: 1, inputRevision: "d".repeat(64), runtimeRevision: "e".repeat(64) });
  const executionBinding = legacy
    ? new DraftWorkerExecutionBinding({ executionGeneration: generation, inputDigest: digest, inputRevision: digest })
    : new DraftConditionalWorkerExecutionBinding({ executionGeneration: generation,
      inputDigest: digest, inputRevision: digest, contentDigest });
  const claim = new DraftWorkerExecutionClaim({ dispatchInvocationId: "source-dispatch",
    generatedAt: "2026-10-15T00:00:00.000Z", actionDigest: digest, requestDigest });
  const lifecycle = phase === "checkpoint" ? DraftStepExecutionLifecycle.checkpoint(executionBinding)
    : new DraftStepExecutionLifecycle({ phase, binding: executionBinding, claim });
  const stepResult = new DraftRefineWorkerRequiredResult();
  const settlement = settleDraftStepResult(binding.stepId, stepResult);
  const receipt = new DraftStepSettlementReceipt({ binding, result: stepResult, settlement,
    publication: new DraftStepSettlementPublication(), executionLifecycle: lifecycle });
  const executionState = new DraftStepExecutionState({ binding, receipt, result: stepResult });
  const evidence = new ArtifactWorkerRecoveryEvidence({ sourceContract, targetContract,
    requestDigest: digest, targetRequestDigest: "f".repeat(64), physicalEvidenceDigest: digest,
    sourceDispatchInvocationId: "source-dispatch", targetDispatchInvocationId: "target-dispatch",
    budget: { providerCallCount: 1 }, inputContinuation: new ArtifactWorkerInputContinuation({
      sourceContract, targetContract, contentDigest: "1".repeat(64),
    }) });
  const recovery = new ArtifactWorkerRecoveryReceipt({ evidence,
    result: { kind: "artifact-worker-recovery-authorized" }, settlement: { kind: "execution" } });
  const targetRequest = { executionContract: targetContract, inputDigest: "2".repeat(64),
    inputRevision: targetContract.inputRevision, requestDigest: evidence.targetRequestDigest,
    dispatchInvocationId: evidence.targetDispatchInvocationId };
  return { binding, executionState, recovery, targetRequest, targetContentDigest: contentDigest, receipt };
}

test("a conditional recovery reuses its selected Result and creates the authorized generation checkpoint", () => {
  const value = fixture();
  const before = value.executionState.toJSON();
  const checkpoint = new DraftWorkerRecoveryCheckpoint(value);
  assert.equal(checkpoint.binding, value.binding);
  assert.equal(checkpoint.stepResult, value.executionState.executionIdentity().stepResult);
  assert.equal(checkpoint.settlement, value.executionState.executionIdentity().settlement);
  assert.equal(checkpoint.executionBinding.executionGeneration, value.recovery.targetGeneration);
  assert.equal(checkpoint.executionBinding.inputDigest, value.targetRequest.inputDigest);
  assert.equal(checkpoint.executionBinding.inputRevision, value.recovery.targetContract.inputRevision);
  assert.equal(checkpoint.executionBinding.contentDigest, contentDigest);
  assert.equal(checkpoint.lifecycle.phase, "checkpoint");
  assert.equal(checkpoint.lifecycle.claim, null);
  const saved = new DraftStepSettlementReceipt({ binding: checkpoint.binding,
    result: checkpoint.stepResult, settlement: checkpoint.settlement,
    publication: new DraftStepSettlementPublication({ recoveryId: value.recovery.id }),
    executionLifecycle: checkpoint.lifecycle });
  assert.equal(assertDraftSettlementReceiptTransition([value.receipt], saved).id, saved.id);
  assert.deepEqual(value.executionState.toJSON(), before);
});

test("conditional recovery refuses legacy, unclaimed, published, stale generation and foreign claim states", () => {
  for (const options of [{ legacy: true }, { phase: "checkpoint" }, { phase: "publication" },
    { generation: 1 }, { requestDigest: "9".repeat(64) }]) {
    const value = fixture(options);
    const before = value.executionState.toJSON();
    assert.throws(() => new DraftWorkerRecoveryCheckpoint(value), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
    assert.deepEqual(value.executionState.toJSON(), before);
  }
});

test("conditional recovery refuses changed target provenance, checkpoint content and Attempt binding", () => {
  const value = fixture();
  for (const changed of [
    { targetContentDigest: "9".repeat(64) },
    { binding: { ...value.binding, attempt: { ...value.binding.attempt, id: "foreign-attempt" } } },
    { targetRequest: { ...value.targetRequest, requestDigest: "9".repeat(64) } },
    { targetRequest: { ...value.targetRequest, dispatchInvocationId: "foreign-dispatch" } },
  ]) assert.throws(() => new DraftWorkerRecoveryCheckpoint({ ...value, ...changed }),
    { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
});
