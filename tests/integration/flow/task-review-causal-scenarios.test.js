import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { confirmCanonicalFixtureStep } from "../../support/infrastructure/flow-setup.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { readRetryBaseline, RetryRecoveryReceipt, retryEvidenceRouteForNode } from "../../../src/flow/lib/retry-recovery.js";
import { ReviewTransitionFacts } from "../../../src/flow/lib/review-transition-facts.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { runTaskReviewProtocol, classifyReviewCommandError, parseImplReviewFindings, formatImplReviewJson } from "../../../src/flow/commands/review.js";
import { ReviewProtocolFailure } from "../../../src/flow/lib/review-protocol.js";
import { container } from "../../../src/lib/container.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";

function baseline(scenario) {
  const state = scenario.state();
  return readRetryBaseline(scenario.manager, state, retryEvidenceRouteForNode(state, state.attempt.nodeId));
}

function recoveryReceipt(scenario) {
  const state = scenario.state();
  const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
  const receipt = scenario.manager.readArtifact({
    specId: scenario.specId,
    logicalKey: "retry.recovery.receipt",
    parameters: { routeId: `${route.kind}-${route.phase}${route.taskId ? `-${route.taskId}` : ""}`, attemptId: state.attempt.id },
    consumerNodeId: state.attempt.nodeId,
    optional: true,
  });
  return receipt === null ? null : new RetryRecoveryReceipt(JSON.parse(receipt.bytes.toString("utf8")));
}

async function withOutputDirectory(directory, callback) {
  const previous = process.env.SENNEL_REVIEW_OUTPUT_DIR;
  process.env.SENNEL_REVIEW_OUTPUT_DIR = directory;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.SENNEL_REVIEW_OUTPUT_DIR;
    else process.env.SENNEL_REVIEW_OUTPUT_DIR = previous;
  }
}

function useScenarioContainer(t, scenario) {
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
}

function stoppedWorker() {
  return { ok: false, status: 1, stdout: "", stderr: "deterministic boundary stop", signal: null, killed: false };
}

class DeterministicReviewAgent {
  constructor(call) { this.call = call; }
  providerRetryPolicy() { return { retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }; }
}

function commitRuntimeEvidence(scenario, revision) {
  scenario.changeEvidence(revision);
  execFileSync("git", ["add", "runtime-repair.js"], { cwd: scenario.root });
  execFileSync("git", ["commit", "-q", "-m", "audited runtime fixture change"], { cwd: scenario.root });
}

// Real protocol, response parser, artifact formatter, and seal. Only the AI
// and child-process invocation are faked, not the parent's required evidence.
function repairingWorker(scenario, invocation, { repair = true, onProviderCall = () => {} } = {}) {
  return async (_command, _args, options) => withOutputDirectory(options.env.SENNEL_REVIEW_OUTPUT_DIR, async () => {
    const requirementIds = new Set(["R-1"]);
    const raw = await runTaskReviewProtocol({
      root: scenario.root,
      executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
      flowManager: scenario.manager, requirementIds, recurrenceHistory: [], sourcePaths: new Set(["README.md"]),
      agent: new DeterministicReviewAgent(async () => {
          onProviderCall();
          if (repair) fs.appendFileSync(scenario.sourcePath, `repair ${invocation}\n`);
          return JSON.stringify({ blockingFindings: repair ? [{
            findingKey: `repair-${invocation}`, title: `Repair ${invocation}`,
            failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
            issue: `Missing behavior ${invocation}`, suggestion: "Correct the implementation.",
            disposition: "must-fix", rationale: "R-1 requires this behavior.",
            priorRepairInsufficiency: null, repairStrategy: null,
          }] : [], nonBlockingImprovements: [] });
      }),
      prompt: "Review the Task", systemPrompt: "Return a complete Review object",
    });
    const findings = parseImplReviewFindings(raw, { requirementIds });
    fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), formatImplReviewJson({ ...findings, generatedAt: "2026-09-07T00:00:00.000Z", requirementIds }));
    ReviewWorkUnit.fromEnvironment(options.env).seal();
    return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
  });
}

async function publishPassingTaskReview(scenario) {
  const result = await scenario.review(repairingWorker(scenario, 1, { repair: false })).execute(scenario.context());
  assert.equal(result.result, "ok", JSON.stringify(result));
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  return result;
}

// A published PASS now prepares Gate atomically. Complete that active Gate
// before exercising rewind from a terminal Task, preserving the recovery scenario.
async function completePassingTask(scenario) {
  await publishPassingTaskReview(scenario);
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
  confirmCanonicalFixtureStep(scenario.manager, scenario.specId, "T-1-gate");
  scenario.reload();
  assert.equal(scenario.state().current, null);
}

