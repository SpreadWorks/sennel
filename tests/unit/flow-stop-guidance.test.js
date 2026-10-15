import assert from "node:assert/strict";
import { test } from "node:test";
import { Envelope } from "../../src/lib/flow-envelope.js";
import { createI18n } from "../../src/lib/i18n.js";
import { FlowStopFacts, buildFlowStopGuidance, normalizeFlowStopResult } from "../../src/lib/flow-stop-guidance.js";
import { AgentTimeoutFailure, AgentAuthenticationFailure, AgentProcessStopEvidence } from "../../src/lib/agent-failure.js";
import { ProcessExecutionControlFailure, ProcessExecutionCommunicationDiagnostic } from "../../src/lib/process-execution-values.js";
import { SingleUserActionDirective, NextActionDirective, BlockedDirective, ExecuteContinuationDirective,
  AwaitUserDecisionDirective } from "../../src/flow/lib/next-action-directive.js";
import { FlowContinuation, UserActionPrompt } from "../../src/flow/lib/user-action-prompt.js";

function localize(lang) {
  const local = createI18n(lang, { domain: "messages" });
  return (key, params) => local(key.replace(/^messages:/, ""), params);
}
const en = localize("en");

test("single user action is one concrete task, never a fake choice or execution capability", () => {
  const directive = new SingleUserActionDirective({ actionId: "REPAIR_INPUT", instruction: "Restore the missing input.",
    reason: "The input was removed.", preconditions: ["Use the preserved revision."] });
  const restored = NextActionDirective.fromStored(directive.toJSON());
  assert.deepEqual(restored.toJSON(), directive.toJSON());
  assert.equal(directive.requiresUserAction, true);
  assert.equal(Object.hasOwn(directive, "command"), false);
  assert.equal(Object.hasOwn(directive, "prompt"), false);
  assert.throws(() => new SingleUserActionDirective({ actionId: "BAD", instruction: "Repair.", reason: "Failed.", category: "automatic" }), TypeError);
});

test("guidance shares the selected directive identity and rejects an equivalent competing instance", () => {
  const directive = new BlockedDirective({ code: "BLOCKED", reason: "Missing input.", resumeInstruction: "Restore input." });
  const result = normalizeFlowStopResult({ directive }, { code: "BLOCKED", t: en });
  assert.equal(result.directive, directive);
  assert.equal(result.data.directive, result.guidance.directive);
  assert.equal(result.guidance.toJSON().nextAction.instruction, "Restore input.");
  assert.throws(() => result.guidance.assertDirective(NextActionDirective.fromStored(directive.toJSON())), /FLOW_STOP_GUIDANCE_CONFLICT/);
  assert.throws(() => normalizeFlowStopResult({ directive, continuation: {} }, { code: "BLOCKED", t: en }), /NEXT_ACTION_DIRECTIVE_CONFLICT/);
});

test("blocked omission requests diagnostic repair instead of repeating the reason as an action", () => {
  const directive = new BlockedDirective({ code: "BLOCKED", reason: "Input is missing." });
  assert.notEqual(directive.resumeInstruction, directive.reason);
  assert.match(directive.resumeInstruction, /diagnostic details/);
  const repeated = new BlockedDirective({ code: "BLOCKED", reason: "Input is missing.", resumeInstruction: "Input is missing." });
  assert.notEqual(repeated.resumeInstruction, repeated.reason);
  assert.throws(() => new BlockedDirective({ code: "BLOCKED", reason: "Input is missing.", resumeInstruction: "" }), /non-empty/);
});

test("legacy selected continuations keep exact command and automatic status without a user wait", () => {
  const continuation = new FlowContinuation({ actionId: "RECOVER_SELECTED", nextAction: "sennel flow run selected --opaque 'binding'",
    instruction: "Run the selected recovery.", reason: "The owner selected recovery." });
  const result = normalizeFlowStopResult({ continuation, yieldsControl: false, requiresUserAction: false }, { code: "FAILURE", t: en });
  assert.ok(result.directive instanceof ExecuteContinuationDirective);
  assert.equal(result.directive.continuation, continuation);
  assert.equal(result.directive.nextAction, continuation.nextAction);
  assert.equal(result.directive.requiresUserAction, false);
  assert.equal(result.guidance.toJSON().nextAction.kind, "automatic");
  assert.equal(Object.hasOwn(result.data, "continuation"), false);
  assert.deepEqual(NextActionDirective.fromStored(result.directive.toJSON()).toJSON(), result.directive.toJSON());
});

