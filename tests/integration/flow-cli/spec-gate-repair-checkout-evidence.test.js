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
import { SpecGateRepairProgressReader } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { SpecGateRepairInputUnavailable } from "../../../src/flow/lib/spec-gate-repair-input-unavailable.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, requestInput, requestPayloadPath, requestSpecGateRepairIdentity } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const entryOrigin = "src/deep/entry.js";
const ownerOrigin = "src/deep/limit.js";
const ruleOrigin = "src/deep/AGENTS.md";
const entryText = "import { maximumItems } from './limit.js';\nexport const permits = items => items.length <= maximumItems;\n";
const ownerText = "export const maximumItems = 137;\n";
const ruleText = "Use the current imported limit; describe rejection explicitly.\n";

function checkout({ root }, availability) {
  fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, entryOrigin), entryText);
  fs.writeFileSync(path.join(root, ownerOrigin), "export const maximumItems = 136;\n");
  fs.writeFileSync(path.join(root, ruleOrigin), "Prior scoped rules.\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Read applicable directory rules before correcting the Spec.\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
  initGitRepo(root);
  commitAll(root, "Create checkout research baseline");
  // These working changes are intentionally not committed. The worker must see
  // its actual execution checkout, rather than a Git HEAD or host source copy.
  fs.writeFileSync(path.join(root, ownerOrigin), ownerText);
  if (availability === "missing") fs.unlinkSync(path.join(root, ruleOrigin));
  else fs.writeFileSync(path.join(root, ruleOrigin), availability === "unavailable" ? Buffer.from([0xff, 0xfe]) : ruleText);
}

for (const availability of ["available", "missing", "unavailable"]) {
  test(`worker research uses uncommitted imported code and handles ${availability} scoped rules through the persisted disposition`, async (t) => {
    const value = await createSpecGateRepairScenario({ request: `Read ${entryOrigin}, its imported contract and applicable directory rules.`,
      beforeGate: (input) => checkout(input, availability) });
    t.after(() => removeTmpDir(value.root));
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    const beforeSpec = value.flowManager.readArtifact({ specId: value.specId, logicalKey: "spec.record",
      consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8");
    const beforeCatalog = value.flowManager.artifactCatalog(value.specId).toJSON();
    const config = { agent: { default: "fixture/worker", promptCharacterLimit: 60_000,
      providers: { "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] } } } };
    const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
      registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: value.root, enabled: false }) });
    let calls = 0;
    let providerAssertion;
    let context;
    t.mock.method(agent, "_callOnce", async (resolved, prompt, options) => {
      try {
        calls++;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const identity = requestSpecGateRepairIdentity(request, options.executionEnvironment);
        context = requestInput(request, "spec-gate-repair-context.json").document;
        const selection = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
        const claimed = new SpecGateRepairProgressReader({ flowManager: value.flowManager, specId: value.specId,
          attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "claimed");
        assert.equal(claimed.budget.snapshot().providerCallCount, 1);
        for (const sources of [context.bundle.sources, claimed.sourceSnapshots.sources()]) {
          assert.equal(sources.some((source) => source.origin.endsWith(".js") || source.origin === ruleOrigin), false);
        }
        const executionRoot = options.executionWorkDir;
        assert.equal(fs.realpathSync(executionRoot), fs.realpathSync(value.root));
        assert.match(fs.readFileSync(path.join(executionRoot, "AGENTS.md"), "utf8"), /applicable directory rules/);
        const entry = fs.readFileSync(path.join(executionRoot, entryOrigin), "utf8");
        const importedOrigin = path.posix.normalize(path.posix.join(path.posix.dirname(entryOrigin), entry.match(/from '([^']+)'/)[1]));
        const owner = fs.readFileSync(path.join(executionRoot, importedOrigin), "utf8");
        const maximum = Number(owner.match(/maximumItems = (\d+)/)[1]);
        assert.equal(maximum, 137);
        let proposal;
        if (availability === "available") {
          assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(executionRoot, ruleOrigin))), ruleText);
          const range = selection.ranges.find((entry) => entry.writable);
          assert.deepEqual(selection.ranges.filter((entry) => entry.writable).map((entry) => entry.target),
            [{ entity: "requirement", id: "R1", field: "desc" }]);
          proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
            groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity), operations: [{
              kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
              edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value), replacement: `Reject collections exceeding ${maximum} items.` }],
              reason: "Use the current imported limit and scoped rejection rule read in the checkout.",
            }] }] };
        } else {
          const readRule = () => new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(executionRoot, ruleOrigin)));
          if (availability === "missing") assert.throws(readRule, { code: "ENOENT" });
          else assert.throws(readRule, TypeError);
          proposal = new SpecGateRepairInputUnavailable({ version: 1, stage: "spec-gate-repair-input-unavailable",
            ...identity.toJSON(), reason: "context-unavailable",
            explanation: `Required scoped rule ${ruleOrigin} is ${availability} in the execution checkout.` }).toJSON();
        }
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
        sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        const text = JSON.stringify({ sealed: true, requestDigest: identity.binding.requestDigest });
        return { text, usage: null, stdout: text, stderr: "", providerCompletionEvidence: new AgentProviderCompletionEvidence({
          provider: resolved.providerKey, profile: resolved.profileKey, exitCode: 0, stdout: text, processTreeQuiescence: "confirmed" }) };
      } catch (error) { providerAssertion = error; throw error; }
    });
    const flowState = value.flowManager.loadReadOnly(value.specId);
    const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
    dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
    const result = await dispatcher.execute({ ...value.ctx, flowState,
      expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch" });
    if (providerAssertion) throw providerAssertion;
    assert.equal(calls, 1, JSON.stringify(result));
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    if (availability === "available") {
      assert.equal(reloaded.canonicalState(value.specId).nextAction().nodeId, "spec-review");
      const stored = JSON.parse(reloaded.readArtifact({ specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes);
      assert.equal(stored.requirements[0].desc, "Reject collections exceeding 137 items.");
      assert.deepEqual(stored.overview, JSON.parse(beforeSpec).overview);
    } else {
      assert.equal(reloaded.canonicalState(value.specId).attempt.failure.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
      assert.equal(reloaded.readArtifact({ specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8"), beforeSpec);
      const catalog = reloaded.artifactCatalog(value.specId).toJSON();
      for (const logicalKey of ["spec.snapshot", "spec.gate.repair.audit"]) {
        assert.equal(catalog.artifacts.filter((entry) => entry.logicalKey === logicalKey).length,
          beforeCatalog.artifacts.filter((entry) => entry.logicalKey === logicalKey).length);
      }
      const publication = new SpecGateRepairProgressReader({ flowManager: reloaded, specId: value.specId,
        attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "publication");
      assert.equal(publication.document.proposal.reason, "context-unavailable");
      assert.match(publication.document.proposal.explanation, new RegExp(availability));
    }
    assert.equal(latestRepairBudget({ flowManager: reloaded, specId: value.specId, attemptId,
      baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot().providerCallCount, 1);
    assert.equal(fs.readFileSync(path.join(value.root, ownerOrigin), "utf8"), ownerText);
  });
}
