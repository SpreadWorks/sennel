import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { managedOutputDir } from "../../../src/lib/config.js";
import { FlowTargetExpectation, FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchInvocation, FlowDispatchSession, FlowDispatchTarget, UnapprovedFlowDispatchAuthorization } from "../../../src/flow/lib/dispatch-invocation.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunReopenDraftCommand from "../../../src/flow/lib/run-reopen-draft.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { AgentAuthenticationFailure } from "../../../src/lib/agent-failure.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { DispatchExecutionRepositoryBinding, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { installReviewProcessFake } from "../../support/infrastructure/review-process-fake.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, dispatchFlowCommand, fixtureRepository, installGateProviderFake, requestInput, requestPayloadPath, WorkerRequestIdentityObserver } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { assertCanonicalStepResult } from "../../support/infrastructure/canonical-step-result.js";
import { RequirementTestPhaseScenario } from "../../support/requirement-test-phase-scenario.js";
import { assertCurrentWorkerExecutionSelection, projectWorkerExecutionAdmission, selectWorkerExecutionAdmission } from "../../../src/flow/lib/worker-execution-admission.js";

function assertArtifactIntegrity(artifact) {
  assert.equal(crypto.createHash("sha256").update(artifact.bytes).digest("hex"), artifact.descriptor.hash);
  assert.equal(artifact.bytes.length, artifact.descriptor.size);
}

