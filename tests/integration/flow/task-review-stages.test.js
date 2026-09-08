import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { container } from "../../../src/lib/container.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { TaskSourceFailureObservation } from "../../../src/flow/lib/task-source-failure.js";
import { buildAcceptancePrompt } from "../../../src/flow/lib/run-acceptance-review.js";
import {
  materializeSourceWorkerEffect, sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";

function finding(key = "missing-behavior") {
  return { findingKey: key, title: "Required behavior is missing", failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1", issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.", disposition: "must-fix", rationale: "The mapped requirement requires this behavior." };
}

async function review(scenario, findings, edit = null) {
  return scenario.publishReview(findings, { edit });
}

function scenarioFor(t, options = {}) {
  const scenario = new TaskReviewScenario(t, options);
  container.reset(); container.register("root", scenario.root);
  t.after(() => container.reset());
  return scenario;
}

function claim(scenario, role) {
  if (scenario.state().current?.at(-1) !== `${scenario.taskId}-${role}`) scenario.manager.updateStepStatus({ stepId: `${scenario.taskId}-${role}`, requestedStatus: "in_progress" }, { specId: scenario.specId });
}

function triageEffect(keys, disposition = "apply") {
  return { version: 1, stepId: "task-triage", completionStatus: "done", files: [], issues: [], overview: null, triage: { version: 1, dispositions: keys.map((findingKey) => ({ findingKey, disposition, basis: disposition === "apply" ? "repair-required" : "already-satisfied", rationale: disposition === "apply" ? "The requirement confirms this missing behavior." : "The referenced behavior is already covered by the current implementation." })) }, repair: null, noChangeReason: null };
}

function repairEffect(keys, recurrence = { entries: [] }) {
  return { version: 1, stepId: "task-repair", completionStatus: "done", files: [{ requirementId: "R-1", paths: ["README.md"] }], issues: [], overview: null, triage: null, repair: { version: 1, findings: keys.map((findingKey) => ({ findingKey, paths: ["README.md"] })), summary: "Implemented the missing mapped behavior.", recurrenceResolutions: recurrence.entries.map(({ findingKey, fingerprint }) => ({ findingKey, fingerprint, priorRepairInsufficiency: "The prior change did not cover the required behavior identified by this exact finding.", repairStrategy: "Add the missing requirement branch and preserve the previous correction." })) }, noChangeReason: null };
}

function artifact(scenario, role) { return new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role }); }
function accounting(scenario) { return new TaskReviewAccounting({ taskId: scenario.taskId, budget: scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1).budget, history: artifact(scenario, "review").history }); }

test("Task review publishes immutable findings before triage; only repair edits and retains both finding mappings after reload", async (t) => {
  const scenario = scenarioFor(t);
  const keys = ["missing-behavior", "missing-validation"];
  const original = fs.readFileSync(scenario.sourcePath, "utf8");
  const reviewed = await review(scenario, keys.map(finding));
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  scenario.reload();
  const reviewRef = artifact(scenario, "review").reference;
  assert.deepEqual(artifact(scenario, "review").document.blockingFindings.map((entry) => entry.findingKey), keys);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), original);
  assert.equal(accounting(scenario).completedReviewCount, 1);
  assert.equal(scenario.state().nextAction().action.action, "write-task-triage");
  const triage = scenario.stageHandoff("triage");
  assert.equal(scenario.completeHandoff(triage, triageEffect(keys)).completed, true);
  scenario.reload();
  assert.equal(artifact(scenario, "triage").document.binding.review.digest, reviewRef.digest);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), original);
  assert.equal(accounting(scenario).completedReviewCount, 1);
  assert.equal(scenario.state().nextAction().action.action, "run-task-repair");
  const repair = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "required behavior and validation\n");
  assert.equal(scenario.completeHandoff(repair, repairEffect(keys)).completed, true);
  scenario.reload();
  const repaired = artifact(scenario, "repair");
  assert.equal(repaired.reference.attemptId, repaired.document.attempt.id);
  assert.equal(repaired.document.attempt.nodeId, "T-1-repair");
  assert.deepEqual(repaired.document.repair.findingMutations.map((entry) => entry.findingKey), keys);
  assert.equal(repaired.document.sourceMutationManifest.mutations.length, 1);
  assert.equal(artifact(scenario, "review").reference.digest, reviewRef.digest);
  assert.deepEqual(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).map((entry) => entry.role), ["implementation", "repair"]);
  assert.equal(accounting(scenario).completedReviewCount, 1);
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
});

