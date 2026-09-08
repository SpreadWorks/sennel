/**
 * tests/integration/flow/set-step.test.js
 *
 * Tests for `flow set step` — updates step status and returns JSON envelope.
 */

import { describe, it, afterEach } from "node:test";
import { CanonicalFlowFixture, TaskLifecycleFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import SetStepCommand from "../../../src/flow/lib/set-step.js";
const FLOW_CMD = join(process.cwd(), "src/flow.js");

describe("flow set step", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function setupFlowState(dir) {
    const specId = "001-test";
    return new CanonicalFlowFixture({
      flowManager: makeFlowManager(dir), specId, runId: "run-test",
    }).create().registerActive();
  }

  it("updates step and returns JSON envelope", () => {
    tmp = createTmpDir();
    setupFlowState(tmp).activate("branch");
    const result = execFileSync(
      "node", [FLOW_CMD, "set", "step", "branch", "done"],
      { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } },
    );
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, "set");
    assert.equal(envelope.key, "step");

    const loaded = makeFlowManager(tmp).load();
    const branch = findStepById(loaded.steps, "branch");
    assert.equal(branch.status, "done");
  });

  it("returns error for invalid step ID", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    try {
      execFileSync(
        "node", [FLOW_CMD, "set", "step", "nonexistent", "done"],
        { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } },
      );
      assert.fail("should exit non-zero");
    } catch (err) {
      const envelope = JSON.parse(err.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.errors[0].level, "fatal");
    }
  });

  it("passes explicit flow and task scope for the resolved active step", async () => {
    tmp = createTmpDir();
    const flowManager = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "demo",
      specRecord: { requirements: [{ id: "R-T-1", desc: "Exercise Task step scope.", task_ids: ["T-1"] }] },
    })
      .create()
      .addTask({
        id: "T-1", title: "task", goal: "task", parent: null,
        origin: "plan", added_round: 0, status: "pending",
      })
      .activate("branch");
    const command = new SetStepCommand();

    await command.execute({
      id: "branch",
      status: "done",
      specId: "demo",
      flowManager,
    });
    fixture.settleBefore("T-1-impl").activateTask("T-1", { settlePredecessors: false });
    await command.execute({
      id: "task-impl",
      status: "done",
      specId: "demo",
      flowManager,
    });

    const state = flowManager.loadReadOnly("demo");
    assert.equal(findStepById(state.steps, "branch").status, "done");
    assert.equal(state.tasks[0].steps[0].id, "T-1-impl");
    assert.equal(state.tasks[0].steps[0].status, "done");
  });

  it("rejects a current step whose completion is owned by a definition lifecycle", async () => {
    tmp = createTmpDir();
    const flowManager = makeFlowManager(tmp);
    new CanonicalFlowFixture({ flowManager, specId: "demo" })
      .create()
      .activate("scenario-validity");
    const result = await new SetStepCommand().execute({
      id: "scenario-validity",
      status: "done",
      root: tmp,
      specId: "demo",
      flowManager,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_STEP_TRANSITION_INVALID");
    assert.equal(findStepById(flowManager.loadReadOnly("demo").steps, "scenario-validity").status, "in_progress");
  });

  it("rejects direct completion or skip of Task review-funnel stages without changing state or Activities", async () => {
    tmp = createTmpDir();
    for (const role of ["review", "triage", "repair"]) {
      const root = join(tmp, role);
      fs.mkdirSync(root, { recursive: true });
      const flowManager = makeFlowManager(root);
      new TaskLifecycleFixture({
        flowManager,
        specId: `task-${role}`,
        runId: `run-task-${role}`,
        taskId: "T-1",
        targetStep: `task-${role}`,
        taskDocuments: [{ id: "T-1", title: "task", goal: "task", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      }).create();
      for (const status of ["done", "skipped"]) {
        const beforeState = JSON.stringify(flowManager.canonicalState(`task-${role}`).toJSON());
        const beforeActivities = JSON.stringify(flowManager.activityLedger(`task-${role}`));
        const result = await new SetStepCommand().execute({
          id: `task-${role}`,
          status,
          root,
          specId: `task-${role}`,
          flowManager,
        });
        assert.equal(result.ok, false);
        assert.equal(result.errors[0].code, "FLOW_STEP_TRANSITION_INVALID");
        assert.equal(JSON.stringify(flowManager.canonicalState(`task-${role}`).toJSON()), beforeState);
        assert.equal(JSON.stringify(flowManager.activityLedger(`task-${role}`)), beforeActivities);
      }
    }
  });
});
