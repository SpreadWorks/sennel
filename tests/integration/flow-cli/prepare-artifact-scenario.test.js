import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { dispatchContainer, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { assertCanonicalStepResult } from "../../support/infrastructure/canonical-step-result.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { StepResult, StepErrorResult, stepResultDigest } from "../../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt } from "../../../src/flow/definition.js";
import * as Definition from "../../../src/flow/definition.js";
import { CurrentFlowVersionStore } from "../../../src/flow/lib/current-flow-state.js";
import { WorktreeFlowBindingStore } from "../../../src/lib/worktree-flow-binding.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";

function journalRecord(scenario) {
  const file = path.join(scenario.root, ".sennel", ".worktree-prepare-attempt.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function assertNoWorker(scenario) {
  assert.equal(fs.existsSync(path.join(scenario.root, ".tmp", "unexpected-agent-calls")), false);
}

function canonicalBytes(scenario) {
  const location = scenario.flowManager.specLocation(scenario.specId);
  return ["flow.state", "flow.activities", "artifact.catalog"].map((key) => (
    fs.readFileSync(location.artifact(key))
  ));
}

/** Fault only the real publication and acknowledgement of one Prepare Result. */
class PreparePublicationFault {
  #scenario;
  #stepId;
  #kind;
  #fault;
  #failure;
  #receiptFailure;
  #once;
  #apply;
  #read;
  #mocks = [];
  #reached = false;
  #commits = 0;
  #receiptReads = 0;
  #before = null;
  #committed = null;
  #receiptInput = null;
  #readerManager = null;
  #journalAtPublication = null;
  #worktreesAtCommit = null;

  constructor(t, { scenario, stepId, kind, fault, failure,
    receiptFailure = new Error("durable receipt temporarily unreadable"), once = false }) {
    assert.ok(({ branch: ["branch-prepared", "branch-not-required"],
      "prepare-spec": ["prepare-spec-ready"] })[stepId]?.includes(kind),
    "publication fault must target a known Prepare Step/Result contract");
    assert.ok(["before-commit", "lost-response", "receipt-read-failure"].includes(fault));
    assert.ok(failure instanceof Error);
    assert.ok(receiptFailure instanceof Error);
    assert.equal(typeof once, "boolean");
    this.#scenario = scenario;
    this.#stepId = stepId;
    this.#kind = kind;
    this.#fault = fault;
    this.#failure = failure;
    this.#receiptFailure = receiptFailure;
    this.#once = once;
    this.#apply = CurrentFlowVersionStore.prototype.apply;
    this.#read = FlowManager.prototype.findStepSettlementReceipt;
    t.after(() => this.restore());
    const injector = this;
    this.#mocks.push(t.mock.method(CurrentFlowVersionStore.prototype, "apply", function (input) {
      return injector.#publish(this, input);
    }));
    this.#mocks.push(t.mock.method(FlowManager.prototype, "findStepSettlementReceipt", function (input) {
      return injector.#acknowledge(this, input);
    }));
  }

  get reached() { return this.#reached; }
  get commits() { return this.#commits; }
  get receiptReads() { return this.#receiptReads; }
  get before() { return this.#before; }
  get committed() { return this.#committed; }
  get receiptInput() { return this.#receiptInput; }
  get readerManager() { return this.#readerManager; }
  get journalAtPublication() { return this.#journalAtPublication; }
  get worktreesAtCommit() { return this.#worktreesAtCommit; }

  #publish(store, input) {
    if (input.activity?.nodeId !== this.#stepId
      || input.activity?.result?.stepResult?.kind !== this.#kind
      || (this.#once && this.#commits > 0)) return this.#apply.call(store, input);
    this.#reached = true;
    this.#scenario.specId = store.location.specId;
    if (this.#scenario.mode === "worktree") {
      this.#journalAtPublication = journalRecord(this.#scenario);
      if (this.#journalAtPublication !== null) {
        this.#scenario.executionRoot = this.#journalAtPublication.worktreePath;
      }
    }
    this.#before = canonicalBytes(this.#scenario);
    if (this.#fault === "before-commit") throw this.#failure;
    this.#apply.call(store, input);
    this.#commits += 1;
    this.#committed = canonicalBytes(this.#scenario);
    if (this.#scenario.mode === "worktree") {
      this.#worktreesAtCommit = this.#scenario.git(["worktree", "list", "--porcelain"]);
    }
    throw this.#failure;
  }

  #acknowledge(manager, input) {
    if (this.#commits === 0 || input.binding?.stepId !== this.#stepId) return this.#read.call(manager, input);
    this.#receiptReads += 1;
    this.#receiptInput = input;
    this.#readerManager = manager;
    if (this.#fault === "receipt-read-failure") throw this.#receiptFailure;
    return this.#read.call(manager, input);
  }

  readReceipt(input, manager = this.#readerManager) {
    return this.#read.call(manager, input);
  }

  restore() {
    for (const mocked of this.#mocks.splice(0).reverse()) mocked.mock.restore();
  }
}

function boundaryInputWithChangedField(value, field, replacement) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.ok(Object.hasOwn(descriptors, field), `observed typed input must own ${field}`);
  descriptors[field] = { ...descriptors[field], value: replacement };
  return Object.create(Object.getPrototypeOf(value), descriptors);
}

/** Observe the real Draft consumer at the sole external worker boundary. */
async function startDraft(scenario) {
  const requests = [];
  const agent = { async call(prompt, options) {
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    requests.push({ request,
      requestPath, prompt, options });
    fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(
      canonicalDraftDocument({ goal: "Carry the preparation request into Draft." })));
    sealWorkerArtifactHandoff({ requestPath,
      invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
    return "sealed";
  } };
  const manager = scenario.reload();
  const ctx = scenario.context();
  ctx.expectBinding = FlowTargetBinding.capture({ flowState: ctx.flowState,
    mainRoot: scenario.root, authorityRoot: scenario.executionRoot }).serialize();
  ctx._envelopeType = "run";
  ctx._envelopeKey = "dispatch";
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
  dispatcher.container = dispatchContainer({ root: scenario.executionRoot, flowManager: manager, agent });
  dispatcher.container.register("mainRoot", scenario.root);
  dispatcher.container.register("inWorktree", scenario.mode === "worktree");
  dispatcher.container.register("config", scenario.config);
  const result = await scenario.withEnvironment(() => dispatcher.execute(ctx));
  return { result, requests };
}

function assertPreparedDraftInput(scenario, requests, receipt) {
  assert.equal(requests.length, 1);
  const { request, options } = requests[0];
  assert.equal(options.executionWorkDir, scenario.executionRoot);
  assert.equal(request.stepId, "draft");
  assert.equal(request.runId, scenario.runId);
  assert.equal(request.specId, scenario.specId);
  assert.equal(request.contextSnapshot.entries.find((entry) => entry.kind === "request").document,
    scenario.request);
  assert.ok(request.inputs.some((input) => isDeepStrictEqual(input.document, receipt)),
    "the persisted preparation receipt must reach the actual Draft input");
}

function savedPreparation(scenario, stepId, kind, targetStepId) {
  const state = scenario.reload().canonicalState(scenario.specId);
  const node = state.findNode(stepId);
  assert.equal(node.result?.stepResult?.kind, kind,
    `${stepId} must save its registered semantic Result; a status-only completion is insufficient`);
  assert.equal(node.result.stepResult.type, "completed");
  const restored = assertCanonicalStepResult(node.result, { stepId, kind, type: "completed" });
  assert.equal(restored.constructor.name, {
    "branch-prepared": "BranchPreparedResult", "branch-not-required": "BranchNotRequiredResult",
    "prepare-spec-ready": "PrepareSpecReadyResult",
  }[kind]);
  assert.equal(typeof Definition.settlePrepareStepResult, "function",
    "Definition must select preparation settlement from the persisted Result alone");
  const settlement = Definition.settlePrepareStepResult(stepId, restored);
  assert.ok(settlement instanceof Definition.StepRoute);
  assert.equal(settlement.targetStepId, targetStepId);
  const activities = scenario.flowManager.activityLedger(scenario.specId);
  const publications = activities.filter((activity) => activity.nodeId === stepId
    && activity.result?.stepResult?.kind === kind);
  assert.equal(publications.length, 1, "the producer must commit one Result/receipt Activity");
  const activity = publications[0];
  // Existing shared Store representation and its production receipt validator;
  // do not invent a preparation-specific receipt reader or parallel registry.
  const receipt = DraftStepSettlementReceipt.assertStored(activity.result.draftSettlementReceipt, {
    binding: { runId: scenario.runId, specId: scenario.specId, stepId,
      attempt: { id: activity.attemptId, sequence: activity.sequence } }, result: restored, settlement,
  });
  assert.deepEqual(receipt, node.result.draftSettlementReceipt.toJSON());
  assert.equal(receipt.targetStepId, targetStepId);
  assert.equal(receipt.settlementKind, "target-connection");
  assert.equal(receipt.resultDigest, stepResultDigest(restored));
  assert.match(receipt.publicationDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.binding.runId, scenario.runId);
  assert.equal(receipt.binding.specId, scenario.specId);
  assert.equal(receipt.binding.attemptSequence, 1);
  assert.equal(typeof receipt.binding.attemptId, "string");
  assert.notEqual(receipt.binding.attemptId, "");
  const catalog = scenario.flowManager.artifactCatalog(scenario.specId);
  for (const entry of catalog.artifacts) {
    if (entry.activityId !== null) assert.ok(activities.some((candidate) => candidate.id === entry.activityId),
      `${entry.logicalKey} must name a real confirmed Activity`);
  }
  const creation = activities[0];
  const immutableCreationArtifacts = catalog.artifacts.filter((entry) => (
    ["spec.record", "spec.snapshot", "issue.snapshot"].includes(entry.logicalKey)
      && entry.activityId === creation.id
  )).map((entry) => entry.toJSON?.() ?? entry);
  const analysisBytes = stepId === "prepare-spec"
    ? fs.readFileSync(path.join(scenario.executionRoot, ".sennel", "output", "analysis.json")) : null;
  const mode = state.execution.mode;
  const pluginArtifacts = catalog.artifacts.filter((entry) => entry.logicalKey === "plugin.lifecycle.artifact")
    .map((entry) => entry.toJSON?.() ?? entry);
  const bindingIdentity = mode === "worktree" && stepId === "prepare-spec"
    ? new WorktreeFlowBindingStore({ worktreePath: scenario.executionRoot }).load().toJSON() : null;
  // f72f's additive shared-receipt serialization contract. Expectations come
  // from real Git, canonical creation artifacts and mandatory output readback.
  // Branch cannot claim evidence of mandatory work that has not happened yet.
  assert.deepEqual(receipt.preparation, {
    mode, baseOid: scenario.baseOid,
    branch: mode === "direct" ? null : state.execution.featureBranch,
    worktree: mode === "worktree" ? scenario.executionRoot : null,
    creationActivityId: creation.id, catalog: immutableCreationArtifacts,
    request: scenario.request,
    issueSnapshot: scenario.issue === null ? null : { number: scenario.issue, body: scenario.issueBody },
    mandatory: stepId === "branch" ? null : {
      plugins: pluginArtifacts, analysis: { hash: crypto.createHash("sha256").update(analysisBytes).digest("hex"), size: analysisBytes.length },
    },
    bindingIdentity,
  });
  return receipt;
}

function savedBranchBeforeMandatory(scenario, kind) {
  const receipt = savedPreparation(scenario, "branch", kind, "prepare-spec");
  const state = scenario.flowManager.canonicalState(scenario.specId);
  assert.equal(state.findNode("branch").status, "done");
  assert.equal(state.findNode("prepare-spec").status, "in_progress",
    "branch publication must atomically activate its normal preparation target");
  assert.equal(state.nextAction().nodeId, "prepare-spec");
  assert.equal(state.findNode("prepare-spec").result, null,
    "mandatory evidence must precede the preparation Result");
  assert.equal(state.findNode("draft").attemptSequence, 0);
  assert.equal(state.findNode("draft").result, null);
  return receipt;
}

for (const mode of ["branch", "worktree", "no-branch"]) {
  for (const issue of [null, 472]) {
    it(`P01 ${mode} Issue=${issue}: real CLI preparation reloads into the actual Draft consumer`, async (t) => {
      const scenario = PrepareArtifactScenario.create(t, { mode, issue });
      const initialized = await scenario.initialize({ cli: true });
      assert.equal(initialized.request, scenario.request);
      assert.equal(scenario.flowManager.loadPreparingFlow(scenario.runId).request, scenario.request);
      assert.equal(fs.existsSync(path.join(scenario.root, "specs")), false,
        "preparing has no canonical Step Attempt or fresh root");
      await scenario.prepare({ cli: true });
      const preparedState = scenario.reload().loadReadOnly(scenario.specId);
      assert.equal(preparedState.request, scenario.request);
      assert.deepEqual(preparedState.execution, {
        mode: mode === "no-branch" ? "direct" : mode, baseBranch: "main",
        featureBranch: mode === "no-branch" ? null : scenario.prepared.artifacts.branch,
      });
      assert.equal(scenario.git(["rev-parse", "HEAD"], scenario.executionRoot).trim(), scenario.baseOid);
      const catalog = scenario.flowManager.artifactCatalog(scenario.specId);
      const creation = scenario.flowManager.activityLedger(scenario.specId)[0];
      assert.ok(catalog.artifacts.some((entry) => entry.logicalKey === "spec.record"
        && entry.activityId === creation.id), "fresh spec and creation Activity must share a publication");
      const snapshot = scenario.flowManager.readArtifact({ specId: scenario.specId,
        logicalKey: "issue.snapshot", consumerNodeId: "draft", optional: true });
      assert.equal(snapshot === null ? null : snapshot.bytes.toString("utf8"), issue === null ? null : `${scenario.issueBody}\n`);
      if (snapshot !== null) assert.equal(snapshot.descriptor.activityId, creation.id);
      const analysis = JSON.parse(fs.readFileSync(path.join(scenario.executionRoot, ".sennel", "output", "analysis.json"), "utf8"));
      assert.equal(typeof analysis, "object", "mandatory analysis must have actual stored output");
      if (mode === "worktree") {
        const binding = new WorktreeFlowBindingStore({ worktreePath: scenario.executionRoot }).load();
        assert.equal(binding.runId, scenario.runId);
        assert.equal(binding.issue, issue);
        assert.equal(binding.specId, scenario.specId);
        assert.equal(binding.worktreePath, scenario.executionRoot);
      }
      const next = scenario.expectSuccess(scenario.cli([
        "get", "next-action", "--expect-run-id", scenario.runId, "--expect-spec", scenario.specId,
      ]));
      assert.equal(next.step, "draft");
      const { result, requests } = await startDraft(scenario);
      const branch = savedPreparation(scenario, "branch",
        mode === "no-branch" ? "branch-not-required" : "branch-prepared", "prepare-spec");
      const prepare = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
      assertPreparedDraftInput(scenario, requests, prepare);
      const { request, requestPath } = requests[0];
      assert.equal(request.issue, issue);
      assert.ok(requestPath.startsWith(`${scenario.executionRoot}${path.sep}`));
      const entries = request.contextSnapshot.entries;
      const issueEntry = entries.find((entry) => entry.kind === "issue");
      assert.deepEqual(issueEntry.status === "omitted" ? issueEntry : issueEntry.document,
        issue === null ? { kind: "issue", status: "omitted", reason: "no-linked-issue" }
          : { number: issue, body: scenario.issueBody });
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors.map((entry) => entry.code), ["FLOW_DISPATCH_LIMIT_REACHED"]);
      assert.equal(scenario.reload().canonicalState(scenario.specId).findNode("draft").status, "done");
      assert.notEqual(branch.binding.attemptId, prepare.binding.attemptId);
      assert.equal(request.contextSnapshot.binding.runId, prepare.binding.runId);
    });
  }
}

it("P02 stable preparation Action identity survives manager disposal, reread and clock advance", async (t) => {
  const scenario = PrepareArtifactScenario.create(t);
  await scenario.initialize();
  await scenario.prepare();
  scenario.expectSuccess(scenario.cli(["get", "next-action", "--expect-run-id", scenario.runId]));
  const session = new FlowDispatchSession({ target: new FlowDispatchTarget({
    expectation: new FlowTargetExpectation({ expectRunId: scenario.runId, expectSpec: scenario.specId }),
  }) });
  const capture = async () => {
    scenario.reload();
    const action = await new GetNextActionCommand().execute(scenario.context());
    assert.equal(action.step, "draft");
    return session.captureAction(action, scenario.baseOid).digest;
  };
  const first = await capture();
  const before = scenario.flowManager.canonicalState(scenario.specId).toJSON();
  const ActualDate = Date;
  const clock = t.mock.method(globalThis, "Date", class extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [2_000_000_000_000])); }
    static now() { return 2_000_000_000_000; }
  });
  assert.equal(await capture(), first);
  assert.equal(await capture(), first);
  clock.mock.restore();
  assert.deepEqual(scenario.reload().canonicalState(scenario.specId).toJSON(), before);
});

for (const [name, overrides, message] of [
  ["run", { runId: "another-preparing-run" }, /preparing|run/i],
  ["Issue", { issue: 473 }, /issue/i],
  ["request", { request: "A different request" }, /request/i],
]) {
  it(`P03 rejects ${name} mismatch before creating any canonical Attempt`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
    await scenario.initialize();
    const before = scenario.flowManager.loadPreparingFlow(scenario.runId);
    await assert.rejects(scenario.prepare(overrides), message);
    assert.deepEqual(scenario.reload().loadPreparingFlow(scenario.runId), before);
    assert.equal(fs.existsSync(path.join(scenario.root, "specs")), false);
    assert.equal(journalRecord(scenario), null);
    assert.equal(scenario.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm).length, 1);
    assertNoWorker(scenario);
  });
}

it("P04 dirty branch refuses Git preparation without canonical Attempt or branch side effects", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "branch" });
  await scenario.initialize();
  fs.appendFileSync(path.join(scenario.root, "README.md"), "uncommitted user content\n");
  const branches = scenario.git(["branch", "--format=%(refname)"]);
  await assert.rejects(scenario.prepare(), /dirty worktree/);
  assert.equal(scenario.git(["branch", "--format=%(refname)"]), branches);
  assert.equal(fs.existsSync(path.join(scenario.root, "specs")), false);
  assert.notEqual(scenario.reload().loadPreparingFlow(scenario.runId), null);
  assertNoWorker(scenario);
});

it("P05 uncommitted required config refuses worktree publication without canonical Attempt", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
  await scenario.initialize();
  fs.writeFileSync(path.join(scenario.root, ".sennel", "config.json"), JSON.stringify({ ...scenario.config, lang: "ja" }));
  const result = await scenario.prepare();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "REQUIRED_WORKTREE_FILES_UNREFLECTED");
  assert.equal(fs.existsSync(path.join(scenario.root, "specs")), false);
  assert.equal(journalRecord(scenario), null);
  assertNoWorker(scenario);
});

