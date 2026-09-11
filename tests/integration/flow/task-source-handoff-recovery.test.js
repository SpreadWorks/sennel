import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import {
  WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError,
  materializeSourceWorkerEffect, sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { container } from "../../../src/lib/container.js";
import { TaskSourceFailureObservation } from "../../../src/flow/lib/task-source-failure.js";
import { TaskReviewEpisodeBinding, TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { SourceHandoffFailureFacts } from "../../../src/flow/lib/source-handoff-failure.js";
import { resolveSourceHandoffTransitionPlan } from "../../../src/flow/definition.js";

function finding() {
  return {
    findingKey: "missing-behavior", title: "Required behavior is missing",
    failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
    issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.",
    disposition: "must-fix", rationale: "The mapped requirement requires this behavior.",
  };
}

function triageEffect() {
  return {
    version: 1, stepId: "task-triage", completionStatus: "done", issues: [], overview: null,
    triage: { version: 1, dispositions: [{
      findingKey: "missing-behavior", disposition: "apply", basis: "repair-required",
      rationale: "The requirement confirms this missing behavior.",
    }] },
    repair: null, noChangeReason: null,
  };
}

function repairEffect() {
  return {
    version: 1, stepId: "task-repair", completionStatus: "done",
    issues: [], overview: null, triage: null,
    repair: { version: 1, findings: [{ findingKey: "missing-behavior", paths: ["README.md"] }],
      summary: "Implemented the mapped behavior.", recurrenceResolutions: [] },
    noChangeReason: null,
  };
}

function repairEffectWithQualityIssue() {
  return {
    ...repairEffect(),
    issues: [{
      classification: "quality",
      reason: "The repaired behavior still requires an independent quality review.",
      remainingRisk: "A later quality checkpoint must verify the repaired behavior end to end.",
    }],
  };
}

function recover(scenario) {
  scenario.reload();
  return new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-09-08T00:00:00.000Z") })
    .recoverPending({ ctx: scenario.context() });
}

function publishedTaskArtifacts(scenario) {
  return scenario.manager.artifactCatalog(scenario.specId).artifacts
    .filter((entry) => entry.logicalKey !== "flow.activities"
      && entry.logicalKey !== "flow.state"
      && !entry.logicalKey.startsWith("source.handoff."))
    .map((entry) => entry.toJSON());
}

function scenarioFor(t) {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  return scenario;
}

function recordStoppedTaskFailure(scenario, {
  role = "repair", error = null, run = null,
} = {}) {
  const work = scenario.stageHandoff(role);
  try {
    const observed = run?.(work) ?? error;
    work.coordinator.finishSourceWorker({ ctx: work.ctx, request: work.request });
    const mutationAuthority = work.coordinator.sourceMutationAuthority({ ctx: work.ctx, request: work.request });
    const observation = new TaskSourceFailureObservation({
      request: work.request, mutationAuthority, error: observed,
    });
    const facts = SourceHandoffFailureFacts.fromError(observed, {
      request: work.request, ownershipProven: true, workerStopped: true,
    });
    const plan = resolveSourceHandoffTransitionPlan({ facts, policy: work.request.policy });
    assert.equal(plan.disposition, "preserve");
    work.coordinator.recordSourceFailure({ ctx: work.ctx, request: work.request, plan });
    assert.equal(observation.record(scenario.manager, {
      sourceHandoffSettlement: work.coordinator.createSourceFailureSettlement({
        ctx: work.ctx, request: work.request, plan,
      }),
    }), true);
    return { work, observation, plan };
  } finally {
    work.release();
  }
}

async function sealedTriage(t) {
  const scenario = scenarioFor(t);
  const reviewed = await scenario.publishReview([finding()]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  const work = scenario.stageHandoff("triage");
  scenario.sealHandoff(work, triageEffect());
  return { scenario, work };
}

test("Task sealed triage handoff rehydrates a cataloged baseline after restart exactly once", async (t) => {
  const { scenario } = await sealedTriage(t);
  assert.equal(recover(scenario).completed, true);
  assert.equal(scenario.state().current?.at(-1), "T-1-repair");
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  assert.equal(recover(scenario), null);
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount);
});

test("a fresh manager records one bounded failure for a sealed invalid Task triage payload", async (t) => {
  const { scenario, work } = await sealedTriage(t);
  const effectPath = work.request.payloadPath("effects.json");
  const effect = JSON.parse(fs.readFileSync(effectPath, "utf8"));
  effect.triage.dispositions = [];
  fs.writeFileSync(effectPath, `${JSON.stringify(effect, null, 2)}\n`);
  fs.unlinkSync(work.request.submissionPath);
  sealParentMaterializedSourceWorkerEffect({ request: work.request });
  assert.equal(recover(scenario).completed, true);
  assert.equal(scenario.state().attempt.failure.category, "semantic");
  assert.equal(scenario.state().nextAction().operation, "blocked");
  const count = scenario.manager.activityLedger(scenario.specId)
    .filter((activity) => activity.transition?.operation === "fail_attempt").length;
  assert.deepEqual(recover(scenario), { completed: true, replayed: true, cleanedHandoffs: 1 });
  assert.equal(scenario.manager.activityLedger(scenario.specId)
    .filter((activity) => activity.transition?.operation === "fail_attempt").length, count);
  assert.equal(recover(scenario), null);
});

test("Task sealed repair handoff recovers its bound review and triage lineage exactly once", async (t) => {
  const { scenario } = await sealedTriage(t);
  assert.equal(recover(scenario).completed, true);
  const repair = scenario.stageHandoff("repair");
  try {
    fs.appendFileSync(scenario.sourcePath, "recovered repair\n");
    scenario.sealHandoff(repair, repairEffect());
  } catch (error) {
    repair.release();
    throw error;
  }
  scenario.reload();
  const result = new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-09-08T00:00:00.000Z") })
    .recoverPending({ ctx: scenario.context() });
  assert.equal(result.completed, true);
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId })
    .map((entry) => entry.role), ["implementation", "repair"]);
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount);
});

