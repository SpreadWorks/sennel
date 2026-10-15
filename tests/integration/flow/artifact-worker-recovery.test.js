import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/flow-process-execution-binding.js";
import { readFlowProcessStops } from "../../../src/flow/lib/process-runtime-admission.js";
import { ArtifactWorkerRecoveryAuthorized, ArtifactWorkerRecoveryRequired,
  ArtifactWorkerExecutionContinuationFacts, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";
import { ArtifactWorkerExecutionFrontier } from "../../../src/flow/lib/artifact-worker-recovery-values.js";
import { executeArtifactWorkerPrompt } from "../../../src/flow/lib/artifact-worker-prompt-execution.js";
import { PromptExecutionReservationContinuation, PromptProviderProcessIdentity } from "../../../src/lib/prompt-execution-journal.js";
import { PromptBatchExecutionIncompleteFailure } from "../../../src/lib/prompt-batching.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff,
  DispatchExecutionRepositoryBinding, WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { OriginalArtifactWorkerAuthorization } from "../../../src/flow/lib/original-artifact-worker-authorization.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { CanonicalPromptReservationReconciliationPublication } from "../../../src/flow/lib/canonical-prompt-execution.js";
import { FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunRecoverArtifactExecutionCommand from "../../../src/flow/lib/run-recover-artifact-execution.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftGateRepairWorkerRequiredResult, DraftGateRepairAppliedResult } from "../../../src/flow/engine/step-result.js";
import { DraftRepairCandidate } from "../../../src/flow/steps/draft/draft-repair-candidate.js";
import { DraftWorkerStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftConditionalWorkerExecutionBinding, settleDraftStepResult } from "../../../src/flow/definition.js";
import { FlowDispatchTarget, FlowDispatchSession, FlowDispatchInvocation,
  UnapprovedFlowDispatchAuthorization } from "../../../src/flow/lib/dispatch-invocation.js";
import RunDispatchCommand, { dispatchRepositoryFingerprint } from "../../../src/flow/lib/run-dispatch.js";
import { selectWorkerExecutionAdmission, projectWorkerExecutionAdmission,
  assertCurrentWorkerExecutionSelection } from "../../../src/flow/lib/worker-execution-admission.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { dispatchContainer, dispatchFlowCommand } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { installReviewProcessFake } from "../../support/infrastructure/review-process-fake.js";

function bytesUnder(directory) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isDirectory()) { entries.push([relative, null]); visit(absolute); }
      else entries.push([relative, fs.readFileSync(absolute).toString("base64")]);
    }
  };
  visit(directory);
  return entries;
}

function recoveryRepository(t) {
  const root = createTmpDir("artifact-worker-recovery-");
  const runtimes = [];
  t.after(async () => {
    try { for (const runtime of runtimes) if (!runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "Artifact worker recovery fixture\n");
  commitAll(root, "Create artifact worker recovery fixture");
  return { root, runtimes };
}

function boundFixture({ root, runtimes, specId, manager, request, scenario = null }) {
  const reload = (options = {}) => new FlowManager({ root, mainRoot: root, inWorktree: false, specId, ...options });
  const context = (flowManager) => ({ root, mainRoot: root, executionRoot: root, specId,
    flowManager, flowState: flowManager.loadReadOnly(specId) });
  const binding = (flowManager) => {
    const state = flowManager.canonicalState(specId);
    return { runId: state.runId, specId, stepId: request.stepId, nodeId: request.stepId, attempt: state.attempt };
  };
  return { root, specId, manager, request, scenario, runtimes, reload, context, binding };
}

function selectedInvocation({ root, manager, specId, id }) {
  const ctx = { root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId) };
  const stepId = manager.canonicalState(specId).attempt.nodeId;
  const selected = selectWorkerExecutionAdmission({ ctx, stepId });
  const binding = FlowTargetBinding.captureContext(ctx);
  const session = new FlowDispatchSession({ id,
    target: FlowDispatchTarget.captureContext({ ...ctx, expectBinding: binding.serialize() }) });
  const action = session.captureAction({ step: stepId, directive: projectWorkerExecutionAdmission(selected).toJSON() },
    dispatchRepositoryFingerprint(ctx));
  return new FlowDispatchInvocation({ session, action, authorization: new UnapprovedFlowDispatchAuthorization(action) });
}

function conditionalFixture(t) {
  const { root, runtimes } = recoveryRepository(t);
  const specId = "artifact-worker-recovery";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "artifact-worker-recovery-run",
    request: "Retain one conditional worker authorization through a restart.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("draft");
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "Retain the selected behavior", questions: [] }))) }] });
  flow.activate("draft-gate");
  const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId }).select({
    issueLogId: "artifact-worker-recovery-issue", observations: [{ kind: "violation", failureMode: "guardrail-violation",
      requirementRef: "R-1", where: { file: "draft.json", locator: "goal" },
      observed: "State the selected behavior precisely.", severity: "blocking", refs: ["R-1"] }],
  });
  // The shared scenario predates atomic canonical request snapshots. Exercise the
  // current production checkpoint/claim APIs with the same selected Gate facts.
  const invocation = selectedInvocation({ root, manager, specId, id: `draft-gate-repair-${manager.canonicalState(specId).attempt.id}` });
  let request = scenario.coordinator.createRequest({ ctx: scenario.ctx, state: manager.loadReadOnly(specId), invocation,
    deferPreparation: true, deferConditionalAdmission: true });
  request = request.withDispatchRepositoryBinding(DispatchExecutionRepositoryBinding.capture({
    ctx: { ...scenario.ctx, flowState: manager.loadReadOnly(specId) }, request, invocation, fingerprint: dispatchRepositoryFingerprint }));
  const binding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-gate-repair" });
  const stepResult = new DraftGateRepairWorkerRequiredResult();
  const settlement = settleDraftStepResult(stepResult.stepId, stepResult);
  const executionBinding = new DraftConditionalWorkerExecutionBinding({ executionGeneration: 0,
    inputDigest: request.inputDigest, inputRevision: request.inputRevision, contentDigest: request.checkpointContentDigest() });
  manager.checkpointDraftStepExecution({ binding, stepResult, settlement, executionBinding });
  manager.claimDraftStepExecution({ binding, stepResult, settlement, executionBinding,
    executionContract: request.executionContract, requestSnapshot: request.requestSnapshot(),
    executionClaim: new DraftWorkerExecutionClaim({ dispatchInvocationId: request.dispatchInvocationId,
      generatedAt: request.generatedAt, actionDigest: request.actionDigest, requestDigest: request.requestDigest }) });
  scenario.coordinator.admitConditionalDraftRequest({ ctx: scenario.ctx, state: manager.loadReadOnly(specId), request });
  request.prepare();
  scenario.request = request;
  return boundFixture({ root, runtimes, specId, manager, request, scenario });
}

