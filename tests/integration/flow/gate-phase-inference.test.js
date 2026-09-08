import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import {
  resolveGateStepId,
  resolveGatePhaseFromState,
  STEP_TO_PHASE,
} from "../../../src/flow/lib/gate-step.js";
import { VALID_GATE_PHASES } from "../../../src/lib/constants.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { DefinitionLifecycleTransition } from "../../../src/flow/lib/step-transition-policy.js";

// -----------------------------------------------------------------------------
// AC6 (R5): resolveGateStepId / STEP_TO_PHASE round-trip consistency
// -----------------------------------------------------------------------------

describe("gate-step.js: step <-> phase round-trip (AC6/R5)", () => {
  it("exports STEP_TO_PHASE mapping covering every VALID_GATE_PHASES value", () => {
    assert.ok(STEP_TO_PHASE && typeof STEP_TO_PHASE === "object");
    const phases = Object.values(STEP_TO_PHASE);
    for (const phase of phases) {
      assert.ok(
        VALID_GATE_PHASES.includes(phase),
        `STEP_TO_PHASE produced unknown phase: ${phase}`,
      );
    }
  });

  it("resolveGateStepId -> STEP_TO_PHASE round-trips for flow-level gate steps", () => {
    // For each known phase, compute the step id, then look up the phase back.
    // The forward function maps integration to impl-gate and task-impl to task-gate;
    // this round-trip only asserts the flow-level gate steps (spec-gate / draft-gate / impl-gate).
    for (const phase of VALID_GATE_PHASES) {
      const stepId = resolveGateStepId(phase);
      const back = STEP_TO_PHASE[stepId];
      // back must be a valid phase and stepId(back) must land on the same step.
      if (stepId === "spec-gate" || stepId === "draft-gate" || stepId === "impl-gate") {
        assert.ok(
          VALID_GATE_PHASES.includes(back),
          `inverse produced non-phase value for ${stepId}: ${back}`,
        );
        assert.equal(
          resolveGateStepId(back),
          stepId,
          `inverse is not consistent with forward for ${phase} -> ${stepId} -> ${back}`,
        );
      }
    }
  });
});

// -----------------------------------------------------------------------------
// AC1 (R1): single in_progress at flow level resolves to expected phase
// -----------------------------------------------------------------------------

