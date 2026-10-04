import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { SpecGateRepairContext } from "../../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairContextExpansion } from "../../../src/flow/lib/spec-gate-repair-context-expansion.js";
import { SpecGateRepairSourceSnapshots } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { readSpecGateRepairSources } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { readSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-input.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { prepareSpecGateRepairService, createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const rootRule = "AGENTS.md";
const aRules = [rootRule, "src/AGENTS.md", "src/a/AGENTS.md", "src/a/deep/AGENTS.md"];
const bRules = ["src/b/AGENTS.md", "src/b/deep/AGENTS.md"];
function specFixture() {
  const spec = validWorkerHandoffSpec();
  spec.requirements = ["a", "b", "c"].map((name, index) => ({ ...spec.requirements[0],
    id: `R${index + 1}`, desc: `対象src/${name}/deep/file.jsを確認する。`, task_ids: ["T1"] }));
  return spec;
}
function repository(root, { unavailable = null, missing = null, noRoot = false } = {}) {
  const rules = [...aRules, ...bRules, "src/c/AGENTS.md"];
  for (const relative of rules) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), `Rule body for ${relative}:\n${"Retain the contract.\n".repeat(relative === bRules[0] ? 500 : 1)}`);
  }
  fs.appendFileSync(path.join(root, rootRule), "Context navigation may mention src/c/deep/file.js.\n");
  fs.appendFileSync(path.join(root, bRules[1]), "Context navigation may mention src/c/deep/file.js.\n");
  for (const name of ["a", "b", "c"]) {
    fs.mkdirSync(path.join(root, `src/${name}/deep`), { recursive: true });
    // Reading B must not recursively select C merely because its body names C.
    fs.writeFileSync(path.join(root, `src/${name}/deep/file.js`), name === "b"
      ? "// src/c/deep/file.js 漢🧭\n".repeat(6000) : "export const retained = true;\n");
  }
  if (noRoot) fs.unlinkSync(path.join(root, rootRule));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
  commitAll(root, "Capture isolated scoped-rule evidence");
  if (missing) fs.unlinkSync(path.join(root, missing));
  if (unavailable) fs.writeFileSync(path.join(root, unavailable), Buffer.from([0xff, 0xfe]));
}
function selectedRules(selection) {
  return selection.ranges.filter((range) => range.value?.appliesTo?.length).map((range) => range.value.origin).sort();
}
function reload(value) {
  value.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  value.ctx = { ...value.ctx, flowManager: value.flowManager };
}
function snapshot(value) {
  return { state: value.flowManager.canonicalState(value.specId).toJSON(),
    catalog: value.flowManager.artifactCatalog(value.specId).toJSON(),
    activities: value.flowManager.activityLedger(value.specId) };
}
function agentFor(root, call) {
  const config = { agent: { default: "fixture/worker", providers: {
    "fixture/worker": { command: "fixture-worker", args: ["{{PROMPT}}"] },
  } } };
  const transport = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: root, enabled: false }) });
  return { projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options), call };
}
async function dispatch(value, agent) {
  const flowState = value.flowManager.loadReadOnly(value.specId);
  const command = new RunDispatchCommand({ agent, maxDispatches: 1 });
  command.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  return command.execute({ ...value.ctx, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
}
function repairProposal(selection) {
  const range = selection.ranges.find((entry) => entry.writable);
  return { version: 1, stage: "spec-gate-repair", baseRevision: selection.baseRevision,
    groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity), operations: [{
      kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
      edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value), replacement: "Preserve the validated source contract." }],
      reason: "Use the selected source rules.",
    }] }] };
}

