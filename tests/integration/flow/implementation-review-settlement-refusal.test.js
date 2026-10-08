import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunSettleReviewTransitionCommand from "../../../src/flow/lib/run-settle-review-transition.js";
import { ReviewTransitionFacts } from "../../../src/flow/lib/review-transition-facts.js";
import { CurrentFlowStateInvariantError } from "../../../src/flow/lib/current-flow-state.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";

function protectedEvidence(scenario) {
  const files = [];
  function visit(relative) {
    const absolute = path.join(scenario.root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
    } else files.push([relative, fs.readFileSync(absolute)]);
  }
  for (const relative of ["specs", ".sennel", "src", "project-tests", "package.json"]) visit(relative);
  return { canonical: scenario.snapshot(), files, workers: scenario.requests.length,
    reviews: scenario.reviews.length + scenario.phaseReviews.length };
}

test("public Review settlement refuses migrated Task and Impl producers without reclassification or effects", async (t) => {
  const scenario = ImplPhaseScenario.create(t);
  const task = new TaskStepIdentity({ taskId: "T1", role: "review" });
  for (const [nodeId, stepId, taskId] of [[task.nodeId, task.definitionId, task.taskId],
    ["impl-review", "impl-review", null]]) {
    await scenario.advanceTo(nodeId);
    const ctx = { ...scenario.context(), phase: "impl" };
    // The actual command claims its registered Step and seals real external
    // Review output. The retired settlement command cannot publish that output
    // or reinterpret the current claim before its registered post consumes it.
    const output = await new RunReviewCommand().execute(ctx);
    assert.notEqual(output.ok, false, JSON.stringify(output));
    assert.equal(output.artifacts.verdict, "PASS");
    const claim = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId, taskId });
    assert.equal(claim.receipt.settlementKind, "execution");
    const originalManager = scenario.manager;
    scenario.reload();
    assert.notEqual(scenario.manager, originalManager);
    const before = protectedEvidence(scenario);
    const facts = t.mock.method(ReviewTransitionFacts, "forCurrentAttempt");
    const processes = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]
      .map((name) => t.mock.method(childProcess, name));
    syncBuiltinESMExports();
    try {
      const refused = new RunSettleReviewTransitionCommand().execute(scenario.context());
      assert.equal(refused.ok, false);
      assert.equal(refused.errors[0].code, "REVIEW_TRANSITION_SETTLEMENT_UNAVAILABLE");
      assert.equal(facts.mock.callCount(), 0, "a migrated Review cannot be classified again from raw publication facts");
      assert.ok(processes.every((process) => process.mock.callCount() === 0), "refusal cannot execute another producer");
      assert.deepEqual(protectedEvidence(scenario), before);
      let confirmationError = null;
      let confirmation = null;
      try {
        confirmation = scenario.manager.confirmCurrentAttempt({ specId: scenario.specId, commandResult: output });
      } catch (error) { confirmationError = error; }
      assert.ok(confirmationError instanceof CurrentFlowStateInvariantError, JSON.stringify({
        nodeId, error: confirmationError === null ? null : { name: confirmationError.name,
          code: confirmationError.code, message: confirmationError.message },
        confirmedResult: confirmation?.findNode(nodeId)?.result?.toJSON() ?? null,
        canonicalUnchanged: isDeepStrictEqual(protectedEvidence(scenario).canonical, before.canonical),
        processCalls: processes.map((process) => process.mock.callCount()),
      }));
      assert.equal(confirmationError.code, "CURRENT_FLOW_STATE_INVARIANT_INVALID");
      assert.equal(confirmationError.message,
        "Implementation confirmation requires its atomic selected Result and settlement receipt");
      assert.ok(processes.every((process) => process.mock.callCount() === 0), "generic confirmation refusal cannot execute another producer");
      assert.deepEqual(protectedEvidence(scenario), before);
      const retained = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId, taskId });
      assert.deepEqual(retained.receipt.toJSON(), claim.receipt.toJSON());
    } finally {
      facts.mock.restore();
      for (const process of processes) process.mock.restore();
      syncBuiltinESMExports();
    }
    await FLOW_COMMANDS.run.review.post({ ...ctx, flowManager: scenario.manager,
      flowState: scenario.manager.loadReadOnly(scenario.specId) }, output);
    scenario.reload();
    const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId, taskId, completed: true });
    assert.equal(saved.result.kind, taskId === null ? "impl-review-passed" : "task-review-gate-required");
    assert.equal(saved.receipt.settlementKind, "target-connection");
    assert.equal(saved.receipt.targetStepId, taskId === null ? "impl-gate"
      : new TaskStepIdentity({ taskId, role: "gate" }).nodeId);
    scenario.assertResults([nodeId]);
  }
});
