import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { RunGateCommand } from "../../../src/flow/lib/run-gate.js";
import { taskReviewReadiness } from "../../../src/flow/lib/gate-transition-facts.js";
import { GateReviewFindingReadiness } from "../../../src/flow/lib/gate-transition.js";
import { TaskMutationLineage, TaskExecutionBudget } from "../../../src/flow/lib/task-mutation-lineage.js";
import { readRetryBaseline, RetryRecoveryReceipt, retryEvidenceRouteForNode } from "../../../src/flow/lib/retry-recovery.js";
import { ReviewTransitionFacts } from "../../../src/flow/lib/review-transition-facts.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { runTaskReviewProtocol, classifyReviewCommandError, parseImplReviewFindings, formatImplReviewJson } from "../../../src/flow/commands/review.js";
import { ReviewProtocolFailure } from "../../../src/flow/lib/review-protocol.js";
import { container } from "../../../src/lib/container.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
  reconcileCompletedReviewWorkUnits,
} from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { TaskReviewFailureFacts, resolveTaskReviewFailure } from "../../../src/flow/definition.js";

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

async function completeTaskGate(scenario) {
  const provider = installGateProviderFake((_prompt, options) => {
    const required = options.jsonSchema?.required ?? [];
    if (required.includes("evaluations")) {
      const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum ?? [];
      return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({
        guardrail_id, result: "pass", reason: "The source satisfies the mapped scenario requirement.",
      })) });
    }
    return JSON.stringify({ observations: [], ...(required.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
  });
  try {
    const ctx = { ...scenario.context(), phase: "task-impl" };
    const result = await new RunGateCommand().execute(ctx);
    assert.equal(result.result, "pass", JSON.stringify(result));
    await FLOW_COMMANDS.run.gate.post(ctx, result);
  } finally {
    provider.mock.restore();
  }
}

// A published PASS now prepares Gate atomically. Complete that active Gate
// before exercising rewind from a terminal Task, preserving the recovery scenario.
async function completePassingTask(scenario) {
  await publishPassingTaskReview(scenario);
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
  await completeTaskGate(scenario);
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
  const failed = await scenario.review(() => {
    calls += 1;
    const error = new Error("unknown internal fixture failure");
    error.code = "INTERNAL_REVIEW_FIXTURE_FAILURE";
    error.retryable = false;
    throw error;
  }).execute(scenario.context());
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(calls, 1);
  scenario.reload();
  assert.equal(scenario.state().attempt.failure.code, "INTERNAL_REVIEW_FIXTURE_FAILURE");
  assert.equal(scenario.state().attempt.consumption.semantic, 0);
  scenario.changeEvidence(1).reload();
  const recovered = scenario.recover();
  assert.equal(recovered.reset, true, JSON.stringify(recovered));
  assert.equal(recovered.grants[0].operation, "retry_recovery_attempt");
  scenario.reload();
  const receipt = recoveryReceipt(scenario);
  const currentAttempt = scenario.state().attempt;
  assert.equal(receipt.previous.equals(previousBaseline), true);
  assert.equal(receipt.current.attemptId, currentAttempt.id);
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
  assert.equal((await scenario.filter([])).ok, true);
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
  const unavailable = await review.execute(scenario.context());
  assert.ok(received instanceof TaskReviewExecutionIdentity, "parent must reach the worker boundary");
  assert.equal(received.reviewAttempt, 2, "worker must receive the second semantic Review, not the raw sequence");
  assert.equal(received.attempt.nodeId, "T-1-review");
  assert.ok(received.attempt.sequence > received.reviewAttempt);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
  const finalState = scenario.state();
  const handoff = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state: finalState,
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: finalState.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  }).handoffs().map((entry) => entry.toJSON()).find((entry) => entry.unavailable === true);
  assert.equal(handoff.semanticReviewCount, 1, "unavailable publication preserves prior semantic Review results");
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
  test(`protocol ${invalid} failure publishes unavailable evidence and continues to Gate after reload`, async (t) => {
    const scenario = new TaskReviewScenario(t);
    useScenarioContainer(t, scenario);
    let calls = 0;
    const review = scenario.review(invalidProtocolWorker(scenario, invalid, () => { calls += 1; }));
    const result = await review.execute(scenario.context());
    assert.equal(calls, 2, JSON.stringify(result));
    assert.equal(result.ok, false);
    scenario.reload();
    assert.equal(scenario.state().attempt.failure, null);
    assert.equal(scenario.state().attempt.consumption.semantic, 0);
    assert.equal(scenario.state().current.at(-1), "T-1-gate");
    const state = scenario.state();
    const convergence = new TaskReviewConvergenceEvidence({
      flowManager: scenario.manager, state,
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
    });
    const handoff = convergence.handoffs().map((entry) => entry.toJSON()).find((entry) => entry.unavailable === true);
    assert.equal(handoff.failure.code, "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE");
    assert.equal(handoff.semanticReviewCount, 0);
    assert.deepEqual(handoff.findings, []);
    assert.equal(handoff.unreviewedFindings, false);
    assert.deepEqual(convergence.status().find((entry) => entry.taskId === scenario.taskId), {
      taskId: scenario.taskId, reviewAttempts: 0, recurringFindings: [], fourthRepairUnreviewed: false,
      unavailable: true, remainingRisk: handoff.remainingRisk, finalVerdict: null,
    });
    const before = scenario.snapshot();
    scenario.reload();
    assert.equal(scenario.snapshot(), before);
    assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "implemented source\n");
  });
}