// Outcomes -> producers/storage/consumers: selected R1 and explicit B fragment ->
// real Git capture -> checkpoint snapshots -> fresh FlowManager -> next provider
// bundle and accepted Spec. Inventory/index discovery alone must add no scope.
test("scoped rules follow selected evidence and persisted fragment expansion into the next provider", async (t) => {
  const value = await createSpecGateRepairScenario({ specRecord: specFixture(), beforeGate: ({ root }) => repository(root) });
  t.after(() => removeTmpDir(value.root));
  let calls = 0;
  let initialSnapshots;
  let fragment;
  const documents = [];
  const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
  const agent = agentFor(value.root, async (prompt, options) => {
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    const document = requestInput(request, "spec-gate-repair-context.json").document;
    documents.push(document);
    const selection = SpecGateRepairBundle.fromJSON(document.bundle).selections()[0];
    const checkpoint = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
      parameters: { attemptId, generation: String(calls), phase: "checkpoint" } }).bytes.toString("utf8"));
    const sources = SpecGateRepairSourceSnapshots.fromJSON(checkpoint.sourceSnapshots);
    let proposal;
    if (calls === 0) {
      initialSnapshots = sources.toJSON();
      t.diagnostic(`initialSelectedBytes=${Buffer.byteLength(JSON.stringify(document))}; capturedSourceBytes=${sources.sources().reduce((sum, source) => sum + source.byteLength, 0)}`);
      assert.deepEqual(selectedRules(selection), [...aRules].sort());
      const index = selection.ranges.find((range) => range.id.startsWith("repair-index:")).value;
      assert(index.descriptors.some((entry) => entry.source?.origin === bRules[0]), "B is discoverable without reading its rule body");
      const input = readSpecGateRepairInput({ flowManager: value.flowManager,
        state: value.flowManager.canonicalState(value.specId), executionRoot: value.root, sourceSnapshots: sources });
      fragment = input.context.tableOfContents().find((entry) => entry.source?.origin === "src/b/deep/file.js"
        && entry.byteEnd - entry.byteStart < entry.source.byteLength);
      assert(fragment, "an actual registered UTF-8 fragment is requested");
      proposal = { version: 1, stage: "spec-gate-repair-context-request", baseRevision: selection.baseRevision,
        unitId: selection.unit.id, additionalRangeIds: [fragment.id] };
    } else {
      assert.deepEqual(sources.toJSON(), initialSnapshots, "next generation reads the immutable source inventory");
      assert.deepEqual(selectedRules(selection), [...aRules, ...bRules].sort());
      const selected = selection.ranges.find((range) => range.id === fragment.id);
      const bytes = Buffer.from(sources.sources().find((source) => source.origin === fragment.source.origin).content);
      assert.equal(selected.value.content, bytes.subarray(fragment.byteStart, fragment.byteEnd).toString("utf8"));
      assert.equal(selected.writable, false);
      assert.equal(selectedRules(selection).includes("src/c/AGENTS.md"), false);
      proposal = repairProposal(selection);
    }
    assert.deepEqual(checkpoint.context, document);
    calls += 1;
    fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
    sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
    return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
  });
  const first = await dispatch(value, agent);
  assert.equal(calls, 1, JSON.stringify(first));
  reload(value);
  assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
  const second = await dispatch(value, agent);
  assert.equal(calls, 2, JSON.stringify(second));
  assert.equal(second.data?.nextAction?.step, "spec-review", JSON.stringify(second));
  reload(value);
  const saved = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
    logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes.toString("utf8"));
  assert.equal(saved.requirements[0].desc, "Preserve the validated source contract.");
  assert.equal(saved.requirements[1].desc, specFixture().requirements[1].desc);
  assert(documents[1].bundle.sources.length > documents[0].bundle.sources.length);
});

