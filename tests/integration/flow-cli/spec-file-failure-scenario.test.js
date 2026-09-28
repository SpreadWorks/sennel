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
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake,
  requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";

it("keeps a later Spec file evaluation failure across reload without publishing earlier findings", async () => {
  const root = fixtureRepository("spec-file-failure-");
  const specId = "903-spec-file-failure";
  let gateAgentLookup = null;
  let reviewProcess = null;
  try {
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
      guardrails: ["FIRST", "SECOND"].map((id) => ({
        id, title: id, body: `Check the full Spec for ${id}.`,
        meta: { phase: ["spec"], category: "requirements" },
      })),
    }));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-spec-file-failure",
      request: "Keep a failed Spec file evaluation recoverable across reload.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("spec");
    const paths = [];
    const gateCalls = [];
    const unavailableReason = "SECOND could not read the complete Spec file within its available context.";
    gateAgentLookup = installGateProviderFake((prompt, options) => {
      const ids = options.jsonSchema?.properties?.observations?.items?.properties?.requirementRef?.enum ?? [];
      assert.equal(manager.canonicalState(specId).current.at(-1), "spec-gate");
      assert.equal(ids.length, 1, "whole rules must be grouped before provider evaluation");
      const filePath = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
      assert.ok(filePath, "the provider must receive a full file reference");
      paths.push(filePath);
      assert.ok(fs.readFileSync(filePath, "utf8").includes("FULL_SPEC_TAIL"));
      gateCalls.push(ids[0]);
      if (ids[0] !== "FIRST" && ids[0] !== "SECOND") {
        return JSON.stringify({ observations: [], evaluationUnavailable: null });
      }
      return ids[0] === "FIRST"
        ? JSON.stringify({ observations: [{
          failureMode: "guardrail-violation", requirementRef: "FIRST",
          where: { file: "spec.json", locator: "requirements.R1.desc" },
          observed: "The first rule identifies a concrete issue.",
          targets: [{ entity: "requirement", id: "R1", field: "desc" }],
          allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" },
            operationKinds: ["edit-text-field"] }],
        }], evaluationUnavailable: null })
        : JSON.stringify({ observations: null, evaluationUnavailable: { reason: unavailableReason } });
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
      assert.equal(manager.canonicalState(specId).current.at(-1), "spec-review");
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
      if (request.stepId === "spec") {
        const canonical = validWorkerHandoffTaskSpec();
        canonical.background = `FULL_SPEC_HEAD ${"x".repeat(130_000)} FULL_SPEC_TAIL`;
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
    assert.deepEqual(gateCalls.slice(-2), ["FIRST", "SECOND"], JSON.stringify({
      attemptFailure: manager.canonicalState(specId).attempt.failure,
      settlement: manager.readCurrentStepSettlement({ specId, stepId: "spec-gate" }),
      artifacts: manager.artifactCatalog(specId).artifacts.map((entry) => entry.logicalKey),
    }));
    assert.equal(new Set(gateCalls).size, gateCalls.length, "valid unavailable output must not trigger a format retry");
    assert.equal(paths.length, gateCalls.length);
    assert.equal(new Set(paths).size, 1);
    assert.equal(fs.existsSync(paths[0]), false);
    assert.equal(result.dispatch?.boundary, "blocked", JSON.stringify(result));

    const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const failure = restored.canonicalState(specId).attempt.failure;
    assert.equal(failure.category, "tooling");
    assert.equal(failure.code, "GATE_OUTPUT_TOOLING_FAILURE");
    assert.match(failure.message, /SECOND could not read the complete Spec file/);
    assert.doesNotMatch(failure.message, /The first rule identifies a concrete issue/);
    assert.equal(restored.readCurrentStepSettlement({ specId, stepId: "spec-gate" }), null);
    assert.equal(restored.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "spec.gate"), false);
    const failureActivity = restored.activityLedger(specId).findLast((entry) =>
      entry.nodeId === "spec-gate" && entry.transition?.operation === "fail_attempt");
    assert.equal(failureActivity.failure.message, failure.message);
    const next = await new GetNextActionCommand().execute({ root, mainRoot: root, executionRoot: root,
      specId, flowManager: restored, flowState: restored.loadReadOnly(specId) });
    assert.equal(next.step, "spec-gate");
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, "CANONICAL_ATTEMPT_RECOVERY_REQUIRED");
  } finally {
    reviewProcess?.mock.restore();
    syncBuiltinESMExports();
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});