test("Task all-reject triage preserves the rejected review and skips repair", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  const work = scenario.stageHandoff("triage");
  scenario.completeHandoff(work, triageEffect(["missing-behavior"], "reject"));
  scenario.reload();
  assert.equal(artifact(scenario, "review").document.verdict, "REJECTED");
  assert.equal(artifact(scenario, "triage").document.dispositions[0].disposition, "reject");
  assert.equal(scenario.state().findNode("T-1-repair").status, "skipped");
  assert.equal(scenario.state().current?.at(-1), "T-1-gate");
  assert.equal(accounting(scenario).completedReviewCount, 1);
});

test("normal-source all-reject triage carries its rejected findings and rationale to Acceptance after reload", async (t) => {
  const scenario = scenarioFor(t);
  const rejected = finding();
  await review(scenario, [rejected]);
  scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect([rejected.findingKey], "reject"));
  scenario.reload();

  const state = scenario.state();
  const handoffs = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager,
    state,
    cycle: ReviewFindingCycle.fromActivityLedger({
      runId: state.runId,
      activities: scenario.manager.activityLedger(scenario.specId),
    }),
  }).handoffs().map((entry) => entry.toJSON());
  assert.equal(handoffs.length, 1);
  const [handoff] = handoffs;
  assert.equal(handoff.allRejected, true);
  assert.equal(handoff.reviewVerdict, "REJECTED");
  assert.equal(handoff.taskRound, 1);
  assert.equal(handoff.sourceFingerprint, handoff.binding.sourceFingerprint);
  assert.deepEqual(handoff.findings, [artifact(scenario, "review").document.blockingFindings[0]]);
  assert.deepEqual(handoff.dispositions, [artifact(scenario, "triage").document.dispositions[0]]);
  assert.equal(handoff.review.artifact.digest, artifact(scenario, "review").reference.digest);
  assert.equal(handoff.triage.attempt.id, artifact(scenario, "triage").document.attempt.id);
  assert.match(buildAcceptancePrompt({ evidence: { taskReviewHandoffs: handoffs } }).systemPrompt, /allRejected=true/);
});

test("Task triage source edits are rejected without publication or automatic rollback", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  const work = scenario.stageHandoff("triage");
  const before = scenario.snapshot();
  fs.appendFileSync(scenario.sourcePath, "forbidden triage change\n");
  assert.throws(() => scenario.completeHandoff(work, triageEffect(["missing-behavior"])), /source|mutation|diff/i);
  assert.equal(scenario.snapshot(), before);
  assert.equal(work.coordinator.rollbackRejectedSourceHandoff({ ctx: scenario.context(), request: work.request, mutationAuthority: work.authority }), false);
  assert.match(fs.readFileSync(scenario.sourcePath, "utf8"), /forbidden triage change/);
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
});

test("an empty Task Review response cannot hide source edits or publish a successful review", async (t) => {
  const scenario = scenarioFor(t);
  const result = await review(scenario, [], () => fs.appendFileSync(scenario.sourcePath, "forbidden review change\n"));
  assert.equal(result.ok, false);
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review", optional: true }).reference, null);
  assert.notEqual(scenario.state().findNode("T-1-review").status, "done");
  assert.notEqual(scenario.state().findNode("T-1-gate").status, "in_progress");
  assert.match(fs.readFileSync(scenario.sourcePath, "utf8"), /forbidden review change/);
});

test("an incomplete Task triage cannot publish or expose repair", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding("first"), finding("second")]);
  const work = scenario.stageHandoff("triage");
  const before = scenario.snapshot();
  assert.throws(() => scenario.completeHandoff(work, triageEffect(["first"])), /each canonical finding exactly once/);
  assert.equal(scenario.snapshot(), before);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
});

