import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Agent, MAX_AGENT_ARGUMENT_BYTES } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { latestRepairBudget, SpecGateRepairProgressLedger } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { readSpecJsonValidator } from "../../../src/lib/spec-json.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, fixtureRepository, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

function projectionAgent(root, args = ["{{PROMPT}}"]) {
  const config = { agent: { default: "fixture/worker", providers: {
    "fixture/worker": { command: "fixture-worker", args },
  } } };
  return new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: root, enabled: false }) });
}

function canonicalSnapshot(manager, specId) {
  return { state: manager.canonicalState(specId).toJSON(),
    catalog: manager.artifactCatalog(specId).toJSON(),
    activities: manager.activityLedger(specId) };
}

async function dispatchOnce(value, agent) {
  const flowState = value.flowManager.loadReadOnly(value.specId);
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  return dispatcher.execute({ ...value.ctx, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root,
      authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
}

function independentRepairSpec({ uniqueCharacters = 88_000 } = {}) {
  const spec = validWorkerHandoffSpec();
  // R1 is the short authoritative rule. The eight selected requirements hold
  // distinct bodies below the Requirement prompt hard maximum.
  spec.requirements = [spec.requirements[0], ...Array.from({ length: 8 }, (_, index) => ({
    ...spec.requirements[0], id: `R${index + 2}`, task_ids: [`T${index + 2}`],
    desc: `Unique requirement ${index + 2}: ${"条".repeat(uniqueCharacters)}`,
  }))];
  // Unique range bodies force two files even after common decisions are shared.
  spec.overview.decisions = Array.from({ length: 1 }, (_, index) => ({
    text: `Decision ${index}: ${"決".repeat(400)}`,
    evidence: "拠".repeat(400), consideredAlternatives: "案".repeat(400),
  }));
  return spec;
}

function independentRepairScenario(specRecord) {
  const additionalObservations = specRecord.requirements.slice(2).map((requirement) => {
    const target = { entity: "requirement", id: requirement.id, field: "desc" };
    return { failureMode: "guardrail-violation", requirementRef: "R1",
      where: { file: "spec.json", locator: `requirements[${requirement.id}].desc` },
      observed: `Correct ${requirement.id}.`, targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] };
  });
  return createSpecGateRepairScenario({ specRecord, additionalObservations,
    locator: "requirements[R2].desc", target: { entity: "requirement", id: "R2", field: "desc" } });
}

test("packs complete Unicode units into bounded files and atomically applies all generations after reload", async () => {
  const specRecord = independentRepairSpec();
  const value = await independentRepairScenario(specRecord);
  try {
    const initialBytes = value.flowManager.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes;
    readSpecJsonValidator().validate(JSON.parse(initialBytes.toString("utf8")));
    initGitRepo(value.root);
    fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
    commitAll(value.root, "Create isolated multi-file repair repository");
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    const initialCatalog = value.flowManager.artifactCatalog(value.specId).toJSON();
    const transport = projectionAgent(value.root);
    const unitIds = new Set();
    const contexts = [];
    let chargedCharacters = 0;
    let chargedItems = 0;
    const agent = {
      projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
      async call(prompt, options) {
        transport.projectInvocation(prompt, options).assertWithinLimit(transport.promptCharacterLimit);
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const input = requestInput(request, "spec-gate-repair-context.json");
        const context = input.document;
        contexts.push(context);
        chargedCharacters += prompt.length + request.inputs.reduce((sum, entry) =>
          sum + JSON.stringify(requestInput(request, entry.name).document).length, 0);
        chargedItems += request.inputs.length + 1;
        assert.ok(input.byteLength <= 2 * 1024 * 1024);
        assert.equal(context.mode, "repair");
        assert.equal(context.batchCount, contexts.length === 1 ? 2 : 1);
        const groups = SpecGateRepairBundle.fromJSON(context.bundle).selections().map((selection) => {
          assert.equal(unitIds.has(selection.unit.id), false, "A completed unit must never be sent again");
          unitIds.add(selection.unit.id);
          assert.deepEqual(selection.ranges.filter((range) => range.id.startsWith("overview.decisions["))
            .map((range) => range.value).sort((a, b) => a.text.localeCompare(b.text)),
          [...specRecord.overview.decisions].sort((a, b) => a.text.localeCompare(b.text)));
          const range = selection.ranges.find((entry) => entry.writable);
          return { findingIdentities: selection.unit.findings.map((finding) => finding.identity),
            operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
              edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value),
                replacement: `Precisely validate ${range.target.id}.` }], reason: "Correct the whole selected unit." }] };
        });
        const proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision, groups };
        chargedCharacters += JSON.stringify(proposal).length;
        chargedItems += groups.length;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    for (let generation = 0; generation < 2; generation += 1) {
      const result = await dispatchOnce(value, agent);
      assert.equal(contexts.length, generation + 1, JSON.stringify(result));
      value.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      value.ctx = { ...value.ctx, flowManager: value.flowManager };
      const budget = latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
        attemptId, baseRevision: contexts[0].baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
      assert.equal(budget.providerCallCount, generation + 1);
      assert.equal(budget.aggregateCharacters, chargedCharacters);
      assert.equal(budget.aggregateItemCount, chargedItems);
      assert.ok(budget.aggregateCharacters < 1_000_000);
      const progress = ["checkpoint", "claimed", "publication"].map((phase) => JSON.parse(
        value.flowManager.readArtifact({ specId: value.specId,
          logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
          parameters: { attemptId, generation: String(generation), phase } }).bytes.toString("utf8")));
      for (const entry of progress) {
        assert.deepEqual(entry.context, contexts[generation]);
        assert.equal(entry.requestDigest, progress[0].requestDigest);
        assert.equal(entry.generation, generation);
      }
      assert.equal(progress[0].budget.providerCallCount, generation);
      assert.equal(progress[1].budget.providerCallCount, generation + 1);
      assert.equal(progress[1].budget.aggregateCharacters, progress[0].budget.aggregateCharacters);
      assert.deepEqual(progress[2].budget, budget);
      if (generation === 0) {
        assert.equal(result.data?.nextAction?.step, "spec-gate-repair", JSON.stringify(result));
        assert.deepEqual(value.flowManager.readArtifact({ specId: value.specId,
          logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes, initialBytes);
        const ledger = new SpecGateRepairProgressLedger({ flowManager: value.flowManager,
          specId: value.specId, attemptId, baseRevision: contexts[0].baseRevision });
        assert.equal(ledger.entries.length, 1);
        assert.deepEqual(ledger.entries[0].context, contexts[0]);
        const completed = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
          logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
          parameters: { attemptId, generation: "0", phase: "completed" } }).bytes.toString("utf8"));
        assert.equal(completed.resultKind, "spec-gate-repair-context-required");
      } else assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify(result));
    }
    assert.equal(unitIds.size, 8);
    const saved = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes.toString("utf8"));
    assert.deepEqual(saved.overview.decisions, specRecord.overview.decisions);
    assert.equal(saved.requirements[0].desc, specRecord.requirements[0].desc);
    assert.ok(saved.requirements.slice(1).every((requirement) => requirement.desc === `Precisely validate ${requirement.id}.`));
    const audit = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-review", parameters: { attemptId } }).bytes);
    assert.equal(audit.acceptedGroups.length, 8);
    assert.equal(value.flowManager.artifactCatalog(value.specId).artifacts.filter((entry) => entry.logicalKey === "spec.snapshot").length,
      initialCatalog.artifacts.filter((entry) => entry.logicalKey === "spec.snapshot").length + 1);
  } finally { removeTmpDir(value.root); }
});

