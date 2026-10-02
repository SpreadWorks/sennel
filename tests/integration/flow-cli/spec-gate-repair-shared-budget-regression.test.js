import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
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

test("repairs seven findings in six units with shared complete ASCII evidence within the durable aggregate budget", async () => {
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
    const config = { agent: { default: "fixture/worker", providers: {
      "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] },
    } } };
    const transport = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
      registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: value.root, enabled: false }) });
    let providerCalls = 0;
    let context;
    let chargedCharacters = 0;
    let chargedItems = 0;
    const agent = {
      projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
      async call(prompt, options) {
        providerCalls += 1;
        const { SpecGateRepairBundle } = await import("../../../src/flow/lib/spec-gate-repair-bundle.js");
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        context = requestInput(request, "spec-gate-repair-context.json").document;
        const bundle = SpecGateRepairBundle.fromJSON(context.bundle);
        const selections = bundle.selections();
        assert.equal(context.mode, "repair");
        assert.equal(context.batchCount, 1);
        assert.equal(selections.length, 6);
        assert.equal(selections.flatMap((selection) => selection.unit.findings).length, 7);
        assert.equal(context.bundle.sources.length, 23);
        assert.equal(sources.reduce((total, source) => total + source.content.length, 0), 602722);
        for (const source of sources) {
          const shared = context.bundle.sources.filter((entry) => entry.id === `evidence:source:${source.relative}`);
          assert.equal(shared.length, 1);
          assert.equal(shared[0].content, source.content);
          assert.equal(shared[0].revision, hash(source.content));
          assert.equal(JSON.stringify(context).split(JSON.stringify(source.content)).length - 1, 1,
            "Each complete source body must occur once in the provider input");
          for (const selection of selections) {
            const range = selection.ranges.find((entry) => entry.id === shared[0].id);
            assert.equal(range.value.content, source.content);
            assert.equal(range.digest, shared[0].digest);
            assert.equal(range.writable, false);
            assert.equal(range.target, null);
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
        chargedCharacters = prompt.length + request.inputs.reduce((sum, entry) =>
          sum + JSON.stringify(requestInput(request, entry.name).document).length, 0) + JSON.stringify(proposal).length;
        chargedItems = request.inputs.length + 1 + groups.length;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
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
    const budget = latestRepairBudget({ flowManager: reloaded, specId: value.specId, attemptId,
      baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
    assert.equal(budget.providerCallCount, 1);
    assert.equal(budget.aggregateCharacters, chargedCharacters);
    assert.equal(budget.aggregateItemCount, chargedItems);
    assert.ok(budget.aggregateCharacters <= 1_000_000);
    const checkpoint = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
      parameters: { attemptId, generation: "0", phase: "checkpoint" } }).bytes.toString("utf8"));
    assert.equal(checkpoint.version, 2);
    assert.equal(checkpoint.plan.version, 1);
    assert.equal(checkpoint.plan.calls.length, 1);
    assert.ok(checkpoint.plan.calls[0].callCost.characters
      + checkpoint.plan.calls[0].responseAllowance.characters <= 1_000_000);
    assert.deepEqual(checkpoint.callCost, checkpoint.plan.calls[0].callCost);
    assert.deepEqual(checkpoint.responseAllowance, checkpoint.plan.calls[0].responseAllowance);
  } finally { removeTmpDir(value.root); }
});
