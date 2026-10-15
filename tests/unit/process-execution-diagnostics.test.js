import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic, ProcessExecutionCommunicationAttempt,
  ProcessExecutionCommunicationDiagnostic } from "../../src/lib/process-execution-values.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";
const parentCallId = "33333333-3333-4333-8333-333333333333";
const foreignExecutionId = "44444444-4444-4444-8444-444444444444";
function diagnostic() {
  return new ProcessExecutionFailureDiagnostic({ executionId, callId, operation: "capture-members", role: "descendant",
    birth: { pid: 345, bootIdentity: "boot-instance", startFingerprint: "678" }, originalPgid: 123,
    observedPgid: 345, observedSid: 345,
    primaryCause: { code: "PROCESS_EXECUTION_OBSERVATION_UNKNOWN", message: "Member birth observation is unavailable" } });
}
function failure() {
  return new ProcessExecutionControlFailure("observation-unknown", "Member birth observation is unavailable",
    { executionId, callId, diagnostic: diagnostic() });
}

test("public process failure evidence is immutable, bounded and excludes arbitrary error authority", () => {
  const value = diagnostic();
  for (const part of [value, value.birth, value.primaryCause]) assert.equal(Object.isFrozen(part), true);
  assert.throws(() => { value.birth.pid = 999; }, TypeError);
  const unsafe = new Error("internal failure"); unsafe.ownerToken = "secret-owner"; unsafe.capability = "secret-capability"; unsafe.cause = unsafe;
  const original = failure(), wrapped = new ProcessExecutionControlFailure("stop-unconfirmed", "Stop could not be confirmed",
    { cause: unsafe, executionId, callId, diagnostic: original.diagnostic, primaryCause: original.primaryCause });
  const serialized = JSON.stringify(wrapped);
  assert.equal(/secret-owner|secret-capability|ownerToken|capability|stack|internal failure/.test(serialized), false);
  assert.deepEqual(ProcessExecutionControlFailure.fromStored(JSON.parse(serialized)).toJSON(), wrapped.toJSON());
});

test("parent failure envelopes retain the original process, operation and primary call provenance", () => {
  const original = failure();
  const parent = new ProcessExecutionControlFailure("stop-unconfirmed", "A descendant lacks a durable receipt", { cause: original,
    executionId, callId: parentCallId }).withContext({ executionId, callId: parentCallId });
  const envelope = JSON.parse(JSON.stringify({ ok: false, data: { processExecutionControlFailure: parent },
    errors: [{ level: "fatal", code: parent.code }] }));
  const restored = ProcessExecutionControlFailure.fromEnvelope(envelope);
  assert.equal(restored.code, "PROCESS_EXECUTION_STOP_UNCONFIRMED");
  assert.equal(restored.callId, parentCallId);
  assert.deepEqual(restored.primaryCause.toJSON(), original.primaryCause.toJSON());
  assert.deepEqual(restored.diagnostic.toJSON(), diagnostic().toJSON());
  assert.equal(restored.retryable, false);
});

test("versioned diagnostic boundaries reject unknown, recursive, excessive and inconsistent evidence", () => {
  const cases = [
    (value) => { value.diagnostic.ownerToken = "secret"; },
    (value) => { value.diagnostic.birth.ownerToken = "secret"; },
    (value) => { value.diagnostic.primaryCause.stack = "trace"; },
    (value) => { value.primaryCause.cause = value; },
    (value) => { value.diagnostic.birth.bootIdentity = "x".repeat(257); },
    (value) => { value.diagnostic.birth.startFingerprint = "1".repeat(33); },
    (value) => { value.diagnostic.role = "unrestricted-process"; },
    (value) => { value.diagnostic.operation = "x".repeat(81); },
    (value) => { value.diagnostic.schemaVersion = 2; },
    (value) => { delete value.diagnostic.schemaVersion; },
    (value) => { value.diagnostic.observedSid = null; },
    (value) => { value.diagnostic.birth.pid = 0; },
    (value) => { value.diagnostic.role = "launcher"; },
    (value) => { value.diagnostic.callId = parentCallId; },
    (value) => { value.primaryCause.code = "PROCESS_EXECUTION_REPLACED_CAUSE"; },
    (value) => { value.primaryCause.executionId = null; },
    (value) => { value.primaryCause.callId = null; },
    (value) => { value.message = "x".repeat(2049); },
    (value) => { value.retryable = true; },
  ];
  for (const mutate of cases) {
    const stored = failure().toJSON(); mutate(stored);
    assert.throws(() => ProcessExecutionControlFailure.fromStored(stored), TypeError, mutate.toString());
  }
});

