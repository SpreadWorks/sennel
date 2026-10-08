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
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const entryOrigin = "src/entry.js";
const ownerOrigin = "src/limits.js";
const entryText = "import { maximumItems } from './limits.js';\nexport const permits = items => items.length <= maximumItems;\n";
const ownerText = "export const maximumItems = 137;\n";
const replacement = "Reject collections exceeding the captured maximum of 137 items.";

function sourceRepository({ root }) {
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, entryOrigin), entryText);
  fs.writeFileSync(path.join(root, ownerOrigin), ownerText);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Use the captured implementation's exact limit.\n");
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
  commitAll(root, "Create captured source discovery evidence");
}
async function dispatchOnce(value, agent) {
  const flowState = value.flowManager.loadReadOnly(value.specId);
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  return dispatcher.execute({ ...value.ctx, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
}
function repair(context) {
  return { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
    groups: SpecGateRepairBundle.fromJSON(context.bundle).selections().map((selection) => {
      const range = selection.ranges.find((entry) => entry.writable);
      return { findingIdentities: selection.unit.findings.map((finding) => finding.identity),
        operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
          edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value), replacement }],
          reason: "Use the exact value read from the captured imported owner." }] };
    }) };
}

test("worker reads its checkout directly and host source selectors refuse without publication", async (t) => {
  const value = await createSpecGateRepairScenario({ issue: 521,
    request: `Read ${entryOrigin} and its imported contract before correcting the Spec.`,
    beforeGate: sourceRepository });
  t.after(() => removeTmpDir(value.root));
  const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
  const config = { agent: { default: "fixture/worker", promptCharacterLimit: 60_000,
    providers: { "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] } } } };
  const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: value.root, enabled: false }) });
  let calls = 0;
  let providerAssertion;
  t.mock.method(agent, "_callOnce", async (resolved, prompt, options) => {
    try {
      calls += 1;
      assert.match(prompt, /Follow workerInstructions in request.json/);
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      assert.match(request.workerInstructions.schemaGuidance, /Research missing source facts directly in the execution checkout/);
      const context = requestInput(request, "spec-gate-repair-context.json").document;
      assert.equal(context.mode, "repair");
      assert.equal(Object.hasOwn(context.bundle, "sourceOrigins"), false);
      assert.equal(context.bundle.sources.some((source) => source.origin.endsWith(".js")), false);
      const claimed = new SpecGateRepairProgressReader({ flowManager: value.flowManager, specId: value.specId,
        attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "claimed");
      assert.equal(claimed.sourceSnapshots.sources().some((source) => source.origin.endsWith(".js")), false);
      const selection = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
      const before = { state: value.flowManager.canonicalState(value.specId).toJSON(),
        catalog: value.flowManager.artifactCatalog(value.specId).toJSON(),
        budget: claimed.budget.snapshot() };
      const base = { version: 3, stage: "spec-gate-repair-context-request", intent: "inspect",
        baseRevision: context.baseRevision, unitId: selection.unit.id, additionalRangeIds: [], sourceOrigins: [], sourceQueries: [] };
      for (const invalid of [{ ...base, sourceOrigins: [entryOrigin] },
        { ...base, sourceQueries: [{ origin: ownerOrigin, literal: "maximumItems", beforeLines: 0, afterLines: 0, maxMatches: 1, cursor: null }] }]) {
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(invalid));
        assert.throws(() => sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID }),
          { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
        assert.deepEqual(value.flowManager.canonicalState(value.specId).toJSON(), before.state);
        assert.deepEqual(value.flowManager.artifactCatalog(value.specId).toJSON(), before.catalog);
        assert.deepEqual(new SpecGateRepairProgressReader({ flowManager: value.flowManager, specId: value.specId,
          attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "claimed").budget.snapshot(), before.budget);
      }
      // The external worker follows the import in the checkout. No host range or query supplies these bytes.
      assert.equal(fs.readFileSync(path.join(value.root, "AGENTS.md"), "utf8"), "Use the captured implementation's exact limit.\n");
      const entry = fs.readFileSync(path.join(value.root, entryOrigin), "utf8");
      const origin = path.posix.normalize(path.posix.join(path.posix.dirname(entryOrigin), entry.match(/from '([^']+)'/)[1]));
      const owner = fs.readFileSync(path.join(value.root, origin), "utf8");
      assert.equal(Number(owner.match(/maximumItems = (\d+)/)[1]), 137);
      fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(repair(context)));
      sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      const text = JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      return { text, usage: null, stdout: text, stderr: "", providerCompletionEvidence: new AgentProviderCompletionEvidence({
        provider: resolved.providerKey, profile: resolved.profileKey, exitCode: 0, stdout: text, processTreeQuiescence: "confirmed" }) };
    } catch (error) { providerAssertion = error; throw error; }
  });
  const result = await dispatchOnce(value, agent);
  if (providerAssertion) throw providerAssertion;
  assert.equal(calls, 1, JSON.stringify(result));
  value.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const stored = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
    logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes);
  assert.equal(stored.requirements[0].desc, replacement);
  assert.equal(value.flowManager.canonicalState(value.specId).nextAction().nodeId, "spec-review");
  assert.equal(fs.readFileSync(path.join(value.root, ownerOrigin), "utf8"), ownerText);
});
