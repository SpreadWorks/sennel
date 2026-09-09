import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { container } from "../../../src/lib/container.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalNextActionScenario, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

// Causal boundary: the external owner publishes a real lock, the reader's real
// identity assessment observes it live, then it releases between the next
// pathname stat and owner-file open. Hooks only schedule the external process;
// they do not substitute an ownership assessment or a filesystem result.
async function withContendingWriter(t, directory, operation) {
  const barrierRoot = createTmpDir("state-contention-barrier-");
  const releasePath = path.join(barrierRoot, "release");
  const releasedPath = path.join(barrierRoot, "released");
  const lockPath = path.join(directory, ".runtime", "locks", "current-flow-state.lock");
  const stateModule = new URL("../../../src/flow/lib/current-flow-state.js", import.meta.url).href;
  const definitionModule = new URL("../../../src/flow/definition.js", import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { CurrentFlowStateStore } from ${JSON.stringify(stateModule)};
    import { buildCurrentFlowDefinition } from ${JSON.stringify(definitionModule)};
    const store = new CurrentFlowStateStore({ directory: ${JSON.stringify(directory)}, definition: buildCurrentFlowDefinition() });
    store.lock.acquire();
    const watcher = fs.watch(${JSON.stringify(barrierRoot)}, () => {
      if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
      watcher.close();
      store.lock.release();
      fs.writeFileSync(${JSON.stringify(releasedPath)}, 'released\\n');
    });
    process.stdout.write('locked\\n');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    removeTmpDir(barrierRoot);
  });
  await Promise.race([
    once(child.stdout, "data"),
    closed.then(() => { throw new Error(`lock owner exited before acquisition: ${stderr}`); }),
  ]);
  const assess = ProcessIdentitySource.prototype.assess;
  const open = fs.openSync;
  let observedLive = false;
  let releasedDuringRead = false;
  ProcessIdentitySource.prototype.assess = function (identity) {
    const result = assess.call(this, identity);
    if (identity.pid === child.pid && result.status === "live" && !observedLive) {
      observedLive = true;
    }
    return result;
  };
  fs.openSync = (target, ...args) => {
    if (target === lockPath && observedLive && !releasedDuringRead) {
      releasedDuringRead = true;
      fs.writeFileSync(releasePath, "release\n");
      const deadline = performance.now() + 5_000;
      while (!fs.existsSync(releasedPath)) {
        if (performance.now() >= deadline) throw new Error("external current-state owner did not acknowledge release");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    }
    return open(target, ...args);
  };
  try {
    const result = await operation();
    assert.equal(observedLive, true, "the reader must encounter the external live writer");
    assert.equal(releasedDuringRead, true, "the writer must release during the subsequent owner-file read");
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    return result;
  } finally {
    ProcessIdentitySource.prototype.assess = assess;
    fs.openSync = open;
  }
}

function freshScenario(t) {
  const root = createTmpDir("state-contention-");
  t.after(() => removeTmpDir(root));
  const scenario = new CanonicalNextActionScenario({ flowManager: makeFlowManager(root) }).create();
  return { root, scenario, manager: scenario.flowManager, specId: scenario.specId };
}

function canonicalBytes(manager, specId) {
  const directory = manager.specLocation(specId).directory;
  return ["flow.json", "activities.jsonl", "artifact-catalog.json"].map((name) => fs.readFileSync(path.join(directory, name)));
}

test("canonical load waits for an external current-state writer without changing persisted authority", { timeout: 30000 }, async (t) => {
  const { root, manager, specId } = freshScenario(t);
  const expected = manager.canonicalState(specId).toJSON();
  const before = canonicalBytes(manager, specId);
  const state = await withContendingWriter(t, manager.specLocation(specId).directory, () => makeFlowManager(root).canonicalState(specId));
  assert.deepEqual(state.toJSON(), expected);
  assert.deepEqual(canonicalBytes(manager, specId), before);
});

test("get-next-action preserves its selected action after external current-state contention", { timeout: 30000 }, async (t) => {
  const { root, scenario, manager, specId } = freshScenario(t);
  scenario.atFlowStep("draft");
  const context = () => ({ root, mainRoot: root, executionRoot: root, specId, flowManager: makeFlowManager(root), flowState: manager.loadReadOnly(specId), config: {} });
  const command = new GetNextActionCommand();
  const expected = await command.execute(context());
  const ctx = context();
  const before = canonicalBytes(manager, specId);
  const result = await withContendingWriter(t, manager.specLocation(specId).directory, () => command.execute(ctx));
  assert.deepEqual(result, expected);
  assert.deepEqual(canonicalBytes(manager, specId), before);
});

test("sealed handoff recovery survives external current-state contention and settles once after restart", { timeout: 30000 }, async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const reviewed = await scenario.publishReview([{
    findingKey: "missing-behavior", title: "Required behavior is missing", failureMode: "spec_behavior_contradiction",
    file: "README.md", requirementId: "R-1", issue: "The implementation omits required behavior.",
    suggestion: "Implement the required behavior.", disposition: "must-fix", rationale: "The mapped requirement requires this behavior.",
  }]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  const work = scenario.stageHandoff("triage");
  scenario.sealHandoff(work, {
    version: 1, stepId: "task-triage", completionStatus: "done", issues: [], overview: null,
    triage: { version: 1, dispositions: [{ findingKey: "missing-behavior", disposition: "apply", basis: "repair-required", rationale: "The requirement confirms this missing behavior." }] },
    repair: null, noChangeReason: null,
  });
  scenario.reload();
  const ctx = scenario.context();
  const sourceBefore = fs.readFileSync(scenario.sourcePath);
  const recovery = new WorkerArtifactHandoffCoordinator();
  const result = await withContendingWriter(t, scenario.manager.specLocation(scenario.specId).directory, () => recovery.recoverPending({ ctx }));
  assert.equal(result.completed, true);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  const settled = scenario.snapshot();
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  scenario.reload();
  assert.equal(scenario.snapshot(), settled);
  assert.deepEqual(fs.readFileSync(scenario.sourcePath), sourceBefore);
});
