import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { dispatchContainer, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { CanonicalFlowArtifactWrite } from "../../../src/flow/lib/current-flow-state.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";

async function assertDraftConsumesPreparation(scenario, ready) {
  const manager = scenario.reload();
  const requests = [];
  const agent = { async call(prompt, options) {
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    requests.push({ request, options });
    fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(canonicalDraftDocument()));
    sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
    return "sealed";
  } };
  const ctx = scenario.context();
  ctx.expectBinding = FlowTargetBinding.capture({ flowState: ctx.flowState,
    mainRoot: scenario.root, authorityRoot: scenario.executionRoot }).serialize();
  ctx._envelopeType = "run";
  ctx._envelopeKey = "dispatch";
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
  dispatcher.container = dispatchContainer({ root: scenario.executionRoot, flowManager: manager, agent });
  dispatcher.container.register("mainRoot", scenario.root);
  dispatcher.container.register("inWorktree", true);
  dispatcher.container.register("config", scenario.config);
  const dispatched = await scenario.withEnvironment(() => dispatcher.execute(ctx));
  assert.deepEqual(dispatched.errors.map((entry) => entry.code), ["FLOW_DISPATCH_LIMIT_REACHED"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.executionWorkDir, scenario.executionRoot);
  assert.equal(requests[0].request.runId, scenario.runId);
  assert.equal(requests[0].request.contextSnapshot.entries.find((entry) => entry.kind === "request").document,
    scenario.request);
  assert.deepEqual(requests[0].request.contextSnapshot.entries.find((entry) => entry.kind === "issue").document,
    { number: scenario.issue, body: scenario.issueBody });
  assert.deepEqual(requests[0].request.inputs.find((entry) => entry.document?.id === ready.receipt.id)?.document,
    ready.receipt.toJSON());
  assert.equal(scenario.reload().canonicalState(scenario.specId).findNode("draft").status, "done");
}

function installCountedPreparePlugin(scenario) {
  scenario.installPreparePlugin({ observeInvocation: true });
  const invocationLog = path.join(scenario.root, ".tmp", "prepare-plugin-calls");
  const pluginPath = path.join(scenario.root, ".sennel", "plugins", "prepare-observer", "hooks", "prepare.js");
  fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace("async run(context) {",
    `async run(context) { fs.appendFileSync(${JSON.stringify(invocationLog)}, "called\\n");`));
  return { invocationLog, pluginPath };
}

