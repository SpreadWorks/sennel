import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { SourceWorkerCanonicalObservationAdvance, WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { selectWorkerExecutionAdmission } from "../../../src/flow/lib/worker-execution-admission.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/step-persistence-failure.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { dispatchRepositoryFingerprint } from "../../../src/flow/lib/run-dispatch.js";
import { RequirementTestPhaseScenario } from "../../support/requirement-test-phase-scenario.js";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { configureManagedFixtureRepository, requestInput, requestPayloadPath, WorkerRequestIdentityObserver } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

class NestedRefineScenario extends RequirementTestPhaseScenario {
  constructor(options) {
    super(options);
    assert.ok(options.prepared instanceof PrepareArtifactScenario);
    this.mainRoot = options.prepared.root;
  }

  reload() {
    this.manager = new FlowManager({ root: this.root, mainRoot: this.mainRoot,
      inWorktree: true, specId: this.specId });
    return this;
  }

  context() { return { ...super.context(), mainRoot: this.mainRoot }; }

}

function refineScenario(t, options = {}) {
  const ScenarioClass = options.nestedWorktree ? NestedRefineScenario : RequirementTestPhaseScenario;
  const scenario = ScenarioClass.create(t, {
    entryStep: "draft", autoApprove: false, ...options,
    async beforeSeal(request, scenario) {
      if (request.stepId === "draft") fs.writeFileSync(requestPayloadPath(request, "draft.json"),
        workerArtifactJson(canonicalDraftDocument({ questions: [{
          state: "CandidateQuestion", id: "q1", category: "user-visible-behavior",
          question: "Which behavior must survive recovery?", revision: 0,
          provenance: { producer: "draft-worker" }, evidenceDigest: "a".repeat(64),
        }] })));
      await options.beforeSeal?.(request, scenario);
    },
  });
  scenario.requestIdentity = new WorkerRequestIdentityObserver(scenario.worker.bind(scenario));
  scenario.worker = scenario.requestIdentity.call.bind(scenario.requestIdentity);
  // Production setup excludes transient handoffs and agent work directories.
  // The minimal fixture repository otherwise fingerprints those producer files.
  if (!options.nestedWorktree) configureManagedFixtureRepository(scenario.root);
  return scenario;
}

function executionState(scenario) {
  const state = scenario.manager.canonicalState(scenario.specId);
  return scenario.manager.draftStepExecutionState({ binding: {
    runId: state.runId, specId: scenario.specId, stepId: "draft-refine", attempt: state.attempt,
  } });
}

async function interruptRefinePublication(t, boundary, { beforeClaim = null, nestedWorktree = false } = {}) {
  const coordinator = new class extends WorkerArtifactHandoffCoordinator {
    publishDraftWorker(input) {
      if (input.request.stepId !== "draft-refine") return super.publishDraftWorker(input);
      if (boundary === "publication") super.publishDraftWorker(input);
      throw new WorkerArtifactHandoffError("recovery-required", "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
        `interrupt at ${boundary} refine response`, { recoveryPossible: true });
    }
  }();
  let prepared = null;
  if (nestedWorktree) {
    prepared = PrepareArtifactScenario.create(t, { mode: "worktree", request: "Retain nested execution checkout authority." });
    const nestedInput = path.join(prepared.root, "fixtures", ".tmp", "input.json");
    fs.mkdirSync(path.dirname(nestedInput), { recursive: true });
    fs.writeFileSync(nestedInput, workerArtifactJson({ preserved: true }));
    prepared.git(["add", "-f", "fixtures/.tmp/input.json"]);
    prepared.git(["commit", "-m", "Seed tracked nested fixture input"]);
    await prepared.initialize();
    const ready = await prepared.prepare();
    assert.equal(ready.result, "ok", JSON.stringify(ready));
  }
  const scenario = refineScenario(t, { handoffCoordinator: coordinator, nestedWorktree, ...(prepared ? { prepared } : {}) });
  await scenario.advanceTo("draft-refine");
  await beforeClaim?.(scenario);
  scenario.interruptedAttempt = scenario.manager.canonicalState(scenario.specId).attempt;
  await assert.rejects(() => scenario.dispatch(1),
    (error) => error instanceof StepPersistenceFailure
      && error.cause instanceof WorkerArtifactHandoffError
      && error.cause.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED");
  return scenario.reload();
}

for (const boundary of ["missing", "unsealed"]) {
  it(`holds a real refine claim with a ${boundary} response after reload without another provider or state change`, async (t) => {
    let invocation;
    const coordinator = new class extends WorkerArtifactHandoffCoordinator {
      createRequest(input) {
        if (input.invocation.action.nextAction.step === "draft-refine") invocation = input.invocation;
        return super.createRequest(input);
      }
      prepareDraftWorker(input) {
        if (boundary === "unsealed" && input.request.stepId === "draft-refine")
          throw new Error("interrupt before reading unsealed refine response");
        return super.prepareDraftWorker(input);
      }
    }();
    const scenario = refineScenario(t, { handoffCoordinator: coordinator });
    await scenario.advanceTo("draft-refine");
    const selectedAttempt = scenario.manager.canonicalState(scenario.specId).attempt;
    if (boundary === "missing") {
      const claim = scenario.manager.claimDraftStepExecution.bind(scenario.manager);
      scenario.manager.claimDraftStepExecution = (input) => {
        claim(input);
        throw new WorkerArtifactHandoffError("recovery-required", "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
          "interrupt after refine claim", { recoveryPossible: true });
      };
      const interrupted = await scenario.dispatch(1);
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED", JSON.stringify(interrupted));
    } else {
      // The external producer writes its normal payload but is interrupted before
      // sealing; stop the parent before it observes a terminal provider response.
      scenario.agent.call = async (_prompt, options) => {
        const request = JSON.parse(fs.readFileSync(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST, "utf8"));
        scenario.requests.push(request);
        fs.writeFileSync(requestPayloadPath(request, "draft.json"),
          workerArtifactJson(requestInput(request, "draft.json").document));
        return "unsealed interrupted response";
      };
      await assert.rejects(() => scenario.dispatch(1), /interrupt before reading unsealed refine response/);
    }
    scenario.reload();
    const saved = executionState(scenario);
    assert.equal(saved.lifecycle.phase, "claimed");
    assert.equal(saved.lifecycle.executionGeneration, 0);
    assert.equal(saved.lifecycle.claim.dispatchInvocationId, invocation.id);
    assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, selectedAttempt.id);
    assert.deepEqual(scenario.manager.canonicalState(scenario.specId).attempt.consumption.toJSON(),
      selectedAttempt.consumption.toJSON());
    const calls = scenario.requests.length;
    assert.equal(scenario.requests.filter((request) => request.stepId === "draft-refine").length,
      boundary === "missing" ? 0 : 1);
    const before = scenario.snapshot();
    scenario.agent.call = async () => assert.fail("an unfinished refine claim cannot start another provider");
    const selection = selectWorkerExecutionAdmission({ ctx: scenario.context(), stepId: "draft-refine" });
    assert.equal(selection.continuation.code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
    const next = await scenario.next();
    assert.equal(next.directive.kind, "blocked", JSON.stringify(next));
    assert.equal(next.directive.code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
    const result = await scenario.dispatch(2);
    assert.equal(result.dispatch.boundary, "blocked", JSON.stringify(result));
    assert.equal(result.dispatch.dispatchCount, 0);
    assert.equal(scenario.requests.length, calls);
    assert.deepEqual(scenario.reload().snapshot(), before);
    assert.deepEqual(executionState(scenario).lifecycle.toJSON(), saved.lifecycle.toJSON());
    assert.equal(executionState(scenario).receiptId, saved.receiptId);
  });
}

for (const boundary of ["sealed", "publication"]) {
  it(`replays the exact ${boundary} refine response after reload without repeating its provider or publication`, async (t) => {
    const scenario = await interruptRefinePublication(t, boundary);
    const selectedAttempt = scenario.interruptedAttempt;
    const request = scenario.requests.at(-1);
    assert.equal(request.stepId, "draft-refine");
    const expectedContract = FlowExecutionContract.fromJSON(request.executionContract);
    const savedContract = scenario.manager.readExecutionContract({ executionContract: expectedContract });
    assert.deepEqual(savedContract.toJSON(), expectedContract.toJSON());
    assert.equal(savedContract.id, request.executionContractId);
    assert.equal(savedContract.attemptId, selectedAttempt.id);
    assert.equal(savedContract.attemptSequence, selectedAttempt.sequence);
    assert.equal(savedContract.generation, 0);
    const contractArtifact = scenario.manager.readArtifact({ specId: scenario.specId,
      logicalKey: "execution.contract", parameters: savedContract.parameters, consumerNodeId: "system" });
    const contractProducer = scenario.manager.activityLedger(scenario.specId).find((entry) =>
      entry.id === contractArtifact.descriptor.activityId);
    assert.equal(contractProducer.nodeId, "draft-refine");
    assert.equal(contractProducer.attemptId, selectedAttempt.id);
    const saved = executionState(scenario);
    assert.equal(saved.lifecycle.phase, boundary === "sealed" ? "claimed" : "publication");
    assert.equal(saved.lifecycle.claim.requestDigest, scenario.requestIdentity.requestDigest(request.dispatchInvocationId));
    assert.equal(saved.lifecycle.claim.dispatchInvocationId, request.dispatchInvocationId);
    const beforeRead = scenario.snapshot();
    const savedDraft = scenario.artifact("draft", undefined, "draft-refine");
    const draftPayload = fs.readFileSync(requestPayloadPath(request, "draft.json"));
    const selection = selectWorkerExecutionAdmission({ ctx: scenario.context(), stepId: "draft-refine" });
    const responseDigest = selection.continuation.responseDigest;
    assert.match(responseDigest, /^[a-f0-9]{64}$/);
    assert.equal((await scenario.next()).directive.kind, "execute_step");
    assert.deepEqual(scenario.snapshot(), beforeRead, "replay selection is read-only");
    scenario.options.handoffCoordinator = new WorkerArtifactHandoffCoordinator();
    scenario.agent.call = async () => assert.fail("an exact saved refine response must be replayed without a provider");
    const requestsBefore = scenario.requests.length;
    const replayed = await scenario.dispatch(4);
    const replayedData = replayed instanceof Envelope ? replayed.data : replayed;
    assert.equal(replayedData.dispatch.boundary, "await_user_decision", JSON.stringify(replayed));
    scenario.reload();
    assert.equal(scenario.requests.length, requestsBefore);
    assert.equal(scenario.current(), "draft-refine");
    assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, selectedAttempt.id);
    assert.deepEqual(scenario.manager.canonicalState(scenario.specId).attempt.consumption.toJSON(),
      selectedAttempt.consumption.toJSON());
    const activities = scenario.manager.activityLedger(scenario.specId);
    const publications = activities.filter((entry) => entry.nodeId === "draft-refine"
      && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication"
      && entry.result.draftSettlementReceipt.settlementKind === "execution");
    assert.equal(publications.length, 1);
    const publication = publications[0].result.draftSettlementReceipt;
    assert.equal(publication.executionLifecycle.claim.requestDigest, scenario.requestIdentity.requestDigest(request.dispatchInvocationId));
    assert.equal(publication.executionLifecycle.claim.dispatchInvocationId, request.dispatchInvocationId);
    if (boundary === "publication") {
      assert.equal(publication.id, saved.receiptId);
      assert.deepEqual(activities.slice(0, beforeRead.activities.length), beforeRead.activities);
    }
    const awaited = activities.findLast((entry) => entry.nodeId === "draft-refine"
      && entry.result?.stepResult?.kind === "draft-refine-awaiting-answer");
    assert.equal(awaited.attemptId, selectedAttempt.id);
    assert.equal(awaited.result.draftSettlementReceipt.awaitQuestion.questionId, "q1");
    const promoted = JSON.parse(scenario.artifact("draft", undefined, "draft-refine").bytes);
    const published = JSON.parse(draftPayload);
    assert.equal(promoted.goal, published.goal);
    assert.deepEqual(promoted.analysis, published.analysis);
    assert.equal(promoted.questionLedger.questions[0].state, "AwaitingUserAnswer");
    assert.equal(promoted.questionLedger.questions[0].revision, published.questionLedger.questions[0].revision + 1);
    if (boundary === "publication") assert.deepEqual(JSON.parse(savedDraft.bytes), published);
    const stopped = scenario.snapshot();
    scenario.reload();
    const awaiting = await scenario.next();
    assert.equal(awaiting.directive.kind, "await_draft_question");
    assert.equal(awaiting.directive.questionId, "q1");
    await scenario.dispatch(2);
    assert.equal(scenario.requests.length, requestsBefore);
    assert.deepEqual(scenario.reload().snapshot(), stopped, "completed replay cannot publish or consume budget twice");
  });
}

function publishChangedDraft(scenario) {
  const changed = JSON.parse(scenario.artifact("draft", undefined, "draft-refine").bytes);
  changed.analysis.validation = "A later canonical producer changed the selected validation input.";
  scenario.manager.publishArtifacts({ specId: scenario.specId, nodeId: "draft-refine", artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(changed)),
  }] });
}