test("Task repair refuses a mapped finding that changes a path outside its implementation lineage", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect(["missing-behavior"]));
  const work = scenario.stageHandoff("repair");
  const before = scenario.snapshot();
  fs.writeFileSync(path.join(scenario.root, "unrelated.js"), "export const unrelated = true;\n");
  const effect = repairEffect(["missing-behavior"]);
  effect.files[0].paths = ["unrelated.js"];
  effect.repair.findings[0].paths = ["unrelated.js"];
  assert.throws(() => scenario.completeHandoff(work, effect), /authorized Task lineage/);
  assert.equal(scenario.snapshot(), before);
  scenario.reload();
  assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).length, 1);
  assert.equal(fs.readFileSync(path.join(scenario.root, "unrelated.js"), "utf8"), "export const unrelated = true;\n");
});

test("the fourth separately published Task repair advances to Gate with bound unreviewed Acceptance evidence", async (t) => {
  const scenario = scenarioFor(t);
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    assert.notEqual((await review(scenario, [finding()])).ok, false);
    const reviewed = artifact(scenario, "review").reference;
    assert.equal(accounting(scenario).completedReviewCount, ordinal);
    scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect(["missing-behavior"]));
    const triaged = artifact(scenario, "triage").reference;
    const work = scenario.stageHandoff("repair");
    const recurrence = work.request.inputs.find((input) => input.name === "task-review-recurrence.json").document;
    assert.equal(recurrence.entries.length, ordinal === 1 ? 0 : 1);
    if (ordinal > 1) {
      assert.equal(recurrence.entries[0].previous.length, ordinal - 1);
      assert.equal(recurrence.entries[0].previous.at(-1).repair.dispositions[0].disposition, "apply");
      assert.equal(recurrence.entries[0].previous.at(-1).repair.mutations[0].path, "README.md");
    }
    fs.appendFileSync(scenario.sourcePath, `repair ${ordinal}\n`);
    scenario.completeHandoff(work, repairEffect(["missing-behavior"], recurrence));
    scenario.reload();
    const repaired = artifact(scenario, "repair").document;
    assert.equal(repaired.binding.review.payloadDigest, reviewed.payloadDigest);
    assert.equal(repaired.binding.triage.payloadDigest, triaged.payloadDigest);
    assert.equal(repaired.binding.reviewOrdinal, ordinal);
    assert.equal(repaired.unreviewedAfterRepair, ordinal === 4);
    assert.equal(scenario.state().current.at(-1), ordinal === 4 ? "T-1-gate" : "T-1-review");
    assert.equal(accounting(scenario).completedReviewCount, ordinal);
  }
  const convergence = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: scenario.state().runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  });
  const handoffs = convergence.handoffs().map((entry) => entry.toJSON());
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].reviewAttempt, 4);
  assert.equal(handoffs[0].unreviewedAfterRepair, true);
  assert.equal(handoffs[0].sourceMutationManifest.attempt.nodeId, "T-1-repair");
  assert.equal(handoffs[0].dispositions[0].disposition, "apply");
  assert.equal(convergence.status()[0].fourthRepairUnreviewed, true);
});

test("a source change after handoff validation is rejected at Task publication without advancing the Attempt", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  const work = scenario.stageHandoff("triage");
  const before = scenario.snapshot();
  const confirm = scenario.manager.confirmSourceWorkerHandoff.bind(scenario.manager);
  scenario.manager.confirmSourceWorkerHandoff = (input) => {
    fs.appendFileSync(scenario.sourcePath, "change at publication boundary\n");
    return confirm(input);
  };
  assert.throws(() => scenario.completeHandoff(work, triageEffect(["missing-behavior"])), /mutation|source/i);
  assert.equal(scenario.snapshot(), before);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  assert.match(fs.readFileSync(scenario.sourcePath, "utf8"), /change at publication boundary/);
});

