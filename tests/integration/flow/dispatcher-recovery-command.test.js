import assert from "node:assert/strict";
import { test } from "node:test";
import RunDispatchCommand, { FlowDispatchAction } from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import SetRetryCommand from "../../../src/flow/lib/set-retry.js";
import { ExecuteCommandDirective, NextActionDirective } from "../../../src/flow/lib/next-action-directive.js";
import { FlowExecutionCommand } from "../../../src/flow/lib/flow-execution-command.js";
import { FlowDispatchInvocation, FlowDispatchSession, FlowDispatchTarget,
  UnapprovedFlowDispatchAuthorization } from "../../../src/flow/lib/dispatch-invocation.js";
import { readRetryRecoveryReceipt, retryEvidenceRouteForNode } from "../../../src/flow/lib/retry-recovery.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function context(root, manager, specId) {
  return { root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
    flowState: manager.loadReadOnly(specId), flowCommandBoundary: true };
}

function snapshot(manager, specId) {
  return JSON.stringify({ state: manager.canonicalState(specId).toJSON(),
    activities: manager.activityLedger(specId), catalog: manager.artifactCatalog(specId).toJSON() });
}

function exhaustedRecovery(t) {
  const root = createTmpDir("dispatcher-retry-recovery-");
  t.after(() => removeTmpDir(root));
  const specId = "001-dispatcher-retry-recovery";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "dispatcher-retry-recovery",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft",
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`) }] });
  flow.activate("draft-questions-review");
  const fail = () => manager.failCurrentAttempt({ specId, failure: {
    category: "tooling", code: "AGENT_TIMEOUT", message: "The provider process tree stopped.",
    retryable: true, retryKind: "tooling", agentStopEvidence: AgentProcessStopEvidence.confirmed(),
  } });
  fail();
  const initial = new SetRetryCommand().execute({ ...context(root, manager, specId),
    action: "reset", kind: "review", phase: "draft-questions", yes: true,
    reason: "Record the normal retry baseline before the exhausted recovery." });
  assert.equal(initial.grants[0].operation, "retry_attempt");
  fail();
  assert.notEqual(manager.canonicalState(specId).failureDisposition().operation, "retry");
  // Restart discards the manager used by the producer; all further observations
  // come from persisted state and artifacts.
  const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  return { root, specId, manager: restored, ctx: context(root, restored, specId) };
}

async function selection(value) {
  const binding = FlowTargetBinding.captureContext(value.ctx);
  const target = new FlowDispatchTarget({ binding,
    expectation: new FlowTargetExpectation({ expectBinding: binding.serialize() }) });
  const stored = JSON.parse(JSON.stringify(await new GetNextActionCommand().execute(value.ctx)));
  const next = target.assertNextActionBinding(stored);
  assert.equal(next.directive.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  const session = new FlowDispatchSession({ target });
  const dispatcher = new RunDispatchCommand({ repositoryFingerprint: () => "recovery-command-fingerprint" });
  const identity = dispatcher.captureAction(value.ctx, session, next, 0, "action-capture");
  const invocation = new FlowDispatchInvocation({ session, action: identity,
    authorization: new UnapprovedFlowDispatchAuthorization(identity) });
  return { next, target, invocation };
}

test("Definition retry selection survives reload and executes the actual set registry without a worker", async (t) => {
  const value = exhaustedRecovery(t);
  const before = value.manager.canonicalState(value.specId);
  const { next, target, invocation } = await selection(value);
  const directive = NextActionDirective.fromStored(next.directive);
  assert.equal(directive.command.group, "set");
  assert.equal(directive.command.subcommand, "retry");
  assert.deepEqual(directive.command.args.slice(0, 4), ["reset", "review", "draft-questions", "--reason"]);
  assert.equal(directive.command.args.includes("--agent-work-dir"), false);
  let workerCalls = 0;
  const agent = { async call() { workerCalls += 1; throw new Error("recovery must not start a worker"); } };
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1,
    repositoryFingerprint: () => "recovery-command-fingerprint" });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent });
  const result = await dispatcher.execute({ ...value.ctx, expectRunId: before.runId,
    agentWorkDir: value.root, _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(result.data.dispatch.dispatchCount, 1, JSON.stringify(result));
  assert.equal(workerCalls, 0);
  const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const after = reloaded.canonicalState(value.specId);
  assert.notEqual(after.attempt.id, before.attempt.id);
  assert.equal(after.attempt.failure, null);
  assert.equal(after.attempt.consumption.semantic, before.attempt.consumption.semantic);
  const receipt = readRetryRecoveryReceipt(reloaded, after, retryEvidenceRouteForNode(after, after.attempt.nodeId));
  assert.equal(receipt.reason, directive.command.args[4]);
  assert.equal(receipt.reevaluationCount, 1);
  const subsequent = await new GetNextActionCommand().execute(context(value.root, reloaded, value.specId));
  assert.equal(subsequent.directive.kind, "execute_step");
  const settled = snapshot(reloaded, value.specId);
  await assert.rejects(dispatcher.runDispatcherOwnedRecovery(value.ctx, target, new FlowDispatchAction(next), invocation),
    (error) => error.code === "FLOW_DISPATCH_INVOCATION_STALE");
  assert.equal(snapshot(reloaded, value.specId), settled, "the old Attempt invocation cannot duplicate the recovery receipt");
});

test("structured explicit retry argv preserves Japanese, spaces, quotes and newline through actual registry and receipt", async (t) => {
  const value = exhaustedRecovery(t);
  const reason = "日本語の再試行理由 with spaces 'single' and \"double\"\n次の行も一つの値";
  const binding = FlowTargetBinding.captureContext(value.ctx);
  const command = FlowExecutionCommand.fromStored(JSON.parse(JSON.stringify(new FlowExecutionCommand({
    group: "set", subcommand: "retry", args: ["reset", "review", "draft-questions", "--reason", reason, "--yes"],
  }).bindTarget(binding))));
  const dispatcher = new RunDispatchCommand();
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  const result = await dispatcher.runRegisteredFlowCommand({ ...value.ctx, agentWorkDir: value.root }, null, command);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.type, "set");
  assert.equal(result.key, "retry");
  const manager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const state = manager.canonicalState(value.specId);
  assert.equal(readRetryRecoveryReceipt(manager, state, retryEvidenceRouteForNode(state, state.attempt.nodeId)).reason, reason);
});

test("changed structured command or action identity refuses before registry mutation", async (t) => {
  const value = exhaustedRecovery(t);
  const { next, target, invocation } = await selection(value);
  const directive = NextActionDirective.fromStored(next.directive);
  const fields = { actionId: directive.actionId, command: directive.command,
    instruction: directive.instruction, reason: directive.reason };
  const dispatcher = new RunDispatchCommand();
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  const before = snapshot(value.manager, value.specId);
  for (const replacement of [
    new ExecuteCommandDirective({ ...fields, actionId: "RUN_GATE" }),
    new ExecuteCommandDirective({ ...fields, command: new FlowExecutionCommand({
      group: "run", subcommand: "gate", args: directive.command.args.slice(6),
    }) }),
    new ExecuteCommandDirective({ ...fields, command: new FlowExecutionCommand({
      ...directive.command.toJSON(), args: directive.command.args.map((arg, index) => index === 4 ? "A changed reason is a different selection." : arg),
    }) }),
  ]) {
    await assert.rejects(dispatcher.runDispatcherOwnedRecovery(value.ctx, target,
      new FlowDispatchAction({ ...next, directive: replacement.toJSON() }), invocation),
    (error) => error.code === "FLOW_DISPATCH_INVOCATION_STALE");
    assert.equal(snapshot(value.manager, value.specId), before);
  }
});

test("mutating captured serialized command cannot replace the immutable invocation selection", async (t) => {
  const value = exhaustedRecovery(t);
  const { next, target, invocation } = await selection(value);
  const before = snapshot(value.manager, value.specId);
  // The same caller-owned JSON was supplied when the invocation was captured.
  // Keep the serialized command/display internally consistent, as a real
  // replacement value would be, while attempting to change its selected argv.
  invocation.action.nextAction.directive.command.args[4] = "An altered reason must never reach the recovery receipt.";
  invocation.action.nextAction.directive.nextAction = FlowExecutionCommand.fromStored(
    invocation.action.nextAction.directive.command,
  ).toString();
  next.directive.command.args[4] = invocation.action.nextAction.directive.command.args[4];
  next.directive.nextAction = invocation.action.nextAction.directive.nextAction;
  const dispatcher = new RunDispatchCommand({ repositoryFingerprint: () => "recovery-command-fingerprint" });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  await assert.rejects(dispatcher.runDispatcherOwnedRecovery(value.ctx, target, new FlowDispatchAction(next), invocation),
    (error) => error.code === "FLOW_DISPATCH_INVOCATION_STALE");
  assert.equal(snapshot(value.manager, value.specId), before,
    "rejected replacement cannot reset the Attempt or persist an altered recovery receipt");
});

test("unregistered command and mismatched target refuse without canonical effects", async (t) => {
  const value = exhaustedRecovery(t);
  const dispatcher = new RunDispatchCommand();
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  const before = snapshot(value.manager, value.specId);
  await assert.rejects(dispatcher.runRegisteredFlowCommand(value.ctx, null,
    new FlowExecutionCommand({ group: "run", subcommand: "unregistered-command" })), /not registered/);
  const command = new FlowExecutionCommand({ group: "set", subcommand: "retry",
    args: ["reset", "review", "draft-questions", "--reason", "This is a legal reason attached to the wrong run.", "--yes",
      "--expect-run-id", "different-run", "--expect-spec", value.specId, "--expect-no-issue"] });
  const result = await dispatcher.runRegisteredFlowCommand(value.ctx, null, command);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(["ACTIVE_FLOW_MISMATCH", "FLOW_TARGET_NOT_FOUND"].includes(result.errors[0].code));
  assert.equal(snapshot(value.manager, value.specId), before);
  const emptyReason = FlowExecutionCommand.fromStored(JSON.parse(JSON.stringify(new FlowExecutionCommand({
    group: "set", subcommand: "retry", args: ["reset", "review", "draft-questions", "--reason", "", "--yes"],
  }).bindTarget(FlowTargetBinding.captureContext(value.ctx)))));
  assert.equal(emptyReason.args[4], "", "the value round-trip preserves an empty argv element");
  const emptyResult = await dispatcher.runRegisteredFlowCommand(value.ctx, null, emptyReason);
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.errors[0].code, "ARGS_ERROR");
  assert.match(emptyResult.errors[0].messages.join(" "), /Missing value for option: --reason/);
  assert.equal(snapshot(value.manager, value.specId), before);
});

test("unchanged canonical recovery stops within its bound even when repository state changes", async (t) => {
  const value = exhaustedRecovery(t);
  const { target, invocation } = await selection(value);
  const dispatcher = new RunDispatchCommand({ maxStalledDispatches: 2,
    repositoryFingerprint: () => { throw new Error("repository-only changes cannot count as recovery progress"); } });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  const before = snapshot(value.manager, value.specId);
  let stalledDispatches = 0;
  let outcome;
  for (let dispatchCount = 1; dispatchCount <= 2; dispatchCount += 1) {
    outcome = await dispatcher.parentCommandProgress({ ctx: value.ctx, session: invocation.session,
      target, invocation, dispatchCount, stalledDispatches, owner: "recovery command",
      requiresCanonicalActionProgress: true });
    stalledDispatches = outcome.stalledDispatches;
    assert.equal(outcome.progressed, false);
  }
  assert.equal(outcome.failure.errors[0].code, "FLOW_DISPATCH_STALLED");
  assert.equal(outcome.failure.data.dispatch.dispatchCount, 2);
  assert.equal(snapshot(value.manager, value.specId), before);
});

test("a changed canonical revision refuses the captured recovery invocation before dispatch", async (t) => {
  const value = exhaustedRecovery(t);
  const { next, target, invocation } = await selection(value);
  value.manager.addNote("A concurrent canonical writer advanced the observed revision.", { specId: value.specId });
  const before = snapshot(value.manager, value.specId);
  const dispatcher = new RunDispatchCommand({ repositoryFingerprint: () => "recovery-command-fingerprint" });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.manager, agent: null });
  await assert.rejects(dispatcher.runDispatcherOwnedRecovery(value.ctx, target, new FlowDispatchAction(next), invocation),
    (error) => error.code === "FLOW_DISPATCH_INVOCATION_STALE");
  assert.equal(snapshot(value.manager, value.specId), before);
});