function assertRefineRefusal(refused, expectedCode) {
  if (expectedCode === "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED") {
    const observed = refused instanceof Envelope ? refused.data : refused;
    assert.ok(refused instanceof Envelope, JSON.stringify({
      boundary: observed.dispatch.boundary,
      directive: observed.nextAction?.directive?.kind,
      code: observed.nextAction?.directive?.code,
    }));
    assert.equal(refused.ok, false);
    assert.equal(refused.errors[0].code, expectedCode);
    assert.equal(refused.data.dispatch.boundary, "blocked");
    assert.equal(refused.data.dispatch.dispatchCount, 0);
  } else {
    assert.equal(refused.nextAction.directive.kind, "blocked");
    assert.equal(refused.nextAction.directive.code, expectedCode);
    assert.equal(refused.dispatch.boundary, "blocked");
    assert.equal(refused.dispatch.dispatchCount, 0);
  }
}

const replayMutations = [
  ["project source", "sealed", "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED", (scenario) => {
    const source = path.join(scenario.root, "src", "behavior.js");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "export const changed = true;\n");
  }],
  ["formal project tests", "publication", "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED", (scenario) => {
    const test = path.join(scenario.root, "project-tests", "behavior.test.js");
    fs.mkdirSync(path.dirname(test), { recursive: true });
    fs.writeFileSync(test, "import test from 'node:test'; test('changed behavior', () => {});\n");
  }],
  ["unowned single-dot runtime suffix", "sealed", "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED", (scenario) => {
    const originalFingerprint = dispatchRepositoryFingerprint(scenario.context());
    fs.writeFileSync(path.join(scenario.root, ".sennel", ".repository-maintenance.lock.tmp"),
      "Unregistered repository input must remain visible to replay authority.\n");
    assert.notEqual(dispatchRepositoryFingerprint(scenario.context()), originalFingerprint,
      "the default repository fingerprint must observe an unowned single-dot suffix");
  }, (scenario) => {
    const relativeInput = ".sennel/.repository-maintenance.lock.tmp";
    fs.writeFileSync(path.join(scenario.root, relativeInput), "Original tracked repository input.\n");
    const staged = runGit(["add", "-f", relativeInput], { cwd: scenario.root, log: false });
    assert.equal(staged.status, 0, staged.stderr);
    const committed = runGit(["commit", "-m", "Seed tracked single-dot input"], { cwd: scenario.root, log: false });
    assert.equal(committed.status, 0, committed.stderr);
    const tracked = runGit(["ls-files", "--error-unmatch", relativeInput], { cwd: scenario.root, log: false });
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout.trim(), relativeInput);
  }],
  ["canonical Draft input", "sealed", "FLOW_ARTIFACT_HANDOFF_STALE", publishChangedDraft],
  ["newer canonical Draft publication", "publication", "FLOW_EXECUTION_INPUT_BASELINE_CHANGED", publishChangedDraft],
  ["unrelated catalog publication", "publication", "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED", (scenario) => {
    scenario.manager.appendIssueLog({ specId: scenario.specId, idempotencyKey: "unrelated-publication",
      entry: { issueLogId: "unrelated-publication", step: "draft-refine", phase: "draft",
        reason: "A separate diagnostic publication is outside this saved execution.",
        trigger: "external producer", observations: [], timestamp: "2026-10-14T00:00:00.000Z" } });
  }],
  ["stored request binding", "sealed", "FLOW_EXECUTION_CONTRACT_MISMATCH", (scenario) => {
    const request = scenario.requests.at(-1);
    const requestPath = path.join(path.dirname(path.dirname(requestPayloadPath(request, "draft.json"))), "request.json");
    const changed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    changed.dispatchRepositoryBinding.repositoryFingerprint = "untrusted-replacement-fingerprint";
    fs.writeFileSync(requestPath, workerArtifactJson(changed));
  }],
  ["published sealed payload", "publication", "FLOW_ARTIFACT_HANDOFF_INVALID", (scenario) => {
    const payloadPath = requestPayloadPath(scenario.requests.at(-1), "draft.json");
    const changed = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    changed.analysis.validation = "An untrusted writer changed a successfully sealed payload.";
    fs.writeFileSync(payloadPath, workerArtifactJson(changed));
  }],
];