function originalFixture(t) {
  const { root, runtimes } = recoveryRepository(t);
  const specId = "original-artifact-reservation";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "original-artifact-reservation-run",
    request: "Resume only the original unstarted worker reservation.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("draft");
  const request = new WorkerArtifactHandoffCoordinator().createRequest({ ctx: { root, mainRoot: root,
    executionRoot: root, flowManager: manager, specId }, state: manager.loadReadOnly(specId),
    invocation: selectedInvocation({ root, manager, specId, id: "original-artifact-dispatch" }) });
  return boundFixture({ root, runtimes, specId, manager, request });
}

function workerProcessBinding(request) {
  return new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(request.executionContract).toJSON(),
    dispatchInvocationId: request.dispatchInvocationId, requestDigest: request.requestDigest });
}

async function interruptOriginalReservation(value, manager, { boundary, ordinal, reservationContinuation = null }) {
  const { request, root, specId } = value;
  const processBinding = workerProcessBinding(request);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: request.runId, specId, binding: processBinding });
  value.runtimes.push(runtime);
  const failure = new Error(`Interrupted original worker ${boundary} ${ordinal}`);
  try {
    await assert.rejects(runtime.enter(() => executeArtifactWorkerPrompt({ flowManager: manager, request,
      prompt: "Publish the selected Draft behavior", reservationContinuation,
      callOptions: { commandId: "flow.worker", processExecutionBinding: processBinding },
      agent: { async call(_prompt, options) {
        options.providerCallAdmission.claim();
        const context = { attempt: 1, maxAttempts: 1, providerKey: "test", profileKey: "original",
          attemptId: `original-provider-${ordinal}`, logicalInvocationId: `original-logical-${ordinal}` };
        await options.providerCallAdmission.beforeProviderAttempt(context);
        const invocation = { kind: "provider", providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
          providerAttemptContext: context, promptProcessIdentity: options.providerCallAdmission.processExecutionIdentity.toJSON() };
        if (boundary === "before-permit") {
          const call = await runtime.reserveCall({ binding: processBinding, invocation: { kind: "provider",
            providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
            providerAttemptContext: context, promptProcessIdentity: options.providerCallAdmission.processExecutionIdentity.toJSON() } });
          await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
        } else if (boundary === "after-permit") {
          await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('worker started without a submission')"], {
            ...invocation, processExecutionBinding: processBinding, timeoutMs: 60000, maxBuffer: 1024 });
        }
        throw failure;
      } },
    })), (error) => error instanceof PromptBatchExecutionIncompleteFailure && error.cause === failure);
  } finally { await runtime.close(); }
}

async function completeOriginalReservation(value, manager, reservationContinuation, payload) {
  const { request, root, specId } = value;
  const processBinding = workerProcessBinding(request);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: request.runId, specId, binding: processBinding });
  value.runtimes.push(runtime);
  try {
    return await runtime.enter(() => executeArtifactWorkerPrompt({ flowManager: manager, request,
      prompt: "Publish the selected Draft behavior", reservationContinuation,
      callOptions: { commandId: "flow.worker", processExecutionBinding: processBinding },
      agent: { async call(_prompt, options) {
        const admission = options.providerCallAdmission;
        admission.claim();
        const context = { attempt: 1, maxAttempts: 1, providerKey: "test", profileKey: "original",
          attemptId: "completed-provider-attempt", logicalInvocationId: "completed-logical-invocation" };
        await admission.beforeProviderAttempt(context);
        fs.writeFileSync(request.payloadPath("draft-gate-repair.json"), JSON.stringify(payload));
        sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
        const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('sealed worker result')"], {
          processExecutionBinding: processBinding, kind: "provider", timeoutMs: 60000, maxBuffer: 1024,
          providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
          providerAttemptContext: context, promptProcessIdentity: admission.processExecutionIdentity.toJSON(),
          onProcessExecutionStop: (receipt) => admission.observeProcessStop(receipt, context) });
        admission.settle();
        return result.stdout;
      } },
    }));
  } finally { await runtime.close(); }
}

async function closeStoppedRuntime(value) {
  await interruptOriginalReservation(value, value.manager, { boundary: "after-permit", ordinal: "stopped-source" });
  return ProcessExecutionRuntime.inspect({ mainRoot: value.root, executionRoot: value.root });
}

async function recoverArtifact(value, manager) {
  const ctx = value.context(manager);
  const envelope = await new RunRecoverArtifactExecutionCommand().execute({ ...ctx,
    expectBinding: FlowTargetBinding.captureContext(ctx).serialize() });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const frontier = manager.artifactWorkerExecutionState({ binding: value.binding(manager) });
  return frontier.recovery ?? new OriginalArtifactWorkerAuthorization({
    requestSnapshot: manager.readArtifactWorkerRequest({ executionContract: frontier.executionContract }) });
}

async function guardedRecovery(value, manager) {
  const selection = selectWorkerExecutionAdmission({ ctx: value.context(manager), stepId: value.request.stepId });
  assert.ok(selection.artifactContinuation instanceof ArtifactWorkerRecoveryRequired);
  const binding = FlowTargetBinding.captureContext(value.context(manager));
  const directive = projectWorkerExecutionAdmission(selection, { binding });
  assert.equal(directive.command.subcommand, "recover-artifact-execution");
  const execution = await dispatchFlowCommand({ container: dispatchContainer({ root: value.root, flowManager: manager,
    agent: { call: () => assert.fail("the recovery command cannot call a provider") } }),
    group: "run", name: "recover-artifact-execution", argv: [...directive.command.args] });
  assert.equal(execution.exitCode, 0, execution.stderr || execution.stdout);
  assert.equal(execution.envelope.ok, true, execution.stdout);
  return execution.envelope.data;
}

