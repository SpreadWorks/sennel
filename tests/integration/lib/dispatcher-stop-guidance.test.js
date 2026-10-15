import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Container } from "../../../src/lib/container.js";
import { Command } from "../../../src/lib/command.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { RuntimeLogBlockWriter } from "../../../src/lib/runtime-log.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { dispatchContainer, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { ProcessRuntimeFlowScenario } from "../../support/infrastructure/process-runtime-flow-scenario.js";
import { CurrentFlowPolicy } from "../../../src/flow/lib/current-flow-state.js";
import { ExecuteContinuationDirective, ExecuteStepDirective, NextActionDirective } from "../../../src/flow/lib/next-action-directive.js";
import { FlowContinuation, UserActionPrompt } from "../../../src/flow/lib/user-action-prompt.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchBoundary } from "../../../src/flow/lib/run-dispatch.js";
import { FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { DefinitionFailureOwnership } from "../../../src/flow/lib/definition-failure-ownership.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";

function fixture(t) {
  const root = createTmpDir("sennel-stop-guidance-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const container = new Container();
  container.register("config", {});
  container.register("paths", { root, agentWorkDir: path.join(root, ".agent-work") });
  return { container, root };
}

async function run(t, { execute, metadata, pre, post, nonblockingPost, onError, finally: finalHook, context,
  outputMode = "envelope", envelopeKey = "stop-subject", failureOwnership } = {}) {
  const { container, root } = fixture(t);
  class Subject extends Command {
    static outputMode = outputMode;
    execute() { return execute?.() ?? { done: true }; }
  }
  const output = [];
  let exitCode;
  const events = [];
  await dispatch({
    container, argv: [], envelopeType: "run", envelopeKey, runtimeLog: true,
    entry: { command: async () => ({ default: Subject }), args: {}, requiresFlow: false,
      runtimeLog: { stepId: "draft" }, pre, post, nonblockingPost, onError, finally: finalHook, failureOwnership },
    buildHookCtx: context ?? (() => ({ root, specId: "stop-subject", flowState: { runId: "run-subject" },
      flowManager: { setStepRuntimeLog() { events.push("metadata"); metadata?.(); } } })),
    stdout: (chunk) => { events.push("stdout"); output.push(chunk); },
    stderr: () => {}, setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(output.length, 1, "one final JSON publication");
  return { envelope: JSON.parse(output[0]), exitCode, events };
}

function assertGuidance(envelope) {
  assert.equal(typeof envelope.guidance.explanation, "string");
  assert.ok(envelope.guidance.explanation.length > 0);
  assert.equal(typeof envelope.guidance.currentState, "object");
  assert.equal(typeof envelope.guidance.nextAction.instruction, "string");
  assert.ok(envelope.guidance.nextAction.instruction.length > 0);
  assert.ok(envelope.data.directive);
}

test("raw Flow failed returns use the common boundary after metadata and final hooks", async (t) => {
  const effects = [];
  const result = await run(t, { outputMode: "raw",
    execute: () => Envelope.fail("run", "stop-subject", "RAW_REFUSAL", "The raw operation was refused."),
    post() { effects.push("post"); }, finally() { effects.push("finally"); } });
  assert.equal(result.envelope.errors[0].code, "RAW_REFUSAL");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(effects, ["finally"]);
  assert.deepEqual(result.events, ["metadata", "stdout"]);
  assertGuidance(result.envelope);
});

test("raw Flow candidate text cannot precede a later post-hook failure response", async (t) => {
  const result = await run(t, { outputMode: "raw",
    execute() { process.stdout.write("candidate text"); },
    post() { throw new Error("post hook failed after raw output"); } });
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.errors[0].code, "POST_HOOK_FAILED");
  assert.equal(result.exitCode, 1);
  assertGuidance(result.envelope);
});

test("successful raw Flow text preserves its bytes and follows final hooks", async (t) => {
  const { container } = fixture(t);
  const events = [];
  class TextCommand extends Command {
    static outputMode = "raw";
    execute() { process.stdout.write(Buffer.from("result 😀\n")); }
  }
  let text;
  await dispatch({ container, entry: { command: async () => ({ default: TextCommand }), args: {}, requiresFlow: false,
    post() { events.push("post"); }, finally() { events.push("finally"); } },
    argv: [], envelopeType: "get", envelopeKey: "text", stdout(chunk) { events.push("stdout"); text = chunk; },
    setExitCode(code) { assert.equal(code, 0); } });
  assert.deepEqual(text, Buffer.from("result 😀\n"));
  assert.deepEqual(events, ["post", "finally", "stdout"]);
});

test("metadata rejection is included before the sole final JSON instead of following a success JSON", async (t) => {
  const result = await run(t, { metadata() { throw new Error("metadata is not durable"); } });
  assert.equal(result.envelope.ok, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.envelope.errors.some((error) => error.code === "RUNTIME_LOG_METADATA_FAILED"));
  assert.deepEqual(result.events, ["metadata", "stdout"]);
  assertGuidance(result.envelope);
});

test("the initial rejection survives a later metadata failure in the same final response", async (t) => {
  const result = await run(t, {
    execute: () => Envelope.fail("run", "stop-subject", "WORK_REJECTED", "work was rejected"),
    metadata() { throw new Error("metadata failed later"); },
  });
  assert.equal(result.envelope.ok, false);
  assert.deepEqual(result.envelope.errors.map((error) => error.code), ["WORK_REJECTED", "RUNTIME_LOG_METADATA_FAILED"]);
  assertGuidance(result.envelope);
});

test("log close failure preserves an execution failure and cannot publish a second JSON", async (t) => {
  const original = RuntimeLogBlockWriter.prototype.close;
  t.mock.method(RuntimeLogBlockWriter.prototype, "close", function (code) {
    original.call(this, code);
    throw new Error("log close failed");
  });
  const result = await run(t, { execute() { throw Object.assign(new Error("work failed"), { code: "WORK_FAILED" }); } });
  assert.deepEqual(result.envelope.errors.map((error) => error.code), ["WORK_FAILED", "RUNTIME_LOG_CLOSE_FAILED"]);
  assert.equal(result.exitCode, 1);
  assertGuidance(result.envelope);
});

test("warning with nonzero exit carries guidance while preserving successful command status", async (t) => {
  const result = await run(t, { post() { throw new Error("post could not finish"); } });
  assert.equal(result.envelope.ok, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.errors[0].code, "POST_HOOK_FAILED");
  assertGuidance(result.envelope);
});

test("onError and finally failures are related to the original exception", async (t) => {
  const events = [];
  const result = await run(t, {
    execute() { throw Object.assign(new Error("original failure"), { code: "WORK_FAILED" }); },
    onError() { events.push("onError"); throw new Error("onError failed"); },
    finally() { events.push("finally"); throw new Error("finally failed"); },
  });
  assert.deepEqual(events, ["onError", "finally"]);
  assert.deepEqual(result.envelope.errors.map((error) => error.code), ["WORK_FAILED", "ON_ERROR_HOOK_FAILED", "FINALLY_HOOK_FAILED"]);
  assertGuidance(result.envelope);
});

for (const physical of [false, true]) {
  test(`candidate retention preserves a returned refusal through ${physical ? "physical" : "ordinary"} onError failure`, async (t) => {
    const failure = physical
      ? new ProcessExecutionControlFailure("stop-unconfirmed", "Physical stop could not be confirmed.")
      : new Error("Failure recording failed.");
    const effects = [];
    let selected;
    let binding;
    const result = await run(t, { context(container) {
      const root = container.get("paths").root;
      const state = nonblockingState();
      const ctx = { root, mainRoot: root, executionRoot: root, flowState: state,
        flowOutboxEntry: { status: "pending" } };
      binding = FlowTargetBinding.captureContext(ctx, state);
      selected = new ExecuteStepDirective({ action: "run-selected",
        nextAction: binding.guardCommand("sennel flow run selected") });
      return ctx;
    }, execute: () => Envelope.fail("run", "stop-subject", "INITIAL_REFUSAL", "The command refused the operation.",
      { directive: selected, binding: binding.serialize(), retained: "initial refusal" }),
    onError() { effects.push("onError"); throw failure; },
    finally() { effects.push("finally"); throw new Error("Final cleanup failed."); } });
    assert.deepEqual(effects, ["onError", "finally"]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.envelope.ok, false);
    assert.deepEqual(new Set(result.envelope.errors.map((entry) => entry.code)),
      new Set(["INITIAL_REFUSAL", physical ? failure.code : "ON_ERROR_HOOK_FAILED", "FINALLY_HOOK_FAILED"]));
    assert.deepEqual(result.envelope.data.directive, selected.toJSON());
    assert.equal(result.envelope.data.binding, binding.serialize());
    assert.equal(result.envelope.data.retained, "initial refusal");
    if (physical) assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(result.envelope).toJSON(), failure.toJSON());
    assertGuidance(result.envelope);
  });
}

test("candidate retention preserves successful command data through a physical post failure", async (t) => {
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Post-hook physical stop could not be confirmed.");
  const selected = new ExecuteStepDirective({ action: "run-selected", nextAction: "sennel flow run selected" });
  const commandResult = { directive: selected, retained: "command result" };
  let finalized = false;
  const result = await run(t, { execute: () => commandResult,
    post(_ctx, received) { assert.equal(received, commandResult); throw failure; },
    finally() { finalized = true; } });
  assert.equal(finalized, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.data.retained, "command result");
  assert.deepEqual(result.envelope.data.directive, selected.toJSON());
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(result.envelope).toJSON(), failure.toJSON());
  assertGuidance(result.envelope);
});

test("candidate retention adopts post replacement data before a physical nonblocking failure while retaining prior causes", async (t) => {
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Evidence recording could not confirm physical stop.");
  const selected = new ExecuteStepDirective({ action: "run-post-selected", nextAction: "sennel flow run post-selected" });
  const commandResult = Envelope.warn("run", "stop-subject", { retained: "command projection" }, "COMMAND_WARNING", "Command warning.");
  const result = await run(t, { execute: () => commandResult,
    post(_ctx, received) {
      assert.equal(received, commandResult);
      return Envelope.fail("run", "stop-subject", "POST_PROJECTION", "Post selected a refusal.",
        { directive: selected, retained: "post projection" });
    }, nonblockingPost(_ctx, received) { assert.equal(received, commandResult); throw failure; },
    finally() { throw new Error("Final cleanup failed."); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.deepEqual(new Set(result.envelope.errors.map((entry) => entry.code)),
    new Set(["COMMAND_WARNING", "POST_PROJECTION", failure.code, "FINALLY_HOOK_FAILED"]));
  assert.equal(result.envelope.data.retained, "post projection");
  assert.deepEqual(result.envelope.data.directive, selected.toJSON());
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(result.envelope).toJSON(), failure.toJSON());
  assertGuidance(result.envelope);
});

test("publication invariant suppresses metadata and preserves canonical evidence after physical lifecycle persistence refusal", async (t) => {
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Lifecycle save could not confirm physical stop.");
  let manager;
  let stateBefore;
  let activitiesBefore;
  let metadataWrites = 0;
  let writes = 0;
  const result = await run(t, { envelopeKey: "test-execute", failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
    context(container) {
      const root = container.get("paths").root;
      const specId = "001-lifecycle-retention";
      manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-lifecycle-retention",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("test-execute");
      stateBefore = manager.canonicalState(specId).toJSON();
      activitiesBefore = manager.activityLedger(specId);
      t.mock.method(manager, "failCurrentAttemptIfCurrent", () => { writes += 1; throw failure; });
      const setStepRuntimeLog = manager.setStepRuntimeLog.bind(manager);
      t.mock.method(manager, "setStepRuntimeLog", (...args) => { metadataWrites += 1; return setStepRuntimeLog(...args); });
      return { root, mainRoot: root, executionRoot: root, flowManager: manager, specId,
        flowState: manager.loadReadOnly(specId), flowResolutionError: null };
    }, execute: () => ({ retained: "command result" }),
    post() { throw new Error("Post hook failed."); } });
  assert.equal(writes, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.ok(result.envelope.errors.some((entry) => entry.code === "POST_HOOK_FAILED"));
  assert.equal(metadataWrites, 0, "physical refusal suppresses later canonical runtime metadata writes");
  assert.equal(result.envelope.data.retained, "command result");
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(result.envelope).toJSON(), failure.toJSON());
  const reloaded = new FlowManager({ root: manager.executionRoot(), mainRoot: manager.executionRoot(),
    inWorktree: false, specId: "001-lifecycle-retention" });
  assert.deepEqual(reloaded.canonicalState("001-lifecycle-retention").toJSON(), stateBefore);
  assert.deepEqual(reloaded.activityLedger("001-lifecycle-retention"), activitiesBefore);
  assertGuidance(result.envelope);
});

test("publication invariant retains distinct physical failures with the same code and reconstructs the latest cause", async (t) => {
  const initial = new ProcessExecutionControlFailure("stop-unconfirmed", "Command stop could not be confirmed.");
  const final = new ProcessExecutionControlFailure("stop-unconfirmed", "Final cleanup stop could not be confirmed.");
  const result = await run(t, { execute() { throw initial; }, finally() { throw final; } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.deepEqual(result.envelope.errors.filter((entry) => entry.code === initial.code)
    .map((entry) => entry.messages), [[final.message], [initial.message]]);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(result.envelope).toJSON(), final.toJSON());
  assertGuidance(result.envelope);
});

test("context initialization refusal also receives the common failure response", async (t) => {
  const result = await run(t, { context() { throw Object.assign(new Error("context unavailable"), { code: "CONTEXT_UNAVAILABLE" }); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.errors[0].code, "CONTEXT_UNAVAILABLE");
  assertGuidance(result.envelope);
});

test("native parser failures retain their cause without echoing unlabelled confidential input", async (t) => {
  const result = await run(t, { execute() { JSON.parse("private-unlabelled-input-77d0"); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.guidance.cause.code, "SYNTAX_ERROR");
  assert.doesNotMatch(JSON.stringify(result.envelope), /private-unlabelled-input/);
  assertGuidance(result.envelope);
});

test("hook parser failures withhold native input snippets from warnings and stderr", async (t) => {
  const { container } = fixture(t);
  class Subject extends Command {
    static outputMode = "envelope";
    execute() { return {}; }
  }
  const out = [];
  const err = [];
  await dispatch({ container, argv: [], envelopeType: "run", envelopeKey: "hook-parser",
    entry: { command: async () => ({ default: Subject }), args: {},
      post() { JSON.parse("private-hook-input-77d0"); } },
    stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), setExitCode: () => {},
  });
  const envelope = JSON.parse(out.join(""));
  assert.equal(envelope.errors[0].code, "POST_HOOK_FAILED");
  assert.doesNotMatch(JSON.stringify(envelope) + err.join(""), /private-hook-input/);
  assertGuidance(envelope);
});

test("envelope commands keep incidental stdout inside diagnostics before the single publication", async (t) => {
  const { container } = fixture(t);
  const output = [];
  t.mock.method(process.stdout, "write", (chunk) => { output.push(String(chunk)); return true; });
  class Subject extends Command {
    static outputMode = "envelope";
    execute() {
      process.stdout.write("incidental command output\n");
      return Envelope.fail("run", "stdout-subject", "WORK_REJECTED", "Work stopped.");
    }
  }
  await dispatch({ container, argv: [], envelopeType: "run", envelopeKey: "stdout-subject",
    entry: { command: async () => ({ default: Subject }), args: {} }, setExitCode: () => {},
  });
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).errors[0].code, "WORK_REJECTED");
});

test("stdout delivery failure never retries JSON or hides a second write in stderr", async (t) => {
  const { container } = fixture(t);
  class Subject extends Command {
    static outputMode = "envelope";
    execute() { return { done: true }; }
  }
  let writes = 0;
  let exitCode;
  const stderr = [];
  await dispatch({ container, argv: [], envelopeType: "get", envelopeKey: "status",
    entry: { command: async () => ({ default: Subject }), args: {}, requiresFlow: false },
    stdout() { writes += 1; throw Object.assign(new Error("pipe closed"), { code: "EPIPE" }); },
    stderr: (text) => stderr.push(text), setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(writes, 1);
  assert.equal(exitCode, 1);
  assert.match(stderr.join(""), /STDOUT_DELIVERY_FAILED/);
  assert.doesNotMatch(stderr.join(""), /"ok"\s*:/);
});

test("physical runtime close failure preserves its typed refusal and the original command cause", async (t) => {
  const seed = fixtureRepository("sennel-stop-runtime-seed-");
  t.after(() => fs.rmSync(seed, { recursive: true, force: true }));
  fs.mkdirSync(path.join(seed, ".sennel"), { recursive: true });
  const scenario = new ProcessRuntimeFlowScenario(seed, { test: t });
  const manager = scenario.manager();
  const originalClose = ProcessExecutionRuntime.prototype.close;
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Runtime closure confirmation is unavailable.");
  t.mock.method(ProcessExecutionRuntime.prototype, "close", async function () {
    await originalClose.call(this);
    throw failure;
  });
  class Subject extends Command {
    static outputMode = "envelope";
    execute() { throw Object.assign(new Error("The command failed first."), { code: "WORK_FAILED" }); }
  }
  const output = [];
  let exitCode;
  await dispatch({ container: dispatchContainer({ root: scenario.root, flowManager: manager, agent: null }),
    entry: { command: async () => ({ default: Subject }), args: {}, runtimeLog: { stepMetadata: false } },
    argv: [], envelopeType: "run", envelopeKey: "physical-close-subject", runtimeLog: true,
    buildHookCtx: () => scenario.context({ flowManager: manager }),
    stdout: (chunk) => output.push(chunk), stderr: () => {}, setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(output.length, 1);
  const envelope = JSON.parse(output[0]);
  assert.equal(exitCode, 1);
  assert.equal(ProcessExecutionControlFailure.fromEnvelope(envelope).code, failure.code);
  assert.deepEqual(envelope.errors.map((entry) => entry.code), [failure.code, "WORK_FAILED"]);
  assert.equal(envelope.guidance.currentState.stop, "unconfirmed");
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: scenario.root }).slot, null);
});

function nonblockingState() {
  return { specId: "001-test", runId: "run-test", issue: null,
    baseBranch: "main", featureBranch: null,
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    policy: new CurrentFlowPolicy({ autoApprove: false, nonblocking: { enabled: true,
      activatedAt: "2026-08-01T00:00:00.000Z", activatedStep: "impl-review",
      reason: "The normal recovery route exhausted its retry budget." } }).toJSON() };
}

test("typed process refusal preserves the guarded nonblocking refresh without a user wait or metadata write", async (t) => {
  const state = nonblockingState();
  const originalState = JSON.stringify(state);
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Runtime closure confirmation is unavailable.");
  let targetContext;
  let metadataWrites = 0;
  const result = await run(t, { execute() { throw failure; }, context(container) {
    const root = container.get("paths").root;
    targetContext = { root, mainRoot: root, executionRoot: root, flowState: state,
      flowResolutionError: null, flowManager: { setStepRuntimeLog() { metadataWrites += 1; } } };
    return targetContext;
  } });
  const directive = NextActionDirective.fromStored(result.envelope.data.directive);
  assert.ok(directive instanceof ExecuteContinuationDirective);
  assert.ok(directive.continuation instanceof FlowContinuation);
  assert.equal(directive.continuation.actionId, "REFRESH_NONBLOCKING_FLOW");
  const binding = FlowTargetBinding.captureContext(targetContext, state);
  assert.equal(directive.continuation.nextAction, binding.guardCommand("sennel flow get next-action"));
  assert.equal(directive.requiresUserAction, false);
  assert.equal(result.envelope.guidance.nextAction.kind, "automatic");
  const restoredFailure = ProcessExecutionControlFailure.fromEnvelope(result.envelope);
  assert.equal(restoredFailure.code, failure.code);
  assert.equal(restoredFailure.message, failure.message);
  assert.equal(result.exitCode, 1);
  assert.equal(metadataWrites, 0);
  assert.equal(JSON.stringify(state), originalState);
});

test("later process refusal retains an existing nested approval directive without a competing nonblocking refresh", async (t) => {
  const state = nonblockingState();
  const originalState = JSON.stringify(state);
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "Runtime closure confirmation is unavailable.");
  let selected;
  let binding;
  const result = await run(t, { context(container) {
    const root = container.get("paths").root;
    const ctx = { root, mainRoot: root, executionRoot: root, flowState: state,
      flowResolutionError: null, flowManager: {} };
    binding = FlowTargetBinding.captureContext(ctx, state);
    const command = binding.guardCommand("sennel flow run selected");
    selected = new ExecuteStepDirective({ action: "run-selected", nextAction: command,
      actionPrompt: new UserActionPrompt({ question: "Continue the selected operation or abort?",
        choices: [{ actionId: "CONTINUE_SELECTED", label: "Continue", nextAction: command, impact: { changes: ["selected operation"] } },
          { actionId: "ABORT_SELECTED", label: "Abort", nextAction: binding.guardCommand("sennel flow run abort"), impact: { changes: ["Flow lifecycle"] } }],
        recommendedActionId: "CONTINUE_SELECTED", recommendationReason: "Continue the requested operation." }) });
    return ctx;
  }, execute() {
    const target = new FlowDispatchTarget({ expectation: new FlowTargetExpectation({ expectBinding: binding.serialize() }), binding });
    return new FlowDispatchBoundary({ kind: "approval_required", target, dispatchCount: 1,
      approvalToken: "original-approval-token", nextAction: { step: "approval", directive: selected } }).toJSON();
  }, finally() { throw failure; } });
  const directive = NextActionDirective.fromStored(result.envelope.data.directive);
  assert.ok(directive instanceof ExecuteStepDirective);
  assert.deepEqual(directive.toJSON(), selected.toJSON());
  assert.equal(directive.nextAction, binding.guardCommand("sennel flow run selected"));
  assert.equal(result.envelope.data.dispatch.binding, binding.serialize());
  assert.equal(result.envelope.data.dispatch.approvalToken, "original-approval-token");
  assert.equal(result.envelope.data.nextAction.step, "approval");
  assert.equal(Object.hasOwn(result.envelope.data.nextAction, "directive"), false);
  assert.equal(Object.hasOwn(result.envelope.data, "continuation"), false);
  assert.equal(Object.hasOwn(result.envelope.data, "actionPrompt"), false);
  assert.equal(result.envelope.guidance.nextAction.kind, "user_decision");
  const restoredFailure = ProcessExecutionControlFailure.fromEnvelope(result.envelope);
  assert.equal(restoredFailure.code, failure.code);
  assert.equal(restoredFailure.message, failure.message);
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.stringify(state), originalState);
});
