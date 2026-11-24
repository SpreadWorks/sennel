import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionCapturedInvocation } from "../../src/lib/process-execution-invocation.js";
import { ProcessExecutionInvocationDisclosure, executionValueDigest } from "../../src/lib/process-execution-values.js";

test("capture retains normalized private identity and immutable public metadata across caller mutations", () => {
  const input = { kind: "command", observationBinding: { specId: "original" },
    providerAttemptContext: { attemptId: "attempt", inputCharacters: NaN, omitted: undefined },
    launch: { executable: "node", args: ["private-argument"], env: { NODE_OPTIONS: "--import=data:private-bootstrap" } } };
  const normalized = JSON.parse(JSON.stringify(input));
  let snapshots = 0;
  const disclosure = ProcessExecutionInvocationDisclosure.capture({ toJSON() { snapshots++; return input; } });
  assert.equal(snapshots, 1);
  assert.equal(disclosure.invocationDigest, executionValueDigest(normalized));
  assert.equal(disclosure.matchesPrivate(normalized), true);
  assert.equal(Object.isFrozen(disclosure.invocation), true);
  assert.equal(Object.isFrozen(disclosure.invocation.observationBinding), true);
  assert.equal(Object.isFrozen(disclosure.invocation.executionIdentity.nodeImportDigests), true);
  const restored = new ProcessExecutionInvocationDisclosure(disclosure.toJSON());
  assert.deepEqual(restored.toJSON(), disclosure.toJSON());
  assert.notEqual(restored.invocation, disclosure.invocation);
  assert.notEqual(restored.invocation.observationBinding, disclosure.invocation.observationBinding);
  input.observationBinding.specId = "changed";
  input.launch.args[0] = "changed-private-argument";
  assert.equal(disclosure.invocation.observationBinding.specId, "original");
  assert.equal(disclosure.matchesPrivate(input), false);
  assert.equal(JSON.stringify(disclosure).includes("private-argument"), false);
  assert.equal(JSON.stringify(disclosure).includes("private-bootstrap"), false);
  assert.deepEqual(ProcessExecutionInvocationDisclosure.capture(undefined).toJSON(), ProcessExecutionInvocationDisclosure.capture(null).toJSON());
});

test("public disclosure construction cannot forge capture authority or bypass stored metadata validation", () => {
  const disclosure = ProcessExecutionInvocationDisclosure.capture({ kind: "command", providerAttemptContext: { attemptId: "attempt" } });
  const fabricated = Object.assign(Object.create(Object.getPrototypeOf(disclosure.invocation)),
    disclosure.invocation.toJSON(), { launch: { env: { SECRET: "private" } } });
  for (const authority of [undefined, Symbol("captured invocation metadata"), disclosure.invocation, Object.getPrototypeOf(disclosure.invocation)]) {
    assert.throws(() => new ProcessExecutionInvocationDisclosure({ invocation: fabricated, invocationDigest: disclosure.invocationDigest }, authority),
      { name: "TypeError", message: "Public invocation metadata has unknown or private fields" });
  }
  assert.throws(() => new ProcessExecutionInvocationDisclosure({ invocation: null, invocationDigest: "invalid" }, Symbol()),
    { name: "TypeError", message: "Invocation digest is invalid" });
  assert.throws(() => ProcessExecutionInvocationDisclosure.capture({ kind: { private: true } }),
    { name: "TypeError", message: "Public invocation kind must be scalar metadata" });
  const stored = disclosure.toJSON();
  stored.invocation.providerAttemptContext.invocation = { args: ["private"] };
  assert.throws(() => ProcessExecutionInvocationDisclosure.fromStored(stored),
    { name: "TypeError", message: "Public invocation metadata has unknown or private fields" });
});


test("captured invocation factory reuses only its exact owned immutable value", () => {
  const input = { kind: "command", observationBinding: { specId: "original" },
    launch: { executable: "node", args: ["private-argument"], env: { NODE_OPTIONS: "--import=data:private-bootstrap" } } };
  let snapshots = 0;
  const captured = ProcessExecutionCapturedInvocation.capture({ toJSON() { snapshots++; return input; } });
  assert.equal(snapshots, 1);
  const expected = JSON.parse(JSON.stringify(input));
  assert.notEqual(captured.value, input);
  assert.deepEqual(captured.value, expected);
  assert.equal(captured.digest, executionValueDigest(expected));
  assert.equal(captured.text(), JSON.stringify(expected));
  for (let index = 0; index < 10; index++) {
    assert.equal(ProcessExecutionCapturedInvocation.capture(captured.value), captured);
    assert.equal(ProcessExecutionInvocationDisclosure.capture(captured.value), captured.disclosure);
    assert.equal(captured.matches(captured.value), true);
  }
  assert.equal(snapshots, 1);
  input.observationBinding.specId = "changed";
  input.launch.args[0] = "changed-private-argument";
  assert.deepEqual(captured.value, expected);
  assert.equal(captured.matches(input), false);
  assert.equal(JSON.stringify(captured.disclosure).includes("private-argument"), false);
  assert.equal(JSON.stringify(captured.disclosure).includes("private-bootstrap"), false);
});

test("captured invocation factory does not borrow frozen unknown inputs or cache their serializers", () => {
  const input = Object.freeze({ kind: "command", providerAttemptContext: { attemptId: "first" } });
  const first = ProcessExecutionCapturedInvocation.capture(input);
  const second = ProcessExecutionCapturedInvocation.capture(input);
  assert.notEqual(first, second);
  assert.notEqual(first.value, input);
  assert.notEqual(first.value, second.value);
  assert.equal(first.matches(input), true);
  input.providerAttemptContext.attemptId = "second";
  assert.equal(first.value.providerAttemptContext.attemptId, "first");
  assert.equal(first.matches(input), false);
  const later = ProcessExecutionCapturedInvocation.capture(input);
  assert.equal(later.value.providerAttemptContext.attemptId, "second");
  let snapshots = 0;
  const serialized = { toJSON() { snapshots++; return { kind: "command", providerAttemptContext: { attemptId: "first" } }; } };
  assert.equal(first.matches(serialized), true);
  assert.equal(first.matches(serialized), true);
  assert.equal(snapshots, 2);
  assert.equal(first.matches({ providerAttemptContext: { attemptId: "first" }, kind: "command" }), false);
});

test("captured invocation factory preserves scalar normalization and exact byte matching", () => {
  for (const input of [null, undefined]) {
    const captured = ProcessExecutionCapturedInvocation.capture(input);
    assert.equal(captured.value, null);
    assert.equal(captured.text(), "null");
    assert.equal(captured.matches(null), true);
    assert.deepEqual(captured.disclosure.toJSON(), ProcessExecutionInvocationDisclosure.capture(null).toJSON());
  }
  const captured = ProcessExecutionCapturedInvocation.capture({ kind: "command", measurementId: "value" });
  assert.equal(captured.matches(JSON.parse(captured.text())), true);
  assert.equal(captured.matches({ measurementId: "value", kind: "command" }), false);
  assert.throws(() => captured.matches(undefined), { name: "TypeError", message: "Execution value has no JSON representation" });
});