test("Task sealed repair quality issues recover to Review atomically and exactly once", async (t) => {
  const { scenario } = await sealedTriage(t);
  assert.equal(recover(scenario).completed, true);
  const repair = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "repair requiring quality review\n");
  scenario.sealHandoff(repair, repairEffectWithQualityIssue());
  const handoffDigest = JSON.parse(fs.readFileSync(repair.request.submissionPath, "utf8")).handoffDigest;
  scenario.reload();

  const recovered = new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-09-08T00:00:00.000Z") })
    .recoverPending({ ctx: scenario.context() });

  assert.equal(recovered.completed, true);
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  const issueLog = JSON.parse(scenario.manager.readArtifact({
    specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-review",
  }).bytes.toString("utf8"));
  assert.equal(issueLog.entries.length, 1);
  assert.equal(issueLog.entries[0].origin.sourceStep, "task-repair");
  assert.equal(issueLog.entries[0].recoveryStep, "T-1-review");
  assert.deepEqual(issueLog.entries[0].evidence, {
    ref: `worker-handoff:${handoffDigest}#effects.json`,
    digest: handoffDigest,
  });
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount);
  const reloadedIssueLog = JSON.parse(scenario.manager.readArtifact({
    specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-review",
  }).bytes.toString("utf8"));
  assert.equal(reloadedIssueLog.entries.length, 1);
});