for (const checkpoint of ["after-journal-publication", "after-worktree-add", "after-exclusion-registration"]) {
  it(`P06 ${checkpoint} interruption rolls back owned preparation and permits a fresh reload/retry`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
    await scenario.initialize();
    const before = scenario.flowManager.loadPreparingFlow(scenario.runId);
    const failure = new Error(`stop:${checkpoint}`);
    let stopped = null;
    await assert.rejects(scenario.prepare({ worktreePrepareFaultInjector(event) {
      if (event.phase !== checkpoint) return;
      stopped = event;
      assert.equal(fs.existsSync(path.join(scenario.root, "specs", event.specId)), false);
      const journal = journalRecord(scenario);
      assert.equal(journal.runId, scenario.runId);
      assert.equal(journal.expectedOid, scenario.baseOid);
      throw failure;
    } }), (error) => error === failure);
    assert.notEqual(stopped, null);
    assert.equal(fs.existsSync(stopped.worktreePath), false);
    assert.equal(journalRecord(scenario), null);
    assert.deepEqual(scenario.reload().loadPreparingFlow(scenario.runId), before);
    assert.equal(scenario.git(["branch", "--list", stopped.branchName]), "");
    await scenario.prepare();
    assert.equal(scenario.specId, stopped.specId);
    assert.equal(scenario.reload().loadReadOnly(scenario.specId).runId, scenario.runId);
    savedPreparation(scenario, "branch", "branch-prepared", "prepare-spec");
  });
}

