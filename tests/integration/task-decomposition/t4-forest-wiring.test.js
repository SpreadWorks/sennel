/**
 * tests/integration/task-decomposition/t4-forest-wiring.test.js
 *
 * Spec 226 / T-4: forest 構造の運用配線。
 * sync-spec-tasks の parent 転写、get-next-action の forest traversal
 * (DFS pre-order, 配列順)、completeTask の親子 propagation を検証する。
 *
 * REQ-6 / REQ-9 に対応。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  findNextPendingTask,
  promoteNextPending,
} from "../../../src/lib/flow-helpers.js";
import { checkSpecJson } from "../../../src/flow/lib/run-gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseSpec(tasks) {
  return {
    goal: "test",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    background: "",
    requirements: [],
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    tasks,
  };
}

/** Shorthand for a minimal task entry used in findNextPendingTask tests. */
function task(id, status = "pending", parent = null) {
  return { id, parent, status };
}

/** Build a Spec Task document for canonical Task admission. */
function taskDocument(id, parent = null, extras = {}) {
  return {
    id,
    title: `Task ${id}`,
    goal: `Complete ${id}.`,
    origin: "plan",
    parent,
    added_round: 0,
    status: "pending",
    ...extras,
  };
}

function mappedSpec(...taskIds) {
  return { requirements: [{ id: "R-forest", desc: "Exercise the canonical Task forest.", task_ids: taskIds }] };
}