function canonicalSnapshot(value, manager) {
  return { state: manager.canonicalState(value.specId).toJSON(),
    activities: JSON.parse(JSON.stringify(manager.activityLedger(value.specId))),
    catalog: manager.artifactCatalog(value.specId).toJSON(),
    sourceCapability: bytesUnder(value.request.directory),
    budget: manager.readStoredPromptExecutionEpisode({ executionContract: value.request.executionContract }).budget };
}

function claimReplacement(value, manager, receipt) {
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const request = coordinator.storedArtifactExecutionRequest({ ctx: value.context(manager),
    state: manager.loadReadOnly(value.specId), executionContract: receipt.targetContract });
  const execution = manager.draftStepExecutionState({ binding: value.binding(manager) });
  const selected = execution.executionIdentity();
  manager.claimDraftStepExecution({ binding: value.binding(manager), stepResult: selected.stepResult,
    settlement: selected.settlement, executionBinding: execution.lifecycle.binding, executionContract: request.executionContract,
    requestSnapshot: request.requestSnapshot(),
    executionClaim: new DraftWorkerExecutionClaim({ dispatchInvocationId: request.dispatchInvocationId,
      generatedAt: request.generatedAt, actionDigest: request.actionDigest, requestDigest: request.requestDigest }) });
  request.prepare();
  return request;
}

async function consumeCoverage(t, value, expectedGoal) {
  const consumer = value.reload();
  const saved = consumer.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" });
  assert.equal(JSON.parse(saved.bytes).goal, expectedGoal);
  let reviewed = false;
  const reviewProcess = installReviewProcessFake((_command, _args, options) => {
    const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
    assert.equal(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")).goal, expectedGoal);
    assert.equal(source.revision.digest, saved.descriptor.hash);
    reviewed = true;
    const work = ReviewWorkUnit.fromEnvironment(options.env);
    fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), JSON.stringify({
      version: 2, phase: "draft-coverage", sourceDraft: "draft.json", sourceDraftRevision: source.revision,
      generatedAt: "2026-10-06T00:00:00.000Z", verdict: "PASS", summary: "The recovered Draft retains the behavior.",
      blockingFindings: [], advisoryFindings: [], repairTargets: [],
    }));
    work.seal();
    return { ok: true, status: 0, signal: null, killed: false, stdout: "", stderr: "" };
  });
  t.after(() => reviewProcess.mock.restore());
  const agent = { call: () => assert.fail("Coverage uses its registered external Review process") };
  for (let index = 0; index < 3 && !reviewed; index++) {
    const resumed = value.reload();
    const dispatch = new RunDispatchCommand({ agent, maxDispatches: 1 });
    dispatch.container = dispatchContainer({ root: value.root, flowManager: resumed, agent });
    const review = await dispatch.execute({ ...value.context(resumed),
      expectBinding: FlowTargetBinding.captureContext(value.context(resumed)).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch" });
    assert.equal(review.errors[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(review));
  }
  assert.equal(reviewed, true);
  const consumedReview = value.reload().readArtifact({ specId: value.specId, logicalKey: "draft.coverage.review", consumerNodeId: "draft-coverage-triage" });
  assert.equal(JSON.parse(consumedReview.bytes).attempts.at(-1).artifact.payload.sourceDraftRevision.digest, saved.descriptor.hash);
  assert.equal(value.reload().canonicalState(value.specId).nextAction().nodeId, "draft-gate",
    "the clean Coverage review skips empty triage and repair work through Definition");
}

for (const boundary of ["before-reservation", "before-permit"]) {
  test(`an original ${boundary} reservation resumes through the guarded command without a new generation or budget`, async (t) => {
    const value = originalFixture(t);
    const { request, specId } = value;
    const originalState = value.manager.canonicalState(specId).toJSON();
    await interruptOriginalReservation(value, value.manager, { boundary, ordinal: "initial" });
    const before = value.reload();
    const initial = before.artifactWorkerExecutionState({ binding: value.binding(before) });
    assert.equal(initial.status, "reserved");
    assert.equal(initial.recovery, null);
    assert.equal(initial.reservationContinuation, null);
    const budget = before.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget;
    assert.equal(budget.providerCallCount, 1);
    const response = await guardedRecovery(value, before);
    assert.equal(response.executionContractId, request.executionContract.id);
    assert.equal(response.executionGeneration, 0);
    assert.equal(response.runtimeMigration, false);
    const fresh = value.reload();
    const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
    const authorization = new OriginalArtifactWorkerAuthorization({
      requestSnapshot: fresh.readArtifactWorkerRequest({ executionContract: request.executionContract }) });
    assert.equal(response.authorizationId, authorization.id);
    assert.equal(frontier.contracts.length, 1);
    assert.equal(frontier.executionContract.id, request.executionContract.id);
    assert.equal(frontier.recovery, null);
    assert.equal(frontier.reservationContinuation.pending, true);
    assert.equal(frontier.reservationContinuation.authorizationId, authorization.id);
    assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget, budget);
    const recoveredState = fresh.canonicalState(specId).toJSON();
    assert.deepEqual(recoveredState.attempt, originalState.attempt);
    assert.equal(recoveredState.current, originalState.current);
    assert.deepEqual(recoveredState.steps, originalState.steps);
    assert.deepEqual(recoveredState.lifecycle, originalState.lifecycle);
    const selected = selectWorkerExecutionAdmission({ ctx: value.context(fresh), stepId: request.stepId });
    assert.ok(selected.artifactContinuation instanceof ArtifactWorkerRecoveryAuthorized);
    assert.equal(selected.artifactContinuation.reservationContinuation.id, frontier.reservationContinuation.id);
    assert.equal(projectWorkerExecutionAdmission(selected).kind, "execute_step");
    const snapshot = canonicalSnapshot(value, fresh);
    const replay = await recoverArtifact(value, value.reload());
    assert.equal(replay.id, authorization.id);
    assert.deepEqual(canonicalSnapshot(value, value.reload()), snapshot,
      "an identical recover request cannot append a duplicate reservation reconciliation");
  });
}

test("the original unused grant remains available before any Prompt reservation across recovery and reload", async (t) => {
  const value = originalFixture(t);
  const contract = value.request.executionContract;
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, executionRoot: value.root,
    runId: contract.runId, specId: contract.specId, binding: FlowProcessExecutionBinding.forContract(contract) });
  value.runtimes.push(runtime);
  await runtime.close();
  const manager = value.reload();
  const before = canonicalSnapshot(value, manager);
  assert.equal(before.budget.providerCallCount, 0);
  const authorization = await recoverArtifact(value, manager);
  assert.ok(authorization instanceof OriginalArtifactWorkerAuthorization);
  assert.equal(authorization.executionContract.id, contract.id);
  const fresh = value.reload();
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
  assert.equal(frontier.executionContract.generation, 0);
  assert.equal(frontier.contracts.length, 1);
  assert.equal(frontier.status, "unconsumed");
  assert.equal(frontier.recovery, null);
  assert.equal(frontier.reservationContinuation, null);
  assert.deepEqual(canonicalSnapshot(value, fresh), before);
  const selected = selectWorkerExecutionAdmission({ ctx: value.context(fresh), stepId: value.request.stepId });
  assert.ok(selected.artifactContinuation instanceof ArtifactWorkerRecoveryAuthorized);
  assert.equal(projectWorkerExecutionAdmission(selected).kind, "execute_step");
});

