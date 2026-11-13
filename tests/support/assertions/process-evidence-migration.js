import assert from "node:assert/strict";
import { ProcessExecutionStopReceipt, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { ProcessExecutionReservationRevocation } from "../../../src/lib/process-execution-reservation-revocation.js";

// Compare all original data; only independently versioned protocol evidence
// changes representation. Original ACKs, events and closure identities stay exact.
function assertFailure(source, current) {
  assert.equal(current.schemaVersion, 3);
  const { schemaVersion: oldVersion, communication: oldCommunication, ...oldFields } = source;
  const { schemaVersion: newVersion, communication: newCommunication, ...newFields } = current;
  assert.equal(oldVersion, 2); assert.equal(newVersion, 3); assert.deepEqual(newFields, oldFields);
  if (oldCommunication === null) assert.equal(newCommunication, null);
  else {
    const { schemaVersion, stopConfirmation, ...oldTiming } = oldCommunication;
    const { schemaVersion: currentVersion, stopConfirmed, ...newTiming } = newCommunication;
    assert.equal(schemaVersion, 1); assert.equal(currentVersion, 2);
    assert.equal(stopConfirmed, stopConfirmation === "confirmed"); assert.deepEqual(newTiming, oldTiming);
  }
}

function assertCompletion(source, current) {
  const stopped = source.scope === "registered-executions";
  assert.equal(current.schemaVersion, stopped ? 4 : 3);
  assert.deepEqual({ ...current, schemaVersion: source.schemaVersion }, source);
  const fact = stopped ? new ProcessExecutionStopReceipt(current) : ProcessExecutionReservationRevocation.fromStored(current);
  assert.equal(fact.evidenceDigest, executionValueDigest(source));
  for (const name of ["mainDevice", "mainInode", "checkoutDevice", "checkoutInode"]) assert.equal(fact.checkoutIdentity[name], String(source.checkoutIdentity[name]));
}

export function assertProcessRuntimeEvidencePreserved(source, current) {
  assert.equal(current.version, 10);
  const checkout = { ...source.checkout };
  for (const name of ["mainDevice", "mainInode", "checkoutDevice", "checkoutInode"]) checkout[name] = String(checkout[name]);
  assert.deepEqual(current.checkout, checkout);
  assert.equal(current.ownerEpoch, source.ownerEpoch); assert.equal(current.slot, source.slot);
  assert.equal(current.executions.length, source.executions.length);
  for (const old of source.executions) {
    const next = current.executions.find(value => value.executionId === old.executionId);
    // Includes every original event, actual durable canonical ACK, finalization
    // cutoff, closure, epoch, grant identity and lifecycle flag.
    assert.deepEqual({ ...next, calls: [], requests: [] }, { ...old, calls: [], requests: [] });
    assert.equal(next.calls.length, old.calls.length); assert.equal(next.requests.length, old.requests.length);
    for (const call of old.calls) {
      const actual = next.calls.find(value => value.callId === call.callId);
      assert.deepEqual({ ...actual, receipt: null, revocation: null, controlFailure: null }, { ...call, receipt: null, revocation: null, controlFailure: null });
      if (call.receipt !== null) assertCompletion(call.receipt, actual.receipt); else assert.equal(actual.receipt, null);
      if (call.revocation !== null) assertCompletion(call.revocation, actual.revocation); else assert.equal(actual.revocation, null);
      if (call.controlFailure !== null) assertFailure(call.controlFailure, actual.controlFailure); else assert.equal(actual.controlFailure, null);
    }
    for (const [index, request] of old.requests.entries()) {
      const actual = next.requests[index];
      assert.deepEqual({ ...actual, response: null }, { ...request, response: null });
      if (request.response?.ok === true && ["finish", "revoke-reservation"].includes(request.operation)) assertCompletion(request.response.value, actual.response.value);
      else if (request.response?.ok === true && request.operation === "failure") assertFailure(request.response.value, actual.response.value);
      else assert.equal(JSON.stringify(actual.response), JSON.stringify(request.response));
    }
  }
}