it("P07 mandatory analysis and binding are required before prepare becomes terminal", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
  scenario.installPreparePlugin({ observeInvocation: true });
  await scenario.initialize();
  const failure = new Error("stop before mandatory completion");
  let checkpointState;
  let pluginInvocation = null;
  let pluginInvocationCount = 0;
  let canonicalInvocationFlow = null;
  let branchAtPluginInvocation = null;
  let pluginInvocationError = null;
  const writeFile = fs.writeFileSync;
  // The real hook's first statement exposes its actual invocation input.
  // Observe before the original marker write and all real hook effects; the
  // command snapshot is used only to locate the canonical authority.
  const invocationObserver = t.mock.method(fs, "writeFileSync", function (file, value, ...args) {
    if (file === scenario.preparePluginInvocationPath) {
      pluginInvocationCount += 1;
      pluginInvocation = JSON.parse(value);
      scenario.specId = pluginInvocation.flow.specId;
      scenario.executionRoot = pluginInvocation.projectRoot;
      try {
        canonicalInvocationFlow = scenario.reload().canonicalState(scenario.specId);
        branchAtPluginInvocation = savedBranchBeforeMandatory(scenario, "branch-prepared");
      }
      catch (error) { pluginInvocationError = error; }
    }
    return writeFile.call(this, file, value, ...args);
  });
  const outcome = await scenario.prepare({ worktreePrepareFaultInjector(event) {
    if (event.phase !== "after-planning-state-publication") return;
    const reloaded = new FlowManager({ root: event.worktreePath, mainRoot: scenario.root,
      inWorktree: true, specId: event.specId });
    checkpointState = reloaded.canonicalState(event.specId).toJSON();
    scenario.specId = event.specId;
    scenario.executionRoot = event.worktreePath;
    savedBranchBeforeMandatory(scenario, "branch-prepared");
    throw failure;
  } }).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
  invocationObserver.mock.restore();
  assert.equal(pluginInvocationCount, 1, "the real required plugin must be invoked once before this checkpoint");
  assert.notEqual(pluginInvocation, null, "the real required plugin must receive its invocation input");
  assert.notEqual(canonicalInvocationFlow, null, "required plugin invocation must have an authoritative canonical source");
  assert.equal(pluginInvocation.projectRoot, scenario.executionRoot);
  assert.equal(pluginInvocation.flow.runId, canonicalInvocationFlow.runId);
  assert.equal(pluginInvocation.flow.specId, canonicalInvocationFlow.specId);
  assert.equal(pluginInvocation.flow.request, canonicalInvocationFlow.request);
  assert.equal(fs.existsSync(scenario.preparePluginInvocationPath), true,
    "observation must delegate the original marker write and real hook execution");
  if (pluginInvocationError !== null) throw pluginInvocationError;
  assert.notEqual(branchAtPluginInvocation, null,
    "the branch Result, receipt and normal target must precede required plugin invocation");
  if (outcome.error instanceof assert.AssertionError) throw outcome.error;
  assert.equal(outcome.error, failure);
  assert.notEqual(checkpointState, undefined);
  // Traverse the serialized canonical node tree without constructing state.
  const collect = (value) => value && typeof value === "object"
    ? [value, ...Object.values(value).flatMap(collect)] : [];
  const prepare = collect(checkpointState).find((value) => value.id === "prepare-spec");
  assert.notEqual(prepare, undefined);
  assert.notEqual(prepare.status, "done", "mandatory work cannot be represented by a completed preparation");
  assert.equal(prepare.result, null);
  assert.equal(collect(checkpointState).some((value) => value.nodeId === "draft" && value.attemptId), false);
});