test("Task repair quality publication rejects a stale stage binding without partial settlement", async (t) => {
  const { scenario } = await sealedTriage(t);
  assert.equal(recover(scenario).completed, true);
  const work = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "repair with stale publication binding\n");
  scenario.finishHandoff(work, repairEffectWithQualityIssue());
  const before = scenario.snapshot();
  const canonicalManager = scenario.manager;
  const staleManager = new Proxy(canonicalManager, {
    get(target, property) {
      if (property === "confirmSourceWorkerHandoff") {
        return (input) => target.confirmSourceWorkerHandoff({
          ...input,
          taskStageBinding: new TaskReviewEpisodeBinding({
            ...input.taskStageBinding.toJSON(),
            sourceFingerprint: "f".repeat(64),
          }),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let rejection;
  try {
    assert.throws(() => work.coordinator.reconcile({
      ctx: { ...work.ctx, flowManager: staleManager },
      request: work.request,
      mutationAuthority: work.coordinator.sourceMutationAuthority({ ctx: work.ctx, request: work.request }),
    }), (error) => {
      rejection = error;
      return error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED";
    });
  } finally {
    work.release();
  }

  assert.equal(rejection.recoveryPossible, false, JSON.stringify({
    code: rejection.code,
    causeCode: rejection.cause?.code,
    causeName: rejection.cause?.name,
    message: rejection.message,
  }));
  assert.equal(scenario.snapshot(), before);
  assert.equal(scenario.manager.readArtifact({
    specId: scenario.specId, logicalKey: "issue.log", consumerNodeId: "T-1-repair", optional: true,
  }), null);
  assert.equal(scenario.manager.readSourceHandoffAuthority({
    specId: scenario.specId, identity: work.request.sourceHandoffIdentity,
  }).settlement, null);
});

test("Task sealed triage recovery rejects an uncataloged canonical file", async (t) => {
  const { scenario } = await sealedTriage(t);
  fs.writeFileSync(path.join(scenario.manager.specLocation(scenario.specId).directory, "forged-canonical.txt"), "forged\n");
  assert.throws(() => recover(scenario), /canonical|mutation|untrusted/i);
});

test("Task sealed triage recovery rejects source drift", async (t) => {
  const { scenario, work } = await sealedTriage(t);
  const catalogBefore = publishedTaskArtifacts(scenario);
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  fs.appendFileSync(scenario.sourcePath, "late source drift\n");
  assert.equal(recover(scenario)?.completed, true);
  assert.equal(scenario.state().current?.at(-1), "T-1-triage");
  assert.equal(scenario.state().attempt.failure.category, "source-integrity");
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount + 2);
  assert.deepEqual(scenario.manager.activityLedger(scenario.specId).slice(activityCount)
    .map((entry) => entry.transition.operation), ["publish_artifacts", "fail_attempt"]);
  assert.deepEqual(publishedTaskArtifacts(scenario), catalogBefore);
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
  assert.match(fs.readFileSync(scenario.sourcePath, "utf8"), /late source drift/);
  assert.equal(scenario.manager.readSourceHandoffAuthority({
    specId: scenario.specId, identity: work.request.sourceHandoffIdentity,
  }).settlement.kind, "quarantined");
});

test("Task sealed triage recovery rejects index drift", async (t) => {
  const { scenario, work } = await sealedTriage(t);
  const catalogBefore = publishedTaskArtifacts(scenario);
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  // Implementation left README dirty before this stage. Staging that exact
  // baseline content changes only the Git index authority.
  execFileSync("git", ["add", "README.md"], { cwd: scenario.root, stdio: "pipe" });
  assert.equal(recover(scenario)?.completed, true);
  assert.equal(scenario.state().attempt.failure.category, "source-integrity");
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount + 2);
  assert.deepEqual(scenario.manager.activityLedger(scenario.specId).slice(activityCount)
    .map((entry) => entry.transition.operation), ["publish_artifacts", "fail_attempt"]);
  assert.deepEqual(publishedTaskArtifacts(scenario), catalogBefore);
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "implemented source\n");
  assert.equal(scenario.manager.readSourceHandoffAuthority({
    specId: scenario.specId, identity: work.request.sourceHandoffIdentity,
  }).settlement.kind, "quarantined");
});

test("Task sealed triage recovery rejects HEAD drift", async (t) => {
  const { scenario, work } = await sealedTriage(t);
  const catalogBefore = publishedTaskArtifacts(scenario);
  const activityCount = scenario.manager.activityLedger(scenario.specId).length;
  execFileSync("git", ["commit", "--allow-empty", "-m", "drift after sealed handoff"], { cwd: scenario.root, stdio: "pipe" });
  assert.equal(recover(scenario)?.completed, true);
  assert.equal(scenario.state().attempt.failure.category, "source-integrity");
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount + 2);
  assert.deepEqual(scenario.manager.activityLedger(scenario.specId).slice(activityCount)
    .map((entry) => entry.transition.operation), ["publish_artifacts", "fail_attempt"]);
  assert.deepEqual(publishedTaskArtifacts(scenario), catalogBefore);
  assert.equal(new TaskStageArtifact({ flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "triage", optional: true }).reference, null);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), "implemented source\n");
  assert.equal(scenario.manager.readSourceHandoffAuthority({
    specId: scenario.specId, identity: work.request.sourceHandoffIdentity,
  }).settlement.kind, "quarantined");
});

