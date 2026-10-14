import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { implementationFinding } from "../../support/impl-phase-scenario.js";
import { readAcceptanceExecutionContinuation } from "../../../src/flow/lib/acceptance-execution-session.js";
import { executionValueDigest } from "../../../src/flow/lib/flow-execution-contract.js";
import { CanonicalPromptExecutionEpisode } from "../../../src/flow/lib/canonical-prompt-execution.js";
import { PromptExecutionJournalSnapshot } from "../../../src/lib/prompt-execution-journal.js";
import { canonicalPlanGateRepairForTarget } from "../../../src/flow/lib/plan-gate-repair.js";
import { AcceptanceEvidenceExecutionPlan } from "../../../src/flow/lib/run-acceptance-review.js";
import { PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";
import { stableArtifactViewJson } from "../../../src/flow/lib/artifact-view-fingerprint.js";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { currentRuntimePackage } from "../../../src/lib/runtime-package.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import { registerAcceptanceExecutionSettlementCases } from "./acceptance-execution-settlement.contract.js";

function episode(scenario) {
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
  const executionContract = scenario.manager.readStoredExecutionContract({ binding: saved.result.evidence.identity,
    generation: saved.result.evidence.executionGeneration });
  return scenario.manager.readPromptExecutionEpisode({ executionContract });
}

function publishedEpisode(scenario, executionContract) {
  const prefix = `artifacts/executions/${executionContract.episodeId}/${executionContract.generation}/progress/`;
  const scopes = scenario.manager.artifactCatalog(scenario.specId).artifacts
    .filter((descriptor) => descriptor.logicalKey === "prompt.execution.progress" && descriptor.relativePath.startsWith(prefix))
    .map((descriptor) => {
      const scopeId = path.basename(descriptor.relativePath, ".json");
      const artifact = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "prompt.execution.progress",
        parameters: { ...executionContract.parameters, scopeId }, consumerNodeId: "final-regression" });
      return PromptExecutionJournalSnapshot.fromJSON(JSON.parse(artifact.bytes.toString("utf8")).record.snapshot);
    });
  const budget = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "prompt.execution.budget",
    parameters: { budgetId: executionContract.budgetId }, consumerNodeId: "final-regression" });
  return new CanonicalPromptExecutionEpisode({ executionContract, scopes, budget: JSON.parse(budget.bytes.toString("utf8")).budget });
}

function interruptSave(scenario, { event, after = false, stage = null }) {
  const manager = scenario.manager;
  const original = manager.savePromptExecutionProgress;
  let interrupted = false;
  manager.savePromptExecutionProgress = function (input) {
    if (!interrupted && input.record.event === event && (stage === null || input.scope.stage === stage)) {
      interrupted = true;
      if (after) original.call(this, input);
      const error = new Error(`interrupted ${after ? "after" : "before"} ${event} persistence`);
      error.code = "TEST_EXECUTION_INTERRUPTED";
      throw error;
    }
    return original.call(this, input);
  };
  return () => { manager.savePromptExecutionProgress = original; };
}

function assertUnpublished(scenario, attempt) {
  assert.equal(scenario.current(), "acceptance-review");
  assert.equal(scenario.state().attempt.id, attempt.id);
  assert.equal(scenario.state().attempt.consumption.semantic, attempt.consumption.semantic);
  assert.equal(scenario.state().findNode("final-regression").status, "pending");
  assert.equal(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "acceptance.review",
    consumerNodeId: "final-regression", optional: true }), null);
}