it("P08 fresh reload retains PrepareSpecReadyResult and its source-bound Draft connection", async (t) => {
  const scenario = PrepareArtifactScenario.create(t);
  await scenario.initialize();
  await scenario.prepare();
  const receipt = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
  const before = canonicalBytes(scenario);
  assert.deepEqual(savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft"), receipt);
  assert.deepEqual(canonicalBytes(scenario), before);
  assert.equal(scenario.flowManager.canonicalState(scenario.specId).nextAction().nodeId, "draft");
});

it("P09 exact completed prepare replay returns the existing publication without another Activity", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
  await scenario.initialize();
  await scenario.prepare();
  const before = canonicalBytes(scenario);
  const specId = scenario.specId;
  // Resume the same public prepare operation from its main-repository entry.
  scenario.flowManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
  let replay;
  let failure = null;
  try { replay = await scenario.prepare(); } catch (error) { failure = error; }
  assert.equal(failure, null, "the exact completed operation must read back its durable receipt");
  assert.equal(replay.specId, specId);
  assert.equal(replay.runId, scenario.runId);
  scenario.reload();
  assert.deepEqual(canonicalBytes(scenario), before);
  savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
});

for (const [name, changed] of [
  ["mode", { noBranch: true, worktree: false }],
  ["base", { base: "other-base" }],
]) {
  it(`P10 completed replay with different ${name} refuses before changing publication or Git`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
    scenario.git(["branch", "other-base"]);
    if (name === "base") {
      scenario.git(["checkout", "other-base"]);
      scenario.git(["commit", "--allow-empty", "-m", "Distinct replay base"]);
      scenario.git(["checkout", "main"]);
      assert.notEqual(scenario.git(["rev-parse", "other-base"]).trim(), scenario.baseOid);
    }
    await scenario.initialize();
    await scenario.prepare();
    const before = canonicalBytes(scenario);
    const worktrees = scenario.git(["worktree", "list", "--porcelain"]);
    scenario.flowManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
    await assert.rejects(scenario.prepare(changed), /run|prepar|mode|base|conflict/i);
    scenario.reload();
    assert.deepEqual(canonicalBytes(scenario), before);
    assert.equal(scenario.git(["worktree", "list", "--porcelain"]), worktrees);
    assertNoWorker(scenario);
  });
}

