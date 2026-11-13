import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionBinding } from "../../src/lib/process-execution-values.js";

test("binding reuse retains a genuine immutable instance while construction and JSON projection remain independent snapshots", () => {
  const raw = { run: "first", nested: { attempt: 1 } };
  const binding = ProcessExecutionBinding.from(raw);
  raw.nested.attempt = 2;
  assert.deepEqual(binding.toJSON(), { run: "first", nested: { attempt: 1 } });
  assert.equal(ProcessExecutionBinding.from(binding), binding);
  assert.notEqual(new ProcessExecutionBinding(binding), binding);
  const projection = binding.toJSON(); projection.nested.attempt = 3;
  assert.deepEqual(binding.toJSON(), { run: "first", nested: { attempt: 1 } });
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.value.nested));
  assert.equal(ProcessExecutionBinding.from(null).value, null);
});

test("binding factory snapshots subclasses, proxies and forged prototypes instead of trusting instanceof", () => {
  class OtherBinding extends ProcessExecutionBinding {}
  const subtype = new OtherBinding({ kind: "subtype" });
  const nominal = new ProcessExecutionBinding({ kind: "nominal" });
  const proxy = new Proxy(nominal, {});
  const forged = Object.create(ProcessExecutionBinding.prototype);
  forged.value = { nested: { revision: 1 } };
  for (const value of [subtype, proxy, forged]) {
    const first = ProcessExecutionBinding.from(value), second = ProcessExecutionBinding.from(value);
    assert.notEqual(first, value); assert.notEqual(first, second);
    assert.equal(Object.getPrototypeOf(first), ProcessExecutionBinding.prototype);
    assert.deepEqual(first.toJSON(), value.toJSON());
  }
  const captured = ProcessExecutionBinding.from(forged);
  forged.value.nested.revision = 2;
  assert.deepEqual(captured.toJSON(), { nested: { revision: 1 } });
  assert.deepEqual(ProcessExecutionBinding.from(forged).toJSON(), { nested: { revision: 2 } });
});