test("refuses all known unique-input calls and response allowances before any canonical mutation", async () => {
  const specRecord = independentRepairSpec({ uniqueCharacters: 108_000 });
  const value = await independentRepairScenario(specRecord);
  try {
    initGitRepo(value.root);
    fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
    commitAll(value.root, "Create isolated remaining-plan budget repository");
    const before = canonicalSnapshot(value.flowManager, value.specId);
    const transport = projectionAgent(value.root);
    let calls = 0;
    const result = await dispatchOnce(value, {
      projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
      async call() { calls += 1; assert.fail("The entire remaining plan must fit before the first provider"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "PROMPT_RESPONSE_TOO_LARGE", JSON.stringify(result));
    assert.equal(calls, 0);
    assert.deepEqual(canonicalSnapshot(new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId }), value.specId), before);
  } finally { removeTmpDir(value.root); }
});

test("refuses an indivisible file overflow before provider, claim, retry or canonical mutation", async () => {
  const specRecord = validWorkerHandoffSpec();
  specRecord.overview.decisions = Array.from({ length: 60 }, () => ({
    text: "決".repeat(4000), evidence: "拠".repeat(4000), consideredAlternatives: "案".repeat(4000),
  }));
  const value = await createSpecGateRepairScenario({ specRecord });
  try {
    initGitRepo(value.root);
    fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
    commitAll(value.root, "Create isolated indivisible file admission repository");
    const before = canonicalSnapshot(value.flowManager, value.specId);
    const transport = projectionAgent(value.root);
    let calls = 0;
    const result = await dispatchOnce(value, {
      projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
      async call() { calls += 1; assert.fail("Oversized atomic input must be refused before its provider"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE", JSON.stringify(result));
    assert.equal(calls, 0);
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    assert.deepEqual(canonicalSnapshot(reloaded, value.specId), before);
  } finally { removeTmpDir(value.root); }
});

test("dispatches a complete Unicode repair input larger than the prompt limit and reloads its atomic publication", async () => {
  const specRecord = validWorkerHandoffSpec();
  const head = "Read the original decision from its beginning.";
  const tail = "Keep the original decision through its end.";
  specRecord.overview.decisions = Array.from({ length: 60 }, (_, index) => ({
    text: `${head} ${index}: ` + "承認済みの判断を維持する。\"根拠\"\n🧭".repeat(14) + tail,
    evidence: "The complete decision is authoritative read-only context. ".repeat(15),
    consideredAlternatives: "A partial decision does not establish the repair authority. ".repeat(15),
  }));
  const value = await createSpecGateRepairScenario({ specRecord });
  try {
    readSpecJsonValidator().validate(JSON.parse(value.flowManager.readArtifact({
      specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair",
    }).bytes.toString("utf8")));
    initGitRepo(value.root);
    fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
    commitAll(value.root, "Create isolated Unicode repair repository");
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    const transport = projectionAgent(value.root);
    let providerCalls = 0;
    let inputBytes = 0;
    const agent = {
      projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
      async call(prompt, options) {
        transport.projectInvocation(prompt, options).assertWithinLimit(transport.promptCharacterLimit);
        providerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const input = requestInput(request, "spec-gate-repair-context.json");
        inputBytes = input.byteLength;
        assert.ok(inputBytes > 120_000, "The fixture must exercise the original file-body limit");
        assert.equal(input.document.mode, "repair");
        assert.equal(input.document.batchCount, 1);
        const selections = SpecGateRepairBundle.fromJSON(input.document.bundle).selections();
        assert.equal(selections.length, 1);
        assert.equal(request.inputs.some((entry) => entry.name === "spec.json"), false);
        assert.equal(prompt.includes(head), false);
        assert.equal(prompt.includes(tail), false);
        const selection = selections[0];
        for (const expected of specRecord.overview.decisions) {
          const decision = selection.ranges.find((range) => range.value?.text === expected.text);
          assert.deepEqual(decision?.value, expected, "Every complete selected decision must survive request serialization");
          assert.equal(decision.writable, false);
        }
        const writable = selection.ranges.find((range) => range.id === "requirements[R1].desc" && range.writable);
        assert.ok(writable);
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair", baseRevision: input.document.baseRevision,
          groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity),
            operations: [{ kind: "edit-text-field", target: writable.target,
              expectedDigest: writable.digest,
              edits: [{ startByte: 0, endByte: Buffer.byteLength(writable.value, "utf8"),
                replacement: "Publish a precisely validated artifact." }],
              reason: "Correct the permitted field using its complete selected context." }] }],
        }));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    const result = await dispatchOnce(value, agent);
    assert.equal(providerCalls, 1, JSON.stringify(result));
    assert.ok(inputBytes > 120_000);
    assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify({
      errors: result.errors,
      settlement: value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }),
    }));
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const saved = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes.toString("utf8"));
    assert.equal(saved.requirements[0].desc, "Publish a precisely validated artifact.");
    assert.deepEqual(saved.overview.decisions, specRecord.overview.decisions);
    const audit = JSON.parse(reloaded.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-review",
      parameters: { attemptId } }).bytes.toString("utf8"));
    assert.equal(audit.acceptedGroups.length, 1);
  } finally { removeTmpDir(value.root); }
});