for (const fault of ["required-hook", "analysis", "binding", "active-registration"]) {
  it(`P11 ${fault} failure leaves Draft unclaimed and starts zero workers`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
    if (fault === "required-hook") scenario.installPreparePlugin({ fail: true });
    await scenario.initialize();
    const failure = new Error(`mandatory ${fault} unavailable`);
    let observed = false;
    let stoppedState = null;
    if (fault === "active-registration") {
      const original = FlowManager.prototype.addActiveFlow;
      t.mock.method(FlowManager.prototype, "addActiveFlow", function (specId, mode, options) {
        if (this._mainRoot !== scenario.root) return original.call(this, specId, mode, options);
        observed = true;
        stoppedState = this.canonicalState(specId);
        throw failure;
      });
    }
    const result = await scenario.prepare({
      worktreePrepareFaultInjector(event) {
        if (event.phase !== "after-planning-state-publication") return;
        const manager = new FlowManager({ root: event.worktreePath, mainRoot: scenario.root,
          inWorktree: true, specId: event.specId });
        stoppedState = manager.canonicalState(event.specId);
        if (fault === "analysis") {
          observed = true;
          // Real scan sees a damaged filesystem input; no internal CLI fake.
          fs.writeFileSync(path.join(event.worktreePath, ".sennel", "config.json"), "{invalid-config");
        }
      },
      worktreeFlowBindingFaultInjector(event) {
        if (fault !== "binding" || event.phase !== "before-binding-publication-receipt-intent-mkdir") return;
        observed = true;
        throw failure;
      },
    }).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    if (fault === "required-hook") {
      assert.equal(result.value?.ok, false, result.error?.stack ?? JSON.stringify(result.value));
      assert.equal(result.value.errors[0].code, "PLUGIN_HOOK_REQUIRED_FAILED");
    } else {
      assert.equal(observed, true, `${fault} boundary must actually be reached`);
      assert.notEqual(result.error, null);
      assert.equal(stoppedState.findNode("draft").attemptSequence, 0);
      assert.equal(stoppedState.findNode("draft").result, null);
    }
    assertNoWorker(scenario);
    scenario.reload();
    assert.notEqual(scenario.flowManager.loadPreparingFlow(scenario.runId), null);
    assert.equal(scenario.flowManager.loadActiveFlows().length, 0);
    assert.equal(journalRecord(scenario), null);
    if (stoppedState) {
      assert.notEqual(stoppedState.findNode("prepare-spec").status, "done",
        `${fault} must not be preceded by a completed preparation receipt`);
    }
  });
}

for (const checkpoint of ["after-identity-binding", "after-registry-publication", "after-preparing-flow-removal", "after-journal-completion"]) {
  it(`P12 interruption at ${checkpoint} respects the actual preparation receipt boundary`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
    await scenario.initialize();
    const failure = new Error(`stop:${checkpoint}`);
    let stopped = null;
    let bytes = null;
    let prepareNode = null;
    let confirmedReceipt = null;
    await assert.rejects(scenario.prepare({ worktreePrepareFaultInjector(event) {
      if (event.phase !== checkpoint) return;
      stopped = event;
      scenario.specId = event.specId;
      // Canonical artifacts live in mainRoot even when execution is elsewhere.
      bytes = canonicalBytes(scenario);
      const manager = new FlowManager({ root: event.worktreePath, mainRoot: scenario.root,
        inWorktree: true, specId: event.specId });
      const state = manager.canonicalState(event.specId);
      prepareNode = state.findNode("prepare-spec");
      assert.equal(state.findNode("draft").attemptSequence, 0);
      if (prepareNode.result?.stepResult?.kind === "prepare-spec-ready") {
        scenario.executionRoot = event.worktreePath;
        confirmedReceipt = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
      }
      throw failure;
    } }), (error) => error === failure || error.cause === failure);
    assert.notEqual(stopped, null);
    if (["after-preparing-flow-removal", "after-journal-completion"].includes(checkpoint)) {
      assert.notEqual(confirmedReceipt, null,
        "cleanup requires an authenticated preparation receipt, not registry publication alone");
    }
    if (confirmedReceipt === null) {
      assert.notEqual(prepareNode.status, "done", "incomplete preparation must not be terminal");
      assert.equal(prepareNode.result, null);
      assert.equal(fs.existsSync(stopped.worktreePath), false);
      assert.equal(journalRecord(scenario), null);
      scenario.executionRoot = scenario.root;
      assert.notEqual(scenario.reload().loadPreparingFlow(scenario.runId), null);
      assertNoWorker(scenario);
      return;
    }
    assert.equal(fs.existsSync(stopped.worktreePath), true,
      "cleanup after confirmed preparation must preserve its execution root");
    scenario.executionRoot = stopped.worktreePath;
    scenario.reload();
    assert.deepEqual(canonicalBytes(scenario), bytes);
    assert.equal(scenario.flowManager.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
    assertNoWorker(scenario);
    assert.deepEqual(savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft"), confirmedReceipt);
  });
}

const persistenceCases = ["branch", "prepare-spec"].flatMap((stepId) => (
  ["before-commit", "lost-response", "receipt-read-failure"].map((fault) => ({ stepId, fault, mode: "no-branch" }))
));
persistenceCases.push(...["lost-response", "receipt-read-failure"].map((fault) => (
  { stepId: "prepare-spec", fault, mode: "worktree" }
)));
for (const { stepId, fault, mode } of persistenceCases) {
  it(`P13 ${mode === "worktree" ? "worktree " : ""}${stepId} ${fault} distinguishes uncommitted state from a durable publication`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode });
    await scenario.initialize();
    const kind = stepId === "branch" ? "branch-not-required" : "prepare-spec-ready";
    const failure = new Error(`injected ${stepId} ${fault}`);
    // Local persistence fault only: all admission, producer and transaction
    // code stays real. No completed Result or receipt is manufactured.
    const publicationFault = new PreparePublicationFault(t, { scenario, stepId, kind, fault, failure });
    const outcome = await scenario.prepare().then((value) => ({ value, error: null }),
      (error) => ({ value: null, error }));
    publicationFault.restore();
    assert.equal(publicationFault.reached, true,
      `${stepId} must reach the real Version Store with ${kind}, not only write status=done`);
    if (mode === "worktree") {
      assert.notEqual(publicationFault.journalAtPublication, null,
        "Prepare publication must still belong to the real journal owner");
    }
    const ownedJournal = publicationFault.journalAtPublication;
    if (mode === "worktree") {
      assert.equal(fs.existsSync(ownedJournal.worktreePath), true,
        "committed preparation must survive the worktree command's owned-rollback catch");
      assert.equal(fs.existsSync(scenario.flowManager.specLocation(scenario.specId).artifact("flow.state")), true,
        "committed canonical preparation must survive the owned-rollback catch");
    }
    scenario.reload();
    const activities = scenario.flowManager.activityLedger(scenario.specId);
    assert.equal(activities.filter((entry) => entry.nodeId === stepId
      && entry.result?.stepResult?.type === "error").length, 0,
    "persistence failure must not append an alternative Error Result");
    assertNoWorker(scenario);
    if (mode === "worktree") {
      assert.equal(publicationFault.commits, 1);
      assert.equal(scenario.git(["worktree", "list", "--porcelain"]), publicationFault.worktreesAtCommit);
      assert.equal(scenario.git(["rev-parse", ownedJournal.branchName]).trim(), scenario.baseOid);
      const identity = new WorktreeFlowBindingStore({ worktreePath: scenario.executionRoot }).load();
      assert.equal(identity.runId, scenario.runId);
      assert.equal(identity.specId, scenario.specId);
      assert.equal(identity.worktreePath, ownedJournal.worktreePath);
      assert.equal(scenario.flowManager.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
      assert.equal(new RepositoryFlowOperationLock({ mainRoot: scenario.root }).lock.inspect(), null,
        "return or stop must release the operation owner without deleting committed preparation");
    }
    if (fault === "before-commit") {
      assert.notEqual(outcome.error, null);
      assert.equal(publicationFault.commits, 0);
      assert.deepEqual(canonicalBytes(scenario), publicationFault.before,
        "uncommitted failure preserves Result, Activity and Attempt lease");
    } else if (fault === "receipt-read-failure") {
      assert.notEqual(outcome.error, null);
      assert.equal(publicationFault.commits, 1);
      assert.equal(publicationFault.receiptReads, 1);
      assert.deepEqual(canonicalBytes(scenario), publicationFault.committed,
        "unreadable acknowledgement must not append a fallback or discard the committed publication");
      if (mode === "worktree") {
        const retainedJournal = journalRecord(scenario);
        assert.notEqual(retainedJournal, null, "unacknowledged committed work must retain its owned recovery journal");
        assert.equal(retainedJournal.attemptId, ownedJournal.attemptId);
        assert.deepEqual(retainedJournal.processIdentity, ownedJournal.processIdentity);
        savedPreparation(scenario, stepId, kind, "draft");
      }
    } else {
      assert.equal(outcome.error, null);
      assert.equal(publicationFault.commits, 1);
      assert.equal(activities.filter((entry) => entry.nodeId === stepId
        && entry.result?.stepResult?.kind === kind).length, 1);
      const receipt = savedPreparation(scenario, stepId, kind, stepId === "branch" ? "prepare-spec" : "draft");
      if (mode === "worktree") {
        assert.equal(journalRecord(scenario), null, "acknowledged completion must finish its journal");
        assert.equal(scenario.flowManager.loadPreparingFlow(scenario.runId), null);
        const { requests } = await startDraft(scenario);
        assertPreparedDraftInput(scenario, requests, receipt);
      }
    }
  });
}

