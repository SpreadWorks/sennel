import assert from "node:assert/strict";
import test from "node:test";
import { FlowExecutionError } from "../../src/flow/engine/flow-execution-error.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../src/flow/engine/step-output.js";

test("StepOutput accepts each non-error result with one argument", () => {
  for (const type of [
    STEP_OUTPUT_TYPE.COMPLETED,
    STEP_OUTPUT_TYPE.BRANCH_REQUIRED,
    STEP_OUTPUT_TYPE.LOOP_REQUIRED,
    STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED,
  ]) {
    const output = new StepOutput(type);
    assert.equal(output.type, type);
    assert.equal(output.error, null);
    assert.deepEqual(StepOutput.fromStored(output.toJSON()).toJSON(), { type });
  }
  assert.throws(() => new StepOutput(STEP_OUTPUT_TYPE.ERROR), TypeError);
  assert.throws(() => new StepOutput(STEP_OUTPUT_TYPE.COMPLETED, new Error("unexpected")), TypeError);
});

test("StepOutput preserves an ordinary Error as an ordinary Error after readback", () => {
  const source = new Error("provider failed");
  const output = new StepOutput(source);
  assert.equal(output.type, STEP_OUTPUT_TYPE.ERROR);
  assert.notEqual(output.error, source);
  assert.equal(output.error.message, source.message);
  source.message = "changed later";
  assert.equal(output.error.message, "provider failed");
  assert.deepEqual(output.toJSON(), {
    type: STEP_OUTPUT_TYPE.ERROR,
    error: { kind: "generic", message: "provider failed" },
  });

  const restored = StepOutput.fromStored(output.toJSON());
  assert.equal(restored.type, STEP_OUTPUT_TYPE.ERROR);
  assert.equal(restored.error instanceof Error, true);
  assert.equal(restored.error instanceof FlowExecutionError, false);
  assert.equal(restored.error.message, "provider failed");
});

test("StepOutput preserves Flow-specific error information after readback", () => {
  const cause = new Error("worker timed out");
  const error = new FlowExecutionError({
    code: "STEP_TIMEOUT",
    message: "Draft review timed out",
    runId: "run-7",
    stepId: "draft-questions-review",
    attemptId: "attempt-2",
    cause,
  });
  const output = new StepOutput(error);
  assert.equal(output.type, STEP_OUTPUT_TYPE.ERROR);
  assert.equal(output.error, error);
  assert.equal(output.error.cause, cause);
  assert.deepEqual(output.toJSON(), {
    type: STEP_OUTPUT_TYPE.ERROR,
    error: {
      kind: "flow",
      code: "STEP_TIMEOUT",
      message: "Draft review timed out",
      runId: "run-7",
      stepId: "draft-questions-review",
      attemptId: "attempt-2",
    },
  });

  const restored = StepOutput.fromStored(output.toJSON());
  assert.equal(restored.error instanceof FlowExecutionError, true);
  assert.equal(restored.error.code, "STEP_TIMEOUT");
  assert.equal(restored.error.runId, "run-7");
  assert.equal(restored.error.stepId, "draft-questions-review");
  assert.equal(restored.error.attemptId, "attempt-2");
  assert.equal(restored.error.cause, undefined);
});

test("StepOutput rejects malformed stored error distinctions", () => {
  assert.throws(() => StepOutput.fromStored({
    type: STEP_OUTPUT_TYPE.ERROR,
    error: { kind: "flow", code: "STEP_TIMEOUT", message: "timed out" },
  }), TypeError);
  assert.throws(() => StepOutput.fromStored({
    type: STEP_OUTPUT_TYPE.ERROR,
    error: { kind: "generic", message: "failed", runId: "run-7" },
  }), TypeError);
});
