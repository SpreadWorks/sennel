import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { ArtifactWorkerExecutionFrontier, ArtifactWorkerRecoveryEvidence,
  ArtifactWorkerRecoveryReceipt } from "../../src/flow/lib/artifact-worker-recovery-values.js";
import { ArtifactWorkerExecutionContinuationFacts, ArtifactWorkerNewExecution,
  ArtifactWorkerSealedReplay, ArtifactWorkerPublicationReplay, ArtifactWorkerRecoveryRequired,
  ArtifactWorkerRecoveryAuthorized, ArtifactWorkerExecutionStop,
  resolveArtifactWorkerExecutionContinuation } from "../../src/flow/lib/artifact-worker-execution-continuation.js";
import { ArtifactWorkerOwnerExecution } from "../../src/flow/lib/artifact-worker-owner-execution.js";
import { DraftWorkerExecutionContinuationFacts, DraftWorkerNewExecution,
  DraftWorkerSealedReplay, DraftWorkerExecutionStop,
  resolveDraftWorkerExecutionContinuation } from "../../src/flow/lib/draft-worker-execution-continuation.js";

const digest = "a".repeat(64);
function contract(generation) {
  return new FlowExecutionContract({ runId: "run", specId: "spec", stepId: "spec-triage",
    attemptId: "attempt", attemptSequence: 1, generation, inputRevision: digest,
    runtimeRevision: digest, promptDigest: digest, schemaDigest: digest });
}
function frontier(status = null) {
  const sourceContract = contract(0);
  if (status === null) return new ArtifactWorkerExecutionFrontier({ contracts: [sourceContract] });
  const targetContract = contract(1);
  const evidence = new ArtifactWorkerRecoveryEvidence({ sourceContract, targetContract,
    requestDigest: digest, targetRequestDigest: "b".repeat(64), physicalEvidenceDigest: digest,
    sourceDispatchInvocationId: "source", targetDispatchInvocationId: "target",
    budget: { providerCallCount: 1 } });
  return new ArtifactWorkerExecutionFrontier({ contracts: [sourceContract, targetContract],
    recovery: new ArtifactWorkerRecoveryReceipt({ evidence,
      result: { kind: "artifact-worker-recovery-authorized" }, settlement: { kind: "execution" } }), status });
}
function select(input = {}) {
  return resolveArtifactWorkerExecutionContinuation(new ArtifactWorkerExecutionContinuationFacts({
    frontier: frontier(), ...input,
  }));
}

test("artifact execution distinguishes a first claim from reacquiring an unfinished claim", () => {
  const fresh = select({ frontier: new ArtifactWorkerExecutionFrontier({ contracts: [] }) });
  assert.ok(fresh instanceof ArtifactWorkerNewExecution);
  assert.equal(fresh.requiresWorker, true);
  assert.ok(select({ response: "unsealed", newlyClaimed: true }) instanceof ArtifactWorkerNewExecution);
  assert.ok(select({ response: "unsealed", retryAuthorized: true, physical: "stopped" }) instanceof ArtifactWorkerNewExecution);
  const retained = select({ response: "unsealed" });
  assert.ok(retained instanceof ArtifactWorkerExecutionStop);
  assert.equal(retained.code, "FLOW_ARTIFACT_EXECUTION_STOP_UNCONFIRMED");
  assert.equal(retained.requiresWorker, false);
  assert.equal(retained.retryable, false);
});

test("sealed and partially published results replay before considering additional execution", () => {
  for (const status of [null, "unconsumed", "reserved", "accepted"]) {
    const replay = select({ frontier: frontier(status), response: "sealed", physical: "running",
      responseDigest: digest });
    assert.ok(replay instanceof ArtifactWorkerSealedReplay);
    assert.equal(replay.requiresWorker, false);
    assert.equal(replay.usesSavedResponse, true);
    assert.equal(replay.responseDigest, digest);
  }
  for (const publication of ["pending", "accepted"]) {
    assert.ok(select({ publication }) instanceof ArtifactWorkerPublicationReplay);
  }
});