it("P14 fresh root starts with no Attempt and journal ownership never becomes a Step binding", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
  await scenario.initialize();
  const original = FlowManager.prototype.createFresh;
  let fresh = null;
  let journalAttemptId = null;
  t.mock.method(FlowManager.prototype, "createFresh", function (request) {
    assert.equal(fs.existsSync(this.pathFor(request.specId)), false);
    const journal = journalRecord(scenario);
    assert.equal(journal.runId, scenario.runId);
    journalAttemptId = journal.attemptId;
    const result = original.call(this, request);
    fresh = this.canonicalState(request.specId);
    return result;
  });
  await scenario.prepare();
  assert.notEqual(fresh, null);
  assert.equal(fresh.attempt, null);
  for (const stepId of ["branch", "prepare-spec", "draft"]) {
    assert.equal(fresh.findNode(stepId).attemptSequence, 0);
    assert.equal(fresh.findNode(stepId).result, null);
  }
  const activities = scenario.reload().activityLedger(scenario.specId);
  for (const stepId of ["branch", "prepare-spec"]) {
    const attempts = activities.filter((activity) => activity.nodeId === stepId && activity.attemptId !== null);
    assert.ok(attempts.length > 0);
    assert.ok(attempts.every((activity) => activity.attemptId !== journalAttemptId));
  }
  assert.equal(scenario.flowManager.canonicalState(scenario.specId).findNode("draft").attemptSequence, 0);
  assertNoWorker(scenario);
});

for (const changed of ["live-owner", "base-oid"]) {
  it(`P15 journal retry refuses ${changed} without changing its owner or creating an Attempt`, async (t) => {
    const scenario = PrepareArtifactScenario.create(t, { mode: "worktree" });
    await scenario.initialize();
    const journalPath = path.join(scenario.root, ".sennel", ".worktree-prepare-attempt.json");
    const unlink = fs.unlinkSync;
    const cleanupFailure = new Error("journal removal interrupted");
    const fault = t.mock.method(fs, "unlinkSync", function (file) {
      if (file === journalPath) throw cleanupFailure;
      return unlink.call(this, file);
    });
    await assert.rejects(scenario.prepare({ worktreePrepareFaultInjector(event) {
      if (event.phase === "after-journal-publication") throw new Error("prepare interrupted before Git");
    } }), (error) => error instanceof AggregateError && error.errors.includes(cleanupFailure));
    fault.mock.restore();
    const before = fs.readFileSync(journalPath);
    if (changed === "base-oid") scenario.git(["commit", "--allow-empty", "-m", "Advance fixture base"]);
    scenario.reload();
    await assert.rejects(scenario.prepare(), changed === "live-owner" ? /owner is live/ : /base revision/);
    assert.deepEqual(fs.readFileSync(journalPath), before);
    assert.equal(fs.existsSync(path.join(scenario.root, "specs")), false);
    assert.equal(scenario.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm).length, 1);
    assertNoWorker(scenario);
  });
}