test("direct rule, full source, fragment and document reads retain applicable parents without sibling closure after snapshot reload", (t) => {
  const root = createTmpDir("repair-scoped-rules-");
  t.after(() => removeTmpDir(root));
  repository(root);
  fs.mkdirSync(path.join(root, "vendor/src/b/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor/AGENTS.md"), "Preserve vendor behavior.");
  fs.writeFileSync(path.join(root, "vendor/src/b/deep/file.js"), "export const vendor = true;");
  commitAll(root, "Capture a distinct origin containing another path as a suffix");
  fs.mkdirSync(path.join(root, "quoted"));
  fs.writeFileSync(path.join(root, 'quoted/file"name.js'), "export const quoted = true;");
  fs.writeFileSync(path.join(root, "quoted/AGENTS.md"), "Preserve quoted evidence.");
  commitAll(root, "Capture an origin with a literal quotation mark");
  const spec = specFixture();
  spec.overview.decisions.push({ text: "Consider vendor/src/b/deep/file.js.", evidence: "Existing consumer", consideredAlternatives: "Keep the contract" });
  const sources = readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
    state: { issue: null, request: '対象quoted/file"name.jsを確認する。' }, executionRoot: root, spec });
  const savedPath = path.join(root, "snapshots.json");
  fs.writeFileSync(savedPath, JSON.stringify(new SpecGateRepairSourceSnapshots(sources).toJSON()));
  const restored = SpecGateRepairSourceSnapshots.fromJSON(JSON.parse(fs.readFileSync(savedPath, "utf8")));
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const contextFor = ({ document = false, direct = false, suffix = false, observed = "Repair the check", rationale = "", rule = "Preserve behavior" } = {}) => {
    const inputSpec = structuredClone(spec);
    if (direct) inputSpec.requirements[0].desc = "Read src/b/deep/AGENTS.md.";
    if (suffix) inputSpec.requirements[0].desc = "Read ./vendor/src/b/deep/file.js.";
    return new SpecGateRepairContext({ spec: inputSpec, baseRevision: `sha256:${"a".repeat(64)}`,
      guardrails: [{ id: "rule", body: rule }], acknowledgedRationale: rationale, sources: restored.sources(),
      findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
        requirementRef: "rule", observed, targets: [document ? { document: "spec" } : target],
        allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }] });
  };
  assert(restored.sources().some((source) => source.origin === 'quoted/file"name.js'));
  const expectedCanonicalRule = "quoted/AGENTS.md";
  const context = contextFor();
  const unitId = context.units()[0].id;
  const initial = context.select(unitId);
  t.diagnostic(`componentSelectedBytes=${Buffer.byteLength(JSON.stringify(initial.toJSON()))}`);
  assert.deepEqual(selectedRules(initial), [...aRules, expectedCanonicalRule].sort());
  const descriptors = context.tableOfContents();
  const source = descriptors.find((entry) => entry.source?.origin === "src/b/deep/file.js"
    && entry.byteEnd === entry.source.byteLength && entry.byteStart === 0);
  const directRule = descriptors.find((entry) => entry.source?.origin === bRules[1]);
  assert.equal(descriptors.filter((entry) => entry.source?.origin === bRules[1]).length, 1, "rules are complete atomic sources");
  for (const id of [source.id, directRule.id, "requirements[R2].desc"]) {
    const expanded = new SpecGateRepairContextExpansion({ context, unitId, baseRevision: context.baseRevision, requestedRangeIds: [id] });
    assert.deepEqual(selectedRules(expanded.selection), [...aRules, ...bRules, expectedCanonicalRule].sort());
    assert.deepEqual(expanded.selection.ranges.filter((range) => range.writable), initial.ranges.filter((range) => range.writable));
  }
  for (const options of [{ observed: "Review src/b/deep/file.js" }, { rationale: "Review src/b/deep/file.js" }, { rule: "Review src/b/deep/file.js" }]) {
    const referenced = contextFor(options);
    assert.deepEqual(selectedRules(referenced.select(referenced.units()[0].id)), [...aRules, ...bRules, expectedCanonicalRule].sort());
  }
  const direct = contextFor({ direct: true });
  assert.deepEqual(selectedRules(direct.select(direct.units()[0].id)), [rootRule, "src/AGENTS.md", ...bRules, expectedCanonicalRule].sort());
  const suffix = contextFor({ suffix: true });
  assert.deepEqual(selectedRules(suffix.select(suffix.units()[0].id)), [rootRule, expectedCanonicalRule, "vendor/AGENTS.md"].sort(), "a captured origin inside a different path does not select its rules");
  const document = contextFor({ document: true });
  assert.deepEqual(selectedRules(document.select(document.units()[0].id)), [...aRules, ...bRules, "src/c/AGENTS.md", "vendor/AGENTS.md", expectedCanonicalRule].sort());
});

