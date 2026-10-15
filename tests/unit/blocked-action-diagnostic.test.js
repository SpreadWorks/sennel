import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockedActionDiagnostic, BlockedDirective, NextActionDirective } from "../../src/flow/lib/next-action-directive.js";
import { ArtifactWorkerExecutionFrontier } from "../../src/flow/lib/artifact-worker-recovery-values.js";
import { ArtifactWorkerExecutionContinuationFacts } from "../../src/flow/lib/artifact-worker-execution-continuation.js";
import { DraftWorkerExecutionContinuationFacts } from "../../src/flow/lib/draft-worker-execution-continuation.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { selectWorkerExecutionAdmission, projectWorkerExecutionAdmission,
  assertWorkerExecutionAdmission } from "../../src/flow/lib/worker-execution-admission.js";

test("blocked directives retain their existing public representation without diagnostics", () => {
  const directive = new BlockedDirective({ code: "BLOCKED", reason: "Input is unavailable.", resumeInstruction: "Restore the input." });
  const expected = { kind: "blocked", terminal: true, requiresUserAction: false,
    code: "BLOCKED", reason: "Input is unavailable.", resumeInstruction: "Restore the input." };
  assert.deepEqual(directive.toJSON(), expected);
  assert.deepEqual(NextActionDirective.fromStored(expected).toJSON(), expected);
});

test("blocked diagnostic readback retains missing conditions and available resolution facts", () => {
  const diagnostic = new BlockedActionDiagnostic({ code: "STOP_REQUIRED", reason: "Worker stop is unconfirmed.",
    missingConditions: ["confirmed-stop"], resolutionOperation: "recover-process", resolutionImplemented: true,
    retryable: false });
  const directive = new BlockedDirective({ code: diagnostic.code, reason: diagnostic.reason,
    resumeInstruction: "Resolve the missing conditions.", diagnostic });
  const stored = JSON.parse(JSON.stringify(directive));
  assert.deepEqual(stored.diagnostic, diagnostic.toJSON());
  const restored = NextActionDirective.fromStored(stored);
  assert.ok(restored.diagnostic instanceof BlockedActionDiagnostic);
  assert.deepEqual(restored.toJSON(), stored);
  assert.throws(() => restored.diagnostic.missingConditions.push("changed"), TypeError);
  assert.throws(() => new BlockedDirective({ code: "DIFFERENT", reason: diagnostic.reason, diagnostic }), TypeError);
  assert.throws(() => new BlockedDirective({ code: diagnostic.code, reason: diagnostic.reason,
    diagnostic: diagnostic.toJSON() }), TypeError);
  assert.throws(() => NextActionDirective.fromStored({ ...stored,
    diagnostic: { ...stored.diagnostic, operationAuthority: "invented" } }), TypeError);
});

test("artifact stop projects the same structured diagnostic into next-action and worker refusal", () => {
  const digest = "a".repeat(64);
  const executionContract = new FlowExecutionContract({ runId: "run", specId: "spec", stepId: "spec-triage",
    attemptId: "attempt", attemptSequence: 1, generation: 0, inputRevision: digest,
    runtimeRevision: digest, promptDigest: digest, schemaDigest: digest });
  const state = { runId: "run", specId: "spec", current: ["spec-triage"], lifecycle: { state: "active" },
    attempt: { id: "attempt", nodeId: "spec-triage", sequence: 1, failure: null },
    nextAction: () => ({ nodeId: "spec-triage", operation: "resume" }) };
  const savedState = JSON.stringify(state);
  const selection = selectWorkerExecutionAdmission({ ctx: { specId: "spec", flowManager: {
    canonicalState: () => state, loadReadOnly: () => ({ specId: "spec", runId: "run" }), activityLedger: () => [],
  } }, stepId: "spec-triage", handoffCoordinator: {
    readArtifactWorkerExecutionContinuation: () => new ArtifactWorkerExecutionContinuationFacts({
      frontier: new ArtifactWorkerExecutionFrontier({ contracts: [executionContract] }),
      response: "unsealed", physical: "unknown", recoveryBudgetAvailable: true,
    }),
  } });
  const directive = projectWorkerExecutionAdmission(selection);
  assert.ok(directive instanceof BlockedDirective);
  assert.deepEqual(directive.toJSON().diagnostic, {
    code: "FLOW_ARTIFACT_EXECUTION_STOP_UNCONFIRMED",
    reason: "The previous artifact worker has no authenticated stop or non-execution proof.",
    missingConditions: ["confirmed-stop-or-non-execution"], resolutionOperation: null,
    resolutionImplemented: false, retryable: false,
  });
  assert.throws(() => assertWorkerExecutionAdmission(selection), (error) => {
    assert.equal(error.code, directive.code);
    assert.equal(error.message, directive.reason);
    assert.equal(error.retryable, false);
    assert.equal(error.recoveryPossible, false);
    assert.deepEqual(error.data, { failureKind: "step-admission", diagnostic: directive.toJSON().diagnostic });
    return true;
  });
  assert.equal(JSON.stringify(state), savedState);
});

test("an existing conditional owner keeps its refusal code while projecting the shared physical diagnostic", () => {
  const digest = "a".repeat(64);
  const stepId = "draft-gate-repair";
  const contract = new FlowExecutionContract({ runId: "run", specId: "spec", stepId,
    attemptId: "attempt", attemptSequence: 1, generation: 0, inputRevision: digest,
    runtimeRevision: digest, promptDigest: digest, schemaDigest: digest });
  const state = { runId: "run", specId: "spec", current: [stepId], lifecycle: { state: "active" },
    attempt: { id: "attempt", nodeId: stepId, sequence: 1, failure: null },
    nextAction: () => ({ nodeId: stepId, operation: "resume" }) };
  const selection = selectWorkerExecutionAdmission({ ctx: { specId: "spec", flowManager: {
    canonicalState: () => state, loadReadOnly: () => ({ specId: "spec", runId: "run" }), activityLedger: () => [],
  } }, stepId, handoffCoordinator: {
    readDraftWorkerExecutionContinuation: () => new DraftWorkerExecutionContinuationFacts({ phase: "claimed", response: "unsealed" }),
    readArtifactWorkerExecutionContinuation: () => new ArtifactWorkerExecutionContinuationFacts({
      frontier: new ArtifactWorkerExecutionFrontier({ contracts: [contract] }), response: "unsealed", physical: "unknown",
    }),
  } });
  const directive = projectWorkerExecutionAdmission(selection);
  assert.equal(directive.code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
  assert.equal(directive.reason, selection.artifactContinuation.reason);
  assert.deepEqual(directive.diagnostic.toJSON(), {
    code: "FLOW_EXECUTION_CONTRACT_MISMATCH", reason: selection.artifactContinuation.reason,
    missingConditions: ["confirmed-stop-or-non-execution"], resolutionOperation: null,
    resolutionImplemented: false, retryable: false,
  });
  assert.throws(() => assertWorkerExecutionAdmission(selection), (error) => {
    assert.equal(error.code, directive.code);
    assert.deepEqual(error.data.diagnostic, directive.diagnostic.toJSON());
    return true;
  });
});
