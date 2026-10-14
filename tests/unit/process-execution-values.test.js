import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";

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
