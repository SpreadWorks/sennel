import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { AgentProviderCompletionEvidence } from "../../../src/lib/agent-failure.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { SpecGateRepairNavigationSelection, SpecGateRepairIndexManifest } from "../../../src/flow/lib/spec-gate-repair-selection.js";
import { SpecGateRepairProgressReader } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff, WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

async function dispatchOnce(value, agent) {
  const flowState = value.flowManager.loadReadOnly(value.specId);
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  return dispatcher.execute({ ...value.ctx, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
}

function repairProposal(context) {
  return { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
    groups: SpecGateRepairBundle.fromJSON(context.bundle).selections().map((selection) => {
      const range = selection.ranges.find((entry) => entry.writable);
      return { findingIdentities: selection.unit.findings.map((finding) => finding.identity),
        operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
          edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value), replacement: `Precisely validate ${range.target.id}.` }],
          reason: "Correct the canonical finding using all restored evidence." }] };
    }) };
}

test("persists readonly navigation and inspection, then restores every repair unit and exact authority", async (t) => {
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements.push(...Array.from({ length: 80 }, (_, index) => ({
    id: `R${index + 2}`, desc: `Canonical requirement ${index + 2}`, testable: false, task_ids: ["T1"],
  })));
  const secondTarget = { entity: "requirement", id: "R2", field: "desc" };
  const value = await createSpecGateRepairScenario({ specRecord, issue: 521,
    issueSnapshot: `Complete acknowledged constraints.\n${"Preserve acknowledged requirements.\n".repeat(3000)}`,
    additionalObservations: [{ failureMode: "guardrail-violation", requirementRef: "R2",
      where: { file: "spec.json", locator: "requirements[R2].desc" }, observed: "Correct the second independent field.",
      targets: [secondTarget], allowedTargets: [{ target: secondTarget, operationKinds: ["edit-text-field"] }] }],
    beforeGate({ root }) {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/host-only.js"), "export const checkoutOnly = 137;\n");
      initGitRepo(root);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(root, "Create isolated readonly continuation repository");
    } });
  t.after(() => removeTmpDir(value.root));
  const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
  const config = { agent: { default: "fixture/worker", promptCharacterLimit: 60_000,
    providers: { "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] } } } };
  const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: value.root, enabled: false }) });
  const contexts = [];
  let unitId;
  let pageId;
  let inspectedId;
  let initialSelections;
  let providerFailure = null;
  t.mock.method(agent, "_callOnce", async (resolved, prompt, options) => {
    try {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const context = requestInput(request, "spec-gate-repair-context.json").document;
      const generation = contexts.length;
      contexts.push(context);
      const progress = new SpecGateRepairProgressReader({ flowManager: value.flowManager,
        specId: value.specId, attemptId, consumerNodeId: "spec-gate-repair" }).read(generation, "claimed");
      assert.deepEqual(progress.document.context, context);
      const contextRequest = (ids, intent) => ({ version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId, additionalRangeIds: ids, ...(intent === "inspect" ? { intent } : {}) });
      let proposal;
      if (generation === 0) {
        assert.equal(context.mode, "repair");
        initialSelections = SpecGateRepairBundle.fromJSON(context.bundle).selections();
        assert.equal(initialSelections.length, 2);
        const selection = initialSelections[0];
        unitId = selection.unit.id;
        const available = new Set(selection.ranges.map((range) => range.id));
        pageId = new SpecGateRepairIndexManifest(selection.indexManifest)
          .routesForPrefix("requirements[R40].desc").find((route) => !available.has(route.id)).id;
        assert.deepEqual(new SpecGateRepairIndexManifest(selection.indexManifest).pagesForSource("src/host-only.js"), []);
        assert.equal(context.bundle.sources.some((source) => source.origin === "src/host-only.js"), false);
        proposal = contextRequest([pageId], "inspect");
      } else if (generation === 1 || generation === 2) {
        assert.equal(context.mode, generation === 1 ? "navigate" : "inspect");
        const navigation = SpecGateRepairNavigationSelection.fromJSON(context.navigation);
        assert.equal(navigation.unit.id, unitId);
        assert.deepEqual(navigation.unit.toJSON().findings.map((finding) => finding.identity),
          initialSelections[0].unit.findings.map((finding) => finding.identity));
        assert.equal(navigation.toJSON().ranges.every((range) => range.writable === false), true);
        assert.equal(JSON.stringify(context).includes("Preserve acknowledged requirements."), false);
        const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
        const state = reloaded.canonicalState(value.specId);
        const lifecycle = reloaded.draftStepExecutionState({ binding: {
          runId: state.runId, specId: value.specId, stepId: "spec-gate-repair", attempt: state.attempt,
        } }).lifecycle;
        const restored = new WorkerArtifactHandoffCoordinator().restoreClaimedDraftRequest({
          ctx: { ...value.ctx, flowManager: reloaded }, state: reloaded.loadReadOnly(value.specId), lifecycle });
        assert.equal(restored.requestDigest, progress.document.requestDigest);
        assert.deepEqual(restored.inputs[0].document, context);
        if (generation === 1) {
          const page = navigation.ranges.find((range) => range.id === pageId);
          inspectedId = page.value.descriptors.find((entry) => entry.id === "requirements[R40].desc").id;
          proposal = contextRequest([inspectedId], "inspect");
        } else {
          assert.equal(navigation.ranges.some((range) => range.id === inspectedId), true);
          proposal = contextRequest([inspectedId], "repair");
        }
        const payloadPath = requestPayloadPath(request, "spec-gate-repair.json");
        const before = value.flowManager.canonicalState(value.specId).toJSON();
        const catalog = value.flowManager.artifactCatalog(value.specId).toJSON();
        for (const invalid of [repairProposal(contexts[0]), { ...proposal, unitId: `${unitId}-foreign` },
          { ...proposal, baseRevision: `sha256:${"f".repeat(64)}` }, { ...proposal, sourceQueries: [] }]) {
          fs.writeFileSync(payloadPath, workerArtifactJson(invalid));
          assert.throws(() => sealWorkerArtifactHandoff({ requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID }),
          (error) => error.code === "FLOW_ARTIFACT_HANDOFF_INVALID");
          assert.deepEqual(value.flowManager.canonicalState(value.specId).toJSON(), before);
          assert.deepEqual(value.flowManager.artifactCatalog(value.specId).toJSON(), catalog);
        }
      } else if (generation === 3) {
        assert.equal(context.mode, "repair");
        const selections = SpecGateRepairBundle.fromJSON(context.bundle).selections();
        assert.deepEqual(selections.map((selection) => selection.unit.id), initialSelections.map((selection) => selection.unit.id));
        for (const [index, selection] of selections.entries()) {
          assert.deepEqual(selection.unit.findings.map((finding) => finding.identity),
            initialSelections[index].unit.findings.map((finding) => finding.identity));
          assert.deepEqual(selection.unit.findings.map((finding) => finding.allowedTargets),
            initialSelections[index].unit.findings.map((finding) => finding.allowedTargets));
          assert.equal(selection.ranges.some((range) => range.id.startsWith("evidence:issue.snapshot")), true);
        }
        assert.equal(selections[0].ranges.some((range) => range.id === pageId), true);
        assert.equal(selections[0].ranges.some((range) => range.id === inspectedId), true);
        proposal = repairProposal(context);
      } else assert.fail(`Unexpected generation ${generation}`);
      fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
      const sealed = sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      const text = JSON.stringify(sealed);
      return { text, usage: null, stdout: text, stderr: "", providerCompletionEvidence: new AgentProviderCompletionEvidence({
        provider: resolved.providerKey, profile: resolved.profileKey, exitCode: 0, stdout: text, processTreeQuiescence: "confirmed" }) };
    } catch (error) { providerFailure = error; throw error; }
  });
  let result;
  for (let attempts = 0; attempts < 16 && contexts.length < 4; attempts += 1) {
    result = await dispatchOnce(value, agent);
    if (providerFailure !== null) throw providerFailure;
    if (!result.ok) assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result));
    value.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    value.ctx = { ...value.ctx, flowManager: value.flowManager };
  }
  assert.deepEqual(contexts.map((context) => context.mode), ["repair", "navigate", "inspect", "repair"], JSON.stringify(result));
  const stored = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
    logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes);
  assert.equal(stored.requirements[0].desc, "Precisely validate R1.");
  assert.equal(stored.requirements[1].desc, "Precisely validate R2.");
  assert.equal(value.flowManager.canonicalState(value.specId).nextAction().nodeId, "spec-review");
  for (let generation = 0; generation < 4; generation += 1) {
    const progress = new SpecGateRepairProgressReader({ flowManager: value.flowManager, specId: value.specId,
      attemptId, consumerNodeId: "spec-gate-repair" }).read(generation, "publication");
    assert.deepEqual(progress.document.context, contexts[generation]);
  }
});
