import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { container } from "../../../src/lib/container.js";
import { RunGateCommand } from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { taskReviewReadiness } from "../../../src/flow/lib/gate-transition-facts.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";

test("a genuine Task Review PASS refuses source drift before Gate provider or canonical effects", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  assert.notEqual((await scenario.publishReview([])).ok, false);
  scenario.reload();
  assert.equal(taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }).status, "ready");
  fs.appendFileSync(scenario.sourcePath, "unreviewed allowlisted source change\n");
  const protectedState = scenario.snapshot();
  let providerCalls = 0;
  const provider = installGateProviderFake((_prompt, options) => {
    providerCalls += 1;
    if (!(options.jsonSchema?.required ?? []).includes("evaluations")) {
      return JSON.stringify({ observations: [], ...((options.jsonSchema?.required ?? []).includes("evaluationUnavailable")
        ? { evaluationUnavailable: null } : {}) });
    }
    const ids = options.jsonSchema?.properties?.evaluations?.items?.properties?.guardrail_id?.enum ?? [];
    return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({
      guardrail_id, result: "pass", reason: "The external evaluator reports a nominal PASS.",
    })) });
  });
  let refusal = null;
  let outcome = null;
  try {
    const ctx = { ...scenario.context(), phase: "task-impl" };
    await FLOW_COMMANDS.run.gate.pre(ctx);
    outcome = await new RunGateCommand().execute(ctx);
    await FLOW_COMMANDS.run.gate.post(ctx, outcome);
  } catch (error) {
    refusal = error;
  } finally {
    provider.mock.restore();
  }
  assert.ok(refusal instanceof StepAdmissionRefusal, JSON.stringify({
    result: outcome?.result, providerCalls, current: scenario.state().current, refusal: refusal?.message,
  }));
  assert.match(refusal.message, /source.*Review|Review.*source/i);
  assert.equal(providerCalls, 0, "stale semantic Review authority must refuse before provider execution");
  assert.equal(scenario.snapshot(), protectedState, "source identity refusal must not save a Gate checkpoint, Result, Activity or metric");
  assert.throws(() => taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }), StepAdmissionRefusal);
  scenario.reload();
  assert.equal(scenario.snapshot(), protectedState);
});

test("a certified fourth no-change repair retains risk but refuses later unowned source drift", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const findingKey = `missing-behavior-${ordinal}`;
    assert.notEqual((await scenario.publishReview([{ findingKey, title: `Required behavior ${ordinal} is missing`,
      failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
      issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.",
      disposition: "must-fix", rationale: "The mapped requirement requires this behavior." }])).ok, false);
    assert.equal((await scenario.filter([])).ok, true);
    const work = scenario.stageHandoff("repair");
    if (ordinal < 4) fs.appendFileSync(scenario.sourcePath, `certified repair ${ordinal}\n`);
    assert.equal(scenario.completeHandoff(work, { version: 1, stepId: "task-repair", completionStatus: "done",
      issues: [], overview: null, triage: null,
      repair: ordinal === 4 ? null : { version: 1, findings: [{ findingKey, paths: ["README.md"] }],
        summary: "Implemented the missing mapped behavior.", recurrenceResolutions: [] },
      noChangeReason: ordinal === 4 ? { classification: "no-change", findingKeys: [findingKey],
        reason: "The attempted correction made no source change; the final finding remains unresolved." } : null,
    }).completed, true);
    scenario.reload();
  }
  const evidence = () => {
    const state = scenario.state();
    return new TaskReviewConvergenceEvidence({ flowManager: scenario.manager, state,
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId,
        activities: scenario.manager.activityLedger(scenario.specId) }) });
  };
  const carry = evidence().handoffs().find((entry) => entry.taskId === scenario.taskId).toJSON();
  assert.equal(carry.reviewAttempt, 4);
  assert.equal(carry.unreviewedAfterRepair, true);
  assert.equal(carry.sourceMutationManifest.mutations.length, 0);
  assert.ok(carry.repairNoChange);
  assert.equal(taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }).status, "blocking", "a certified no-change repair preserves the unresolved finding");
  const canonical = scenario.snapshot();
  const rows = scenario.manager.activityLedger(scenario.specId);
  const sourceRow = rows.findLast((entry) => entry.result?.stepResult?.kind === "task-repair-unreviewed-gate");
  assert.ok(sourceRow);
  for (const overrides of [
    { sourceHandoffAuthorities: () => [] },
    { activityLedger: () => rows.map((entry) => {
      const copy = structuredClone(entry);
      if (copy.id === sourceRow.id) copy.result.draftSettlementReceipt.resultDigest = "0".repeat(64);
      return copy;
    }) },
  ]) {
    const reader = new Proxy(scenario.manager, { get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.throws(() => taskReviewReadiness({ flowManager: reader, state: scenario.state(), taskId: scenario.taskId }),
      "the fourth-repair flag alone cannot replace actual source authority and receipt proof");
    assert.equal(scenario.snapshot(), canonical);
  }
  fs.appendFileSync(scenario.sourcePath, "unowned change after fourth repair\n");
  assert.throws(() => taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }), StepAdmissionRefusal);
  scenario.reload();
  assert.deepEqual(evidence().handoffs().find((entry) => entry.taskId === scenario.taskId).toJSON(), carry,
    "later source changes do not erase the certified historical unreviewed risk");
  assert.equal(scenario.snapshot(), canonical);
});

test("historical unavailable Review risk survives later source changes while Gate authority refuses them", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  await scenario.review(() => ({ ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false }))
    .execute(scenario.context());
  scenario.reload();
  assert.equal(taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }).status, "unavailable");
  const evidence = () => {
    const state = scenario.state();
    return new TaskReviewConvergenceEvidence({ flowManager: scenario.manager, state,
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: state.runId,
        activities: scenario.manager.activityLedger(scenario.specId) }) });
  };
  const risk = evidence().handoffs().find((entry) => entry.taskId === scenario.taskId).toJSON();
  assert.equal(risk.unavailable, true);
  assert.equal(risk.semanticReviewCount, 0);
  const canonical = scenario.snapshot();
  fs.appendFileSync(scenario.sourcePath, "later unreviewed source\n");
  scenario.reload();
  assert.deepEqual(evidence().handoffs().find((entry) => entry.taskId === scenario.taskId).toJSON(), risk);
  assert.throws(() => taskReviewReadiness({ flowManager: scenario.manager, state: scenario.state(),
    taskId: scenario.taskId }), /source/);
  assert.equal(scenario.snapshot(), canonical);
});
