import { describe, it, afterEach } from "node:test";
import {
  makeFlowManager,
  makeLifecycleStepTransition,
  makeNormalStepTransition,
  CanonicalFlowFixture,
  FlowAtStepFixture,
} from "../support/infrastructure/flow-setup.js";
import assert from "node:assert/strict";
import fs from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { buildInitialSteps, FLOW_STEPS } from "../../src/lib/flow-helpers.js";
import { flattenSteps, findStepById } from "../../src/flow/lib/step-tree.js";
const FLOW_CMD = join(process.cwd(), "src/flow.js");

// ── .active-flow pointer tests ──────────────────────────────────────────────

describe("active-flow pointer", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("loadActiveFlows returns empty array when .active-flow does not exist", () => {
    tmp = createTmpDir();
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.deepEqual(flows, []);
  });

  it("addActiveFlow creates .active-flow with one entry", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate-flow-state", "worktree");
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.equal(flows.length, 1);
    assert.equal(flows[0].specId, "086-migrate-flow-state");
    assert.equal(flows[0].mode, "worktree");
  });

  it("addActiveFlow appends to existing entries", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate", "worktree");
    makeFlowManager(tmp).addActiveFlow("087-other", "branch");
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.equal(flows.length, 2);
    assert.equal(flows[0].specId, "086-migrate");
    assert.equal(flows[1].specId, "087-other");
    assert.equal(flows[1].mode, "branch");
  });

  it("rejects a second branch flow while allowing worktree flows", () => {
    tmp = createTmpDir();
    const manager = makeFlowManager(tmp);
    manager.addActiveFlow("086-first", "branch");
    manager.addActiveFlow("087-worktree", "worktree");

    assert.throws(
      () => manager.addActiveFlow("088-second", "branch"),
      (error) => error.code === "ACTIVE_FLOW_BRANCH_CONFLICT" && error.specId === "086-first",
    );
    assert.deepEqual(manager.loadActiveFlows(), [
      { specId: "086-first", mode: "branch" },
      { specId: "087-worktree", mode: "worktree" },
    ]);
  });

  it("removeActiveFlow removes matching entry and keeps others", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate", "worktree");
    makeFlowManager(tmp).addActiveFlow("087-other", "branch");
    makeFlowManager(tmp).removeActiveFlow("086-migrate");
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.equal(flows.length, 1);
    assert.equal(flows[0].specId, "087-other");
  });

  it("removeActiveFlow deletes .active-flow file when last entry is removed", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate", "worktree");
    makeFlowManager(tmp).removeActiveFlow("086-migrate");
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.deepEqual(flows, []);
    assert.ok(!fs.existsSync(join(tmp, ".sennel", ".active-flow")));
  });

  it("removeActiveFlow is a no-op when spec ID does not exist", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate", "worktree");
    makeFlowManager(tmp).removeActiveFlow("999-nonexistent");
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.equal(flows.length, 1);
  });

  it(".active-flow is stored as valid JSON", () => {
    tmp = createTmpDir();
    makeFlowManager(tmp).addActiveFlow("086-migrate", "direct");
    const raw = fs.readFileSync(join(tmp, ".sennel", ".active-flow"), "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].specId, "086-migrate");
    assert.equal(parsed[0].mode, "direct");
  });
});

// ── flow.json storage in the canonical Version root ─────────────────────────

describe("flow-state (canonical Version-1 storage)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function createCanonicalFixture(specId = "001-test") {
    const manager = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "flow-state-storage",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create();
    return { fixture, manager, location: manager.specLocation(specId) };
  }

  it("fresh creation writes flow.json only to its resolved Version authority", () => {
    tmp = createTmpDir();
    const { fixture, manager, location } = createCanonicalFixture();
    assert.ok(fs.existsSync(manager.pathFor(fixture.state().specId)));
    assert.equal(manager.pathFor(fixture.state().specId), location.flowStateFile);
    assert.equal(fs.existsSync(join(dirname(location.directory), "flow.json")), false);
  });

  it("fresh creation does not write an unmanaged .sennel flow state", () => {
    tmp = createTmpDir();
    createCanonicalFixture();
    assert.ok(!fs.existsSync(join(tmp, ".sennel", "flow.json")));
  });

  it("does not read a retired root flow.json when resolving the active Flow", () => {
    tmp = createTmpDir();
    const { fixture, manager, location } = createCanonicalFixture();
    fixture.registerActive();
    fs.writeFileSync(join(dirname(location.directory), "flow.json"), "retired authority\n");

    const loaded = manager.load();
    assert.equal(loaded.specId, fixture.state().specId);
    assert.equal(loaded.runId, fixture.state().runId);
    assert.equal(manager.pathFor(loaded.specId), location.flowStateFile);
  });

  it("loadFlowState returns null when no .active-flow exists", () => {
    tmp = createTmpDir();
    assert.equal(makeFlowManager(tmp).load(), null);
  });

  it("clearFlowState removes the active entry but keeps the canonical flow.json", () => {
    tmp = createTmpDir();
    const { fixture, manager, location } = createCanonicalFixture();
    const specId = fixture.state().specId;
    fixture.registerActive();

    manager.clearFlowState(specId);

    // .active-flow entry should be removed
    const flows = makeFlowManager(tmp).loadActiveFlows();
    assert.equal(flows.length, 0);
    assert.ok(fs.existsSync(location.flowStateFile));
  });
});

// ── steps and requirements ──────────────────────────────────────────────────