for (const remainingCandidate of [false, true]) {
  it(remainingCandidate
    ? "selects the next refine generation after a real answer and refuses the preceding answer selection without effects"
    : "completes refine after a real answer without reopening the removed worker and lets Coverage consume the saved answer", async (t) => {
    const questions = (remainingCandidate ? ["q1", "q2"] : ["q1"]).map((id) => ({
      state: "CandidateQuestion", id, category: "user-visible-behavior",
      question: `Which public behavior must ${id} preserve?`, revision: 0,
      provenance: { producer: "draft-worker" }, evidenceDigest: "a".repeat(64),
    }));
    const scenario = RequirementTestPhaseScenario.create(t, {
      entryStep: "draft", autoApprove: false,
      beforeSeal(request) {
        if (request.stepId === "draft") fs.writeFileSync(requestPayloadPath(request, "draft.json"),
          workerArtifactJson(canonicalDraftDocument({ questions })));
      },
    });
    const requestIdentity = new WorkerRequestIdentityObserver(scenario.worker.bind(scenario));
    scenario.worker = requestIdentity.call.bind(requestIdentity);
    await scenario.advanceTo("draft-refine");
    await scenario.dispatch(1);
    scenario.reload();
    const selectedAttempt = scenario.manager.canonicalState(scenario.specId).attempt;
    const firstWorker = scenario.requests.find((request) => request.stepId === "draft-refine");
    assert.ok(firstWorker, "the registered refine worker must publish the Await boundary");
    const oldRequestPath = path.join(path.dirname(path.dirname(requestPayloadPath(firstWorker, "draft.json"))), "request.json");
    assert.equal(fs.existsSync(oldRequestPath), false, "completed Await publication removes its old handoff");
    const firstAwait = scenario.manager.activityLedger(scenario.specId).findLast((entry) =>
      entry.result?.stepResult?.kind === "draft-refine-awaiting-answer");
    assert.equal(firstAwait.attemptId, selectedAttempt.id);
    assert.equal(firstAwait.result.draftSettlementReceipt.awaitQuestion.questionId, "q1");

    const answer = async (questionId) => {
      const next = await scenario.next();
      assert.equal(next.directive.kind, "await_draft_question", JSON.stringify(next));
      assert.equal(next.directive.questionId, questionId);
      const execution = await dispatchFlowCommand({
        container: dispatchContainer({ root: scenario.root, flowManager: scenario.manager, agent: scenario.agent }),
        group: "set", name: "draft-answer",
        argv: [questionId, "--question-revision", String(next.directive.questionRevision),
          "--answer", `Preserve the ${questionId} behavior.`, "--why", "It matches the current request."],
      });
      assert.equal(execution.envelope.ok, true, execution.stdout);
      assert.equal(execution.envelope.data.status, "answered", execution.stdout);
      scenario.reload();
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, selectedAttempt.id);
      assert.deepEqual(scenario.manager.canonicalState(scenario.specId).attempt.consumption.toJSON(),
        selectedAttempt.consumption.toJSON());
      const projected = scenario.manager.draftRefineStepState({ binding: {
        runId: scenario.manager.canonicalState(scenario.specId).runId, specId: scenario.specId,
        stepId: "draft-refine", attempt: selectedAttempt,
      } });
      assert.equal(projected.requiresStepSelection, true);
      assert.equal(projected.executionIdentity(), null);
      const selection = selectWorkerExecutionAdmission({ ctx: scenario.context(), stepId: "draft-refine" });
      assert.equal(selection.continuation, null, "a consumed Await cannot reopen the removed worker handoff");
      assert.equal(projectWorkerExecutionAdmission(selection).kind, "execute_step");
      return selection;
    };
    const precedingAnswerSelection = await answer("q1");
    const afterFirstAnswer = scenario.artifact("draft", undefined, "draft-refine");
    const firstAnswered = JSON.parse(afterFirstAnswer.bytes).questionLedger.questions[0];
    assert.equal(firstAnswered.state, "AnsweredQuestion");
    assert.equal(firstAnswered.answer, "Preserve the q1 behavior.");
    const retainedLedger = scenario.manager.activityLedger(scenario.specId);
    const requestsBeforeReselection = scenario.requests.length;
    const proofCapture = remainingCandidate ? null : t.mock.method(DispatchExecutionRepositoryBinding, "capture");
    await scenario.dispatch(1);
    scenario.reload();

    if (remainingCandidate) {
      const secondWorker = scenario.requests.at(-1);
      assert.equal(scenario.requests.length, requestsBeforeReselection + 1);
      assert.equal(secondWorker.stepId, "draft-refine");
      assert.notEqual(secondWorker.dispatchInvocationId, firstWorker.dispatchInvocationId);
      assert.notEqual(requestIdentity.requestDigest(secondWorker.dispatchInvocationId), requestIdentity.requestDigest(firstWorker.dispatchInvocationId));
      assert.equal(requestInput(secondWorker, "draft.json").digest, afterFirstAnswer.descriptor.hash);
      assert.deepEqual(requestInput(secondWorker, "draft.json").document.questionLedger.questions[0], firstAnswered);
      const reloadedState = scenario.manager.canonicalState(scenario.specId);
      assert.equal(reloadedState.attempt.id, selectedAttempt.id);
      assert.deepEqual(reloadedState.attempt.consumption.toJSON(), selectedAttempt.consumption.toJSON());
      assert.deepEqual(scenario.manager.activityLedger(scenario.specId).slice(0, retainedLedger.length), retainedLedger);
      const claims = scenario.manager.activityLedger(scenario.specId).filter((entry) =>
        entry.nodeId === "draft-refine" && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "claimed");
      assert.deepEqual(claims.map((entry) => entry.result.draftSettlementReceipt.executionLifecycle.binding.executionGeneration), [0, 1]);
      const savedExecution = claims.at(-1).result.draftSettlementReceipt.executionLifecycle;
      assert.equal(savedExecution.binding.inputDigest, secondWorker.inputDigest);
      assert.equal(savedExecution.binding.inputRevision, secondWorker.inputRevision);
      assert.notEqual(savedExecution.binding.inputRevision, claims[0].result.draftSettlementReceipt.executionLifecycle.binding.inputRevision);
      const savedClaim = savedExecution.claim;
      assert.equal(savedClaim.requestDigest, requestIdentity.requestDigest(secondWorker.dispatchInvocationId));
      assert.equal(savedClaim.dispatchInvocationId, secondWorker.dispatchInvocationId);
      const currentAnswerSelection = await answer("q2");
      assert.equal(precedingAnswerSelection.state.attempt.id, currentAnswerSelection.state.attempt.id);
      assert.equal(precedingAnswerSelection.action, currentAnswerSelection.action);
      const beforeRefusal = scenario.snapshot();
      const callsBeforeRefusal = scenario.requests.length;
      assert.throws(() => assertCurrentWorkerExecutionSelection(precedingAnswerSelection, currentAnswerSelection),
        (error) => error.code === "FLOW_WORKER_EXECUTION_SELECTION_CHANGED" && error.data.failureKind === "step-admission");
      assert.equal(scenario.requests.length, callsBeforeRefusal);
      assert.deepEqual(scenario.reload().snapshot(), beforeRefusal);
      await scenario.dispatch(1);
      scenario.reload();
    } else {
      assert.equal(scenario.requests.length, requestsBeforeReselection, "answered refine completes without a provider");
      assert.equal(proofCapture.mock.callCount(), 0, "worker-free completion must not inventory execution proof inputs");
    }

    assert.equal(scenario.current(), "draft-coverage-review");
    const completed = scenario.manager.activityLedger(scenario.specId).findLast((entry) =>
      entry.nodeId === "draft-refine" && entry.result?.stepResult?.kind === "draft-refine-completed");
    assert.equal(completed.attemptId, selectedAttempt.id);
    assert.equal(completed.result.draftSettlementReceipt.targetStepId, "draft-coverage-review");
    const updatedDraft = scenario.artifact("draft", undefined, "draft-coverage-review");
    assertArtifactIntegrity(updatedDraft);
    const updated = JSON.parse(updatedDraft.bytes);
    assert.deepEqual(updated.questionLedger.questions[0], firstAnswered);
    const reviewProcess = scenario.runReviewProcess.bind(scenario);
    let coverageInput;
    scenario.runReviewProcess = (command, argv, options) => {
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      coverageInput = JSON.parse(fs.readFileSync(source.sourcePath, "utf8"));
      assert.deepEqual(coverageInput.questionLedger, updated.questionLedger);
      assert.equal(source.revision.digest, updatedDraft.descriptor.hash);
      return reviewProcess(command, argv, options);
    };
    await scenario.advanceTo("draft-gate");
    scenario.reload();
    assert.deepEqual(coverageInput.questionLedger, updated.questionLedger);
    const coverage = scenario.artifact("draft.coverage.review", undefined, "draft-coverage-triage");
    assertArtifactIntegrity(coverage);
    assert.equal(JSON.parse(coverage.bytes).attempts.at(-1).artifact.payload.sourceDraftRevision.digest,
      updatedDraft.descriptor.hash);
    assert.equal(scenario.current(), "draft-gate");
  });
}

