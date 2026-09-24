import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { CanonicalSpecTaskSynchronizer, syncSpecTasksToFlow } from "../../../src/flow/lib/sync-spec-tasks.js";
import { TaskCollection } from "../../../src/spec/lib/render-contract.js";

function taskDocument(id, addedRound = 0) {
  return { id, title: `Task ${id}`, goal: `Complete ${id}.`, parent: null, origin: "plan", added_round: addedRound, status: "pending" };
}

describe("approval Task admission (REQ-2, REQ-6)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("adds each approved Spec Task through the canonical Task API", () => {
    tmp = createTmpDir();
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specId: "215-flow-task-decomposition",
      specRecord: { requirements: [{ id: "R-tasks", desc: "Admit every approved Task.", task_ids: ["T-seed", "T-1", "T-2"] }] },
    })
      .create().addTask(taskDocument("T-seed")).registerActive();
    fixture.addTask(taskDocument("T-1")).addTask(taskDocument("T-2"));
    assert.deepEqual(fixture.state().tasks.map((task) => task.id), ["T-seed", "T-1", "T-2"]);
  });

  it("preserves an existing admitted Task while admitting a later Task", () => {
    tmp = createTmpDir();
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specId: "215-flow-task-decomposition",
      specRecord: { requirements: [{ id: "R-tasks", desc: "Admit every approved Task.", task_ids: ["T-1", "T-2"] }] },
    })
      .create().addTask(taskDocument("T-1")).registerActive();
    fixture.addTask(taskDocument("T-2", 1));
    const state = fixture.state();
    assert.deepEqual(state.tasks.map((task) => [task.id, task.added_round]), [["T-1", 0], ["T-2", 1]]);
  });

  it("retains the Task document added_round authority", () => {
    tmp = createTmpDir();
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specId: "215-flow-task-decomposition",
      specRecord: { requirements: [{ id: "R-tasks", desc: "Retain every Task round.", task_ids: ["T-1", "T-2"] }] },
    })
      .create().addTask(taskDocument("T-1")).addTask(taskDocument("T-2", 1)).registerActive();
    assert.equal(fixture.state().tasks.find((task) => task.id === "T-2").added_round, 1);
  });

  it("adopts cataloged Spec Tasks append-only and is idempotent", () => {
    const state = { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, specId: "215-flow-task-decomposition", currentNodeId: "approval", tasks: [taskDocument("T-1")] };
    const added = [];
    const flowManager = {
      readArtifact: () => ({ bytes: Buffer.from(JSON.stringify({ tasks: [taskDocument("T-1"), taskDocument("T-2", 1)] })) }),
      addTask: (task) => added.push(task),
    };
    const sync = new CanonicalSpecTaskSynchronizer({ flowManager, state });
    assert.deepEqual(sync.pending().map((task) => [task.id, task.added_round]), [["T-2", 1]]);
    assert.deepEqual(sync.admit().added, ["T-2"]);
    assert.deepEqual(added.map((task) => task.id), ["T-2"]);
  });

  it("orders approval admission by parent even when the Spec proposal is child-first", () => {
    const tasks = new TaskCollection([
      { ...taskDocument("T-child"), parent: "T-parent" },
      { ...taskDocument("T-parent"), parent: null },
    ]);
    assert.deepEqual(tasks.admissionOrder().map((task) => task.id.value), ["T-parent", "T-child"]);
  });

  it("rejects cyclic Task proposals before approval admission", () => {
    const tasks = new TaskCollection([
      { ...taskDocument("T-a"), parent: "T-b" },
      { ...taskDocument("T-b"), parent: "T-a" },
    ]);
    assert.throws(() => tasks.admissionOrder(), /cycle/);
  });

  it("reports skipped when no active flow exists", async () => {
    tmp = createTmpDir();
    assert.deepEqual(syncSpecTasksToFlow({ root: tmp }), { added: [], skipped: true, reason: "no active flow" });
  });
});