test("Definition refuses to continue an unknown internal Review failure", () => {
  const decision = resolveTaskReviewFailure(new TaskReviewFailureFacts({
    taskReview: true, sourceIntegrityFailure: false, workerStopped: true,
    canonicalEvidenceAvailable: true, retryable: false, code: "INTERNAL_INVARIANT_BROKEN", message: "unexpected invariant",
  }));
  assert.equal(decision.facts.category, "internal");
  assert.equal(decision.disposition, "stop");
});

test("a stopped Task Review with an invalid sealed transport converges without a semantic result", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  const result = await scenario.review(() => ({
    ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false,
  })).execute(scenario.context());
  assert.equal(result.ok, false);
  assert.equal(result.data.failureCode, "SCHEMA_FAILURE");
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
  assert.equal(scenario.state().attempt.consumption.semantic, 0);
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "task.review"), false);
});

test("a later semantic Review in the same cycle supersedes unavailable Acceptance evidence", async (t) => {
  const scenario = new TaskReviewScenario(t);
  useScenarioContainer(t, scenario);
  let interruptedManifest = null;
  let interruptedManifestPath = null;
  const unavailable = await scenario.review((_command, _args, options) => {
    interruptedManifestPath = options.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
    interruptedManifest = fs.readFileSync(interruptedManifestPath);
    return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
  }).execute(scenario.context());
  // Recreate the exact unsealed surface to model interruption after the
  // canonical unavailable commit but before transient cleanup.
  fs.mkdirSync(path.dirname(interruptedManifestPath), { recursive: true });
  fs.writeFileSync(interruptedManifestPath, interruptedManifest);
  scenario.reload();
  const untouched = scenario.snapshot();
  const readiness = new GateReviewFindingReadiness(taskReviewReadiness({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId,
  }));
  assert.equal(readiness.status, "unavailable");
  assert.equal(readiness.allowsPass, false, "unavailable evidence cannot claim a successful semantic Review");
  assert.equal(readiness.allowsGatePass, true, "the authenticated unavailable branch still permits the actual Gate");
  assert.equal(readiness.unavailable.semanticReviewCount, 0);
  assert.equal(scenario.snapshot(), untouched);
  const actualLedger = scenario.manager.activityLedger(scenario.specId);
  const sourceRow = actualLedger.findLast((entry) => entry.result?.stepResult?.kind === "task-review-unavailable");
  const alteredReader = (overrides) => new Proxy(scenario.manager, {
    get(target, name) {
      if (overrides[name]) return overrides[name];
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (const alter of [
    (rows) => rows.filter((entry) => entry.id !== sourceRow.id),
    (rows) => rows.map((entry) => {
      if (entry.id === sourceRow.id) entry.result.draftSettlementReceipt.resultDigest = "0".repeat(64);
      return entry;
    }),
    (rows) => rows.map((entry) => {
      if (entry.id === sourceRow.id) entry.sequence += 1;
      return entry;
    }),
  ]) {
    const reader = alteredReader({ activityLedger: () => alter(structuredClone(actualLedger)) });
    assert.throws(() => taskReviewReadiness({ flowManager: reader, state: scenario.state(), taskId: scenario.taskId }));
    assert.equal(scenario.snapshot(), untouched, "altered unavailable provenance must produce zero effects");
  }
  const oldRound = alteredReader({ taskMutationLineages: (input) => scenario.manager.taskMutationLineages(input)
    .map((lineage) => new TaskMutationLineage({ ...lineage.toJSON(),
      budget: new TaskExecutionBudget({ ...lineage.budget.toJSON(), round: 2 }) })) });
  assert.throws(() => taskReviewReadiness({ flowManager: oldRound, state: scenario.state(), taskId: scenario.taskId }));
  assert.equal(scenario.snapshot(), untouched);
  const sourceBytes = fs.readFileSync(scenario.sourcePath);
  try {
    fs.appendFileSync(scenario.sourcePath, "unreviewed source alteration\n");
    assert.throws(() => taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId }));
    assert.equal(scenario.snapshot(), untouched);
  } finally {
    fs.writeFileSync(scenario.sourcePath, sourceBytes);
  }
  await completeTaskGate(scenario);
  scenario.reload();
  assert.equal(reconcileCompletedReviewWorkUnits({
    flowManager: scenario.manager, specId: scenario.specId, executionRoot: scenario.root,
  }), 1);
  scenario.manager.rewindTo("T-1-review", { specId: scenario.specId });
  scenario.reload();
  await publishPassingTaskReview(scenario);
  scenario.reload();
  const state = scenario.state();
  const convergence = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state,
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  });
  assert.equal(convergence.handoffs().some((entry) => entry.unavailable === true), false);
  assert.equal(convergence.status().some((entry) => entry.unavailable === true), false);
});

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

