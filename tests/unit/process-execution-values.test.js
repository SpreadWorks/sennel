import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProcessExecutionControlFailure, ProcessExecutionNonExecutionEvidence, ProcessExecutionInvocationDisclosure, ProcessExecutionValueEncoding, executionValueDigest } from "../../src/lib/process-execution-values.js";

function envelope() {
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "A descendant has no durable stop receipt");
  return { ok: false, data: { processExecutionControlFailure: failure.toJSON(),
    runtimeLog: { runId: "run", sequence: 1 } }, errors: [{ level: "fatal", code: failure.code }] };
}

test("a typed control failure crosses the error envelope boundary with its exact identity and refusal code", () => {
  const value = envelope(), restored = ProcessExecutionControlFailure.fromEnvelope(value);
  assert.ok(restored instanceof ProcessExecutionControlFailure);
  assert.deepEqual(restored.toJSON(), value.data.processExecutionControlFailure);
  assert.equal(restored.retryable, false);
  assert.equal(ProcessExecutionControlFailure.fromEnvelope({ ...value, ok: true }), null);
  assert.equal(ProcessExecutionControlFailure.fromEnvelope({ ok: false, data: { name: "ordinary failure" } }), null);
});

test("unknown typed failure envelope data is a control refusal rather than an ordinary decoding error", () => {
  const value = envelope(); value.data.processExecutionControlFailure.unknown = true;
  assert.throws(() => ProcessExecutionControlFailure.fromEnvelope(value), (error) => error instanceof ProcessExecutionControlFailure
    && error.code === "PROCESS_EXECUTION_FAILURE_ENVELOPE_INVALID" && error.cause instanceof TypeError);
});

test("a fatal envelope code cannot replace the exact recorded control failure code", () => {
  const value = envelope(); value.errors[0].code = "ORDINARY_COMMAND_FAILURE";
  assert.throws(() => ProcessExecutionControlFailure.fromEnvelope(value), (error) => error instanceof ProcessExecutionControlFailure
    && error.code === "PROCESS_EXECUTION_FAILURE_ENVELOPE_INVALID" && error.retryable === false);
});

test("a process control refusal without its typed payload is rejected before ordinary lifecycle handling", () => {
  const value = envelope(); delete value.data.processExecutionControlFailure;
  assert.throws(() => ProcessExecutionControlFailure.fromEnvelope(value), (error) => error instanceof ProcessExecutionControlFailure
    && error.code === "PROCESS_EXECUTION_FAILURE_ENVELOPE_INVALID" && error.retryable === false);
});


test("saved absence evidence rejects retired stale-owner authority without an explicit closed or exclusive fact", () => {
  const root = path.resolve("evidence-checkout");
  const stored = { schemaVersion: 1, checkoutIdentity: { mainRoot: root, executionRoot: root,
    mainDevice: 1, mainInode: 2, checkoutDevice: 1, checkoutInode: 2 }, binding: { contract: "unclaimed" },
    invocation: null, inventoryDigest: "a".repeat(64), ownerEpoch: 1, reservationBeforeSpawn: true,
    executions: [{ executionId: "b1894b74-e91e-43fa-a967-52d7f9f34a6f", ownerEpoch: 1, authorityState: "stale" }] };
  assert.throws(() => ProcessExecutionNonExecutionEvidence.fromStored(stored), /Non-execution owner authority/);
  for (const authorityState of ["closed", "exclusive"]) {
    const controlled = { ...stored, executions: [{ ...stored.executions[0], authorityState }] };
    assert.deepEqual(ProcessExecutionNonExecutionEvidence.fromStored(controlled).toJSON(), controlled);
  }
});


