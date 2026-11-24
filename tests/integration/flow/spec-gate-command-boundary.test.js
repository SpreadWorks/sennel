import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, test } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { AgentResponseProtocolEvidence } from "../../../src/lib/agent-response-protocol.js";
import {
  attachCanonicalCommandResultArtifact,
  CanonicalCommandResultArtifact,
} from "../../../src/flow/lib/canonical-command-result.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { produceGateResult } from "../../support/infrastructure/query-draft-review-scenario.js";
import { passingGateProviderResponse } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec } from "../../support/infrastructure/worker-artifact.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

async function setup({ faultInjector = null } = {}) {
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
  const fixture = new FlowAtStepFixture({
    flowManager: manager, specId, runId: "run-spec-gate-command-boundary",
    request: "Keep the Spec Gate command and post boundary atomic through reload.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    specRecord: validWorkerHandoffSpec(), taskDocuments: validWorkerHandoffTaskSpec().tasks,
    targetStep: "spec-gate",
  });
  await fixture.createWithProducers();
  fs.writeFileSync(`${root}/.sennel/guardrail.json`, JSON.stringify({ guardrails: [{
    id: "R-1", body: "The Spec goal must state a bounded outcome.",
    meta: { phase: ["spec"], category: "requirements" },
  }] }));
  const ctx = {
    root, mainRoot: root, executionRoot: root, specId, phase: "spec",
    flowManager: manager, flowState: manager.loadReadOnly(specId), config: {},
  };
  const evaluate = async (result = "pass", artifacts = {}) => {
    const response = result === "pass" ? passingGateProviderResponse : () => JSON.stringify({
      observations: artifacts.nextAction.diagnosis.observations.map(({ failureMode, requirementRef, where, observed }) => ({
        failureMode, requirementRef, where, observed,
        targets: [{ entity: "spec", field: "goal" }],
        allowedTargets: [{ target: { entity: "spec", field: "goal" }, operationKinds: ["replace-field"] }],
      })),
    });
    const produced = await produceGateResult(ctx, response);
    assert.equal(produced.result, result, JSON.stringify(produced));
    return produced;
  };
  return { root, specId, manager, fixture, ctx, evaluate };
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
      stdout: (chunk) => output.push(chunk), stderr: (chunk) => input.stderr?.(chunk), setExitCode: () => {},
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
  const input = await setup({ faultInjector: ({ phase, filePath }) => {
    if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
      throw new Error("injected Spec Gate settlement interruption");
    }
  } });
  catalogFile = input.fixture.location().catalogFile;
  const result = await input.evaluate("fail", {
    failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "spec.json", locator: "goal" },
      observed: "The goal requires a bounded outcome.", severity: "blocking", refs: ["R-1"],
    }] } },
  });
  const before = bytesAt(input.fixture.location());
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
    const input = await setup();
    const result = await input.evaluate("pass");
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
  const input = await setup();
  const promoted = await input.evaluate("pass");
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
  const input = await setup();
  const promoted = await input.evaluate("pass");
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
  const input = await setup();
  const promoted = await input.evaluate("pass");
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
  const input = await setup({});
  const initialAttempt = input.manager.canonicalState(input.specId).attempt;
  let calls = 0;
  const result = await produceGateResult(input.ctx, () => {
    calls += 1;
    return "invalid provider JSON";
  });
  assert.equal(calls, 2, "one initial provider call and one protocol retry");
  assert.equal(result.result, "fail");
  assert.equal(result.artifacts.failureCode, "GATE_REQUIRED_OUTPUT");
  assert.deepEqual(result.artifacts.evaluations, []);
  // Evaluation owns the execution claim and durable protocol observations.
  // A rejected post must preserve that exact authenticated producer frontier.
  const before = bytesAt(input.fixture.location());
  await assert.rejects(() => flowCommands.run.gate.post(input.ctx, result),
    { code: "GATE_OUTPUT_TOOLING_FAILURE" });
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  assert.equal(input.manager.readCurrentStepSettlement({
    specId: input.specId, stepId: "spec-gate",
  }), null);
  const state = input.manager.canonicalState(input.specId);
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.attempt.id, initialAttempt.id);
  assert.equal(state.attempt.sequence, initialAttempt.sequence);
  assert.equal(state.attempt.consumption.semantic, initialAttempt.consumption.semantic);
  assert.equal(state.attempt.failure, null);
});

async function rejectedProviderResult(input) {
  let calls = 0;
  const result = await produceGateResult(input.ctx, () => {
    calls += 1;
    return "invalid provider JSON";
  });
  assert.equal(calls, 2);
  assert.equal(result.result, "fail");
  return result;
}

