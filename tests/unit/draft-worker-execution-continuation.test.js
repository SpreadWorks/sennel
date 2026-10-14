import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DraftWorkerExecutionContinuationFacts,
  DraftWorkerNewExecution,
  DraftWorkerSealedReplay,
  DraftWorkerPublicationReplay,
  DraftWorkerExecutionStop,
  resolveDraftWorkerExecutionContinuation,
} from "../../src/flow/lib/draft-worker-execution-continuation.js";

test("new and unclaimed Draft execution retains its first-start authorization", () => {
  for (const phase of [null, "checkpoint"]) {
    const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({ phase }));
    assert.ok(decision instanceof DraftWorkerNewExecution);
    assert.equal(decision.requiresWorker, true);
    assert.equal(decision.usesSavedResponse, false);
  }
  assert.ok(resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
    phase: "claimed", response: "unsealed", newlyClaimed: true,
  })) instanceof DraftWorkerNewExecution);
});

test("reacquired claimed executions stop without request or sealed response", () => {
  for (const response of ["absent", "unsealed"]) {
    const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
      phase: "claimed", response,
    }));
    assert.ok(decision instanceof DraftWorkerExecutionStop);
    assert.equal(decision.code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
    assert.equal(decision.requiresWorker, false);
    assert.equal(decision.usesSavedResponse, false);
  }
});

test("a live authorized protocol retry retains its exact prior execution identity", () => {
  const receiptId = "a".repeat(64);
  const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
    phase: "claimed", response: "unsealed", retryAuthorized: true, receiptId,
  }));
  assert.ok(decision instanceof DraftWorkerNewExecution);
  assert.equal(decision.receiptId, receiptId);
  assert.equal(decision.requiresWorker, true);
});

test("saved responses select replay rather than another provider call", () => {
  for (const newlyClaimed of [false, true]) {
    const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
      phase: "claimed", response: "sealed", newlyClaimed,
    }));
    assert.ok(decision instanceof DraftWorkerSealedReplay);
    assert.equal(decision.requiresWorker, false);
    assert.equal(decision.usesSavedResponse, true);
  }
  const published = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
    phase: "publication", response: "sealed",
  }));
  assert.ok(published instanceof DraftWorkerPublicationReplay);
  assert.equal(published.requiresWorker, false);
  assert.equal(published.usesSavedResponse, true);
});

test("missing publication evidence and completed executions do not authorize new calls", () => {
  for (const phase of ["publication", "terminal"]) {
    const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({ phase }));
    assert.ok(decision instanceof DraftWorkerExecutionStop);
    assert.equal(decision.requiresWorker, false);
  }
});

test("a rejected boundary observation retains its original diagnostic", () => {
  const refusal = Object.assign(new Error("Saved request input changed"), { code: "FLOW_ARTIFACT_HANDOFF_STALE" });
  const decision = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
    phase: "claimed", response: "invalid", refusal,
  }));
  assert.ok(decision instanceof DraftWorkerExecutionStop);
  assert.equal(decision.code, refusal.code);
  assert.equal(decision.reason, refusal.message);
  assert.equal(decision.cause, refusal);
});

test("continuation facts reject unsupported phases and contradictory observations", () => {
  for (const input of [
    { phase: "unknown" },
    { phase: "checkpoint", newlyClaimed: true },
    { phase: "checkpoint", response: "sealed" },
    { phase: "claimed", response: "invalid", refusal: "failure" },
    { phase: "claimed", refusal: new Error("failure") },
  ]) assert.throws(() => new DraftWorkerExecutionContinuationFacts(input), TypeError);
  assert.throws(() => resolveDraftWorkerExecutionContinuation({ phase: "claimed" }), TypeError);
});
