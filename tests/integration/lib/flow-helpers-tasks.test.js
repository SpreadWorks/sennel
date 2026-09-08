import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSteps,
  buildInitialTaskSteps,
  derivePhase,
  TASK_STEPS_PLAN,
} from "../../../src/lib/flow-helpers.js";
import { findStepById, flattenSteps } from "../../../src/flow/lib/step-tree.js";

describe("flow-helpers task-aware APIs", () => {
  describe("buildInitialTaskSteps", () => {
    it("returns TASK_STEPS_PLAN sequence for origin=plan", () => {
      const steps = buildInitialTaskSteps("plan");
      assert.equal(steps.length, TASK_STEPS_PLAN.length);
      assert.deepEqual(steps.map((s) => s.id), TASK_STEPS_PLAN);
      for (const s of steps) assert.equal(s.status, "pending");
    });

    it("returns TASK_STEPS_PLAN sequence for origin=integration", () => {
      const steps = buildInitialTaskSteps("integration");
      assert.equal(steps.length, TASK_STEPS_PLAN.length);
      assert.deepEqual(steps.map((s) => s.id), TASK_STEPS_PLAN);
    });

    it("throws on unknown origin", () => {
      assert.throws(() => buildInitialTaskSteps("nonsense"), /origin|unknown/i);
    });

    it("throws on legacy origin=addition (removed in spec 215)", () => {
      assert.throws(() => buildInitialTaskSteps("addition"), /origin|unknown/i);
    });

    it("TASK_STEPS_PLAN is defined by the canonical Task lifecycle", () => {
      assert.ok(Array.isArray(TASK_STEPS_PLAN));
      assert.deepEqual(TASK_STEPS_PLAN, [
        "task-impl", "task-review", "task-triage", "task-repair", "task-gate",
      ]);
      // Removed in spec 226: approval, gate (task-spec), update-overview
      assert.ok(!TASK_STEPS_PLAN.includes("approval"));
      assert.ok(!TASK_STEPS_PLAN.includes("gate"));
      assert.ok(!TASK_STEPS_PLAN.includes("update-overview"));
      // Removed in spec 235: write-tests, run-tests
      assert.ok(!TASK_STEPS_PLAN.includes("write-tests"));
      assert.ok(!TASK_STEPS_PLAN.includes("run-tests"));
    });
  });

  describe("derivePhase(state)", () => {
    function makeState(overrides = {}) {
      return {
        spec: "specs/001-test/spec.md",
        steps: buildInitialSteps(),
        requirements: [],
        tasks: [],
        currentTaskId: null,
        ...overrides,
      };
    }

    it("returns 'plan' for fresh flow-level steps (no tasks)", () => {
      const state = makeState();
      assert.equal(derivePhase(state), "plan");
    });

    it("returns flow-level phase when flow step is in_progress and no current task", () => {
      const state = makeState();
      // Reset auto-promoted first leaf, then set implement to in_progress.
      for (const s of flattenSteps(state.steps)) s.status = "pending";
      findStepById(state.steps, "implement").status = "in_progress";
      assert.equal(derivePhase(state), "impl");
    });

    it("returns 'task-impl' when current task has impl in_progress", () => {
      const state = makeState({
        currentTaskId: "001",
        tasks: [
          {
            id: "001",
            spec: "specs/001-test/tasks/001-x.md",
            origin: "plan",
            parent: null,
            status: "in_progress",
            steps: buildInitialTaskSteps("plan"),
            requirements: [],
            summary: null,
          },
        ],
      });
      state.tasks[0].steps.find((s) => s.id === "task-impl").status = "in_progress";
      assert.equal(derivePhase(state), "task-impl");
    });

    it("returns 'task-impl' when current task has task-gate in_progress (spec 226: replaces task-plan gate step)", () => {
      const state = makeState({
        currentTaskId: "001",
        tasks: [
          {
            id: "001",
            spec: "specs/001-test/tasks/001-x.md",
            origin: "plan",
            parent: null,
            status: "in_progress",
            steps: buildInitialTaskSteps("plan"),
            requirements: [],
            summary: null,
          },
        ],
      });
      state.tasks[0].steps.find((s) => s.id === "task-gate").status = "in_progress";
      assert.equal(derivePhase(state), "task-impl");
    });

    it("falls back to flow-level phase when current task has no in_progress step", () => {
      const state = makeState({
        currentTaskId: "001",
        tasks: [
          {
            id: "001",
            spec: "specs/001-test/tasks/001-x.md",
            origin: "plan",
            parent: null,
            status: "pending",
            steps: buildInitialTaskSteps("plan"),
            requirements: [],
            summary: null,
          },
        ],
      });
      // Reset auto-promoted first leaf, then set spec to in_progress.
      for (const s of flattenSteps(state.steps)) s.status = "pending";
      findStepById(state.steps, "spec").status = "in_progress";
      assert.equal(derivePhase(state), "plan");
    });
  });
});
