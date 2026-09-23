import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, test } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { container } from "../../../src/lib/container.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import {
  attachCanonicalCommandResultArtifact,
  CanonicalCommandResultArtifact,
} from "../../../src/flow/lib/canonical-command-result.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

function setup({ faultInjector = null, validSpec = false } = {}) {
  const root = createTmpDir("spec-gate-command-boundary-");
  roots.push(root);
  initGitRepo(root);
  fs.writeFileSync(`${root}/README.md`, "Spec Gate command boundary\n");
  commitAll(root, "Spec Gate command boundary");
  const specId = "645-spec-gate-command-boundary";
  const manager = new FlowManager({
    root, mainRoot: root, inWorktree: false, specId,
    ...(faultInjector === null ? {} : { versionStoreFaultInjector: faultInjector }),
  });
  const fixture = new CanonicalFlowFixture({
    flowManager: manager, specId, runId: "run-spec-gate-command-boundary",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    ...(validSpec ? { specRecord: {
      goal: "Evaluate a valid canonical Spec with the provider.",
      requirements: [{ id: "R-1", desc: "The Spec Gate verifies this task.", task_ids: ["T-1"] }],
      acceptance_criteria: ["The Spec Gate records a verified outcome."],
    } } : {}),
  }).create();
  if (validSpec) fixture.addTask({
    id: "T-1", title: "Verify the Spec", goal: "Exercise the Gate evaluator.",
    test_strategy: "Check the canonical Gate outcome.", parent: null,
    origin: "plan", added_round: 0, status: "pending",
  });
  fixture.registerActive().activate("draft");
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`),
  }] });
  fixture.activate("spec-gate");
  const ctx = {
    root, mainRoot: root, executionRoot: root, specId, phase: "spec",
    flowManager: manager, flowState: manager.loadReadOnly(specId), config: {},
  };
  const promote = (result, artifacts = {}) => new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
  }).promote({ result, artifacts: { phase: "spec", ...artifacts } });
  return { root, specId, manager, fixture, ctx, promote };
}

function bytesAt(location) {
  const files = [
    location.flowStateFile, location.activitiesFile, location.catalogFile,
    location.artifact("spec.gate"), location.artifact("spec.gate.source"),
    location.artifact("issue.log"),
  ];
  return files.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
}

async function dispatchGate(input, result) {
  const entry = flowCommands.run.gate;
  const original = entry.command;
  class PublishedGateCommand extends Command {
    static outputMode = "envelope";
    execute() { return result; }
  }
  const output = [];
  try {
    entry.command = async () => ({ default: PublishedGateCommand });
    const values = {
      paths: { root: input.root }, flowManager: input.manager,
      mainRoot: input.root, config: null, inWorktree: false,
    };
    await dispatch({
      container: {
        get(name) { return values[name] ?? null; },
        has(name) { return Object.hasOwn(values, name); },
      },
      entry, argv: [], envelopeType: "run", envelopeKey: "gate",
      stdout: (chunk) => output.push(chunk), stderr: () => {}, setExitCode: () => {},
      buildHookCtx: () => input.ctx,
    });
  } finally {
    entry.command = original;
  }
  return JSON.parse(output.join(""));
}

test("Spec Gate post-hook transaction rolls back Result, publication, issue, and route after a catalog fault", async () => {
  let interrupt = false;
  let catalogFile = null;
  const input = setup({ faultInjector: ({ phase, filePath }) => {
    if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
      throw new Error("injected Spec Gate settlement interruption");
    }
  } });
  catalogFile = input.fixture.location().catalogFile;
  const before = bytesAt(input.fixture.location());
  const result = input.promote("fail", {
    failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "spec.json", locator: "goal" },
      observed: "The goal requires a bounded outcome.", severity: "blocking", refs: ["R-1"],
    }] } },
  });
  interrupt = true;
  await assert.rejects(() => flowCommands.run.gate.post(input.ctx, result),
    /injected Spec Gate settlement interruption/);
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  const state = input.manager.canonicalState(input.specId);
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.attempt.failure, null);
  assert.equal(input.manager.readCurrentStepSettlement({ specId: input.specId, stepId: "spec-gate" }), null);
});

test("direct post hook and dispatcher persist the same Spec Gate PASS contract", async () => {
  const outcomes = [];
  for (const viaDispatcher of [false, true]) {
    const input = setup();
    const result = input.promote("pass");
    if (viaDispatcher) {
      assert.equal((await dispatchGate(input, result)).ok, true);
    } else {
      await flowCommands.run.gate.post(input.ctx, result);
    }
    const state = input.manager.canonicalState(input.specId);
    const activity = input.manager.activityLedger(input.specId).find((entry) => (
      entry.nodeId === "spec-gate" && entry.result?.draftSettlementReceipt != null
    ));
    const source = input.manager.artifactCatalog(input.specId).artifacts.find((entry) => (
      entry.logicalKey === "spec.gate"
    ));
    assert.equal(source.activityId, activity.id);
    const reloaded = new FlowManager({
      root: input.root, mainRoot: input.root, inWorktree: false, specId: input.specId,
    });
    assert.equal(reloaded.canonicalState(input.specId).nextAction().nodeId, "approval");
    assert.equal(reloaded.activityLedger(input.specId).find((entry) => entry.id === activity.id)
      .result.draftSettlementReceipt.id, activity.result.draftSettlementReceipt.id);
    outcomes.push({
      result: activity.result.stepResult.kind,
      target: activity.result.draftSettlementReceipt.targetStepId,
      next: state.nextAction().nodeId,
      publication: source.logicalKey,
    });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0], {
    result: "spec-gate-passed", target: "approval", next: "approval", publication: "spec.gate",
  });
});

test("dispatcher refuses a stale attached Spec Gate payload without any canonical mutation", async () => {
  const input = setup();
  const promoted = input.promote("pass");
  const bad = {
    result: "pass",
    artifacts: { ...promoted.artifacts, gateTransitionAttemptId: "stale-attempt" },
  };
  attachCanonicalCommandResultArtifact(bad, new CanonicalCommandResultArtifact({
    logicalKey: "spec.gate", payload: bad,
  }));
  const before = bytesAt(input.fixture.location());
  const response = await dispatchGate(input, bad);
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  assert.equal(response.ok, false, JSON.stringify(response));
  const state = input.manager.canonicalState(input.specId);
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.attempt.failure, null);
});

test("dispatcher rejects a Spec Gate result attached as another Gate artifact before publication", async () => {
  const input = setup();
  const promoted = input.promote("pass");
  const bad = { result: promoted.result, artifacts: promoted.artifacts };
  attachCanonicalCommandResultArtifact(bad, new CanonicalCommandResultArtifact({
    logicalKey: "draft.gate", payload: bad,
  }));
  const before = bytesAt(input.fixture.location());

  const response = await dispatchGate(input, bad);

  assert.equal(response.ok, false);
  assert.equal(response.errors[0].code, "SPEC_GATE_ADMISSION_REFUSED");
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  assert.equal(input.manager.readCurrentStepSettlement({ specId: input.specId, stepId: "spec-gate" }), null);
});

test("dispatcher refuses a non-Spec phase label while the canonical Spec Gate is active", async () => {
  const input = setup();
  const promoted = input.promote("pass");
  const bad = { result: promoted.result, artifacts: { ...promoted.artifacts, phase: "integration" } };
  attachCanonicalCommandResultArtifact(bad, new CanonicalCommandResultArtifact({
    logicalKey: "integration.gate", payload: bad,
  }));
  const before = bytesAt(input.fixture.location());

  const response = await dispatchGate(input, bad);

  assert.equal(response.ok, false);
  assert.equal(response.errors[0].code, "SPEC_GATE_ADMISSION_REFUSED");
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  assert.equal(input.manager.readCurrentStepSettlement({ specId: input.specId, stepId: "spec-gate" }), null);
});

test("Spec Gate command bounds protocol retries and refuses tooling output without publication", async () => {
  const input = setup({ validSpec: true });
  const before = bytesAt(input.fixture.location());
  const originalGet = container.get.bind(container);
  let calls = 0;
  container.get = (key) => key !== "agent" ? originalGet(key) : {
    resolve: () => ({ provider: "fixture" }),
    call: async () => { calls += 1; return "invalid provider JSON"; },
  };
  let result;
  try {
    result = await new RunGateCommand().execute(input.ctx);
  } finally {
    container.get = originalGet;
  }
  assert.equal(calls, 2, "one initial provider call and one protocol retry");
  assert.equal(result.result, "fail");
  assert.equal(result.artifacts.failureCode, "GATE_REQUIRED_OUTPUT");
  assert.deepEqual(result.artifacts.evaluations, []);
  await assert.rejects(() => flowCommands.run.gate.post(input.ctx, result),
    { code: "GATE_OUTPUT_TOOLING_FAILURE" });
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  assert.equal(input.manager.readCurrentStepSettlement({
    specId: input.specId, stepId: "spec-gate",
  }), null);
  const state = input.manager.canonicalState(input.specId);
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.attempt.failure, null);
});

test("atomic Spec Gate retry projects the replacement Attempt without another Gate classification", async () => {
  const input = setup();
  const before = input.manager.canonicalState(input.specId).attempt.sequence;
  const result = input.promote("fail", {
    failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations: [] } },
  });
  await flowCommands.run.gate.post(input.ctx, result);
  const state = input.manager.canonicalState(input.specId);
  assert.equal(state.attempt.sequence, before + 1);
  assert.equal(state.attempt.failure, null);
  const next = await new GetNextActionCommand().execute({
    ...input.ctx, flowState: input.manager.loadReadOnly(input.specId),
  });
  assert.equal(next.step, "spec-gate");
  assert.notEqual(next.directive.actionId, "CLAIM_GATE_RETRY");
  assert.notEqual(next.directive.actionId, "RECONCILE_GATE_PUBLICATION");
  const reloaded = new FlowManager({
    root: input.root, mainRoot: input.root, inWorktree: false, specId: input.specId,
  });
  assert.equal(reloaded.canonicalState(input.specId).attempt.sequence, before + 1);
});