test("call-bound restoration refuses another execution or call without replacing primary evidence", () => {
  const stored = failure().toJSON();
  assert.throws(() => ProcessExecutionControlFailure.fromStored(stored, { executionId: foreignExecutionId, callId }), { code: "PROCESS_EXECUTION_FAILURE_EVIDENCE_INVALID", executionId: foreignExecutionId, callId });
  assert.throws(() => ProcessExecutionControlFailure.fromStored(stored, { executionId, callId: parentCallId }), { code: "PROCESS_EXECUTION_FAILURE_EVIDENCE_INVALID", executionId, callId: parentCallId });
  assert.throws(() => failure().withContext({ executionId: foreignExecutionId, callId }), TypeError);
  assert.deepEqual(ProcessExecutionControlFailure.fromStored(stored, { executionId, callId }).toJSON(), stored);
});

test("an inconsistent envelope refuses handling while preserving its independently decoded primary diagnostic", () => {
  const original = failure();
  assert.throws(() => ProcessExecutionControlFailure.fromEnvelope({ ok: false,
    data: { processExecutionControlFailure: original.toJSON() }, errors: [{ level: "fatal", code: "PROCESS_EXECUTION_OTHER" }] }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_FAILURE_ENVELOPE_INVALID");
    assert.equal(error.executionId, executionId); assert.equal(error.callId, callId);
    assert.deepEqual(error.diagnostic.toJSON(), original.diagnostic.toJSON());
    assert.deepEqual(error.primaryCause.toJSON(), original.primaryCause.toJSON()); return true;
  });
});

test("unversioned and unsupported failures produce typed missing-evidence refusals tied to their call", () => {
  const legacy = { code: "PROCESS_EXECUTION_IDENTITY_UNKNOWN", message: "Old group escape failure", executionId, callId };
  for (const [stored, code] of [[legacy, "PROCESS_EXECUTION_FAILURE_EVIDENCE_MISSING"],
    [{ ...legacy, schemaVersion: 0 }, "PROCESS_EXECUTION_FAILURE_EVIDENCE_UNSUPPORTED"],
    [null, "PROCESS_EXECUTION_FAILURE_EVIDENCE_MISSING"]]) {
    assert.throws(() => ProcessExecutionControlFailure.fromStored(stored, { executionId, callId }), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.equal(error.code, code); assert.equal(error.executionId, executionId); assert.equal(error.callId, callId);
      assert.equal(error.retryable, false); return true;
    });
  }
});

function communication() {
  return new ProcessExecutionCommunicationDiagnostic({ operation: "start", budgetMs: 14000, elapsedMs: 14000.25,
    cutoff: "budget-exhausted", acceptance: "unknown", attempts: [
      new ProcessExecutionCommunicationAttempt({ ordinal: 1, responseDeadlineMs: 2000, elapsedMs: 1.25, outcome: "disconnected" }),
      new ProcessExecutionCommunicationAttempt({ ordinal: 2, responseDeadlineMs: 6000, elapsedMs: 4000, outcome: "timeout" }),
      new ProcessExecutionCommunicationAttempt({ ordinal: 3, responseDeadlineMs: 14000, elapsedMs: 8000.25, outcome: "timeout" }),
    ] });
}

