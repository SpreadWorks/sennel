import assert from "node:assert/strict";
import { it } from "node:test";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { requestInput } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";

// This cumulative case extends the existing new-Flow entry to the phase-03 exit.
// It does not replace phase-scoped refusal, budget or recovery scenarios.
it("I00 preserves one new Flow through Prepare, Draft, Spec, Requirement tests and implementation to the real Retro", async (t) => {
  const prepared = PrepareArtifactScenario.create(t, {
    mode: "no-branch",
    request: "Preserve the implementation requirement and its test evidence through the real retrospective.",
  });
  await prepared.withEnvironment(async () => {
    const initialized = await prepared.initialize();
    const ready = await prepared.prepare();
    assert.equal(ready.result, "ok", JSON.stringify(ready));
    prepared.reload();
    const state = prepared.flowManager.canonicalState(prepared.specId);
    assert.equal(state.runId, initialized.runId);
    assert.equal(state.current?.at(-1) ?? state.nextAction().nodeId, "draft");
    assert.equal(state.findNode("draft").attemptSequence, 0);

    const scenario = ImplPhaseScenario.create(t, { prepared, autoApprove: false });
    await scenario.advanceTo("approval");
    scenario.reload();
    assert.equal(scenario.state().runId, initialized.runId);
    assert.equal(scenario.specId, ready.specId);
    const draft = scenario.manager.readArtifact({
      specId: scenario.specId, logicalKey: "draft", consumerNodeId: "spec",
    });
    const specInput = scenario.requests.find((request) => request.stepId === "spec");
    assert.ok(specInput, "Spec must execute in the same newly prepared Flow");
    assert.equal(requestInput(specInput, "draft.json").digest, draft.descriptor.hash);
    assert.deepEqual(requestInput(specInput, "draft.json").document, JSON.parse(draft.bytes));

    const awaiting = await scenario.dispatch(8);
    assert.equal(awaiting.dispatch?.boundary, "approval_required", JSON.stringify(awaiting));
    scenario.reload();
    await scenario.approve();
    await scenario.advanceTo("implement");
    scenario.reload();
    const sources = new CanonicalTestArtifactStore({
      flowManager: scenario.manager, state: scenario.manager.loadReadOnly(scenario.specId),
    }).testSources("implement");
    assert.equal(sources.length, 1);
    const promoted = scenario.manager.readArtifact({
      specId: scenario.specId, logicalKey: "tests.source",
      parameters: { testPath: sources[0].testPath }, consumerNodeId: "implement",
    });
    assert.ok(promoted, "Requirement Gate must promote the source consumed by phase 03");
    const promotedBy = scenario.manager.activityLedger(scenario.specId)
      .find((activity) => activity.id === promoted.descriptor.activityId);
    assert.equal(promotedBy.nodeId, "test-gate");
    assert.ok(promotedBy.attemptId);

    const retro = await scenario.consumeRetro();
    assert.equal(retro.artifacts.summary.done, 1);
    const execution = scenario.commandArtifact("test.execute", "retro");
    assert.equal(execution.payload.process.exitCode, 0);
    assert.equal(execution.payload.summary[0].id, "R1");
    assert.equal(execution.payload.summary[0].execution, "executed");
    assert.equal(execution.payload.summary[0].result, "pass");
    assert.equal(scenario.state().runId, initialized.runId);
    assert.ok(scenario.requests.some((request) => request.stepId === "draft"));
    assert.ok(scenario.requests.some((request) => request.stepId === "implement"));
    assert.ok(scenario.requests.some((request) => request.stepId === "task-impl"));

    // Successful legacy execution is insufficient: every executed owning leaf
    // must also persist its own concrete Result and exact settlement binding.
    scenario.assertResults([
      "implement", "T1-impl", "T1-review", "T1-gate",
      "test-execute", "test-result-review", "impl-review", "impl-gate",
    ]);
  });
});
