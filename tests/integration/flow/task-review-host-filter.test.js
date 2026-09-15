import assert from "node:assert/strict";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunFilterTaskReviewCommand from "../../../src/flow/lib/run-filter-task-review.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";

const findings = [
  {
    findingKey: "required-behavior", title: "Required behavior is missing",
    failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
    issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.",
    disposition: "must-fix", rationale: "The mapped requirement requires this behavior.",
  },
  {
    findingKey: "naming-improvement", title: "Naming can be clearer",
    failureMode: "maintainability", file: "README.md", requirementId: "R-1",
    issue: "The implementation uses a vague name.", suggestion: "Use a clearer name.",
    disposition: "informational", rationale: "This is useful but does not violate a mandatory requirement.",
  },
];

test("host filter rejects invalid or stale identity without side effects and publishes selected findings", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.publishReview(findings);

  const projected = await new GetNextActionCommand().execute(scenario.context());
  assert.equal(projected.directive.kind, "await_task_review_filter");
  assert.equal(projected.directive.requiresUserAction, false);
  assert.equal(projected.context.taskReviewFilter.findings.length, 2);
  const [first, second] = projected.context.taskReviewFilter.findings;
  assert.equal(first.findingKey, undefined);
  assert.equal(first.title, findings[0].title);
  assert.equal(first.file, findings[0].file);
  assert.equal(first.requirementId, findings[0].requirementId);
  assert.equal(first.issue, findings[0].issue);
  assert.equal(first.suggestion, findings[0].suggestion);

  for (const [name, exclusions, overrides] of [
    ["unknown", [{ findingId: "unknown-finding", reason: "not applicable" }], {}],
    ["duplicate", [{ findingId: first.findingId, reason: "one" }, { findingId: first.findingId, reason: "two" }], {}],
    ["missing reason", [{ findingId: first.findingId, reason: "" }], {}],
    ["unknown field", [{ findingId: first.findingId, reason: "not applicable", note: "unchecked" }], {}],
    ["stale catalog", [], { expectCatalogFingerprint: "0".repeat(64) }],
    ["stale Review", [], { expectReviewDigest: "0".repeat(64) }],
    ["stale source", [], { expectSourceFingerprint: "0".repeat(64) }],
    ["stale Attempt", [], { expectAttemptId: "stale-attempt" }],
  ]) {
    const before = scenario.snapshot();
    const result = await scenario.filter(exclusions, overrides);
    assert.equal(result.ok, false, name);
    assert.equal(scenario.snapshot(), before, name);
  }

  const accepted = await scenario.filter([{ findingId: first.findingId, reason: "x" }]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  const triage = new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage",
  }).document;
  assert.deepEqual(triage.hostFilter.exclusions, [{ findingId: first.findingId, reason: "x" }]);
  assert.deepEqual(triage.hostFilter.repairFindingIds, [second.findingId]);
  assert.deepEqual(
    triage.dispositions.map(({ findingKey, disposition, basis }) => ({ findingKey, disposition, basis })),
    [
      { findingKey: findings[0].findingKey, disposition: "reject", basis: "host-excluded" },
      { findingKey: findings[1].findingKey, disposition: "apply", basis: "repair-required" },
    ],
  );
  const after = scenario.snapshot();
  const replay = new RunFilterTaskReviewCommand().execute({
    ...scenario.context(), exclusions: "[]",
    expectAttemptId: projected.context.taskReviewFilter.attemptId,
    expectReviewDigest: projected.context.taskReviewFilter.reviewDigest,
    expectSourceFingerprint: projected.context.taskReviewFilter.sourceFingerprint,
    expectCatalogFingerprint: projected.context.taskReviewFilter.catalogFingerprint,
  });
  assert.equal(replay.ok, false);
  assert.equal(scenario.snapshot(), after);
});

test("Task repair publishes a typed zero-mutation outcome and advances without rerunning the worker", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.publishReview([findings[0]]);
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();

  const work = scenario.stageHandoff("repair");
  const result = scenario.completeHandoff(work, {
    version: 1,
    stepId: "task-repair",
    completionStatus: "done",
    issues: [],
    overview: null,
    triage: null,
    repair: null,
    noChangeReason: {
      classification: "unrepairable",
      findingKeys: [findings[0].findingKey],
      reason: "The selected finding cannot be repaired without changing the approved Task scope.",
    },
  });
  assert.equal(result.completed, true);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-review");
  assert.equal(scenario.state().attempt.failure, null);
  const repair = new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "repair",
  }).document;
  assert.deepEqual(repair.repairNoChange, {
    classification: "unrepairable",
    findingKeys: [findings[0].findingKey],
    reason: "The selected finding cannot be repaired without changing the approved Task scope.",
  });
  assert.deepEqual(repair.sourceMutationManifest.mutations, []);
  const lineage = scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1);
  assert.equal(lineage.role, "repair");
  assert.equal(lineage.noChangeReason, repair.repairNoChange.reason);
});

test("an informational-only Review is host-filtered and selected for Task repair", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.publishReview([findings[1]]);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
  const projected = await new GetNextActionCommand().execute(scenario.context());
  assert.equal(projected.directive.kind, "await_task_review_filter");
  assert.equal(projected.context.taskReviewFilter.findings[0].findingId.length > 0, true);
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  const triage = new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage",
  }).document;
  assert.equal(triage.dispositions[0].disposition, "apply");
  assert.equal(triage.reviewFindings[0].disposition, "informational");
});

test("an unusable stopped Task repair response converges to canonical no-change without consuming Review", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.publishReview([findings[0]]);
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();

  let calls = 0;
  const dispatcher = new RunDispatchCommand({
    nextAction: { run: async () => new GetNextActionCommand().execute(scenario.context()) },
    agent: { async call() { calls += 1; return "{ malformed"; } },
    maxDispatches: 1,
    leaseFactory: () => ({ acquire() {}, release() {} }),
  });
  dispatcher.container = {};
  const dispatchContext = {
    ...scenario.context(),
    expectRunId: scenario.state().runId,
    expectSpec: scenario.specId,
    _envelopeType: "run",
    _envelopeKey: "dispatch",
  };
  const boundary = await dispatcher.execute(dispatchContext);
  if (calls === 0) assert.ok(boundary.dispatch?.approvalToken, JSON.stringify(boundary));
  const result = calls === 0
    ? await dispatcher.execute({ ...dispatchContext, approve: boundary.dispatch.approvalToken })
    : boundary;
  assert.equal(calls, 1, "schema failure is not retried with the same worker contract");
  assert.equal(result.errors[0].code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result));

  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-review");
  assert.equal(scenario.state().attempt.failure, null);
  const repair = new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "repair",
  }).document;
  assert.equal(repair.repairNoChange.classification, "unrepairable");
  assert.match(repair.repairNoChange.reason, /FLOW_SOURCE_HANDOFF_RESPONSE_INVALID/);
  assert.deepEqual(repair.sourceMutationManifest.mutations, []);
  const review = new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review",
  });
  const budget = scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1).budget;
  assert.equal(new TaskReviewAccounting({ taskId: scenario.taskId, budget, history: review.history }).completedReviewCount, 1);
  assert.equal((await new GetNextActionCommand().execute(scenario.context())).step, "task-review");
});
