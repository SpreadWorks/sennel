import "./impl-phase-admission-recovery.contract.js";
import "./impl-phase-gate-authority.contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import RunTestExecuteCommand from "../../../src/flow/lib/run-test-execute.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { dispatchContainer, installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import { canonicalPlanGateRepairForTarget } from "../../../src/flow/lib/plan-gate-repair.js";
import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { ImplPhaseScenario, implementationFinding } from "../../support/impl-phase-scenario.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { container } from "../../../src/lib/container.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import RunRetroCommand from "../../../src/flow/lib/run-retro.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import { ImplPhasePublicationObserver } from "../../support/infrastructure/impl-phase-publication-observer.js";

function task(id) { return { id, title: `Implement ${id}`, goal: "Implement R1", origin: "plan", added_round: 0, status: "pending" }; }
function taskScenario(t, options) {
  const publicationObserver = new ImplPhasePublicationObserver(t);
  const scenario = new TaskReviewScenario(t, options);
  scenario.publicationObserver = publicationObserver;
  container.reset(); container.register("root", scenario.root);
  t.after(() => container.reset());
  return scenario;
}
function taskArtifact(scenario, role) {
  return new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role });
}
function reviewCount(scenario) {
  return new TaskReviewAccounting({ taskId: scenario.taskId,
    budget: scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1).budget,
    history: taskArtifact(scenario, "review").history }).completedReviewCount;
}
function taskFinding() { return { ...implementationFinding(), file: "README.md", requirementId: "R-1" }; }
function repairEffect(work, { quality = false } = {}) {
  const recurrence = work.request.inputs.find((input) => input.name === "task-review-recurrence.json").document;
  return { version: 1, stepId: "task-repair", completionStatus: "done", overview: null, triage: null,
    issues: quality ? [{ classification: "quality", reason: "The final correction needs independent verification.", remainingRisk: "Acceptance must examine the unreviewed source." }] : [],
    repair: { version: 1, findings: [{ findingKey: "missing-behavior", paths: ["README.md"] }], summary: "Applied behavior correction.",
      recurrenceResolutions: recurrence.entries.map(({ findingKey, fingerprint }) => ({ findingKey, fingerprint,
        priorRepairInsufficiency: "Previous correction omitted a behavior branch.", repairStrategy: "Add the missing branch and preserve previous corrections." })) }, noChangeReason: null };
}
function convergence(scenario) {
  return new TaskReviewConvergenceEvidence({ flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: scenario.state().runId, activities: scenario.manager.activityLedger(scenario.specId) }) });
}
function assertTypedResults(scenario, nodes) { ImplPhaseScenario.prototype.assertResults.call(scenario, nodes); }

