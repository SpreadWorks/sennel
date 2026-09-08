import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TASK_STEPS_PLAN, buildInitialTaskSteps } from "../../../src/lib/flow-helpers.js";
import { collectTaskLeafIds, getTaskNode } from "../../../src/flow/definition.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, FreshFlowFixture, TaskLifecycleFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";

const SRC_ROOT = path.resolve(new URL(import.meta.url).pathname, "../../../../src");

function taskDocument(id, parent = null) {
  return {
    id,
    title: `Task ${id}`,
    goal: `Complete ${id}.`,
    parent,
    origin: "plan",
    added_round: 0,
    status: "pending",
  };
}

function mappedTaskSpec(...taskIds) {
  return { requirements: [{ id: "R-tasks", desc: "Exercise canonical Task control.", task_ids: taskIds }] };
}

function completedTaskFixture(tmp, taskDocuments, taskId) {
  const fm = makeFlowManager(tmp);
  const fixture = new TaskLifecycleFixture({ flowManager: fm, taskDocuments, taskId, targetStep: "task-gate" }).create();
  fixture.flow.flow.settle(`${taskId}-gate`);
  return { fm, fixture };
}

describe("T-6: task-scope step redesign and manual control CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("TASK_STEPS_PLAN declares the complete Task review funnel", () => {
    assert.deepEqual(TASK_STEPS_PLAN, ["task-impl", "task-review", "task-triage", "task-repair", "task-gate"]);
  });

  it("buildInitialTaskSteps returns 5 pending steps matching TASK_STEPS_PLAN", () => {
    const steps = buildInitialTaskSteps("plan");
    assert.deepEqual(steps.map((step) => step.id), TASK_STEPS_PLAN);
    assert.ok(steps.every((step) => step.status === "pending"));
  });

  it("TASK_DEFINITION excludes retired Task leaves", () => {
    const taskIds = collectTaskLeafIds();
    for (const retired of ["approval", "gate", "update-overview"]) {
      assert.equal(taskIds.includes(retired), false, `${retired} must not be a Task leaf`);
    }
  });

  it("TASK_DEFINITION retains the task-gate leaf", () => {
    assert.ok(getTaskNode("task-gate"));
  });

  it("retired approval Task prompt file does not exist", () => {
    assert.equal(fs.existsSync(path.join(SRC_ROOT, "flow/prompts/task", "approval.md")), false);
  });

  it("retired gate Task prompt file does not exist", () => {
    assert.equal(fs.existsSync(path.join(SRC_ROOT, "flow/prompts/task", "gate.md")), false);
  });

  it("retired update-overview Task prompt file does not exist", () => {
    assert.equal(fs.existsSync(path.join(SRC_ROOT, "flow/prompts/task", "update-overview.md")), false);
  });

  it("task impl prompt returns overview additions through the dispatcher-owned handoff", () => {
    const prompt = fs.readFileSync(path.join(SRC_ROOT, "flow/prompts/task/task-impl.md"), "utf8");
    assert.ok(prompt.includes("effects.json"));
    assert.ok(prompt.includes("required overview additions"));
    assert.ok(prompt.includes("no canonical Flow write authority"));
    assert.ok(prompt.includes("run update-overview"));
    assert.ok(prompt.includes("Do not call"));
  });

  it("start-task claims a pending Spec Task through the production primitive", async () => {
    tmp = createTmpDir("t6-start-");
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specRecord: mappedTaskSpec("T-1") })
      .create().addTask(taskDocument("T-1")).registerActive();
    fixture.prepareTaskFrontier();
    const { RunStartTaskCommand } = await import("../../../src/flow/lib/run-start-task.js");
    const env = await new RunStartTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-1" });
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.deepEqual(env.data, { taskId: "T-1", currentTaskId: "T-1", status: "in_progress" });
    const task = fm.loadReadOnly().tasks.find((entry) => entry.id === "T-1");
    assert.equal(task.status, "in_progress");
  });

  it("start-task returns the canonical unknown-Task envelope", async () => {
    tmp = createTmpDir("t6-start-");
    const fm = makeFlowManager(tmp);
    new FreshFlowFixture({ flowManager: fm, specRecord: mappedTaskSpec("T-1") })
      .create().addTask(taskDocument("T-1")).registerActive();
    const { RunStartTaskCommand } = await import("../../../src/flow/lib/run-start-task.js");
    const env = await new RunStartTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-missing" });
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "UNKNOWN_TASK_ID");
  });

  it("complete-task completes an explicitly selected Task after its typed child confirmations", async () => {
    tmp = createTmpDir("t6-complete-");
    const { fm } = completedTaskFixture(tmp, [taskDocument("T-1")], "T-1");
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-1" });
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.equal(env.data.taskId, "T-1");
    assert.equal(env.data.completed, true);
    assert.equal(fm.loadReadOnly().tasks.find((entry) => entry.id === "T-1").status, "done");
  });

  it("complete-task resolves the selected current Task when no task id is supplied", async () => {
    tmp = createTmpDir("t6-complete-");
    const { fm } = completedTaskFixture(tmp, [taskDocument("T-1")], "T-1");
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly() });
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.equal(env.data.taskId, "T-1");
    assert.equal(env.data.completed, true);
    assert.equal(fm.loadReadOnly().tasks.find((entry) => entry.id === "T-1").status, "done");
  });

  it("complete-task resolves the current Task and rejects it before child confirmation", async () => {
    tmp = createTmpDir("t6-complete-");
    const fm = makeFlowManager(tmp);
    new TaskLifecycleFixture({
      flowManager: fm,
      taskDocuments: [taskDocument("T-1")],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly() });
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "TASK_COMPLETE_INVALID");
    assert.equal(fm.loadReadOnly().currentTaskId, "T-1");
  });

  it("complete-task leaves the next Task pending for an explicit next claim", async () => {
    tmp = createTmpDir("t6-complete-");
    const { fm } = completedTaskFixture(tmp, [taskDocument("T-1"), taskDocument("T-2")], "T-1");
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-1" });
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.equal(env.data.nextTaskId, "T-2");
    const state = fm.loadReadOnly();
    assert.equal(state.currentTaskId, null);
    assert.equal(state.tasks.find((entry) => entry.id === "T-2").status, "pending");
  });

  it("complete-task propagates to a parent after the final child is completed", async () => {
    tmp = createTmpDir("t6-complete-");
    const tasks = [taskDocument("T-parent"), taskDocument("T-child-1", "T-parent"), taskDocument("T-child-2", "T-parent")];
    const { fm, fixture } = completedTaskFixture(tmp, tasks, "T-child-1");
    fm.completeTask("T-child-1");
    fixture.flow.flow.activateTask("T-child-2", { settlePredecessors: false });
    for (const step of ["T-child-2-impl", "T-child-2-review", "T-child-2-triage", "T-child-2-repair", "T-child-2-gate"]) fixture.flow.flow.settle(step);
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-child-2" });
    assert.equal(env.ok, true);
    const state = fm.loadReadOnly();
    assert.equal(state.tasks.find((entry) => entry.id === "T-child-2").status, "done");
    assert.equal(state.tasks.find((entry) => entry.id === "T-parent").status, "done");
  });

  it("complete-task returns NO_TASK_TARGET without an active Task", async () => {
    tmp = createTmpDir("t6-complete-");
    const fm = makeFlowManager(tmp);
    new CanonicalFlowFixture({ flowManager: fm }).create().registerActive();
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly() });
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "NO_TASK_TARGET");
  });

  it("complete-task returns UNKNOWN_TASK_ID for an explicit absent Task", async () => {
    tmp = createTmpDir("t6-complete-");
    const fm = makeFlowManager(tmp);
    new CanonicalFlowFixture({ flowManager: fm, specRecord: mappedTaskSpec("T-1") })
      .create().addTask(taskDocument("T-1")).registerActive();
    const { RunCompleteTaskCommand } = await import("../../../src/flow/lib/run-complete-task.js");
    const env = await new RunCompleteTaskCommand().execute({ root: tmp, flowManager: fm, flowState: fm.loadReadOnly(), taskId: "T-missing" });
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "UNKNOWN_TASK_ID");
  });

  it("the retained overview command uses the canonical manager operation", () => {
    const prompt = fs.readFileSync(path.join(SRC_ROOT, "flow/prompts/task/task-impl.md"), "utf8");
    const command = fs.readFileSync(path.join(SRC_ROOT, "flow/lib/run-update-overview.js"), "utf8");
    assert.ok(prompt.includes("Do not call") && prompt.includes("run update-overview"));
    assert.ok(command.includes("fm.updateTaskOverview"));
    assert.doesNotMatch(command, /persistOverviewUpdate|getSpecDir|saveSpecJson/);
  });

  it("impl overview additions remain in the handoff, not a separate Task leaf", () => {
    const prompt = fs.readFileSync(path.join(SRC_ROOT, "flow/prompts/task/task-impl.md"), "utf8");
    assert.ok(prompt.includes("effects.json"));
    assert.equal(TASK_STEPS_PLAN.includes("update-overview"), false);
  });
});