// Exercise the real Task Review protocol and parent failure persistence; only
// the provider response and child-process boundary are deterministic fakes.
function invalidProtocolWorker(scenario, invalid, onCall) {
  return async (_command, _args, options) => {
    try {
      await withOutputDirectory(options.env.SENNEL_REVIEW_OUTPUT_DIR, () => runTaskReviewProtocol({
        root: scenario.root,
        executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
        flowManager: scenario.manager, requirementIds: new Set(["R-1"]),
        recurrenceHistory: [], sourcePaths: new Set(["README.md"]),
        agent: new DeterministicReviewAgent(async () => { onCall(); return invalid; }),
        prompt: "Review the Task", systemPrompt: "Return a complete Review object",
      }));
    } catch (error) {
      assert.ok(error instanceof ReviewProtocolFailure);
      const failure = classifyReviewCommandError(error, "impl");
      return { ok: false, status: 1, stdout: "", stderr: failure.toMarkerLine(), signal: null, killed: false };
    }
    assert.fail("invalid responses must not return a successful worker result");
  };
}

async function recoverFromNonRetryableProtocolFailure(scenario) {
  const previousAttempt = scenario.state().attempt;
  const previousBaseline = baseline(scenario);
  assert.notEqual(previousBaseline, null, "the failed Review Attempt must retain its recovery baseline");
  let calls = 0;
  const failed = await scenario.review(invalidProtocolWorker(scenario, "[]", () => { calls += 1; })).execute(scenario.context());
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(calls, 2, "the protocol's bounded provider attempts must complete before parent persistence");
  scenario.reload();
  assert.equal(scenario.state().attempt.failure.code, "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE");
  assert.equal(scenario.state().attempt.failure.retryable, false);
  assert.equal(scenario.state().attempt.consumption.semantic, 0);
  scenario.changeEvidence(1).reload();
  const recovered = scenario.recover();
  assert.equal(recovered.reset, true, JSON.stringify(recovered));
  assert.equal(recovered.grants[0].operation, "retry_recovery_attempt");
  scenario.reload();
  const receipt = recoveryReceipt(scenario);
  const currentAttempt = scenario.state().attempt;
  assert.equal(receipt.previous.equals(previousBaseline), true, "receipt must bind the persisted baseline of the failed Attempt");
  assert.equal(receipt.current.attemptId, currentAttempt.id);
  assert.equal(receipt.current.attempt, currentAttempt.sequence);
  assert.notEqual(currentAttempt.id, previousAttempt.id);
  assert.equal(currentAttempt.sequence, previousAttempt.sequence + 1);
  assert.equal(currentAttempt.consumption.semantic, previousAttempt.consumption.semantic);
  assert.equal(currentAttempt.failure, null);
}

test("review recovery retains a usable baseline through two failures and fresh Store instances", (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  const original = scenario.state().attempt.id;
  scenario.changeEvidence(1).reload();
  const first = scenario.recover();
  assert.equal(first.reset, true, JSON.stringify(first));
  const recovered = scenario.state().attempt.id;
  assert.notEqual(recovered, original);
  scenario.reload().fail().changeEvidence(2).reload();
  const second = scenario.recover();
  assert.equal(second.reset, true, JSON.stringify(second));
  assert.equal(second.grants[0].operation, "retry_recovery_attempt");
  scenario.reload();
  assert.notEqual(scenario.state().attempt.id, recovered);
  assert.equal(baseline(scenario).attemptId, scenario.state().attempt.id);
  assert.equal(scenario.state().attempt.failure, null);
});

