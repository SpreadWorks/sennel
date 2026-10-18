import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FreshFlowFixture,
  TaskLifecycleFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

function taskDocument(overrides = {}) {
  return {
    id: "001",
    title: "Fixture task",
    goal: "Exercise the canonical Task API.",
    origin: "plan",
    parent: null,
    status: "pending",
    added_round: 0,
    ...overrides,
  };
}

function freshFlow(tmp) {
  const fm = makeFlowManager(tmp);
  const fixture = new FreshFlowFixture({
    flowManager: fm,
    specId: "001-test",
    runId: "run-test",
    execution: { mode: "direct" },
    specRecord: { requirements: [{ id: "R-001", desc: "Exercise the canonical Task API.", task_ids: ["001"] }] },
  }).create().registerActive();
  return { fixture, fm };
}

function activeTask(tmp, { taskId = "001", taskDocuments = [taskDocument({ id: taskId })] } = {}) {
  initGitRepo(tmp);
  commitAll(tmp, "Task API fixture baseline");
  const fixture = new TaskLifecycleFixture({
    flowManager: makeFlowManager(tmp),
    specId: "001-test",
    runId: "run-test",
    execution: { mode: "direct" },
    taskDocuments,
    taskId,
  }).create();
  return { fixture, fm: makeFlowManager(tmp) };
}

async function settleTask(fixture, taskId) {
  await fixture.flow.flow.activateWithProducers(`${taskId}-review`);
  await fixture.flow.flow.produce(`${taskId}-review`);
}

function confirmTaskWithoutMutation(fm, taskId) {
  const snapshot = () => JSON.stringify({
    state: fm.canonicalState("001-test").toJSON(),
    activities: fm.activityLedger("001-test"),
    catalog: fm.artifactCatalog("001-test").toJSON(),
  });
  const before = snapshot();
  const result = fm.completeTask(taskId);
  assert.equal(result.tasks.find((task) => task.id === taskId).status, "done");
  assert.equal(snapshot(), before, "completion confirmation must not create a second transition or publication");
  return result;
}

describe("FlowManager canonical Task API", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("adds a typed Task document without inventing a current Task", () => {
    tmp = createTmpDir();
    const { fm } = freshFlow(tmp);
    fm.addTask(taskDocument());
    const state = fm.load("001-test");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, "001");
    assert.equal(state.currentTaskId, null);
  });

  it("rejects duplicate Task identity", () => {
    tmp = createTmpDir();
    const { fm } = freshFlow(tmp);
    fm.addTask(taskDocument());
    assert.throws(() => fm.addTask(taskDocument()), /duplicate|exist/i);
  });

  it("rejects a runtime Task-step blob at the fixture boundary", () => {
    tmp = createTmpDir();
    const { fixture } = freshFlow(tmp);
    assert.throws(
      () => fixture.addTask({ ...taskDocument(), steps: [] }),
      /Spec Task document, not runtime Task steps/,
    );
  });

  it("derives current Task and current Task Step from a typed Task-start transition", () => {
    tmp = createTmpDir();
    const { fm } = activeTask(tmp);
    assert.equal(fm.getCurrentTask().id, "001");
    assert.deepEqual(
      { id: fm.getCurrentTaskStep().id, status: fm.getCurrentTaskStep().status },
      { id: "001-impl", status: "in_progress" },
    );
  });

  it("rejects direct current-Task-step mutation while a typed Attempt is authoritative", () => {
    tmp = createTmpDir();
    const { fm } = activeTask(tmp);
    assert.throws(
      () => fm.updateStepStatus({ stepId: "001-review", requestedStatus: "in_progress" }),
      /canonical|current|transition/i,
    );
    assert.equal(fm.getCurrentTaskStep().id, "001-impl");
  });

  it("does not complete a Task before every canonical child Step is terminal", () => {
    tmp = createTmpDir();
    const { fm } = activeTask(tmp);
    assert.throws(() => fm.completeTask("001"), /cannot complete before all child Steps are done/);
  });

  it("confirms a Task completed by the registered no-change Review without another transition", async () => {
    tmp = createTmpDir();
    const { fixture, fm } = activeTask(tmp);
    await settleTask(fixture, "001");
    confirmTaskWithoutMutation(fm, "001");
    const state = fm.load("001-test");
    assert.equal(state.tasks[0].status, "done");
    assert.equal(state.currentTaskId, null);
  });

  it("keeps another active Task selected when confirming an earlier terminal Task", async () => {
    tmp = createTmpDir();
    const { fixture, fm } = activeTask(tmp, {
      taskDocuments: [taskDocument({ id: "001" }), taskDocument({ id: "002" })],
    });
    await settleTask(fixture, "001");
    fixture.flow.flow.activateTask("002", { settlePredecessors: false });
    const confirmed = confirmTaskWithoutMutation(fm, "001");
    assert.equal(confirmed.currentTaskId, "002");
    assert.equal(fm.load("001-test").currentTaskId, "002");
    assert.equal(fm.load("001-test").tasks.find((task) => task.id === "001").status, "done");
  });

  it("writes notes with the current Task identity only when one is actively selected", () => {
    tmp = createTmpDir();
    const { fm } = activeTask(tmp);
    fm.addNote("task-note");
    const state = fm.load("001-test");
    assert.equal(state.notes[0].taskId, "001");
    assert.equal(state.notes[0].text, "task-note");
  });

  it("honors explicit parent and Task note scopes", () => {
    tmp = createTmpDir();
    const { fm } = activeTask(tmp, {
      taskDocuments: [taskDocument({ id: "001" }), taskDocument({ id: "002" })],
    });
    fm.addNote("parent", { taskId: null });
    fm.addNote("other", { taskId: "002" });
    const notes = fm.load("001-test").notes;
    assert.deepEqual(notes.map(({ taskId, text }) => ({ taskId, text })), [
      { taskId: null, text: "parent" },
      { taskId: "002", text: "other" },
    ]);
    assert.throws(() => fm.addNote("missing", { taskId: "999" }), /unknown|absent|not found/i);
  });

  it("does not expose generic state replacement for legacy task blobs", () => {
    tmp = createTmpDir();
    const { fm } = freshFlow(tmp);
    assert.equal(typeof fm.mutate, "undefined");
    assert.equal(fm.load("001-test").tasks.length, 0);
  });
});