for (const [changedInput, boundary, expectedCode, mutate, beforeClaim] of replayMutations) {
  it(`refuses ${boundary} refine replay after ${changedInput} changes without a provider or persistence effects`, async (t) => {
    const scenario = await interruptRefinePublication(t, boundary, { beforeClaim });
    mutate(scenario);
    scenario.reload();
    const before = scenario.snapshot();
    const calls = scenario.requests.length;
    const lifecycle = executionState(scenario);
    scenario.options.handoffCoordinator = new WorkerArtifactHandoffCoordinator();
    scenario.agent.call = async () => assert.fail("changed replay authority cannot start a provider");
    const refused = await scenario.dispatch(4);
    assertRefineRefusal(refused, expectedCode);
    assert.equal(scenario.requests.length, calls);
    assert.deepEqual(scenario.reload().snapshot(), before);
    assert.deepEqual(executionState(scenario).lifecycle.toJSON(), lifecycle.lifecycle.toJSON());
    assert.equal(executionState(scenario).receiptId, lifecycle.receiptId);
  });
}

it("refuses reading or dispatching a corrupted saved refine contract without repairing it or consuming budget", async (t) => {
  const scenario = await interruptRefinePublication(t, "publication");
  const contract = FlowExecutionContract.fromJSON(scenario.requests.at(-1).executionContract);
  const artifact = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "execution.contract",
    parameters: contract.parameters, consumerNodeId: "system" });
  const location = scenario.manager.specLocation(scenario.specId);
  const contractPath = path.join(location.directory, artifact.descriptor.relativePath);
  const changed = JSON.parse(artifact.bytes);
  changed.promptDigest = "b".repeat(64);
  fs.writeFileSync(contractPath, workerArtifactJson(changed));
  const paths = [location.flowStateFile, location.activitiesFile, location.catalogFile, contractPath];
  const before = paths.map((filename) => fs.readFileSync(filename));
  const calls = scenario.requests.length;
  const expectedMessage = `artifact content does not match the catalog: ${artifact.descriptor.relativePath}`;
  scenario.reload();
  scenario.agent.call = async () => assert.fail("corrupt contract authority cannot start a provider");
  assert.throws(() => scenario.manager.loadReadOnly(scenario.specId), { name: "Error", message: expectedMessage });
  await assert.rejects(() => scenario.dispatch(4), { name: "Error", message: expectedMessage });
  assert.equal(scenario.requests.length, calls);
  assert.deepEqual(paths.map((filename) => fs.readFileSync(filename)), before);
  assert.deepEqual(JSON.parse(before[0]).attempt.consumption, scenario.interruptedAttempt.consumption.toJSON());
});