it("P16 an existing Git worktree uses BranchNotRequired without fabricating Git preparation", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "branch" });
  const executionRoot = path.join(scenario.root, ".sennel", "worktree", "existing");
  scenario.git(["worktree", "add", "-b", "existing-feature", executionRoot, "main"]);
  const before = scenario.git(["worktree", "list", "--porcelain"]);
  await scenario.initialize();
  const prepared = await scenario.prepare({ executionRoot });
  assert.equal(prepared.result, "ok");
  assert.equal(prepared.artifacts.mode, "direct");
  assert.equal(scenario.git(["worktree", "list", "--porcelain"]), before);
  assert.equal(scenario.executionRoot, executionRoot);
  savedPreparation(scenario, "branch", "branch-not-required", "prepare-spec");
});

it("P17 the actual Draft consumer retains significant surrounding whitespace in the original request", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { request: "  Original request.\nSecond line.\n\n" });
  await scenario.initialize();
  await scenario.prepare();
  assert.equal(scenario.reload().loadReadOnly(scenario.specId).request, scenario.request);
  const { requests } = await startDraft(scenario);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.contextSnapshot.entries.find((entry) => entry.kind === "request").document,
    scenario.request, "the prepared request must reach Draft unchanged");
});

for (const stepId of ["branch", "prepare-spec"]) {
  it(`P18 ${stepId} semantic Error uses the shared Result and Definition Failure without a Connector`, () => {
    assert.equal(typeof Definition.settlePrepareStepResult, "function",
      "preparation needs the phase Definition entry used by both production Steps");
    const result = new StepErrorResult(stepId, Object.assign(new Error("semantic preparation failure"), {
      code: "PREPARATION_SEMANTIC_FAILURE", data: { stepId },
    }));
    const restored = StepResult.fromStored(stepId, result.toJSON());
    assert.ok(restored instanceof StepErrorResult);
    const settlement = Definition.settlePrepareStepResult(stepId, restored);
    assert.ok(settlement instanceof Definition.StepErrorDecision);
    assert.equal(settlement.kind, "failure");
    assert.equal(settlement.connector, undefined);
    assert.equal(settlement.targetStepId, undefined);
    assert.equal(restored.error.code, "PREPARATION_SEMANTIC_FAILURE");
    assert.deepEqual(restored.error.data, { stepId });
  });
}

for (const stepId of ["branch", "prepare-spec"]) {
  for (const difference of ["owner", "publication", "target"]) {
    it(`P19 ${stepId} receipt readback refuses different ${difference} with zero mutation`, async (t) => {
      const scenario = PrepareArtifactScenario.create(t);
      await scenario.initialize();
      const kind = stepId === "branch" ? "branch-not-required" : "prepare-spec-ready";
      const publicationFault = new PreparePublicationFault(t, { scenario, stepId, kind,
        fault: "lost-response", once: true,
        failure: new Error("Lose the response so production performs exact receipt recovery") });
      await scenario.prepare();
      publicationFault.restore();
      const replayInput = publicationFault.receiptInput;
      assert.notEqual(replayInput, null, `${stepId} must recover using its real typed settlement input`);
      const exact = publicationFault.readReceipt(replayInput);
      assert.notEqual(exact, null);
      scenario.reload();
      const before = canonicalBytes(scenario);
      // A malformed boundary input changes one identity dimension while keeping
      // the real producer's typed input and all other fields intact.
      const changed = { ...replayInput };
      if (difference === "owner") {
        changed.binding = boundaryInputWithChangedField(replayInput.binding, "runId", `${scenario.runId}-other`);
      } else if (difference === "publication") {
        changed.commandResult = { ...replayInput.commandResult, changedPreparationPublication: true };
      } else {
        changed.settlement = boundaryInputWithChangedField(replayInput.settlement, "targetStepId", "spec");
      }
      let found = null;
      try {
        found = publicationFault.readReceipt(changed);
      } catch (error) {
        assert.ok(error instanceof CurrentFlowStateConflictError, error.stack);
      }
      assert.equal(found, null, "a mismatched receipt must not authorize replay");
      assert.deepEqual(canonicalBytes(scenario), before);
      assertNoWorker(scenario);
    });
  }
}

it("P20 required plugin success publishes real evidence that survives reload and binds the Draft receipt", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
  scenario.installPreparePlugin();
  await scenario.initialize();
  await scenario.prepare();
  const manager = scenario.reload();
  const descriptors = manager.artifactCatalog(scenario.specId).artifacts.filter((entry) => (
    entry.logicalKey === "plugin.lifecycle.artifact"
  ));
  assert.equal(descriptors.length, 1, "the actual required hook must publish its output through the canonical Store");
  const published = manager.readArtifact({ specId: scenario.specId,
    logicalKey: "plugin.lifecycle.artifact", consumerNodeId: "system",
    parameters: { pluginArtifactPath: "prepare-observer/prepare-seen.json" },
  });
  assert.equal(published.descriptor.hash, descriptors[0].hash);
  assert.equal(crypto.createHash("sha256").update(published.bytes).digest("hex"), descriptors[0].hash);
  assert.deepEqual(JSON.parse(published.bytes), {
    runId: scenario.runId, specId: scenario.specId, issue: scenario.issue,
    request: scenario.request, hookCount: 1,
  });
  const publication = manager.activityLedger(scenario.specId).filter((entry) => entry.id === descriptors[0].activityId);
  assert.equal(publication.length, 1);
  assertNoWorker(scenario);
  const { requests } = await startDraft(scenario);
  const receipt = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
  assert.deepEqual(receipt.preparation.mandatory.plugins,
    descriptors.map((entry) => entry.toJSON?.() ?? entry));
  assertPreparedDraftInput(scenario, requests, receipt);
});