it("reopens Draft and preserves repair Attempt ordinals across an intervening Definition skip", async () => {
  const root = fixtureRepository("draft-reopen-repair-ordinal-");
  let gateProvider;
  let reviewProcess;
  try {
    const specId = "806-draft-reopen-repair-ordinal";
    let manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-draft-reopen-repair-ordinal",
      request: "State how the requested behavior will be verified.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    const guardrailId = "DRAFT-VALIDATION";
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({ guardrails: [{
      id: guardrailId, title: "Explicit validation", body: "State the required validation.",
      meta: { phase: ["draft"], category: "requirements" },
    }] }));
    const initialDraft = canonicalDraftDocument({ goal: "Verify the requested behavior." });
    const repairedValidations = [
      "Run the documented behavioral regression and inspect its result.",
      "For every requested behavior, record representative input and exact expected output and exit status; execute each case and compare all three with the recorded expectation.",
    ];
    const repairs = [];
    const skippedOrdinals = [];
    const workerFailures = [];
    gateProvider = installGateProviderFake((_prompt, options) => {
      const draft = JSON.parse(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate" }).bytes);
      const known = options.jsonSchema.properties.observations.items.properties.requirementRef.enum;
      return JSON.stringify({ observations: known.includes(guardrailId) && !repairedValidations.includes(draft.analysis.validation) ? [{
        failureMode: "missing-validation", requirementRef: guardrailId,
        where: { file: "draft.json", locator: "analysis.validation" },
        observed: "The Draft does not state the behavioral regression check.",
      }] : [], evaluationUnavailable: null });
    });
    reviewProcess = installReviewProcessFake((_command, _args, options) => {
      const state = manager.canonicalState(specId);
      const step = state.current.at(-1);
      const repair = state.findNode("draft-gate-repair");
      if (step === "draft-coverage-review" && repair.status === "skipped") skippedOrdinals.push(repair.attemptSequence);
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
        version: 2, phase: step === "draft-questions-review" ? "draft-questions" : "draft-coverage",
        sourceDraft: "draft.json", sourceDraftRevision: source.revision,
        generatedAt: "2026-09-23T00:00:00.000Z", verdict: "PASS", summary: "No review findings.",
        blockingFindings: [], advisoryFindings: [], repairTargets: [],
      }));
      work.seal();
      return { ok: true, status: 0, signal: null, killed: false, stdout: "", stderr: "" };
    });
    const agent = { async call(_prompt, options) { try {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (request.stepId === "draft") {
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(initialDraft));
      } else if (request.stepId === "draft-gate-repair") {
        // Reconstruct the manager before consuming the newly published Gate.
        manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const state = manager.canonicalState(specId);
        repairs.push({ id: state.attempt.id, sequence: state.attempt.sequence });
        assert.equal(state.current.at(-1), "draft-gate-repair");
        const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" });
        assertArtifactIntegrity(source);
        assert.equal(requestInput(request, "draft.json").digest, source.descriptor.hash);
        assert.deepEqual(requestInput(request, "draft.json").document, initialDraft);
        const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
        assert.equal(recurrence.entries.length, 1);
        const recurring = recurrence.entries[0].recurrenceCount > 0;
        assert.equal(recurring, repairs.length === 2, "The second repair consumes the persisted recurrence of the first observation");
        const replacement = repairedValidations[recurring ? 1 : 0];
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson({
          version: 1, baseRevision: `sha256:${request.inputRevision}`,
          operations: [{ kind: "replace-value", path: "analysis.validation", replacement,
            reason: "State the required regression check." }],
          report: { version: 1, summary: "Made validation explicit.", results: recurrence.entries.map((entry) => ({
            fingerprint: entry.fingerprint,
            strategy: recurring ? "Replace the generic regression reference with an explicit per-behavior input/output/exit-status matrix." : "State the existing regression check.",
            summary: recurring ? "Validation now defines cases and exact assertions for every behavior." : "Validation names the existing regression check.",
            priorRepairInsufficiency: recurring ? "The generic regression reference did not state concrete cases or expected results, and the reopened Draft omitted it." : null,
          })) },
        }));
      } else {
        assert.equal(request.stepId, "spec");
        throw new AgentAuthenticationFailure({ message: "Stop at the Spec provider boundary." });
      }
      sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
    } catch (error) {
      if (!(error instanceof AgentAuthenticationFailure)) workerFailures.push(error);
      throw error;
    } } };
    for (let episode = 0; episode < 2; episode += 1) {
      const dispatcher = new RunDispatchCommand({ agent });
      dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
      const flowState = manager.loadReadOnly(specId);
      const result = await dispatcher.execute({ root, mainRoot: root, executionRoot: root, specId,
        flowManager: manager, flowState,
        expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: root, authorityRoot: root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.deepEqual(workerFailures, [], workerFailures.map((error) => error.stack).join("\n"));
      assert.deepEqual(result.errors.map((entry) => entry.code), ["AGENT_AUTHENTICATION_FAILED"], JSON.stringify({
        errors: result.errors, failure: manager.canonicalState(specId).attempt?.failure,
      }));
      manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      assert.equal(manager.canonicalState(specId).current.at(-1), "spec");
      assert.equal(manager.canonicalState(specId).findNode("draft-gate-repair").status, "done");
      const saved = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" });
      assert.equal(JSON.parse(saved.bytes).analysis.validation, repairedValidations[episode]);
      assertArtifactIntegrity(manager.readArtifact({ specId, logicalKey: "draft.gate", consumerNodeId: "spec" }));
      if (episode === 0) {
        const reopened = await new RunReopenDraftCommand().execute({ root, flowManager: manager,
          flowState: manager.loadReadOnly(specId), reason: "Regenerate the Draft after revisiting the request." });
        assert.equal(reopened.ok, true, JSON.stringify(reopened));
        manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.equal(manager.canonicalState(specId).current.at(-1), "draft");
        assert.equal(manager.canonicalState(specId).findNode("draft-gate-repair").status, "invalidated");
      }
    }
    assert.deepEqual(skippedOrdinals, [1, 3]);
    assert.deepEqual(repairs.map((attempt) => attempt.sequence), [2, 4]);
    assert.notEqual(repairs[0].id, repairs[1].id);
    const introduced = manager.activityLedger(specId).filter((entry) => entry.transition.attempt?.nodeId === "draft-gate-repair");
    assert.deepEqual(introduced.map((entry) => entry.transition.attempt.sequence), [2, 4], "Skipped lifecycle slots have no fabricated worker Attempt");
  } finally {
    gateProvider?.mock.restore();
    reviewProcess?.mock.restore();
    removeTmpDir(root);
  }
});