describe("T-4: forest wiring (sync parent transcription + traversal + propagation)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  // ── sync-spec-tasks: parent transcription ──────────────────────────────────

  it("canonical Task admission persists the Spec Task parent", () => {
    tmp = createTmpDir();
    const fixture = new CanonicalFlowFixture({ flowManager: makeFlowManager(tmp), specId: "226-forest", specRecord: mappedSpec("T-root", "T-child") })
      .create()
      .addTasks([taskDocument("T-root"), taskDocument("T-child", "T-root")])
      .registerActive();
    const flow = fixture.state();
    const tRoot = flow.tasks.find((t) => t.id === "T-root");
    const tChild = flow.tasks.find((t) => t.id === "T-child");
    assert.equal(tRoot.parent, null);
    assert.equal(tChild.parent, "T-root");
  });

  it("canonical admission preserves flat (parent=null) Tasks", () => {
    tmp = createTmpDir();
    const fixture = new CanonicalFlowFixture({ flowManager: makeFlowManager(tmp), specId: "226-flat", specRecord: mappedSpec("T-a", "T-b") })
      .create()
      .addTasks([taskDocument("T-a"), taskDocument("T-b")])
      .registerActive();
    const flow = fixture.state();
    const tA = flow.tasks.find((t) => t.id === "T-a");
    const tB = flow.tasks.find((t) => t.id === "T-b");
    assert.equal(tA.parent, null);
    assert.equal(tB.parent, null);
  });

  // ── forest traversal: findNextPendingTask ──────────────────────────────────

  it("forest traversal is DFS pre-order", () => {
    // Tree:  R1 -> C1 -> GC1
    //           -> C2
    //        R2
    // DFS pre-order visits: R1, C1, GC1, C2, R2
    // GC1 is the deepest leaf and first pending leaf in DFS order.
    const tasks = [
      task("R1", "pending", null),
      task("C1", "pending", "R1"),
      task("GC1", "pending", "C1"),
      task("C2", "pending", "R1"),
      task("R2", "pending", null),
    ];
    const result = findNextPendingTask(tasks);
    assert.equal(result.id, "GC1");
  });

  it("forest traversal respects spec.json.tasks[] array order for siblings", () => {
    // Two roots, both pending with no children. Array order determines priority.
    const tasks = [
      task("first", "pending", null),
      task("second", "pending", null),
    ];
    const result = findNextPendingTask(tasks);
    assert.equal(result.id, "first");

    // Swap order: "second" comes first in array.
    const swapped = [
      task("second", "pending", null),
      task("first", "pending", null),
    ];
    const result2 = findNextPendingTask(swapped);
    assert.equal(result2.id, "second");
  });

  it("forest traversal prioritizes leaf (no children or all children done)", () => {
    // P has two children: C1 (done) and C2 (pending).
    // P itself is pending but C2 is not done, so P cannot be selected.
    // C2 is a leaf and pending => selected.
    const tasks = [
      task("P", "pending", null),
      task("C1", "done", "P"),
      task("C2", "pending", "P"),
    ];
    const result = findNextPendingTask(tasks);
    assert.equal(result.id, "C2");
  });

  it("forest traversal returns same result for same input (deterministic)", () => {
    const tasks = [
      task("R", "pending", null),
      task("A", "pending", "R"),
      task("B", "pending", "R"),
    ];
    const r1 = findNextPendingTask(tasks);
    const r2 = findNextPendingTask(tasks);
    const r3 = findNextPendingTask(tasks);
    assert.equal(r1.id, r2.id);
    assert.equal(r2.id, r3.id);
  });

  it("forest traversal handles 3+ level depth", () => {
    // L0 -> L1 -> L2 -> L3 (4 levels, 0-indexed depth 3)
    const tasks = [
      task("L0", "pending", null),
      task("L1", "pending", "L0"),
      task("L2", "pending", "L1"),
      task("L3", "pending", "L2"),
    ];
    const result = findNextPendingTask(tasks);
    // Deepest leaf in DFS
    assert.equal(result.id, "L3");

    // After L3 is done, L2 becomes the next leaf (all children done).
    tasks.find((t) => t.id === "L3").status = "done";
    const r2 = findNextPendingTask(tasks);
    assert.equal(r2.id, "L2");

    // After L2 is done, L1 becomes the next leaf.
    tasks.find((t) => t.id === "L2").status = "done";
    const r3 = findNextPendingTask(tasks);
    assert.equal(r3.id, "L1");
  });

  it("forest traversal handles independent root Tasks", () => {
    // All Tasks are roots.
    const tasks = [
      task("A", "pending", null),
      task("B", "pending", null),
      task("C", "pending", null),
    ];
    const result = findNextPendingTask(tasks);
    assert.equal(result.id, "A");

    // If first is done, selects second.
    tasks[0].status = "done";
    const r2 = findNextPendingTask(tasks);
    assert.equal(r2.id, "B");

    // All done => null.
    tasks[1].status = "done";
    tasks[2].status = "done";
    assert.equal(findNextPendingTask(tasks), null);
  });

  // ── completeTask: parent propagation ───────────────────────────────────────

  it("completeTask propagates to parent when all children are done", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-propagation", specRecord: mappedSpec("P", "C1", "C2") })
      .create().addTasks([taskDocument("P"), taskDocument("C1", "P"), taskDocument("C2", "P")]).registerActive();
    fixture.activateTask("C1");
    for (const step of ["C1-impl", "C1-review", "C1-triage", "C1-repair", "C1-gate"]) fixture.settle(step);
    fm.completeTask("C1", { specId: "226-propagation" });
    fixture.activateTask("C2", { settlePredecessors: false });
    for (const step of ["C2-impl", "C2-review", "C2-triage", "C2-repair", "C2-gate"]) fixture.settle(step);
    fm.completeTask("C2");

    const state = fm.load("226-propagation");
    const parent = state.tasks.find((t) => t.id === "P");
    assert.equal(parent.status, "done", "parent should be auto-completed");
  });

  it("completeTask propagation is recursive up to root", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-recursive", specRecord: mappedSpec("Root", "Mid", "Leaf") })
      .create().addTasks([taskDocument("Root"), taskDocument("Mid", "Root"), taskDocument("Leaf", "Mid")]).registerActive();
    fixture.activateTask("Leaf");
    for (const step of ["Leaf-impl", "Leaf-review", "Leaf-triage", "Leaf-repair", "Leaf-gate"]) fixture.settle(step);
    fm.completeTask("Leaf");

    const state = fm.load("226-recursive");
    assert.equal(state.tasks.find((t) => t.id === "Leaf").status, "done");
    assert.equal(state.tasks.find((t) => t.id === "Mid").status, "done");
    assert.equal(state.tasks.find((t) => t.id === "Root").status, "done");
  });

  it("completeTask does NOT auto-promote (responsibility separation)", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-no-promote", specRecord: mappedSpec("T-1", "T-2") })
      .create().addTasks([taskDocument("T-1"), taskDocument("T-2")]).registerActive();
    fixture.activateTask("T-1");
    for (const step of ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"]) fixture.settle(step);
    fm.completeTask("T-1");

    const state = fm.load("226-no-promote");
    // currentTaskId should be null — completeTask clears it but does NOT
    // promote the next pending task.
    assert.equal(state.currentTaskId, null);
    assert.equal(state.tasks.find((t) => t.id === "T-2").status, "pending");
  });

  it("completeTask handles flat tasks (parent=null) without propagation", () => {
    tmp = createTmpDir();
    const fm = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({ flowManager: fm, specId: "226-flat-complete", specRecord: mappedSpec("A", "B", "C") })
      .create().addTasks([taskDocument("A"), taskDocument("B"), taskDocument("C")]).registerActive();
    fixture.activateTask("A");
    for (const step of ["A-impl", "A-review", "A-triage", "A-repair", "A-gate"]) fixture.settle(step);
    fm.completeTask("A");
    fixture.activateTask("B", { settlePredecessors: false });
    for (const step of ["B-impl", "B-review", "B-triage", "B-repair", "B-gate"]) fixture.settle(step);
    fm.completeTask("B");

    const state = fm.load("226-flat-complete");
    assert.equal(state.tasks.find((t) => t.id === "B").status, "done");
    // No propagation expected — parent is null for all tasks.
    assert.equal(state.tasks.find((t) => t.id === "A").status, "done");
    assert.equal(state.tasks.find((t) => t.id === "C").status, "pending");
    assert.equal(state.currentTaskId, null);
  });

  // ── forest depth boundary ──────────────────────────────────────────────────

  it("forest depth 10 boundary is enforced (depth 11+ fails spec gate)", () => {
    // Build a chain of 11 levels (depth=11 from leaf to root).
    // depth is measured as the longest parent-chain length.
    // 12 tasks forming a chain: T-0 -> T-1 -> ... -> T-11
    // Depth of T-11 = 11 hops up to T-0 => exceeds the max of 10.
    const deepTasks = [];
    for (let i = 0; i <= 11; i++) {
      deepTasks.push({
        id: `T-${i}`,
        title: `Task ${i}`,
        goal: `goal-${i}`,
        origin: "plan",
        added_round: 0,
        status: "pending",
        parent: i === 0 ? null : `T-${i - 1}`,
      });
    }
    const spec = baseSpec(deepTasks);
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => /forest depth/.test(i) && /exceeds/.test(i)),
      `expected depth violation issue, got: ${JSON.stringify(issues)}`,
    );

    // Depth 10 (11 tasks, 0..10) should pass.
    const okTasks = [];
    for (let i = 0; i <= 10; i++) {
      okTasks.push({
        id: `T-${i}`,
        title: `Task ${i}`,
        goal: `goal-${i}`,
        origin: "plan",
        added_round: 0,
        status: "pending",
        parent: i === 0 ? null : `T-${i - 1}`,
      });
    }
    const okSpec = baseSpec(okTasks);
    const okIssues = checkSpecJson(okSpec);
    const depthIssues = okIssues.filter((i) => /forest depth/.test(i));
    assert.equal(depthIssues.length, 0, `depth 10 should pass, got: ${JSON.stringify(depthIssues)}`);
  });
});