it("P21 a terminated worktree owner reloads through journal recovery into one preparation and actual Draft", async (t) => {
  const scenario = PrepareArtifactScenario.create(t, { mode: "worktree", issue: 472 });
  await scenario.initialize();
  const preparing = scenario.flowManager.loadPreparingFlow(scenario.runId);
  const stopped = scenario.interruptAfterWorktreeAdd();
  const abandoned = journalRecord(scenario);
  assert.equal(stopped.phase, "after-worktree-add");
  assert.equal(abandoned.runId, scenario.runId);
  assert.equal(abandoned.specId, stopped.specId);
  assert.equal(abandoned.expectedOid, scenario.baseOid);
  assert.equal(fs.existsSync(abandoned.worktreePath), true,
    "abrupt process exit must leave the production Git publication instead of synchronous rollback");
  assert.equal(scenario.git(["rev-parse", abandoned.branchName]).trim(), scenario.baseOid);
  assert.equal(fs.existsSync(path.join(scenario.root, "specs", abandoned.specId)), false);
  const operationLock = new RepositoryFlowOperationLock({ mainRoot: scenario.root });
  const abandonedOperation = operationLock.lock.inspect();
  assert.notEqual(abandonedOperation, null, "the exiting command must leave its real operation owner");
  const identities = new ProcessIdentitySource();
  assert.equal(identities.assess(abandoned.processIdentity).status, "stale");
  assert.equal(identities.assess(abandonedOperation.processIdentity).status, "stale");
  assert.equal(abandoned.processIdentity.pid, abandonedOperation.processIdentity.pid);
  assertNoWorker(scenario);
  assert.deepEqual(scenario.reload().loadPreparingFlow(scenario.runId), preparing);

  const observer = new PrepareExecutionObserver(t);
  let replacement = null;
  await scenario.prepare({ worktreePrepareFaultInjector(event) {
    if (event.phase === "after-journal-publication") replacement = journalRecord(scenario);
  } });
  await t.test("P21 existing stale journal and operation-owner recovery preserves identity and one Git publication", () => {
    assert.notEqual(replacement, null, "stale journal recovery must publish a fresh owned attempt");
    assert.notEqual(replacement.attemptId, abandoned.attemptId);
    assert.equal(replacement.runId, abandoned.runId);
    assert.equal(replacement.specId, abandoned.specId);
    assert.equal(scenario.specId, abandoned.specId);
    assert.equal(scenario.executionRoot, abandoned.worktreePath);
    assert.equal(scenario.reload().loadReadOnly(scenario.specId).runId, scenario.runId);
    assert.equal(journalRecord(scenario), null);
    assert.equal(operationLock.lock.inspect(), null);
    assert.equal(scenario.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm).length, 2);
    assert.equal(scenario.git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${abandoned.branchName}`]).trim(),
      abandoned.branchName);
    assert.equal(scenario.git(["rev-parse", "HEAD"], scenario.executionRoot).trim(), scenario.baseOid);
    assertNoWorker(scenario);
  });
  savedPreparation(scenario, "branch", "branch-prepared", "prepare-spec");
  const receipt = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
  observer.assertExecuted(["branch", "prepare-spec"]);
  observer.restore();
  assertNoWorker(scenario);
  const { requests } = await startDraft(scenario);
  assertPreparedDraftInput(scenario, requests, receipt);
});

it("P22 branch publication stops before mandatory work and resumes without another branch Activity", async (t) => {
  // no-branch is the representative branch leaf publication; Git restart is
  // separately covered by P21. This checkpoint is a local persistence fault,
  // since production has no public fault callback immediately after branch save.
  const scenario = PrepareArtifactScenario.create(t);
  scenario.installPreparePlugin({ observeInvocation: true });
  await scenario.initialize();
  const failure = new Error("stop after durable branch publication");
  const publicationFault = new PreparePublicationFault(t, { scenario, stepId: "branch",
    kind: "branch-not-required", fault: "receipt-read-failure", failure,
    receiptFailure: new Error("branch acknowledgement temporarily unreadable") });
  const stopped = await scenario.prepare().then((value) => ({ value, error: null }),
    (error) => ({ value: null, error }));
  publicationFault.restore();
  assert.equal(publicationFault.commits, 1,
    "branch must reach its real semantic Result transaction before mandatory work");
  assert.notEqual(stopped.error, null, "receipt read failure must stop rather than start mandatory work");
  assert.notEqual(publicationFault.receiptInput, null,
    "production must attempt exact receipt readback for the committed branch");
  assert.equal(fs.existsSync(scenario.flowManager.specLocation(scenario.specId).artifact("flow.state")), true,
    "stopping after branch commit must retain the published canonical root");
  const manager = scenario.reload();
  assert.deepEqual(canonicalBytes(scenario), publicationFault.committed,
    "stopping after branch commit must retain its Result, receipt, Activity and target activation");
  const branchReceipt = savedBranchBeforeMandatory(scenario, "branch-not-required");
  assert.deepEqual(publicationFault.readReceipt(publicationFault.receiptInput, manager), branchReceipt);
  assert.equal(fs.existsSync(path.join(scenario.root, ".sennel", "output", "analysis.json")), false);
  assert.equal(fs.existsSync(scenario.preparePluginInvocationPath), false,
    "branch acknowledgement failure must stop before required plugin invocation");
  assert.equal(manager.artifactCatalog(scenario.specId).artifacts.some((entry) => (
    entry.logicalKey === "plugin.lifecycle.artifact"
  )), false, "branch acknowledgement failure must not publish required plugin effects");
  assert.notEqual(manager.loadPreparingFlow(scenario.runId), null);
  assertNoWorker(scenario);
  const specId = scenario.specId;
  const branchActivity = manager.activityLedger(specId).find((entry) => entry.nodeId === "branch"
    && entry.result?.stepResult?.kind === "branch-not-required").id;
  // Discard all command/manager output. Exact public retry must identify and
  // reuse this durable root from the preparing run, not fabricate a new root.
  scenario.flowManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
  const resumed = await scenario.prepare().then((value) => ({ value, error: null }),
    (error) => ({ value: null, error }));
  assert.equal(resumed.error, null, "the exact stopped operation must resume from its durable branch receipt");
  assert.equal(resumed.value?.result, "ok");
  assert.equal(scenario.specId, specId);
  const reloaded = scenario.reload();
  const pluginInvocation = JSON.parse(fs.readFileSync(scenario.preparePluginInvocationPath, "utf8"));
  assert.equal(pluginInvocation.flow.runId, scenario.runId);
  assert.equal(pluginInvocation.flow.specId, specId);
  assert.equal(reloaded.artifactCatalog(specId).artifacts.filter((entry) => (
    entry.logicalKey === "plugin.lifecycle.artifact"
  )).length, 1, "resumed preparation must run and publish the real required plugin");
  assert.deepEqual(savedPreparation(scenario, "branch", "branch-not-required", "prepare-spec"), branchReceipt);
  const branchActivities = reloaded.activityLedger(specId).filter((entry) => entry.nodeId === "branch"
    && entry.result?.stepResult?.kind === "branch-not-required");
  assert.equal(branchActivities.length, 1);
  assert.equal(branchActivities[0].id, branchActivity);
  const preparationReceipt = savedPreparation(scenario, "prepare-spec", "prepare-spec-ready", "draft");
  assertNoWorker(scenario);
  const { requests } = await startDraft(scenario);
  assertPreparedDraftInput(scenario, requests, preparationReceipt);
});
