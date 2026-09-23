import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
    const draftDocument = canonicalDraftDocument({ goal: "Retain both unresolved Draft observations." });
    const observations = ["goal", "analysis.validation"].map((locator, index) => ({
      failureMode: `missing-behavior-${index + 1}`, requirementRef: sharedGuardrail,
      where: { file: "draft.json", locator },
      observed: `Required Draft behavior ${index + 1} remains unresolved.`,
    }));
    const requests = [];
    let specBeforeRefusal = null;
    const gateAttempts = new Set();
    const reviewSteps = [];
    gateAgentLookup = installGateProviderFake((_prompt, options) => {
      const state = flowManager.canonicalState(specId);
      assert.equal(state.current.at(-1), "draft-gate");
      gateAttempts.add(state.attempt.id);
      const knownIds = options.jsonSchema?.properties?.observations?.items?.properties?.requirementRef?.enum ?? [];
      return JSON.stringify({ observations: knownIds.includes(sharedGuardrail) ? observations : [] });
    });
    const originalSpawnSync = childProcess.spawnSync;
    reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
        return originalSpawnSync(command, args, options);
      }
      const step = flowManager.canonicalState(specId).current.at(-1);
      assert.ok(["draft-questions-review", "draft-coverage-review"].includes(step));
      reviewSteps.push(step);
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
          specBeforeRefusal = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
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
    const dispatcher = new RunDispatchCommand({ agent });
    dispatcher.container = dispatchContainer({ root, flowManager, agent });
    const ctx = {
      root, mainRoot: root, executionRoot: root, specId, flowManager,
      flowState: flowManager.loadReadOnly(specId),
      expectBinding: FlowTargetBinding.capture({
        flowState: flowManager.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
      }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch",
    };
    const result = await dispatcher.execute(ctx);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((entry) => entry.code), ["FLOW_ARTIFACT_HANDOFF_MISSING"]);
    assert.equal(result.data.agentFailure.code, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(result.data.retryBudgetConsumed, false);
    assert.deepEqual(requests.map((request) => request.stepId), ["draft", "draft-gate-repair", "spec"]);
    assert.deepEqual(reviewSteps, ["draft-questions-review", "draft-coverage-review", "draft-coverage-review"]);
    assert.equal(gateAttempts.size, 2);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const draft = reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" });
    assert.deepEqual(JSON.parse(draft.bytes.toString("utf8")), draftDocument);
    const persisted = JSON.parse(reloaded.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    }).bytes.toString("utf8")).entries;
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.map((entry) => entry.sourceFindingId), [sharedGuardrail, sharedGuardrail]);
    assert.equal(new Set(persisted.map((entry) => entry.fingerprint)).size, 2);
    const gate = reloaded.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "draft.gate");
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

    const request = requests.at(-1);
    assert.deepEqual(requestInput(request, "draft.json").document, draftDocument);
    assert.equal(requestInput(request, "draft.json").digest, draft.descriptor.hash);
    const entries = requestInput(request, "flow-findings.json").document.entries;
    assert.deepEqual(entries.map(({ sourceObservation, ...entry }) => entry), persisted);
    assert.deepEqual(entries.map((entry) => entry.sourceObservation.observations[0].observed),
      observations.map((entry) => entry.observed));
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "spec");
    const specAfterRefusal = reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec" });
    assert.equal(specAfterRefusal.descriptor.hash, specBeforeRefusal.descriptor.hash);
    assert.deepEqual(specAfterRefusal.bytes, specBeforeRefusal.bytes);
    assert.equal(reloaded.activityLedger(specId).some((entry) => entry.result?.stepResult?.kind === "spec-created"), false);

  } finally {
    reviewProcess?.mock.restore();
    syncBuiltinESMExports();
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});