test("multiple real choices remain the selected user decision", () => {
  const prompt = new UserActionPrompt({ question: "Repair or abort?", recommendedActionId: "REPAIR", recommendationReason: "Preserve progress.",
    choices: [{ actionId: "REPAIR", label: "Repair", nextAction: "repair", impact: { changes: ["missing input"] } },
      { actionId: "ABORT", label: "Abort", nextAction: "abort", impact: { changes: ["flow lifecycle"] } }] });
  const result = normalizeFlowStopResult({ actionPrompt: prompt, yieldsControl: true, requiresUserAction: true }, { code: "WAIT", t: en });
  assert.ok(result.directive instanceof AwaitUserDecisionDirective);
  assert.equal(result.directive.prompt, prompt);
  assert.equal(result.guidance.toJSON().nextAction.kind, "user_decision");
  assert.equal(result.guidance.toJSON().nextAction.instruction, prompt.question);
});

test("same process error code preserves measured attempts, original cause, and actual stop proof", () => {
  const communication = new ProcessExecutionCommunicationDiagnostic({ operation: "status", budgetMs: 50,
    elapsedMs: 51, cutoff: "budget-exhausted", attempts: [
      { ordinal: 1, responseDeadlineMs: 10, elapsedMs: 10, outcome: "timeout" },
      { ordinal: 2, responseDeadlineMs: 50, elapsedMs: 51, outcome: "disconnected" },
    ] });
  const error = new ProcessExecutionControlFailure("communication-failed", "ownerToken=secret env=private", { communication });
  const unconfirmed = buildFlowStopGuidance({ code: error.code, error, t: en }).toJSON();
  const confirmed = buildFlowStopGuidance({ code: error.code, error: error.withStopConfirmation("confirmed"), t: en }).toJSON();
  assert.equal(unconfirmed.currentState.stop, "unconfirmed");
  assert.equal(confirmed.currentState.stop, "confirmed");
  assert.equal(confirmed.currentState.attemptCount, 2);
  assert.equal(confirmed.currentState.budgetMs, 50);
  assert.equal(confirmed.currentState.elapsedMs, 51);
  assert.deepEqual(confirmed.currentState.communicationAttempts, communication.toJSON().attempts);
  assert.equal(confirmed.cause.code, error.primaryCause.code);
  assert.doesNotMatch(JSON.stringify(confirmed), /secret|private|ownerToken|capability|stack/);
  assert.equal(confirmed.nextAction.kind, "external_work");
});

test("typed provider cause, attempts and recovery prerequisite survive the safe projection in both locales", () => {
  const error = new AgentAuthenticationFailure({ message: "ENV_SECRET=private", attemptCount: 2, maxAttempts: 3 });
  const english = buildFlowStopGuidance({ code: "PROVIDER_FAILED", error, t: en }).toJSON();
  const japanese = buildFlowStopGuidance({ code: "PROVIDER_FAILED", error, t: localize("ja") }).toJSON();
  assert.equal(english.cause.kind, "authentication");
  assert.equal(english.cause.code, error.code);
  assert.equal(english.cause.recoveryHint, error.recoveryHint);
  assert.equal(english.currentState.attemptCount, 2);
  assert.equal(english.currentState.maxAttempts, 3);
  assert.match(english.explanation, /authentication/);
  assert.match(japanese.explanation, /認証/);
  assert.doesNotMatch(JSON.stringify(japanese), /private/);
  assert.equal(japanese.nextAction.kind, "external_work");
  assert.match(japanese.nextAction.instruction, /認証/);
  assert.equal(buildFlowStopGuidance({ code: "PROVIDER_FAILED", error, t: en }).directive.actionId, "RESOLVE_PROVIDER_EXTERNAL_FAILURE");
  const persisted = normalizeFlowStopResult({ agentFailure: error.toJSON() }, { code: "PROVIDER_FAILED", t: en });
  assert.equal(persisted.guidance.toJSON().cause.kind, "authentication");
  assert.equal(persisted.guidance.toJSON().currentState.attemptCount, 2);
});

test("timeout does not infer recovery authority even when the provider stop is confirmed", () => {
  const error = new AgentTimeoutFailure({ message: "Timeout" });
  const guidance = buildFlowStopGuidance({ code: error.code, error, t: en });
  assert.equal(guidance.toJSON().currentState.stop, "unconfirmed");
  assert.equal(guidance.directive.actionId, "REQUEST_FLOW_DIAGNOSTIC_REPAIR");
  assert.equal(guidance.directive.requiresUserAction, true);
  assert.equal(Object.hasOwn(guidance.directive, "nextAction"), false);
  const confirmed = buildFlowStopGuidance({ code: error.code,
    error: new AgentTimeoutFailure({ message: "Timeout", stopEvidence: AgentProcessStopEvidence.confirmed() }), t: en });
  assert.equal(confirmed.toJSON().currentState.stop, "confirmed");
  assert.equal(confirmed.directive.actionId, "REQUEST_FLOW_DIAGNOSTIC_REPAIR");
});