test("communication failure survives context, later stop proof, storage and envelopes without replacing the first cause", () => {
  const original = new ProcessExecutionControlFailure("transport-timeout", "Launcher response budget exhausted", { executionId, callId, communication: communication() });
  const wrapped = new ProcessExecutionControlFailure("stop-unconfirmed", "Stopping failed", { cause: original,
    executionId, callId: parentCallId }).withContext({ executionId, callId: parentCallId });
  const confirmed = wrapped.withStopConfirmation("confirmed");
  assert.equal(original.communication.stopConfirmation, "unknown");
  assert.equal(confirmed.communication.stopConfirmation, "confirmed");
  assert.deepEqual(confirmed.communication.attempts, original.communication.attempts);
  assert.deepEqual(confirmed.primaryCause, original.primaryCause);
  const stored = JSON.parse(JSON.stringify(confirmed));
  const restored = ProcessExecutionControlFailure.fromStored(stored, { executionId, callId: parentCallId });
  assert.deepEqual(restored.toJSON(), stored);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope({ ok: false,
    data: { processExecutionControlFailure: stored }, errors: [{ level: "fatal", code: confirmed.code }] }).toJSON(), stored);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 16 * 1024);
  assert.equal(/ownerToken|capability|environment|stack/.test(JSON.stringify(stored)), false);
  for (const value of [original.communication, original.communication.attempts, ...original.communication.attempts]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => confirmed.withStopConfirmation("unknown"), TypeError);
});

test("communication evidence refuses unknown fields, invalid times, unordered or excessive history and retired failure revisions", () => {
  for (const mutate of [
    (value) => { value.communication.schemaVersion = 2; },
    (value) => { delete value.communication.schemaVersion; },
    (value) => { value.communication.ownerToken = "secret"; },
    (value) => { value.communication.attempts[0].stack = "trace"; },
    (value) => { value.communication.operation = "arbitrary-command"; },
    (value) => { value.communication.cutoff = "success"; },
    (value) => { value.communication.acceptance = "success"; },
    (value) => { value.communication.stopConfirmation = "assumed"; },
    (value) => { value.communication.elapsedMs = null; },
    (value) => { value.communication.budgetMs = Infinity; },
    (value) => { value.communication.attempts[0].elapsedMs = -1; },
    (value) => { value.communication.attempts[0].elapsedMs = 15000; },
    (value) => { value.communication.attempts[1].responseDeadlineMs = 1; },
    (value) => { value.communication.attempts[2].responseDeadlineMs = 15000; },
    (value) => { value.communication.attempts[0].ordinal = 2; },
    (value) => { value.communication.attempts[0].outcome = "succeeded"; },
    (value) => { value.communication.attempts.push(value.communication.attempts[0]); },
  ]) {
    const stored = new ProcessExecutionControlFailure("transport-timeout", "Budget exhausted", { executionId, callId, communication: communication() }).toJSON();
    mutate(stored);
    assert.throws(() => ProcessExecutionControlFailure.fromStored(stored), TypeError, mutate.toString());
  }
  const retired = failure().toJSON(); retired.schemaVersion = 1;
  assert.throws(() => ProcessExecutionControlFailure.fromStored(retired), { code: "PROCESS_EXECUTION_FAILURE_EVIDENCE_UNSUPPORTED" });
});

test("pre-attempt interruption records measured elapsed time with no fabricated attempt", () => {
  const value = new ProcessExecutionCommunicationDiagnostic({ operation: "stop", budgetMs: 100, elapsedMs: 0.75,
    cutoff: "aborted", attempts: [] });
  assert.equal(value.elapsedMs, 0.75);
  assert.equal(value.acceptance, "unknown");
  assert.equal(value.stopConfirmation, "unknown");
  assert.deepEqual(value.attempts, []);
});
