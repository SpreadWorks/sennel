import assert from "node:assert/strict";
import { test } from "node:test";
import { readAcceptanceExecutionContract } from "../../../src/flow/lib/acceptance-execution-session.js";
import { FlowExecutionContract, FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";
import { DraftWorkerExecutionBinding, DraftStepExecutionLifecycle, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";

function acquired(phase = "claimed") {
  const fingerprint = "a".repeat(64);
  const binding = { runId: "run", specId: "spec", stepId: "acceptance-review", attempt: { id: "attempt", sequence: 1 } };
  const state = { ...binding, current: [binding.stepId], attempt: { ...binding.attempt, nodeId: binding.stepId, failure: null } };
  const context = { fingerprint: { hash: fingerprint }, executionInputBaselines: [], mechanicalBlockers: [] };
  const executionBinding = new DraftWorkerExecutionBinding({ executionGeneration: 0, inputDigest: fingerprint, inputRevision: fingerprint });
  let lifecycle = DraftStepExecutionLifecycle.checkpoint(executionBinding);
  if (phase === "claimed") lifecycle = lifecycle.claimed(new DraftWorkerExecutionClaim({ dispatchInvocationId: "dispatch",
    generatedAt: "2026-10-13T00:00:00.000Z", actionDigest: fingerprint, requestDigest: "b".repeat(64) }));
  const stored = FlowExecutionContract.fromBinding({ binding, generation: 0, inputRevision: fingerprint,
    promptDigest: "b".repeat(64), schemaDigest: "c".repeat(64), inputBaselines: [] });
  const reads = [];
  const flowManager = {
    draftStepExecutionState() { return { lifecycle }; },
    readStoredExecutionContract({ optional }) { reads.push("stored"); assert.equal(optional, phase === "checkpoint"); return stored; },
    readExecutionContract({ executionContract }) { reads.push("contract"); stored.assertMatches(executionContract); return stored; },
  };
  return { binding, state, context, flowManager, reads, stored };
}

for (const phase of ["checkpoint", "claimed"]) {
  test(`Acceptance refuses changed ${phase} inputs before contract/provider planning even with mechanical blockers`, () => {
    const input = acquired(phase);
    input.context.fingerprint.hash = "d".repeat(64);
    input.context.mechanicalBlockers = [{ kind: "invalid_upgrade" }];
    assert.throws(() => readAcceptanceExecutionContract(input), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
    assert.deepEqual(input.reads, [], "changed acquired input must be refused before further execution reads");
  });
}

test("Acceptance unchanged claimed input retains its exact saved contract", () => {
  const input = acquired();
  assert.deepEqual(readAcceptanceExecutionContract(input).toJSON(), input.stored.toJSON());
  assert.deepEqual(input.reads, ["stored", "contract"]);
});

test("Acceptance rejects a saved contract from another runtime without planning another request", () => {
  const input = acquired();
  input.flowManager.readStoredExecutionContract = () => new FlowExecutionContract({ ...input.stored.toJSON(), runtimeRevision: "other-runtime", inputBaselines: [] });
  input.flowManager.readExecutionContract = ({ executionContract }) => {
    input.flowManager.readStoredExecutionContract().assertMatches(executionContract);
  };
  assert.throws(() => readAcceptanceExecutionContract(input), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH", mismatchedFields: ["runtimeRevision"] });
});

test("Acceptance unclaimed mechanical blockers do not acquire an execution contract", () => {
  const input = acquired();
  input.flowManager.draftStepExecutionState = () => ({ lifecycle: null });
  input.context.mechanicalBlockers = [{ kind: "missing_test_evidence" }];
  assert.equal(readAcceptanceExecutionContract(input), null);
  assert.deepEqual(input.reads, []);
});

test("Acceptance checkpoint may precede its contract, but a claimed execution may not", () => {
  for (const phase of ["checkpoint", "claimed"]) {
    const input = acquired(phase);
    input.flowManager.readStoredExecutionContract = ({ optional }) => {
      if (!optional) throw new FlowExecutionContractRefusal("Unfinished execution has no canonical contract");
      return null;
    };
    if (phase === "checkpoint") assert.equal(readAcceptanceExecutionContract(input), null);
    else assert.throws(() => readAcceptanceExecutionContract(input), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
    assert.deepEqual(input.reads, []);
  }
});