test("unknown codes, missing catalog, unresolved arguments and locale failure retain stable diagnostic fallback", () => {
  for (const t of [() => { throw new Error("locale broken"); }, (key) => key, () => "missing {{argument}}"] ) {
    const guidance = buildFlowStopGuidance({ code: "UNREGISTERED_CODE", error: new Error("secret stack"), t }).toJSON();
    assert.equal(guidance.code, "UNREGISTERED_CODE");
    assert.equal(guidance.diagnosticReference, "UNREGISTERED_CODE");
    assert.equal(guidance.currentState.completion, "unconfirmed");
    assert.equal(guidance.currentState.persistence, "unconfirmed");
    assert.equal(guidance.currentState.attemptCount, "unconfirmed");
    assert.match(guidance.nextAction.instruction, /UNREGISTERED_CODE/);
    assert.doesNotMatch(JSON.stringify(guidance), /secret|\{\{/);
  }
  assert.match(buildFlowStopGuidance({ code: "UNREGISTERED_CODE", t: localize("ja") }).explanation, /停止/);
});

test("failure returns and thrown failures use identical assembly and preserve final facts across serialization", () => {
  const error = new AgentTimeoutFailure({ message: "Timeout" });
  const facts = new FlowStopFacts({ persistence: "saved", completion: "incomplete", elapsedMs: 123 });
  const returned = Envelope.fail("run", "worker", error.code, "failed").attachStopGuidance({ error, facts, t: en });
  const thrown = Envelope.fail("run", "worker", error.code, "failed").attachStopGuidance({ error, facts, t: en });
  assert.deepEqual(returned.toJSON().guidance, thrown.toJSON().guidance);
  assert.equal(returned.toJSON().guidance.currentState.persistence, "saved");
  returned.addWarning("CLOSE_FAILED", "close failed");
  assert.equal(returned.toJSON().errors.length, 2);
  assert.equal(returned.toJSON().guidance.currentState.elapsedMs, 123);
  assert.throws(() => { returned.data.directive = NextActionDirective.fromStored(returned.data.directive.toJSON()); returned.toJSON(); }, /FLOW_STOP_GUIDANCE_CONFLICT/);
});

test("only failures, user stops, and explicit nonzero warning exits acquire guidance", () => {
  const success = Envelope.ok("get", "status", { active: false });
  assert.equal(Object.hasOwn(success.toJSON(), "guidance"), false);
  const warning = Envelope.warn("run", "worker", {}, "CLOSE_FAILED", "close failed");
  assert.equal(Object.hasOwn(warning.toJSON(), "guidance"), false);
  warning.attachStopGuidance({ exitCode: 2, t: en });
  assert.equal(warning.toJSON().guidance.code, "CLOSE_FAILED");
  const blocked = Envelope.ok("get", "next-action", { directive: new BlockedDirective({ code: "BLOCKED", reason: "Input missing." }) });
  assert.equal(blocked.toJSON().guidance.code, "BLOCKED");
  for (const type of ["docs", "workflow", "plugin"]) {
    const envelope = Envelope.fail(type, "command", "FAILED", "failed");
    assert.equal(envelope.toJSON().data, null);
    assert.equal(Object.hasOwn(envelope.toJSON(), "guidance"), false);
  }
});

test("current wire readback binds guidance to the restored directive and rejects divergent presentation", () => {
  const original = Envelope.ok("get", "next-action", { directive: new BlockedDirective({ code: "BLOCKED",
    reason: "Input missing.", resumeInstruction: "Restore the selected input." }) });
  original.attachStopGuidance({ t: en });
  const wire = JSON.parse(JSON.stringify(original.toJSON()));
  const restored = new Envelope(wire);
  assert.equal(restored.guidance.directive, restored.data.directive);
  assert.equal(restored.toJSON().guidance.nextAction.instruction, "Restore the selected input.");
  wire.guidance.nextAction.instruction = "Run a different operation.";
  assert.throws(() => new Envelope(wire), /FLOW_STOP_GUIDANCE_CONFLICT/);
  const failure = Envelope.fail("run", "provider", "PROVIDER_FAILED", "failed").attachStopGuidance({
    error: new AgentAuthenticationFailure({ message: "Authentication failed", attemptCount: 2, maxAttempts: 3 }), t: en,
    facts: new FlowStopFacts({ persistence: "saved" }),
  });
  const failedWire = JSON.parse(JSON.stringify(failure.toJSON()));
  assert.deepEqual(JSON.parse(JSON.stringify(new Envelope(failedWire))), failedWire);
});