test("a rejected no-change Review requires triage and an explicit all-reject continuation before skipping Gate", async (t) => {
  const scenario = scenarioFor(t, { noChange: true });
  const missing = { ...finding(), file: null, failureMode: "missing_acceptance_requirement" };
  assert.notEqual((await review(scenario, [missing])).ok, false);
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  const reviewed = artifact(scenario, "review").reference;
  scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect([missing.findingKey], "reject"));
  scenario.reload();
  assert.equal(artifact(scenario, "review").reference.digest, reviewed.digest);
  assert.equal(artifact(scenario, "review").document.verdict, "REJECTED");
  assert.equal(scenario.state().findNode("T-1-repair").status, "skipped");
  assert.equal(scenario.state().findNode("T-1-gate").status, "skipped");
  const handoffs = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: scenario.state().runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  }).handoffs().map((entry) => entry.toJSON());
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].continuation.facts.triage.disposition, "all-reject");
  assert.equal(handoffs[0].continuation.facts.review.artifactDigest, reviewed.digest);
  assert.equal(handoffs[0].findings[0].disposition, "must-fix");
  assert.deepEqual(handoffs[0].dispositions, [{
    findingKey: missing.findingKey,
    disposition: "reject",
    basis: "already-satisfied",
    rationale: "The referenced behavior is already covered by the current implementation.",
  }]);
});

test("a Task Review cannot publish success after its Attempt has failed", async (t) => {
  const scenario = scenarioFor(t);
  const confirm = scenario.manager.confirmTaskReviewResult.bind(scenario.manager);
  let failedSnapshot;
  scenario.manager.confirmTaskReviewResult = (input) => {
    scenario.fail();
    failedSnapshot = scenario.snapshot();
    return confirm(input);
  };
  await assert.rejects(() => review(scenario, []), /failed Attempt cannot be confirmed/);
  assert.equal(scenario.snapshot(), failedSnapshot);
  scenario.reload();
  assert.equal(scenario.state().attempt.failure.category, "tooling");
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review", optional: true }).reference, null);
});

test("a Task source handoff cannot publish success after its Attempt has failed", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  const work = scenario.stageHandoff("triage");
  const confirm = scenario.manager.confirmSourceWorkerHandoff.bind(scenario.manager);
  let failedSnapshot;
  scenario.manager.confirmSourceWorkerHandoff = (input) => {
    scenario.fail();
    failedSnapshot = scenario.snapshot();
    return confirm(input);
  };
  assert.throws(() => scenario.completeHandoff(work, triageEffect(["missing-behavior"])), /failed Attempt cannot be confirmed/);
  assert.equal(scenario.snapshot(), failedSnapshot);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  assert.equal(scenario.state().attempt.failure.category, "tooling");
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
});

test("a late Task source failure cannot mark the successor Attempt as failed", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  const work = scenario.stageHandoff("triage");
  const observation = new TaskSourceFailureObservation({
    request: work.request, mutationAuthority: work.authority,
    error: Object.assign(new Error("provider failed after its observation"), { code: "PROVIDER_FAILED" }),
  });
  const read = scenario.manager.canonicalState.bind(scenario.manager);
  scenario.manager.canonicalState = (specId) => {
    scenario.manager.canonicalState = read;
    const previous = read(specId);
    scenario.completeHandoff(work, triageEffect(["missing-behavior"]));
    return previous;
  };
  assert.equal(observation.record(scenario.manager), false);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  assert.equal(scenario.state().attempt.failure, null);
  assert.equal(scenario.manager.activityLedger(scenario.specId).some((activity) => activity.failure?.code === "PROVIDER_FAILED"), false);
});


test("a recurring Task repair cannot publish without the exact prior-repair resolution", async (t) => {
  const scenario = scenarioFor(t);
  await review(scenario, [finding()]);
  scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect(["missing-behavior"]));
  const first = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "first repair\n");
  scenario.completeHandoff(first, repairEffect(["missing-behavior"]));
  await review(scenario, [finding()]);
  scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect(["missing-behavior"]));
  const second = scenario.stageHandoff("repair");
  const prior = artifact(scenario, "repair").reference;
  const before = scenario.snapshot();
  fs.appendFileSync(scenario.sourcePath, "unexplained repeated repair\n");
  assert.throws(() => scenario.completeHandoff(second, repairEffect(["missing-behavior"])), /recurrence resolutions must exactly match/);
  assert.equal(scenario.snapshot(), before);
  assert.equal(artifact(scenario, "repair").reference.digest, prior.digest);
  assert.match(fs.readFileSync(scenario.sourcePath, "utf8"), /unexplained repeated repair/);
});
