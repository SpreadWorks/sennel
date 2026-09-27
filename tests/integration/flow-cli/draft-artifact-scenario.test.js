import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { it, mock } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { AgentAuthenticationFailure } from "../../../src/lib/agent-failure.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";

function assertArtifactIntegrity(artifact) {
  assert.equal(crypto.createHash("sha256").update(artifact.bytes).digest("hex"), artifact.descriptor.hash);
  assert.equal(artifact.bytes.length, artifact.descriptor.size);
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
      return JSON.stringify({ observations: knownIds.includes(sharedGuardrail) ? observations : [], evaluationUnavailable: null });
    });
    const originalSpawnSync = childProcess.spawnSync;
    reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
        return originalSpawnSync(command, args, options);
      }
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
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    syncBuiltinESMExports();
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
    assert.deepEqual(result.errors.map((entry) => entry.code), ["FLOW_ARTIFACT_HANDOFF_MISSING"]);
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
      assert.equal(stepResult.stepResult.kind, expectedKind);
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
    assert.equal(retryResult.ok, false);
    assert.deepEqual(retryResult.errors.map((entry) => entry.code), ["FLOW_ARTIFACT_HANDOFF_MISSING"]);
    assert.equal(retryResult.data.agentFailure.code, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(retryResult.data.retryBudgetConsumed, false);
    assert.deepEqual(requests.slice(requestCountBeforeRetry).map((request) => request.stepId), ["spec"]);
    assert.equal(reviewSteps.length, reviewCountBeforeRetry);
    assert.equal(gateCalls, gateCallsBeforeRetry);
    assert.equal(gateAttempts.size, gateAttemptCountBeforeRetry);
    assert.equal(retryActivityDelta.length, 2);
    // A real failed Spec provider call records its invocation metric and one issue.log diagnostic.
    assert.deepEqual(retryActivityDelta.map((entry) => [entry.nodeId, entry.type, entry.transition.operation]), [
      ["flow", "metric_recorded", "record_metric"],
      ["spec", "artifacts_published", "publish_artifacts"],
    ]);
    const [retryMetric, retryIssueLogPublication] = retryActivityDelta;
    assert.equal(retryMetric.metric.phase, "spec");
    assert.equal(retryMetric.metric.kind, "agent");
    assert.equal(retryMetric.metric.callCount, 1);
    assert.equal(retryMetric.metric.responseChars, 0);
    assert.equal(retryIssueLogPublication.attemptId, canonicalBeforeRetry.attempt.id);
    assert.equal(retryIssueLogPublication.sequence, canonicalBeforeRetry.attempt.sequence);
    assert.deepEqual(retryIssueLogPublication.references.artifacts, []);
    assert.ok(issueLogBeforeRetry);
    assert.ok(issueLogAfterRetry);
    assertArtifactIntegrity(flowStateAfterRetry);
    assertArtifactIntegrity(flowActivitiesAfterRetry);
    assert.equal(flowStateAfterRetry.descriptor.activityId, retryIssueLogPublication.id);
    assert.equal(flowActivitiesAfterRetry.descriptor.activityId, retryIssueLogPublication.id);
    assert.equal(issueLogAfterRetry.descriptor.activityId, retryIssueLogPublication.id);
    const expectedCanonicalAfterRetry = structuredClone(canonicalBeforeRetry);
    expectedCanonicalAfterRetry.confirmationOrder += 2;
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), expectedCanonicalAfterRetry);
    assert.deepEqual(retryActivities.slice(0, activitiesBeforeRetry.length), activitiesBeforeRetry);
    assert.equal(retryActivities.length, activitiesBeforeRetry.length + 2);
    assert.deepEqual(JSON.parse(flowStateAfterRetry.bytes.toString("utf8")), expectedCanonicalAfterRetry);
    const activityLinesAfterRetry = flowActivitiesAfterRetry.bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(activityLinesAfterRetry, retryActivities);
    assert.deepEqual(activityLinesAfterRetry.slice(0, activitiesBeforeRetry.length), activitiesBeforeRetry);
    const catalogChangedLogicalKeys = catalogAfterRetry.filter((after) => {
      const before = catalogBeforeRetry.find((entry) => entry.relativePath === after.relativePath);
      return before === undefined || JSON.stringify(after) !== JSON.stringify(before);
    }).map((entry) => entry.logicalKey).sort();
    assert.deepEqual(catalogChangedLogicalKeys, ["flow.activities", "flow.state", "issue.log"]);
    assert.equal(catalogAfterRetry.length, catalogBeforeRetry.length);
    assert.deepEqual(catalogAfterRetry.filter((entry) => !["flow.activities", "flow.state", "issue.log"].includes(entry.logicalKey)),
      catalogBeforeRetry.filter((entry) => !["flow.activities", "flow.state", "issue.log"].includes(entry.logicalKey)));
    assertArtifactIntegrity(issueLogAfterRetry);
    assert.notEqual(issueLogAfterRetry.descriptor.hash, issueLogBeforeRetry.descriptor.hash);
    const priorIssueEntries = JSON.parse(issueLogBeforeRetry.bytes.toString("utf8")).entries;
    const retryIssueEntries = JSON.parse(issueLogAfterRetry.bytes.toString("utf8")).entries;
    assert.deepEqual(retryIssueEntries.slice(0, priorIssueEntries.length), priorIssueEntries);
    assert.equal(retryIssueEntries.length, priorIssueEntries.length + 1);
    assert.equal(retryIssueEntries.at(-1).step, "spec");
    assert.equal(retryIssueEntries.at(-1).issueLogId,
      `worker-handoff-${requests.at(-1).dispatchInvocationId}-${requests.at(-1).actionDigest}-missing`);
    assert.match(retryIssueEntries.at(-1).reason, /^Worker artifact handoff missing:/);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" }).descriptor, draftBeforeRetry);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "flow.findings", consumerNodeId: "spec" }).descriptor, findingsBeforeRetry);
    assert.deepEqual(reloaded.readArtifact({ specId, logicalKey: "draft.gate", consumerNodeId: "spec" }).descriptor, gateBeforeRetry);
    const specAfterRetry = reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
    assert.equal(specAfterRetry.descriptor.hash, specBeforeRetry.descriptor.hash);
    assert.deepEqual(specAfterRetry.bytes, specBeforeRetry.bytes);
    assert.equal(specRefusalSnapshots.length, 2);
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
    syncBuiltinESMExports();
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});
