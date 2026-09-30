import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { it, mock } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake,
  requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";

for (const phase of ["draft", "spec"]) {
it(`stops ${phase} after four file-read failures and rejects dispatcher restart after reload`, async () => {
  const root = fixtureRepository(`${phase}-file-read-exhaustion-`);
  const specId = `904-${phase}-file-read-exhaustion`;
  let gateAgentLookup = null;
  let reviewProcess = null;
  try {
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
      guardrails: ["FIRST", "SECOND"].map((id) => ({
        id, title: id, body: `Check the full Spec for ${id}.`,
        meta: { phase: [phase], category: "requirements" },
      })),
    }));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-spec-file-failure",
      request: "Keep a failed Spec file evaluation recoverable across reload.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate(phase);
    const paths = [];
    const gateCalls = [];
    const attemptBindings = [];
    const semanticStates = [];
    const unavailableReason = "SECOND explicitly failed to open the referenced file.";
    gateAgentLookup = installGateProviderFake((prompt, options) => {
      const ids = options.jsonSchema?.properties?.observations?.items?.properties?.requirementRef?.enum ?? [];
      const state = manager.canonicalState(specId);
      assert.equal(state.current.at(-1), `${phase}-gate`);
      attemptBindings.push({ id: state.attempt.id, sequence: state.attempt.sequence });
      semanticStates.push(state.findNode(`${phase}-gate`).toJSON());
      assert.equal(ids.length, 1, "whole rules must be grouped before provider evaluation");
      const filePath = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
      assert.ok(filePath, "the provider must receive a full file reference");
      paths.push(filePath);
      assert.ok(fs.readFileSync(filePath, "utf8").includes("FULL_INPUT_TAIL"));
      gateCalls.push(ids[0]);
      if (ids[0] !== "FIRST" && ids[0] !== "SECOND") {
        return JSON.stringify({ observations: [], evaluationUnavailable: null });
      }
      return ids[0] === "FIRST"
        ? JSON.stringify({ observations: [{
          failureMode: "guardrail-violation", requirementRef: "FIRST",
          where: { file: `${phase}.json`, locator: phase === "draft" ? "goal" : "requirements.R1.desc" },
          observed: "The first rule identifies a concrete issue.",
          ...(phase === "spec" ? { targets: [{ entity: "requirement", id: "R1", field: "desc" }],
          allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" },
            operationKinds: ["edit-text-field"] }] } : {}),
        }], evaluationUnavailable: null })
        : JSON.stringify({ observations: null, evaluationUnavailable: { kind: "file-read-failed", reason: unavailableReason } });
    }, { projectInvocation(_prompt, options) {
      const count = options.jsonSchema.properties.observations.items.properties.requirementRef.enum.length;
      return new ResolvedAgentInvocationProjection({
        providerKey: "fixture", profileKey: "fixture", command: "fixture",
        promptCharacterCount: count > 1 ? 120001 : 1000,
        systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
        finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
      });
    } });
    const originalSpawnSync = childProcess.spawnSync;
    reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
        return originalSpawnSync(command, args, options);
      }
      const reviewStep = manager.canonicalState(specId).current.at(-1);
      if (phase === "draft") {
        assert.ok(["draft-questions-review", "draft-coverage-review"].includes(reviewStep));
        const work = ReviewWorkUnit.fromEnvironment(options.env);
        const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
        fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
          version: 2, phase: reviewStep === "draft-questions-review" ? "draft-questions" : "draft-coverage",
          sourceDraft: "draft.json", sourceDraftRevision: source.revision,
          generatedAt: "2026-09-23T00:00:00.000Z", verdict: "PASS",
          summary: "No Draft review findings.", blockingFindings: [], advisoryFindings: [], repairTargets: [],
        }));
        work.seal();
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
      assert.equal(reviewStep, "spec-review");
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
      const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
      const delta = new SpecReviewDelta({ version: 2, stage: "spec-review",
        identity: review.identity.toJSON(), baseReviewDigest: review.digest,
        findings: [], scopeExpansions: [], operations: [] });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"),
        workerArtifactJson(delta.toJSON()));
      work.seal();
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    syncBuiltinESMExports();
    const worker = { async call(_prompt, options) {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const invocationId = options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (request.stepId === "draft") {
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(
          canonicalDraftDocument({ goal: `FULL_INPUT_HEAD ${"x".repeat(130_000)} FULL_INPUT_TAIL` })));
      } else if (request.stepId === "spec") {
        const canonical = validWorkerHandoffTaskSpec();
        canonical.background = `FULL_INPUT_HEAD ${"x".repeat(130_000)} FULL_INPUT_TAIL`;
        canonical.tasks = canonical.tasks.map((task) => ({ ...task,
          test_strategy: "Verify the exact behavior after implementation." }));
        fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson(canonical));
      } else if (request.stepId === "spec-triage" || request.stepId === "spec-repair") {
        const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
        fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
          version: 2, stage: request.stepId, identity: review.identity.toJSON(),
          baseReviewDigest: review.digest, findings: [], operations: [],
          ...(request.stepId === "spec-repair" ? { scopeExpansions: [] } : {}),
        }));
      } else throw new Error(`Unexpected worker ${request.stepId}`);
      sealWorkerArtifactHandoff({ requestPath, invocationId });
      return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
    } };
    const dispatcher = new RunDispatchCommand({ agent: worker, maxDispatches: 64 });
    dispatcher.container = dispatchContainer({ root, flowManager: manager, agent: worker });
    const result = await dispatcher.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      expectBinding: FlowTargetBinding.capture({ flowState: manager.loadReadOnly(specId),
        mainRoot: root, authorityRoot: root }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.deepEqual(gateCalls.slice(-5), ["FIRST", "SECOND", "SECOND", "SECOND", "SECOND"], JSON.stringify({
      attemptFailure: manager.canonicalState(specId).attempt.failure,
      settlement: manager.readCurrentStepSettlement({ specId, stepId: `${phase}-gate` }),
      artifacts: manager.artifactCatalog(specId).artifacts.map((entry) => entry.logicalKey),
    }));
    assert.equal(gateCalls.filter((id) => id === "SECOND").length, 4);
    assert.equal(new Set(attemptBindings.map((entry) => entry.id)).size, 1);
    assert.ok(semanticStates.every((state) => JSON.stringify(state) === JSON.stringify(semanticStates[0])),
      "response retries must leave the semantic Gate node and retry budget unchanged");
    assert.equal(paths.length, gateCalls.length);
    assert.equal(new Set(paths).size, 1);
    assert.equal(fs.existsSync(paths[0]), false);
    assert.equal((result.dispatch ?? result.data?.dispatch)?.boundary, "blocked", JSON.stringify(result));

    const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const failure = restored.canonicalState(specId).attempt.failure;
    assert.equal(failure?.category, phase === "draft" ? "step-result-error" : "tooling",
      JSON.stringify({ failure, result }));
    assert.equal(failure.code, "GATE_OUTPUT_TOOLING_FAILURE");
    const evidence = failure.responseProtocolEvidence;
    assert.ok(evidence, JSON.stringify(failure));
    const exhausted = evidence.groups.find((group) => group.attempts.length === 4);
    assert.ok(exhausted, JSON.stringify(evidence));
    assert.ok(evidence.groups.some((group) => group.outcome === "accepted"),
      "earlier accepted group evidence must survive the final unavailable group");
    assert.equal(exhausted.stopReason, "file_read_retry_exhausted");
    assert.equal(exhausted.providerAttemptCount, 4);
    assert.equal(exhausted.responseCallCount, 4);
    assert.deepEqual(exhausted.attempts.map((attempt) => attempt.failureKind),
      Array(4).fill("file-read-failed"));
    assert.equal(restored.canonicalState(specId).attempt.id, attemptBindings[0].id);
    assert.doesNotMatch(failure.message, /The first rule identifies a concrete issue/);
    const saved = restored.readCurrentStepSettlement({ specId, stepId: `${phase}-gate` });
    if (phase === "draft") {
      assert.equal(saved.result.kind, "draft-gate-error");
      assert.equal(saved.result.error.code, "GATE_OUTPUT_TOOLING_FAILURE");
      assert.equal(saved.result.error.data.failureMode, "file_read_retry_exhausted");
      assert.deepEqual(saved.result.error.data.responseProtocolEvidence, evidence.toJSON());
      assert.equal(saved.receipt.binding.attemptId, attemptBindings[0].id);
    } else assert.equal(saved, null);
    if (phase === "draft") {
      const history = JSON.parse(restored.readArtifact({ specId, logicalKey: "draft.gate",
        consumerNodeId: "spec" }).bytes.toString("utf8"));
      assert.equal(history.attempts.length, 1);
      const diagnostic = history.attempts[0].artifact.payload;
      assert.equal(diagnostic.result, "fail");
      assert.deepEqual(diagnostic.artifacts.evaluations, []);
      assert.equal(diagnostic.artifacts.failureCode, "GATE_OUTPUT_TOOLING_FAILURE", JSON.stringify(diagnostic));
      assert.deepEqual(diagnostic.artifacts.responseProtocolEvidence, evidence.toJSON());
    } else assert.equal(restored.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "spec.gate"), false);
    assert.equal(restored.canonicalState(specId).attempt.consumption.semantic, 0);
    assert.equal(restored.canonicalState(specId).attempt.consumption.tooling, 0);
    const failureActivity = restored.activityLedger(specId).findLast((entry) =>
      entry.nodeId === `${phase}-gate` && entry.transition?.operation === "fail_attempt");
    assert.equal(failureActivity.failure.message, failure.message);
    assert.deepEqual(failureActivity.failure.responseProtocolEvidence, evidence.toJSON());
    const next = await new GetNextActionCommand().execute({ root, mainRoot: root, executionRoot: root,
      specId, flowManager: restored, flowState: restored.loadReadOnly(specId) });
    assert.equal(next.step, `${phase}-gate`);
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, phase === "draft"
      ? "CANONICAL_ATTEMPT_BLOCKED" : "CANONICAL_ATTEMPT_RECOVERY_REQUIRED");
    const before = restored.canonicalState(specId).toJSON();
    const beforeCatalog = restored.artifactCatalog(specId).toJSON();
    const beforeActivities = restored.activityLedger(specId);
    const callsBefore = gateCalls.length;
    const restart = new RunDispatchCommand({ agent: worker, maxDispatches: 64 });
    restart.container = dispatchContainer({ root, flowManager: restored, agent: worker });
    const retry = await restart.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: restored,
      flowState: restored.loadReadOnly(specId),
      expectBinding: FlowTargetBinding.capture({ flowState: restored.loadReadOnly(specId),
        mainRoot: root, authorityRoot: root }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(retry.dispatch.boundary, "blocked");
    assert.equal(retry.dispatch.dispatchCount, 0);
    assert.equal(gateCalls.length, callsBefore);
    assert.deepEqual(restored.canonicalState(specId).toJSON(), before);
    assert.deepEqual(restored.artifactCatalog(specId).toJSON(), beforeCatalog);
    assert.deepEqual(restored.activityLedger(specId), beforeActivities);
  } finally {
    reviewProcess?.mock.restore();
    syncBuiltinESMExports();
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});

}
