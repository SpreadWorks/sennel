import "./requirement-test-save-recovery.contract.js";
import "./requirement-test-stale-admission.contract.js";
import "./requirement-test-error-admission.contract.js";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import path from "node:path";
import RunRetroCommand from "../../../src/flow/lib/run-retro.js";
import RunAcceptanceReviewCommand, { AcceptanceReviewResponseSource } from "../../../src/flow/lib/run-acceptance-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { attachedCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import SetAutoCommand from "../../../src/flow/lib/set-auto.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { RequirementTestArtifactStore } from "../../../src/flow/lib/requirement-test-store.js";
import { prepareCommonRequirementTestError } from "../../support/requirement-test-save-boundary.js";
import { RequirementTestPhaseScenario, requirementTestSource, rejectFirstRequirementReview, rejectFirstRequirementReviewBatches } from "../../support/requirement-test-phase-scenario.js";
import { assertRequirementTestResultRoundtrip } from "../../support/assertions/requirement-test-result.js";
import { TEST_REVIEW_REPAIR_BATCH_LIMITS, canonicalTestReviewRepairForTarget, canonicalTestReviewRepairProgress } from "../../../src/flow/lib/test-review-repair.js";
import { FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { CanonicalSpecApproval } from "../../../src/flow/lib/canonical-spec-approval.js";
import { acquireApprovalInput } from "../../../src/flow/engine/composition/test.js";
import SetAcceptanceDecisionCommand from "../../../src/flow/lib/set-acceptance-decision.js";

function requirement(id, expectation = "fail") {
  return { id, desc: `Observe ${id} behavior.`, task_ids: ["T1"], preimplementation_test_expectation: expectation };
}

function wrongRequirementOwnershipSource(id) {
  return `// spec: ${id}\nimport test from 'node:test';\ntest('R9: incorrectly assigned behavior', () => {});\n`;
}

async function approved(t, options = {}) {
  const scenario = RequirementTestPhaseScenario.create(t, options);
  await scenario.advanceTo("approval");
  if (options.autoApprove) {
    await scenario.advanceTo(options.requirements?.every((entry) => entry.testable === false) ? "implement" : "test-generate");
  } else {
    const awaiting = await scenario.dispatch(8);
    assert.equal(awaiting.dispatch?.boundary, "approval_required", JSON.stringify(awaiting));
    await scenario.approve();
  }
  return scenario;
}

async function assertImplementationConsumer(scenario) {
  scenario.reload();
  assert.equal(scenario.current(), "implement");
  const saved = JSON.parse(scenario.artifact("spec.record").bytes);
  const approval = structuredClone(saved.user_approval);
  await scenario.dispatch(4);
  assert.ok(scenario.implementationInput, "the real implement entry must construct its worker input from persisted artifacts");
  assert.deepEqual(scenario.implementationInput.document.requirements, saved.requirements);
  assert.deepEqual(JSON.parse(scenario.artifact("spec.record").bytes).user_approval, approval);
}

function assertSavedResult(scenario, stepId, kind, expectedSettlement = null) {
  const matches = scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === stepId && entry.result?.stepResult?.kind === kind);
  assert.ok(matches.length > 0, `production ${stepId} must atomically save ${kind} with its publication/receipt/Activity`);
  return matches.map((activity) => {
    const checked = assertRequirementTestResultRoundtrip(stepId, activity.result.stepResult,
      scenario.evidenceFor(activity), expectedSettlement);
    assert.ok(activity.attemptId);
    assert.ok(activity.sequence > 0);
    return { activity, ...checked };
  });
}

async function persistCommonStepError(scenario, stepId) {
  const { prepared, service } = await prepareCommonRequirementTestError(scenario, stepId);
  const result = await prepared.step.execute();
  return { result, outcome: service.settlementOutcome };
}

function publishedCommand(scenario, logicalKey) {
  return new CanonicalTestArtifactStore({ flowManager: scenario.manager,
    state: scenario.manager.loadReadOnly(scenario.specId) }).readCurrentAttempt({ logicalKey, consumerNodeId: scenario.current() }).payload;
}