for (const ids of [["T17", "T23"], []]) {
  test(`I01 ${ids.length ? "all Tasks" : "no Task"}: normal producer chain survives reload and Retro consumes the exact test producer`, async (t) => {
    const scenario = ImplPhaseScenario.create(t, { tasks: ids.map(task), requirements: ids.length ? [{ id: "R1", desc: "Implement observable behavior.", task_ids: ids, preimplementation_test_expectation: "fail" }] : [] });
    if (ids.length === 0) {
      // Empty upstream Specs require the existing explicit advisory decision.
      // Keep the real rejection and its source identity; never synthesize approval.
      await scenario.advanceTo("spec-gate");
      let strict = await scenario.next();
      for (let count = 0; count < 8 && strict.directive.kind !== "blocked"; count += 1) {
        await scenario.executeCurrent();
        scenario.reload();
        strict = await scenario.next();
      }
      assert.equal(strict.directive.kind, "blocked");
      assert.equal(strict.directive.code, "STRICT_RECOVERY_EXHAUSTED");
      const failed = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "spec-gate" });
      assert.equal(failed.result.kind, "spec-gate-blocked");
      activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
        reason: "Exercise the legal empty-Task phase boundary while retaining the upstream empty-Spec refusal." });
      scenario.reload();
      const decision = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
      assert.ok(decision.allowedActions.includes("continue"));
      const accepted = recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "continue",
        expectEvidenceDigest: decision.evidenceDigest,
        reason: "Continue the empty-Task scenario with the exact upstream refusal retained.",
        remainingRisk: "The downstream Retro must retain its explicit no-requirements refusal." });
      scenario.reload();
      assert.equal(accepted.evidenceDigest, decision.evidenceDigest);
      assert.ok(scenario.manager.activityLedger(scenario.specId).some((entry) =>
        entry.result?.draftSettlementReceipt?.id === failed.receipt.id), "the original blocked source receipt remains durable");
      assert.ok(scenario.manager.activityLedger(scenario.specId).some((entry) =>
        entry.transition?.nonblocking?.evidenceDigest === decision.evidenceDigest
        && entry.transition.nonblocking.action === "continue"), "the actual decision retains its exact failed evidence");
    }
    await scenario.advanceTo("test-execute");
    scenario.reload();
    for (const id of ids) assert.equal(scenario.state().findNode(id).status, "done", "integration waits for every Task frontier");
    await scenario.advanceTo("test-result-review");
    for (const review of scenario.phaseReviews) assert.equal(review.process?.status, 0, review.process?.stderr);
    const execution = scenario.commandArtifact("test.execute");
    assert.deepEqual(execution.payload.summary.map((entry) => entry.result), ids.length ? ["pass"] : []);
    const producer = scenario.manager.activityLedger(scenario.specId).find((entry) => entry.id === execution.descriptor.activityId);
    assert.equal(producer.nodeId, "test-execute");
    await scenario.advanceTo("retro");
    scenario.reload();
    const review = scenario.commandArtifact("test.result.review");
    assert.equal(review.payload.testExecute.producerActivityId, producer.id);
    if (ids.length) {
      const retro = await scenario.consumeRetro();
      assert.equal(retro.artifacts.summary.done, 1);
    } else {
      const before = scenario.snapshot();
      const retro = await new RunRetroCommand().execute(scenario.context());
      assert.equal(retro.ok, false);
      assert.equal(retro.errors[0].code, "NO_REQUIREMENTS", "phase 04 retains its explicit empty-requirements refusal");
      assert.deepEqual(scenario.reload().snapshot(), before);
      assert.equal(scenario.manager.readProducerArtifact({ specId: scenario.specId,
        nodeId: "retro", logicalKey: "retro", optional: true }), null);
    }
    assert.equal(scenario.commandArtifact("test.execute", "retro").descriptor.activityId, producer.id);
    scenario.assertResults(["implement", ...ids.flatMap((id) => [`${id}-impl`, `${id}-review`, `${id}-gate`]), "test-execute", "test-result-review", "impl-review", "impl-gate"]);
  });
}

