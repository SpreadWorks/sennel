import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionEvent, ProcessExecutionEventGroup, ProcessExecutionAtomicEventWriter,
  ProcessExecutionCanonicalAcknowledgement } from "../../src/lib/process-execution-values.js";
const id = "a1894b74-e91e-43fa-a967-52d7f9f34a6f";
function event(changes = {}) {
  return new ProcessExecutionEvent({ eventId: id, executionId: id, callId: id, parentCallId: null, rootCallId: id,
    sequence: 1, type: "reserved", binding: null, occurredAt: "2026-10-31T00:00:00.000Z", payload: {}, ...changes });
}
test("event group retains immutable typed observations and refuses a different execution or binding", () => {
  const first = event(), second = event({ sequence: 2 });
  const input = [first, second], group = new ProcessExecutionEventGroup(input);
  input.pop();
  assert.deepEqual(group.events, [first, second]);
  assert.equal(Object.isFrozen(group), true);
  assert.throws(() => group.events.pop(), TypeError);
  assert.throws(() => new ProcessExecutionEventGroup([]), TypeError);
  assert.throws(() => new ProcessExecutionEventGroup([first.toJSON()]), TypeError);
  assert.throws(() => new ProcessExecutionEventGroup([first, event({ executionId: "b1894b74-e91e-43fa-a967-52d7f9f34a6f" })]), TypeError);
  assert.throws(() => new ProcessExecutionEventGroup([first, event({ binding: { runId: "another" } })]), TypeError);
});
test("atomic writer retains its single-event port for synchronous and asynchronous publications", async () => {
  class Writer extends ProcessExecutionAtomicEventWriter {
    constructor(asynchronous) { super(); this.asynchronous = asynchronous; }
    writeGroup(group) {
      const publications = group.events.map((entry) => ProcessExecutionCanonicalAcknowledgement.fromEvent(entry));
      return this.asynchronous ? Promise.resolve(publications) : publications;
    }
  }
  const first = event();
  for (const asynchronous of [false, true]) {
    const publication = await new Writer(asynchronous).write(first);
    assert.equal(publication.matches(first), true);
  }
  assert.throws(() => new ProcessExecutionAtomicEventWriter(), TypeError);
});