test("public invocation proofs retain semantic identifiers and exact private digest while excluding launch and nested provider inputs", () => {
  const full = { kind: "command", providerAttemptId: "attempt", logicalInvocationId: "logical",
    actualCommand: { args: ["private-argv"], env: { SECRET: "private-env" } },
    launch: { executable: "node", args: ["private-argv"], env: { NODE_OPTIONS: "--import=data:private-bootstrap", SECRET: "private-env" } },
    providerAttemptContext: { attemptId: "attempt", logicalInvocationId: "logical", attempt: 1, maxAttempts: 2,
      providerKey: "provider", profileKey: "profile", invocation: { args: ["nested-private-argv"], env: { SECRET: "nested-private-env" } } } };
  const before = JSON.stringify(full);
  const disclosure = ProcessExecutionInvocationDisclosure.capture(full);
  assert.equal(disclosure.invocationDigest, executionValueDigest(full));
  assert.equal(disclosure.matchesPrivate(full), true);
  assert.equal(disclosure.invocation.providerAttemptContext.attemptId, "attempt");
  assert.equal(disclosure.invocation.executionIdentity.matchesRuntimeDelivery("node", "--import=data:private-bootstrap"), true);
  assert.equal(disclosure.invocation.executionIdentity.matchesRuntimeDelivery("other", "--import=data:private-bootstrap"), false);
  for (const sentinel of ["private-argv", "private-env", "private-bootstrap"]) assert.equal(JSON.stringify(disclosure).includes(sentinel), false);
  assert.equal(JSON.stringify(full), before);
  const changed = JSON.parse(before); changed.launch.args[0] = "changed-private-input";
  assert.equal(disclosure.matchesPrivate(changed), false);
  assert.deepEqual(ProcessExecutionInvocationDisclosure.capture(changed).invocation.toJSON(), disclosure.invocation.toJSON());
  assert.deepEqual(ProcessExecutionInvocationDisclosure.fromStored(disclosure.toJSON()).toJSON(), disclosure.toJSON());
});

test("stored public invocation proofs reject hidden top-level or nested private data instead of redacting an already signed proof", () => {
  const saved = ProcessExecutionInvocationDisclosure.capture({ kind: "command", providerAttemptContext: { attemptId: "attempt" } }).toJSON();
  for (const mutate of [
    (value) => { value.invocation.actualCommand = { args: ["secret"] }; },
    (value) => { value.invocation.launch = { env: { SECRET: "secret" } }; },
    (value) => { value.invocation.providerAttemptContext.invocation = { args: ["secret"] }; },
    (value) => { value.invocation.providerAttemptContext.attemptId = { env: { SECRET: "secret" } }; },
    (value) => { value.invocationDigest = "invalid"; },
  ]) {
    const changed = JSON.parse(JSON.stringify(saved)); mutate(changed);
    assert.throws(() => ProcessExecutionInvocationDisclosure.fromStored(changed), TypeError);
  }
});


class EncodedExecutionFixture {
  toJSON() { return { text: "日本語", values: [undefined, null], omitted: undefined }; }
}

test("encoded execution values preserve exact normalized JSON bytes and their digest", () => {
  const cases = [
    [null, 'null'],
    [[null, "日本語", 'quote"slash\\line\n'], '[null,"日本語","quote\\"slash\\\\line\\n"]'],
    [{ text: "日本語 😀", omitted: undefined, amount: NaN }, '{"text":"日本語 😀","amount":null}'],
    [new EncodedExecutionFixture(), '{"text":"日本語","values":[null,null]}'],
  ];
  for (const [value, expected] of cases) {
    const encoded = new ProcessExecutionValueEncoding(value);
    assert.equal(encoded.text(), expected);
    assert.equal(encoded.digest, createHash("sha256").update(expected).digest("hex"));
    assert.equal(encoded.digest, executionValueDigest(value));
    assert.equal(Object.isFrozen(encoded), true);
  }
  const source = { text: "original" };
  const encoded = new ProcessExecutionValueEncoding(source);
  source.text = "changed";
  assert.equal(encoded.text(), '{"text":"original"}');
  assert.equal(encoded.digest, createHash("sha256").update('{"text":"original"}').digest("hex"));
  assert.throws(() => new ProcessExecutionValueEncoding(undefined), TypeError);
});