test("I02 two implementation rounds each persist four Reviews; actual Gate repair starts a fresh counter and keeps final unreviewed evidence", async (t) => {
  const { readCurrentGateTransitionFacts } = await import("../../../src/flow/lib/gate-transition-facts.js");
  const { resolveGateTransition } = await import("../../../src/flow/definition.js");
  const { default: RunSettleGateTransitionCommand } = await import("../../../src/flow/lib/run-settle-gate-transition.js");
  const scenario = taskScenario(t);
  let firstRoundHandoff = null;
  for (const round of [1, 2]) {
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      assert.notEqual((await scenario.publishReview([taskFinding()])).ok, false);
      scenario.reload();
      assert.equal(reviewCount(scenario), ordinal);
      const reviewed = taskArtifact(scenario, "review").reference;
      assert.equal((await scenario.filter([])).ok, true);
      scenario.reload();
      const work = scenario.stageHandoff("repair");
      fs.appendFileSync(scenario.sourcePath, `round ${round} correction ${ordinal}\n`);
      assert.equal(scenario.completeHandoff(work, repairEffect(work, { quality: ordinal === 4 })).completed, true);
      scenario.reload();
      const repaired = taskArtifact(scenario, "repair").document;
      assert.equal(repaired.binding.review.payloadDigest, reviewed.payloadDigest);
      assert.equal(repaired.binding.reviewOrdinal, ordinal);
      assert.equal(repaired.binding.taskRound, round);
      assert.equal(repaired.unreviewedAfterRepair, ordinal === 4);
      assert.equal(reviewCount(scenario), ordinal);
      assert.equal(scenario.state().current.at(-1), ordinal === 4 ? "T-1-gate" : "T-1-review");
    }
    const handoff = convergence(scenario).handoffs()[0].toJSON();
    assert.equal(handoff.unreviewedAfterRepair, true);
    assert.equal(handoff.reviewAttempt, 4);
    assert.equal(handoff.binding.taskRound, round);
    assert.equal(handoff.sourceMutationManifest.attempt.nodeId, "T-1-repair");
    if (round === 2) {
      assert.notEqual(handoff.binding.review.attemptId, firstRoundHandoff.binding.review.attemptId);
      assert.notEqual(handoff.sourceMutationManifest.digest, firstRoundHandoff.sourceMutationManifest.digest);
    } else firstRoundHandoff = handoff;
    const gateAttempt = scenario.state().attempt;
    let calls = 0;
    const provider = installGateProviderFake(() => {
      calls += 1;
      return JSON.stringify({ evaluations: [{ guardrail_id: "R-1", result: "fail",
        reason: "[REQ:R-1] the mapped source still omits the required behavior branch." }] });
    });
    t.after(() => provider.mock.restore());
    try {
      const ctx = { ...scenario.context(), phase: "task-impl", skipGuardrail: true };
      const failed = await new RunGateCommand().execute(ctx);
      assert.equal(failed.result, "fail", JSON.stringify(failed));
      assert.ok(calls > 0, "the canonical current Gate, not a fabricated failed artifact, selects correction");
      await FLOW_COMMANDS.run.gate.post(ctx, failed);
    } finally { provider.mock.restore(); }
    scenario.reload();
    assert.equal(scenario.state().attempt.id, gateAttempt.id,
      "the failed Gate publication belongs to this implementation round's owning Attempt");
    if (round === 2) {
      const finalDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: scenario.manager, flowState: scenario.manager.loadReadOnly(scenario.specId), phase: "task-impl",
      }));
      assert.equal(finalDecision.facts.taskBudget.round, 2);
      assert.equal(finalDecision.disposition.operation, "defer", "the second failed Gate cannot select a third implementation round");
      assert.equal(finalDecision.plan.taskLifecycle.successorStepId, "test-execute");
      const beforeWrongRepair = scenario.snapshot();
      assert.equal(new RunRepairPlanGateCommand().execute(scenario.context()).ok, false);
      assert.equal(scenario.reload().snapshot(), beforeWrongRepair, "exhausted Task repair admission has zero effects");
      const settled = new RunSettleGateTransitionCommand().execute(scenario.context());
      assert.equal(settled.ok, true, JSON.stringify(settled));
      scenario.reload();
      assert.equal(scenario.state().findNode("T-1-gate").status, "done");
      assert.equal(scenario.state().nextAction().nodeId, "test-execute");
      assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId })
        .filter((entry) => entry.role === "implementation").length, 2);
      assert.equal(taskArtifact(scenario, "repair").document.unreviewedAfterRepair, true);
      assert.deepEqual(taskArtifact(scenario, "repair").document.binding, handoff.binding);
      assert.ok(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review" }),
        "the actual final Gate settlement publishes retained findings for the acceptance consumer");
      continue;
    }
    const repaired = new RunRepairPlanGateCommand().execute(scenario.context());
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    scenario.reload();
    assert.equal(scenario.state().current.at(-1), "T-1-impl");
    const selected = canonicalPlanGateRepairForTarget({ flowManager: scenario.manager,
      state: scenario.manager.loadReadOnly(scenario.specId), targetStepId: "T-1-impl" });
    assert.ok(selected.observationRequests.length > 0);
    const completed = completeCanonicalSourceHandoff({ root: scenario.root, manager: scenario.manager,
      specId: scenario.specId, stepId: "task-impl", taskId: scenario.taskId,
      mutate: () => fs.appendFileSync(scenario.sourcePath, "second implementation round repairs the Gate observation\n"),
      effect: { version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
        overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null, noChangeReason: null,
        gateRepair: { version: 1, summary: "Apply the exact selected Gate observations.",
          results: selected.observationRequests.map((entry) => ({ fingerprint: entry.fingerprint.toString(),
            strategy: "Implement the missing mapped branch.", summary: "Updated the canonical mapped source.",
            priorRepairInsufficiency: entry.recurrenceCount === 0 ? null : "The previous strategy omitted the branch.", paths: ["README.md"] })) },
      } });
    assert.equal(completed.reconciliation.completed, true);
    scenario.manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId: scenario.specId });
    scenario.reload();
    assert.equal(reviewCount(scenario), 0, "Gate-selected implementation creates a new semantic Review budget");
  }
  const issues = JSON.parse(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-gate" }).bytes);
  assert.equal(issues.entries.filter((entry) => entry.origin?.sourceStep === "task-repair").length, 2);
  assertTypedResults(scenario, ["T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"]);
});