test("Task sealed triage recovery rejects a missing catalog baseline", async (t) => {
  const { scenario, work } = await sealedTriage(t);
  const descriptor = scenario.manager.artifactCatalog(scenario.specId).artifacts.find((entry) => (
    entry.logicalKey === "source.handoff.rollback-blob"
      && entry.relativePath.includes(work.request.sourceHandoffIdentity.storageId)
  ));
  fs.unlinkSync(scenario.manager.specLocation(scenario.specId).resolve(descriptor.relativePath));
  assert.throws(() => recover(scenario), /baseline|catalog|artifact|canonical/i);
});

test("Task unsealed triage recovery remains terminal evidence", async (t) => {
  const scenario = scenarioFor(t);
  const reviewed = await scenario.publishReview([finding()]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  {
    const work = scenario.stageHandoff("triage");
    work.coordinator.finishSourceWorker({ ctx: work.ctx, request: work.request });
    work.release();
  }
  assert.throws(() => recover(scenario), /unsealed|unverified|source/i);
  assert.equal(scenario.state().current?.at(-1), "T-1-triage");
});

test("an unsealed zero-change Task repair semantic failure is cleaned before Definition retries", async (t) => {
  const { scenario } = await sealedTriage(t);
  recover(scenario);
  recordStoppedTaskFailure(scenario, {
    error: new WorkerArtifactHandoffError("invalid", "TASK_REPAIR_SEMANTIC_FAILURE", "repair response was semantically invalid", {
      data: { failureKind: "semantic" },
    }),
  });
  assert.equal(recover(scenario).completed, true);
  assert.equal(scenario.state().attempt.failure.category, "semantic");
  assert.equal(scenario.state().nextAction().operation, "retry");
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  assert.equal(scenario.state().current?.at(-1), "T-1-repair");
  assert.equal(scenario.state().attempt.failure, null);
  assert.deepEqual(scenario.state().attempt.consumption.toJSON(), { semantic: 1, tooling: 0 });
});

test("an unsealed zero-change Task repair tooling failure is cleaned before Definition retries", async (t) => {
  const { scenario } = await sealedTriage(t);
  recover(scenario);
  recordStoppedTaskFailure(scenario, {
    error: new WorkerArtifactHandoffError("invalid", "TASK_REPAIR_TOOLING_FAILURE", "repair provider was unavailable"),
  });
  assert.equal(recover(scenario).completed, true);
  assert.equal(scenario.state().attempt.failure.category, "tooling");
  assert.equal(scenario.state().nextAction().operation, "retry");
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  assert.equal(scenario.state().attempt.consumption.tooling, 1);
});

test("three semantic Task repair failures remain blocked without exposing Gate", async (t) => {
  const { scenario } = await sealedTriage(t);
  assert.equal(recover(scenario).completed, true);
  const invalidRepair = {
    version: 1, stepId: "task-repair", completionStatus: "done",
    issues: [], overview: null,
    triage: null,
    repair: {
      version: 1,
      findings: [{ findingKey: "missing-behavior", paths: ["README.md"] }],
      summary: "Claims a repair without changing source.",
      recurrenceResolutions: [],
    },
    noChangeReason: null,
  };
  const attempts = [];
  for (let index = 0; index < 3; index += 1) {
    const attemptId = scenario.state().attempt.id;
    let failure = null;
    const { work } = recordStoppedTaskFailure(scenario, { run: (staged) => {
      try {
        materializeSourceWorkerEffect({ request: staged.request, responseText: JSON.stringify(invalidRepair) });
      } catch (error) {
        failure = error;
      }
      return failure;
    } });
    attempts.push(attemptId);
    assert.equal(failure?.data?.failureKind, "semantic");
    assert.equal(recover(scenario).completed, true);
    scenario.reload();
    assert.equal(scenario.state().attempt.failure.category, "semantic");
    assert.equal(scenario.state().nextAction().operation, index < 2 ? "retry" : "blocked");
    const review = new TaskStageArtifact({
      flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review",
    });
    const budget = scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).at(-1).budget;
    assert.equal(new TaskReviewAccounting({ taskId: scenario.taskId, budget, history: review.history }).completedReviewCount, 1);
    if (index < 2) scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  }
  scenario.reload();
  const exhausted = scenario.state();
  assert.equal(new Set(attempts).size, 3);
  assert.equal(exhausted.current?.at(-1), "T-1-repair");
  assert.equal(exhausted.findNode("T-1-repair").status, "in_progress");
  assert.equal(exhausted.findNode("T-1-gate").status, "pending");
  assert.equal(exhausted.attempt.consumption.semantic, 2);
  assert.equal(exhausted.nextAction().operation, "blocked");
  assert.equal(scenario.manager.missingProducerArtifactRoute({ specId: scenario.specId }), null);
  const blockedSnapshot = exhausted.toJSON();
  assert.throws(() => scenario.manager.retryCurrentAttempt({ specId: scenario.specId }), /does not authorize retry/);
  assert.deepEqual(scenario.state().toJSON(), blockedSnapshot);
  assert.throws(() => scenario.manager.settleCurrentFailure({ specId: scenario.specId }), /no settle transition/);
  assert.deepEqual(scenario.state().toJSON(), blockedSnapshot);
  assert.equal(recover(scenario), null);
  scenario.reload();
  assert.equal(scenario.state().nextAction().operation, "blocked");
});

test("an unsealed failed Task repair with a canonical mutation remains preserved", async (t) => {
  const { scenario } = await sealedTriage(t);
  recover(scenario);
  const repair = (() => {
    const work = scenario.stageHandoff("repair");
    try {
      work.coordinator.finishSourceWorker({ ctx: work.ctx, request: work.request });
      const error = new WorkerArtifactHandoffError("invalid", "TASK_REPAIR_SEMANTIC_FAILURE", "repair response was semantically invalid", {
        data: { failureKind: "semantic" },
      });
      const facts = SourceHandoffFailureFacts.fromError(error, {
        request: work.request, ownershipProven: true, workerStopped: true,
      });
      const plan = resolveSourceHandoffTransitionPlan({ facts, policy: work.request.policy });
      work.coordinator.recordSourceFailure({ ctx: work.ctx, request: work.request, plan });
      return work;
    } finally {
      work.release();
    }
  })();
  fs.writeFileSync(path.join(scenario.manager.specLocation(scenario.specId).directory, "forged-after-failure.txt"), "forged\n");
  assert.throws(() => recover(scenario), /canonical|artifact|untrusted|mutation/i);
  assert.equal(fs.existsSync(repair.request.directory), true);
});