test("Spec tooling evidence crosses the cloned post error and exact Attempt failure transaction", async () => {
  const input = await setup({});
  const initialAttempt = input.manager.canonicalState(input.specId).attempt;
  const result = await rejectedProviderResult(input);
  const evidence = AgentResponseProtocolEvidence.from(result.artifacts.responseProtocolEvidence);
  const before = bytesAt(input.fixture.location());
  await assert.rejects(() => flowCommands.run.gate.post(input.ctx, result), (error) => {
    assert.equal(error.code, "GATE_OUTPUT_TOOLING_FAILURE");
    assert.equal(error.data.responseProtocolEvidence instanceof AgentResponseProtocolEvidence, false);
    assert.deepEqual(AgentResponseProtocolEvidence.from(error.data.responseProtocolEvidence).toJSON(), evidence.toJSON());
    return true;
  });
  assert.deepEqual(bytesAt(input.fixture.location()), before, "direct tooling rejection must not publish a semantic result");

  const envelope = await dispatchGate(input, result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.errors[0].code, "GATE_OUTPUT_TOOLING_FAILURE");
  const restored = new FlowManager({ root: input.root, mainRoot: input.root, inWorktree: false, specId: input.specId });
  const state = restored.canonicalState(input.specId);
  assert.equal(state.attempt.id, initialAttempt.id);
  assert.equal(state.attempt.sequence, initialAttempt.sequence);
  assert.equal(state.attempt.consumption.semantic, initialAttempt.consumption.semantic);
  assert.equal(state.attempt.failure.code, "GATE_OUTPUT_TOOLING_FAILURE");
  assert.ok(state.attempt.failure.responseProtocolEvidence instanceof AgentResponseProtocolEvidence);
  assert.deepEqual(state.attempt.failure.responseProtocolEvidence.toJSON(), evidence.toJSON());
  const failure = restored.activityLedger(input.specId).findLast((entry) => entry.type === "attempt_failed");
  assert.equal(failure.attemptId, initialAttempt.id);
  assert.deepEqual(AgentResponseProtocolEvidence.from(failure.failure.responseProtocolEvidence).toJSON(), evidence.toJSON());
  assert.equal(restored.readCurrentStepSettlement({ specId: input.specId, stepId: "spec-gate" }), null);
  assert.equal(restored.readProducerArtifact({ specId: input.specId, nodeId: "spec-gate", logicalKey: "spec.gate", optional: true }), null);
});

test("a fault saving Spec protocol failure preserves canonical state and exposes the save failure", async () => {
  let interrupt = false;
  let catalogFile = null;
  const input = await setup({ faultInjector: ({ phase, filePath }) => {
    if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
      throw new Error("injected protocol failure save interruption");
    }
  } });
  catalogFile = input.fixture.location().catalogFile;
  const result = await rejectedProviderResult(input);
  const before = bytesAt(input.fixture.location());
  const diagnostic = [];
  input.stderr = (chunk) => diagnostic.push(chunk);
  interrupt = true;
  const envelope = await dispatchGate(input, result);
  assert.equal(envelope.ok, false);
  assert.match(diagnostic.join(""), /injected protocol failure save interruption/);
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  const restored = new FlowManager({ root: input.root, mainRoot: input.root, inWorktree: false, specId: input.specId });
  assert.equal(restored.canonicalState(input.specId).attempt.failure, null);
  assert.equal(restored.activityLedger(input.specId).filter((entry) => entry.type === "attempt_failed").length, 0);
});

test("stale Spec protocol evidence cannot replace another Attempt failure", async () => {
  const input = await setup({});
  const result = await rejectedProviderResult(input);
  const initial = input.manager.canonicalState(input.specId).attempt;
  const priorFailure = {
    category: "tooling", code: "EXISTING_ATTEMPT_FAILURE", message: "The Attempt is already stopped.",
    retryable: false, retryKind: null,
  };
  input.manager.failCurrentAttempt({ specId: input.specId, failure: priorFailure,
    result: { outcome: "failed", summary: priorFailure.message, confirmedAt: initial.startedAt, artifactRefs: [] },
  });
  const before = bytesAt(input.fixture.location());
  const envelope = await dispatchGate(input, result);
  assert.equal(envelope.ok, false);
  assert.deepEqual(bytesAt(input.fixture.location()), before);
  const restored = new FlowManager({ root: input.root, mainRoot: input.root, inWorktree: false, specId: input.specId });
  assert.equal(restored.canonicalState(input.specId).attempt.failure.code, priorFailure.code);
  assert.equal(restored.canonicalState(input.specId).attempt.failure.responseProtocolEvidence, null);
});
