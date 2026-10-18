import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import { draftStepRegistrations } from "../../../src/flow/engine/composition/draft.js";
import { PreparedStep } from "../../../src/flow/engine/composition/step-registration.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { QueryDraftReviewScenario, produceDraftGateResult } from "../../support/infrastructure/query-draft-review-scenario.js";
import { completeDraftWorkerThroughStep, prepareConditionalDraftWorkerThroughStep } from "../../support/infrastructure/draft-worker-step.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { ServiceBoundaryCoverage } from "../../support/structure/service-boundary.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

const finding = {
  title: "Make validation explicit", target: "analysis.validation", classification: "blocking",
  rationale: "The validation plan needs a bounded clarification.",
  evidence: "The current validation omits the selected expected result.",
};

async function completeWorker(scenario, stepId, payload) {
  scenario.manager.beginNextAction(scenario.specId);
  assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), stepId);
  const request = scenario.coordinator.createRequest({
    ctx: scenario.ctx, state: scenario.manager.loadReadOnly(scenario.specId),
    invocation: scenario.invocation(stepId),
  });
  fs.writeFileSync(request.payloadPath(`${stepId}.json`), workerArtifactJson(payload(request)));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
  const result = await completeDraftWorkerThroughStep({
    coordinator: scenario.coordinator, ctx: scenario.ctx, request,
  });
  scenario.reload();
  return result;
}

test("every registered Draft Step Service has a real instance inspected for A07", async (t) => {
  const coverage = new ServiceBoundaryCoverage(draftStepRegistrations);
  const observer = new PrepareExecutionObserver(t, {
    registrations: draftStepRegistrations, stepIds: draftStepRegistrations.map(({ stepId }) => stepId),
  });
  try {
    const scenario = new QueryDraftReviewScenario(t, "001-draft-service-boundary");
    await scenario.draft();
    for (const phase of ["questions", "coverage"]) {
      if (phase === "coverage") await scenario.refine();
      await scenario.review(`draft-${phase}`, { verdict: "REJECTED", blocking: [finding] });
      const triage = await completeWorker(scenario, `draft-${phase}-triage`, () => ({
        version: 1, phase: `draft-${phase}-triage`,
        sourceReview: `draft-review-${phase}.json`, summary: finding.rationale,
        items: [{ ...finding, decision: "apply",
          allowedFieldPaths: [finding.target], requiredFieldPaths: [finding.target] }],
      }));
      assert.equal(triage.stepResult.kind, `draft-${phase}-triage-completed`);
      const repair = await completeWorker(scenario, `draft-${phase}-repair`, (request) => {
        const source = request.inputs.find((input) => input.name === "draft.json").document;
        return { version: 1, baseRevision: `sha256:${request.inputRevision}`, operations: [{
          title: finding.title, target: finding.target, kind: "replace-value", path: finding.target,
          expectedDigest: crypto.createHash("sha256").update(JSON.stringify(source.analysis.validation)).digest("hex"),
          replacement: `Verify the saved ${phase} correction and its downstream source identity.`,
          reason: finding.rationale,
        }] };
      });
      assert.equal(repair.stepResult.kind, `draft-${phase}-repair-changed`);
      scenario.manager.beginNextAction(scenario.specId);
      await scenario.review(`draft-${phase}`);
    }
    scenario.manager.beginNextAction(scenario.specId);
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), "draft-gate");
    const ctx = { ...scenario.ctx, phase: "draft", config: {},
      flowState: scenario.manager.loadReadOnly(scenario.specId) };
    const result = await produceDraftGateResult(ctx, { observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-DRAFT",
      where: { file: "draft.json", locator: "goal" },
      observed: "The retained behavior must be explicit.", severity: "blocking", refs: ["R-DRAFT"],
    }] });
    await FLOW_COMMANDS.run.gate.post(ctx, result);
    scenario.reload();
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), "draft-gate-repair");
    const preparedRepair = await prepareConditionalDraftWorkerThroughStep({
      coordinator: scenario.coordinator, ctx: scenario.ctx,
      state: scenario.manager.loadReadOnly(scenario.specId), invocationId: "a07-draft-gate-repair",
    });
    assert.ok(preparedRepair.request, "the actual conditional selection requires its repair worker");

    for (const registration of draftStepRegistrations) {
      const prepared = observer.prepared(registration).filter((value) => value instanceof PreparedStep);
      assert.ok(prepared.length > 0,
        `A07 ${registration.stepId}: actual producers must construct its registered Service`);
      for (const instance of prepared) coverage.inspectPrepared(registration, instance);
    }
    const required = new Set(draftStepRegistrations.flatMap((registration) => registration.StepClass.dependencies));
    assert.equal(coverage.assertComplete(), required.size);
  } finally { observer.restore(); }
});