test("tooling recovery contributes zero completed Review results after reload", (t) => {
  const scenario = new TaskReviewScenario(t).exhaust().changeEvidence(1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const facts = ReviewTransitionFacts.forCurrentAttempt({
    flowManager: scenario.manager, flowState: scenario.context().flowState,
    typedState: scenario.state(), scope: "task", phase: "impl",
  });
  assert.equal(facts.attemptCount, 0, "tooling Attempts are not semantic Review results");
  assert.equal(facts.verdict, null);
});

test("parent serializes semantic Review ordinal independently of tooling Attempt sequence", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);

  // A semantic reject is published by Review, then the separate Task stages
  // resolve it.  Review itself must never repair the source.
  const first = await scenario.publishReview([{
    findingKey: "repair-1", title: "Repair 1", failureMode: "spec_behavior_contradiction",
    file: "README.md", requirementId: "R-1", issue: "Missing behavior 1",
    suggestion: "Correct the implementation.", disposition: "must-fix",
    rationale: "R-1 requires this behavior.",
  }]);
  assert.notEqual(first.ok, false, JSON.stringify(first));
  const triage = scenario.stageHandoff("triage");
  assert.equal(scenario.completeHandoff(triage, {
    version: 1, stepId: "task-triage", completionStatus: "done", issues: [], overview: null,
    triage: { version: 1, dispositions: [{ findingKey: "repair-1", disposition: "apply", basis: "repair-required", rationale: "R-1 requires the missing behavior." }] },
    repair: null, noChangeReason: null,
  }).completed, true);
  const repair = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "repaired behavior\n");
  assert.equal(scenario.completeHandoff(repair, {
    version: 1, stepId: "task-repair", completionStatus: "done", issues: [], overview: null,
    triage: null,
    repair: { version: 1, findings: [{ findingKey: "repair-1", paths: ["README.md"] }], summary: "Implemented the missing behavior.", recurrenceResolutions: [] },
    noChangeReason: null,
  }).completed, true);
  scenario.reload();

  // A retryable worker interruption increments its Attempt sequence without
  // inventing a second completed Review result.
  const interrupted = await scenario.review(() => {
    const failure = new Error("retryable provider interruption before output");
    failure.code = "REVIEW_PROVIDER_UNAVAILABLE";
    failure.retryable = true;
    throw failure;
  }).execute(scenario.context());
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted));
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  scenario.reload();
  let received;
  const review = scenario.review((_command, _args, options) => {
    received = TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY));
    return { ok: false, status: 1, stdout: "", stderr: "deterministic boundary stop", signal: null, killed: false };
  });
  await review.execute(scenario.context());
  assert.ok(received instanceof TaskReviewExecutionIdentity, "parent must reach the worker boundary");
  assert.equal(received.reviewAttempt, 2, "worker must receive the second semantic Review, not the raw sequence");
  assert.equal(received.attempt.id, scenario.state().attempt.id);
  assert.ok(received.attempt.sequence > received.reviewAttempt);
});

test("unchanged exhausted recovery refuses without changing canonical state", (t) => {
  const scenario = new TaskReviewScenario(t).exhaust().reload();
  const before = scenario.snapshot();
  const result = scenario.recover();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "INVALID_RECOVERY_INPUT");
  assert.match(result.errors[0].messages.join(" "), /changed evidence must differ/);
  assert.equal(scenario.snapshot(), before);
});

for (const invalid of ["[]", "{not-json}"]) {
  test(`protocol ${invalid} failure persists through the parent boundary and reload`, async (t) => {
    const scenario = new TaskReviewScenario(t);
    useScenarioContainer(t, scenario);
    let calls = 0;
    const review = scenario.review(invalidProtocolWorker(scenario, invalid, () => { calls += 1; }));
    const result = await review.execute(scenario.context());
    assert.equal(calls, 2, JSON.stringify(result));
    assert.equal(result.ok, false);
    scenario.reload();
    assert.equal(scenario.state().attempt.failure.code, "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE");
    assert.equal(scenario.state().attempt.failure.retryable, false);
    assert.equal(scenario.state().attempt.consumption.semantic, 0);
    assert.equal(scenario.state().current.at(-1), "T-1-review");
    const before = scenario.snapshot();
    scenario.reload();
    assert.equal(scenario.snapshot(), before);
    assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "implemented source\n");
  });
}

