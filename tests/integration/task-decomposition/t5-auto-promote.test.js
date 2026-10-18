import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, TaskLifecycleFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { promoteNextPending, findNextPendingTask } from "../../../src/lib/flow-helpers.js";

function pureTask(id, status = "pending", parent = null) {
  return { id, status, parent };
}

function taskDocument(id, parent = null) {
  return { id, title: `Task ${id}`, goal: `Complete ${id}.`, parent, origin: "plan", added_round: 0, status: "pending" };
}

function mappedSpec(...taskIds) {
  return { requirements: [{ id: "R-tasks", desc: "Exercise explicit Task selection.", task_ids: taskIds }] };
}

describe("T-5: Task selection and explicit claim boundaries", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("promoteNextPending is a no-op while a Task is selected", () => {
    const state = { currentTaskId: "T-1", tasks: [pureTask("T-1"), pureTask("T-2")] };
    assert.equal(promoteNextPending(state), null);
    assert.equal(state.currentTaskId, "T-1");
  });

  it("promoteNextPending uses forest leaf priority for its pure selection input", () => {
    const state = { currentTaskId: null, tasks: [pureTask("T-root"), pureTask("T-done", "done", "T-root"), pureTask("T-leaf", "pending", "T-root")] };
    assert.equal(promoteNextPending(state), "T-leaf");
    assert.equal(state.currentTaskId, "T-leaf");
    assert.equal(state.tasks.find((task) => task.id === "T-leaf").status, "in_progress");
  });

  it("pure selection is a no-op for an empty forest", () => {
    const empty = { currentTaskId: null, tasks: [] };
    assert.equal(promoteNextPending(empty), null);
    assert.equal(empty.currentTaskId, null);
  });

  it("pure selection is a no-op for a complete forest", () => {
    const done = { currentTaskId: null, tasks: [pureTask("T-1", "done"), pureTask("T-2", "done")] };
    assert.equal(findNextPendingTask(done.tasks), null);
    assert.equal(promoteNextPending(done), null);
    assert.equal(done.currentTaskId, null);
  });

  it("canonical Task admission records pending Tasks without mutable sync input", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-canonical-admission", specRecord: mappedSpec("T-1", "T-2") })
      .create().addTasks([taskDocument("T-1"), taskDocument("T-2")]).registerActive();
    const state = fixture.state();
    assert.deepEqual(state.tasks.map((task) => [task.id, task.status]), [["T-1", "pending"], ["T-2", "pending"]]);
    assert.equal(state.currentTaskId, null);
  });

  it("the next pending Task is claimed only by the typed startTask transition", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-explicit-claim", specRecord: mappedSpec("T-1") })
      .create().addTasks([taskDocument("T-1")]).registerActive();
    fixture.prepareTaskFrontier();
    fm.startTask("T-1");
    const state = fm.loadReadOnly();
    assert.equal(state.currentTaskId, "T-1");
    assert.equal(state.tasks[0].status, "in_progress");
  });

  it("get-next-action returns to Flow scope after every Task is completed", async () => {
    tmp = fixtureRepository("task-scope-completion-");
    const fm = makeFlowManager(tmp);
    const { flow } = await new TaskLifecycleFixture({
      flowManager: fm,
      specId: "226-flow-frontier",
      taskDocuments: [taskDocument("T-1")],
      taskId: "T-1",
      targetStep: "task-review",
    }).createWithProducers();
    await flow.flow.produce("T-1-review");
    fm.completeTask("T-1");
    const out = execFileSync("node", [path.join(process.cwd(), "src/sennel.js"), "flow", "get", "next-action"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    const envelope = JSON.parse(out);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.taskId, null, "completed Task forest must return to Flow scope");
    assert.notEqual(envelope.data.step, "task-impl");
    assert.ok(flow.location().relativeDirectory.endsWith("/001"));
  });

  it("get-next-action remains Task-scoped at an explicit Task lifecycle frontier", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    new TaskLifecycleFixture({
      flowManager: fm,
      taskDocuments: [taskDocument("T-1"), taskDocument("T-2")],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    const out = execFileSync("node", [path.join(process.cwd(), "src/sennel.js"), "flow", "get", "next-action"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    const envelope = JSON.parse(out);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.taskId, "T-1");
    assert.equal(envelope.data.step, "task-impl");
  });
});