function assertReviewPublication(scenario, candidate, verdict) {
  const review = publishedCommand(scenario, "test.requirement.review");
  assert.equal(review.requirementId, candidate.bundle.requirementId);
  assert.equal(review.candidateDigest, candidate.digest);
  assert.equal(review.bundleRevision, candidate.bundle.revision);
  assert.deepEqual(review.specRevision, candidate.bundle.specRevision.toJSON());
  assert.deepEqual(review.sourceAttempt, candidate.bundle.lineage.sourceAttempt.toJSON());
  assert.equal(review.verdict, verdict);
  assert.match(review.canonicalEvidence.identity.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.match(review.workerOutput.digest, /^[a-f0-9]{64}$/);
  assert.ok(review.workerOutput.byteLength > 0);
}

function assertGatePublication(scenario, candidate, kind) {
  const gate = publishedCommand(scenario, "test.requirement.gate");
  assert.equal(gate.observation.requirementId, candidate.bundle.requirementId);
  assert.equal(gate.observation.candidateDigest, candidate.digest);
  assert.equal(gate.observation.bundleRevision, candidate.bundle.revision);
  assert.deepEqual(gate.observation.specRevision, candidate.bundle.specRevision.toJSON());
  assert.deepEqual(gate.observation.sourceAttempt, candidate.bundle.lineage.sourceAttempt.toJSON());
  assert.equal(gate.observation.testName, `${candidate.bundle.requirementId}: required behavior`);
  assert.equal(gate.observation.kind, kind);
}

class MixedRequirementAcceptanceResponse extends AcceptanceReviewResponseSource {
  load(input) {
    const summary = input.evidence.testEvidence["test-execute-result.json"].summary;
    assert.equal(summary.find((entry) => entry.id === "R1").execution, "executed");
    assert.equal(summary.find((entry) => entry.id === "R2").execution, "deferred_no_active_test");
    return {
      requirementJudgments: input.evidence.requirements.map((requirement) => ({
        requirementId: requirement.id, status: requirement.id === "R1" ? "met" : "notVerifiable",
        requestRefs: ["flow.request"], requirementRefs: [`spec.json#${requirement.id}`],
        diffRefs: ["diff:src/implementation.js"], repairRefs: ["acceptance:no-repair"],
        testRefs: requirement.id === "R1" ? ["test-execute-result.json#R1"] : [],
        missingEvidence: requirement.id === "R1" ? [] : ["Requirement test remains deferred without an active test source."],
      })),
      deferredFindingDispositions: input.evidence.deferredFindingEvidence.map((entry) => ({
        findingId: entry.findingId, finalDisposition: "still_open", evidenceRefs: [entry.sourceRef],
      })),
    };
  }
}

async function consumeMixedDownstream(scenario) {
  // The current normal implementation entry and dynamic Task lifecycle execute
  // through dispatch. No arbitrary activate(), fixture completion or receipt import.
  await scenario.advanceTo("test-execute", 64);
  scenario.reload();
  const sources = new CanonicalTestArtifactStore({ flowManager: scenario.manager,
    state: scenario.manager.loadReadOnly(scenario.specId) }).testSources("test-execute");
  assert.deepEqual(sources.map((source) => path.basename(source.absolutePath)), ["r1.test.js"]);
  await scenario.advanceTo("test-result-review");
  scenario.reload();
  const executed = new CanonicalTestArtifactStore({ flowManager: scenario.manager,
    state: scenario.manager.loadReadOnly(scenario.specId) }).readCurrentAttempt({ logicalKey: "test.execute", consumerNodeId: "test-result-review" }).payload;
  assert.deepEqual(executed.summary.map(({ id, execution, result }) => ({ id, execution, result })), [
    { id: "R1", execution: "executed", result: "pass" },
    { id: "R2", execution: "deferred_no_active_test", result: "deferred" },
  ]);
  await scenario.advanceTo("retro", 64);
  scenario.reload();
  const context = { ...scenario.context(), phase: "retro" };
  const retro = await new RunRetroCommand().execute(context);
  assert.equal(retro.artifacts.summary.done, 1);
  assert.equal(retro.artifacts.summary.deferred_count, 1);
  await FLOW_COMMANDS.run.retro.post(context, retro);
  await scenario.advanceTo("acceptance-review");
  scenario.reload();
  const acceptanceContext = scenario.context();
  const acceptance = await new RunAcceptanceReviewCommand({ responseSource: new MixedRequirementAcceptanceResponse() }).execute(acceptanceContext);
  const result = attachedCanonicalCommandResultArtifact(acceptance).payload;
  assert.equal(result.verdict, "user_decision_required");
  assert.equal(result.requirementJudgments.find((entry) => entry.requirementId === "R2").status, "notVerifiable");
  assert.ok(result.deferredFindings.some((entry) => entry.finalDisposition === "still_open"));
  await FLOW_COMMANDS.run["acceptance-review"].post(acceptanceContext, acceptance);
  scenario.reload();
  assert.notEqual(scenario.current(), "finalize-commit", "auto approval never grants Acceptance authority");

  const decisionContext = scenario.context();
  new SetAcceptanceDecisionCommand().execute({ ...decisionContext, choice: "accept_risk_and_continue" });
  const reportArtifactInput = { specId: scenario.specId, logicalKey: "report", consumerNodeId: "report", optional: true };
  let reportArtifact = scenario.manager.readArtifact(reportArtifactInput);
  const reportDispatches = [];
  for (let index = 0; reportArtifact === null && index < 8; index += 1) {
    const dispatch = await scenario.dispatch();
    reportDispatches.push(dispatch);
    scenario.reload();
    assert.equal(dispatch.errors?.some((entry) => entry.code !== "FLOW_DISPATCH_LIMIT_REACHED") ?? false, false,
      JSON.stringify(dispatch.errors));
    reportArtifact = scenario.manager.readArtifact(reportArtifactInput);
  }
  const pendingReportAction = reportArtifact === null ? await scenario.next() : null;
  const finalRegression = reportArtifact === null
    ? new CanonicalTestArtifactStore({ flowManager: scenario.manager, state: scenario.manager.canonicalState(scenario.specId) })
      .readCurrentAttempt({ logicalKey: "final.regression", consumerNodeId: "final-regression", optional: true })?.payload ?? null
    : null;
  assert.ok(reportArtifact !== null,
    `the registered report consumer must publish its canonical artifact after the explicit Acceptance decision: ${JSON.stringify({ currentAction: scenario.current(), nextAction: { step: pendingReportAction?.step, directive: pendingReportAction?.directive?.kind }, finalRegression: finalRegression === null ? null : { result: finalRegression.result, failureKind: finalRegression.failureKind, failureCategory: finalRegression.failureCategory, failureSummary: finalRegression.failureSummary, command: finalRegression.command, exitCode: finalRegression.process?.exitCode, skipKind: finalRegression.skipKind }, dispatchCount: reportDispatches.length })}`);
  const report = JSON.parse(reportArtifact.bytes.toString("utf8"));
  assert.deepEqual({ total: report.data.tests.total, passed: report.data.tests.passed, failed: report.data.tests.failed },
    { total: 2, passed: 1, failed: 0 }, "report counts only the promoted Requirement as a passing test");
  assert.equal(report.data.retro.deferred_count, 1, "report retains the deferred Requirement obligation");
}

/** Outcome-to-condition graph is in requirement-test-phase-scenario-coverage.md.
 * Scenarios follow production producers through Review, Gate, and downstream consumers;
 * failure cases stop only at their documented boundary and never use fixture settlements.
 */
describe("Requirement Test phase production scenarios", { concurrency: false }, () => {
  it("keeps the Approval Action digest stable across canonical reread and clock advance", async (t) => {
    const scenario = RequirementTestPhaseScenario.create(t);
    await scenario.advanceTo("approval");
    const target = FlowDispatchTarget.captureContext({ ...scenario.context(), expectRunId: "run-requirement-phase" });
    const session = new FlowDispatchSession({ target });
    const action = await scenario.next();
    const original = session.captureAction(action, "stable-repository-fingerprint");
    scenario.reload();
    const now = Date.now();
    const clock = mock.method(Date, "now", () => now + 60_000);
    try {
      assert.equal(Date.now(), now + 60_000);
      const reread = await scenario.next();
      const restored = session.captureCanonicalAction(reread, original);
      assert.equal(restored.digest, original.digest);
      assert.equal(restored.hasCanonicalActionProgressedTo(original), false);
    } finally {
      clock.mock.restore();
    }
  });

  it("validates the approved Spec at the outer Approval acquisition boundary", async (t) => {
    const scenario = RequirementTestPhaseScenario.create(t);
    await scenario.advanceTo("approval");
    const state = scenario.manager.canonicalState(scenario.specId);
    const specRecord = scenario.manager.readArtifact({ specId: scenario.specId,
      logicalKey: "spec.record", consumerNodeId: "approval" });
    const review = scenario.manager.readCurrentSpecReview({ specId: scenario.specId,
      consumerNodeId: "approval" });
    const invalidSpec = JSON.parse(specRecord.bytes.toString("utf8"));
    invalidSpec.requirements[0].preimplementation_test_expectation = "maybe";
    const approval = new CanonicalSpecApproval({ confirmedAt: "2026-10-05T00:00:00.000Z" });
    assert.throws(() => acquireApprovalInput({ state, specDescriptor: specRecord.descriptor,
      spec: invalidSpec, review: review.review, approval }));
  });

  for (const stepId of ["approval", "test-generate", "test-review", "test-repair", "test-gate"]) {
    it(`persists the shared ${stepId} Error Result with its source binding and Failure receipt`, async (t) => {
      const scenario = stepId === "approval"
        ? RequirementTestPhaseScenario.create(t)
        : await approved(t, { ...(stepId === "test-repair" ? { reviewResponse: rejectFirstRequirementReview } : {}) });
      if (stepId === "approval") await scenario.advanceTo("approval");
      else if (scenario.current() !== stepId) await scenario.advanceTo(stepId);
      const priorState = scenario.manager.canonicalState(scenario.specId);
      const priorPlan = stepId === "approval" ? null : scenario.plan().toJSON();
      const { result, outcome } = await persistCommonStepError(scenario, stepId);
      scenario.reload();
      const failed = scenario.manager.canonicalState(scenario.specId);
      assert.equal(result.kind, `${stepId}-error`);
      assert.equal(result.type, "error");
      assert.equal(outcome.receipt.binding.attemptId, priorState.attempt.id);
      assert.equal(outcome.receipt.binding.attemptSequence, priorState.attempt.sequence);
      assert.equal(failed.attempt.id, priorState.attempt.id);
      assert.equal(failed.attempt.failure.code, "SEMANTIC_STEP_FAILURE");
      const activity = scenario.manager.activityLedger(scenario.specId).findLast((entry) => (
        entry.nodeId === stepId && entry.result?.stepResult?.kind === `${stepId}-error`));
      assert.ok(activity);
      assert.equal(activity.transition.operation, "fail_attempt");
      const [saved] = assertSavedResult(scenario, stepId, `${stepId}-error`, { kind: "failure" });
      assert.equal(saved.result.error.code, "SEMANTIC_STEP_FAILURE");
      if (stepId === "approval") {
        assert.equal(saved.result.evidence.attempt.id, priorState.attempt.id);
        assert.equal(saved.result.evidence.attempt.sequence, priorState.attempt.sequence);
      } else {
        assert.equal(saved.result.binding.attempt.id, priorState.attempt.id);
        assert.equal(saved.result.binding.leaf, stepId);
        assert.deepEqual(scenario.plan().toJSON(), priorPlan, "Failure does not advance the Requirement plan or budget");
      }
    });
  }

  it("reads the saved Review execution-required checkpoint before provider output and continues to Gate", async (t) => {
    let checkpoint = null;
    const scenario = await approved(t, { beforeReview(work, current) {
      const manifest = work.manifest();
      current.reload();
      assert.equal(current.artifact("test.requirement.review"), null,
        "execution-required precedes an accepted Review publication");
      const [saved] = assertSavedResult(current, "test-review", "test-review-execution-required",
        { kind: "execution" });
      assert.equal(saved.result.binding.attempt.id, manifest.attemptId);
      assert.equal(current.manager.canonicalState(current.specId).attempt.id, manifest.attemptId);
      assert.equal(current.plan().workItem("R1").status, "candidate_saved");
      checkpoint = { attemptId: manifest.attemptId, result: saved.result.toJSON() };
    } });
    await scenario.advanceTo("test-gate");
    scenario.reload();
    assert.ok(checkpoint, "the normal Review producer must expose its durable execution checkpoint");
    assert.equal(scenario.reviews.length, 1);
    const [accepted] = assertSavedResult(scenario, "test-review", "test-review-passed",
      { kind: "target-connection", targetStepId: "test-gate" });
    assert.equal(accepted.activity.attemptId, checkpoint.attemptId);
    assert.equal(scenario.plan().workItem("R1").status, "reviewed");
    assertReviewPublication(scenario, scenario.candidate("R1").candidate, "PASS");
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
  });

  // These are the existing classified-observation adapters used by dispatcher
  // failure settlement. They create the typed observation themselves from
  // canonical inputs. No provider exception, pre-Step claim failure, or Result
  // constructor is fabricated here; those are separate command contracts.
  for (const stepId of ["test-generate", "test-repair"]) {
    for (const external of [false, true]) {
      const kind = `${stepId}-${external ? "external-blocked" : "tooling-unavailable"}`;
      it(`persists classified ${kind} through its real adapter and selects the saved-only Settlement`, async (t) => {
        const scenario = await approved(t, { reviewResponse: rejectFirstRequirementReview });
        await scenario.advanceTo(stepId);
        const before = scenario.manager.canonicalState(scenario.specId);
        const priorPlan = scenario.plan().toJSON();
        const prior = scenario.plan().workItem("R1");
        const failure = { code: "REQUIREMENT_TEST_PROVIDER_AUTH_REQUIRED", message: "Provider authentication is required." };
        if (external) scenario.manager.completeRequirementTestExternalFailure({ specId: scenario.specId, failure });
        else scenario.manager.completeRequirementTestToolingFailure({ specId: scenario.specId, message: "Provider temporarily unavailable." });
        scenario.reload();
        const after = scenario.manager.canonicalState(scenario.specId);
        const item = scenario.plan().workItem("R1");
        assert.equal(scenario.current(), stepId);
        assert.equal(item.status, prior.status);
        assert.deepEqual(item.bundleRevision?.toJSON() ?? null, prior.bundleRevision?.toJSON() ?? null);
        assert.deepEqual(item.budget.toJSON(), { ...prior.budget.toJSON(), tooling: prior.budget.tooling + (external ? 0 : 1) });
        assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
        if (external) {
          assert.equal(after.attempt.id, before.attempt.id);
          assert.equal(after.attempt.failure.code, failure.code);
          assert.deepEqual(scenario.plan().toJSON(), priorPlan);
          assert.equal((await scenario.next()).directive.kind, "blocked");
        } else {
          assert.notEqual(after.attempt.id, before.attempt.id);
          assert.equal(after.attempt.sequence, before.attempt.sequence + 1);
        }
        const [saved] = assertSavedResult(scenario, stepId, kind,
          external ? { kind: "failure" } : { kind: "target-connection", targetStepId: stepId });
        assert.equal(saved.result.binding.attempt.id, before.attempt.id);
        assert.equal(saved.result.binding.attempt.sequence, before.attempt.sequence);
        assert.equal(saved.result.binding.requirementId, "R1");
        assert.deepEqual(saved.result.retryState.budget.toJSON(), prior.budget.toJSON(),
          "saved selection operands bind the source budget before its selected increment");
        if (external) {
          assert.equal(saved.settlement.error.code, failure.code);
          const stopped = scenario.snapshot();
          const calls = scenario.requests.length;
          await scenario.dispatch();
          assert.equal(scenario.requests.length, calls);
          assert.deepEqual(scenario.snapshot(), stopped);
        } else {
          await scenario.advanceTo("test-review");
          scenario.reload();
          assert.equal(scenario.plan().workItem("R1").budget.tooling, prior.budget.tooling + 1);
          assert.equal(scenario.plan().workItem("R1").status, "candidate_saved");
          assertSavedResult(scenario, stepId, `${stepId}-candidate-saved`,
            { kind: "target-connection", targetStepId: "test-review" });
        }
      });
    }
  }

  it("saves the actual Gate tooling observation and retries the same isolated candidate after reload", async (t) => {
    // The existing Gate runner test establishes this named test's exit code 2
    // as tooling_failure. Keep the real process/classifier/publication path.
    const scenario = await approved(t, { testSource: (id) =>
      `// spec: ${id}\nimport test from 'node:test';\ntest('${id}: required behavior', () => {});\nprocess.exitCode = 2;\n`,
    });
    await scenario.advanceTo("test-gate");
    const before = scenario.manager.canonicalState(scenario.specId).attempt;
    const candidate = scenario.candidate("R1").candidate;
    const budget = scenario.plan().workItem("R1").budget.toJSON();
    await scenario.dispatch();
    scenario.reload();
    assert.equal(scenario.current(), "test-gate");
    assert.notEqual(scenario.manager.canonicalState(scenario.specId).attempt.id, before.id);
    assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.sequence, before.sequence + 1);
    assert.deepEqual(scenario.candidate("R1").candidate.toJSON(), candidate.toJSON());
    assert.deepEqual(scenario.plan().workItem("R1").budget.toJSON(), { ...budget, tooling: budget.tooling + 1 });
    assert.equal(scenario.plan().workItem("R1").status, "reviewed");
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
    assertGatePublication(scenario, candidate, "tooling_failure");
    const [saved] = assertSavedResult(scenario, "test-gate", "test-gate-tooling-unavailable",
      { kind: "target-connection", targetStepId: "test-gate" });
    assert.equal(saved.result.binding.attempt.id, before.id);
    assert.deepEqual(saved.result.retryState.budget.toJSON(), budget);
  });

  it("status reads the approved ordered plan across reload and a duplicate claim cannot invent another Attempt", async (t) => {
    const scenario = await approved(t, { requirements: [requirement("R1"), requirement("R2")] });
    await scenario.advanceTo("test-generate");
    const before = scenario.snapshot();
    const status = await new GetStatusCommand().execute(scenario.context());
    assert.deepEqual(status.requirementTestLifecycle, {
      activeRequirementId: "R1", semanticMode: "manual",
      requirements: ["R1", "R2"].map((requirementId) => ({
        requirementId, status: requirementId === "R1" ? "in_progress" : "pending", bundleRevision: null,
        semantic: { mode: "manual", attempts: 0, remaining: 5,
          auto: { attempts: 0, remaining: 5 }, manual: { attempts: 0, remaining: 5 } },
        tooling: { attempts: 0, remaining: 3 },
      })),
    });
    scenario.reload();
    assert.deepEqual((await new GetStatusCommand().execute(scenario.context())).requirementTestLifecycle,
      status.requirementTestLifecycle);
    const refused = await new RunClaimNextActionCommand().execute(scenario.context());
    assert.equal(refused.errors[0].code, "NEXT_ACTION_CLAIM_NOT_ADMITTED");
    assert.deepEqual(scenario.snapshot(), before,
      "status and a refused duplicate claim cannot create Activities, reset budgets or replace the active Attempt");
  });

  it("keeps unapproved Await across manager discard without creating test Attempts", async (t) => {
    const scenario = RequirementTestPhaseScenario.create(t);
    await scenario.advanceTo("approval");
    assert.equal((await scenario.dispatch(8)).dispatch?.boundary, "approval_required");
    const before = scenario.snapshot();
    scenario.reload();
    assert.equal((await scenario.dispatch(8)).dispatch?.boundary, "approval_required");
    assert.deepEqual(scenario.snapshot(), before, "an Await replay cannot create Activity or test work");
    assert.equal(scenario.requests.some((request) => request.stepId.startsWith("test-")), false);
    assertSavedResult(scenario, "approval", "approval-awaiting-user");
  });

  for (const autoApprove of [false, true]) {
    it(`${autoApprove ? "auto" : "manual"} approval with no testable R skips all four leaves without invented Attempts and reaches actual implement`, async (t) => {
      const tasks = [
        { id: "T-child-2", parent: "T1" }, { id: "T1", parent: null }, { id: "T-child-1", parent: "T1" },
      ].map((task) => ({ ...task, title: task.id, goal: `Complete ${task.id}.`, origin: "plan", added_round: 0, status: "pending" }));
      const scenario = await approved(t, { autoApprove, tasks,
        requirements: [{ id: "R1", desc: "Manual verification.", task_ids: tasks.map((task) => task.id), testable: false }] });
      const admitted = scenario.manager.canonicalState(scenario.specId);
      assert.deepEqual(admitted.findNode(admitted.definition.dynamicTaskContainerId).steps
        .filter((node) => node.kind === "task").map((node) => node.id),
      ["T1", "T-child-2", "T-child-1"], "approval uses parent-first stable sibling admission order");
      await assertImplementationConsumer(scenario);
      const state = scenario.manager.canonicalState(scenario.specId);
      for (const stepId of ["test-generate", "test-review", "test-repair", "test-gate"]) {
        const node = state.findNode(stepId);
        assert.equal(node.status, "skipped");
        assert.equal(node.attemptSequence, 0);
        assert.equal(scenario.manager.activityLedger(scenario.specId).some((entry) => entry.nodeId === stepId && entry.attemptId != null), false);
      }
      assertSavedResult(scenario, "approval", "approval-confirmed-without-tests");
    });
  }

  for (const { autoApprove, verdict } of [{ autoApprove: false, verdict: "PASS" }, { autoApprove: true, verdict: "ADVISORY" }]) {
    it(`${autoApprove ? "auto" : "manual"} approval stages multiple mixed R, ${verdict} → Gate → reload → actual implement input`, async (t) => {
      const scenario = await approved(t, { autoApprove,
        requirements: [requirement("R1"), { id: "R2", desc: "Manual review.", task_ids: ["T1"], testable: false }, requirement("R3", "pass")],
        reviewResponse: () => ({ verdict, blockingFindings: [], advisoryFindings: verdict === "ADVISORY" ? [{
          title: "Clarify assertion wording", target: "R1", improvement: "Use a clearer assertion message.",
          whyNonBlocking: "Advisory only.",
        }] : [] }),
      });
      const initialPlan = scenario.plan();
      assert.deepEqual(initialPlan.workItems.map((item) => item.requirementId), ["R1", "R3"]);
      await scenario.advanceTo("test-review");
      scenario.reload();
      assert.deepEqual(scenario.plan().workItems.map((item) => item.status), ["candidate_saved", "candidate_saved"]);
      assert.equal(new Set(scenario.requests.filter((entry) => entry.stepId === "test-generate").map((entry) => entry.requirementTestBinding.sourceAttempt.id)).size, 1, "non-final generation shares its claimed Attempt");
      const firstCandidate = scenario.candidate("R1").candidate;
      assert.equal(firstCandidate.bundle.lineage.predecessorRevision, null);
      await scenario.advanceTo("test-gate");
      assert.equal(scenario.plan().workItem("R1").status, "reviewed");
      assertReviewPublication(scenario, firstCandidate, verdict);
      assert.equal(scenario.requests.some((entry) => entry.stepId === "test-repair"), false);
      await scenario.dispatch();
      scenario.reload();
      assert.equal(scenario.current(), "test-review");
      assertGatePublication(scenario, firstCandidate, "assertion_failed");
      assert.deepEqual(scenario.plan().workItems.map((item) => item.status), ["promoted", "candidate_saved"]);
      await scenario.advanceTo("implement");
      assert.deepEqual(scenario.plan().workItems.map((item) => item.status), ["promoted", "promoted"]);
      await assertImplementationConsumer(scenario);
      assertSavedResult(scenario, "approval", "approval-confirmed-with-tests");
      assertSavedResult(scenario, "test-generate", "test-generate-candidate-saved");
      assertSavedResult(scenario, "test-review", verdict === "PASS" ? "test-review-passed" : "test-review-advisory");
      assertSavedResult(scenario, "test-gate", "test-gate-compatible");
    });
  }

  it("repairs a structurally rejected generated source then reviews and gates the next revision through real dispatch", async (t) => {
    const scenario = await approved(t, { testSource(id, request) {
      return request.stepId === "test-generate"
        ? `// spec: ${id}\nimport test from 'node:test';\nimport missing from './missing.js';\ntest('${id}: required behavior', () => missing());\n`
        : requirementTestSource(id);
    } });
    await scenario.advanceTo("test-repair");
    scenario.reload();
    const rejected = scenario.candidate("R1").candidate;
    assert.equal(scenario.plan().activeWorkItem().budget.manualSemantic, 1);
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
    await scenario.advanceTo("test-review");
    scenario.reload();
    const repaired = scenario.candidate("R1").candidate;
    assert.equal(repaired.bundle.revision, rejected.bundle.revision + 1);
    assert.equal(repaired.bundle.lineage.predecessorRevision, rejected.bundle.revision);
    assert.ok(repaired.bundle.lineage.sourceFindingFingerprints.length > 0);
    await scenario.advanceTo("test-gate");
    assertReviewPublication(scenario, repaired, "PASS");
    await scenario.advanceTo("implement");
    assertGatePublication(scenario, repaired, "assertion_failed");
    assert.equal(scenario.plan().workItem("R1").status, "promoted");
    await assertImplementationConsumer(scenario);
    assertSavedResult(scenario, "test-generate", "test-generate-structural-rejected");
    assertSavedResult(scenario, "test-repair", "test-repair-candidate-saved");
    assertSavedResult(scenario, "test-review", "test-review-passed");
    assertSavedResult(scenario, "test-gate", "test-gate-compatible");
  });

  it("persists multiple repair batches in one Attempt before publishing the next candidate revision", async (t) => {
    const count = TEST_REVIEW_REPAIR_BATCH_LIMITS.findingCount + 1;
    const scenario = await approved(t, { reviewResponse: rejectFirstRequirementReviewBatches(count) });
    await scenario.advanceTo("test-repair");
    const rejected = scenario.plan().activeWorkItem();
    const source = scenario.candidate("R1").candidate;
    const attempt = scenario.manager.canonicalState(scenario.specId).attempt;
    const repair = canonicalTestReviewRepairForTarget({ flowManager: scenario.manager, state: scenario.manager.loadReadOnly(scenario.specId), targetStepId: "test-repair" });
    assert.equal(repair.blockingFindings.length, count);
    await scenario.dispatch();
    scenario.reload();
    assert.equal(scenario.current(), "test-repair");
    assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, attempt.id);
    assert.equal(scenario.plan().activeWorkItem().bundleRevision.revision, source.bundle.revision);
    const progress = canonicalTestReviewRepairProgress({ flowManager: scenario.manager,
      state: scenario.manager.loadReadOnly(scenario.specId), repair, consumerNodeId: "test-repair" });
    assert.equal(progress.coordinatorAttempt.id, attempt.id);
    assert.equal(progress.sourceEvidenceId, repair.sourceEvidenceId);
    assert.equal(progress.sourceArtifactDigest, repair.sourceArtifactDigest);
    assert.deepEqual(progress.entries.map(({ findingId, fingerprint }) => ({ findingId, fingerprint })),
      repair.blockingFindings.map(({ findingId, fingerprint }) => ({ findingId, fingerprint })));
    for (const entry of progress.entries.filter((entry) => entry.status === "done")) {
      assert.equal(entry.handoff.batchId, scenario.requests.findLast((entry) => entry.stepId === "test-repair").testReviewRepair.batch.batchId);
      assert.match(entry.handoff.requestDigest, /^[a-f0-9]{64}$/);
    }
    assert.ok(progress.entries.filter((entry) => entry.status === "done").length > 0 && progress.entries.filter((entry) => entry.status === "done").length < count);
    await scenario.advanceTo("test-review");
    const repaired = scenario.candidate("R1").candidate;
    assert.equal(repaired.bundle.revision, source.bundle.revision + 1);
    assert.equal(repaired.bundle.lineage.predecessorRevision, source.bundle.revision);
    assert.equal(repaired.bundle.lineage.sourceAttempt.id, attempt.id);
    assert.ok(repaired.bundle.lineage.sourceFindingFingerprints.length > 0);
    const repairedSources = scenario.candidate("R1").sources.map((entry) => entry.bytes.toString("utf8")).join("\n");
    for (const request of scenario.requests.filter((entry) => entry.stepId === "test-repair")) {
      assert.ok(repairedSources.includes(request.testReviewRepair.batch.batchId), "final candidate retains each staged repair batch");
    }
    assert.deepEqual(scenario.plan().activeWorkItem().budget.toJSON(), rejected.budget.toJSON(), "batch progress cannot recharge the semantic finding");
    await scenario.advanceTo("implement");
    assertSavedResult(scenario, "test-review", "test-review-rejected");
    assertSavedResult(scenario, "test-repair", "test-repair-progress-saved");
    assertSavedResult(scenario, "test-repair", "test-repair-candidate-saved");
  });

  for (const { label, source, atGate } of [
    { label: "ReferenceError", source: "test('R1: required behavior', () => missingValue);", atGate: true },
    { label: "syntax", source: "test('R1: required behavior', () => { const =; });", atGate: true },
    { label: "bootstrap import", source: "import absent from './absent.js'; test('R1: required behavior', () => absent());", atGate: false },
    { label: "skip", source: "test.skip('R1: required behavior', () => assert.fail());", atGate: false },
    { label: "missing named test", source: "test('unassigned behavior', () => assert.fail());", atGate: false },
    { label: "multiple named tests", source: "test('R1: first', () => assert.fail()); test('R1: second', () => assert.fail());", atGate: true },
    { label: "cross-R ownership", source: "test('R9: different owner', () => assert.fail());", atGate: false },
  ]) {
    it(`never promotes ${label} as an expected failing assertion`, async (t) => {
      const scenario = await approved(t, { testSource: () => `// spec: R1\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\n${source}\n` });
      await scenario.advanceTo(atGate ? "test-gate" : "test-repair");
      const before = scenario.plan().workItem("R1");
      if (atGate) {
        await scenario.dispatch();
        scenario.reload();
        assert.equal(scenario.current(), "test-review", "a Gate mismatch reopens the same candidate Review");
        assert.equal(scenario.plan().workItem("R1").bundleRevision.revision, before.bundleRevision.revision);
        assert.deepEqual(scenario.plan().workItem("R1").budget.toJSON(), before.budget.toJSON(), "Gate mismatch charges zero semantic attempts");
      }
      assert.notEqual(scenario.plan().workItem("R1").status, "promoted");
      assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
      assertSavedResult(scenario, atGate ? "test-gate" : "test-generate", atGate ? "test-gate-incompatible" : "test-generate-structural-rejected");
    });
  }

  it("preserves per-R semantic consumption across repair, manager reload and manual/auto switching", async (t) => {
    const scenario = await approved(t, { requirements: [requirement("R1"), requirement("R2")], reviewResponse: rejectFirstRequirementReview });
    await scenario.advanceTo("test-repair");
    const budget = scenario.plan().workItem("R1").budget.toJSON();
    assert.deepEqual(budget, { autoSemantic: 0, manualSemantic: 1, tooling: 0 });
    assert.deepEqual(scenario.plan().workItem("R2").budget.toJSON(), { autoSemantic: 0, manualSemantic: 0, tooling: 0 });
    await new SetAutoCommand().execute({ ...scenario.context(), value: "on" });
    scenario.reload();
    assert.deepEqual(scenario.plan().workItem("R1").budget.toJSON(), budget);
    await new SetAutoCommand().execute({ ...scenario.context(), value: "off" });
    scenario.reload();
    assert.deepEqual(scenario.plan().workItem("R1").budget.toJSON(), budget);
    await scenario.advanceTo("implement");
    assert.equal(scenario.plan().workItem("R1").budget.manualSemantic, 1);
    assertSavedResult(scenario, "test-review", "test-review-rejected");
  });

  it("refuses unsupported nonblocking activation during Requirement repair without changing state or budgets", async (t) => {
    const scenario = await approved(t, { testSource: wrongRequirementOwnershipSource });
    await scenario.advanceTo("test-repair");
    const before = scenario.snapshot();
    const plan = scenario.plan().toJSON();
    assert.throws(() => activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
      reason: "Retain exhausted Requirement obligations for Acceptance." }), /nonblocking is not supported for step: test-repair/);
    scenario.reload();
    assert.deepEqual(scenario.snapshot(), before);
    assert.deepEqual(scenario.plan().toJSON(), plan);
  });

  it("retains upstream Spec Gate nonblocking policy without bypassing Requirement repair or recharging its budget", async (t) => {
    const gateAttempts = new Set();
    const scenario = RequirementTestPhaseScenario.create(t, {
      // Same legal producer as the Spec artifact scenario: a new semantic
      // finding after each bounded repair reaches the cycle-limit strict stop.
      gateResponse: (_prompt, options, active) => {
        assert.equal(active.current(), "spec-gate");
        gateAttempts.add(active.manager.canonicalState(active.specId).attempt.id);
        const observation = options.jsonSchema.properties.observations.items;
        const knownIds = observation.properties.requirementRef?.enum ?? [];
        const evidenceIds = observation.properties.requirementId?.enum ?? [];
        const sourceRefs = observation.properties.sourceRef?.enum ?? [];
        const observed = `Spec behavior ${gateAttempts.size} needs a separate clarification.`;
        if (evidenceIds.length > 0) return JSON.stringify({ observations: evidenceIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
          requirementId, sourceRef, support: [], contradictions: requirementId === "PHASE-SPEC" ? [observed] : [], unresolved: [],
        }))) });
        const target = { entity: "requirement", id: "R1", field: "desc" };
        return JSON.stringify({ observations: knownIds.includes("PHASE-SPEC") ? [{ failureMode: "guardrail-violation",
          requirementRef: "PHASE-SPEC", where: { file: "spec.json", locator: "requirements.R1.desc" }, observed,
          targets: [target], allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
        }] : [] });
      },
      testSource: wrongRequirementOwnershipSource,
    });
    const strict = await scenario.dispatch(64);
    assert.equal(strict.dispatch?.boundary, "blocked", JSON.stringify(strict.errors));
    assert.equal(gateAttempts.size, 4);
    const settlement = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "spec-gate" });
    assert.equal(settlement.result.kind, "spec-gate-blocked");
    assert.equal(settlement.result.error.data.reason, "cycle-limit");
    assert.match((await scenario.next()).directive.reason, /cycle 4 reached maximum 4/);
    activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
      reason: "Keep the unresolved Spec observation as an Acceptance obligation." });
    const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
    assert.equal(context.sourceStep, "spec-gate");
    assert.equal(context.resultKind, "quality");
    assert.deepEqual(context.allowedActions, ["continue"]);
    recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager,
      choice: "continue", reason: "Continue with the explicit unresolved Spec observation.",
      remainingRisk: "Acceptance must decide the unresolved Spec Gate observation.",
      expectEvidenceDigest: context.evidenceDigest, expectIdentity: context.identity().toJSON() });
    scenario.reload();
    const policy = scenario.manager.loadReadOnly(scenario.specId).policy.nonblocking;
    assert.equal(policy.enabled, true);
    await scenario.advanceTo("approval");
    await scenario.approve();
    await scenario.advanceTo("test-repair");
    const budget = scenario.plan().workItem("R1").budget.toJSON();
    assert.deepEqual(budget, { autoSemantic: 0, manualSemantic: 1, tooling: 0 });
    const before = scenario.snapshot();
    assert.deepEqual(activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
      reason: "The existing policy remains enabled." }), policy);
    scenario.reload();
    assert.deepEqual(scenario.snapshot(), before);
    assert.deepEqual(scenario.plan().workItem("R1").budget.toJSON(), budget);
    assert.notEqual(scenario.plan().workItem("R1").status, "promoted");
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
    assertSavedResult(scenario, "test-generate", "test-generate-structural-rejected");
  });

  for (const autoApprove of [false, true]) {
    it(`caps each R at five ${autoApprove ? "auto" : "manual"} semantic repairs through structural rejection and reload`, async (t) => {
      const scenario = await approved(t, { autoApprove, requirements: [requirement("R1"), requirement("R2")],
        testSource: wrongRequirementOwnershipSource,
      });
      for (const requirementId of ["R1", "R2"]) {
        await scenario.advanceTo("test-repair");
        const field = autoApprove ? "autoSemantic" : "manualSemantic";
        assert.equal(scenario.plan().workItem(requirementId).budget[field], 1);
        if (requirementId === "R1") {
          assert.equal(scenario.plan().workItem("R2").budget[field], 0);
        }
        for (let consumption = 2; consumption <= 5; consumption += 1) {
          const result = await scenario.dispatch();
          scenario.reload();
          assert.equal(scenario.current(), "test-repair");
          const item = scenario.plan().workItem(requirementId);
          assert.equal(item.budget[field], consumption);
          assert.notEqual(scenario.plan().workItem(requirementId).status, "promoted");
        }
        await scenario.dispatch();
        scenario.reload();
        assert.equal(scenario.plan().workItem(requirementId).budget[field], 5);
        assert.equal(scenario.plan().workItem(requirementId).status, "deferred");
        assert.equal(scenario.artifact("tests.source", { testPath: `${requirementId.toLowerCase()}.test.js` }), null);
        assert.ok(scenario.artifact("test.requirement.deferred", { requirementId }));
        assert.equal(scenario.current(), requirementId === "R1" ? "test-generate" : "implement");
      }
      const before = scenario.plan().toJSON();
      scenario.reload();
      assert.deepEqual(scenario.plan().toJSON(), before);
      assertSavedResult(scenario, "test-generate", "test-generate-structural-rejected");
      assertSavedResult(scenario, "test-repair", "test-repair-structural-rejected");
    });
  }

  for (const expectation of ["fail", "pass"]) {
    it(`reopens the same candidate without charging semantic budget when assertion contradicts expectation ${expectation}`, async (t) => {
      const scenario = await approved(t, { requirements: [requirement("R1", expectation)],
        testSource: (id) => requirementTestSource(id, expectation === "fail" ? "pass" : "fail"),
      });
      await scenario.advanceTo("test-gate");
      const before = scenario.plan().activeWorkItem();
      const candidate = scenario.candidate("R1").candidate;
      await scenario.dispatch();
      scenario.reload();
      assert.equal(scenario.current(), "test-review");
      assert.deepEqual(scenario.candidate("R1").candidate.toJSON(), candidate.toJSON());
      assertGatePublication(scenario, candidate, expectation === "fail" ? "assertion_passed" : "assertion_failed");
      assert.deepEqual(scenario.plan().activeWorkItem().budget.toJSON(), before.budget.toJSON());
      assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
      assertSavedResult(scenario, "test-gate", "test-gate-incompatible");
    });
  }

  for (const permissionRelated of [false, true]) {
    it(permissionRelated ? "stops external permission failures without consuming any R budget" : "preserves promoted R while tooling exhaustion defers the next R and retains Acceptance obligations", async (t) => {
      const scenario = await approved(t, { requirements: [requirement("R1"), requirement("R2")],
        continueImplementation: !permissionRelated,
        testSource(id, request, scenario) {
          return `// spec: ${id}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('${id}: required behavior', () => assert.ok(fs.existsSync(${JSON.stringify(path.join(scenario.root, "src", "implementation.js"))})));\n`;
        },
        reviewResponse(_index, revision) {
        if (revision.requirementId === "R1") return { verdict: "PASS", blockingFindings: [], advisoryFindings: [] };
        return { toolingOutcome: { kind: "TOOLING_ERROR", stage: "provider", attempt: 1, maxAttempts: 3,
          remainingAttempts: 2, reason: permissionRelated ? "permission denied" : "provider unavailable", permissionRelated } };
      } });
      await scenario.advanceTo("test-gate");
      await scenario.dispatch();
      scenario.reload();
      assert.equal(scenario.plan().workItem("R1").status, "promoted");
      assert.equal(scenario.plan().workItem("R2").status, "candidate_saved");
      if (permissionRelated) {
        await scenario.dispatch();
        scenario.reload();
        assert.deepEqual(scenario.plan().workItem("R2").budget.toJSON(), { autoSemantic: 0, manualSemantic: 0, tooling: 0 });
        assert.equal((await scenario.next()).directive.kind, "blocked");
        const before = scenario.snapshot();
        const calls = scenario.reviews.length;
        await scenario.dispatch();
        assert.equal(scenario.reviews.length, calls);
        assert.deepEqual(scenario.snapshot(), before);
        assertSavedResult(scenario, "test-review", "test-review-external-blocked");
      } else {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await scenario.dispatch();
          scenario.reload();
          assert.equal(scenario.plan().workItem("R2").budget.tooling, attempt);
          assert.equal(scenario.plan().workItem("R1").budget.tooling, 0);
        }
        await scenario.advanceTo("implement");
        scenario.reload();
        assert.deepEqual(scenario.plan().workItems.map((item) => item.status), ["promoted", "deferred"]);
        assert.ok(scenario.artifact("test.requirement.deferred", { requirementId: "R2" }));
        assert.equal(scenario.artifact("tests.source", { testPath: "r2.test.js" }), null);
        const acceptance = await new CanonicalAcceptanceArtifactStore({ flowManager: scenario.manager,
          state: scenario.manager.loadReadOnly(scenario.specId) }).buildContext({ executionRoot: scenario.root });
        assert.ok(acceptance.deferredFindings.length > 0, "Acceptance must retain the deferred source obligations after reload");
        await consumeMixedDownstream(scenario);
        assertSavedResult(scenario, "test-review", "test-review-tooling-unavailable");
      }
    });
  }
});
