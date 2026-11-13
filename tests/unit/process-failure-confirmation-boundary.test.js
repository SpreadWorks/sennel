import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic,
  ProcessExecutionCommunicationDiagnostic } from "../../src/lib/process-execution-values.js";

// These exact semantic inputs produce a valid16384-byte unknown failure in
// the authentic revision9 producer. Keep inputs identical before/after repair.
test("a valid maximum-sized communication failure remains durably readable after stop confirmation", () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const callId = "22222222-2222-4222-8222-222222222222";
  const code = "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE";
  const communication = new ProcessExecutionCommunicationDiagnostic({ operation: "finish", budgetMs: 14000,
    elapsedMs: 14000, cutoff: "budget-exhausted", acceptance: "unknown", stopConfirmation: "unknown", attempts: [] });
  const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "\0".repeat(2048), { executionId, callId,
    diagnostic: new ProcessExecutionFailureDiagnostic({ executionId, callId, operation: "finish", role: "coordinator",
      phase: "unknown", primaryCause: { code, message: "x".repeat(1586) } }), communication });
  const original = failure.toJSON();
  assert.ok(Buffer.byteLength(JSON.stringify(original)) <= 16 * 1024);
  const restored = ProcessExecutionControlFailure.fromStored(original);
  const confirmed = restored.withStopConfirmation("confirmed");
  const reloaded = ProcessExecutionControlFailure.fromStored(confirmed.toJSON());
  assert.equal(reloaded.communication.stopConfirmation, "confirmed");
  assert.ok(Buffer.byteLength(JSON.stringify(confirmed)) <= Buffer.byteLength(JSON.stringify(original)));
  assert.equal(reloaded.message, failure.message);
  assert.deepEqual(reloaded.primaryCause.toJSON(), failure.primaryCause.toJSON());
  assert.deepEqual(reloaded.diagnostic.toJSON(), failure.diagnostic.toJSON());
  for (const key of ["operation", "budgetMs", "elapsedMs", "cutoff", "acceptance"]) {
    assert.equal(reloaded.communication[key], failure.communication[key]);
  }
  assert.deepEqual(reloaded.communication.attempts, failure.communication.attempts);
  assert.deepEqual(restored.toJSON(), original);
  assert.throws(() => reloaded.withStopConfirmation("unknown"), /cannot be removed/);
});