// Arbitrary provider edits are not owned by the generic protocol. Invalid
// output with effects must stop; shape-valid output still needs parent ownership
// admission. These replace the unsupported rollback-and-retry expectations.
for (const response of ["invalid", "unowned"]) {
test(`${response} Review source effects stop without publication or implicit rollback after reload`, async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  let calls = 0;
  const beforeAttempt = scenario.state().attempt;
  const beforeLineages = scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId });
  const extra = path.join(scenario.root, "unexpected.txt");
  const mutate = () => {
    calls += 1;
    fs.writeFileSync(scenario.sourcePath, "unaccepted partial edit\n");
    if (response === "invalid") fs.writeFileSync(extra, "unowned source\n");
  };
  const worker = response === "invalid"
    ? invalidProtocolWorker(scenario, "[]", mutate)
    : repairingWorker(scenario, 1, { repair: false, onProviderCall: mutate });
  const result = await scenario.review(worker).execute(scenario.context());
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(calls, 1, "neither protocol nor parent may silently retry unaccepted source effects");
  scenario.reload();
  const state = scenario.state();
  assert.equal(state.attempt.id, beforeAttempt.id);
  assert.equal(state.attempt.nodeId, "T-1-review");
  assert.equal(state.attempt.consumption.semantic, beforeAttempt.consumption.semantic);
  if (response === "invalid") {
    assert.equal(state.attempt.failure.code, "TASK_REVIEW_SOURCE_EFFECT_OBSERVED");
    assert.equal(state.attempt.failure.retryable, false);
    assert.equal(fs.readFileSync(extra, "utf8"), "unowned source\n");
  } else {
    assert.match(state.attempt.failure.message, /zero-effect worker boundary/);
  }
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "unaccepted partial edit\n");
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "task.review"), false);
  assert.deepEqual(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }), beforeLineages);
  assert.equal(state.findNode("T-1-gate").status, "pending");
  const stopped = scenario.snapshot();
  scenario.reload();
  assert.equal(scenario.snapshot(), stopped, "fresh readers must retain the same failed Attempt and no success publication");
  assert.throws(() => scenario.manager.retryCurrentAttempt({ specId: scenario.specId }), {
    code: "CURRENT_FLOW_STATE_INVARIANT_INVALID",
  });
  assert.equal(scenario.reload().snapshot(), stopped, "refused retry must not adopt unaccepted edits");
  scenario.changeEvidence(1).reload();
  const recovery = scenario.recover();
  assert.equal(recovery.ok, false, "changed evidence must not make unaccepted source effects recoverable");
  assert.equal(recovery.errors[0].code, "RETRY_NOT_AVAILABLE");
  assert.equal(scenario.reload().snapshot(), stopped, "changed runtime evidence cannot authorize unaccepted source effects");
  const refused = await scenario.review(() => { calls += 1; return stoppedWorker(); }).execute(scenario.context());
  assert.equal(refused.ok, false);
  assert.equal(calls, 1, "blocked source effects must not reach another worker invocation");
  assert.equal(scenario.reload().snapshot(), stopped);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "unaccepted partial edit\n");
  assert.equal(state.attempt.failure.category, "source-integrity");
  assert.equal(state.attempt.failure.retryable, false);
  assert.equal(state.attempt.failure.retryKind, null);
  assert.equal(state.failureDisposition().operation, "blocked");
});
}

test("admitted Task Review retains a baseline before any provider can fail", (t) => {
  const scenario = new TaskReviewScenario(t).reload();
  const durable = baseline(scenario);
  assert.notEqual(durable, null, "all legal Task Review entry paths must preserve the later recovery prerequisite");
  assert.equal(durable.attemptId, scenario.state().attempt.id);
  assert.equal(durable.attempt, scenario.state().attempt.sequence);
});

test("a receipt-authorized committed runtime change reconciles an unsealed Review after reload", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  // This contract compares a recovery-time target with a later invocation;
  // use RunReview's production target resolver, not the fixture's constant.
  const runtimeIdentity = { resolveTargetStateDigest: undefined };
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  let previousDirectory;
  await scenario.review((_command, _args, options) => {
    previousDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
    return stoppedWorker();
  }, runtimeIdentity).execute(scenario.context());
  assert.ok(fs.existsSync(previousDirectory));
  commitRuntimeEvidence(scenario, 2);
  const grant = scenario.reload().recover();
  assert.equal(grant.reset, true, JSON.stringify(grant));
  scenario.reload();
  let calls = 0;
  const result = await scenario.review(() => { calls += 1; return stoppedWorker(); }, runtimeIdentity).execute(scenario.context());
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(fs.existsSync(previousDirectory), false, "accepted old work unit must be reconciled");
  assert.notEqual(scenario.state().attempt.failure.code, "TASK_REVIEW_PARTIAL_EFFECT");
});