test("a phase owner that completed the prior generation selects its next execution without replaying old results", () => {
  for (const publication of ["unpublished", "accepted"]) {
    const next = select({ ownerGeneration: 1, response: "sealed", responseDigest: digest, publication });
    assert.ok(next instanceof ArtifactWorkerNewExecution);
    assert.equal(next.requiresWorker, true);
    assert.equal(next.usesSavedResponse, false);
  }
  assert.ok(select({ ownerGeneration: 0, response: "sealed" }) instanceof ArtifactWorkerSealedReplay);
  assert.equal(select({ ownerGeneration: 1, response: "sealed", publication: "unknown" }).code,
    "FLOW_ARTIFACT_EXECUTION_PUBLICATION_UNKNOWN");
});

test("only authenticated stopped or unstarted claims with remaining budget select explicit recovery", () => {
  for (const physical of ["stopped", "unstarted"]) {
    const required = select({ physical, response: "unsealed", recoveryBudgetAvailable: true });
    assert.ok(required instanceof ArtifactWorkerRecoveryRequired);
    assert.equal(required.requiresWorker, false);
    assert.equal(required.executionContract.id, contract(0).id);
  }
  for (const physical of ["running", "unknown"]) {
    const stopped = select({ physical, recoveryBudgetAvailable: true });
    assert.ok(stopped instanceof ArtifactWorkerExecutionStop);
    assert.equal(stopped.code, "FLOW_ARTIFACT_EXECUTION_STOP_UNCONFIRMED");
  }
  const exhausted = select({ physical: "stopped" });
  assert.ok(exhausted instanceof ArtifactWorkerExecutionStop);
  assert.equal(exhausted.code, "FLOW_ARTIFACT_EXECUTION_RECOVERY_EXHAUSTED");
});

test("saved replacement permits one unused call and requires explicit reconciliation for an unstarted reservation", () => {
  const unconsumed = frontier("unconsumed");
  const authorized = select({ frontier: unconsumed, physical: "stopped" });
  assert.ok(authorized instanceof ArtifactWorkerRecoveryAuthorized);
  assert.equal(authorized.recoveryId, unconsumed.recovery.id);
  assert.equal(authorized.executionContract.id, contract(1).id);
  const unreconciled = select({ frontier: frontier("reserved"), physical: "unstarted" });
  assert.ok(unreconciled instanceof ArtifactWorkerRecoveryRequired);
  assert.equal(unreconciled.requiresWorker, false);
  for (const [status, physical] of [["unconsumed", "running"], ["reserved", "unknown"],
    ["reserved", "stopped"], ["accepted", "unstarted"]]) {
    const rejected = select({ frontier: frontier(status), physical, newlyClaimed: true,
      response: "unsealed", recoveryBudgetAvailable: true });
    assert.ok(rejected instanceof ArtifactWorkerExecutionStop);
    assert.equal(rejected.requiresWorker, false);
  }
});

test("an already authorized tooling retry continues after recovery without allocating another recovery receipt", () => {
  for (const status of ["reserved", "accepted"]) {
    for (const physical of ["stopped", "unstarted"]) {
      const saved = frontier(status);
      const selected = select({ frontier: saved, response: "unsealed", retryAuthorized: true, physical });
      assert.ok(selected instanceof ArtifactWorkerNewExecution);
      assert.equal(selected.requiresWorker, true);
      assert.equal(selected.executionContract, saved.executionContract);
      assert.equal(selected.recovery, saved.recovery);
      assert.equal(selected.recoveryId, saved.recovery.id);
    }
  }
});