for (const step of ["draft", "draft-refine", "draft-gate-repair", "spec-gate-repair"]) {
  test(`refuses ${step} transport before provider start without a handoff retry or canonical mutation`, async () => {
    let value;
    if (step === "spec-gate-repair") {
      value = await createSpecGateRepairScenario();
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated repair admission repository");
    } else {
      const root = fixtureRepository("draft-file-admission-");
      const specId = "501-draft-file-admission";
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "run-draft-file-admission",
        autoApprove: true,
        request: "Read complete inputs through the guarded worker." }).create().registerActive().activate("draft");
      if (step !== "draft") {
        const draft = canonicalDraftDocument({ questions: step === "draft-refine" ? [{
          state: "CandidateQuestion", id: "q1", question: "Which public behavior should be selected?",
          category: "user-visible-behavior", revision: 0,
          provenance: { producer: "worker-handoff-fixture" }, evidenceDigest: "a".repeat(64),
        }] : [] });
        flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(draft)),
        }] });
        if (step === "draft-refine") fixture.activate(step);
        else {
          fixture.activate("draft-gate");
          new DraftGateRepairScenario({ flowManager, root, specId }).select({
            issueLogId: "file-admission-gate",
            observations: [{ kind: "violation", failureMode: "guardrail-violation", requirementRef: "DRAFT",
              where: { file: "draft.json", locator: "analysis.validation" },
              observed: "The retained behavior is absent from validation.", severity: "blocking", refs: ["DRAFT"] }],
          });
        }
      }
      value = { root, specId, flowManager,
        ctx: { root, mainRoot: root, executionRoot: root, specId, flowManager } };
    }
    try {
      const before = canonicalSnapshot(value.flowManager, value.specId);
      const transport = projectionAgent(value.root,
        ["漢".repeat(Math.floor(MAX_AGENT_ARGUMENT_BYTES / 3) + 1), "{{PROMPT}}"]);
      let agentCalls = 0;
      let providerCalls = 0;
      const agent = {
        projectInvocation: (prompt, options) => transport.projectInvocation(prompt, options),
        async call(prompt, options) {
          agentCalls += 1;
          transport.projectInvocation(prompt, options).assertWithinLimit(transport.promptCharacterLimit);
          providerCalls += 1;
          throw new Error("The oversized transport must never reach its provider");
        },
      };
      const result = await dispatchOnce(value, agent);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "PROMPT_INVOCATION_PROJECTION_OVERFLOW", JSON.stringify(result));
      assert.equal(agentCalls, 0);
      assert.equal(providerCalls, 0);
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.deepEqual(canonicalSnapshot(reloaded, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });
}

test("settles worker-free Draft refinement without admitting an unused provider", async () => {
  const root = fixtureRepository("draft-worker-free-admission-");
  try {
    const specId = "502-worker-free-refine";
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "run-worker-free-refine",
      request: "Continue a complete Draft without a worker." }).create().registerActive().activate("draft");
    flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft",
      mediaType: "application/json", bytes: Buffer.from(workerArtifactJson(canonicalDraftDocument())) }] });
    fixture.activate("draft-refine");
    let projections = 0;
    const agent = { projectInvocation() { projections += 1; assert.fail("A worker-free Result does not admit a provider"); },
      async call() { assert.fail("A worker-free Result does not call a provider"); } };
    await dispatchOnce({ root, specId, flowManager,
      ctx: { root, mainRoot: root, executionRoot: root, specId, flowManager } }, agent);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(projections, 0);
    const settlement = reloaded.activityLedger(specId).findLast((activity) => activity.nodeId === "draft-refine")
      ?.result?.draftSettlementReceipt;
    assert.equal(settlement?.resultKind, "draft-refine-completed");
  } finally { removeTmpDir(root); }
});