test("I03 zero-effect unavailable Review publishes failure evidence without consuming a semantic ordinal", async (t) => {
  const scenario = taskScenario(t, { noChange: true });
  const before = fs.readFileSync(scenario.sourcePath, "utf8");
  const outcome = await scenario.review(() => ({ ok: false, status: 1, stdout: "", stderr: "provider unavailable", signal: null, killed: false })).execute(scenario.context());
  assert.equal(outcome.ok, false);
  scenario.reload();
  const handoff = convergence(scenario).handoffs().map((entry) => entry.toJSON()).find((entry) => entry.unavailable);
  assert.ok(handoff, "UNAVAILABLE must be a canonical failure artifact usable by the downstream Gate");
  assert.equal(handoff.semanticReviewCount, 0);
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), before);
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "task.review"), false);
  assertTypedResults(scenario, ["T-1-review"]);
});

for (const guard of ["attemptId", "reviewDigest", "sourceFingerprint", "catalogFingerprint", "unknown-finding", "duplicate-finding"]) {
  test(`I04 persisted Review refuses stale host ${guard} before triage publication`, async (t) => {
    const scenario = taskScenario(t);
    await scenario.publishReview([taskFinding()]);
    scenario.reload();
    const before = scenario.snapshot();
    const entry = taskArtifact(scenario, "review").document.blockingFindings[0];
    const exclusions = guard === "unknown-finding" ? [{ findingId: "unknown", reason: "Untrusted provider identity." }]
      : guard === "duplicate-finding" ? Array.from({ length: 2 }, () => ({ findingId: entry.findingId, reason: "Duplicate decision." })) : [];
    const overrides = ["unknown-finding", "duplicate-finding"].includes(guard) ? {} : { [`expect${guard[0].toUpperCase()}${guard.slice(1)}`]: guard === "attemptId" ? "different-attempt" : "f".repeat(64) };
    const result = await scenario.filter(exclusions, overrides);
    assert.equal(result.ok, false);
    scenario.reload();
    assert.equal(scenario.snapshot(), before, "refused host filtering preserves Review, counters, source binding and pending repair");
    assert.equal(taskArtifact(scenario, "review").document.blockingFindings[0].findingId, entry.findingId);
  });
}

test("I04 repair without a source mutation refuses its claimed apply set after reload", async (t) => {
  const scenario = taskScenario(t);
  await scenario.publishReview([taskFinding()]);
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();
  const work = scenario.stageHandoff("repair");
  const before = scenario.snapshot();
  assert.throws(() => scenario.completeHandoff(work, repairEffect(work)), { code: "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID" });
  scenario.reload();
  assert.equal(scenario.snapshot(), before);
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).length, 1);
});