describe("resolveGatePhaseFromState: single in_progress (AC1/R1)", () => {
  it("resolves flow-level impl-gate in_progress to integration", () => {
    const state = {
      steps: [
        { id: "branch", status: "done" },
        { id: "prepare-spec", status: "done" },
        { id: "draft", status: "done" },
        { id: "draft-gate", status: "done" },
        { id: "spec", status: "done" },
        { id: "spec-gate", status: "done" },
        { id: "approval", status: "done" },
        { id: "test", status: "done" },
        { id: "implement", status: "done" },
        { id: "impl-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result, "expected non-null result");
    assert.equal(result.phase, "integration");
    assert.deepEqual(result.staleSteps, []);
  });

  it("resolves draft-gate in_progress to draft", () => {
    const state = {
      steps: [
        { id: "draft", status: "done" },
        { id: "draft-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result);
    assert.equal(result.phase, "draft");
    assert.deepEqual(result.staleSteps, []);
  });

  it("resolves flow-level gate in_progress to spec", () => {
    const state = {
      steps: [
        { id: "spec", status: "done" },
        { id: "spec-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result);
    assert.equal(result.phase, "spec");
    assert.deepEqual(result.staleSteps, []);
  });
});

// -----------------------------------------------------------------------------
// AC2 (R2): zero in_progress -> null (caller must reject with error)
// -----------------------------------------------------------------------------

describe("resolveGatePhaseFromState: zero in_progress (AC2/R2)", () => {
  it("returns null when no gate-type step is in_progress", () => {
    const state = {
      steps: [
        { id: "branch", status: "done" },
        { id: "draft-gate", status: "done" },
        { id: "spec-gate", status: "pending" },
        { id: "impl-gate", status: "pending" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.equal(result, null);
  });
});

// -----------------------------------------------------------------------------
// AC3 (R3): multiple flow-level in_progress -> latest wins, others stale
// -----------------------------------------------------------------------------

describe("resolveGatePhaseFromState: multiple flow-level in_progress (AC3/R3)", () => {
  it("prefers the later step in FLOW_STEPS order and marks earlier ones stale", () => {
    const state = {
      steps: [
        { id: "draft-gate", status: "done" },
        { id: "spec", status: "done" },
        { id: "spec-gate", status: "in_progress" },
        { id: "implement", status: "done" },
        { id: "impl-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result);
    assert.equal(result.phase, "integration");
    assert.deepEqual(result.staleSteps, ["spec-gate"]);
  });

  it("handles three simultaneously-in_progress gate steps (latest wins, others stale)", () => {
    const state = {
      steps: [
        { id: "draft-gate", status: "in_progress" },
        { id: "spec-gate", status: "in_progress" },
        { id: "impl-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result);
    assert.equal(result.phase, "integration");
    // stale order should reflect the scan order we choose to expose; the set
    // matters. The flow-level spec only requires that staleSteps contains the
    // non-chosen in_progress gate steps.
    assert.deepEqual(new Set(result.staleSteps), new Set(["draft-gate", "spec-gate"]));
  });
});

// -----------------------------------------------------------------------------
// AC4 (R3, task-level): task-level gate in_progress wins over flow-level
// -----------------------------------------------------------------------------

describe("resolveGatePhaseFromState: task-level takes precedence (AC4/R3)", () => {
  it("picks task-impl when active task's task-gate step is in_progress", () => {
    const state = {
      steps: [
        { id: "impl-gate", status: "pending" },
      ],
      tasks: [
        {
          id: "T1",
          status: "in_progress",
          steps: [
            { id: "T1-impl", status: "done" },
            { id: "T1-review", status: "done" },
            { id: "T1-gate", status: "in_progress" },
          ],
        },
      ],
      currentTaskId: "T1",
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result, "expected non-null result");
    assert.equal(result.phase, "task-impl");
    assert.deepEqual(result.staleSteps, []);
  });

  it("does not mistake a Task for the flow-level task-spec validation route", () => {
    const state = {
      steps: [
        { id: "spec-gate", status: "in_progress" },
        { id: "impl-gate", status: "done" },
      ],
      tasks: [
        {
          id: "T1",
          status: "in_progress",
          steps: [
            { id: "T1-impl", status: "done" },
            { id: "T1-review", status: "pending" },
            { id: "T1-gate", status: "pending" },
          ],
        },
      ],
      currentTaskId: "T1",
    };
    const result = resolveGatePhaseFromState(state);
    assert.ok(result);
    assert.equal(result.phase, "spec");
    assert.deepEqual(result.staleSteps, []);
  });

  it("passes explicit task scope to the task-gate lifecycle mutation", async () => {
    const root = createTmpDir("gate-phase-task-scope-");
    try {
      const flowManager = makeFlowManager(root);
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId: "001-test",
        runId: "run-task-gate-pre",
        specRecord: { requirements: [{ id: "R-T1", desc: "Exercise Task Gate scope.", task_ids: ["T1"] }] },
      }).create().addTask({
        id: "T1", title: "task", goal: "task", parent: null,
        origin: "plan", added_round: 0, status: "pending",
      }).registerActive();
      fixture.settleBefore("T1-impl").activateTask("T1", { settlePredecessors: false });
      fixture
        .settle("T1-impl")
        .settle("T1-review")
        .settle("T1-triage", "skipped")
        .settle("T1-repair", "skipped")
        .activate("T1-gate", { settlePredecessors: false });
      const flowState = flowManager.loadReadOnly("001-test");

      assert.equal(FLOW_COMMANDS.run.gate.runtimeLog.stepId({ phase: "task-impl", flowState }), "T1-gate");
      await FLOW_COMMANDS.run.gate.pre({
        phase: "task-impl",
        flowState,
        flowManager,
        root,
        mainRoot: root,
        executionRoot: root,
      });

      const updated = flowManager.loadReadOnly("001-test");
      assert.equal(updated.tasks[0].steps.find((step) => step.id === "T1-gate")?.status, "in_progress");
      assert.equal(updated.currentTaskId, "T1");
      assert.equal(updated.steps.find((step) => step.id === "impl-gate")?.status ?? "pending", "pending");
    } finally {
      removeTmpDir(root);
    }
  });

  it("keeps the flow-level integration gate lifecycle identity at impl-gate", async () => {
    const root = createTmpDir("gate-phase-flow-scope-");
    try {
      const flowManager = makeFlowManager(root);
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId: "001-test",
        runId: "run-impl-gate-pre",
      }).create().registerActive();
      fixture.settleBefore("impl-gate");
      const flowState = flowManager.loadReadOnly("001-test");

      await FLOW_COMMANDS.run.gate.pre({
        phase: "integration",
        flowState,
        flowManager,
        root,
        mainRoot: root,
        executionRoot: root,
      });

      const updated = flowManager.loadReadOnly("001-test");
      assert.equal(resolveGateStepId("integration"), "impl-gate");
      assert.equal(updated.currentNodeId, "impl-gate");
      assert.equal(updated.currentTaskId, null);
    } finally {
      removeTmpDir(root);
    }
  });

  it("allows explicit terminal gate revalidation without reopening lifecycle state", async () => {
    const updates = [];
    const flowState = {
      currentTaskId: null,
      steps: [
        { id: "impl-gate", status: "done" },
        { id: "retro", status: "done" },
        { id: "acceptance-review", status: "in_progress" },
      ],
      tasks: [],
    };
    const ctx = {
      phase: "integration",
      flowState,
      flowManager: {
        load: () => flowState,
        updateStepStatus(transition, opts) { updates.push({ transition, opts }); },
      },
    };

    await FLOW_COMMANDS.run.gate.pre(ctx);
    await FLOW_COMMANDS.run.gate.post(ctx, {
      result: "pass",
      artifacts: { phase: "integration", evaluations: [] },
    });

    assert.equal(ctx.terminalGateRevalidation, true);
    assert.deepEqual(updates, []);
    assert.equal(flowState.steps[2].status, "in_progress");
  });

  it("skips the normal gate post-hook after stale evidence recovery", async () => {
    let loaded = false;
    await FLOW_COMMANDS.run.gate.post({
      terminalGateRevalidation: false,
      flowManager: {
        load() {
          loaded = true;
          throw new Error("normal gate lifecycle must not run");
        },
      },
    }, {
      result: "recovered",
      artifacts: {
        evidenceRefresh: { recovered: true },
      },
    });
    assert.equal(loaded, false);
  });
});

// -----------------------------------------------------------------------------
// AC2 / AC3 via in-process execution of RunGateCommand (R2, R3)
// No external processes — we exercise RunGateCommand.execute directly.
// -----------------------------------------------------------------------------

describe("RunGateCommand.execute (in-process, AC2/AC3)", () => {
  let tmp;
  afterEach(() => {
    if (tmp) removeTmpDir(tmp);
    tmp = null;
  });

  it("AC2: returns ok:false envelope with --phase enum listed when no gate-type step is in_progress", async () => {
    tmp = createTmpDir();
    setupFlowConfig(tmp, "ja");
    const state = {
      specId: "001-test",
      baseBranch: "main",
      featureBranch: "feature/001-test",
      steps: [
        { id: "branch", status: "done" },
        { id: "draft-gate", status: "done" },
        { id: "spec-gate", status: "pending" },
        { id: "impl-gate", status: "pending" },
      ],
      tasks: [],
      currentTaskId: null,
    };
    const { default: RunGateCommand } = await import("../../../src/flow/lib/run-gate.js");
    const cmd = new RunGateCommand();
    const result = await cmd.execute({ flowState: state, phase: undefined, root: tmp, config: {} });
    // RunGateCommand returns an Envelope on precondition failure.
    assert.ok(result && typeof result.toJSON === "function", `expected Envelope, got: ${result}`);
    const json = result.toJSON();
    assert.equal(json.ok, false);
    const errorMsg = JSON.stringify(json.errors || []);
    for (const phase of ["draft", "spec", "task-spec", "task-impl", "integration"]) {
      assert.ok(errorMsg.includes(phase), `error message must list phase "${phase}", got: ${errorMsg}`);
    }
    // Verify the error code matches the precondition contract.
    assert.ok(json.errors?.[0]?.code === "NO_GATE_STEP_IN_PROGRESS", `unexpected code: ${errorMsg}`);
  });

  it("AC3: preserves inferred gate steps when downstream integration validation does not complete", async () => {
    // In-process test: drive RunGateCommand.execute directly with a mock
    // flow state and a stub flowManager. This verifies the stale-step
    // recovery side effect without spawning external processes.
    tmp = createTmpDir();
    setupFlowConfig(tmp, "ja");

    const state = {
      runId: "run-001-test",
      specId: "001-test",
      baseBranch: "main",
      featureBranch: "feature/001-test",
      steps: [
        { id: "branch", status: "done" },
        { id: "prepare-spec", status: "done" },
        { id: "draft", status: "done" },
        { id: "draft-gate", status: "done" },
        { id: "spec", status: "done" },
        { id: "spec-gate", status: "in_progress" },
        { id: "approval", status: "done" },
        { id: "test", status: "done" },
        { id: "implement", status: "done" },
        { id: "impl-gate", status: "in_progress" },
      ],
      tasks: [],
      currentTaskId: null,
      // spec 222: satisfy the head-evidence guard so the downstream path runs
      // (and the expected throw from missing git/config fires as originally
      // intended).
      test: { summary: { exitCode: 0 } },
    };
    const transitions = [];
    const stubFlowManager = {
      load: () => state,
      updateStepStatus(transition) {
        assert.ok(transition instanceof DefinitionLifecycleTransition);
        transitions.push(transition);
        const step = state.steps.find((candidate) => candidate.id === transition.stepId);
        if (step) step.status = transition.requestedStatus;
      },
    };

    const before = structuredClone(state);

    // Replace container.get("flowManager") for this invocation. Use dynamic
    // import + module-level container ref.
    const containerMod = await import("../../../src/lib/container.js");
    const originalGet = containerMod.container.get.bind(containerMod.container);
    containerMod.container.get = (key) => (key === "flowManager" ? stubFlowManager : originalGet(key));

    const errs = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      errs.push(String(chunk));
      return true;
    };

    try {
      const { default: RunGateCommand } = await import("../../../src/flow/lib/run-gate.js");
      const cmd = new RunGateCommand();
      // Minimal ctx: downstream integration validation fails before a valid
      // semantic PASS/FAIL result can reach the transition commit boundary.
      const ctx = { flowState: state, phase: undefined, root: tmp, config: {} };
      // The downstream path may either throw because git/config are missing
      // or return a mechanical gateFail when the integration precheck detects
      // missing evidence. Neither outcome may commit inferred recovery.
      let downstreamError = null;
      let downstreamResult = null;
      try {
        downstreamResult = await cmd.execute(ctx);
      } catch (err) {
        downstreamError = err;
      }
      assert.ok(
        downstreamError !== null || downstreamResult !== null,
        "downstream gate evaluation must produce an outcome (throw or gateFail); got neither",
      );
    } finally {
      containerMod.container.get = originalGet;
      process.stderr.write = originalWrite;
    }

    assert.deepEqual(transitions, []);
    assert.deepEqual(state, before);
    const stderrText = errs.join("");
    assert.doesNotMatch(
      stderrText,
      /gate: stale in_progress step|committed phase=/,
      `failed inference must not claim a committed transition: ${stderrText}`,
    );
  });
});
