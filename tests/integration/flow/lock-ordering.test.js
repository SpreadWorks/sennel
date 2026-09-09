import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ProcessLock } from "../../../src/lib/process-lock.js";
import { FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../../src/lib/worktree-flow-binding.js";
import { IssueLogStore } from "../../../src/flow/lib/issue-log-store.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class LockOrderObservation {
  constructor(t) {
    this.stack = [];
    this.paths = [];
    const observation = this;
    const acquire = ProcessLock.prototype.acquire;
    const release = ProcessLock.prototype.release;
    t.after(() => {
      ProcessLock.prototype.acquire = acquire;
      ProcessLock.prototype.release = release;
    });
    ProcessLock.prototype.acquire = function () {
      const token = acquire.call(this);
      observation.stack.push(this.kind);
      observation.paths.push([...observation.stack]);
      return token;
    };
    ProcessLock.prototype.release = function () {
      release.call(this);
      assert.equal(observation.stack.pop(), this.kind, "nested locks release in reverse acquisition order");
    };
  }

  assertOrder(expected) {
    assert.deepEqual(this.stack, [], "every acquired lock is released");
    assert.ok(this.paths.some((entry) => JSON.stringify(entry) === JSON.stringify(expected)), "the real transaction acquires the complete required chain");
    for (const held of this.paths) {
      const positions = held.map((kind) => expected.indexOf(kind));
      assert.ok(positions.every((rank) => rank >= 0), `unexpected lock in transaction: ${held}`);
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `reverse acquisition: ${held}`);
    }
  }
}

function fixtureFor(t, execution = { mode: "direct" }) {
  const root = createTmpDir("lock-ordering-");
  t.after(() => removeTmpDir(root));
  const manager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({ flowManager: manager, execution }).create().activate("branch");
  return { root, manager, fixture };
}

test("issue-log publication keeps repository, writer, catalog and current-state lock order", (t) => {
  const { manager, fixture } = fixtureFor(t);
  const store = IssueLogStore.forVersion({ location: fixture.location() });
  const trace = new LockOrderObservation(t);
  assert.equal(store.append({ step: "gate", reason: "ordered publication" }, "ordered-event").appended.length, 1);
  trace.assertOrder(["repository-flow-operation", "issue-log-writer", "artifact-catalog-publication", "current-flow-state"]);
  assert.equal(manager.activityLedger(fixture.specId).at(-1).transition.operation, "publish_artifacts");
  assert.equal(store.read().document.entries[0].issueLogId, "ordered-event");
});

test("guarded worktree resolution keeps repository, binding, catalog and current-state lock order", (t) => {
  const { root, manager, fixture } = fixtureFor(t, { mode: "worktree", baseBranch: "main", featureBranch: "feature/lock-ordering" });
  const worktreePath = path.join(root, ".sennel", "worktree", "lock-ordering");
  fs.mkdirSync(worktreePath, { recursive: true });
  const identity = new WorktreeFlowIdentity({ runId: fixture.runId, issue: null, specId: fixture.specId, worktreePath });
  new WorktreeFlowBindingStore({ worktreePath }).save(identity);
  const worktreeManager = manager.forRoot(worktreePath, { specId: fixture.specId });
  const trace = new LockOrderObservation(t);
  const resolved = worktreeManager.resolveWorktreeBinding(new FlowTargetExpectation({ expectRunId: fixture.runId }));
  trace.assertOrder(["repository-flow-operation", "worktree-flow-binding", "artifact-catalog-publication", "current-flow-state"]);
  assert.deepEqual(resolved.toJSON(), identity.toJSON());
});
