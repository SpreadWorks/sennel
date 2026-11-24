import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CanonicalFlowFixture, canonicalDraftDocument, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { configureManagedFixtureRepository, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class AcceptanceSourceScenario {
  constructor(t, { draft = false } = {}) {
    this.root = fixtureRepository("acceptance-source-revision-");
    configureManagedFixtureRepository(this.root);
    this.manager = makeFlowManager(this.root);
    this.fixture = new CanonicalFlowFixture({ flowManager: this.manager,
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" } }).create()
      .activate(draft ? "draft-refine" : "branch");
    this.specId = this.fixture.specId;
    this.runtime = null;
    t.after(async () => {
      await this.runtime?.close();
      removeQuiescentRuntimeFixture({ mainRoot: this.root });
    });
  }
  publishDraft(goal = "The source remains unchanged.") {
    const bytes = Buffer.from(JSON.stringify(canonicalDraftDocument({ goal })));
    this.manager.publishArtifacts({ specId: this.specId, nodeId: "draft-refine",
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes }] });
    return this.manager.readArtifact({ specId: this.specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
  }
  async acquire(t, mutate = null) {
    const state = this.manager.canonicalState(this.specId);
    const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
      nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence };
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, executionRoot: this.root,
      runId: state.runId, specId: state.specId, binding });
    const store = new CanonicalAcceptanceArtifactStore({ flowManager: this.manager, state: this.manager.loadReadOnly(this.specId) });
    if (mutate !== null) {
      const read = this.manager.readArtifact.bind(this.manager);
      let changed = false;
      t.mock.method(this.manager, "readArtifact", (input) => {
        const result = read(input);
        if (!changed && input.logicalKey === "spec.record") {
          changed = true;
          mutate();
        }
        return result;
      });
    }
    const writer = new FlowProcessEventWriter(this.manager);
    return this.runtime.enter(() => this.runtime.withBinding(binding,
      () => store.buildContext({ executionRoot: this.root }), { eventWriter: (event) => writer.write(event) }));
  }
}

test("acceptance evidence acquisition retains real Git receipts and canonical acknowledgements without invalidating its own source", { timeout: 30000 }, async (t) => {
  const scenario = new AcceptanceSourceScenario(t);
  const before = scenario.manager.artifactCatalog(scenario.specId).hash;
  const context = await scenario.acquire(t);
  const restarted = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
  const catalog = restarted.artifactCatalog(scenario.specId);
  assert.notEqual(catalog.hash, before);
  assert.equal(context.sourceCatalogHash, catalog.hash);
  assert.equal(context.evidence.diff, "");
  assert.ok(context.mechanicalBlockers.some((entry) => entry.kind === "missing_artifact"));
  const execution = scenario.runtime.inspect().executions.find((entry) => entry.executionId === scenario.runtime.executionId);
  assert.ok(execution.calls.length >= 3, "merge-base, tracked diff and untracked inventory use actual registered Git");
  assert.ok(execution.calls.every((call) => call.receipt?.observation.code === 0));
  const canonical = restarted.activityLedger(scenario.specId)
    .filter((activity) => activity.processEvent?.executionId === execution.executionId).map((activity) => activity.processEvent);
  assert.deepEqual(canonical, execution.events);
  assert.equal(canonical.filter((event) => event.type === "result-finalized").length, execution.calls.length);
  assert.deepEqual(execution.eventAcknowledgements.map((entry) => entry.eventId), canonical.map((event) => event.eventId));
  await scenario.runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).inventory.executions
    .find((entry) => entry.executionId === execution.executionId);
  assert.equal(historical.status, "closed");
  assert.deepEqual(historical.calls, execution.calls);
  assert.deepEqual(historical.events, canonical);
});

for (const change of ["new input", "changed input", "same-byte producer"]) {
  test(`acceptance acquisition refuses ${change} saved during its Git evidence window`, { timeout: 30000 }, async (t) => {
    const scenario = new AcceptanceSourceScenario(t, { draft: true });
    const original = change === "new input" ? null : scenario.publishDraft();
    let saved;
    await assert.rejects(scenario.acquire(t, () => {
      saved = scenario.publishDraft(change === "changed input" ? "A newly changed source." : undefined);
    }), (error) => error instanceof StepAdmissionRefusal
      && error.message === "Acceptance source catalog changed while acquiring evidence");
    assert.ok(saved !== undefined);
    if (original !== null) {
      assert.notEqual(saved.descriptor.activityId, original.descriptor.activityId);
      assert.equal(saved.descriptor.hash === original.descriptor.hash, change === "same-byte producer");
    }
    const restarted = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
    assert.deepEqual(restarted.readArtifact({ specId: scenario.specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" }).descriptor, saved.descriptor);
    assert.ok(!restarted.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "acceptance.review"));
  });
}

for (const change of ["note", "policy", "Attempt"]) {
  test(`acceptance acquisition refuses a saved ${change} change while its registered Git calls complete`, { timeout: 30000 }, async (t) => {
    const scenario = new AcceptanceSourceScenario(t);
    const initial = scenario.manager.canonicalState(scenario.specId);
    await assert.rejects(scenario.acquire(t, () => {
      if (change === "note") scenario.manager.addNote("A new source observation.", { specId: scenario.specId });
      else if (change === "policy") scenario.manager.setAutoApprove(true, { specId: scenario.specId });
      else {
        scenario.fixture.settle("branch");
        scenario.fixture.activate("draft-refine");
      }
    }), (error) => error instanceof StepAdmissionRefusal
      && error.message === "Acceptance source catalog changed while acquiring evidence");
    const restarted = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
    const state = restarted.canonicalState(scenario.specId);
    if (change === "policy") assert.equal(state.policy.autoApprove, true);
    else if (change === "Attempt") assert.notEqual(state.attempt.id, initial.attempt.id);
    else assert.ok(restarted.activityLedger(scenario.specId).some((entry) => entry.transition.operation === "record_note"));
    assert.ok(!restarted.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "acceptance.review"));
  });
}