test("an original conditional reservation retains its claim history across reinterruption and publishes a repair used by Coverage", async (t) => {
  const value = conditionalFixture(t);
  const { request, specId, scenario } = value;
  const sourceOwner = value.manager.draftStepExecutionState({ binding: value.binding(value.manager) });
  const sourceClaim = sourceOwner.lifecycle.claim.toJSON();
  const sourceState = value.manager.canonicalState(specId);
  await interruptOriginalReservation(value, value.manager, { boundary: "before-reservation", ordinal: "first" });
  const first = value.reload();
  const firstResponse = await guardedRecovery(value, first);
  const firstFrontier = value.reload().artifactWorkerExecutionState({ binding: value.binding(first) });
  const firstMarker = firstFrontier.reservationContinuation;
  const budget = first.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget;
  assert.equal(firstResponse.executionGeneration, 0);
  assert.equal(firstMarker.pending, true);
  assert.equal(firstMarker.history.length, 0);

  const interrupted = value.reload();
  await interruptOriginalReservation(value, interrupted, { boundary: "before-permit", ordinal: "second", reservationContinuation: firstMarker });
  const second = value.reload();
  const consumed = PromptExecutionReservationContinuation.fromJSON(
    second.readStoredPromptExecutionEpisode({ executionContract: request.executionContract })
      .scopes[0].batches[0].reservationContinuation);
  assert.equal(consumed.id, firstMarker.id);
  assert.equal(consumed.pending, false);
  const secondResponse = await guardedRecovery(value, second);
  assert.equal(secondResponse.authorizationId, firstResponse.authorizationId);
  assert.equal(secondResponse.executionContractId, request.executionContract.id);
  assert.equal(secondResponse.executionGeneration, 0);
  const fresh = value.reload();
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
  const marker = frontier.reservationContinuation;
  assert.equal(frontier.contracts.length, 1);
  assert.equal(frontier.recovery, null);
  assert.equal(marker.pending, true);
  assert.equal(marker.history.length, 1);
  assert.deepEqual(marker.history[0].previousClaim, firstMarker.previousClaim);
  assert.deepEqual(marker.history[0].consumedClaim, consumed.consumedClaim);
  assert.notEqual(marker.physicalEvidence.digest, firstMarker.physicalEvidence.digest);
  const owner = fresh.draftStepExecutionState({ binding: value.binding(fresh) });
  assert.equal(owner.lifecycle.phase, "claimed");
  assert.equal(owner.lifecycle.executionGeneration, 0);
  assert.deepEqual(owner.lifecycle.claim.toJSON(), sourceClaim);
  assert.deepEqual(fresh.canonicalState(specId).attempt.toJSON(), sourceState.attempt.toJSON());
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget, budget);

  const repairedGoal = "Retain the selected behavior when the worker resumes after an interruption.";
  const payload = scenario.replacement("goal", repairedGoal);
  assert.equal(await completeOriginalReservation(value, fresh, marker, payload), "sealed worker result");
  const completion = value.reload();
  const episode = completion.readStoredPromptExecutionEpisode({ executionContract: request.executionContract });
  assert.equal(episode.budget.providerCallCount, budget.providerCallCount);
  assert.equal(episode.budget.synthesisCallCount, budget.synthesisCallCount);
  assert.equal(episode.budget.aggregateItemCount, budget.aggregateItemCount + 1);
  assert.ok(episode.budget.aggregateCharacters > budget.aggregateCharacters);
  const batch = episode.scopes[0].batches[0];
  const completedMarker = PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
  assert.equal(completedMarker.pending, false);
  assert.equal(completedMarker.history.length, 1);
  assert.equal(batch.transportOrdinal, 1);
  assert.equal(batch.batchCalls, 1);
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const preparation = coordinator.prepareDraftWorker({ ctx: value.context(completion), request });
  const stepResult = new DraftGateRepairAppliedResult();
  const publication = coordinator.commitDraftWorker({ ctx: value.context(completion), request,
    preparation: preparation.adoptRepairCandidate(new DraftRepairCandidate(preparation.facts.repairInput)),
    stepResult, settlement: settleDraftStepResult(stepResult.stepId, stepResult), binding: new DraftWorkerStepBinding({ request }) });
  assert.equal(publication.completed, true);
  await consumeCoverage(t, value, repairedGoal);
});