test("second-round unavailable Review retains first-round must-fix obligations and blocks a nominal Gate PASS", async (t) => {
  const scenario = new TaskReviewScenario(t, { noChange: true });
  useScenarioContainer(t, scenario);
  const finding = {
    findingKey: "retained-requirement", title: "Required behavior remains unresolved",
    failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
    issue: "The mapped behavior requires a source correction.", suggestion: "Implement the required behavior.",
    disposition: "must-fix", rationale: "The mapped requirement is mandatory.",
  };
  assert.notEqual((await scenario.publishReview([finding])).ok, false);
  const initial = new TaskReviewConvergenceEvidence({ flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: scenario.state().runId,
      activities: scenario.manager.activityLedger(scenario.specId) }) });
  const fingerprint = initial.record(scenario.taskId).review.document.blockingFindings[0].fingerprint;
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-impl");
  scenario.confirmImplementation("second round source correction\n").reload();
  assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1).budget.round, 2);
  const unavailable = await scenario.review(() => ({
    ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false,
  })).execute(scenario.context());
  assert.equal(unavailable.ok, false);
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
  const facts = new GateReviewFindingReadiness(taskReviewReadiness({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId,
  }));
  assert.equal(facts.status, "blocking");
  assert.equal(facts.allowsPass, false);
  assert.equal(facts.allowsGatePass, false);
  assert.equal(facts.unavailable.taskRound, 2);
  assert.equal(facts.unavailable.semanticReviewCount, 0);
  assert.deepEqual(facts.findingFingerprints, [fingerprint]);
  await completeTaskGate(scenario);
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "T-1-gate");
  assert.ok(scenario.state().attempt.failure);
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "task-gate" });
  assert.equal(saved.result.type, "error");
  assert.equal(saved.receipt.settlementKind, "failure");
  const convergence = new TaskReviewConvergenceEvidence({ flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: scenario.state().runId,
      activities: scenario.manager.activityLedger(scenario.specId) }) });
  assert.ok(convergence.record(scenario.taskId));
  const risk = convergence.handoffs().find((entry) => entry.unavailable === true).toJSON();
  assert.equal(risk.semanticReviewCount, 0);
  assert.equal(risk.binding.taskId, scenario.taskId);
  assert.equal(risk.unavailable, true);
  assert.equal(convergence.record(scenario.taskId).history.attempts.length, 1);
});
