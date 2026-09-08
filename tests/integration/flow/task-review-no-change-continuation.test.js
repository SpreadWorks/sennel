import assert from "node:assert/strict";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { FlowCompletion } from "../../../src/flow/lib/flow-completion.js";
import { buildAcceptancePrompt } from "../../../src/flow/lib/run-acceptance-review.js";

test("Task no-change Review persists its Definition continuation through reload for Acceptance", async (t) => {
  const scenario = new TaskReviewScenario(t, { noChange: true });
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const result = await scenario.publishReview();
  assert.notEqual(result.ok, false, JSON.stringify(result));
  scenario.reload();

  const state = scenario.state();
  assert.equal(state.findNode("T-1-review").status, "done");
  assert.equal(state.findNode("T-1-triage").status, "skipped");
  assert.equal(state.findNode("T-1-repair").status, "skipped");
  assert.equal(state.findNode("T-1-gate").status, "skipped");
  assert.match(state.findNode("T-1-gate").result.summary, /already present/);
  assert.equal(state.findNode("T-1").status, "done");
  assert.equal(state.nextAction().nodeId, "test-execute");
  const convergence = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager,
    state,
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  });
  const handoff = convergence.handoffs().find((entry) => entry.taskId === scenario.taskId && entry.noChange === true);
  assert.ok(handoff);
  const document = handoff.toJSON();
  assert.equal(document.continuation.decision, "continue");
  assert.match(document.continuation.reason, /already present/);
  assert.equal(document.continuation.facts.review.sourceFingerprint, document.canonicalTaskSource.fingerprint);
  assert.equal(document.continuation.facts.acceptance.reviewArtifactDigest, document.continuation.facts.review.artifactDigest);
  assert.equal(convergence.status()[0].assurance, "advisory");
  const projected = scenario.manager.loadReadOnly(scenario.specId);
  assert.equal(new FlowCompletion(projected).assurance, "advisory");
  assert.equal(projected.advisorySummary[0].evidenceRef, document.continuation.acceptanceHandoffId);
  const prompt = buildAcceptancePrompt({ evidence: { taskReviewHandoffs: [document] } });
  assert.match(prompt.systemPrompt, /noChange=true/);
  assert.match(prompt.systemPrompt, /without assuming a repair occurred/);
});


test("draft reopen retires no-change advisory and Acceptance evidence from the previous review cycle", async (t) => {
  const scenario = new TaskReviewScenario(t, { noChange: true });
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.publishReview();
  assert.equal(scenario.manager.loadReadOnly(scenario.specId).advisorySummary.length, 1);
  scenario.manager.updateStepStatus({ stepId: "test-execute", requestedStatus: "in_progress" }, { specId: scenario.specId });
  scenario.manager.reopenDraft({ specId: scenario.specId, route: "task-addition" });
  scenario.reload();
  const state = scenario.state();
  const projected = scenario.manager.loadReadOnly(scenario.specId);
  assert.equal(projected.advisorySummary, undefined);
  assert.equal(new FlowCompletion(projected).assurance, "strict");
  const convergence = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state,
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  });
  assert.deepEqual(convergence.handoffs(), []);
});
