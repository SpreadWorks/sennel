import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { TaskStepBinding } from "../../../src/flow/engine/connectors/task/task-step-binding.js";
import { taskStepRegistration } from "../../../src/flow/engine/composition/task.js";
import { TaskTriageNoChangeCompletedResult } from "../../../src/flow/engine/step-result.js";
import { settleTaskStepResult } from "../../../src/flow/definition.js";
import { TaskStageResultEvidence } from "../../../src/flow/lib/task-stage-result-values.js";
import { ImplementationTaskFrontier } from "../../../src/flow/lib/source-effect-values.js";
import { TaskHostFilterSettlementWriter } from "../../../src/flow/services/task-host-filter-settlement-writer.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { TaskLifecycleFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

/** The existing no-change producer path with two initially declared Tasks. */
class TaskFrontierScenario {
  constructor(t) {
    this.root = createTmpDir("task-stage-frontier-");
    t.after(() => removeTmpDir(this.root));
    this.specId = "001-review-scenario";
    this.taskId = "T-1";
    this.sourcePath = path.join(this.root, "README.md");
    fs.writeFileSync(this.sourcePath, "original source\n");
    initGitRepo(this.root);
    commitAll(this.root, "Task frontier source");
    this.reload();
    new TaskLifecycleFixture({
      flowManager: this.manager, specId: this.specId, runId: "task-frontier-regression",
      taskId: this.taskId, targetStep: "task-impl",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Preserve bounded Review behavior.", task_ids: [this.taskId] },
          { id: "R-2", desc: "Preserve the next declared Task.", task_ids: ["T-2"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: ["T-1", "T-2"].map((id) => ({ id, title: `Task ${id}`, goal: "Preserve Task order.",
        parent: null, origin: "plan", added_round: 0, status: "pending" })),
    }).create();
    TaskReviewScenario.prototype.confirmNoChangeImplementation.call(this);
  }
  reload() { this.manager = makeFlowManager(this.root); return this; }
  state() { return this.manager.canonicalState(this.specId); }
  context() { return TaskReviewScenario.prototype.context.call(this); }
  review(...args) { return TaskReviewScenario.prototype.review.call(this, ...args); }
  publishReview(...args) { return TaskReviewScenario.prototype.publishReview.call(this, ...args); }
  snapshot() { return TaskReviewScenario.prototype.snapshot.call(this); }
}

function semanticSnapshot(scenario) {
  const state = scenario.state();
  const review = new TaskStageArtifact({ flowManager: scenario.manager, state, taskId: scenario.taskId, role: "review" });
  const lineages = scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId });
  const budget = lineages.at(-1).budget;
  const accounting = new TaskReviewAccounting({ taskId: scenario.taskId, budget, history: review.history });
  return { budget: budget.toJSON(), completedReviewCount: accounting.completedReviewCount,
    lineages: lineages.map((entry) => entry.toJSON()), source: fs.readFileSync(scenario.sourcePath, "utf8") };
}

test("Task stage refuses a kind-congruent Result that replaces its acquired successor frontier", async (t) => {
  const scenario = new TaskFrontierScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const reviewed = await scenario.publishReview([{
    findingKey: "missing-behavior", title: "Required behavior is missing",
    failureMode: "missing_acceptance_requirement", file: null, requirementId: "R-1",
    issue: "The selected behavior needs explicit review.", suggestion: "Verify the canonical behavior.",
    disposition: "must-fix", rationale: "The mapped Requirement requires this behavior.",
  }]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  const directive = (await new GetNextActionCommand().execute(scenario.context())).context.taskReviewFilter;
  const review = new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review" });
  const candidate = scenario.manager.prepareTaskReviewHostFilterPublication({
    specId: scenario.specId,
    exclusions: review.document.blockingFindings.map(({ findingId }) => ({ findingId,
      reason: "The required behavior is already satisfied by the canonical no-change source." })),
    expectAttemptId: directive.attemptId, expectReviewDigest: directive.reviewDigest,
    expectSourceFingerprint: directive.sourceFingerprint, expectCatalogFingerprint: directive.catalogFingerprint,
  });
  const binding = new TaskStepBinding({ flowManager: scenario.manager, specId: scenario.specId,
    definitionStepId: "task-triage" });
  const valid = new TaskTriageNoChangeCompletedResult({ evidence: new TaskStageResultEvidence({
    facts: candidate.facts, frontier: candidate.taskFrontier }) });
  assert.equal(settleTaskStepResult("task-triage", valid).targetStepId, "T-2-impl");
  const forgedFrontier = new ImplementationTaskFrontier(candidate.taskFrontier.toJSON().map((entry) => (
    entry.taskId === "T-2" ? { ...entry, status: "done" } : entry
  )));
  const forged = new TaskTriageNoChangeCompletedResult({ evidence: new TaskStageResultEvidence({
    facts: candidate.facts, frontier: forgedFrontier }) });
  const selected = settleTaskStepResult("task-triage", forged);
  assert.equal(forged.kind, valid.kind);
  assert.equal(forged.type, valid.type);
  assert.equal(forged.evidence.facts, candidate.facts);
  assert.equal(selected.targetStepId, "test-execute");
  const before = scenario.snapshot();
  const semantics = semanticSnapshot(scenario);
  const publication = candidate.toJSON();
  const writer = new TaskHostFilterSettlementWriter({ flowManager: scenario.manager, binding, publication: candidate });
  assert.throws(() => scenario.manager.confirmTaskReviewHostFilter({ binding, stepResult: forged,
    settlement: selected, taskStagePublication: candidate }), CurrentFlowStateConflictError);
  assert.throws(() => writer.settle({ stepResult: forged, settlement: selected }), (error) => (
    error instanceof StepAdmissionRefusal && error.cause instanceof CurrentFlowStateConflictError
    && error.cause.code === "CURRENT_FLOW_STATE_CONFLICT"
  ));
  scenario.reload();
  assert.equal(scenario.snapshot(), before);
  assert.deepEqual(semanticSnapshot(scenario), semantics);
  assert.deepEqual(candidate.toJSON(), publication);

  const prepared = taskStepRegistration("task-triage").create({ flowManager: scenario.manager,
    binding: new TaskStepBinding({ flowManager: scenario.manager, specId: scenario.specId,
      definitionStepId: "task-triage" }), taskStagePublication: candidate });
  const result = prepared.step.execute();
  assert.equal(result.kind, valid.kind);
  scenario.reload();
  assert.equal(scenario.state().findNode("T-1").status, "done");
  assert.equal(scenario.state().findNode("T-2").status, "pending");
  assert.equal(scenario.state().nextAction().nodeId, "T-2-impl");
  assert.deepEqual(semanticSnapshot(scenario), semantics);
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "T-1-triage", completed: true });
  assert.equal(saved.receipt.targetStepId, "T-2-impl");
  assert.deepEqual(saved.result.evidence.frontier.toJSON(), candidate.taskFrontier.toJSON());
});