test("tooling retry authorization cannot start a worker while the previous physical execution is running", () => {
  for (const status of [null, "unconsumed", "reserved", "accepted"]) {
    const stopped = select({ frontier: frontier(status), response: "unsealed", retryAuthorized: true,
      physical: "running", recoveryBudgetAvailable: true });
    assert.ok(stopped instanceof ArtifactWorkerExecutionStop);
    assert.equal(stopped.requiresWorker, false);
    assert.equal(stopped.retryable, false);
  }
  const unknown = select({ response: "unsealed", retryAuthorized: true, physical: "unknown", recoveryBudgetAvailable: true });
  assert.ok(unknown instanceof ArtifactWorkerExecutionStop);
  assert.equal(unknown.code, "FLOW_ARTIFACT_EXECUTION_STOP_UNCONFIRMED");
});

test("invalid or unknown publication evidence refuses execution while retaining the diagnostic", () => {
  const refusal = Object.assign(new Error("request changed"), { code: "INPUT_CHANGED" });
  const rejected = select({ response: "invalid", refusal, physical: "stopped", recoveryBudgetAvailable: true });
  assert.ok(rejected instanceof ArtifactWorkerExecutionStop);
  assert.equal(rejected.code, refusal.code);
  assert.equal(rejected.cause, refusal);
  assert.equal(rejected.reason, refusal.message);
  assert.equal(select({ publication: "unknown", response: "sealed" }).code,
    "FLOW_ARTIFACT_EXECUTION_PUBLICATION_UNKNOWN");
});

test("phase owners retain their frontier and acquire only the saved recovery generation and budget", () => {
  const canonical = frontier("unconsumed");
  const selected = new ArtifactWorkerOwnerExecution({ frontier: canonical, generation: 0 });
  assert.equal(selected.generation, 1);
  assert.equal(selected.executionContract, canonical.recovery.targetContract);
  assert.equal(selected.budgetOwner, canonical.recovery.sourceContract.budgetOwner);
  const advanced = new ArtifactWorkerOwnerExecution({ frontier: canonical, generation: 2,
    budgetOwner: selected.budgetOwner });
  assert.equal(advanced.generation, 2);
  assert.equal(advanced.executionContract, null);
  assert.equal(advanced.recovery, null);
  assert.throws(() => new ArtifactWorkerOwnerExecution({ frontier: canonical, generation: 0,
    budgetOwner: "different-budget" }), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
});

test("conditional Draft consumes the shared authorization decision while retaining its own publication lifecycle", () => {
  const artifactContinuation = select({ frontier: frontier("unconsumed"), physical: "stopped" });
  const claimed = new DraftWorkerExecutionContinuationFacts({ phase: "claimed", response: "unsealed" });
  const resumed = resolveDraftWorkerExecutionContinuation(claimed.withArtifactContinuation(artifactContinuation));
  assert.ok(resumed instanceof DraftWorkerNewExecution);
  assert.equal(resumed.recoveryId, artifactContinuation.recoveryId);
  assert.equal(resumed.executionContract, artifactContinuation.executionContract);
  const sealed = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
    phase: "claimed", response: "sealed", artifactContinuation,
  }));
  assert.ok(sealed instanceof DraftWorkerSealedReplay);
  for (const phase of ["publication", "terminal"]) {
    const rejected = resolveDraftWorkerExecutionContinuation(new DraftWorkerExecutionContinuationFacts({
      phase, artifactContinuation,
    }));
    assert.ok(rejected instanceof DraftWorkerExecutionStop);
  }
  assert.throws(() => claimed.withArtifactContinuation(select({ physical: "running" })), TypeError);
});

test("execution observations require their typed frontier and supported classifications", () => {
  for (const input of [{ frontier: {} }, { response: "present" }, { physical: "missing" },
    { publication: "missing" }, { response: "invalid" }, { ownerGeneration: -1 }, { ownerGeneration: 0.5 }]) {
    assert.throws(() => new ArtifactWorkerExecutionContinuationFacts({ frontier: frontier(), ...input }), TypeError);
  }
  assert.throws(() => resolveArtifactWorkerExecutionContinuation({ frontier: frontier() }), TypeError);
});