test("I05 immutable source retains head/tail bytes across producer, fresh Review and typed publication", async (t) => {
  const body = `HEAD: sequential\n${"日本語 😀 \\ exact bytes\n".repeat(12000)}TAIL: parallel\n`;
  const scenario = taskScenario(t, { implementationContent: body });
  scenario.reload();
  let observed = null;
  const outcome = await scenario.review((_command, _args, options) => {
    const reference = JSON.parse(options.env.SENNEL_REVIEW_TASK_CURRENT_SOURCE);
    const bytes = fs.readFileSync(reference.sourcePath);
    assert.equal(bytes.length, reference.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.digest);
    observed = JSON.parse(bytes);
    return { ok: false, status: 1, signal: null, killed: false, stdout: "", stderr: "Review provider cannot evaluate complete input" };
  }).execute(scenario.context());
  assert.equal(outcome.ok, false);
  assert.equal(observed.entries.find((entry) => entry.path === "README.md").content, body);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), body);
  scenario.reload();
  assert.equal(convergence(scenario).handoffs().find((entry) => entry.unavailable).semanticReviewCount, 0);
  assertTypedResults(scenario, ["T-1-review"]);
});

test("I06 test exit 1 is durable complete evidence, and passing result Review cannot erase semantic failure", async (t) => {
  const scenario = ImplPhaseScenario.create(t, { testSource: (id) => `// spec: ${id}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${id}: required behavior', () => assert.fail('behavior remains missing'));\n` });
  await scenario.advanceTo("test-result-review");
  scenario.reload();
  const execution = scenario.commandArtifact("test.execute");
  assert.equal(execution.payload.summary[0].result, "fail");
  await scenario.executeCurrent();
  scenario.reload();
  const review = scenario.commandArtifact("test.result.review");
  assert.equal(review.payload.verdict, "pass", "complete failed test evidence is reviewable");
  assert.equal(review.payload.testExecute.producerActivityId, execution.descriptor.activityId);
  assert.equal(scenario.commandArtifact("test.execute").payload.summary[0].result, "fail");
  assert.notEqual(scenario.state().findNode("impl-gate").status, "done");
  scenario.assertResults(["test-execute", "test-result-review"]);
});

test("I07 Impl repair invalidates the former test chain and preserves repair quality through the next checkpoint", async (t) => {
  const scenario = ImplPhaseScenario.create(t, { forceRepairs: true,
    implReviewResponse: (stage, ordinal) => stage === "impl-review" && ordinal <= 2
      ? { blockingFindings: [implementationFinding()], nonBlockingImprovements: [] } : undefined,
    sourceEffect: (effect, request, current) => request.stepId === "impl-repair"
      && current.phaseWorkers.filter((entry) => entry.stepId === "impl-repair").length === 1 ? { ...effect,
      issues: [{ classification: "quality", reason: "Review the repaired integration branch.", remainingRisk: "The new branch still needs independent verification." }] } : effect,
  });
  await scenario.advanceTo("impl-review");
  const previous = scenario.commandArtifact("test.execute");
  const priorFingerprint = previous.payload.repairFingerprint;
  await scenario.advanceTo("impl-repair");
  scenario.reload();
  await scenario.executeCurrent();
  scenario.reload();
  assert.equal(scenario.current(), "test-execute", "repair returns to a new integration test chain");
  await scenario.advanceTo("impl-review");
  scenario.reload();
  const current = scenario.commandArtifact("test.execute");
  assert.notEqual(current.descriptor.activityId, previous.descriptor.activityId);
  assert.notEqual(current.payload.repairFingerprint, priorFingerprint);
  const reviewed = scenario.commandArtifact("test.result.review");
  assert.equal(reviewed.payload.testExecute.producerActivityId, current.descriptor.activityId);
  assert.notEqual(reviewed.payload.testExecute.producerActivityId, previous.descriptor.activityId);
  await scenario.advanceTo("impl-repair");
  scenario.reload();
  await scenario.executeCurrent();
  scenario.reload();
  const repeated = scenario.phaseWorkers.filter((entry) => entry.stepId === "impl-repair").at(-1);
  const recurrence = repeated.inputs.find((entry) => entry.name === "impl-review-recurrence.json").document;
  assert.equal(recurrence.entries.length, 1, "the second repair receives the prior canonical finding and repair lineage");
  assert.equal(recurrence.entries[0].findingKey, "missing-behavior");
  assert.equal(scenario.current(), "test-execute");
  await scenario.advanceTo("impl-review");
  scenario.reload();
  const refreshed = scenario.commandArtifact("test.execute");
  assert.notEqual(refreshed.descriptor.activityId, current.descriptor.activityId);
  assert.notEqual(refreshed.payload.repairFingerprint, current.payload.repairFingerprint);
  assert.equal(scenario.commandArtifact("test.result.review").payload.testExecute.producerActivityId, refreshed.descriptor.activityId);
  await scenario.advanceTo("impl-gate");
  scenario.reload();
  const issues = JSON.parse(scenario.artifact("issue.log").bytes).entries.filter((entry) => entry.origin?.sourceStep === "impl-repair");
  assert.equal(issues.length, 1, "the repair quality obligation survives fresh test execution and result Review");
  assert.equal(issues[0].classification, "quality");
  assert.equal(issues[0].recoveryStep, "impl-gate");
  assert.equal(issues[0].remainingRisk, "The new branch still needs independent verification.");
  assert.match(issues[0].evidence.digest, /^[a-f0-9]{64}$/);
  scenario.assertResults(["impl-review", "impl-triage", "impl-repair", "test-execute", "test-result-review"]);
});