it("keeps produced refine requests bounded when valid historical Activity bodies grow and replays their compact prefix proof", async (t) => {
  const requestSizes = [];
  for (const historicalModel of ["historical-provider", `HISTORICAL_PROVIDER_BODY:${"x".repeat(24000)}`]) {
    const scenario = await interruptRefinePublication(t, "sealed", { beforeClaim(active) {
      for (let index = 0; index < 8; index++) active.manager.appendMetric({
        phase: "historical", kind: "agent", model: historicalModel, callCount: 1,
      });
      active.preexistingActivityCount = active.manager.activityLedger(active.specId).length;
    } });
    const request = scenario.requests.at(-1);
    const serialized = JSON.stringify(request);
    const observation = request.dispatchRepositoryBinding.canonicalObservation;
    assert.equal(observation.prefixIdentity.activityCount, scenario.preexistingActivityCount);
    assert.match(observation.prefixIdentity.activityDigest, /^[a-f0-9]{64}$/);
    assert.match(observation.prefixIdentity.journalDigest, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(observation, "activityPrefix"), false);
    assert.equal(Object.hasOwn(observation, "activityBytes"), false);
    assert.equal(serialized.includes("HISTORICAL_PROVIDER_BODY"), false,
      "the worker capability cannot expose preexisting Activity bodies");
    requestSizes.push(Buffer.byteLength(serialized));
    scenario.options.handoffCoordinator = new WorkerArtifactHandoffCoordinator();
    scenario.agent.call = async () => assert.fail("compact proof replay cannot execute another provider");
    const beforeCalls = scenario.requests.length;
    const replayed = await scenario.dispatch(4);
    assert.equal(replayed.dispatch.boundary, "await_user_decision", JSON.stringify(replayed));
    assert.equal(scenario.requests.length, beforeCalls);
    assert.equal((await scenario.reload().next()).directive.questionId, "q1");
    scenario.close();
  }
  assert.ok(Math.abs(requestSizes[1] - requestSizes[0]) < 4096,
    `historical body growth cannot be copied into the request: ${requestSizes.join(" -> ")} bytes`);
});

