import assert from "node:assert/strict";
import { test } from "node:test";
import GetRuntimeLogCommand from "../../../src/flow/lib/get-runtime-log.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { RuntimeLogBlockWriter, RuntimeLogFile } from "../../../src/lib/runtime-log.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function captureExecution(ctx) {
  const write = process.stdout.write;
  const previousExitCode = process.exitCode;
  let stdout = "";
  try {
    process.stdout.write = (value) => { stdout += value; return true; };
    const result = new GetRuntimeLogCommand().execute(ctx);
    return { result, stdout, exitCode: process.exitCode, previousExitCode };
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExitCode;
  }
}

function setup(t) {
  const root = createTmpDir("runtime-log-result-");
  t.after(() => removeTmpDir(root));
  const fixture = new CanonicalFlowFixture({ flowManager: makeFlowManager(root),
    specId: "runtime-log-result", runId: "runtime-log-result-run" }).create().registerActive();
  const state = fixture.state();
  const binding = FlowTargetBinding.captureContext({ root, mainRoot: root, executionRoot: root, flowState: state });
  return { fixture, ctx: { root, mainRoot: root, executionRoot: root, flowState: state, expectBinding: binding.serialize() } };
}

test("runtime-log JSON success returns an unpublished Envelope and text success retains exact stdout", (t) => {
  const { fixture, ctx } = setup(t);
  const stateBefore = JSON.stringify(fixture.state());
  const writer = new RuntimeLogBlockWriter({ root: ctx.root, flowId: ctx.flowState.specId,
    runId: ctx.flowState.runId, command: "flow run gate" });
  writer.capture("stdout", "runtime log producer detail\n");
  writer.close(3);
  const file = new RuntimeLogFile(ctx.root, ctx.flowState.specId);
  const expectedText = file.read().trimEnd();
  const json = captureExecution({ ...ctx, format: "json" });
  assert.ok(json.result instanceof Envelope);
  assert.equal(json.result.ok, true);
  assert.equal(json.result.data.text, expectedText);
  assert.equal(json.result.data.exitCode, 3);
  assert.equal(json.stdout, "");
  assert.equal(json.exitCode, json.previousExitCode);
  const text = captureExecution(ctx);
  assert.equal(text.result, undefined);
  assert.equal(text.stdout, `${expectedText}\n`);
  assert.equal(text.exitCode, text.previousExitCode);
  assert.equal(file.read().trimEnd(), expectedText);
  assert.equal(JSON.stringify(fixture.state()), stateBefore);
});

test("runtime-log refusals and argument failures return their Envelope without publishing or setting global exit", (t) => {
  const { fixture, ctx } = setup(t);
  const stateBefore = JSON.stringify(fixture.state());
  const resolutionData = { expectedRunId: "missing-run", activeRunId: ctx.flowState.runId };
  const cases = [
    [{ ...ctx, expectBinding: undefined }, "ARGS_ERROR"],
    [{ ...ctx, flowResolutionError: { code: "FLOW_TARGET_NOT_FOUND", message: "Selected target was not found.", data: resolutionData } }, "FLOW_TARGET_NOT_FOUND"],
    [{ ...ctx, flowState: null }, "FLOW_TARGET_NOT_FOUND"],
    [{ ...ctx, expectBinding: undefined, expectRunId: "other-run" }, "ACTIVE_FLOW_MISMATCH"],
    [{ ...ctx, format: "xml" }, "INVALID_ARG_VALUE"],
    [{ ...ctx, sequence: "0" }, "INVALID_ARG_VALUE"],
    [{ ...ctx, format: "json" }, "RUNTIME_LOG_NOT_FOUND"],
  ];
  for (const [input, code] of cases) {
    const observed = captureExecution(input);
    assert.ok(observed.result instanceof Envelope, code);
    assert.equal(observed.result.ok, false, code);
    assert.equal(observed.result.errors[0].code, code);
    assert.equal(observed.stdout, "", code);
    assert.equal(observed.exitCode, observed.previousExitCode, code);
    if (input.flowResolutionError) assert.deepEqual(observed.result.data, resolutionData);
  }
  assert.equal(JSON.stringify(fixture.state()), stateBefore);
});
