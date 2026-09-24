import { CURRENT_FLOW_SCHEMA_REVISION } from "../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ActiveUpgradeFlowCollection,
  activeUpgradeRootMatches,
  resolveActiveUpgradeFlows,
  writeActiveUpgradeArtifact,
} from "../../src/upgrade.js";
import { container } from "../../src/lib/container.js";

function gitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-upgrade-active-flows-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Sennel Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

function activeState({ specId, runId, mode = "direct", baseBranch = "main", worktreePath = null }) {
  return {
    schemaRevision: CURRENT_FLOW_SCHEMA_REVISION,
    specId,
    runId,
    baseBranch,
    execution: { mode },
    ...(worktreePath === null ? {} : { worktree: { path: worktreePath } }),
  };
}

describe("upgrade dry-run evidence", () => {
  it("does not stage or publish an active Flow upgrade artifact", () => {
    const published = [];
    assert.doesNotThrow(() => writeActiveUpgradeArtifact({
      root: "/path/that-must-not-be-read-for-dry-run-evidence",
      activeFlows: ActiveUpgradeFlowCollection.empty(),
      workerHandoffRequest: "/path/that-must-not-be-staged",
      command: "sennel upgrade --dry-run",
      dryRun: true,
      exitCode: 0,
      result: "success-no-change",
      summary: {},
    }));
    assert.deepEqual(published, []);
  });

  it("does not attach a main-root upgrade to a worktree Flow evidence record", () => {
    const mainRoot = gitRepository();
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-upgrade-worktree-"));
    const worktreeAlias = `${worktreeRoot}-alias`;
    const flowManager = {
      resolveWorktreePaths() { return { worktreePath: worktreeRoot }; },
    };
    const state = { execution: { mode: "worktree" } };
    try {
      fs.symlinkSync(worktreeRoot, worktreeAlias, "dir");
      assert.equal(activeUpgradeRootMatches({
        root: mainRoot,
        state,
        flowManager,
        mainRoot,
      }), false);
      assert.equal(activeUpgradeRootMatches({
        root: worktreeAlias,
        state,
        flowManager,
        mainRoot,
      }), true);
    } finally {
      fs.rmSync(mainRoot, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
      fs.rmSync(worktreeAlias, { recursive: true, force: true });
    }
  });

  it("coordinates one main-checkout upgrade with every matching direct Flow", () => {
    const root = gitRepository();
    const published = [];
    const states = new Map([
      ["001-first", activeState({ specId: "001-first", runId: "run-first" })],
      ["002-second", activeState({ specId: "002-second", runId: "run-second" })],
    ]);
    const managers = new Map([...states].map(([specId, state]) => [specId, {
      load(targetSpecId) {
        assert.equal(targetSpecId, specId);
        return state;
      },
      publishUpgradeResult(value) { published.push(value); },
      assertFlowStateWritable(targetSpecId) { assert.equal(targetSpecId, specId); },
      resolveWorktreePaths() { throw new Error("direct Flow must not resolve a worktree"); },
    }]));
    try {
      container.reset();
      container.register("mainRoot", root);
      container.register("flowManager", {
        load() { throw new Error("the execution-bound manager must not load active states"); },
        loadActiveFlows() {
          return [{ specId: "001-first", mode: "direct" }, { specId: "002-second", mode: "direct" }];
        },
        forRoot(targetRoot, { specId }) {
          assert.equal(targetRoot, root);
          return managers.get(specId);
        },
      });
      const activeFlows = resolveActiveUpgradeFlows(root);
      assert.equal(activeFlows.flows.length, 2);
      writeActiveUpgradeArtifact({
        root,
        activeFlows,
        command: "sennel upgrade",
        dryRun: false,
        exitCode: 0,
        result: "success-no-change",
        summary: {},
      });
      assert.deepEqual(published.map((entry) => entry.specId).sort(), ["001-first", "002-second"]);
    } finally {
      container.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preflights every matching Flow before publishing any upgrade evidence", () => {
    const root = gitRepository();
    const published = [];
    const states = new Map([
      ["001-writable", activeState({ specId: "001-writable", runId: "run-writable" })],
      ["002-blocked", activeState({ specId: "002-blocked", runId: "run-blocked" })],
    ]);
    const managers = new Map([...states].map(([specId, state]) => [specId, {
      load(targetSpecId) { assert.equal(targetSpecId, specId); return state; },
      assertFlowStateWritable() {
        if (specId === "002-blocked") throw new Error("Flow is not writable");
      },
      publishUpgradeResult(value) { published.push(value); },
      resolveWorktreePaths() { throw new Error("direct Flow must not resolve a worktree"); },
    }]));
    try {
      container.reset();
      container.register("mainRoot", root);
      container.register("flowManager", {
        loadActiveFlows() {
          return [{ specId: "001-writable", mode: "direct" }, { specId: "002-blocked", mode: "direct" }];
        },
        forRoot(targetRoot, { specId }) {
          assert.equal(targetRoot, root);
          return managers.get(specId);
        },
      });
      assert.throws(
        () => writeActiveUpgradeArtifact({
          root,
          activeFlows: resolveActiveUpgradeFlows(root),
          command: "sennel upgrade",
          dryRun: false,
          exitCode: 0,
          result: "success-no-change",
          summary: {},
        }),
        /Flow is not writable/,
      );
      assert.deepEqual(published, []);
    } finally {
      container.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses canonical managers for every active Flow when invoked inside one worktree", () => {
    const mainRoot = gitRepository();
    const selfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-upgrade-self-worktree-"));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-upgrade-other-worktree-"));
    const states = new Map([
      ["001-self", activeState({ specId: "001-self", runId: "run-self", mode: "worktree", worktreePath: selfRoot })],
      ["002-other", activeState({ specId: "002-other", runId: "run-other", mode: "worktree", worktreePath: otherRoot })],
    ]);
    const managers = new Map([...states].map(([specId, state]) => [specId, {
      load(targetSpecId) { assert.equal(targetSpecId, specId); return state; },
      resolveWorktreePaths() { return { worktreePath: state.worktree.path }; },
    }]));
    try {
      container.reset();
      container.register("mainRoot", mainRoot);
      container.register("flowManager", {
        load() { throw new Error("the worktree-bound manager must not load another active Flow"); },
        loadActiveFlows() {
          return [{ specId: "001-self", mode: "worktree" }, { specId: "002-other", mode: "worktree" }];
        },
        forRoot(targetRoot, { specId }) {
          assert.equal(targetRoot, mainRoot);
          return managers.get(specId);
        },
      });
      const activeFlows = resolveActiveUpgradeFlows(selfRoot);
      assert.deepEqual(activeFlows.flows.map((flow) => flow.state.specId), ["001-self"]);
    } finally {
      container.reset();
      fs.rmSync(mainRoot, { recursive: true, force: true });
      fs.rmSync(selfRoot, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("does not bypass coordination when a registered active Flow cannot be resolved", () => {
    const root = gitRepository();
    try {
      container.reset();
      container.register("mainRoot", root);
      container.register("flowManager", {
        loadActiveFlows() { return [{ specId: "001-corrupt", mode: "direct" }]; },
        forRoot() {
          return {
            load() { throw new Error("canonical active Flow state is corrupt"); },
          };
        },
      });
      assert.throws(
        () => resolveActiveUpgradeFlows(root),
        /canonical active Flow state is corrupt/,
      );
    } finally {
      container.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