for (const alteredPrefix of ["raw journal", "typed Activity"]) {
  it(`refuses compact refine replay when its ${alteredPrefix} prefix changes without effects`, async (t) => {
    const scenario = await interruptRefinePublication(t, "sealed", { beforeClaim(active) {
      active.manager.appendMetric({ phase: "historical", kind: "agent", model: "recorded-provider", callCount: 1 });
    } });
    const location = scenario.manager.specLocation(scenario.specId);
    const observation = SourceWorkerCanonicalObservationAdvance.capture({
      flowManager: scenario.manager, specId: scenario.specId,
    });
    const suppliedProof = observation.checkpointJSON();
    const corruptedProof = structuredClone(suppliedProof);
    const field = alteredPrefix === "raw journal" ? "journalDigest" : "activityDigest";
    corruptedProof.prefixIdentity[field] = "b".repeat(64);
    const restored = SourceWorkerCanonicalObservationAdvance.fromCheckpoint(suppliedProof, { canonicalLocation: location });
    const corrupted = SourceWorkerCanonicalObservationAdvance.fromCheckpoint(corruptedProof, { canonicalLocation: location });
    const beforeProof = scenario.snapshot();
    scenario.manager.readCanonicalTransitionView({ specId: scenario.specId, read(view) {
      restored.assertTransitionView(view);
      assert.throws(() => corrupted.assertTransitionView(view), (error) =>
        error instanceof WorkerArtifactHandoffError && error.code === "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID"
        && (alteredPrefix !== "raw journal" || error.data.exactJournalAppend === false));
    } });
    assert.deepEqual(scenario.snapshot(), beforeProof, "a malformed supplied checkpoint proof cannot mutate the legal view");

    const activitiesFile = location.activitiesFile;
    const original = fs.readFileSync(activitiesFile, "utf8");
    if (alteredPrefix === "raw journal") {
      const changed = original.replace("\n", "\r\n");
      assert.deepEqual(changed.trimEnd().split(/\r?\n/).map((line) => JSON.parse(line)),
        original.trimEnd().split("\n").map((line) => JSON.parse(line)), "the raw corruption preserves the parsed Activities");
      fs.writeFileSync(activitiesFile, changed);
    } else {
      const lines = original.trimEnd().split("\n");
      const index = lines.findIndex((line) => JSON.parse(line).metric?.model === "recorded-provider");
      assert.notEqual(index, -1);
      const altered = JSON.parse(lines[index]);
      altered.metric.model = "replaced-provider";
      lines[index] = JSON.stringify(altered);
      fs.writeFileSync(activitiesFile, `${lines.join("\n")}\n`);
    }
    const paths = [location.flowStateFile, activitiesFile, location.catalogFile];
    const before = paths.map((filename) => fs.readFileSync(filename));
    const calls = scenario.requests.length;
    scenario.reload();
    scenario.agent.call = async () => assert.fail("changed history cannot grant replay authority");
    const failure = { name: "Error", message: "artifact content does not match the catalog: activities.jsonl" };
    assert.throws(() => scenario.manager.loadReadOnly(scenario.specId), failure);
    await assert.rejects(() => scenario.dispatch(4), failure);
    assert.equal(scenario.requests.length, calls);
    assert.deepEqual(paths.map((filename) => fs.readFileSync(filename)), before);
    assert.deepEqual(JSON.parse(before[0]).attempt.consumption, scenario.interruptedAttempt.consumption.toJSON());
  });
}

