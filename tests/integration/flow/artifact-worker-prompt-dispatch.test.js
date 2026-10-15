import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { container } from "../../../src/lib/container.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { GLOBAL_PROMPT_ELEMENT_HARD_MAX, PromptBatchExecutionIncompleteFailure,
  PromptResponseTooLargeFailure } from "../../../src/lib/prompt-batching.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { ArtifactWorkerSealedReplay } from "../../../src/flow/lib/artifact-worker-execution-continuation.js";
import { selectWorkerExecutionAdmission } from "../../../src/flow/lib/worker-execution-admission.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake, requestPayloadPath,
  configureManagedFixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

class PromptDispatchScenario {
  constructor(t, { response = JSON.stringify({ sealed: true }) } = {}) {
    this.root = fixtureRepository("artifact-prompt-dispatch-");
    t.after(() => removeTmpDir(this.root));
    configureManagedFixtureRepository(this.root);
    this.specId = "artifact-prompt-dispatch";
    this.manager = this.reload();
    new CanonicalFlowFixture({ flowManager: this.manager, specId: this.specId,
      runId: "artifact-prompt-dispatch-run", request: "Keep a sealed worker response unpublished when Prompt persistence fails.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null } })
      .create().registerActive().activate("draft");
    this.draft = canonicalDraftDocument({ goal: "Preserve the durable Prompt boundary.", questions: [] });
    this.providerCalls = 0;
    this.response = response;
    this.provider = installGateProviderFake((_prompt, options) => {
      this.providerCalls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      assert.equal(request.stepId, "draft");
      fs.writeFileSync(requestPayloadPath(request, "draft.json"), `${JSON.stringify(this.draft, null, 2)}\n`);
      sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      return this.response;
    }, { transportContext: () => ({ root: this.root, flowManager: this.manager }) });
    t.after(() => this.provider.mock.restore());
  }

  reload() { return new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false, specId: this.specId }); }

  context() { return { root: this.root, mainRoot: this.root, executionRoot: this.root, specId: this.specId,
    flowManager: this.manager, flowState: this.manager.loadReadOnly(this.specId), flowCommandBoundary: true }; }

  dispatch() {
    const agent = container.get("agent");
    return new RunDispatchCommand({ agent, maxDispatches: 1 }).run(
      dispatchContainer({ root: this.root, flowManager: this.manager, agent }),
      { expectSpec: this.specId, expectRunId: this.manager.canonicalState(this.specId).runId,
        expectNoIssue: true, _envelopeType: "run", _envelopeKey: "dispatch" });
  }

  episode(contract) {
    return this.manager.readStoredPromptExecutionEpisode({ executionContract: contract, currentAttempt: false });
  }

  draftPublications() { return this.manager.artifactCatalog(this.specId).artifacts.filter((entry) => entry.logicalKey === "draft"); }
}

test("dispatch preserves a response journal write failure and fresh sealed replay publishes once without another provider call", async (t) => {
  const scenario = new PromptDispatchScenario(t);
  const initialAttempt = scenario.manager.canonicalState(scenario.specId).attempt.toJSON();
  const failure = new Error("The response journal writer is unavailable");
  let failedWrite = null;
  const save = FlowManager.prototype.savePromptExecutionProgress;
  const writer = t.mock.method(FlowManager.prototype, "savePromptExecutionProgress", function(input) {
    if (input.executionContract.specId === scenario.specId && input.record.event === "response") {
      failedWrite = input;
      throw failure;
    }
    return save.call(this, input);
  });
  await assert.rejects(scenario.dispatch(), (error) => error === failure);
  assert.notEqual(failedWrite, null, "failure must reach the actual response writer after provider completion");
  assert.equal(scenario.providerCalls, 1);
  writer.mock.restore();

  scenario.manager = scenario.reload();
  const contract = failedWrite.executionContract;
  const saved = scenario.episode(contract);
  assert.equal(saved.budget.providerCallCount, 1);
  const batch = saved.scopes[0].batches[0];
  assert.notEqual(batch.claim, null);
  assert.equal(batch.processStops.length, 1);
  assert.equal(batch.responses.length, 0);
  assert.equal(batch.completion, null);
  assert.deepEqual(scenario.manager.canonicalState(scenario.specId).attempt.toJSON(), initialAttempt);
  assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("draft").status, "in_progress");
  assert.equal(scenario.draftPublications().length, 0);
  assert.ok(scenario.manager.activityLedger(scenario.specId).every((entry) => entry.failure === null));
  const continuation = selectWorkerExecutionAdmission({ ctx: scenario.context(), stepId: "draft" }).artifactContinuation;
  assert.ok(continuation instanceof ArtifactWorkerSealedReplay);

  const replay = await scenario.dispatch();
  assert.deepEqual(replay.errors?.map((entry) => entry.code), ["FLOW_DISPATCH_LIMIT_REACHED"]);
  assert.equal(scenario.providerCalls, 1);
  scenario.manager = scenario.reload();
  assert.equal(scenario.draftPublications().length, 1);
  const publication = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
  assert.deepEqual(JSON.parse(publication.bytes.toString("utf8")), scenario.draft);
  assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("draft").status, "done");
  assert.deepEqual(scenario.episode(contract).budget, saved.budget);
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.filter((entry) => entry.logicalKey === "execution.contract").length, 1);
});

test("a sealed payload cannot hide a Prompt response limit failure before canonical publication", async (t) => {
  const scenario = new PromptDispatchScenario(t, { response: "x".repeat(GLOBAL_PROMPT_ELEMENT_HARD_MAX + 1) });
  const initialAttempt = scenario.manager.canonicalState(scenario.specId).attempt.toJSON();
  await assert.rejects(scenario.dispatch(), (error) => error instanceof PromptBatchExecutionIncompleteFailure
    && error.cause instanceof PromptResponseTooLargeFailure && error.cause.code === "PROMPT_RESPONSE_TOO_LARGE");
  assert.equal(scenario.providerCalls, 1);
  scenario.manager = scenario.reload();
  const state = scenario.manager.canonicalState(scenario.specId);
  assert.deepEqual(state.attempt.toJSON(), initialAttempt);
  assert.equal(scenario.draftPublications().length, 0);
  assert.ok(scenario.manager.activityLedger(scenario.specId).every((entry) => entry.failure === null));
  const continuation = selectWorkerExecutionAdmission({ ctx: scenario.context(), stepId: "draft" }).artifactContinuation;
  assert.ok(continuation instanceof ArtifactWorkerSealedReplay);
  const saved = scenario.episode(continuation.executionContract);
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.budget.aggregateCharacters, 0);
  const batch = saved.scopes[0].batches[0];
  assert.equal(batch.claim, null);
  assert.equal(batch.completion, null);
  assert.equal(batch.processStops.length, 1);
  assert.equal(batch.responses.length, 1);
  assert.equal(batch.responses[0].raw, null);
  assert.equal(batch.responses[0].rejection, "PROMPT_RESPONSE_TOO_LARGE");
  assert.equal(batch.responses[0].responseCharacters, GLOBAL_PROMPT_ELEMENT_HARD_MAX + 1);
  const result = await scenario.dispatch();
  assert.deepEqual(result.errors?.map((entry) => entry.code), ["FLOW_DISPATCH_LIMIT_REACHED"]);
  scenario.manager = scenario.reload();
  assert.equal(scenario.providerCalls, 1);
  assert.equal(scenario.draftPublications().length, 1);
  assert.deepEqual(scenario.episode(continuation.executionContract).budget, saved.budget);
});
