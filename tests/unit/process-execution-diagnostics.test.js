import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic } from "../../src/lib/process-execution-values.js";

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