for (const phase of ["questions", "coverage"]) {
  for (const size of phase === "questions" ? ["inline", "whole-file", "supplied-context"] : ["inline", "whole-file"]) {
    const withContext = size === "supplied-context";
    const name = withContext
      ? "delivers searched codebase evidence to Draft question review and reloads its repair finding for triage"
      : `retains quoted NO_PROPOSALS in ${size} Draft ${phase} findings through publication, reload and triage`;
    it(name, async () => {
      const root = fixtureRepository(`draft-response-${phase}-${size}-`);
      try {
        const specId = `805-${phase}-${size}`;
        let flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const fixture = new CanonicalFlowFixture({
          flowManager, specId, runId: `run-${specId}`,
          request: `Preserve actual findings, including quoted response markers.${size === "whole-file" ? "X".repeat(130_000) : ""}`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate("draft");
        const contextEntry = { file: "src/response-format.js", keywords: ["findings"],
          summary: "The existing CLI preserves structured output when no format is requested." };
        const question = "Should omitted output format preserve the existing structured response?";
        const draft = canonicalDraftDocument({ goal: "Preserve findings.", questions: withContext ? [{
          id: "q1", state: "CandidateQuestion", category: "user-visible-behavior", question,
          revision: 0, provenance: { producer: "draft" }, evidenceDigest: "a".repeat(64),
        }] : [] });
        if (withContext) {
          fs.mkdirSync(managedOutputDir(root), { recursive: true });
          fs.writeFileSync(path.join(managedOutputDir(root), "analysis.json"), workerArtifactJson({
            source: { entries: [contextEntry] },
          }));
        }
        flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(draft)),
        }] });
        fixture.activate("draft-questions-review");
        const responsePath = path.join(root, ".tmp", "review-response.txt");
        const callsPath = path.join(root, ".tmp", "review-calls.jsonl");
        const provider = path.join(root, "review-provider.mjs");
        fs.writeFileSync(provider, [
          'import fs from "node:fs";',
          `const prompt = process.argv.at(-1);`,
          'const file = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];',
          'const input = file ? fs.readFileSync(file, "utf8") : prompt;',
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ file: Boolean(file), input }) + "\\n");`,
          `process.stdout.write(fs.readFileSync(${JSON.stringify(responsePath)}, "utf8"));`,
        ].join("\n"));
        const config = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" }, agent: {
          default: "fixture", workDir: ".tmp", timeout: 30,
          providers: { fixture: { command: process.execPath, args: [provider, "{{PROMPT}}"] } },
        } };
        fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify(config));
        const review = async () => {
          const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager,
            phase: "draft", config, flowState: flowManager.loadReadOnly(specId) };
          const result = await new RunReviewCommand().execute(ctx);
          assert.equal(result.result, "ok", JSON.stringify(result));
          await FLOW_COMMANDS.run.review.post(ctx, result);
          return result;
        };
        if (phase === "coverage") {
          fs.writeFileSync(responsePath, "NO_PROPOSALS");
          await review();
          fixture.activate("draft-coverage-review");
        }
        fs.writeFileSync(callsPath, "");
        const evidence = withContext
          ? `${contextEntry.file}: ${contextEntry.summary}`
          : "The draft incorrectly quotes NO_PROPOSALS while leaving validation unspecified.";
        const findingField = withContext ? "repairTargets" : "blockingFindings";
        const target = withContext ? "q1" : "analysis.validation";
        const fieldPath = withContext ? "questionLedger.questions[0]" : "analysis.validation";
        fs.writeFileSync(responsePath, `### 1. ${withContext ? "Redundant format question" : "Missing validation"}\n**Classification:** ${withContext ? "repair_target" : "blocking"}\n**QA:** ${target}\n**Issue:** ${evidence}\n**Suggestion:** ${withContext ? "Resolve the existing question using the cited codebase evidence." : "State the required validation."}`);
        await review();
        const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(calls.length, phase === "coverage" ? 2 : 1);
        assert.ok(calls.every((call) => call.file === (size === "whole-file")));
        if (withContext) {
          assert.ok(calls[0].input.includes(`- **${contextEntry.file}**: ${contextEntry.summary}`),
            "The external reviewer receives the context produced by the actual analysis search");
          assert.ok(calls[0].input.includes(question));
          assert.match(calls[0].input, /Decision Map is a derived projection/);
        }
        flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const published = flowManager.readArtifact({ specId, logicalKey: `draft.${phase}.review`, consumerNodeId: `draft-${phase}-triage` });
        assertArtifactIntegrity(published);
        const artifact = JSON.parse(published.bytes).attempts.at(-1).artifact.payload;
        assert.equal(artifact.verdict, withContext ? "ADVISORY" : "REJECTED");
        assert.equal(artifact[findingField].length, 1);
        assert.equal(artifact[findingField][0].evidence, evidence);
        assert.equal(artifact[findingField][0].target, target);
        assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, `draft-${phase}-triage`);
        flowManager.beginNextAction(specId);
        const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
        const session = new FlowDispatchSession({ target: new FlowDispatchTarget({
          expectation: new FlowTargetExpectation({ expectRunId: `run-${specId}`, expectSpec: specId }),
        }) });
        const selectedAction = await new GetNextActionCommand().execute({
          ...ctx, flowState: flowManager.loadReadOnly(specId),
        });
        assert.equal(selectedAction.step, `draft-${phase}-triage`);
        assert.match(selectedAction.instructions.content, /workerInstructions.schemaGuidance/);
        const action = session.captureAction(selectedAction, "draft-triage-scenario");
        const invocation = new FlowDispatchInvocation({ session, action,
          authorization: new UnapprovedFlowDispatchAuthorization(action),
        });
        let workerCalls = 0;
        const agent = { async call(prompt, options) {
          workerCalls += 1;
          assert.match(prompt, /Follow workerInstructions in request.json/);
          const workerInvocation = JSON.parse(options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION);
          const workerAction = JSON.parse(fs.readFileSync(workerInvocation.actionFilePath, "utf8"));
          assert.deepEqual(workerAction.instructions, selectedAction.instructions);
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const guidance = request.workerInstructions.schemaGuidance;
          assert.match(guidance, /accepts only these completed-item decisions: apply, invalid, already_resolved, downgraded_to_non_blocking/);
          assert.match(guidance, /requires_user_decision is recognized but rejected by handoff validation/);
          assert.match(guidance, /no successful triage completion or QA route/);
          assert.match(guidance, /Preserve existing QA entries and prior answers/);
          assert.match(guidance, new RegExp(`Accepted triage proceeds to draft-${phase}-repair`));
          const input = requestInput(request, `draft-review-${phase}.json`).document;
          assert.equal(input[findingField][0].evidence, evidence);
          assert.equal(input[findingField][0].target, target);
          fs.writeFileSync(requestPayloadPath(request, `draft-${phase}-triage.json`), workerArtifactJson({
            version: 1, phase: `draft-${phase}-triage`, sourceReview: `draft-review-${phase}.json`,
            summary: "Apply the retained finding.", items: input[findingField].map((finding) => ({
              ...finding, decision: "apply", allowedFieldPaths: [fieldPath], requiredFieldPaths: [fieldPath],
            })),
          }));
          sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          return "sealed";
        } };
        const result = await new RunDispatchCommand().runWorkerAttempt(ctx, invocation, null, agent);
        assert.equal(workerCalls, 1);
        assert.equal(result.error, null);
        assert.equal(result.stepResult.kind, `draft-${phase}-triage-completed`);
        const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, `draft-${phase}-repair`);
      } finally {
        removeTmpDir(root);
      }
    });
  }
}

