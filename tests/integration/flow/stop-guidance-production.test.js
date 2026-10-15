import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { FlowDispatchBoundary } from "../../../src/flow/lib/run-dispatch.js";
import { BlockedDirective, AwaitDraftQuestionDirective, ExecuteStepDirective, ExecuteCommandDirective, AwaitTaskReviewFilterDirective } from "../../../src/flow/lib/next-action-directive.js";
import { FlowExecutionCommand } from "../../../src/flow/lib/flow-execution-command.js";
import { ExternalBlockedOutcome, AwaitingDecisionOutcome, DecisionOutcome, DeferOutcome, StepAttempt, recordStepAttempt } from "../../../src/flow/lib/step-outcome.js";
import { UserActionPrompt } from "../../../src/flow/lib/user-action-prompt.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { FlowStopGuidance, publicFlowErrorText, publicFlowErrorCode } from "../../../src/lib/flow-stop-guidance.js";
import { createI18n } from "../../../src/lib/i18n.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import RunFilterTaskReviewCommand from "../../../src/flow/lib/run-filter-task-review.js";

test("Task Review input rejection does not publish the native parser's input excerpt", () => {
  const envelope = new RunFilterTaskReviewCommand().execute({ exclusions: "unlabeledsecret" });
  const wire = JSON.parse(JSON.stringify(envelope));
  assert.equal(wire.ok, false);
  assert.equal(wire.errors[0].code, "TASK_REVIEW_FILTER_NOT_ADMITTED");
  assert.equal(wire.errors[0].messages[0], "Task Review exclusions are not valid JSON.");
  assert.equal(JSON.stringify(wire).includes("unlabeledsecret"), false);
  assert.equal(wire.guidance.currentState.persistence, "unconfirmed");
  assert.equal(wire.guidance.nextAction.kind, "external_work");
});

test("nested next-action metadata is redacted without discarding its step or changing executable authority", () => {
  const directive = new ExecuteStepDirective({ action: "test" });
  const envelope = Envelope.fail("run", "dispatch", "FLOW_DISPATCH_APPROVAL_STALE", "The selected action changed.", {
    dispatch: { boundary: "blocked" },
    nextAction: { step: "test", instructions: { content: "Do not disclose capability values." }, directive },
  });
  const wire = envelope.toJSON();
  assert.equal(wire.data.nextAction.step, "test");
  assert.equal(wire.data.nextAction.instructions.content.includes("capability"), false);
  assert.equal(wire.data.directive.action, "test");
  assert.equal(envelope.guidance.directive, directive);
  assert.deepEqual(wire.errors.map(({ code }) => code), ["FLOW_DISPATCH_APPROVAL_STALE"]);
});

function decisionPrompt() {
  return new UserActionPrompt({ question: "Repair or abort?", recommendedActionId: "REPAIR", recommendationReason: "Preserve progress.",
    choices: [{ actionId: "REPAIR", label: "Repair", nextAction: "repair", impact: { changes: ["missing input"] } },
      { actionId: "ABORT", label: "Abort", nextAction: "abort", impact: { changes: ["flow lifecycle"] } }] });
}

test("actual dispatch boundary projections expose one selected directive and guidance for each user or host stop", (t) => {
  const root = createTmpDir("flow-stop-boundaries-");
  t.after(() => removeTmpDir(root));
  const binding = FlowTargetBinding.capture({ flowState: { runId: "run-stop", specId: "stop-spec", execution: { mode: "direct" } },
    mainRoot: root, authorityRoot: root });
  const target = new FlowDispatchTarget({ expectation: new FlowTargetExpectation({ expectBinding: binding.serialize() }), binding });
  const hostCommand = "sennel flow set task-review-filter --finding-filter '<json-array>' --expect-binding exact";
  const cases = [
    ["blocked", new BlockedDirective({ code: "INPUT_MISSING", reason: "Missing input.", resumeInstruction: "Restore the selected input." }), "external_work"],
    ["await_user_decision", new AwaitDraftQuestionDirective({ questionId: "Q1", question: "Which implementation?", questionRevision: 1 }), "single_user_action"],
    ["approval_required", new ExecuteStepDirective({ action: "approve-spec", actionPrompt: decisionPrompt() }), "user_decision"],
    ["host_action", new AwaitTaskReviewFilterDirective({ command: hostCommand, binding: { runId: "run-stop" }, findings: [{ findingId: "F1" }] }), "external_work"],
  ];
  for (const [kind, directive, presentationKind] of cases) {
    const produced = new FlowDispatchBoundary({ kind, nextAction: { step: "spec-review", metadata: "retained", directive },
      dispatchCount: 2, target, approvalToken: kind === "approval_required" ? "exact-approval-token" : null }).toJSON();
    const envelope = Envelope.ok("run", "dispatch", produced);
    const wire = JSON.parse(JSON.stringify(envelope));
    assert.equal(envelope.data.directive, directive, kind);
    assert.equal(envelope.guidance.directive, directive, kind);
    assert.equal(Object.hasOwn(wire.data.nextAction, "directive"), false, kind);
    assert.equal(wire.data.nextAction.metadata, "retained", kind);
    assert.deepEqual(wire.data.dispatch, produced.dispatch, kind);
    assert.equal(wire.guidance.nextAction.kind, presentationKind, kind);
    if (kind === "host_action") {
      assert.match(wire.guidance.nextAction.instruction, /task-review-filter/);
      assert.equal(wire.data.directive.command, hostCommand);
      assert.equal(wire.data.directive.requiresUserAction, false);
      assert.equal(wire.guidance.code, "FLOW_HOST_ACTION_REQUIRED");
    }
  }
});

