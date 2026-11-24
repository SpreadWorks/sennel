import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { FlowTargetBinding } from "../../../../src/lib/flow-target-guard.js";
import { ProcessExecutionFinalizationBarrier } from "../../../../src/lib/process-execution-finalization.js";
import { withFlowProcessRuntime } from "../../../../src/flow/lib/process-runtime-admission.js";
import { CanonicalFlowFixture, FlowAtStepFixture, makeFlowManager } from "../../../support/infrastructure/flow-setup.js";
import { fixtureRepository } from "../../../support/infrastructure/flow-dispatch-scenario.js";
import { createTmpDir } from "../../../support/builders/tmp-dir.js";
import { StoredFlowPersistenceSnapshot } from "../../../support/assertions/canonical-persistence.js";
import { removeQuiescentRuntimeFixture } from "../../../support/infrastructure/runtime-fixture-cleanup.js";

const SENNEL = path.resolve("src/sennel.js");
const roots = [];

function root() {
  const directory = createTmpDir("sennel-flow-get-artifact-");
  roots.push(directory);
  return directory;
}

afterEach(() => {
  while (roots.length > 0) removeQuiescentRuntimeFixture({ mainRoot: roots.pop() });
});

function specRecord(goal) {
  return {
    goal,
    background: "The exact cataloged record is the only source.",
    scope: { in: ["Read one Version"], out: ["Mutate Flow state"] },
    constraints: ["Node built-ins only."],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [],
    acceptance_criteria: ["The renderer reads cataloged sources."],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

function createFixture(directory, { specId, goal, active = false } = {}) {
  const flowManager = makeFlowManager(directory);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    specRecord: specRecord(goal),
  }).create();
  if (active) fixture.registerActive();
  return { flowManager, fixture };
}

function invoke(directory, args) {
  const result = spawnSync(process.execPath, [SENNEL, "flow", "get", "artifact", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SENNEL_WORK_ROOT: directory },
  });
  let envelope = null;
  if (result.stdout.trim() !== "") envelope = JSON.parse(result.stdout);
  return { ...result, envelope };
}