test("an original reservation with a physical start permit refuses same-generation reuse after its provider has stopped", async (t) => {
  const value = originalFixture(t);
  await interruptOriginalReservation(value, value.manager, { boundary: "after-permit", ordinal: "permitted" });
  const manager = value.reload();
  const contract = value.request.executionContract;
  const snapshot = manager.readStoredPromptExecutionEpisode({ executionContract: contract }).scopes[0];
  const authorization = new OriginalArtifactWorkerAuthorization({ requestSnapshot: manager.readArtifactWorkerRequest({ executionContract: contract }) });
  const before = canonicalSnapshot(value, manager);
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, executionRoot: value.root,
    binding: FlowProcessExecutionBinding.forEpisode(contract) }, (physicalEvidence) => {
    const proof = physicalEvidence.forBinding(FlowProcessExecutionBinding.forContract(contract));
    assert.equal(proof.calls.length, 1);
    assert.equal(proof.calls[0].startPermitted, true);
    assert.notEqual(proof.calls[0].receipt, null);
    const publication = new CanonicalPromptReservationReconciliationPublication({ contract, scope: snapshot.scope,
      snapshot, originalAuthorization: authorization, request: value.request, physicalEvidence,
      operationId: "refuse-original-permitted-reservation" });
    assert.throws(() => manager.savePromptReservationReconciliation({ publication }),
      (error) => error instanceof FlowExecutionContractRefusal && error.message.includes("physical start permission"));
  });
  assert.deepEqual(canonicalSnapshot(value, value.reload()), before);
  assert.equal(value.reload().artifactWorkerExecutionState({ binding: value.binding(manager) }).reservationContinuation, null);
});

