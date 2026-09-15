import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import {
  WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { container } from "../../../src/lib/container.js";
import { TaskReviewEpisodeBinding } from "../../../src/flow/lib/task-review-stage-artifacts.js";
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

function scenarioFor(t) {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  return scenario;
}

async function selectedRepair(t) {
  const scenario = scenarioFor(t);
  const reviewed = await scenario.publishReview([finding()]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  const filtered = await scenario.filter([]);
  assert.equal(filtered.ok, true, JSON.stringify(filtered));
  return { scenario };
}

test("Task sealed repair handoff recovers its bound review and host-filter lineage exactly once", async (t) => {
  const { scenario } = await selectedRepair(t);
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
  const { scenario } = await selectedRepair(t);
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
  const { scenario } = await selectedRepair(t);
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

test("an unsealed failed Task repair with a canonical mutation remains preserved", async (t) => {
  const { scenario } = await selectedRepair(t);
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