test("an ordinary retry cannot authorize committed changes to an unsealed Review", async (t) => {
  const scenario = new TaskReviewScenario(t);
  let previousDirectory;
  await scenario.review((_command, _args, options) => {
    previousDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
    const failure = new Error("retryable provider interruption before output");
    failure.code = "REVIEW_PROVIDER_UNAVAILABLE";
    failure.retryable = true;
    throw failure;
  }).execute(scenario.context());
  assert.equal(scenario.state().failureDisposition().operation, "retry");
  commitRuntimeEvidence(scenario, 1);
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  scenario.reload();
  let calls = 0;
  const result = await scenario.review(() => { calls += 1; return stoppedWorker(); }).execute(scenario.context());
  assert.equal(calls, 0);
  assert.equal(result.data.failureCode, "TASK_REVIEW_PARTIAL_EFFECT");
  assert.equal(fs.existsSync(previousDirectory), true);
  const state = scenario.reload().state();
  const stopped = scenario.snapshot();
  assert.equal(state.attempt.failure.category, "source-integrity");
  assert.equal(state.attempt.failure.retryKind, null);
  assert.equal(state.failureDisposition().operation, "blocked");
  assert.throws(() => scenario.manager.retryCurrentAttempt({ specId: scenario.specId }));
  scenario.changeEvidence(2);
  const recovery = scenario.recover();
  assert.equal(recovery.ok, false);
  assert.equal(recovery.errors[0].code, "RETRY_NOT_AVAILABLE");
  assert.equal(scenario.reload().snapshot(), stopped);
  await scenario.review(() => { calls += 1; return stoppedWorker(); }).execute(scenario.context());
  assert.equal(calls, 0, "partial effects remain blocked across re-entry");
  assert.equal(fs.existsSync(previousDirectory), true);
});

test("published PASS is admitted by Gate after all parent objects are discarded", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  const result = await publishPassingTaskReview(scenario);
  assert.equal(result.artifacts.verdict, "PASS");
  scenario.reload();
  assert.equal(scenario.state().nextAction().nodeId, "T-1-gate");
  const next = await new GetNextActionCommand().execute(scenario.context());
  assert.equal(next.directive.kind, "execute_step");
  assert.equal(next.step, "task-gate");
  assert.equal(next.action, "run-gate");
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
});

test("invalidated Review recovery preserves the baseline required by a later tooling failure", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  await completePassingTask(scenario);
  // Terminal-node rewind is an existing Store production API. It invalidates
  // downstream leaves; completing implementation then claims Review via recover.
  scenario.reload();
  assert.equal(scenario.state().current, null);
  scenario.manager.rewindTo("T-1-impl", { specId: scenario.specId });
  scenario.confirmImplementation("revised implementation\n").reload();
  const introduced = scenario.manager.activityLedger(scenario.specId).findLast((entry) => entry.attemptId === scenario.state().attempt.id);
  assert.equal(introduced.transition.operation, "recover_attempt");
  const durable = baseline(scenario);
  assert.notEqual(durable, null, "recover_attempt must not omit the baseline required after a tooling failure");
  assert.equal(durable.attemptId, scenario.state().attempt.id);
  await recoverFromNonRetryableProtocolFailure(scenario);
});

test("rewindTo directly recovers an invalidated Review with its baseline", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  await completePassingTask(scenario);
  scenario.reload();
  scenario.manager.rewindTo("T-1-impl", { specId: scenario.specId });
  scenario.confirmImplementation("revised implementation without claim\n", { claimReview: false }).reload();
  assert.equal(scenario.state().current, null);
  assert.equal(scenario.state().findNode("T-1-review").status, "invalidated");

  scenario.manager.rewindTo("T-1-review", { specId: scenario.specId });
  scenario.reload();
  assert.equal(scenario.manager.activityLedger(scenario.specId).at(-1).transition.operation, "recover_attempt");
  const durable = baseline(scenario);
  assert.notEqual(durable, null, "direct recover must publish the replacement Attempt baseline in the same transaction");
  assert.equal(durable.attemptId, scenario.state().attempt.id);
  await recoverFromNonRetryableProtocolFailure(scenario);
});

test("direct Review rewind atomically starts its replacement baseline", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  await completePassingTask(scenario);
  scenario.reload();
  assert.equal(scenario.state().current, null);

  scenario.manager.rewindTo("T-1-review", { specId: scenario.specId });
  scenario.reload();
  assert.equal(scenario.manager.activityLedger(scenario.specId).at(-1).transition.operation, "rewind");
  const durable = baseline(scenario);
  assert.notEqual(durable, null, "a direct rewind must publish the replacement Attempt baseline in the same transaction");
  assert.equal(durable.attemptId, scenario.state().attempt.id);
  assert.equal(durable.attempt, scenario.state().attempt.sequence);
  await recoverFromNonRetryableProtocolFailure(scenario);
});

test("completed Task Gate rewinds without fabricating PASS retry evidence", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  await completePassingTask(scenario);
  scenario.reload();
  assert.equal(scenario.state().current, null);

  scenario.manager.rewindTo("T-1-gate", { specId: scenario.specId });
  scenario.reload();
  assert.equal(scenario.manager.activityLedger(scenario.specId).at(-1).transition.operation, "rewind");
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
  assert.equal(baseline(scenario), null, "a passed Gate has no semantic failure source to turn into retry evidence");
});
