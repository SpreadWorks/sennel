import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { attachedCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { settleImplStepResult, implementationNonblockingEligibilityForResult } from "../../../src/flow/definition.js";
import { readCurrentTestChainSettlement } from "../../../src/flow/lib/test-chain-transition-facts.js";
import { implStepRegistration, recoverTestChainExecution } from "../../../src/flow/engine/composition/impl.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function sourceEvidence(scenario) {
  const location = scenario.manager.specLocation(scenario.specId);
  return scenario.manager.artifactCatalog(scenario.specId).artifacts
    .filter((entry) => entry.logicalKey === "tests.source")
    .map((entry) => ({ descriptor: entry.toJSON(), bytes: digest(fs.readFileSync(location.resolve(entry.relativePath))) }));
}

async function claimReview(scenario) {
  if (scenario.state().attempt?.nodeId !== "test-result-review" || scenario.state().attempt.failure !== null) {
    const claimed = await new RunClaimNextActionCommand().execute(scenario.context());
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
  }
  assert.equal(scenario.state().attempt.nodeId, "test-result-review");
}

/** Fail only the consumer's explicit text reread; catalog verification reads bytes. */
async function rejectByTransientConsumerRead(t, scenario) {
  if (scenario.current() === "test-execute") {
    await scenario.executeCurrent();
    assert.equal(scenario.current(), "test-result-review");
  }
  await claimReview(scenario);
  const attempt = scenario.state().attempt;
  assert.equal(attempt.consumption.tooling, 0);
  const execution = scenario.commandArtifact("test.execute", "test-result-review");
  const executionSettlement = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId,
    stepId: "test-execute", completed: true });
  const summary = execution.payload.summary.find((entry) => entry.execution === "executed");
  assert.ok(summary?.evidence.test_file, "the normal execution must supply an executable test source");
  const testFile = path.resolve(scenario.root, summary.evidence.test_file);
  const raw = scenario.manager.readRuntimeArtifact({ specId: scenario.specId,
    logicalKey: "test.execute.raw-log", consumerNodeId: "test-result-review" });
  const protectedSource = sourceEvidence(scenario);
  const rawDigest = digest(raw.bytes);
  const originalRead = fs.readFileSync;
  let injected = 0;
  const fault = t.mock.method(fs, "readFileSync", function (file, options) {
    if (injected === 0 && options === "utf8" && typeof file === "string" && path.resolve(file) === testFile) {
      injected += 1;
      const error = new Error("bounded Test Review consumer read EIO");
      error.code = "EIO";
      throw error;
    }
    return originalRead.apply(this, arguments);
  });
  t.after(() => fault.mock.restore());
  let outcome;
  try { outcome = await new RunTestResultReviewCommand().execute(scenario.context()); }
  finally { fault.mock.restore(); }
  assert.equal(injected, 1, "one consumer text read must fail, then all publication reads recover");
  const publication = attachedCanonicalCommandResultArtifact(outcome);
  assert.equal(publication.payload.verdict, "fail");
  assert.ok(publication.payload.checked_items.some((item) => item.check === "summary_evidence"
    && item.result === "fail" && item.detail.includes("bounded Test Review consumer read EIO")));
  await FLOW_COMMANDS.run["test-result-review"].post(scenario.context(), outcome);
  scenario.reload();
  assert.equal(scenario.state().attempt.consumption.tooling, 0, "structural rejection must not spend tooling retry budget");
  assert.equal(scenario.state().attempt.failure?.category, "semantic", "Rejection must persist its selected semantic failure");
  assert.deepEqual(sourceEvidence(scenario), protectedSource, "transient observation must not change canonical test source bytes or provenance");
  const retainedRaw = scenario.manager.readRuntimeArtifact({ specId: scenario.specId,
    logicalKey: "test.execute.raw-log", consumerNodeId: "test-result-review" });
  assert.equal(digest(retainedRaw.bytes), rawDigest);
  const activity = scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === "test-result-review"
    && entry.attemptId === attempt.id && entry.result?.stepResult).at(-1);
  assert.ok(activity, "the actual registered Step must atomically save its observed Result");
  const result = StepResult.fromStored("test-result-review", activity.result.stepResult);
  assert.equal(result.kind, "test-result-review-evidence-rejected");
  assert.equal(result.type, "loop-required");
  assert.equal(result.evidence.observation.toolingFailure, false);
  assert.equal(result.evidence.integrityFailure, null);
  assert.equal(result.evidence.completion.completed, true);
  assert.equal(result.evidence.identity.attempt.id, attempt.id);
  assert.equal(result.evidence.publication.producerActivityId, activity.id);
  assert.equal(result.evidence.source.producerActivityId, execution.descriptor.activityId);
  const settlement = settleImplStepResult("test-result-review", result);
  const authenticated = scenario.publicationObserver.authenticate(scenario.manager, activity, result, settlement);
  assert.equal(authenticated.receipt.id, activity.result.draftSettlementReceipt.id);
  return { result, settlement, activity, executionActivityId: execution.descriptor.activityId,
    executionReceiptId: executionSettlement.receipt.id };
}