// Durable branch publication -> dead journal owner -> authenticated public
// recovery -> mandatory publication -> real Draft consumer. The child changes
// only the commit-response/read boundary; all saved facts come from production.
it("worktree retry preserves a committed branch after response and receipt acknowledgement loss", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
  const { invocationLog } = installCountedPreparePlugin(scenario);
  await scenario.initialize();
  const managerModule = new URL("../../../src/lib/flow-manager.js", import.meta.url).href;
  const commandModule = new URL("../../../src/flow/lib/run-prepare-spec.js", import.meta.url).href;
  const storeModule = new URL("../../../src/flow/lib/current-flow-state.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    `import { FlowManager } from ${JSON.stringify(managerModule)};`,
    `import RunPrepareSpecCommand from ${JSON.stringify(commandModule)};`,
    `import { CurrentFlowVersionStore } from ${JSON.stringify(storeModule)};`,
    `const input = ${JSON.stringify(scenario.prepareInput())};`,
    "const originalApply = CurrentFlowVersionStore.prototype.apply;",
    "const originalRead = FlowManager.prototype.findStepSettlementReceipt;",
    "let commits = 0; let receiptReads = 0;",
    "CurrentFlowVersionStore.prototype.apply = function (input) {",
    "const result = originalApply.call(this, input);",
    'if (input.activity?.result?.stepResult?.kind === "branch-prepared") {',
    'commits++; throw new Error("lost committed branch response"); } return result; };',
    "FlowManager.prototype.findStepSettlementReceipt = function (input) {",
    'if (commits && input.binding?.stepId === "branch") {',
    'receiptReads++; throw new Error("branch receipt temporarily unreadable"); }',
    "return originalRead.call(this, input); };",
    "const flowManager = new FlowManager({ root: input.root, mainRoot: input.mainRoot, inWorktree: false });",
    "try { await new RunPrepareSpecCommand().execute({ ...input, flowManager }); }",
    "catch (error) { process.stdout.write(JSON.stringify({ commits, receiptReads, error: error.message })); process.exit(73); }",
    'throw new Error("expected branch acknowledgement loss");',
  ].join("\n")], { cwd: scenario.root, env: scenario.environment(scenario.root),
    encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error, undefined, child.error?.stack);
  assert.equal(child.status, 73, child.stderr || child.stdout);
  const fault = JSON.parse(child.stdout);
  assert.equal(fault.commits, 1);
  assert.equal(fault.receiptReads, 1);
  const journalPath = path.join(scenario.root, ".sennel", ".worktree-prepare-attempt.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(new ProcessIdentitySource().assess(journal.processIdentity).status, "stale");
  scenario.specId = journal.specId;
  const first = scenario.reload();
  const branch = first.readCurrentStepSettlement({ specId: scenario.specId, stepId: "branch", completed: true });
  assert.equal(branch.result.kind, "branch-prepared");
  const branchReceipt = branch.receipt.toJSON();
  assert.equal(first.canonicalState(scenario.specId).findNode("prepare-spec").status, "in_progress");
  assert.equal(first.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
  assert.equal(fs.existsSync(scenario.preparePluginInvocationPath), false);
  assert.equal(fs.existsSync(invocationLog), false);
  assert.equal(fs.existsSync(path.join(journal.worktreePath, ".sennel", "output", "analysis.json")), false);
  const gitPublication = scenario.git(["worktree", "list", "--porcelain"]);
  // Drop the original manager and command result; recovery only sees persisted authorities.
  scenario.flowManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
  const resumed = await scenario.prepare();
  assert.equal(resumed.result, "ok");
  assert.equal(resumed.specId, journal.specId);
  assert.equal(resumed.worktreePath, journal.worktreePath);
  assert.equal(scenario.git(["worktree", "list", "--porcelain"]), gitPublication);
  const manager = scenario.reload();
  const replay = manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "branch", completed: true });
  assert.equal(replay.activityId, branch.activityId);
  assert.deepEqual(replay.receipt.toJSON(), branchReceipt);
  assert.equal(manager.activityLedger(scenario.specId).filter((entry) =>
    entry.result?.stepResult?.kind === "branch-prepared").length, 1);
  const plugins = manager.artifactCatalog(scenario.specId).artifacts.filter((entry) =>
    entry.logicalKey === "plugin.lifecycle.artifact");
  assert.equal(plugins.length, 1);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "called\n");
  assert.equal(manager.activityLedger(scenario.specId).filter((entry) => entry.id === plugins[0].activityId).length, 1);
  const ready = manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "prepare-spec", completed: true });
  assert.equal(ready.result.kind, "prepare-spec-ready");
  assert.equal(manager.loadPreparingFlow(scenario.runId), null);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(new RepositoryFlowOperationLock({ mainRoot: scenario.root }).lock.inspect(), null);
  assert.equal(manager.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
  await assertDraftConsumesPreparation(scenario, ready);
});