test("I08 all-reject skips link to the actual rejected Review and reasons without a fabricated repair success", async (t) => {
  const scenario = taskScenario(t);
  await scenario.publishReview([taskFinding()]);
  scenario.reload();
  const review = taskArtifact(scenario, "review");
  const reason = "Host inspected the complete source and found this observation inapplicable.";
  assert.equal((await scenario.filter([{ findingId: review.document.blockingFindings[0].findingId, reason }])).ok, true);
  scenario.reload();
  assert.equal(scenario.state().findNode("T-1-repair").status, "skipped");
  const handoff = convergence(scenario).handoffs()[0].toJSON();
  assert.equal(handoff.allRejected, true);
  assert.equal(handoff.reviewVerdict, "REJECTED");
  assert.equal(handoff.review.artifact.digest, review.reference.digest);
  assert.equal(handoff.dispositions[0].rationale, `Host excluded this finding: ${reason}`);
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "task.repair"), false);
  assert.equal(scenario.manager.activityLedger(scenario.specId).some((entry) => entry.nodeId === "T-1-repair" && entry.result?.stepResult?.type === "completed"), false);
  assertTypedResults(scenario, ["T-1-triage"]);
});

test("I09 sealed repair is recovered once with its exact source and quality receipt; wrong direct command has zero effects", async (t) => {
  const scenario = taskScenario(t);
  await scenario.publishReview([taskFinding()]);
  assert.equal((await scenario.filter([])).ok, true);
  const work = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "sealed correction\n");
  scenario.sealHandoff(work, repairEffect(work, { quality: true }));
  scenario.reload();
  const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });
  assert.equal(recovered.completed, true);
  scenario.reload();
  const receipt = taskArtifact(scenario, "repair").document;
  assert.equal(receipt.repair.findingMutations.length, 1);
  assert.equal(receipt.sourceMutationManifest.mutations.length, 1);
  const before = scenario.snapshot();
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  assert.equal(scenario.reload().snapshot(), before);
  await assert.rejects(new RunTestResultReviewCommand().execute(scenario.context()), /test-chain direct admission rejected/);
  assert.equal(scenario.reload().snapshot(), before, "wrong direct command cannot publish, consume budget or advance");
  const issues = JSON.parse(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-review" }).bytes);
  assert.equal(issues.entries.length, 1);
  assert.equal(issues.entries[0].recoveryStep, "T-1-review");
  assertTypedResults(scenario, ["T-1-repair"]);
});

