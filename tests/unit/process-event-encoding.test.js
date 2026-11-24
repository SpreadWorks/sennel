import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionEvent, executionValueDigest } from "../../src/lib/process-execution-values.js";

const id = "a1894b74-e91e-43fa-a967-52d7f9f34a6f";
function input() {
  return { eventId: id, executionId: id, callId: id, parentCallId: null, rootCallId: id,
    sequence: 1, type: "reserved", binding: null, occurredAt: "2026-10-31T00:00:00.000Z",
    payload: { text: "日本語 😀", items: [{ value: "retained" }, null], omitted: undefined } };
}

test("event encoding retains an immutable normalized value while public JSON copies stay independent", () => {
  const source = input();
  const event = new ProcessExecutionEvent(source);
  const expected = { ...source, binding: event.binding.toJSON(), payload: JSON.parse(JSON.stringify(source.payload)) };
  const view = event.toEncodingValue();
  const bytes = JSON.stringify(expected);
  assert.equal(JSON.stringify(view), bytes);
  assert.equal(event.digest, executionValueDigest(expected));
  assert.equal(event.toEncodingValue(), view);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.binding), true);
  assert.equal(Object.isFrozen(view.payload.items[0]), true);
  source.payload.items[0].value = "producer changed";
  const first = event.toJSON(), second = event.toJSON();
  first.payload.items[0].value = "consumer changed";
  first.binding = "consumer changed";
  assert.deepEqual(second, expected);
  assert.equal(JSON.stringify(event.toEncodingValue()), bytes);
  assert.equal(event.digest, executionValueDigest(expected));
  assert.throws(() => { view.payload.items[0].value = "attempted change"; }, TypeError);
  const reloaded = ProcessExecutionEvent.fromStored(JSON.parse(bytes));
  assert.equal(JSON.stringify(reloaded.toEncodingValue()), bytes);
  assert.equal(reloaded.digest, event.digest);
});