describe("flow-state steps and requirements", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function atStep(dir, targetStep) {
    const flowManager = makeFlowManager(dir);
    return new FlowAtStepFixture({
      flowManager,
      specId: "001-test",
      runId: "run-test",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
      targetStep,
    }).create();
  }

  it("FLOW_STEPS does not contain 'archive'", () => {
    assert.ok(!FLOW_STEPS.includes("archive"), "archive step should be removed");
  });

  it("buildInitialSteps creates nested entries covering all leaf step ids", () => {
    const steps = buildInitialSteps();
    const flat = flattenSteps(steps);
    assert.equal(flat.length, FLOW_STEPS.length);
    // First leaf is promoted to in_progress by buildInitialNestedSteps;
    // all others should be pending.
    for (const step of flat.slice(1)) {
      assert.equal(step.status, "pending");
    }
  });

  it("updateStepStatus updates the correct step", () => {
    tmp = createTmpDir();
    const fixture = atStep(tmp, "spec-gate");
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    fixture.flow.flow.settle("spec-gate");
    const loaded = makeFlowManager(tmp).load();
    const gate = findStepById(loaded.steps, "spec-gate");
    assert.equal(gate.status, "done");
  });

  // ── canonical confirmation / explicit claim contract ───────────────────────

  it("leaves the next definition leaf pending until an explicit claim", () => {
    tmp = createTmpDir();
    const fixture = atStep(tmp, "branch");
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    fm.updateStepStatus(makeNormalStepTransition(fm.load(specId), "branch"), { specId });
    const loaded = fm.load();
    const branch = findStepById(loaded.steps, "branch");
    assert.equal(branch.status, "done");
    const prepareSpec = findStepById(loaded.steps, "prepare-spec");
    assert.equal(prepareSpec.status, "pending", "confirmation must not invent the next Attempt");
    fm.updateStepStatus({ stepId: "prepare-spec", requestedStatus: "in_progress" }, { specId });
    assert.equal(findStepById(fm.load().steps, "prepare-spec").status, "in_progress");
  });

  it("rejects a forbidden skipped transition without changing the active Attempt", () => {
    tmp = createTmpDir();
    const fixture = atStep(tmp, "prepare-spec");
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    assert.throws(
      () => fm.updateStepStatus(
        makeLifecycleStepTransition(fm.load(specId), "prepare-spec", "skipped"),
        { specId },
      ),
      /forbids transition.*skipped/i,
    );
    const loaded = fm.load();
    const prepareSpec = findStepById(loaded.steps, "prepare-spec");
    assert.equal(prepareSpec.status, "in_progress", "rejected transition keeps the current Attempt authoritative");
    const draft = findStepById(loaded.steps, "draft");
    assert.equal(draft.status, "pending", "no downstream Attempt is claimed");
  });

  it("updateStepStatus does NOT promote when another step is already in_progress (REQ-2)", () => {
    tmp = createTmpDir();
    const fixture = atStep(tmp, "spec");
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    const before = structuredClone(fm.load(specId));
    assert.throws(
      () => fm.updateStepStatus(
        makeLifecycleStepTransition(fm.load(specId), "branch", "done"),
        { specId },
      ),
      /definition-authorized|current Attempt|transition/i,
    );
    const loaded = fm.load();
    assert.deepEqual(loaded, before, "an invalid non-current transition does not alter canonical state");
    const spec = findStepById(loaded.steps, "spec");
    assert.equal(spec.status, "in_progress", "pre-existing in_progress step is not touched");
    const prepareSpec = findStepById(loaded.steps, "prepare-spec");
    assert.equal(prepareSpec.status, "done", "the fixture reached spec through typed predecessor confirmation");
    const draft = findStepById(loaded.steps, "draft");
    assert.equal(draft.status, "done", "draft is a typed predecessor of the active spec Attempt");
    const specGate = findStepById(loaded.steps, "spec-gate");
    assert.equal(specGate.status, "pending", "the next leaf remains pending until explicitly claimed");
  });

  it("rejects an already-active claim without advancing the next pending leaf", () => {
    tmp = createTmpDir();
    const fixture = atStep(tmp, "branch");
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    assert.throws(
      () => fm.updateStepStatus({ stepId: "branch", requestedStatus: "in_progress" }, { specId }),
      /cannot replace an active Attempt|already active|definition-authorized/i,
    );
    const loaded = fm.load();
    const prepareSpec = findStepById(loaded.steps, "prepare-spec");
    assert.equal(prepareSpec.status, "pending", "pending transition does not trigger promotion");
  });

  it("updateStepStatus does nothing when no pending steps remain (REQ-1 edge)", () => {
    tmp = createTmpDir();
    const flowManager = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-test",
      runId: "run-test",
      execution: { mode: "direct" },
    }).create().registerActive();
    for (const step of fixture.leaves()) fixture.settle(step.id);
    const specId = fixture.state().specId;
    const fm = makeFlowManager(tmp);
    assert.equal(typeof fm.mutate, "undefined");
    const flat = flattenSteps(fm.load().steps);
    // A terminal retry is rejected and cannot promote a nonexistent pending step.
    const lastStep = flat[flat.length - 1];
    assert.throws(
      () => makeNormalStepTransition(fm.load(specId), lastStep.id),
      /current status in_progress/,
    );
    const loaded = fm.load();
    for (const s of flattenSteps(loaded.steps)) {
      assert.ok(["done", "skipped"].includes(s.status), `${s.id} must be terminal`);
    }
  });
});