test("recordStepAttempt output survives save and readback before selecting its existing stop action", (t) => {
  const root = createTmpDir("flow-stop-attempt-");
  t.after(() => removeTmpDir(root));
  const outcomes = [new ExternalBlockedOutcome({ reason: "Provider configuration is unavailable.", resumeInstruction: "Repair the selected provider configuration.", failureCode: "PROVIDER_CONFIGURATION" }),
    new AwaitingDecisionOutcome({ reason: "A resolution requires user input.", resumeInstruction: "Choose the resolution.", prompt: decisionPrompt() })];
  for (const [index, outcome] of outcomes.entries()) {
    const result = { artifacts: { existing: "retained" } };
    recordStepAttempt({ flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, runId: "run-produced" } },
      { stepId: "spec-review", attempt: index + 1, outcome, result });
    const file = path.join(root, `attempt-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(result));
    const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
    const attempt = StepAttempt.fromStored(reloaded.stepAttempt);
    assert.ok(attempt.outcome instanceof outcome.constructor);
    assert.deepEqual(attempt.outcome.toJSON(), reloaded.artifacts.stepOutcome);
    const envelope = Envelope.ok("run", "review", reloaded);
    const wire = JSON.parse(JSON.stringify(envelope));
    assert.equal(wire.data.artifacts.existing, "retained");
    assert.equal(wire.data.stepAttempt.attempt, index + 1);
    assert.equal(wire.guidance.currentState.attemptCount, index + 1);
    assert.equal(wire.guidance.nextAction.kind, outcome instanceof AwaitingDecisionOutcome ? "user_decision" : "external_work");
    assert.equal(wire.guidance.nextAction.instruction, outcome.prompt?.question ?? outcome.resumeInstruction);
    assert.equal(wire.guidance.code, outcome.failureCode ?? "FLOW_AWAITING_USER_ACTION");
    const recovery = new ExecuteStepDirective({ action: "run-selected-recovery" });
    const recovered = Envelope.ok("run", "review", { ...reloaded, directive: recovery });
    assert.equal(recovered.toJSON().guidance.nextAction.kind, "automatic");
    assert.equal(recovered.data.directive, recovery);
    assert.equal(recovered.guidance.directive.requiresUserAction, false);
  }
});

test("successful DecisionOutcome and DeferOutcome producer results add no stop guidance or operation request", () => {
  for (const outcome of [new DecisionOutcome({ decision: "PASS", nextAction: "spec-gate" }),
    new DeferOutcome({ nextAction: "refresh-next-action", findingCount: 2 })]) {
    const result = {};
    recordStepAttempt({ flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, runId: "run-normal" } },
      { stepId: "spec-review", attempt: 1, outcome, result });
    const wire = JSON.parse(JSON.stringify(Envelope.ok("run", "review", result)));
    assert.equal(Object.hasOwn(wire, "guidance"), false);
    assert.equal(Object.hasOwn(wire.data, "directive"), false);
    assert.deepEqual(wire.data.artifacts.stepOutcome, outcome.toJSON());
  }
});

test("public stop JSON redacts human diagnostics without mutating selected authority or typed evidence", () => {
  const privateText = "ownerToken=private-owner capability=private-capability SENNEL_SECRET=private-environment\n    at private-stack";
  const directive = new BlockedDirective({ code: "BLOCKED", reason: privateText, resumeInstruction: privateText });
  const error = new ProcessExecutionControlFailure("control-failed", privateText);
  const originalEvidence = error.toJSON();
  const envelope = Envelope.fail("run", "worker", "BOUNDARY_FAILED", ["Safe public failure detail.", privateText],
    { directive, processExecutionControlFailure: originalEvidence, env: { SECRET: "private-environment" }, stack: "private-stack" })
    .attachStopGuidance({ error });
  const text = JSON.stringify(envelope);
  const wire = JSON.parse(text);
  assert.doesNotMatch(text, /private-owner|private-capability|private-environment|private-stack|ownerToken|"env"|"stack"/);
  assert.equal(wire.errors[0].messages[0], "Safe public failure detail.");
  assert.equal(wire.guidance.cause.code, error.code);
  assert.equal(wire.data.processExecutionControlFailure.primaryCause.code, error.code);
  assert.equal(envelope.data.directive, directive);
  assert.equal(directive.reason, privateText);
  assert.deepEqual(error.toJSON(), originalEvidence);
  assert.equal(publicFlowErrorText("safe error", "fallback"), "safe error");
  assert.equal(publicFlowErrorText(privateText, "fallback"), "fallback");
  assert.equal(publicFlowErrorCode("ENOENT"), "ENOENT");
  const unknown = Envelope.fail("run", "initialize", "FLOW_INITIALIZATION_FAILED", "safe outer failure")
    .attachStopGuidance({ error: Object.assign(new Error("safe original detail"), { code: "ENOENT" }) });
  assert.equal(unknown.toJSON().guidance.cause.code, "ENOENT");
});

test("unsafe selected instruction publishes a safe complete wire that round-trips with the same action", () => {
  const directive = new BlockedDirective({ code: "BLOCKED", reason: "ownerToken=private-reason",
    resumeInstruction: "capability=private-instruction" });
  const original = Envelope.fail("run", "worker", "BLOCKED", "Safe failure.", { directive });
  const wire = JSON.parse(JSON.stringify(original));
  assert.equal(wire.guidance.nextAction.instruction, wire.data.directive.resumeInstruction);
  assert.notEqual(wire.data.directive.reason, wire.data.directive.resumeInstruction);
  assert.doesNotMatch(JSON.stringify(wire), /private-reason|private-instruction/);
  assert.deepEqual(JSON.parse(JSON.stringify(new Envelope(wire))), wire);
  assert.equal(original.data.directive, directive);
  assert.equal(original.guidance.directive, directive);
});

test("safe large reports, artifacts and execution commands retain their bytes through stop serialization", () => {
  const command = new FlowExecutionCommand({ group: "run", subcommand: "selected", args: ["--input", "x".repeat(6000), ""] });
  const directive = new ExecuteCommandDirective({ actionId: "CONTINUE_SELECTED", command,
    instruction: "Run the selected guarded continuation.", reason: "The owner selected this continuation." });
  const report = "Safe report detail. ".repeat(600);
  const original = Envelope.warn("run", "worker", { directive, report: { text: report },
    artifact: { content: "Safe artifact detail. ".repeat(500), empty: "" } }, "CLOSE_FAILED", "Log close failed.")
    .attachStopGuidance({ exitCode: 1 });
  const wire = JSON.parse(JSON.stringify(original));
  assert.equal(wire.data.report.text, report);
  assert.equal(wire.data.artifact.content, original.data.artifact.content);
  assert.equal(wire.data.artifact.empty, "");
  assert.equal(wire.data.directive.nextAction, command.toString());
  assert.deepEqual(wire.data.directive.command, command.toJSON());
  assert.equal(original.data.directive, directive);
  assert.deepEqual(JSON.parse(JSON.stringify(new Envelope(wire))), wire);
});

test("automatic and host presentations survive cross-locale and unavailable-catalog readback verbatim", () => {
  const english = createI18n("en", { domain: "messages" });
  const t = (key, params) => english(key.replace(/^messages:/, ""), params);
  const directives = [new ExecuteStepDirective({ action: "run-selected-worker" }),
    new AwaitTaskReviewFilterDirective({ command: "sennel flow set task-review-filter --expect-binding exact",
      binding: { runId: "run-locale" }, findings: [{ findingId: "F1" }] })];
  for (const directive of directives) {
    const original = Envelope.warn("run", "worker", { directive }, "PUBLIC_STOP", "Safe diagnostic.")
      .attachStopGuidance({ exitCode: 1, t });
    const wire = JSON.parse(JSON.stringify(original));
    const restored = new Envelope(wire);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), wire);
    let catalogCalls = 0;
    const withoutCatalog = FlowStopGuidance.fromStored(wire.guidance, { directive: restored.data.directive,
      t: () => { catalogCalls += 1; throw new Error("Catalog unavailable"); } });
    assert.equal(catalogCalls, 0);
    assert.deepEqual(withoutCatalog.toJSON(), wire.guidance);
    const altered = structuredClone(wire);
    altered.guidance.nextAction.instruction = "Run a different operation.";
    assert.throws(() => new Envelope(altered), /FLOW_STOP_GUIDANCE_CONFLICT/);
  }
});

test("diagnostic-only target refusal retains its original stable code across repeated serialization", () => {
  const produced = new FlowDispatchBoundary({ kind: "target_mismatch", nextAction: null, dispatchCount: 0 }).toJSON();
  const envelope = Envelope.ok("run", "dispatch", produced).attachStopGuidance();
  assert.equal(envelope.guidance.code, "FLOW_OPERATION_STOPPED");
  assert.equal(envelope.toJSON().guidance.code, "FLOW_OPERATION_STOPPED");
  assert.equal(envelope.toJSON().guidance.code, "FLOW_OPERATION_STOPPED");
});