test("actual rejected Test Review observations exhaust, recover, and explicitly continue with source-bound receipts", async (t) => {
  const scenario = ImplPhaseScenario.create(t);
  await scenario.advanceTo("test-execute");
  const maximum = scenario.state().definition.contractForNode(scenario.state().findNode("test-result-review")).semanticRetryLimit + 1;
  assert.equal(maximum, 3, "the production semantic retry budget must remain unchanged");
  let originalExecution = null;
  const exhaust = async () => {
    let observed;
    for (let used = 1; used <= maximum; used += 1) {
      observed = await rejectByTransientConsumerRead(t, scenario);
      const execution = { activityId: observed.executionActivityId, receiptId: observed.executionReceiptId };
      originalExecution ??= execution;
      assert.deepEqual(execution, originalExecution, "same-Review semantic retries must not rerun or replace the execution producer");
      assert.equal(observed.result.evidence.retry.used, used, "current observation counts once toward the same semantic episode");
      assert.equal(observed.result.evidence.retry.maximum, maximum);
      // 57ec requires same-Review retry/Failure and explicitly excludes test
      // re-execution. Current observations count prospectively; claims charge
      // exactly one semantic retry in the same episode.
      assert.equal(observed.settlement.kind, used === maximum ? "await" : "execution");
      assert.equal(scenario.state().attempt.consumption.semantic, used - 1);
      assert.equal(scenario.state().attempt.failure.retryKind, used === maximum ? null : "semantic");
      assert.equal(scenario.state().attempt.failure.code, used === maximum ? "TEST_CHAIN_RETRY_EXHAUSTED" : "TEST_CHAIN_REJECTED");
      assert.equal(implementationNonblockingEligibilityForResult(observed.result)?.resultKind ?? null,
        used === maximum ? "quality" : null);
      assert.equal(scenario.current(), "test-result-review");
    }
    const before = scenario.snapshot();
    const next = await scenario.next();
    if (scenario.state().policy.nonblocking?.enabled === true) {
      assert.equal(next.directive.kind, "blocked", JSON.stringify(next.directive));
      assert.equal(next.directive.code, "TEST_CHAIN_NONBLOCKING_DECISION_REQUIRED");
      assert.equal(next.directive.terminal, true);
      assert.equal(next.directive.requiresUserAction, false);
      assert.equal(next.nonblockingDecision.resultKind, "quality");
      assert.deepEqual(next.nonblockingDecision.allowedActions, ["repair", "continue"]);
    } else {
      assert.equal(next.directive.kind, "await_user_decision", JSON.stringify(next.directive));
      assert.equal(next.directive.requiresUserAction, true);
      assert.deepEqual(next.directive.actionPrompt.choices.map((entry) => entry.actionId), ["KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING"]);
    }
    assert.equal(scenario.state().nextAction().operation, "blocked");
    await assert.rejects(() => new RunTestResultReviewCommand().execute(scenario.context()),
      /test-chain direct admission rejected/);
    assert.deepEqual(scenario.snapshot(), before, "exhausted query and refused fourth producer have no canonical effects");
    return observed;
  };
  const first = await exhaust();
  activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager, reason: "Retain the actual rejected evidence for explicit recovery." });
  let context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  const beforeRetry = scenario.state().attempt;
  assert.deepEqual(context.allowedActions, ["repair", "continue"]);
  recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "repair",
    reason: "Recover the actual rejected evidence once its transient read has recovered.", expectEvidenceDigest: context.evidenceDigest });
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "test-result-review");
  assert.equal(scenario.state().attempt.sequence, beforeRetry.sequence + 1);
  assert.equal(scenario.state().attempt.consumption.semantic, 0);
  assert.equal(scenario.state().attempt.consumption.tooling, 0);
  assert.equal(first.result.evidence.retry.used, maximum, "explicit retry must not rewrite the original rejected observation");
  const second = await exhaust();
  const source = readCurrentTestChainSettlement({ flowManager: scenario.manager, specId: scenario.specId, stepId: "test-result-review" });
  assert.deepEqual(source.result.toJSON(), second.result.toJSON());
  context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  const input = { root: scenario.root, flowManager: scenario.manager, choice: "continue",
    reason: "Accept the exact repeated structural evidence risk.", remainingRisk: "Acceptance must retain the failed summary evidence.",
    expectEvidenceDigest: context.evidenceDigest };
  const commit = scenario.manager.commitSpecStepResult.bind(scenario.manager);
  for (const field of ["sourceReceiptId", "sourceResultDigest", "oldAttempt"]) {
    const before = scenario.snapshot();
    scenario.manager.commitSpecStepResult = (candidate) => {
      if (field === "oldAttempt") return commit({ ...candidate, binding: candidate.nonblockingPublication.sourceBinding });
      const stored = candidate.stepResult.toJSON();
      stored.evidence.acceptedDecision[field] = "f".repeat(64);
      const stepResult = StepResult.fromStored("test-result-review", stored);
      return commit({ ...candidate, stepResult, settlement: settleImplStepResult("test-result-review", stepResult) });
    };
    try { assert.throws(() => recordNonBlockingDecision(input), (error) => error.code === "CURRENT_FLOW_STATE_CONFLICT"
      || error.cause?.code === "CURRENT_FLOW_STATE_CONFLICT"); }
    finally { scenario.manager.commitSpecStepResult = commit; }
    assert.deepEqual(scenario.snapshot(), before, `${field} refusal preserves source and canonical evidence`);
  }
  const before = scenario.snapshot();
  const executed = scenario.requests.length;
  const processCalls = [];
  const processMocks = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => {
    const original = childProcess[name];
    return t.mock.method(childProcess, name, function (...args) {
      processCalls.push({ name, command: args[0], args: args[1] });
      return original.apply(this, args);
    });
  });
  const restoreProcesses = () => { for (const mocked of processMocks) mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restoreProcesses);
  syncBuiltinESMExports();
  const originalAttempt = scenario.state().attempt;
  recordNonBlockingDecision(input);
  scenario.reload();
  assert.equal(scenario.current(), "impl-review");
  assert.equal(scenario.requests.length, executed, "acceptance must not invoke a worker or rerun test execution");
  const terminal = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "test-result-review", completed: true });
  assert.equal(terminal.result.kind, source.result.kind);
  assert.equal(terminal.result.type, source.result.type);
  assert.equal(terminal.receipt.binding.attemptSequence, originalAttempt.sequence + 1);
  assert.notEqual(terminal.receipt.id, source.receipt.id);
  assert.equal(terminal.result.evidence.acceptedDecision.sourceReceiptId, source.receipt.id);
  const original = terminal.result.evidence.toJSON();
  delete original.acceptedDecision;
  assert.deepEqual(original, source.result.evidence.toJSON());
  assert.equal(terminal.settlement.targetStepId, "impl-review");
  assert.equal(scenario.snapshot().activities.length, before.activities.length + 1);
  const fresh = readCurrentTestChainSettlement({ flowManager: scenario.manager, specId: scenario.specId,
    stepId: "test-result-review", completed: true });
  assert.equal(fresh.receipt.id, terminal.receipt.id);
  const after = scenario.snapshot();
  const registration = implStepRegistration("test-result-review");
  const replayInput = { flowManager: scenario.manager, specId: scenario.specId, stepId: "test-result-review",
    registration, receipt: terminal.receipt };
  const selection = registration.executionContract.select(replayInput);
  assert.equal((await registration.executionContract.execute(selection, replayInput)).id, terminal.receipt.id);
  assert.equal((await recoverTestChainExecution({ ...replayInput, selection })).id, terminal.receipt.id);
  assert.deepEqual(scenario.snapshot(), after, "registered execute/recovery replay must preserve exact decision state and receipt");
  assert.deepEqual(processCalls, Array.from({ length: 2 }, () => ({
    name: "spawnSync", command: "git", args: ["-C", scenario.root, "rev-parse", "--git-common-dir"],
  })), "continuation and replay may authenticate repository location without invoking a test or worker process");
  restoreProcesses();
});
