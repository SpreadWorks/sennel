import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import SetDraftAnswerCommand from "../../../src/flow/lib/set-draft-answer.js";
import SetApprovalCommand from "../../../src/flow/lib/set-approval.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { dispatchContainer, installGateProviderFake, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const priorQuestions = [
  { state: "AnsweredQuestion", id: "q1", question: "Keep the existing public contract?",
    category: "user-visible-behavior", revision: 1,
    provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
    answer: "Yes, keep it.", why: "The request requires compatibility.",
    considered: "Replacing the contract was rejected." },
  { state: "ResolvedByExistingInformation", id: "q2", question: "Which repository rule applies?",
    category: "user-visible-behavior", revision: 0,
    provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
    resolution: "The saved project rule already answers it." },
];
const newQuestion = { state: "CandidateQuestion", id: "q3",
  question: "Which validation target should this requirement name?",
  category: "user-visible-behavior", revision: 0,
  provenance: { producer: "spec-gate-draft-return-scenario" }, evidenceDigest: "a".repeat(64) };

test("Spec Gate decision gap returns through Draft answer to regenerated Spec Gate approval", async () => {
  const taskTestStrategy = "Verify the chosen public API response through the focused scenario.";
  const value = await createSpecGateRepairScenario({ taskTestStrategy, beforeGate({ specId, flowManager, flow }) {
    flow.activate("draft");
    flowManager.publishArtifacts({ specId, nodeId: "draft", artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(workerArtifactJson(canonicalDraftDocument({
        goal: "Keep prior answers while selecting a validation target.", questions: priorQuestions,
      }))),
    }] });
    flow.settle("draft");
  } });
  let gateAgentLookup;
  let reviewProcess;
  try {
    initGitRepo(value.root);
    fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
    commitAll(value.root, "Create isolated Draft return phase repository");
    const repairRequest = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const repairContext = repairRequest.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    fs.writeFileSync(repairRequest.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair-draft-return",
      baseRevision: repairContext.baseRevision, unitId: repairContext.selections[0].unit.id,
      decision: newQuestion.question,
      evidence: "The saved Draft answers and Issue do not identify the validation target.",
      unresolvedBecause: "A user choice is required to name one target.",
    }));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request: repairRequest,
      prompt: JSON.stringify(repairRequest.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: repairRequest.requestPath,
      invocationId: repairRequest.dispatchInvocationId });
    await SpecGateRepairService.prepare({ ctx: value.ctx, request: repairRequest,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const resumed = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const repairService = await SpecGateRepairService.resumePublished({ ctx: { ...value.ctx,
      flowManager: resumed }, state: resumed.canonicalState(value.specId),
      handoffCoordinator: value.coordinator });
    const repairResult = await new StepFactory().provide(SpecGateRepairService, repairService)
      .create(SpecGateRepairStep).execute();
    assert.equal(repairResult.kind, "spec-gate-repair-draft-return-required");
    assert.equal(resumed.canonicalState(value.specId).current.at(-1), "draft");

    const probeCoordinator = new WorkerArtifactHandoffCoordinator();
    for (const [index, questions, expected] of [
      [0, [priorQuestions[1], newQuestion], /changed a prior resolved question/],
      [1, [...priorQuestions, { ...newQuestion, question: priorQuestions[0].question }], /duplicate question/],
    ]) {
      const invalid = probeCoordinator.createRequest({ ctx: { ...value.ctx, flowManager: resumed },
        state: resumed.load(value.specId), invocation: { id: `invalid-draft-${index}`,
          target: { digest: "c".repeat(64) },
          action: { digest: "d".repeat(64), nextAction: { step: "draft" } } } });
      fs.writeFileSync(invalid.payloadPath("draft.json"), workerArtifactJson(
        canonicalDraftDocument({ goal: "Keep the old decisions.", questions })));
      sealWorkerArtifactHandoff({ requestPath: invalid.requestPath,
        invocationId: invalid.dispatchInvocationId });
      assert.throws(() => probeCoordinator.prepareDraftWorker({ ctx: { ...value.ctx,
        flowManager: resumed }, request: invalid }), expected);
      fs.rmSync(invalid.directory, { recursive: true });
    }

    gateAgentLookup = installGateProviderFake((_prompt, options) => {
      const observation = options.jsonSchema?.properties?.observations?.items;
      const requirementIds = observation?.properties?.requirementId?.enum ?? [];
      const sourceRefs = observation?.properties?.sourceRef?.enum ?? [];
      return JSON.stringify({ observations: requirementIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
        requirementId, sourceRef, support: [], contradictions: [], unresolved: [],
      }))) });
    });
    const originalSpawnSync = childProcess.spawnSync;
    reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
        return originalSpawnSync(command, args, options);
      }
      const step = resumed.canonicalState(value.specId).current.at(-1);
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      if (step === "spec-review") {
        const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
        const canonical = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
        const delta = new SpecReviewDelta({ version: 2, stage: "spec-review",
          identity: canonical.identity.toJSON(), baseReviewDigest: canonical.digest,
          findings: [], scopeExpansions: [], operations: [] });
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"),
          workerArtifactJson(delta.toJSON()));
      } else {
        assert.ok(["draft-questions-review", "draft-coverage-review"].includes(step));
        const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
        fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
          version: 2, phase: step === "draft-questions-review" ? "draft-questions" : "draft-coverage",
          sourceDraft: "draft.json", sourceDraftRevision: source.revision,
          generatedAt: "2026-09-23T00:00:00.000Z", verdict: "PASS",
          summary: "The answered Draft is complete.", blockingFindings: [], advisoryFindings: [], repairTargets: [],
        }));
      }
      work.seal();
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    syncBuiltinESMExports();
    let draftCalls = 0;
    let specCalls = 0;
    const agent = { async call(_prompt, options) {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (request.stepId === "draft") {
        draftCalls += 1;
        const reopen = request.contextSnapshot.entries.find((entry) => entry.kind === "reopen").document;
        assert.equal(reopen.reason, newQuestion.question);
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(
          canonicalDraftDocument({ goal: "Select the validation target.",
            questions: [...priorQuestions, newQuestion] })));
      } else if (request.stepId === "draft-refine") {
        const draft = resumed.readArtifact({ specId: value.specId, logicalKey: "draft",
          consumerNodeId: "draft-refine" });
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), draft.bytes);
      } else if (request.stepId === "spec") {
        specCalls += 1;
        const draft = resumed.readArtifact({ specId: value.specId, logicalKey: "draft",
          consumerNodeId: "spec" });
        const questions = JSON.parse(draft.bytes.toString("utf8")).questionLedger.questions;
        assert.deepEqual(questions.slice(0, 2), priorQuestions);
        assert.equal(questions[2].state, "AnsweredQuestion");
        const spec = validWorkerHandoffTaskSpec();
        spec.requirements[0].desc = "Validate the target selected in the answered Draft.";
        spec.tasks = spec.tasks.map((task) => ({ ...task, test_strategy: taskTestStrategy }));
        fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson(spec));
      } else if (request.stepId === "spec-triage" || request.stepId === "spec-repair") {
        const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
        fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
          version: 2, stage: request.stepId, identity: review.identity.toJSON(),
          baseReviewDigest: review.digest, findings: [], operations: [],
          ...(request.stepId === "spec-repair" ? { scopeExpansions: [] } : {}),
        }));
      } else throw new Error(`Unexpected worker after Draft return: ${request.stepId}`);
      sealWorkerArtifactHandoff({ requestPath,
        invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
    } };
    const dispatch = async (maxDispatches = 64) => {
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: resumed, agent });
      const flowState = resumed.loadReadOnly(value.specId);
      return dispatcher.execute({ root: value.root, mainRoot: value.root,
        executionRoot: value.root, specId: value.specId, flowManager: resumed, flowState,
        expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root,
          authorityRoot: value.root }).serialize(), _envelopeType: "run", _envelopeKey: "dispatch" });
    };
    const first = await dispatch();
    assert.equal(draftCalls, 1, JSON.stringify(first));
    const next = await new GetNextActionCommand().execute({ root: value.root,
      mainRoot: value.root, executionRoot: value.root, specId: value.specId,
      flowManager: resumed, flowState: resumed.loadReadOnly(value.specId) });
    assert.equal(next.directive.kind, "await_draft_question", JSON.stringify(first));
    assert.equal(next.directive.questionId, "q3");
    const answer = new SetDraftAnswerCommand().execute({ root: value.root,
      mainRoot: value.root, executionRoot: value.root, specId: value.specId,
      flowManager: resumed, flowState: resumed.loadReadOnly(value.specId),
      questionId: "q3", questionRevision: next.directive.questionRevision,
      answer: "Validate the public API response.",
      why: "That is the user selected behavior." });
    assert.equal(answer.status, "answered");
    const second = await dispatch();
    assert.equal(specCalls, 1, JSON.stringify(second.errors ?? []));
    assert.equal(resumed.canonicalState(value.specId).current.at(-1), "approval",
      JSON.stringify(second.errors ?? second.data?.dispatch ?? {}));
    const approved = new SetApprovalCommand().execute({ root: value.root,
      mainRoot: value.root, executionRoot: value.root, specId: value.specId,
      flowManager: resumed, flowState: resumed.loadReadOnly(value.specId),
      approved: true, confirmedAt: "2026-09-23T00:00:00.000Z",
      notes: "The regenerated Spec passed Gate after the Draft answer." });
    assert.ok(approved);
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const spec = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "approval" }).bytes.toString("utf8"));
    assert.equal(spec.requirements[0].desc, "Validate the target selected in the answered Draft.");
    assert.equal(spec.user_approval.confirmed_at, "2026-09-23T00:00:00.000Z");
  } finally {
    reviewProcess?.mock.restore();
    syncBuiltinESMExports();
    gateAgentLookup?.mock.restore();
    removeTmpDir(value.root);
  }
});