test("a stopped unsealed conditional claim saves one replacement and owner checkpoint, then replays them after fresh readback", async (t) => {
  const value = conditionalFixture(t);
  const { root, specId, manager, request } = value;
  const beforeState = manager.canonicalState(specId);
  const sourceExecution = manager.draftStepExecutionState({ binding: value.binding(manager) });
  assert.equal(sourceExecution.lifecycle.phase, "claimed");
  assert.equal(sourceExecution.lifecycle.executionGeneration, 0);
  assert.equal(request.hasSealedSubmission(), false);
  const sourceCapability = bytesUnder(request.directory);
  const sourceArtifact = manager.readArtifact({ specId, logicalKey: "execution.contract",
    parameters: request.executionContract.parameters, consumerNodeId: "system" });
  const closedInventory = await closeStoppedRuntime(value);
  const sourceActivities = JSON.parse(JSON.stringify(manager.activityLedger(specId)));
  const sourceBudget = manager.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget;
  assert.equal(sourceBudget.providerCallCount, 1);
  assert.equal(closedInventory.executions.length, 1);
  assert.equal(closedInventory.executions[0].status, "closed");
  assert.equal(closedInventory.executions[0].calls.length, 1);
  assert.notEqual(closedInventory.executions[0].calls[0].permit, null);
  assert.equal(readFlowProcessStops({ mainRoot: root, executionRoot: root }).length, 1,
    "the managed worker retains its exact process stop receipt");

  const restarted = value.reload();
  const receipt = await recoverArtifact(value, restarted);
  assert.equal(receipt.sourceContractId, request.executionContract.id);
  assert.equal(receipt.targetGeneration, request.executionContract.generation + 1);
  assert.notEqual(receipt.targetContractId, receipt.sourceContractId);
  assert.notEqual(receipt.evidence.targetDispatchInvocationId, request.dispatchInvocationId);
  assert.notEqual(receipt.evidence.targetRequestDigest, request.requestDigest);
  assert.deepEqual(receipt.evidence.budget, sourceBudget);
  assert.equal(receipt.targetContract.budgetId, request.executionContract.budgetId);
  assert.deepEqual(receipt.targetContract.executionLimit, request.executionContract.executionLimit);

  const readback = value.reload();
  const frontier = readback.artifactWorkerExecutionState({ binding: value.binding(readback) });
  assert.equal(frontier.recovery.id, receipt.id);
  assert.equal(frontier.executionContract.id, receipt.targetContractId);
  assert.equal(frontier.status, "unconsumed");
  assert.deepEqual(frontier.contracts.map((contract) => contract.id), [receipt.sourceContractId, receipt.targetContractId]);
  const checkpoint = readback.draftStepExecutionState({ binding: value.binding(readback) });
  assert.equal(checkpoint.lifecycle.phase, "checkpoint");
  assert.equal(checkpoint.lifecycle.executionGeneration, receipt.targetGeneration);
  assert.equal(checkpoint.lifecycle.binding.contentDigest, sourceExecution.lifecycle.binding.contentDigest);
  assert.equal(checkpoint.lifecycle.claim, null);
  assert.equal(checkpoint.executionIdentity().stepResult.kind, sourceExecution.executionIdentity().stepResult.kind);

  const publications = ["execution.contract", "execution.request", "execution.recovery"].map((logicalKey) =>
    readback.readArtifact({ specId, logicalKey, parameters: receipt.targetContract.parameters, consumerNodeId: "system" }));
  assert.equal(new Set(publications.map((publication) => publication.descriptor.activityId)).size, 1);
  const checkpointActivity = readback.activityLedger(specId).find((activity) =>
    activity.result?.draftSettlementReceipt?.id === checkpoint.receiptId);
  assert.equal(checkpointActivity.id, publications[0].descriptor.activityId,
    "the replacement contract, request, authorization and owner checkpoint share one transaction");
  const targetRequest = readback.readArtifactWorkerRequest({ executionContract: receipt.targetContract });
  assert.equal(targetRequest.requestDigest, receipt.evidence.targetRequestDigest);
  assert.equal(targetRequest.request.dispatchInvocationId, receipt.evidence.targetDispatchInvocationId);
  assert.equal(targetRequest.request.executionContractId, receipt.targetContractId);
  const unchangedSource = readback.readArtifact({ specId, logicalKey: "execution.contract",
    parameters: request.executionContract.parameters, consumerNodeId: "system" });
  assert.deepEqual(unchangedSource.bytes, sourceArtifact.bytes);
  assert.deepEqual(unchangedSource.descriptor, sourceArtifact.descriptor);
  assert.deepEqual(bytesUnder(request.directory), sourceCapability,
    "recovery retains the old claim capability, unsealed payload directory and any producer diagnostics");
  assert.deepEqual(JSON.parse(JSON.stringify(readback.activityLedger(specId))).slice(0, sourceActivities.length), sourceActivities);
  assert.deepEqual(readback.canonicalState(specId).attempt.toJSON(), beforeState.attempt.toJSON());
  assert.deepEqual(readback.canonicalState(specId).current, beforeState.current);
  assert.deepEqual(readback.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget, sourceBudget);
  assert.deepEqual(ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root }), closedInventory);

  const selected = selectWorkerExecutionAdmission({ ctx: value.context(readback), stepId: "draft-gate-repair" });
  assert.ok(selected.artifactContinuation instanceof ArtifactWorkerRecoveryAuthorized);
  assert.equal(projectWorkerExecutionAdmission(selected).kind, "execute_step");
  const after = { state: readback.canonicalState(specId).toJSON(),
    activities: JSON.parse(JSON.stringify(readback.activityLedger(specId))), catalog: readback.artifactCatalog(specId).toJSON() };
  const fresh = value.reload();
  const replay = await recoverArtifact(value, fresh);
  assert.equal(replay.id, receipt.id);
  assert.deepEqual({ state: fresh.canonicalState(specId).toJSON(),
    activities: JSON.parse(JSON.stringify(fresh.activityLedger(specId))), catalog: fresh.artifactCatalog(specId).toJSON() }, after);
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: replay.targetContract }).budget, sourceBudget);

  const resumedRequest = new WorkerArtifactHandoffCoordinator().storedArtifactExecutionRequest({
    ctx: value.context(fresh), state: fresh.loadReadOnly(specId), executionContract: receipt.targetContract });
  const sourceBinding = request.dispatchRepositoryBinding;
  const targetBinding = resumedRequest.dispatchRepositoryBinding;
  assert.deepEqual(targetBinding.executionSnapshot.entries.map((entry) => entry.toJSON()),
    sourceBinding.executionSnapshot.entries.map((entry) => entry.toJSON()));
  assert.equal(targetBinding.executionSnapshot.head, sourceBinding.executionSnapshot.head);
  assert.equal(targetBinding.executionSnapshot.indexDigest, sourceBinding.executionSnapshot.indexDigest);
  assert.deepEqual(targetBinding.canonicalObservation.checkpointJSON(), sourceBinding.canonicalObservation.checkpointJSON());
  assert.deepEqual(targetBinding.executionSnapshot.ignoredDirectories, [...sourceBinding.executionSnapshot.ignoredDirectories,
    path.relative(sourceBinding.executionSnapshot.root, resumedRequest.directory).split(path.sep).join("/")]
    .sort((left, right) => left.localeCompare(right)));
  assert.equal(resumedRequest.dispatchRepositoryBinding.assertCurrent({ flowManager: fresh, request: resumedRequest }),
    resumedRequest.dispatchIdentity.repositoryFingerprint);
  const repair = new DraftGateRepairScenario({ flowManager: fresh, root, specId });
  repair.request = resumedRequest;
  const repairedGoal = "Retain the selected behavior after the stopped worker receives its replacement generation.";
  const payload = repair.replacement("goal", repairedGoal);
  let providerCalls = 0;
  let preproviderGuardCalls = 0;
  let guardedChanges = null;
  const assertRepositoryBinding = DispatchExecutionRepositoryBinding.prototype.assertCurrent;
  t.mock.method(DispatchExecutionRepositoryBinding.prototype, "assertCurrent", function (input) {
    if (input.request.executionContract.id === receipt.targetContractId) preproviderGuardCalls++;
    try { return assertRepositoryBinding.call(this, input); }
    catch (error) {
      guardedChanges = [this.executionSnapshot, this.canonicalRepositorySnapshot].filter(Boolean)
        .flatMap((snapshot) => snapshot.allChangedPaths(WorkerArtifactRepositoryMutationSnapshot.capture(snapshot)));
      throw error;
    }
  });
  const agent = { async call(_prompt, options) {
    providerCalls++;
    assert.ok(preproviderGuardCalls >= 1, "dispatch verifies the retained source mutation boundary before starting the replacement provider");
    const external = JSON.parse(fs.readFileSync(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST, "utf8"));
    assert.equal(external.executionContractId, receipt.targetContractId);
    assert.equal(external.dispatchInvocationId, resumedRequest.dispatchInvocationId);
    const admission = options.providerCallAdmission;
    admission.claim();
    const context = { attempt: 1, maxAttempts: 1, providerKey: "test", profileKey: "replacement",
      attemptId: "replacement-completed-provider", logicalInvocationId: "replacement-completed-invocation" };
    await admission.beforeProviderAttempt(context);
    fs.writeFileSync(resumedRequest.payloadPath("draft-gate-repair.json"), JSON.stringify(payload));
    const sealed = sealWorkerArtifactHandoff({ requestPath: resumedRequest.requestPath,
      invocationId: resumedRequest.dispatchInvocationId, mainRoot: root, flowManager: fresh });
    const result = await executeManagedProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      stdinContent: JSON.stringify(sealed), processExecutionBinding: options.processExecutionBinding,
      kind: "provider", timeoutMs: 60000, maxBuffer: 4096,
      providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
      providerAttemptContext: context, promptProcessIdentity: admission.processExecutionIdentity.toJSON(),
      onProcessExecutionStop: (stop) => admission.observeProcessStop(stop, context) });
    admission.settle();
    return result.stdout;
  } };
  for (let index = 0; index < 3 && providerCalls === 0; index++) {
    const manager = value.reload();
    const dispatch = new RunDispatchCommand({ agent, maxDispatches: 1 });
    dispatch.container = dispatchContainer({ root, flowManager: manager, agent });
    const result = await dispatch.execute({ ...value.context(manager),
      expectBinding: FlowTargetBinding.captureContext(value.context(manager)).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch" });
    assert.equal(result.errors[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify({ result, guardedChanges }));
  }
  assert.equal(providerCalls, 1);
  const completed = value.reload();
  const savedRecovery = completed.readArtifact({ specId, logicalKey: "execution.recovery",
    parameters: receipt.targetContract.parameters, consumerNodeId: "system" });
  assert.equal(JSON.parse(savedRecovery.bytes).id, receipt.id);
  const claimedGenerations = completed.activityLedger(specId).filter((activity) =>
    activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "claimed")
    .map((activity) => activity.result.draftSettlementReceipt.executionLifecycle.binding.executionGeneration);
  assert.deepEqual(claimedGenerations, [0, 1]);
  assert.equal(completed.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract, currentAttempt: false }).budget.providerCallCount, 2);
  assert.deepEqual(bytesUnder(request.directory), sourceCapability);
  await consumeCoverage(t, value, repairedGoal);
});