// A saved plugin artifact is a publication identity, not a lifecycle-completion
// receipt: required hooks run again, while identical bytes reuse that identity.
for (const changed of [false, true]) {
  it(`worktree restart after plugin commit ${changed ? "refuses changed publication without mutation" : "reuses exact publication and reruns required hooks"}`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
    const { invocationLog } = installCountedPreparePlugin(scenario);
    await scenario.initialize();
    const managerModule = new URL("../../../src/lib/flow-manager.js", import.meta.url).href;
    const commandModule = new URL("../../../src/flow/lib/run-prepare-spec.js", import.meta.url).href;
    const storeModule = new URL("../../../src/flow/lib/current-flow-state.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
      `import { FlowManager } from ${JSON.stringify(managerModule)};`,
      `import RunPrepareSpecCommand from ${JSON.stringify(commandModule)};`,
      `import { CurrentFlowVersionStore } from ${JSON.stringify(storeModule)};`,
      `const input = ${JSON.stringify(scenario.prepareInput())};`,
      "const original = CurrentFlowVersionStore.prototype.apply;",
      "CurrentFlowVersionStore.prototype.apply = function (input) {",
      "const result = original.call(this, input);",
      'if (input.activity?.transition?.operation === "publish_plugin_artifacts") {',
      "process.stdout.write(JSON.stringify({ specId: this.location.specId.toString(), activityId: input.activity.id }));",
      "process.exit(73); } return result; };",
      "const flowManager = new FlowManager({ root: input.root, mainRoot: input.mainRoot, inWorktree: false });",
      "await new RunPrepareSpecCommand().execute({ ...input, flowManager });",
      'throw new Error("expected interruption after canonical plugin publication");',
    ].join("\n")], { cwd: scenario.root, env: scenario.environment(scenario.root), encoding: "utf8", timeout: 30_000 });
    assert.equal(child.error, undefined, child.error?.stack);
    assert.equal(child.status, 73, child.stderr || child.stdout);
    const publication = JSON.parse(child.stdout);
    scenario.specId = publication.specId;
    const journalPath = path.join(scenario.root, ".sennel", ".worktree-prepare-attempt.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.equal(new ProcessIdentitySource().assess(journal.processIdentity).status, "stale");
    const manager = scenario.reload();
    const branch = manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "branch", completed: true });
    const pluginDescriptors = manager.artifactCatalog(scenario.specId).artifacts.filter((entry) =>
      entry.logicalKey === "plugin.lifecycle.artifact").map((entry) => entry.toJSON());
    assert.equal(pluginDescriptors.length, 1);
    assert.equal(pluginDescriptors[0].activityId, publication.activityId);
    assert.equal(manager.canonicalState(scenario.specId).findNode("prepare-spec").result, null);
    assert.equal(fs.readFileSync(invocationLog, "utf8"), "called\n");
    const canonicalBytes = () => ["flow.state", "flow.activities", "artifact.catalog"].map((key) =>
      fs.readFileSync(manager.specLocation(scenario.specId).artifact(key)));
    const canonicalBefore = canonicalBytes();
    const gitBefore = scenario.git(["worktree", "list", "--porcelain"]);
    const pluginBytesBefore = fs.readFileSync(path.join(manager.specLocation(scenario.specId).directory,
      pluginDescriptors[0].relativePath));
    if (changed) {
      const pluginPath = path.join(journal.worktreePath, ".sennel", "plugins", "prepare-observer", "hooks", "prepare.js");
      fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace("request: context.flow.request,",
        'request: `${context.flow.request} changed`, '));
    }
    scenario.flowManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
    if (changed) {
      await assert.rejects(() => scenario.prepare(), StepAdmissionRefusal);
      assert.throws(() => manager.publishPluginArtifacts({ specId: scenario.specId,
        preparationReceipt: branch.receipt, artifactWrites: [] }), StepAdmissionRefusal);
      assert.deepEqual(canonicalBytes(), canonicalBefore, "an omitted saved plugin publication must refuse without mutation");
      assert.deepEqual(canonicalBytes(), canonicalBefore);
      assert.equal(scenario.git(["worktree", "list", "--porcelain"]), gitBefore);
      assert.deepEqual(fs.readFileSync(path.join(manager.specLocation(scenario.specId).directory,
        pluginDescriptors[0].relativePath)), pluginBytesBefore);
      assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).attemptId, journal.attemptId);
      assert.notEqual(scenario.reload().loadPreparingFlow(scenario.runId), null);
      assert.equal(manager.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
      assert.equal(fs.existsSync(path.join(scenario.root, ".tmp", "unexpected-agent-calls")), false);
    } else {
      const resumed = await scenario.prepare();
      assert.equal(resumed.specId, journal.specId);
      assert.equal(resumed.worktreePath, journal.worktreePath);
      const reloaded = scenario.reload();
      const replayBranch = reloaded.readCurrentStepSettlement({ specId: scenario.specId, stepId: "branch", completed: true });
      assert.equal(replayBranch.activityId, branch.activityId);
      assert.deepEqual(replayBranch.receipt.toJSON(), branch.receipt.toJSON());
      assert.deepEqual(reloaded.artifactCatalog(scenario.specId).artifacts.filter((entry) =>
        entry.logicalKey === "plugin.lifecycle.artifact").map((entry) => entry.toJSON()), pluginDescriptors);
      assert.equal(reloaded.activityLedger(scenario.specId).filter((entry) =>
        entry.transition.operation === "publish_plugin_artifacts").length, 1);
      assert.equal(scenario.git(["worktree", "list", "--porcelain"]), gitBefore);
      const ready = reloaded.readCurrentStepSettlement({ specId: scenario.specId, stepId: "prepare-spec", completed: true });
      assert.deepEqual(ready.receipt.preparation.mandatory.plugins, pluginDescriptors);
      await assertDraftConsumesPreparation(scenario, ready);
      const completedBytes = canonicalBytes();
      assert.throws(() => reloaded.publishPluginArtifacts({ specId: scenario.specId,
        preparationReceipt: branch.receipt, artifactWrites: [new CanonicalFlowArtifactWrite({
          logicalKey: pluginDescriptors[0].logicalKey,
          parameters: { pluginArtifactPath: "prepare-observer/prepare-seen.json" },
          mediaType: pluginDescriptors[0].mediaType,
          bytes: pluginBytesBefore,
        })] }), StepAdmissionRefusal);
      assert.deepEqual(canonicalBytes(), completedBytes, "a completed preparation cannot publish through an old branch receipt");
    }
    assert.equal(fs.readFileSync(invocationLog, "utf8"), "called\ncalled\n",
      "artifact replay must still execute the required hook lifecycle again");
  });
}