for (const kind of ["file-read-failed", "context-limit"]) {
  test(`I05 ${kind} at the actual Task Review process persists typed unavailable evidence without a false PASS`, async (t) => {
    const scenario = taskScenario(t, { implementationContent: `HEAD complete input\n${"日本語 😀 full source\n".repeat(12000)}TAIL complete input\n` });
    let processFailure = null;
    const outcome = await scenario.review((_command, _args, options) => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../support/impl-phase-review-worker.js", import.meta.url))], {
        ...options, encoding: "utf8", env: { ...options.env, SENNEL_IMPL_SCENARIO_FILE_FAILURE: kind,
          SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify({ evaluationUnavailable: { kind, reason: "Complete input could not be evaluated." } }) },
      });
      processFailure = result.stderr;
      return { ...result, ok: result.status === 0, killed: false };
    }).execute(scenario.context());
    assert.equal(outcome.ok, false);
    scenario.reload();
    const handoff = convergence(scenario).handoffs().map((entry) => entry.toJSON()).find((entry) => entry.unavailable);
    assert.ok(handoff);
    assert.equal(handoff.semanticReviewCount, 0);
    assert.equal(handoff.failure.code, "REVIEW_FILE_EVALUATION_UNAVAILABLE", `file/context limits must retain typed failure; external diagnostic: ${processFailure}`);
    assertTypedResults(scenario, ["T-1-review"]);
  });
}

for (const interruption of ["before-json-rename", "before-json-directory-fsync"]) {
  test(`I09 source settlement ${interruption} retains its exact commit frontier and never reapplies a repair`, async (t) => {
    const scenario = taskScenario(t);
    await scenario.publishReview([taskFinding()]);
    assert.equal((await scenario.filter([])).ok, true);
    const work = scenario.stageHandoff("repair");
    fs.appendFileSync(scenario.sourcePath, "interrupted durable correction\n");
    scenario.sealHandoff(work, repairEffect(work, { quality: true }));
    const catalogFile = scenario.manager.specLocation(scenario.specId).catalogFile;
    const captureRoot = createTmpDir("impl-source-publication-capture-");
    t.after(() => removeTmpDir(captureRoot));
    const captureFile = path.join(captureRoot, "original-source-save.json");
    const captureNonce = randomUUID();
    const child = `
      import { FlowManager } from ${JSON.stringify(new URL("../../../src/lib/flow-manager.js", import.meta.url).href)};
      import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(new URL("../../../src/flow/lib/worker-artifact-handoff.js", import.meta.url).href)};
      import { ImplPhasePublicationObserver } from ${JSON.stringify(new URL("../../support/infrastructure/impl-phase-publication-observer.js", import.meta.url).href)};
      import { mock } from 'node:test';
      new ImplPhasePublicationObserver({ mock, after() {} }, { sourceCapture: {
        filePath: process.env.SCENARIO_CAPTURE, nonce: process.env.SCENARIO_CAPTURE_NONCE } });
      const root = process.env.SCENARIO_ROOT;
      const manager = new FlowManager({ root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector: ({ phase, filePath }) => { if (phase === process.env.SCENARIO_PHASE && filePath === process.env.SCENARIO_CATALOG) process.kill(process.pid, 'SIGKILL'); } });
      new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: { root, executionRoot: root, mainRoot: root, specId: process.env.SCENARIO_SPEC, flowManager: manager } });
    `;
    const stopped = spawnSync(process.execPath, ["--input-type=module", "--eval", child], { encoding: "utf8", env: { ...process.env,
      SCENARIO_ROOT: scenario.root, SCENARIO_SPEC: scenario.specId, SCENARIO_PHASE: interruption, SCENARIO_CATALOG: catalogFile,
      SCENARIO_CAPTURE: captureFile, SCENARIO_CAPTURE_NONCE: captureNonce } });
    assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
    const captureDigest = scenario.publicationObserver.importSourceCapture({ filePath: captureFile,
      nonce: captureNonce, processId: stopped.pid, executionRoot: scenario.root });
    assert.match(captureDigest, /^[a-f0-9]{64}$/);
    scenario.reload();
    const authority = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId, identity: work.request.sourceHandoffIdentity });
    assert.equal(authority.settlement?.kind ?? null, interruption === "before-json-rename" ? null : "accepted");
    assert.equal(scenario.state().current.at(-1), interruption === "before-json-rename" ? "T-1-repair" : "T-1-review");
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }).completed, true);
    scenario.reload();
    const beforeReplay = scenario.snapshot();
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
    assert.equal(scenario.reload().snapshot(), beforeReplay);
    assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).filter((entry) => entry.role === "repair").length, 1);
    assertTypedResults(scenario, ["T-1-repair"]);
  });
}