test("a replacement checkpoint refuses an unrelated canonical publication before claiming or starting its provider", async (t) => {
  const value = conditionalFixture(t);
  await closeStoppedRuntime(value);
  const manager = value.reload();
  const receipt = await recoverArtifact(value, manager);
  manager.publishArtifacts({ specId: value.specId, nodeId: "draft-gate-repair", artifactWrites: [{
    logicalKey: "draft.gate.repair", mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify({ version: 1, report: { version: 1, summary: "Unrelated publication", results: [] } })),
  }] });
  const fresh = value.reload();
  const before = canonicalSnapshot(value, fresh);
  const targetBudget = fresh.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget;
  const agent = { call: () => assert.fail("an unrelated canonical publication cannot authorize a replacement provider") };
  const dispatch = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatch.container = dispatchContainer({ root: value.root, flowManager: fresh, agent });
  const result = await dispatch.execute({ ...value.context(fresh),
    expectBinding: FlowTargetBinding.captureContext(value.context(fresh)).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(result.errors[0]?.code, "FLOW_DISPATCH_REPOSITORY_FINGERPRINT_FAILED", JSON.stringify(result));
  const stopped = value.reload();
  assert.deepEqual(canonicalSnapshot(value, stopped), before);
  assert.deepEqual(stopped.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget, targetBudget);
  assert.equal(stopped.draftStepExecutionState({ binding: value.binding(stopped) }).lifecycle.phase, "checkpoint");
});

test("recovery request planning refuses an existing replacement capability without changing canonical authority", (t) => {
  const value = conditionalFixture(t);
  const before = canonicalSnapshot(value, value.manager);
  const invocationId = "preexisting-replacement-capability";
  const sourceRequest = new WorkerArtifactHandoffCoordinator().storedArtifactExecutionRequest({
    ctx: value.context(value.manager), state: value.manager.loadReadOnly(value.specId),
    executionContract: value.request.executionContract });
  const planned = sourceRequest.withRecoveryInvocation(invocationId);
  assert.equal(value.request.withRecoveryInvocation(invocationId).requestDigest, planned.requestDigest,
    "the live typed invocation and its canonical readback plan the same replacement request");
  fs.mkdirSync(planned.directory, { recursive: true });
  fs.writeFileSync(path.join(planned.directory, "untrusted.json"), "{}\n");
  assert.throws(() => sourceRequest.withRecoveryInvocation(invocationId),
    (error) => error instanceof FlowExecutionContractRefusal && error.message.includes("already exists before authorization"));
  assert.throws(() => value.request.withRecoveryInvocation(invocationId),
    (error) => error instanceof FlowExecutionContractRefusal && error.message.includes("already exists before authorization"));
  assert.deepEqual(canonicalSnapshot(value, value.reload()), before);
});

test("before saving a replacement, a canonical append failure retains the claim and permits one later recovery", async (t) => {
  const value = conditionalFixture(t);
  await closeStoppedRuntime(value);
  const before = canonicalSnapshot(value, value.manager);
  const failure = new Error("Interrupted before artifact recovery Activity append");
  let interrupted = false;
  const failing = value.reload({ versionStoreFaultInjector({ phase, activity }) {
    if (phase === "activity-ready-to-append" && activity.nodeId === "draft-gate-repair") {
      interrupted = true;
      throw failure;
    }
  } });
  await assert.rejects(recoverArtifact(value, failing),
    (error) => error === failure);
  assert.equal(interrupted, true, "the real recovery Store transaction must reach its append boundary");
  const fresh = value.reload();
  assert.deepEqual(canonicalSnapshot(value, fresh), before);
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
  assert.equal(frontier.recovery, null);
  assert.equal(frontier.executionContract.id, value.request.executionContract.id);
  assert.equal(fresh.draftStepExecutionState({ binding: value.binding(fresh) }).lifecycle.phase, "claimed");
  const recovered = await recoverArtifact(value, fresh);
  const saved = value.reload();
  assert.equal(saved.artifactWorkerExecutionState({ binding: value.binding(saved) }).recovery.id, recovered.id);
  assert.equal(saved.artifactWorkerExecutionState({ binding: value.binding(saved) }).contracts.length, 2);
  assert.equal(saved.draftStepExecutionState({ binding: value.binding(saved) }).lifecycle.executionGeneration, 1);
  assert.deepEqual(saved.readStoredPromptExecutionEpisode({ executionContract: recovered.targetContract }).budget, before.budget);
});

test("after saving a replacement, response loss rereads the same authorization and owner checkpoint", async (t) => {
  const value = conditionalFixture(t);
  await closeStoppedRuntime(value);
  const before = canonicalSnapshot(value, value.manager);
  const failure = new Error("Artifact recovery save response was lost after canonical commit");
  const saving = value.reload();
  const originalSave = saving.saveArtifactWorkerRecovery;
  let committedReceipt = null;
  t.mock.method(saving, "saveArtifactWorkerRecovery", function (input) {
    committedReceipt = originalSave.call(this, input);
    throw failure;
  });
  await assert.rejects(recoverArtifact(value, saving),
    (error) => error === failure);
  assert.notEqual(committedReceipt, null, "response loss happens only after the real save returns its durable receipt");
  const fresh = value.reload();
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
  const checkpoint = fresh.draftStepExecutionState({ binding: value.binding(fresh) });
  assert.equal(frontier.recovery.id, committedReceipt.id);
  assert.equal(frontier.contracts.length, 2);
  assert.equal(checkpoint.lifecycle.phase, "checkpoint");
  assert.equal(checkpoint.lifecycle.executionGeneration, committedReceipt.targetGeneration);
  assert.deepEqual(bytesUnder(value.request.directory), before.sourceCapability);
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: committedReceipt.targetContract }).budget, before.budget);
  const after = canonicalSnapshot(value, fresh);
  const replay = await recoverArtifact(value, fresh);
  assert.equal(replay.id, committedReceipt.id);
  assert.deepEqual(canonicalSnapshot(value, value.reload()), after);
});

