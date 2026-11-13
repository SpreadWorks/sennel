import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ProcessExecutionCheckoutIdentity, ProcessExecutionStopReceipt, ProcessExecutionControlFailure,
  ProcessExecutionFailureDiagnostic, ProcessExecutionCommunicationDiagnostic, ProcessExecutionRecoveryCall, ProcessExecutionRecoveryEvidenceSummary, executionValueDigest } from "../../src/lib/process-execution-values.js";
import { ProcessExecutionEvidenceMigration } from "../../src/lib/process-execution-evidence-migration.js";

function originalReceipt() {
  const source = JSON.parse(fs.readFileSync(new URL("../fixtures/process-runtime-record-v8-canonical/archives/2e9ded1e-d0db-4fa7-ae6b-30b18c03756a.json", import.meta.url)));
  return source.payload.execution.calls.find(call => call.receipt !== null).receipt;
}

test("explicit migration retains the producer completion identity while current authority requires decimal identities", () => {
  const source = originalReceipt();
  assert.equal(source.schemaVersion, 3);
  assert.throws(() => new ProcessExecutionStopReceipt(source), TypeError);
  assert.throws(() => new ProcessExecutionCheckoutIdentity(source.checkoutIdentity), TypeError);
  const current = ProcessExecutionEvidenceMigration.retainedCompletion(source);
  assert.equal(current.schemaVersion, 4);
  assert.equal(current.evidenceDigest, executionValueDigest(source));
  assert.deepEqual({ ...current.toJSON(), schemaVersion: 3 }, source);
  assert.notEqual(executionValueDigest(current), current.evidenceDigest);
  for (const name of ["mainDevice", "mainInode", "checkoutDevice", "checkoutInode"]) {
    assert.equal(current.checkoutIdentity[name], String(source.checkoutIdentity[name]));
  }
  const native = new ProcessExecutionCheckoutIdentity({ ...current.checkoutIdentity.toJSON(),
    mainDevice: "-9223372036854775803", mainInode: "9007199254740993",
    checkoutDevice: "-9223372036854775803", checkoutInode: "9007199254740993" });
  const fresh = new ProcessExecutionStopReceipt({ ...source, schemaVersion: 4, checkoutIdentity: native });
  assert.equal(fresh.evidenceDigest, executionValueDigest(fresh));
  assert.equal(fresh.checkoutIdentity.checkoutInode, "9007199254740993");
});

test("explicit previous decoding rejects rounded or signed numeric predecessor tokens and inconsistent source fields", () => {
  const source = originalReceipt();
  for (const mainInode of [9007199254740992, -1, -0]) {
    assert.throws(() => ProcessExecutionEvidenceMigration.retainedCompletion({ ...source,
      checkoutIdentity: { ...source.checkoutIdentity, mainInode } }), TypeError);
  }
  assert.throws(() => ProcessExecutionEvidenceMigration.retainedCompletion({ ...source, unknown: true }), TypeError);
});

test("the exact current 16KiB failure remains bounded through confirmation and durable readback", () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const callId = "22222222-2222-4222-8222-222222222222";
  const communication = new ProcessExecutionCommunicationDiagnostic({ operation: "finish", budgetMs: 14000, elapsedMs: 14000,
    cutoff: "budget-exhausted", acceptance: "unknown", stopConfirmation: "unknown", attempts: [] });
  const make = length => new ProcessExecutionControlFailure("endpoint-unavailable", "\0".repeat(2047) + "x", { executionId, callId, communication,
    diagnostic: new ProcessExecutionFailureDiagnostic({ executionId, callId, operation: "finish", role: "coordinator",
      phase: "unknown", primaryCause: { code: "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", message: "x".repeat(length) } }) });
  const baseLength = 1;
  const zeroBytes = Buffer.byteLength(JSON.stringify(make(baseLength)));
  const remaining = 16384 - zeroBytes;
  // The diagnostic primary cause occurs in two independently stored views.
  assert.equal(remaining % 2, 0);
  const failure = make(baseLength + remaining / 2);
  assert.equal(Buffer.byteLength(JSON.stringify(failure)), 16384);
  const confirmed = ProcessExecutionControlFailure.fromStored(failure.toJSON()).withStopConfirmation("confirmed");
  assert.equal(Buffer.byteLength(JSON.stringify(confirmed)), 16383);
  const reloaded = ProcessExecutionControlFailure.fromStored(confirmed.toJSON());
  assert.equal(reloaded.communication.stopConfirmation, "confirmed");
  assert.deepEqual(reloaded.diagnostic.toJSON(), failure.diagnostic.toJSON());
  assert.deepEqual(reloaded.primaryCause.toJSON(), failure.primaryCause.toJSON());
});

test("saved recovery migration preserves original observation identities for both completed calls and absence", () => {
  const receipt = originalReceipt();
  for (const empty of [false, true]) {
    const migratedReceipt = ProcessExecutionEvidenceMigration.retainedCompletion(receipt);
    const binding = empty ? { episode: "detached-codec-observation" } : receipt.binding;
    const call = empty ? null : new ProcessExecutionRecoveryCall({
      executionId: receipt.executionId, callId: receipt.callId, ownerEpoch: receipt.ownerEpoch,
      binding, invocation: receipt.invocation, invocationDigest: receipt.invocationDigest,
      startPermitted: true, receipt: migratedReceipt, revocation: null,
    });
    // Detached source-format values, not a physical owner, exit or recovery
    // authority. The native producer/migration integration covers those facts.
    const source = { schemaVersion: 3, checkoutIdentity: receipt.checkoutIdentity, binding, invocation: null,
      inventoryDigest: "a".repeat(64), ownerEpoch: empty ? 1 : receipt.ownerEpoch,
      calls: call === null ? [] : [call.toJSON()], nonExecution: empty ? { schemaVersion: 1,
        checkoutIdentity: receipt.checkoutIdentity, binding, invocation: null, inventoryDigest: "a".repeat(64),
        ownerEpoch: 1, executions: [{ executionId: receipt.executionId, ownerEpoch: 1, authorityState: "closed" }],
        reservationBeforeSpawn: true } : null };
    const id = executionValueDigest(source);
    const saved = { ...source, id, digest: id };
    const migrated = ProcessExecutionEvidenceMigration.recoverySummary(saved);
    const restored = ProcessExecutionRecoveryEvidenceSummary.fromSaved(migrated);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.id, id); assert.equal(migrated.digest, id);
    assert.equal(restored.evidenceDigest, id);
    assert.deepEqual(restored.toEvidenceJSON(), source);
    assert.notEqual(executionValueDigest(restored.toJSON()), id);
    assert.equal(restored.checkoutIdentity.mainDevice, String(receipt.checkoutIdentity.mainDevice));
    assert.deepEqual(Object.keys(migrated), Object.keys(saved));
    const wireDigest = executionValueDigest(restored.toJSON());
    assert.throws(() => ProcessExecutionRecoveryEvidenceSummary.fromSaved({ ...migrated, id: wireDigest, digest: wireDigest }), TypeError);
  }
});