describe("flow get artifact CLI", () => {
  it("parses the registered command, hides cache metadata, and leaves the whole project unchanged", () => {
    const directory = root();
    const { fixture } = createFixture(directory, {
      specId: "514-cli-active",
      goal: "The active CLI target is rendered exactly once.",
      active: true,
    });
    const before = new StoredFlowPersistenceSnapshot(directory);
    const result = invoke(directory, ["spec.record", "--mode", "full"]);
    const cachePath = path.join(
      fixture.location().directory,
      ".runtime",
      "views",
      "spec.record.full.md",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.ok, true);
    assert.match(result.envelope.data.markdown, /active CLI target is rendered exactly once/i);
    assert.equal(result.envelope.data.markdown.startsWith("<!--"), false);
    assert.equal(fs.existsSync(cachePath), false);
    before.assertUnchanged();
  });

  it("uses only the supplied completed Version even when the ambient active registry is corrupt", async () => {
    const directory = fixtureRepository("sennel-flow-get-artifact-");
    roots.push(directory);
    const active = createFixture(directory, {
      specId: "514-cli-active",
      goal: "This ambient Flow must never be read.",
      active: true,
    });
    const completedManager = makeFlowManager(directory, { specId: "514-cli-completed" });
    const completed = await new FlowAtStepFixture({
      flowManager: completedManager,
      specId: "514-cli-completed",
      runId: "run-514-cli-completed",
      execution: { mode: "direct", baseBranch: "main" },
      specRecord: {
        ...specRecord("The exact completed Version is rendered despite ambient corruption."),
        requirements: [{ id: "R-view", desc: "Render the exact saved Version.", testable: false }],
      },
      targetStep: "finalize-cleanup",
    }).createWithProducers({
      implementationFiles: new Map([["R-view", ["version-view.js"]]]),
      sourceMutations: new Map([["implement", () => {
        fs.writeFileSync(path.join(directory, "version-view.js"), "export const exactVersionView = true;\n");
      }]]),
    });
    completed.flow.flow.settle("finalize-cleanup");
    const completedSpecId = completed.state().specId;
    // This fixture settles canonical cleanup directly; its real producer
    // history still requires the normal runtime fence before finalization.
    await withFlowProcessRuntime({
      root: directory,
      mainRoot: directory,
      executionRoot: directory,
      specId: completedSpecId,
      flowManager: completedManager,
      flowState: completedManager.loadReadOnly(completedSpecId),
    }, () => completedManager.finalizeFlow(completedSpecId), { commandId: "finalize-cleanup" });
    const finalized = completedManager.canonicalState(completedSpecId);
    assert.equal(finalized.lifecycle.state, "finalized");
    const finalization = completedManager.activityLedger(completedSpecId)
      .findLast((activity) => activity.transition.operation === "finalize_flow");
    const barrier = ProcessExecutionFinalizationBarrier.fromStored(finalization.processFinalizationBarrier);
    assert.deepEqual(barrier.selection.toJSON(), {
      runId: finalized.runId,
      specId: finalized.specId,
      flowVersionId: finalized.flowVersionId,
    });
    fs.writeFileSync(path.join(directory, ".sennel", ".active-flow"), "{ corrupt ambient authority\n");
    const before = new StoredFlowPersistenceSnapshot(directory);

    const result = invoke(directory, [
      "spec.record",
      "--mode", "full",
      "--spec-id", "514-cli-completed",
      "--version", "1",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.ok, true);
    assert.match(result.envelope.data.markdown, /exact completed Version is rendered despite ambient corruption/i);
    assert.equal(fs.existsSync(path.join(completed.location().directory, ".runtime", "views", "spec.record.full.md")), false);
    before.assertUnchanged();
  });

  it("rejects unsupported, extra, partial, and stale active targets before a cache or summary agent can run", () => {
    const directory = root();
    const { fixture } = createFixture(directory, {
      specId: "514-cli-guards",
      goal: "Guard invalid input before reading a view.",
      active: true,
    });
    const staleRoot = root();
    const state = fixture.state();
    const staleBinding = new FlowTargetBinding({
      runId: state.runId,
      issue: state.issue,
      specId: state.specId,
      authority: {
        mode: "direct",
        mainRoot: staleRoot,
        executionRoot: staleRoot,
        featureBranch: null,
        baseBranch: null,
      },
    }).serialize();
    const invalidCommands = [
      ["flow.activities", "--mode", "full"],
      ["spec.record", "extra", "--mode", "full"],
      ["spec.record", "--mode", "full", "--unknown"],
      ["spec.record", "--mode", "full", "--spec-id", "514-cli-guards"],
      ["spec.record", "--mode", "full", "--spec-id", "514-cli-guards", "--version", "1", "--expect-binding", staleBinding],
    ];

    for (const args of invalidCommands) {
      const result = invoke(directory, args);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.envelope.ok, false);
      assert.equal(result.envelope.errors[0].code, "ARGS_ERROR");
    }
    const stale = invoke(directory, ["spec.record", "--mode", "summary", "--expect-binding", staleBinding]);
    assert.notEqual(stale.status, 0, stale.stderr);
    assert.equal(stale.envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
    assert.equal(fs.existsSync(path.join(fixture.location().directory, ".runtime", "views")), false);
  });

  it("reports source and summary failures as closed envelopes and leaves an unusable project cache untouched", () => {
    const directory = root();
    const { fixture } = createFixture(directory, {
      specId: "514-cli-failures",
      goal: "Classify CLI artifact view failures.",
      active: true,
    });
    const location = fixture.location();
    const summary = invoke(directory, ["spec.record", "--mode", "summary"]);
    assert.notEqual(summary.status, 0, `${summary.stderr}\n${summary.stdout}`);
    assert.ok(summary.envelope, `${summary.stderr}\n${summary.stdout}`);
    assert.equal(summary.envelope.errors[0].code, "ARTIFACT_VIEW_AGENT_UNAVAILABLE");
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime", "views", "spec.record.summary.md")), false);

    fs.appendFileSync(location.specFile, "\ncorrupt source bytes");
    const readFailure = invoke(directory, ["spec.record", "--mode", "full"]);
    assert.notEqual(readFailure.status, 0, readFailure.stderr);
    assert.equal(readFailure.envelope.errors[0].code, "ARTIFACT_VIEW_READ_FAILED");

    // A separate clean target retains an unusable project cache: the public
    // invocation uses its own workspace and must neither read nor repair it.
    const warningDirectory = root();
    const warning = createFixture(warningDirectory, {
      specId: "514-cli-warning",
      goal: "Render despite a non-authoritative cache failure.",
      active: true,
    });
    fs.mkdirSync(path.join(warning.fixture.location().directory, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(warning.fixture.location().directory, ".runtime", "views"), "not a directory");
    const before = new StoredFlowPersistenceSnapshot(warningDirectory);
    const warningResult = invoke(warningDirectory, ["spec.record", "--mode", "full"]);
    assert.equal(warningResult.status, 0, warningResult.stderr);
    assert.equal(warningResult.envelope.ok, true);
    assert.equal(warningResult.envelope.errors.some((error) => error.code === "ARTIFACT_VIEW_CACHE_NOT_SAVED"), false);
    assert.match(warningResult.envelope.data.markdown, /Render despite a non-authoritative cache failure/);
    before.assertUnchanged();
  });
});
