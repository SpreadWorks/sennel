import test from "node:test";
import assert from "node:assert/strict";
import { ManagedProcessMessage, ManagedProcessRequestBatch, MANAGED_PROCESS_MESSAGE_MAX_BYTES } from "../../src/lib/managed-process-protocol.js";

const id = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const call = { executionId: id(1), callId: id(2), ownerToken: id(3), capability: id(4) };
const message = (index, operation = "reserve", data = { literal: "日本語\u0000$HOME\\value" }, owner = call) => {
  return new ManagedProcessMessage(owner, operation, { data }, { requestId: id(index + 10) });
};
const json = (value) => JSON.parse(JSON.stringify(value));

test("managed batch wire keeps every original identity and payload in order across independent decode", () => {
  const messages = [message(0), message(1), message(2)];
  const expected = json(messages), batch = new ManagedProcessRequestBatch(messages), wire = batch.wireBytes();
  messages[0].payload.data.literal = "changed after capture";
  const exposed = batch.messages; exposed[0].payload.data.literal = "changed decoded view";
  assert.deepEqual(json(batch.messages), expected);
  assert.deepEqual(batch.wireBytes(), wire);
  const reopened = ManagedProcessRequestBatch.fromEnvelope(JSON.parse(wire));
  assert.deepEqual(json(reopened.messages), expected);
  for (const entry of reopened.messages) entry.assertPayload();
});

test("managed batch wire refuses empty, duplicate, mixed and differently authorized containers before dispatch", () => {
  for (const messages of [[], [message(0)], [message(0), message(0)], [message(0), message(1, "finish")],
    [message(0), message(1, "reserve", {}, { ...call, capability: id(90) })],
    Array.from({ length: ManagedProcessRequestBatch.maximumWidth + 1 }, (_value, index) => message(index))]) {
    assert.throws(() => new ManagedProcessRequestBatch(messages), TypeError);
  }
  assert.throws(() => ManagedProcessRequestBatch.fromEnvelope({ messages: null }), TypeError);
});

test("managed batch wire counts UTF-8 framing against the unchanged message bound", () => {
  assert.equal(MANAGED_PROCESS_MESSAGE_MAX_BYTES, 32 * 1024 * 1024);
  const content = "x".repeat(MANAGED_PROCESS_MESSAGE_MAX_BYTES / 2);
  assert.throws(() => new ManagedProcessRequestBatch([message(0, "reserve", { content }), message(1, "reserve", { content })]), RangeError);
  assert.throws(() => new ManagedProcessRequestBatch([message(0, "reserve", { content: content.replaceAll("x", "語") }), message(1)]), RangeError);
});