for (const relativeInput of ["README.md", "fixtures/.tmp/input.json"]) {
  for (const changedAuthority of ["source", "index only"]) {
  it(`refuses nested worktree refine replay when ${relativeInput} ${changedAuthority} changes without provider or persistence effects`, async (t) => {
    const scenario = await interruptRefinePublication(t, "sealed", { nestedWorktree: true });
    assert.equal(scenario.manager.usesWorktreeFlowBinding(), true);
    assert.match(path.relative(scenario.mainRoot, scenario.root).split(path.sep).join("/"), /^\.sennel\/worktree\//);
    const request = scenario.requests.at(-1);
    const savedContract = FlowExecutionContract.fromJSON(request.executionContract);
    assert.deepEqual(scenario.manager.readExecutionContract({ executionContract: savedContract }).toJSON(), savedContract.toJSON());
    const sourcePath = path.join(scenario.root, relativeInput);
    const originalSource = fs.readFileSync(sourcePath);
    const tracked = runGit(["ls-files", "--error-unmatch", relativeInput], { cwd: scenario.root, log: false });
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout.trim(), relativeInput);
    const originalFingerprint = dispatchRepositoryFingerprint(scenario.context());
    const indexBefore = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.root, log: false });
    assert.equal(indexBefore.status, 0, indexBefore.stderr);
    assert.equal(indexBefore.stdout, "");
    fs.writeFileSync(sourcePath, relativeInput.endsWith(".json") ? workerArtifactJson({ preserved: false })
      : Buffer.concat([originalSource, Buffer.from("Changed execution worktree behavior.\n")]));
    if (changedAuthority === "index only") {
      const staged = runGit(["add", relativeInput], { cwd: scenario.root, log: false });
      assert.equal(staged.status, 0, staged.stderr);
      fs.writeFileSync(sourcePath, originalSource);
      assert.deepEqual(fs.readFileSync(sourcePath), originalSource,
        "the index case must keep exactly the source bytes supplied to the original claim");
    }
    const indexAfter = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.root, log: false });
    assert.equal(indexAfter.status, 0, indexAfter.stderr);
    if (changedAuthority === "index only") assert.notEqual(indexAfter.stdout, "");
    else assert.equal(indexAfter.stdout, "");
    assert.notEqual(dispatchRepositoryFingerprint(scenario.context()), originalFingerprint,
      "the default repository fingerprint must observe both tracked input and staged-index mutations");
    scenario.reload();
    const before = scenario.snapshot();
    const beforeBytes = fs.readFileSync(sourcePath);
    const calls = scenario.requests.length;
    scenario.options.handoffCoordinator = new WorkerArtifactHandoffCoordinator();
    scenario.agent.call = async () => assert.fail("a nested worktree authority change cannot start a provider");
    const refused = await scenario.dispatch(4);
    assertRefineRefusal(refused, "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED");
    assert.equal(scenario.requests.length, calls);
    assert.deepEqual(scenario.reload().snapshot(), before);
    assert.deepEqual(scenario.manager.readExecutionContract({ executionContract: savedContract }).toJSON(), savedContract.toJSON());
    assert.deepEqual(fs.readFileSync(sourcePath), beforeBytes);
    const retainedIndex = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.root, log: false });
    assert.equal(retainedIndex.status, 0, retainedIndex.stderr);
    assert.equal(retainedIndex.stdout, indexAfter.stdout);
  });
  }
}