for (const [kind, processResult] of [
  ["spawn", { started: false, exitCode: null, signal: null, timedOut: false, spawnError: "ENOENT: runner unavailable" }],
  ["signal", { started: true, exitCode: null, signal: "SIGTERM", timedOut: false, spawnError: null }],
  ["timeout", { started: true, exitCode: null, signal: "SIGTERM", timedOut: true, spawnError: null }],
]) {
  test(`I06 ${kind} test process persists tooling stop, exact observation and zero semantic consumption`, async (t) => {
    const scenario = ImplPhaseScenario.create(t);
    await scenario.advanceTo("test-execute");
    scenario.reload();
    const attempt = scenario.state().attempt;
    let calls = 0;
    const command = new RunTestExecuteCommand({ runSpecLocal: async ({ files, executionRoot }) => {
      calls += 1;
      assert.ok(files.length > 0, "normal Requirement producer supplied promoted tests");
      return { command: `node --test ${files.map((file) => path.relative(executionRoot, file)).join(" ")}`, noTestsDeclared: false,
        result: { ...processResult, stdout: "", stderr: `${kind} process failure` } };
    } });
    command.container = dispatchContainer({ root: scenario.root, flowManager: scenario.manager, agent: scenario.agent });
    const ctx = scenario.context();
    const result = await command.execute(ctx);
    await FLOW_COMMANDS.run["test-execute"].post(ctx, result);
    assert.equal(calls, 1);
    scenario.reload();
    assert.equal(scenario.state().attempt.id, attempt.id);
    assert.equal(scenario.state().attempt.failure.code, "TEST_CHAIN_TOOLING_FAILURE");
    assert.equal(scenario.state().attempt.consumption.semantic, 0);
    assert.equal(scenario.state().findNode("test-result-review").status, "pending");
    const observation = scenario.commandArtifact("test.execute", "test-result-review");
    assert.deepEqual(observation.payload.process, processResult);
    scenario.assertResults(["test-execute"]);
  });
}

for (const phase of ["before-worker-handoff-cleanup-rename", "after-worker-handoff-cleanup-rename"]) {
  test(`I09 ${phase} cannot undo the committed repair or duplicate its quality issue`, async (t) => {
    const scenario = taskScenario(t);
    await scenario.publishReview([taskFinding()]);
    assert.equal((await scenario.filter([])).ok, true);
    const work = scenario.stageHandoff("repair");
    fs.appendFileSync(scenario.sourcePath, "committed correction with cleanup interruption\n");
    scenario.sealHandoff(work, repairEffect(work, { quality: true }));
    scenario.reload();
    const stopped = new Error("scenario cleanup boundary interruption");
    let hit = false;
    let failure = null;
    try {
      new WorkerArtifactHandoffCoordinator({ faultInjector: (boundary) => {
        if (boundary.phase === phase && boundary.stepId === "task-repair") { hit = true; throw stopped; }
      } }).recoverPending({ ctx: scenario.context() });
    } catch (error) { failure = error; }
    assert.ok(failure, "cleanup failure must be returned to the caller");
    assert.equal(hit, true, "actual cleanup boundary must be reached after durable commit");
    scenario.reload();
    assert.equal(scenario.state().current.at(-1), "T-1-review");
    const before = scenario.snapshot();
    new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });
    assert.equal(scenario.reload().snapshot(), before);
    assert.equal(JSON.parse(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-review" }).bytes).entries.length, 1);
    assertTypedResults(scenario, ["T-1-repair"]);
  });
}