for (const availability of ["missing", "unavailable"]) {
  for (const selected of [false, true]) {
    test(`${availability} scoped rules ${selected ? "refuse selected input before provider and durable mutation" : "stay inventoried without blocking unrelated repair"}`, async (t) => {
      const badRule = selected ? "src/a/deep/AGENTS.md" : bRules[1];
      const value = await createSpecGateRepairScenario({ specRecord: specFixture(),
        beforeGate: ({ root }) => repository(root, { [availability]: badRule }) });
      t.after(() => removeTmpDir(value.root));
      const before = snapshot(value);
      let calls = 0;
      const agent = agentFor(value.root, async (prompt, options) => {
        calls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const selection = SpecGateRepairBundle.fromJSON(requestInput(request, "spec-gate-repair-context.json").document.bundle).selections()[0];
        assert.deepEqual(selectedRules(selection), [...aRules].sort());
        const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
        const checkpoint = JSON.parse(value.flowManager.readArtifact({ specId: value.specId, logicalKey: "spec.gate.repair.progress",
          consumerNodeId: "spec-gate-repair", parameters: { attemptId, generation: "0", phase: "checkpoint" } }).bytes.toString("utf8"));
        const sources = SpecGateRepairSourceSnapshots.fromJSON(checkpoint.sourceSnapshots);
        assert.equal(sources.sources().find((source) => source.origin === badRule).availability, availability);
        const input = readSpecGateRepairInput({ flowManager: value.flowManager,
          state: value.flowManager.canonicalState(value.specId), executionRoot: value.root, sourceSnapshots: sources });
        const descriptor = input.context.tableOfContents().find((entry) => entry.source?.origin === "src/b/deep/file.js");
        assert.throws(() => input.context.select(selection.unit.id, { additionalRangeIds: [descriptor.id] }),
          { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" }, "explicit evidence cannot bypass its unavailable rules");
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(repairProposal(selection)));
        sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      });
      const result = await dispatch(value, agent);
      reload(value);
      if (selected) {
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.errors[0].code, "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE", JSON.stringify(result));
        assert.equal(calls, 0);
        assert.deepEqual(snapshot(value), before);
      } else {
        assert.equal(calls, 1, JSON.stringify(result));
        assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify(result));
      }
    });
  }
}

test("tracked missing root rules refuse admission while an unregistered absent root stays optional", async (t) => {
  for (const noRoot of [false, true]) {
    const value = await createSpecGateRepairScenario({ specRecord: specFixture(),
      beforeGate: ({ root }) => repository(root, noRoot ? { noRoot } : { missing: rootRule }) });
    t.after(() => removeTmpDir(value.root));
    const before = snapshot(value);
    const create = () => value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
    if (noRoot) {
      const request = create();
      const selection = SpecGateRepairBundle.fromJSON(request.inputs[0].document.bundle).selections()[0];
      assert.deepEqual(selectedRules(selection), aRules.filter((origin) => origin !== rootRule).sort());
    } else assert.throws(create, { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    assert.deepEqual(snapshot(value), before);
  }
});

// A successful initial admission must not let a subsequent source request bypass
// the newly applicable rules. Publication owns this rejection before new reads.
test("a sealed source expansion with unavailable rules refuses publication and restart without another provider claim", async (t) => {
  const value = await createSpecGateRepairScenario({ specRecord: specFixture(),
    beforeGate: ({ root }) => repository(root, { unavailable: bRules[1] }) });
  t.after(() => removeTmpDir(value.root));
  const input = readSpecGateRepairInput({ flowManager: value.flowManager,
    state: value.flowManager.canonicalState(value.specId), executionRoot: value.root });
  const descriptor = input.context.tableOfContents().find((entry) => entry.source?.origin === "src/b/deep/file.js");
  const request = value.coordinator.createRequest({ ctx: value.ctx,
    state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
  const selection = SpecGateRepairBundle.fromJSON(request.inputs[0].document.bundle).selections()[0];
  assert.deepEqual(selectedRules(selection), [...aRules].sort());
  reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
    version: 1, stage: "spec-gate-repair-context-request", baseRevision: selection.baseRevision,
    unitId: selection.unit.id, additionalRangeIds: [descriptor.id],
  }));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
  const before = snapshot(value);
  const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
  const budget = () => latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
    attemptId, baseRevision: selection.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
  const beforeBudget = budget();
  assert.equal(beforeBudget.providerCallCount, 1);
  for (let readback = 0; readback < 2; readback += 1) {
    reload(value);
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const state = value.flowManager.canonicalState(value.specId);
    const lifecycle = value.flowManager.draftStepExecutionState({ binding: {
      runId: state.runId, specId: value.specId, stepId: "spec-gate-repair", attempt: state.attempt,
    } }).lifecycle;
    assert.equal(lifecycle.phase, "claimed");
    const restored = coordinator.restoreClaimedDraftRequest({ ctx: value.ctx,
      state: value.flowManager.loadReadOnly(value.specId), lifecycle });
    await assert.rejects(() => prepareSpecGateRepairService({ ctx: value.ctx, request: restored,
      handoffCoordinator: coordinator }), { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    assert.deepEqual(snapshot(value), before);
    assert.deepEqual(budget(), beforeBudget);
  }
});
