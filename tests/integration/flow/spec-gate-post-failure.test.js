import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, test } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import {
  DraftStepSettlementPublication,
  DraftStepSettlementReceipt,
  settleSpecStepResult,
} from "../../../src/flow/definition.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { SpecGateBlockedResult } from "../../../src/flow/engine/step-result.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

async function failedPostHook() {
  const root = fixtureRepository("spec-gate-post-failure-");
  roots.push(root);
  const specId = "761-spec-gate-post-failure";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const flow = new CanonicalFlowFixture({
    flowManager: manager, specId, runId: "run-spec-gate-post-failure",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive();
  flow.activate("draft");
  manager.publishArtifacts({
    specId, nodeId: "draft",
    artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`),
    }],
  });
  flow.settle("draft");
  flow.activate("spec-gate");
  const result = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
  }).promote({ result: "pass", artifacts: { phase: "spec" } });
  class GateCommand extends Command {
    static outputMode = "envelope";
    execute() { return result; }
  }
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  const originalSelection = SpecGateStep.prototype.selectResult;
  const output = [];
  try {
    entry.command = async () => ({ default: GateCommand });
    SpecGateStep.prototype.selectResult = () => { throw new Error("injected Spec Gate post failure"); };
    const values = { paths: { root }, flowManager: manager, mainRoot: root, config: null, inWorktree: false };
    await dispatch({
      container: {
        get(name) { return values[name] ?? null; },
        has(name) { return Object.hasOwn(values, name); },
      },
      entry, argv: [], envelopeType: "run", envelopeKey: "gate",
      stdout: (chunk) => output.push(chunk), stderr: () => {}, setExitCode: () => {},
      buildHookCtx: () => ({
        root, mainRoot: root, executionRoot: root, specId, phase: "spec",
        flowManager: manager, flowState: manager.loadReadOnly(specId), config: {},
      }),
    });
  } finally {
    entry.command = originalCommand;
    SpecGateStep.prototype.selectResult = originalSelection;
  }
  const envelope = JSON.parse(output.join(""));
  const failure = manager.canonicalState(specId).attempt.failure;
  assert.equal(envelope.errors.some((error) => error.code === "SPEC_GATE_POST_FAILED"), true);
  assert.equal(failure.code, "SPEC_GATE_POST_FAILED");
  assert.equal(failure.retryable, false);
  assert.equal(manager.readCurrentStepSettlement({ specId, stepId: "spec-gate" }), null);
  return { root, specId, location: flow.location() };
}

async function assertStableBlocked({ root, specId }, reason) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const context = () => ({
    root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
    flowState: manager.loadReadOnly(specId),
  });
  const before = {
    state: manager.canonicalState(specId).toJSON(),
    activities: manager.activityLedger(specId),
    catalog: manager.artifactCatalog(specId).toJSON(),
  };
  const status = new GetStatusCommand().execute(context());
  assert.equal(status.active, true);
  assert.equal(status.specId, specId);
  assert.equal(status.phase, "plan");
  const next = await new GetNextActionCommand().execute(context());
  assert.equal(next.directive.kind, "blocked");
  assert.equal(next.directive.code, "SPEC_GATE_POST_FAILED");
  assert.equal(next.directive.requiresUserAction, false);
  assert.match(next.directive.reason, reason);
  assert.doesNotMatch(JSON.stringify(next), /repair-plan-gate/);

  let workerCalls = 0;
  const agent = { async call() { workerCalls += 1; throw new Error("worker must not run"); } };
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
  dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
  const boundary = await dispatcher.execute({
    ...context(),
    expectBinding: FlowTargetBinding.capture({
      flowState: manager.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
    }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch",
  });
  assert.equal(boundary.dispatch?.boundary, "blocked");
  assert.equal(boundary.nextAction?.directive?.code, next.directive.code);
  assert.equal(boundary.nextAction?.directive?.reason, next.directive.reason);
  assert.doesNotMatch(JSON.stringify(boundary), /repair-plan-gate/);
  assert.equal(workerCalls, 0);
  assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state);
  assert.deepEqual(manager.activityLedger(specId), before.activities);
  assert.deepEqual(manager.artifactCatalog(specId).toJSON(), before.catalog);
  return { next, boundary };
}

test("unsettled Spec Gate post failure remains blocked after reload without running a worker", async () => {
  const input = await failedPostHook();
  const { next } = await assertStableBlocked(input, /no current Result and Settlement receipt/);
  assert.match(next.directive.resumeInstruction, /No recovery is authorized for this Attempt/);
});

test("a forged current Spec Gate receipt remains blocked after reload", async () => {
  const input = await failedPostHook();
  const { activitiesFile, catalogFile } = input.location;
  const activities = fs.readFileSync(activitiesFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const failure = activities.find((entry) => (
    entry.nodeId === "spec-gate" && entry.transition.operation === "fail_attempt"
  ));
  assert.notEqual(failure, undefined);
  const result = new SpecGateBlockedResult(new Error("forged blocked result"));
  const receipt = new DraftStepSettlementReceipt({
    binding: {
      runId: "run-spec-gate-post-failure", specId: input.specId, stepId: "spec-gate",
      attempt: { id: failure.attemptId, sequence: failure.sequence },
    },
    result, settlement: settleSpecStepResult("spec-gate", result),
    publication: new DraftStepSettlementPublication({ gate: "forged" }),
  });
  failure.result.stepResult = result.toJSON();
  failure.result.draftSettlementReceipt = receipt.toJSON();
  const bytes = Buffer.from(`${activities.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  fs.writeFileSync(activitiesFile, bytes);
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const activityDescriptor = catalog.artifacts.find((entry) => entry.relativePath === "activities.jsonl");
  assert.notEqual(activityDescriptor, undefined);
  activityDescriptor.hash = createHash("sha256").update(bytes).digest("hex");
  activityDescriptor.size = bytes.length;
  fs.writeFileSync(catalogFile, `${JSON.stringify(new FlowArtifactCatalog({ artifacts: catalog.artifacts }).toJSON())}\n`);

  const { next } = await assertStableBlocked(input, /no valid current settlement/);
  assert.match(next.directive.reason, /does not match its receipt, Attempt, catalog, and Activity/);
});
