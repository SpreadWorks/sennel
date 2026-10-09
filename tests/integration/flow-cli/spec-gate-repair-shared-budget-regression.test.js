import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { AgentProviderCompletionEvidence } from "../../../src/lib/agent-failure.js";
import { PromptLogicalFootprint } from "../../../src/lib/prompt-batching.js";
import { workerArtifactStableStringify } from "../../../src/flow/lib/worker-artifact-input-format.js";
import { SpecGateRepairProgressReader } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("repairs seven findings in six units while worker checkout research stays outside canonical evidence and provider budget", async (t) => {
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements = Array.from({ length: 6 }, (_, index) => ({
    ...specRecord.requirements[0], id: `R${index + 1}`, task_ids: [`T${index + 1}`],
  }));
  const sources = Array.from({ length: 19 }, (_, index) => {
    const relative = `src/context-${index}.js`;
    const length = index === 18 ? 602722 - (31722 * 18) : 31722;
    const prefix = `// Complete context ${index}\n`;
    return { relative, content: prefix + "a".repeat(length - prefix.length - 1) + "\n" };
  });
  const additionalObservations = ["R1", "R2", "R3", "R4", "R5", "R6"].map((id, index) => {
    const target = { entity: "requirement", id, field: "desc" };
    return { failureMode: "guardrail-violation", requirementRef: id,
      where: { file: "spec.json", locator: `requirements[${id}].desc` },
      observed: `Correction ${index + 1} preserves all referenced source context.`, targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] };
  });
  const value = await createSpecGateRepairScenario({ specRecord, additionalObservations,
    issue: 521, issueSnapshot: "Preserve complete shared source evidence while repairing each independent unit.\n",
    request: `Repair each selected description using ${sources.map((source) => source.relative).join(", ")}.`,
    beforeGate: ({ root, specId, flowManager, flow }) => {
      fs.mkdirSync(path.join(root, "src"));
      for (const source of sources) fs.writeFileSync(path.join(root, source.relative), source.content);
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Preserve every complete source and each unit's exact writable authority.\n");
      initGitRepo(root);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(root, "Create shared repair evidence repository");
      flow.activate("draft");
      flowManager.publishCurrentAttemptResult({ specId,
        commandResult: attachCanonicalCommandResultPublications({ result: "draft prepared" }, [{
          logicalKey: "draft", payload: canonicalDraftDocument({ goal: "Retain complete shared context." }),
        }]),
      });
    },
  });
  try {
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    const config = { agent: { default: "fixture/worker", promptCharacterLimit: 60_000, providers: {
      "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] },
    } } };
    const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
      registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: value.root, enabled: false }) });
    let providerCalls = 0;
    let context;
    let chargedCharacters = 0;
    let chargedItems = 0;
    t.mock.method(agent, "_callOnce", async (resolved, prompt, options) => {
      providerCalls += 1;
      const { SpecGateRepairBundle } = await import("../../../src/flow/lib/spec-gate-repair-bundle.js");
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const input = requestInput(request, "spec-gate-repair-context.json");
      context = input.document;
      const bundle = SpecGateRepairBundle.fromJSON(context.bundle);
      const selections = bundle.selections();
      assert.equal(context.mode, "repair");
      assert.equal(context.batchCount, 1);
      assert.equal(selections.length, 6);
      assert.equal(selections.flatMap((selection) => selection.unit.findings).length, 7);
      assert.equal(context.bundle.sources.length, 4, "Only required canonical evidence bodies are selected initially");
      assert.equal(sources.reduce((total, source) => total + source.content.length, 0), 602722);
      const snapshots = new SpecGateRepairProgressReader({ flowManager: value.flowManager, specId: value.specId,
        attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "checkpoint").sourceSnapshots.sources();
      assert.equal(snapshots.length, 4);
      assert.ok(snapshots.every((entry) => !entry.id.startsWith("evidence:source:")),
        "The host captures canonical repair input without selecting checkout source files");
      for (const source of sources) {
        // The provider stub stands at the worker boundary and reads checkout files directly.
        const workerRead = fs.readFileSync(path.join(options.executionWorkDir, source.relative), "utf8");
        assert.equal(workerRead, source.content);
        assert.equal(hash(workerRead), hash(source.content));
        assert.equal(snapshots.some((entry) => entry.origin === source.relative), false);
        assert.equal(workerArtifactStableStringify(context).includes(JSON.stringify(source.content)), false,
          "Checkout research is read by the worker without becoming canonical selected evidence");
        for (const selection of selections) {
          assert.equal(selection.ranges.some((entry) => entry.value?.origin === source.relative), false);
          const index = selection.ranges.find((entry) => entry.id.startsWith("repair-index:"));
          assert.ok(index);
          assert.equal(index.writable, false);
          assert.equal(index.target, null);
          assert.equal(index.value.descriptors.some((entry) => entry.source?.origin === source.relative), false,
            "The canonical index does not advertise a host-selected checkout inventory");
        }
      }
      const groups = selections.map((selection) => {
        const writable = selection.ranges.filter((entry) => entry.writable);
        assert.equal(writable.length, 1);
        assert.equal(writable[0].target.field, "desc");
        assert.ok(selection.unit.findings.every((finding) => finding.allowedTargets.every((permission) =>
          permission.target.id === writable[0].target.id)));
        return { findingIdentities: selection.unit.findings.map((finding) => finding.identity),
          operations: [{ kind: "edit-text-field", target: writable[0].target, expectedDigest: writable[0].digest,
            edits: [{ startByte: 0, endByte: Buffer.byteLength(writable[0].value),
              replacement: `Precisely validate ${writable[0].target.id}.` }], reason: "Correct this exact independent unit." }] };
      });
      const proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision, groups };
      const physical = PromptLogicalFootprint.measure({ systemPrompt: options.systemPrompt,
        userPrompt: prompt, jsonSchema: options.jsonSchema, fmtFallback: options.fmtFallback });
      assert.ok(physical.total <= 60_000, "The admitted provider request respects the configured character limit");
      const action = JSON.parse(fs.readFileSync(path.join(path.dirname(requestPath), "action.json"), "utf8"));
      chargedCharacters = physical.total
        + (input.descriptor.deliveryMode === "file" ? workerArtifactStableStringify(context).length : 0)
        + workerArtifactStableStringify(request).length + workerArtifactStableStringify(action).length
        + JSON.stringify(proposal).length;
      chargedItems = 4 + groups.length;
      fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
      sealWorkerArtifactHandoff({ requestPath,
        invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      const text = JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      return { text, usage: null, stdout: text, stderr: "",
        providerCompletionEvidence: new AgentProviderCompletionEvidence({
          provider: resolved.providerKey, profile: resolved.profileKey, exitCode: 0,
          stdout: text, processTreeQuiescence: "confirmed",
        }) };
    });
    const flowState = value.flowManager.loadReadOnly(value.specId);
    const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
    dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
    const result = await dispatcher.execute({ ...value.ctx, flowState,
      expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch" });
    assert.equal(providerCalls, 1, JSON.stringify(result));
    assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify(result));
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    const saved = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes.toString("utf8"));
    assert.deepEqual(saved.requirements.map((requirement) => requirement.desc),
      specRecord.requirements.map((requirement) => `Precisely validate ${requirement.id}.`));
    assert.deepEqual(saved.overview, specRecord.overview);
    for (const source of sources) assert.equal(fs.readFileSync(path.join(value.root, source.relative), "utf8"), source.content);
    const audit = JSON.parse(reloaded.readArtifact({ specId: value.specId, logicalKey: "spec.gate.repair.audit",
      consumerNodeId: "spec-review", parameters: { attemptId } }).bytes.toString("utf8"));
    assert.equal(audit.acceptedGroups.length, 6);
    assert.equal(reloaded.canonicalState(value.specId).nextAction().nodeId, "spec-review");
    const budget = latestRepairBudget({ flowManager: reloaded, specId: value.specId, attemptId,
      baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
    assert.equal(budget.providerCallCount, 1);
    assert.equal(budget.aggregateCharacters, chargedCharacters);
    assert.equal(budget.aggregateItemCount, chargedItems);

    const checkpoint = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
      parameters: { attemptId, generation: "0", phase: "checkpoint" } }).bytes.toString("utf8"));
    assert.equal(checkpoint.version, 4);
    assert.equal(Object.hasOwn(checkpoint, "sourceSnapshots"), false);
    assert.deepEqual(checkpoint.sourceSnapshotReference, context.sourceSnapshotReference);
    assert.equal(checkpoint.plan.version, 1);
    assert.equal(checkpoint.plan.calls.length, 1);
    assert.equal(checkpoint.limit.maxAggregateCharacters, null);
    const progress = ["claimed", "publication"].map((phase) => JSON.parse(reloaded.readArtifact({
      specId: value.specId, logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
      parameters: { attemptId, generation: "0", phase },
    }).bytes.toString("utf8")));
    assert.equal(checkpoint.budget.providerCallCount, 0);
    for (const entry of progress) {
      assert.deepEqual(entry.limit, checkpoint.limit);
      assert.deepEqual(entry.context, checkpoint.context);
      assert.equal(entry.requestDigest, checkpoint.requestDigest);
      assert.equal(entry.budget.providerCallCount, 1);
    }
    assert.deepEqual(progress[1].budget, budget);
    assert.deepEqual(checkpoint.callCost, checkpoint.plan.calls[0].callCost);
    assert.deepEqual(checkpoint.responseAllowance, checkpoint.plan.calls[0].responseAllowance);
  } finally { removeTmpDir(value.root); }
});