describe("Acceptance durable production execution", () => {
  let seed;
  const seedCleanups = [];
  after(() => { for (const cleanup of seedCleanups.reverse()) cleanup(); });
  before(async () => { seed = await AcceptancePhaseScenario.seed({ mock, after(cleanup) { seedCleanups.push(cleanup); } }); });
  registerAcceptanceExecutionSettlementCases(() => seed);

  for (const event of ["claimed", "response", "validated"]) {
    const boundary = event === "claimed" ? "refused physical claim" : `saved ${event}`;
    it(`continues after ${boundary} boundary without a new Attempt or duplicate completed provider call`, async (t) => {
      const scenario = AcceptancePhaseScenario.fromSeed(t, seed);
      await scenario.advanceTo("acceptance-review");
      const attempt = scenario.state().attempt;
      const restore = interruptSave(scenario, { event, after: event !== "claimed" });
      t.after(restore);
      const interrupted = await scenario.runRegistered("acceptance-review");
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.errors[0].code, "TEST_EXECUTION_INTERRUPTED");
      restore();
      assertUnpublished(scenario, attempt);
      const beforeReload = episode(scenario);
      assert.equal(beforeReload.budget.providerCallCount, event === "claimed" ? 0 : 1);
      const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
      const claimId = saved.receipt.id;
      scenario.reload();
      const continuation = readAcceptanceExecutionContinuation({ flowManager: scenario.manager, state: scenario.state(),
        saved: scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" }) });
      assert.equal(continuation.canResume, true);
      const action = await scenario.next();
      assert.ok(!["blocked", "await_user_decision"].includes(action.directive?.kind));
      const result = await scenario.runRegistered("acceptance-review");
      assert.equal(result.result, "ok", JSON.stringify(result));
      assert.equal(result.verdict, "pass");
      assert.equal(scenario.acceptanceProviderCalls.length, 1);
      assert.equal(scenario.acceptanceProviderCalls[0].claim.id, claimId);
      const review = scenario.commandArtifact("acceptance.review", "final-regression");
      assert.equal(review.payload.verdict, "pass");
      assert.equal(review.attempt, attempt.sequence);
      assert.ok(result.settlementReceipt.id);
      assert.equal(scenario.state().findNode("acceptance-review").status, "done");
      assert.equal(scenario.state().findNode("acceptance-decision").status, "skipped");
    });
  }

  it("keeps a provider response lost before durable save uncertain across manager reload and direct/dispatch admission", async (t) => {
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed);
    await scenario.advanceTo("acceptance-review");
    const attempt = scenario.state().attempt;
    const restore = interruptSave(scenario, { event: "response" }); t.after(restore);
    const interrupted = await scenario.runRegistered("acceptance-review");
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.errors[0].code, "TEST_EXECUTION_INTERRUPTED");
    restore();
    assert.equal(scenario.acceptanceProviderCalls.length, 1);
    assertUnpublished(scenario, attempt);
    const savedEpisode = episode(scenario);
    assert.equal(savedEpisode.scopes[0].batches[0].claim.transportOrdinal, 1);
    const before = scenario.reload().snapshot();
    const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
    const continuation = readAcceptanceExecutionContinuation({ flowManager: scenario.manager, state: scenario.state(), saved });
    assert.equal(continuation.canResume, false);
    assert.equal(continuation.code, "PROMPT_EXECUTION_UNCERTAIN");
    assert.equal(continuation.uncertainCalls.length, 1);
    const repeated = readAcceptanceExecutionContinuation({ flowManager: scenario.manager, state: scenario.state(), saved });
    assert.deepEqual(repeated.uncertainCalls, continuation.uncertainCalls);
    const action = await scenario.next();
    assert.ok(["blocked", "await_user_decision"].includes(action.directive?.kind));
    const denied = await scenario.runRegistered("acceptance-review");
    assert.equal(denied.ok, false);
    await scenario.dispatch(1);
    assert.equal(scenario.acceptanceProviderCalls.length, 1);
    assert.deepEqual(scenario.reload().snapshot(), before);
    assertUnpublished(scenario, attempt);
  });

  it("rejects changed current evidence while preserving the saved raw response and all episode consumption", async (t) => {
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed);
    await scenario.advanceTo("acceptance-review");
    const restore = interruptSave(scenario, { event: "response", after: true }); t.after(restore);
    assert.equal((await scenario.runRegistered("acceptance-review")).ok, false);
    restore();
    const savedEpisode = episode(scenario); const savedDigest = executionValueDigest(savedEpisode.scopes.map((scope) => scope.toJSON()));
    fs.appendFileSync(path.join(scenario.root, "src/implementation.js"), "\n// source changed after saved Acceptance response\n");
    const before = scenario.reload().snapshot();
    const denied = await scenario.runRegistered("acceptance-review");
    assert.equal(denied.ok, false);
    assert.equal(scenario.acceptanceProviderCalls.length, 1);
    assert.deepEqual(scenario.reload().snapshot(), before);
    const heldEpisode = episode(scenario);
    assert.equal(executionValueDigest(heldEpisode.scopes.map((scope) => scope.toJSON())), savedDigest);
    assert.deepEqual(heldEpisode.budget, savedEpisode.budget);
  });

  it("reconstructs a saved map completion and multiple reduction rounds before scoped final using the same fixed episode", async (t) => {
    const reductionCalls = []; let requestLimit = 16_000;
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed, { providerOptions: {
      promptCharacterLimit: () => scenario.current() === "acceptance-review" ? requestLimit : null },
      acceptanceProvider: (prompt, options, active) => {
        const observation = options.jsonSchema?.properties?.observations?.items?.properties;
        if (observation) {
          const ranges = String(prompt).split("## Canonical evidence ranges\n")[1].split("\n").filter(Boolean).map((line) => JSON.parse(line));
          ranges.forEach((range) => active.acceptanceEvidenceRanges.set(range.sourceRef, range));
          const refs = observation.sourceRef.enum;
          const fact = "The transported canonical range supplies acceptance evidence. ".repeat(Math.ceil(12_000 / refs.length / 61));
          return JSON.stringify({ observations: refs.map((sourceRef) => ({ sourceRef, facts: [fact] })) });
        }
        const refs = options.jsonSchema?.properties?.sourceRefs?.items?.enum;
        if (refs) {
          reductionCalls.push([...refs]);
          const previous = episode(active).scopes.filter((scope) => scope.scope.stage === "reduction");
          const round = Math.max(...previous.map((scope) => scope.scope.round), 0);
          return JSON.stringify({ sourceRefs: [...refs], summary: round === 0 ? "Evidence remains bound to its source references. ".repeat(65) : "Bound canonical evidence." });
        }
        return undefined;
      } });
    fs.appendFileSync(path.join(scenario.root, "src/implementation.js"),
      `\n${"// Preserve the required behavior and its independently verified branch.\n".repeat(1_000)}`);
    assert.equal((await scenario.runRegistered("retro")).result, "recovered");
    await scenario.advanceTo("acceptance-review");
    const initialContext = await scenario.observeAcceptanceInput();
    const initialEvidence = stableArtifactViewJson(initialContext.evidence);
    const attempt = scenario.state().attempt;
    const restore = interruptSave(scenario, { event: "validated", after: true, stage: "map" }); t.after(restore);
    const interrupted = await scenario.runRegistered("acceptance-review");
    assert.equal(interrupted.ok, false);
    restore();
    const checkpoint = episode(scenario);
    assert.equal(checkpoint.executionMode, "map-reduce");
    assert.equal(checkpoint.executionLimit.maxRequestCharacters, 16_000);
    const map = checkpoint.scopes.find((scope) => scope.scope.stage === "map");
    assert.ok(map.batches.length > 1);
    assert.equal(map.batches.filter((batch) => batch.completion !== null).length, 1);
    assert.equal(checkpoint.budget.providerCallCount, 1);
    const completedRequest = scenario.acceptanceProviderCalls[0].prompt;
    requestLimit = 20_000;
    scenario.reload();
    const resumedContext = await scenario.observeAcceptanceInput();
    const executionLimit = new PromptExecutionLimit(checkpoint.executionLimit);
    const plans = [initialContext, resumedContext].map((context) => new AcceptanceEvidenceExecutionPlan(context,
      { limit: executionLimit.requestLimit(), executionLimit }).observationPlan);
    const expectedContracts = [];
    const manager = scenario.manager; const readContract = manager.readExecutionContract;
    manager.readExecutionContract = function (input) {
      expectedContracts.push(input.executionContract.toJSON());
      return readContract.call(this, input);
    };
    t.after(() => { manager.readExecutionContract = readContract; });
    const result = await scenario.runRegistered("acceptance-review");
    if (result.result !== "ok") fs.writeFileSync(path.join(scenario.root, "acceptance-map-resume-diagnostic.json"), JSON.stringify({
      initialFingerprint: initialContext.fingerprint, resumedFingerprint: resumedContext.fingerprint,
      initialEvidence, resumedEvidence: stableArtifactViewJson(resumedContext.evidence),
      savedContract: checkpoint.executionContract.toJSON(), expectedContracts, savedPlan: map.plan.toJSON(),
      plans: plans.map((plan) => ({ digest: plan.digest, collectionDigest: plan.collection.digest,
        batches: plan.batches.map((batch) => ({ digest: batch.digest,
          coverage: batch.coverage.map((entry) => entry.toJSON()), schema: batch.request.jsonSchema })) })), result,
    }, null, 2));
    assert.equal(result.result, "ok", JSON.stringify(result));
    assert.equal(result.verdict, "pass");
    assert.equal(scenario.acceptanceProviderCalls.filter((call) => call.prompt === completedRequest).length, 1);
    const contract = checkpoint.executionContract;
    const finalEpisode = publishedEpisode(scenario, contract);
    assert.equal(finalEpisode.executionLimit.maxRequestCharacters, 16_000);
    const rounds = finalEpisode.scopes.filter((scope) => scope.scope.stage === "reduction");
    assert.ok(rounds.length >= 2, "the real reduced context must require multiple production rounds");
    assert.ok(reductionCalls.length >= 2);
    assert.equal(finalEpisode.scopes.find((scope) => scope.scope.stage === "map").batches.every((batch) => batch.completion !== null), true);
    assert.equal(finalEpisode.scopes.find((scope) => scope.scope.stage === "scoped-final").batches.every((batch) => batch.completion !== null), true);
    assert.equal(finalEpisode.budget.providerCallCount, scenario.acceptanceProviderCalls.length);
    const finalBindings = finalEpisode.scopes.find((scope) => scope.scope.stage === "scoped-final").batches.length;
    assert.equal(finalEpisode.budget.synthesisCallCount, finalBindings + rounds.reduce((sum, round) => sum + round.batches.length, 0));
    const completedMap = finalEpisode.scopes.find((scope) => scope.scope.stage === "map");
    const originalRefs = [...new Set(completedMap.batches.flatMap((batch) => batch.completion.response.map((observation) => observation.sourceRef)))].sort();
    assert.ok(originalRefs.length > 1);
    for (const round of rounds) {
      const inherited = [...new Set(round.batches.flatMap((batch) => batch.completion.response.sourceRefs))].sort();
      assert.deepEqual(inherited, originalRefs, "every persisted reduction round must inherit the exact map source references");
    }
    const review = scenario.commandArtifact("acceptance.review", "final-regression");
    assert.equal(review.payload.verdict, "pass");
    assert.equal(review.attempt, attempt.sequence);
  });

  it("continues deferred disposition repair from saved bytes produced after genuine Review exhaustion", async (t) => {
    const options = {
      implReviewResponse: (stage) => ({ blockingFindings: stage === "task-review" ? [implementationFinding({ taskId: "T1" })] : [], nonBlockingImprovements: [] }),
      sourceEffect: (effect, request, active) => {
        if (request.stepId !== "task-impl") return effect;
        const selected = canonicalPlanGateRepairForTarget({ flowManager: active.manager,
          state: active.manager.loadReadOnly(active.specId), targetStepId: `${request.taskId}-impl` });
        if (selected === null) return effect;
        return { ...effect, gateRepair: { version: 1, summary: "Apply the exact selected Gate observations.",
          results: selected.observationRequests.map((entry) => ({ fingerprint: entry.fingerprint.toString(),
            strategy: "Implement the missing mapped branch.", summary: "Updated the canonical mapped source.",
            priorRepairInsufficiency: entry.recurrenceCount === 0 ? null : "The previous strategy omitted the branch.",
            paths: [`src/task-${request.taskId}.js`] })) } };
      },
      gateResponse: (_prompt, options, active) => {
        if (active.current() !== "T1-gate" || !options.jsonSchema.required.includes("evaluations")) return undefined;
        const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
        return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({ guardrail_id, result: "fail",
          reason: "[REQ:R1] The bounded Task correction still omits the required behavior branch." })) });
      },
      acceptanceResponse: (_ordinal, active) => ({ ...acceptanceProviderResponse(active), deferredFindingDispositions: [] }),
      acceptanceProvider: (_prompt, options, active) => {
        if (options.jsonSchema.required.includes("requirementJudgments")) return undefined;
        const ids = options.jsonSchema.properties.deferredFindingDispositions.items.properties.findingId.enum;
        const evidence = active.acceptanceContexts.at(-1).evidence.deferredFindingEvidence;
        return JSON.stringify({ deferredFindingDispositions: ids.map((findingId) => ({ findingId, finalDisposition: "fixed",
          evidenceRefs: [evidence.find((entry) => entry.findingId === findingId).sourceRef] })) });
      },
    };
    const seedRoot = createTmpDir("sennel-acceptance-deferred-fixture-");
    t.after(() => removeTmpDir(seedRoot));
    const seedFile = path.join(seedRoot, "acceptance-deferred-boundary-seed.json");
    const producer = AcceptancePhaseScenario.create(t, options);
    await producer.advanceTo("T1-gate");
    await producer.executeCurrent(); producer.reload();
    await producer.advanceTo("T1-impl");
    await producer.advanceTo("T1-gate");
    await producer.executeCurrent(); producer.reload();
    const producedStrict = await producer.next();
    assert.equal(producedStrict.directive.kind, "await_user_decision");
    assert.deepEqual(producedStrict.directive.actionPrompt.choices.map((entry) => entry.actionId), ["KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING"]);
    const copy = new SeedWorkRoot(producer.root, { prefix: "sennel-acceptance-deferred-boundary-", parent: seedRoot });
    t.after(() => copy.cleanup());
    fs.writeFileSync(seedFile, JSON.stringify({ root: copy.root, specId: producer.specId, frontier: "T1-gate", snapshot: producer.snapshot(),
      runtimeRevision: currentRuntimePackage().revision }, null, 2));
    const boundary = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    const scenario = AcceptancePhaseScenario.fromSeed(t, { ...boundary, options });
    const strict = await scenario.next();
    assert.equal(strict.directive.kind, "await_user_decision");
    assert.ok(strict.directive.actionPrompt.choices.some((entry) => entry.actionId === "ENABLE_NONBLOCKING"));
    activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
      reason: "The simulated user retains the exact exhausted Task Gate findings for final Acceptance disposition." });
    const decision = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
    recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "continue",
      reason: "Continue with the exact failed Task Gate evidence retained for Acceptance.",
      remainingRisk: "Acceptance must decide every retained required-behavior finding.",
      expectEvidenceDigest: decision.evidenceDigest, expectIdentity: decision.identity().toJSON() });
    scenario.reload();
    await scenario.advanceTo("acceptance-review", 128);
    const input = await scenario.observeAcceptanceInput();
    assert.deepEqual(input.mechanicalBlockers, []);
    assert.ok(input.deferredFindings.some((finding) => finding.finalDisposition === "still_open"));
    assert.equal(scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === "T1-review"
      && entry.result?.draftSettlementReceipt?.settlementKind === "target-connection").length, 8,
      "deferred findings must come from both genuine Task rounds, each with four normal Review results");
    const attempt = scenario.state().attempt;
    const restore = interruptSave(scenario, { event: "response", after: true, stage: "deferred-repair" }); t.after(restore);
    const interrupted = await scenario.runRegistered("acceptance-review");
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.errors[0].code, "TEST_EXECUTION_INTERRUPTED");
    restore();
    assertUnpublished(scenario, attempt);
    assert.equal(scenario.acceptanceProviderCalls.length, 2);
    const checkpoint = episode(scenario);
    assert.equal(checkpoint.budget.providerCallCount, 2);
    assert.equal(checkpoint.scopes.find((scope) => scope.scope.stage === "direct").batches[0].completion !== null, true);
    const repair = checkpoint.scopes.find((scope) => scope.scope.stage === "deferred-repair").batches[0];
    assert.equal(repair.claim, null);
    assert.equal(repair.completion, null);
    assert.equal(repair.responses.length, 1);
    scenario.reload();
    const result = await scenario.runRegistered("acceptance-review");
    assert.equal(result.result, "ok", JSON.stringify(result));
    assert.equal(result.verdict, "pass");
    assert.equal(scenario.acceptanceProviderCalls.length, 2, "saved direct and repair responses cannot cause another physical call");
    const completed = publishedEpisode(scenario, checkpoint.executionContract);
    assert.equal(completed.budget.providerCallCount, 2);
    assert.equal(completed.scopes.find((scope) => scope.scope.stage === "deferred-repair").batches[0].completion !== null, true);
    const review = scenario.commandArtifact("acceptance.review", "final-regression");
    assert.equal(review.payload.deferredFindings.length, input.deferredFindings.length);
    assert.equal(review.payload.deferredFindings.every((finding) => finding.finalDisposition === "fixed"), true);
    assert.equal(review.attempt, attempt.sequence);
  });
});
