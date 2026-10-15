import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTmpDir, removeTmpDir, writeJson, writeFile } from "../support/builders/tmp-dir.js";
import { initGitRepo, commitAll, checkoutNewBranch } from "../support/infrastructure/git-repo.js";
import { CanonicalFlowFixture, TaskLifecycleFixture, makeFlowManager } from "../support/infrastructure/flow-setup.js";

const CMD = path.join(process.cwd(), "src/sennel.js");
const SPEC_ID = "001-forest-e2e";

function taskDocument(id, parent = null) {
  return { id, title: `${id} task`, goal: `Complete ${id}.`, parent, origin: "plan", added_round: 0, status: "pending" };
}

function run(tmp, args) {
  return spawnSync("node", [CMD, ...args], {
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
  });
}

async function setupForestFixture(tmp, { taskId = null, targetStep = null, taskDocuments = [taskDocument("T-1"), taskDocument("T-2")] } = {}) {
  writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "base", docs: { languages: ["ja"], defaultLanguage: "ja" } });
  writeJson(tmp, "package.json", { name: "fixture", version: "0.0.0" });
  initGitRepo(tmp);
  commitAll(tmp, "initial");
  checkoutNewBranch(tmp, `feature/${SPEC_ID}`);
  const fm = makeFlowManager(tmp);
  const fixture = taskId === null
    ? new CanonicalFlowFixture({
      flowManager: fm,
      specId: SPEC_ID,
      runId: `run-${SPEC_ID}`,
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      specRecord: { requirements: [{ id: "R1", desc: "task 1 passes", priority: "must", task_ids: ["T-1"] }, { id: "R2", desc: "task 2 passes", priority: "must", task_ids: ["T-2"] }] },
    }).create().addTasks(taskDocuments).registerActive()
    : await new TaskLifecycleFixture({
      flowManager: fm,
      specId: SPEC_ID,
      runId: `run-${SPEC_ID}`,
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      taskDocuments,
      taskId,
      targetStep,
    }).createWithProducers({ sourceMutations: new Map([[`${taskId}-impl`, () => {
      writeFile(tmp, "src/task.js", "export const implemented = true;\n");
    }]]) });
  return { fm, fixture };
}

describe("REQ-C1: E2E forest lifecycle via CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("canonical Spec Task admission records each Spec Task document", async () => {
    tmp = createTmpDir();
    const { fixture } = await setupForestFixture(tmp);
    const state = fixture.state();
    assert.deepEqual(state.tasks.map((task) => task.id), ["T-1", "T-2"]);
    assert.deepEqual(
      fixture.state().tasks.map(({ id, title, goal, parent }) => ({ id, title, goal, parent })),
      [
        { id: "T-1", title: "T-1 task", goal: "Complete T-1.", parent: null },
        { id: "T-2", title: "T-2 task", goal: "Complete T-2.", parent: null },
      ],
    );
  });

  it("flow get next-action selects the active canonical Task leaf", async () => {
    tmp = createTmpDir();
    await setupForestFixture(tmp, { taskId: "T-1", targetStep: "task-impl" });
    const res = run(tmp, ["flow", "get", "next-action"]);
    assert.equal(res.status, 0, `next-action failed: ${res.stderr}`);
    const env = JSON.parse(res.stdout);
    assert.equal(env.data.taskId, "T-1");
    assert.equal(env.data.step, "task-impl");
  });

  it("complete-task leaves the next forest leaf pending for explicit selection", async () => {
    tmp = createTmpDir();
    const { fm, fixture } = await setupForestFixture(tmp, { taskId: "T-1", targetStep: "task-gate" });
    await fixture.flow.flow.produce("T-1-gate");
    const res = run(tmp, ["flow", "run", "complete-task", "--task-id", "T-1"]);
    assert.equal(res.status, 0, `complete-task failed: ${res.stderr}`);
    const state = fm.loadReadOnly();
    assert.equal(state.tasks.find((task) => task.id === "T-1").status, "done");
    assert.equal(state.tasks.find((task) => task.id === "T-2").status, "pending");
    assert.equal(state.currentTaskId, null);
    const taskPaths = fixture.location().taskArtifactLocation("T-1");
    assert.equal(taskPaths.implDirectory, path.join(fixture.location().directory, "steps", "impl", "T-1", "impl"));
    assert.equal(taskPaths.reviewDirectory, path.join(fixture.location().directory, "steps", "impl", "T-1", "review"));
    assert.equal(taskPaths.gateDirectory, path.join(fixture.location().directory, "steps", "impl", "T-1", "gate"));
  });
});