test("an unstarted replacement reservation requires durable reconciliation and fresh selection binds its exact pending marker", async (t) => {
  const value = conditionalFixture(t);
  await closeStoppedRuntime(value);
  const manager = value.reload();
  const receipt = await recoverArtifact(value, manager);
  const request = claimReplacement(value, manager, receipt);
  const processBinding = FlowProcessExecutionBinding.forContract(receipt.targetContract);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, executionRoot: value.root,
    runId: request.runId, specId: value.specId, binding: processBinding });
  value.runtimes.push(runtime);
  const failure = new Error("Interrupted after provider reservation and before physical reservation");
  try {
    await assert.rejects(runtime.enter(() => executeArtifactWorkerPrompt({ flowManager: manager, request,
      prompt: "Preserve the selected repair input", callOptions: { commandId: "flow.worker", processExecutionBinding: processBinding },
      agent: { async call(_prompt, options) {
        options.providerCallAdmission.claim();
        await options.providerCallAdmission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1,
          providerKey: "test", profileKey: "reserved", attemptId: "reserved-provider-attempt", logicalInvocationId: "reserved-logical-call" });
        throw failure;
      } },
    })), (error) => error instanceof PromptBatchExecutionIncompleteFailure && error.cause === failure);
  } finally { await runtime.close(); }
  const before = value.reload();
  const reserved = before.artifactWorkerExecutionState({ binding: value.binding(before) });
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.reservationContinuation, null);
  const budget = before.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget;
  assert.equal(budget.providerCallCount, 2, "the stopped source and replacement retain their two provider reservations");
  const required = selectWorkerExecutionAdmission({ ctx: value.context(before), stepId: "draft-gate-repair" });
  assert.ok(required.artifactContinuation instanceof ArtifactWorkerRecoveryRequired);
  const directive = projectWorkerExecutionAdmission(required);
  assert.equal(directive.actionId, "RECOVER_ARTIFACT_EXECUTION");
  assert.equal(directive.command.subcommand, "recover-artifact-execution");

  const replay = await recoverArtifact(value, before);
  assert.equal(replay.id, receipt.id);
  const fresh = value.reload();
  const reconciled = fresh.artifactWorkerExecutionState({ binding: value.binding(fresh) });
  const marker = reconciled.reservationContinuation;
  assert.ok(marker instanceof PromptExecutionReservationContinuation);
  assert.equal(marker.pending, true);
  assert.equal(marker.authorizationId, receipt.id);
  assert.equal(marker.executionContractId, receipt.targetContractId);
  assert.equal(reconciled.contracts.length, 2);
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget, budget);
  const selected = selectWorkerExecutionAdmission({ ctx: value.context(fresh), stepId: "draft-gate-repair" });
  assert.ok(selected.artifactContinuation instanceof ArtifactWorkerRecoveryAuthorized);
  assert.equal(selected.artifactContinuation.reservationContinuation.id, marker.id);
  assert.equal(projectWorkerExecutionAdmission(selected).kind, "execute_step");

  // The comparator is pure: give it independently typed observations while
  // retaining the same real canonical Attempt, owner checkpoint and authority.
  const selectionFor = (reservationContinuation) => {
    const coordinator = new WorkerArtifactHandoffCoordinator();
    return selectWorkerExecutionAdmission({ ctx: value.context(fresh), stepId: "draft-gate-repair", handoffCoordinator: {
      readDraftWorkerExecutionContinuation: (input) => coordinator.readDraftWorkerExecutionContinuation(input),
      readArtifactWorkerExecutionContinuation: () => new ArtifactWorkerExecutionContinuationFacts({
        frontier: new ArtifactWorkerExecutionFrontier({ contracts: reconciled.contracts,
          recovery: reconciled.recovery, status: "reserved", reservationContinuation }),
        physical: "unstarted", response: "unsealed",
      }),
    } });
  };
  const restored = PromptExecutionReservationContinuation.fromJSON(JSON.parse(JSON.stringify(marker)));
  assert.equal(assertCurrentWorkerExecutionSelection(selected, selectionFor(restored)).artifactContinuation.reservationContinuation.id, marker.id);
  const nextIdentity = new PromptProviderProcessIdentity({ ...marker.previousClaim.processIdentity,
    providerAttemptId: "replacement-provider-attempt", logicalInvocationId: "replacement-logical-call" });
  const consumed = marker.consume({ ...marker.previousClaim, processIdentity: nextIdentity.toJSON() });
  assert.equal(consumed.id, marker.id, "consumption keeps the same authorization identity");
  assert.equal(consumed.pending, false);
  assert.throws(() => assertCurrentWorkerExecutionSelection(selected, selectionFor(consumed)),
    { code: "FLOW_WORKER_EXECUTION_SELECTION_CHANGED" });

  const unused = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, executionRoot: value.root,
    runId: request.runId, specId: value.specId, binding: processBinding });
  value.runtimes.push(unused);
  await unused.close();
  let otherMarker;
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, executionRoot: value.root,
    binding: processBinding }, (evidence) => {
    const identity = marker.previousClaim.processIdentity;
    const proof = evidence.forInvocation({ providerAttemptId: identity.providerAttemptId, logicalInvocationId: identity.logicalInvocationId });
    otherMarker = new PromptExecutionReservationContinuation({ authorizationId: receipt.id,
      executionContractId: receipt.targetContractId, previousClaim: marker.previousClaim,
      physicalEvidence: proof.toJSON(), calls: [] });
  });
  assert.notEqual(otherMarker.id, marker.id);
  assert.equal(otherMarker.pending, true);
  assert.throws(() => assertCurrentWorkerExecutionSelection(selected, selectionFor(otherMarker)),
    { code: "FLOW_WORKER_EXECUTION_SELECTION_CHANGED" });
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: receipt.targetContract }).budget, budget);
});
