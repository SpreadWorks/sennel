import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { container } from "../../../src/lib/container.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";
import { installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { ImplPhaseScenario, implementationFinding } from "../../support/impl-phase-scenario.js";
import { ImplPhasePublicationObserver } from "../../support/infrastructure/impl-phase-publication-observer.js";

function passingEvaluation(options) {
  const required = options.jsonSchema?.required ?? [];
  if (required.includes("evaluations")) {
    const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum ?? [];
    return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({
      guardrail_id, result: "pass", reason: `[REQ:${guardrail_id}] nominal provider PASS.`,
    })) });
  }
  return JSON.stringify({ observations: [], ...(required.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
}

test("I08 current Task Gate retains unrepairable must-fix obligations even when its evaluator returns PASS", async (t) => {
  const publicationObserver = new ImplPhasePublicationObserver(t);
  const scenario = new TaskReviewScenario(t);
  scenario.publicationObserver = publicationObserver;
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const finding = { ...implementationFinding(), file: "README.md", requirementId: "R-1" };
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const review = await scenario.publishReview([finding]);
    assert.notEqual(review.ok, false, JSON.stringify(review));
    scenario.reload();
    assert.equal((await scenario.filter([])).ok, true);
    scenario.reload();
    const work = scenario.stageHandoff("repair");
    const repaired = scenario.completeHandoff(work, {
      version: 1, stepId: "task-repair", completionStatus: "done", issues: [],
      overview: null, triage: null, repair: null,
      noChangeReason: { classification: "unrepairable", findingKeys: [finding.findingKey],
        reason: "The selected missing branch requires authority outside the approved Task scope." },
    });
    assert.equal(repaired.completed, true);
    scenario.reload();
    const receipt = new TaskStageArtifact({
      flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "repair",
    }).document;
    assert.equal(receipt.binding.reviewOrdinal, ordinal);
    assert.equal(receipt.repairNoChange.classification, "unrepairable");
    assert.deepEqual(receipt.sourceMutationManifest.mutations, []);
    assert.equal(scenario.state().current?.at(-1), ordinal === 4 ? "T-1-gate" : "T-1-review");
  }
  const unresolved = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager, state: scenario.state(),
    cycle: ReviewFindingCycle.fromActivityLedger({
      runId: scenario.state().runId, activities: scenario.manager.activityLedger(scenario.specId),
    }),
  }).handoffs().find((entry) => entry.taskId === scenario.taskId).toJSON();
  assert.equal(unresolved.unreviewedAfterRepair, true);
  assert.equal(new TaskStageArtifact({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, role: "review",
  }).document.verdict, "REJECTED");
  const before = scenario.manager.activityLedger(scenario.specId).length;
  let providerCalls = 0;
  const provider = installGateProviderFake((_prompt, options) => {
    providerCalls += 1;
    return passingEvaluation(options);
  });
  t.after(() => provider.mock.restore());
  const ctx = { ...scenario.context(), phase: "task-impl", skipGuardrail: true };
  const evaluated = await new RunGateCommand().execute(ctx);
  assert.ok(providerCalls > 0, "the actual current Gate must evaluate the producer-bound source");
  await FLOW_COMMANDS.run.gate.post(ctx, evaluated);
  scenario.reload();
  assert.ok(scenario.manager.activityLedger(scenario.specId).length > before,
    "the normal Gate path must publish its observation before the fresh reader judges completion");
  assert.notEqual(scenario.state().findNode(scenario.taskId).status, "done",
    "nominal evaluator PASS must not complete a Task with the exact unresolved must-fix obligation");
  assert.notEqual(scenario.state().findNode("T-1-gate").status, "done");
  ImplPhaseScenario.prototype.assertResults.call(scenario, ["T-1-gate"]);
});

for (const refusal of ["readonly-source", "incomplete-finding-classification"]) {
  test(`I04 flow triage refuses ${refusal} from a real persisted implementation Review`, async (t) => {
    let invoked = 0;
    const scenario = ImplPhaseScenario.create(t, {
      implReviewResponse: (stage) => ({
        blockingFindings: stage === "impl-review" ? [implementationFinding()] : [],
        nonBlockingImprovements: [],
      }),
      sourceWorker(request, current) {
        if (request.stepId !== "impl-triage") return undefined;
        invoked += 1;
        if (refusal === "readonly-source") {
          fs.appendFileSync(`${current.root}/src/implementation.js`, "// unapproved triage mutation\n");
        }
        return { version: 1, stepId: "impl-triage", completionStatus: "done", issues: [],
          overview: null, repair: null, noChangeReason: null,
          triage: { version: 1, dispositions: refusal === "incomplete-finding-classification" ? [] : [{
            findingKey: "missing-behavior", disposition: "apply", basis: "repair-required",
            rationale: "The complete Review requires this correction.",
          }] } };
      },
    });
    await scenario.advanceTo("impl-triage");
    scenario.reload();
    const source = scenario.manager.readArtifact({
      specId: scenario.specId, logicalKey: "impl.review", consumerNodeId: "impl-triage",
    });
    assert.ok(source, "triage must read the Review created by the real implementation chain");
    const before = scenario.state().findNode("impl-triage").attemptSequence;
    const result = await scenario.executeCurrent();
    scenario.reload();
    assert.ok(invoked > 0, "the authorized readonly triage worker was invoked");
    assert.equal(result.ok, false);
    assert.notEqual(scenario.state().findNode("impl-triage").status, "done");
    assert.notEqual(scenario.state().findNode("impl-repair").status, "done");
    assert.equal(scenario.state().findNode("impl-triage").attemptSequence, before,
      "source-authority rejection must not consume a new semantic Attempt");
    assert.equal(scenario.manager.activityLedger(scenario.specId).some((entry) =>
      entry.nodeId === "impl-triage" && entry.result?.stepResult?.type === "completed"), false);
    const publications = scenario.manager.artifactCatalog(scenario.specId).artifacts
      .filter((entry) => entry.logicalKey === "impl.triage");
    assert.deepEqual(publications, [], "an invalid disposition or forbidden source mutation cannot be published");
  });
}