it("refuses nested refine replay after staging canonical Draft bytes without a source or provider change", async (t) => {
  const scenario = await interruptRefinePublication(t, "sealed", { nestedWorktree: true });
  const artifact = scenario.artifact("draft", undefined, "draft-refine");
  const location = scenario.manager.specLocation(scenario.specId);
  const draftPath = path.join(location.directory, artifact.descriptor.relativePath);
  const relativeDraft = path.relative(scenario.mainRoot, draftPath).split(path.sep).join("/");
  assert.equal(relativeDraft.startsWith("../"), false);
  const originalBytes = fs.readFileSync(draftPath);
  const beforeIndex = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.mainRoot, log: false });
  assert.equal(beforeIndex.status, 0, beforeIndex.stderr);
  assert.equal(beforeIndex.stdout, "");
  const staged = runGit(["add", "-f", relativeDraft], { cwd: scenario.mainRoot, log: false });
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(fs.readFileSync(draftPath), originalBytes);
  const stagedIndex = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.mainRoot, log: false });
  assert.equal(stagedIndex.status, 0, stagedIndex.stderr);
  assert.notEqual(stagedIndex.stdout, "");
  scenario.reload();
  const before = scenario.snapshot();
  const calls = scenario.requests.length;
  scenario.options.handoffCoordinator = new WorkerArtifactHandoffCoordinator();
  scenario.agent.call = async () => assert.fail("staging canonical artifacts cannot authorize replay");
  const refused = await scenario.dispatch(4);
  assertRefineRefusal(refused, "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED");
  assert.equal(scenario.requests.length, calls);
  assert.deepEqual(scenario.reload().snapshot(), before);
  assert.deepEqual(fs.readFileSync(draftPath), originalBytes);
  const retainedIndex = runGit(["diff", "--cached", "--binary", "HEAD"], { cwd: scenario.mainRoot, log: false });
  assert.equal(retainedIndex.status, 0, retainedIndex.stderr);
  assert.equal(retainedIndex.stdout, stagedIndex.stdout);
});
