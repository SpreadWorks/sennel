import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

import SetStepCommand from "../../../src/flow/lib/set-step.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ImplPhaseScenario, implementationFinding } from "../../support/impl-phase-scenario.js";
import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";

const seedScope = new SeedCleanupScope(after, mock);
let repairSeed;

async function repairScenario(t) {
  repairSeed ??= ImplPhaseScenario.seed(seedScope, {
    frontier: "impl-triage",
    implReviewResponse: (stage, ordinal) => ({
      blockingFindings: stage === "impl-review" && ordinal === 1 ? [implementationFinding()] : [],
      nonBlockingImprovements: [],
    }),
  });
  return ImplPhaseScenario.fromSeed(t, await repairSeed);
}

describe("canonical set-step implementation repair", () => {
  it("confirms registered impl-triage and impl-repair without legacy repair sidecars", async (t) => {
    const scenario = await repairScenario(t);
    assert.equal(scenario.current(), "impl-triage");
    for (const [stepId, kind, target] of [
      ["impl-triage", "impl-triage-repair-required", "impl-repair"],
      ["impl-repair", "impl-repair-applied", "test-execute"],
    ]) {
      const attempt = scenario.state().attempt.id;
      const before = scenario.snapshot();
      const refused = await new SetStepCommand().execute({ ...scenario.context(), id: stepId,
        status: stepId === "impl-triage" ? "skipped" : "done" });
      assert.equal(refused.ok, false);
      assert.equal(refused.errors[0].code, "FLOW_STEP_TRANSITION_INVALID");
      assert.match(refused.errors[0].messages[0], /owned by its definition lifecycle/);
      assert.deepEqual(scenario.snapshot(), before);
      await scenario.executeCurrent();
      scenario.reload();
      const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId, completed: true });
      assert.equal(saved.result.kind, kind);
      assert.equal(saved.receipt.binding.attemptId, attempt);
      assert.equal(saved.receipt.targetStepId, target);
      assert.equal(scenario.state().findNode(stepId).status, "done");
      assert.equal(scenario.current(), target);
      scenario.assertResults([stepId]);
    }
    for (const name of ["impl-triage.json", "impl-repair.json", "impl-repair-transaction.json"]) {
      assert.equal(fs.existsSync(path.join(scenario.root, "specs", scenario.specId, name)), false);
    }
  });

  it("skips unexecuted impl-triage through its actual Review Result and source receipt", async (t) => {
    const scenario = ImplPhaseScenario.create(t);
    await scenario.advanceTo("impl-review");
    const attempts = new Map(["impl-triage", "impl-repair"].map((id) => [id, scenario.state().findNode(id).attemptSequence]));
    const workerCount = scenario.phaseWorkers.length;
    await scenario.executeCurrent();
    scenario.reload();
    const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-review", completed: true });
    assert.equal(saved.result.kind, "impl-review-passed");
    assert.equal(saved.receipt.targetStepId, "impl-gate");
    scenario.assertResults(["impl-review"]);
    for (const [id, sequence] of attempts) {
      const node = scenario.state().findNode(id);
      assert.equal(node.status, "skipped");
      assert.equal(node.attemptSequence, sequence);
      assert.equal(node.result.stepResult, null);
      assert.equal(node.result.draftSettlementReceipt, null);
      assert.deepEqual(node.result.artifactRefs.map(({ kind, id }) => ({ kind, id })),
        [{ kind: "source-step-settlement", id: saved.receipt.id }]);
      assert.ok(saved.settlement.effects.unexecutedStepCompletions.some((entry) => entry.stepId === id));
      assert.equal(fs.existsSync(path.join(scenario.root, "specs", scenario.specId, `${id}.json`)), false);
    }
    assert.equal(scenario.phaseWorkers.length, workerCount, "unused repair stages cannot fabricate worker success");
  });

  it("rejects completion of a non-current implementation leaf", async (t) => {
    const scenario = await repairScenario(t);
    const ctx = scenario.context();

    const before = { state: ctx.flowManager.canonicalState(ctx.specId).toJSON(),
      activities: ctx.flowManager.activityLedger(ctx.specId), catalog: ctx.flowManager.artifactCatalog(ctx.specId).toJSON() };
    const result = await new SetStepCommand().execute({
      ...ctx,
      id: "impl-repair",
      status: "done",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_STEP_TRANSITION_INVALID");
    assert.match(result.errors[0].messages[0], /owned by its definition lifecycle/);
    assert.deepEqual({ state: ctx.flowManager.canonicalState(ctx.specId).toJSON(),
      activities: ctx.flowManager.activityLedger(ctx.specId), catalog: ctx.flowManager.artifactCatalog(ctx.specId).toJSON() }, before);
    for (const name of ["impl-triage.json", "impl-repair.json", "impl-repair-transaction.json"]) {
      assert.equal(fs.existsSync(path.join(scenario.root, "specs", ctx.specId, name)), false);
    }
    assert.equal(findStepById(ctx.flowManager.loadReadOnly(ctx.specId).steps, "impl-triage").status, "in_progress");
  });

  it("rejects a noncanonical mutable state instead of replaying a repair transaction", async (t) => {
    const invalidRoot = createTmpDir("set-step-noncanonical-repair-");
    t.after(() => removeTmpDir(invalidRoot));
    const result = await new SetStepCommand().execute({
      root: invalidRoot,
      flowManager: { load: () => ({ specId: "legacy", steps: [] }) },
      id: "impl-repair",
      status: "done",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "CANONICAL_FLOW_REQUIRED");
  });
});