it("produces Draft through registered Review/Gate commands and reloads its exact findings for Spec and Acceptance", async () => {
  const root = fixtureRepository("draft-artifact-scenario-");
  let gateAgentLookup;
  let reviewProcess;
  try {
    const specId = "803-draft-artifact-scenario";
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager, specId, runId: "run-draft-artifact-scenario",
      request: "Carry distinct Draft observations to their later consumers.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    const sharedGuardrail = "DRAFT-SHARED";
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
      guardrails: [{
        id: sharedGuardrail, title: "Retained Draft behavior",
        body: "The Draft states every required behavior and how it will be checked.",
        meta: { phase: ["draft"], category: "requirements" },
      }],
    }));
    const draftDocument = canonicalDraftDocument({ goal: `Retain both unresolved Draft observations. ${"X".repeat(130000)}` });
    const observations = ["goal", "analysis.validation"].map((locator, index) => ({
      failureMode: `missing-behavior-${index + 1}`, requirementRef: sharedGuardrail,
      where: { file: "draft.json", locator },
      observed: `Required Draft behavior ${index + 1} remains unresolved.`,
    }));
    const requests = [];
    const specRefusalSnapshots = [];
    let activeFlowManager = flowManager;
    let gateCalls = 0;
    let firstGroupReadFailures = 0;
    const gateAttemptIds = [];
    const gateAttempts = new Set();
    const reviewSteps = [];
    const reviewAttempts = [];
    const draftInputPaths = [];
    gateAgentLookup = installGateProviderFake((prompt, options) => {
      gateCalls += 1;
      const state = activeFlowManager.canonicalState(specId);
      assert.equal(state.current.at(-1), "draft-gate");
      gateAttemptIds.push(state.attempt.id);
      gateAttempts.add(state.attempt.id);
      const knownIds = options.jsonSchema?.properties?.observations?.items?.properties?.requirementRef?.enum ?? [];
      const filePath = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
      assert.ok(filePath, "the oversized canonical Draft must be evaluated from a complete file");
      draftInputPaths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), `${JSON.stringify(draftDocument, null, 2)}\n`);
      if (knownIds.includes(sharedGuardrail) && firstGroupReadFailures < 3) {
        firstGroupReadFailures += 1;
        return JSON.stringify({ observations: null, evaluationUnavailable: {
          kind: "file-read-failed", reason: "The first Draft file open failed explicitly.",
        } });
      }
      return JSON.stringify({ observations: knownIds.includes(sharedGuardrail) ? observations : [], evaluationUnavailable: null });
    });
    reviewProcess = installReviewProcessFake((_command, _args, options) => {
      const state = flowManager.canonicalState(specId);
      const step = state.current.at(-1);
      assert.ok(["draft-questions-review", "draft-coverage-review"].includes(step));
      reviewSteps.push(step);
      reviewAttempts.push({ step, attemptId: state.attempt.id });
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
        version: 2, phase: step === "draft-questions-review" ? "draft-questions" : "draft-coverage",
        sourceDraft: "draft.json", sourceDraftRevision: source.revision,
        generatedAt: "2026-09-23T00:00:00.000Z", verdict: "PASS",
        summary: "The Draft review has no findings.",
        blockingFindings: [], advisoryFindings: [], repairTargets: [],
      }));
      work.seal();
      return { ok: true, status: 0, signal: null, killed: false, stdout: "", stderr: "" };
    });
    const agent = {
      async call(_prompt, options) {
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        requests.push(request);
        if (request.stepId === "draft") {
          fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(draftDocument));
        } else if (request.stepId === "spec") {
          const spec = activeFlowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
          specRefusalSnapshots.push({ descriptor: structuredClone(spec.descriptor), bytes: Buffer.from(spec.bytes) });
          // An unavailable external provider is a real refusal boundary. Draft
          // is complete; the production dispatcher must leave Spec unpublished.
          throw new AgentAuthenticationFailure({ message: "Spec provider authentication is unavailable." });
        } else {
          assert.equal(request.stepId, "draft-gate-repair");
          const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
          assert.equal(recurrence.entries.length, 2);
          fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson({
            version: 1, baseRevision: `sha256:${request.inputRevision}`, operations: [],
            report: {
              version: 1, summary: "These unresolved observations require later judgment.",
              results: recurrence.entries.map((entry) => ({
                fingerprint: entry.fingerprint, strategy: "Retain this observation for later judgment.",
                summary: "The Draft is unchanged.",
                priorRepairInsufficiency: entry.recurrenceCount > 0
                  ? "The prior Draft did not resolve this observation." : null,
              })),
            },
          }));
        }
        sealWorkerArtifactHandoff({
          requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
        });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    const makeDispatcher = (manager) => {
      const dispatcher = new RunDispatchCommand({ agent });
      dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
      const flowState = manager.loadReadOnly(specId);
      return {
        dispatcher,
        ctx: {
          root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
          flowState,
          expectBinding: FlowTargetBinding.capture({
            flowState, mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        },
      };
    };
    const firstDispatch = makeDispatcher(flowManager);
    const result = await firstDispatch.dispatcher.execute(firstDispatch.ctx);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((entry) => entry.code), ["AGENT_AUTHENTICATION_FAILED"]);
    assert.equal(result.data.agentFailure.code, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(result.data.retryBudgetConsumed, false);
    assert.deepEqual(requests.map((request) => request.stepId), ["draft", "draft-gate-repair", "spec"]);
    assert.deepEqual(reviewSteps, ["draft-questions-review", "draft-coverage-review", "draft-coverage-review"]);
    assert.equal(gateAttempts.size, 2);
    assert.ok(draftInputPaths.every((filePath) => !fs.existsSync(filePath)));

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    activeFlowManager = reloaded;
    const draft = reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" });
    assertArtifactIntegrity(draft);
    assert.deepEqual(JSON.parse(draft.bytes.toString("utf8")), draftDocument);
    const questionsReview = reloaded.readArtifact({
      specId, logicalKey: "draft.questions.review", consumerNodeId: "draft-questions-triage",
    });
    const coverageReview = reloaded.readArtifact({
      specId, logicalKey: "draft.coverage.review", consumerNodeId: "draft-coverage-triage",
    });
    const gateArtifact = reloaded.readArtifact({ specId, logicalKey: "draft.gate", consumerNodeId: "spec" });
    for (const artifact of [questionsReview, coverageReview, gateArtifact]) assertArtifactIntegrity(artifact);
    const questionsHistory = JSON.parse(questionsReview.bytes.toString("utf8"));
    const coverageHistory = JSON.parse(coverageReview.bytes.toString("utf8"));
    const gateHistory = JSON.parse(gateArtifact.bytes.toString("utf8"));
    assert.deepEqual(questionsHistory.attempts.map((entry) => entry.attempt), [1]);
    assert.deepEqual(coverageHistory.attempts.map((entry) => entry.attempt), [1, 2]);
    assert.deepEqual(questionsHistory.attempts.map((entry) => entry.artifact.payload.sourceDraftRevision.digest), [draft.descriptor.hash]);
    assert.deepEqual(coverageHistory.attempts.map((entry) => entry.artifact.payload.sourceDraftRevision.digest), [draft.descriptor.hash, draft.descriptor.hash]);
    assert.equal(gateHistory.attempts.length, 2);
    assert.equal(firstGroupReadFailures, 3);
    const recoveredEvidence = gateHistory.attempts[0].artifact.payload.artifacts.responseProtocolEvidence;
    const recoveredGroup = recoveredEvidence.groups.find((group) => group.attempts.length === 4);
    assert.ok(recoveredGroup, JSON.stringify(recoveredEvidence));
    assert.deepEqual(recoveredGroup.attempts.map((attempt) => attempt.failureKind),
      ["file-read-failed", "file-read-failed", "file-read-failed", null]);
    assert.equal(recoveredGroup.providerAttemptCount, 4);
    assert.equal(recoveredGroup.responseCallCount, 4);
    assert.equal(recoveredGroup.outcome, "accepted");
    assert.deepEqual(recoveredGroup.attempts.map((attempt) => attempt.providerAttemptCount), [1, 2, 3, 4]);
    const finalGate = gateHistory.attempts.at(-1).artifact.payload;
    const gateObservations = finalGate.artifacts.nextAction.diagnosis.observations;
    assert.deepEqual(gateObservations.map((entry) => [entry.requirementRef, entry.where.locator, entry.observed]),
      observations.map((entry) => [entry.requirementRef, entry.where.locator, entry.observed]));
    const canonical = reloaded.canonicalState(specId);
    for (const [stepId, expectedKind, expectedTarget, attempt] of [
      ["draft-questions-review", "draft-questions-review-passed", "draft-refine", 1],
      ["draft-coverage-review", "draft-coverage-review-passed", "draft-gate", 2],
      ["draft-gate", "draft-gate-carry-forward", "spec", 2],
    ]) {
      const stepResult = canonical.findNode(stepId).result;
      assertCanonicalStepResult(stepResult, { stepId, kind: expectedKind, type: "completed" });
      assert.equal(stepResult.draftSettlementReceipt.targetStepId, expectedTarget);
      assert.equal(stepResult.draftSettlementReceipt.binding.stepId, stepId);
      assert.equal(stepResult.draftSettlementReceipt.binding.attemptSequence, attempt);
      const expectedAttemptId = stepId === "draft-gate"
        ? gateAttemptIds.at(-1)
        : reviewAttempts.filter((entry) => entry.step === stepId).at(-1).attemptId;
      assert.equal(stepResult.draftSettlementReceipt.binding.attemptId, expectedAttemptId);
    }
    const persisted = JSON.parse(reloaded.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    }).bytes.toString("utf8")).entries;
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.map((entry) => entry.sourceFindingId), [sharedGuardrail, sharedGuardrail]);
    assert.equal(new Set(persisted.map((entry) => entry.fingerprint)).size, 2);
    const gate = reloaded.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "draft.gate");
    assert.equal(gate.relativePath, gateArtifact.descriptor.relativePath);
    assert.deepEqual(persisted.map((entry) => [entry.sourceStep, entry.sourceArtifact, entry.finalDisposition]),
      Array.from({ length: 2 }, () => ["draft-gate", gate.relativePath, "still_open"]));
    const activities = reloaded.activityLedger(specId);
    assert.equal(activities.find((entry) => entry.result?.stepResult?.kind === "draft-gate-carry-forward")
      ?.result.draftSettlementReceipt.targetStepId, "spec");
    assert.equal(activities.some((entry) => entry.nodeId === "spec" && entry.result?.stepResult), false);
    const blockers = [];
    const acceptance = new CanonicalAcceptanceArtifactStore({
      flowManager: reloaded, state: reloaded.loadReadOnly(specId),
    }).deferredFindings(blockers);
    assert.deepEqual(blockers, []);
    assert.deepEqual(acceptance.findings.map((entry) => entry.findingId), persisted.map((entry) => entry.findingId));
    assert.deepEqual(acceptance.evidence.map((entry) => entry.sourceFinding.observations[0].observed),
      observations.map((entry) => entry.observed));

    const findingsArtifact = reloaded.readArtifact({ specId, logicalKey: "flow.findings", consumerNodeId: "spec" });
    assertArtifactIntegrity(findingsArtifact);
    const requestCountBeforeRetry = requests.length;
    const reviewCountBeforeRetry = reviewSteps.length;
    const gateCallsBeforeRetry = gateCalls;
    const gateAttemptCountBeforeRetry = gateAttempts.size;
    const activitiesBeforeRetry = reloaded.activityLedger(specId);
    const catalogBeforeRetry = reloaded.artifactCatalog(specId).artifacts
      .map((entry) => structuredClone(entry.toJSON?.() ?? entry));
    const issueLogReadBeforeRetry = reloaded.readArtifact({ specId, logicalKey: "issue.log", consumerNodeId: "spec", optional: true });
    const issueLogBeforeRetry = issueLogReadBeforeRetry === null ? null : {
      descriptor: structuredClone(issueLogReadBeforeRetry.descriptor),
      bytes: Buffer.from(issueLogReadBeforeRetry.bytes),
    };
    const flowStateBeforeRetry = reloaded.readArtifact({ specId, logicalKey: "flow.state", consumerNodeId: "spec" });
    const flowActivitiesBeforeRetry = reloaded.readArtifact({ specId, logicalKey: "flow.activities", consumerNodeId: "spec" });
    const canonicalBeforeRetry = canonical.toJSON();
    assertArtifactIntegrity(flowStateBeforeRetry);
    assertArtifactIntegrity(flowActivitiesBeforeRetry);
    assert.deepEqual(JSON.parse(flowStateBeforeRetry.bytes.toString("utf8")), canonicalBeforeRetry);
    const activityLinesBeforeRetry = flowActivitiesBeforeRetry.bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(activityLinesBeforeRetry, activitiesBeforeRetry);
    const draftBeforeRetry = draft.descriptor;
    const findingsBeforeRetry = findingsArtifact.descriptor;
    const gateBeforeRetry = gateArtifact.descriptor;
    const specBeforeRetry = reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
    const retryDispatch = makeDispatcher(reloaded);
    const retryResult = await retryDispatch.dispatcher.execute(retryDispatch.ctx);
    const retryActivities = reloaded.activityLedger(specId);
    const retryActivityDelta = retryActivities.slice(activitiesBeforeRetry.length);
    const catalogAfterRetry = reloaded.artifactCatalog(specId).artifacts
      .map((entry) => structuredClone(entry.toJSON?.() ?? entry));
    const issueLogAfterRetry = reloaded.readArtifact({ specId, logicalKey: "issue.log", consumerNodeId: "spec", optional: true });
    const flowStateAfterRetry = reloaded.readArtifact({ specId, logicalKey: "flow.state", consumerNodeId: "spec" });
    const flowActivitiesAfterRetry = reloaded.readArtifact({ specId, logicalKey: "flow.activities", consumerNodeId: "spec" });
    assert.equal(retryResult.dispatch.boundary, "blocked");
    assert.equal(retryResult.dispatch.dispatchCount, 0);
    assert.equal(retryResult.nextAction.directive.kind, "blocked");
    assert.deepEqual(requests.slice(requestCountBeforeRetry), []);
    assert.equal(reviewSteps.length, reviewCountBeforeRetry);
    assert.equal(gateCalls, gateCallsBeforeRetry);
    assert.equal(gateAttempts.size, gateAttemptCountBeforeRetry);
    assert.deepEqual(retryActivityDelta, []);
    assert.ok(issueLogBeforeRetry);
    assert.ok(issueLogAfterRetry);
    assertArtifactIntegrity(flowStateAfterRetry);
    assertArtifactIntegrity(flowActivitiesAfterRetry);
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), canonicalBeforeRetry);
    assert.deepEqual(retryActivities, activitiesBeforeRetry);
    assert.deepEqual(JSON.parse(flowStateAfterRetry.bytes.toString("utf8")), canonicalBeforeRetry);
    const activityLinesAfterRetry = flowActivitiesAfterRetry.bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(activityLinesAfterRetry, retryActivities);
    assert.deepEqual(catalogAfterRetry, catalogBeforeRetry);
    assertArtifactIntegrity(issueLogAfterRetry);
    assert.deepEqual(issueLogAfterRetry.descriptor, issueLogBeforeRetry.descriptor);
    assert.deepEqual(issueLogAfterRetry.bytes, issueLogBeforeRetry.bytes);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" }).descriptor, draftBeforeRetry);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "flow.findings", consumerNodeId: "spec" }).descriptor, findingsBeforeRetry);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "draft.gate", consumerNodeId: "spec" }).descriptor, gateBeforeRetry);
    const specAfterRetry = reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
    assert.equal(specAfterRetry.descriptor.hash, specBeforeRetry.descriptor.hash);
    assert.deepEqual(specAfterRetry.bytes, specBeforeRetry.bytes);
    assert.equal(specRefusalSnapshots.length, 1);
    for (const snapshot of specRefusalSnapshots) {
      assert.deepEqual(specAfterRetry.descriptor, snapshot.descriptor);
      assert.deepEqual(specAfterRetry.bytes, snapshot.bytes);
    }

    const request = requests.at(-1);
    const requestDraft = requestInput(request, "draft.json");
    assert.deepEqual(requestDraft.document, draftDocument);
    assert.equal(requestDraft.digest, draft.descriptor.hash);
    const findingsInput = requestInput(request, "flow-findings.json");
    assert.match(findingsInput.digest, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(findingsInput.byteLength) && findingsInput.byteLength > 0);
    const entries = findingsInput.document.entries;
    assert.deepEqual(entries.map(({ sourceObservation, ...entry }) => entry), persisted);
    assert.deepEqual(entries.map((entry) => entry.sourceObservation.observations[0].observed),
      observations.map((entry) => entry.observed));
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "spec");
    const specAfterRefusal = reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
    assert.deepEqual(specAfterRefusal.descriptor, specRefusalSnapshots[0].descriptor);
    assert.deepEqual(specAfterRefusal.bytes, specRefusalSnapshots[0].bytes);
    assert.equal(reloaded.activityLedger(specId).some((entry) => entry.result?.stepResult?.kind === "spec-created"), false);

  } finally {
    reviewProcess?.mock.restore();
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});
