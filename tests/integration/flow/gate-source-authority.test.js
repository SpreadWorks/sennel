import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import RunGateCommand, {
  GateEvaluationScope,
  findReusablePassedGuardrails,
  runGateFlow,
} from "../../../src/flow/lib/run-gate.js";
import { resolveGateNextAction } from "../../../src/flow/lib/gate-transition-application.js";
import { implementationNonblockingEligibilityForResult } from "../../../src/flow/definition.js";
import { assertImplPhaseResult } from "../../support/assertions/impl-phase-result.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import { canonicalPlanGateRepairForTarget } from "../../../src/flow/lib/plan-gate-repair.js";
import { ImplementationReviewProducer } from "../../support/infrastructure/implementation-review-producer.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { container } from "../../../src/lib/container.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";

const SPEC_ID = "961-gate-source-authority";

function canonicalSnapshot(flowManager) {
  return JSON.parse(JSON.stringify({
    state: flowManager.canonicalState(SPEC_ID),
    activities: flowManager.activityLedger(SPEC_ID),
    catalog: flowManager.artifactCatalog(SPEC_ID),
  }));
}

async function taskGateFixture(root, sourceText = "export const currentTaskBehavior = false;\n") {
  writeJson(root, ".sennel/config.json", {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  });
  writeFile(root, "README.md", "Gate source authority fixture\n");
  initGitRepo(root);
  commitAll(root, "initial fixture");
  const flowManager = makeFlowManager(root);
  const requirements = [
    { id: "R-1", desc: "Keep the first task behavior.", task_ids: ["T-1"], testable: false },
    { id: "R-2", desc: "Keep the second task behavior.", task_ids: ["T-1"], testable: false },
  ];
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: SPEC_ID,
    runId: "run-gate-source-authority",
    request: "Validate Task Gate source authority.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: {
      goal: "Validate Task Gate source authority.",
      requirements,
      acceptance_criteria: ["Task Gate source stays bound to its result."],
    },
  }).create().addTask({
    id: "T-1",
    title: "Source authority",
    goal: "Evaluate current source.",
    test_strategy: "Exercise the canonical Task Gate.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
  }).registerActive();
  fixture.settleBefore("T-1-impl");
  commitAll(root, "record canonical baseline");
  fixture.activateTask("T-1", { settlePredecessors: false });

  completeCanonicalSourceHandoff({
    root, manager: flowManager, specId: SPEC_ID, stepId: "task-impl", taskId: "T-1",
    mutate: () => writeFile(root, "src/task-behavior.js", sourceText),
    effect: {
      version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      triage: null, repair: null, noChangeReason: null,
    },
  });
  fixture.activate("T-1-review", { settlePredecessors: false });
  // Board 03 requires a genuine Review producer and its selected skip effects.
  const review = await publishPassingTaskReview(root, flowManager);
  assert.notEqual(review.ok, false, JSON.stringify(review));
  assert.equal(flowManager.canonicalState(SPEC_ID).current?.at(-1), "T-1-gate");
  return flowManager;
}

async function executeTaskGate(root, flowManager) {
  const ctx = {
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    phase: "task-impl",
    flowState: flowManager.loadReadOnly(SPEC_ID),
    flowManager,
    config: {},
    skipGuardrail: true,
  };
  await FLOW_COMMANDS.run.gate.pre(ctx);
  const result = await new RunGateCommand().execute(ctx);
  // The registered post publishes Result, artifact, issue, receipt and effects atomically.
  await FLOW_COMMANDS.run.gate.post(ctx, result);
  return result;
}

function savedTaskGate(flowManager, { completed = false } = {}) {
  const saved = flowManager.readCurrentStepSettlement({ specId: SPEC_ID, stepId: "task-gate", taskId: "T-1", completed });
  assert.ok(saved, "Task Gate must persist its selected Result with the publication");
  assertImplPhaseResult(saved.result);
  assert.equal(saved.receipt.binding.stepId, "task-gate");
  const activity = flowManager.activityLedger(SPEC_ID).find((entry) => entry.id === saved.activityId);
  assert.equal(activity.attemptId, saved.receipt.binding.attemptId);
  assert.equal(activity.sequence, saved.receipt.binding.attemptSequence);
  assert.equal(activity.result.draftSettlementReceipt.id, saved.receipt.id);
  return saved;
}

function selectedTaskGateFailure(root, flowManager) {
  const saved = savedTaskGate(flowManager);
  const selected = resolveGateNextAction({ flowManager, flowState: flowManager.loadReadOnly(SPEC_ID),
    phase: "task-impl", root });
  assert.equal(selected.receipt.id, saved.receipt.id);
  return selected.decision;
}

async function publishPassingTaskReview(root, flowManager) {
  const ctx = {
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    flowManager,
    flowState: flowManager.loadReadOnly(SPEC_ID),
    config: {},
  };
  return new ImplementationReviewProducer().publish(ctx);
}

describe("Task Gate source authority", () => {
  let root;

  afterEach(() => {
    if (root) removeTmpDir(root);
    root = null;
  });

  it("binds a semantic failure before publication, then a fresh reader selects the sealed repair route", async () => {
    root = createTmpDir("gate-source-authority-");
    const flowManager = await taskGateFixture(root);
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => JSON.stringify({ evaluations: [
        { guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] current source preserves the first behavior." },
        { guardrail_id: "R-2", result: "fail", reason: "[REQ:R-2] current source contradicts the second behavior." },
      ] }),
    };
    let result;
    try {
      result = await executeTaskGate(root, flowManager);
    } finally {
      container.get = originalGet;
    }

    assert.equal(result.result, "fail");
    assert.match(result.artifacts.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.artifacts.evaluationScope.taskId, "T-1");
    assert.equal(result.artifacts.evaluationScope.sourceFingerprint, result.artifacts.sourceFingerprint);

    const reloaded = makeFlowManager(root);
    const saved = savedTaskGate(reloaded);
    assert.equal(saved.result.kind, "task-gate-repair-required");
    assert.equal(saved.result.evidence.failure.category, "semantic");
    const decision = selectedTaskGateFailure(root, reloaded);
    assert.equal(reloaded.canonicalState(SPEC_ID).attempt.failure.category, "semantic");
    assert.equal(decision.disposition.operation, "repair");
    const next = await new GetNextActionCommand().execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId: SPEC_ID,
      phase: "task-impl",
      flowManager: makeFlowManager(root),
      flowState: makeFlowManager(root).loadReadOnly(SPEC_ID),
    });
    assert.equal(next.directive.actionId, "REPAIR_PLAN_GATE_EVIDENCE");
  });

  it("re-evaluates changed repaired source, publishes PASS, and reconstructs passed convergence after restart", async () => {
    root = createTmpDir("gate-source-repair-pass-");
    const flowManager = await taskGateFixture(root);
    let providerCalls = 0;
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => {
        providerCalls += 1;
        return JSON.stringify({ evaluations: [
          { guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] the repaired source preserves the first behavior." },
          { guardrail_id: "R-2", result: providerCalls === 1 ? "fail" : "pass", reason: providerCalls === 1
            ? "[REQ:R-2] the initial source contradicts the second behavior."
            : "[REQ:R-2] the repaired source preserves the second behavior." },
        ] });
      },
    };
    try {
      const first = await executeTaskGate(root, flowManager);
      assert.equal(first.result, "fail");
      const repairDecision = selectedTaskGateFailure(root, flowManager);
      assert.equal(repairDecision.disposition.operation, "repair");

      const repaired = new RunRepairPlanGateCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager, flowState: flowManager.loadReadOnly(SPEC_ID),
      });
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      const repair = canonicalPlanGateRepairForTarget({
        flowManager,
        state: flowManager.loadReadOnly(SPEC_ID),
        targetStepId: "T-1-impl",
      });
      completeCanonicalSourceHandoff({
        root, manager: flowManager, specId: SPEC_ID, stepId: "task-impl", taskId: "T-1",
        mutate: () => writeFile(root, "src/task-behavior.js", "export const currentTaskBehavior = true;\n"),
        effect: {
          version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
          overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
          gateRepair: {
            version: 1,
            summary: "Changed the exact canonical source path for every selected Gate observation.",
            results: repair.observationRequests.map((request) => ({
              fingerprint: request.fingerprint.toString(),
              strategy: "replace the incomplete source behavior",
              summary: "The repaired source now supplies the previously absent behavior.",
              priorRepairInsufficiency: null,
              paths: ["src/task-behavior.js"],
            })),
          },
          noChangeReason: null,
        },
      });
      assert.equal(flowManager.canonicalState(SPEC_ID).current, null);
      flowManager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId: SPEC_ID });
      const review = await publishPassingTaskReview(root, flowManager);
      assert.notEqual(review.ok, false, JSON.stringify(review));
      assert.equal(flowManager.canonicalState(SPEC_ID).current?.at(-1), "T-1-gate", JSON.stringify(review));

      const passed = await executeTaskGate(root, flowManager);
      assert.equal(passed.result, "pass");
      assert.equal(providerCalls, 2, "changed source evidence admits exactly one fresh provider evaluation");

      const beforeStatus = canonicalSnapshot(flowManager);
      const status = new GetStatusCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager, flowState: flowManager.loadReadOnly(SPEC_ID),
      });
      assert.equal(status.gateObservationConvergence.entries[0].finalDisposition, "passed");
      assert.deepEqual(canonicalSnapshot(flowManager), beforeStatus, "status read must not mutate canonical records");

      const completed = savedTaskGate(flowManager, { completed: true });
      assert.equal(completed.result.kind, "task-gate-passed");
      const passDecision = completed.settlement.application.decision;

      const restarted = makeFlowManager(root);
      const beforeRestartedStatus = canonicalSnapshot(restarted);
      const restartedStatus = new GetStatusCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager: restarted, flowState: restarted.loadReadOnly(SPEC_ID),
      });
      assert.deepEqual(restartedStatus.gateObservationConvergence, status.gateObservationConvergence);
      assert.deepEqual(canonicalSnapshot(restarted), beforeRestartedStatus, "reloaded status read must remain read-only");
      const restartedSaved = savedTaskGate(restarted, { completed: true });
      const restartedDecision = restartedSaved.settlement.application.decision;
      assert.deepEqual(
        restartedDecision.toJSON(),
        passDecision.toJSON(),
        "status read must not change the Definition-owned disposition",
      );
      assert.equal(restartedSaved.receipt.id, completed.receipt.id);
      assert.equal(restartedSaved.activityId, completed.activityId);

      const settled = makeFlowManager(root);
      const beforeSettledStatus = canonicalSnapshot(settled);
      const settledStatus = new GetStatusCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager: settled, flowState: settled.loadReadOnly(SPEC_ID),
      });
      assert.equal(settledStatus.gateObservationConvergence.entries[0].finalDisposition, "passed");
      assert.equal(settled.activityLedger(SPEC_ID).some((activity) => (
        activity.attemptId === passed.artifacts.gateTransitionAttemptId
        && activity.id === completed.activityId
        && activity.result?.stepResult?.kind === "task-gate-passed"
        && activity.result?.draftSettlementReceipt?.id === completed.receipt.id
      )), true);
      assert.deepEqual(canonicalSnapshot(settled), beforeSettledStatus, "settled status read must remain read-only");
    } finally {
      container.get = originalGet;
    }
  });

  it("reuses a prior partial PASS for the exact scope before selecting the sealed repair route", async () => {
    root = createTmpDir("gate-source-reuse-");
    const flowManager = await taskGateFixture(root);
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => JSON.stringify({ evaluations: [
        { guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] current source preserves the first behavior." },
        { guardrail_id: "R-2", result: "fail", reason: "[REQ:R-2] current source contradicts the second behavior." },
      ] }),
    };
    let result;
    try {
      result = await executeTaskGate(root, flowManager);
    } finally {
      container.get = originalGet;
    }

    const reloaded = makeFlowManager(root);
    const scope = GateEvaluationScope.fromJSON(result.artifacts.evaluationScope);
    assert.deepEqual(findReusablePassedGuardrails({
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID),
      evaluationScope: scope,
    }).passedGuardrails, ["R-1"]);
    assert.equal(findReusablePassedGuardrails({
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID),
      evaluationScope: GateEvaluationScope.fromJSON({
        ...scope.toJSON(),
        contentFingerprint: "f".repeat(64),
      }),
    }), null);
    const flipped = await runGateFlow({
      root,
      config: {},
      level: "task",
      phase: "task-impl",
      targetPath: "tasks/T-1.md",
      targetText: "same canonical Task Gate input",
      textCheck: () => [],
      checkerRole: "fixture",
      skipGuardrail: false,
      ctx: {
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(SPEC_ID),
        evaluationScope: scope,
      },
      checkGuardrailFn: async () => ({
        passed: false,
        evaluations: [{ guardrail_id: "R-1", result: "fail", reason: "fixture would fail a historically passing scope." }],
      }),
    });
    assert.equal(flipped.result, "pass");
    assert.equal(flipped.artifacts.evaluations[0].result, "pass");
    const decision = selectedTaskGateFailure(root, reloaded);
    assert.equal(decision.disposition.operation, "repair");
    assert.throws(
      () => reloaded.retryGateTransition({ specId: SPEC_ID, decision }),
      /stale or no longer admitted/,
    );
  });

  it("refuses provider-time canonical spec drift without publishing a Task Gate result", async () => {
    root = createTmpDir("gate-source-spec-drift-");
    const flowManager = await taskGateFixture(root);
    let driftedSpec = null;
    const freshRead = new Proxy(flowManager, {
      get(target, property) {
        if (property !== "readArtifact") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (input) => {
          const artifact = target.readArtifact(input);
          if (driftedSpec !== null && input?.logicalKey === "spec.record") {
            return { ...artifact, bytes: Buffer.from(`${JSON.stringify(driftedSpec)}\n`, "utf8") };
          }
          return artifact;
        };
      },
    });
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => {
        const current = JSON.parse(flowManager.readArtifact({
          specId: SPEC_ID,
          logicalKey: "spec.record",
          consumerNodeId: "T-1-gate",
        }).bytes.toString("utf8"));
        current.acceptance_criteria = [...current.acceptance_criteria, "A provider-time constraint changed."];
        driftedSpec = current;
        return JSON.stringify({ evaluations: [
          { guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] current source preserves the first behavior." },
          { guardrail_id: "R-2", result: "pass", reason: "[REQ:R-2] current source preserves the second behavior." },
        ] });
      },
    };
    try {
      await assert.rejects(
        () => executeTaskGate(root, freshRead),
        /evaluation inputs changed during evaluation/,
      );
    } finally {
      container.get = originalGet;
    }
    assert.equal(flowManager.readProducerArtifact({
      specId: SPEC_ID,
      nodeId: "T-1-gate",
      logicalKey: "task.gate",
      parameters: { taskId: "T-1" },
      optional: true,
    }), null);
  });

  it("refuses provider-time Task source mutation without publishing a Task Gate result", async () => {
    root = createTmpDir("gate-source-content-drift-");
    const flowManager = await taskGateFixture(root);
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => {
        writeFile(root, "src/task-behavior.js", "export const currentTaskBehavior = true;\n");
        return JSON.stringify({ evaluations: [
          { guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] source changed during provider call." },
          { guardrail_id: "R-2", result: "pass", reason: "[REQ:R-2] source changed during provider call." },
        ] });
      },
    };
    try {
      await assert.rejects(
        () => executeTaskGate(root, flowManager),
        /source changed during evaluation/,
      );
    } finally {
      container.get = originalGet;
    }
    assert.equal(flowManager.readProducerArtifact({
      specId: SPEC_ID,
      nodeId: "T-1-gate",
      logicalKey: "task.gate",
      parameters: { taskId: "T-1" },
      optional: true,
    }), null);
  });

  it("binds a tooling refusal before a fresh reader blocks the Attempt", async () => {
    root = createTmpDir("gate-source-tooling-");
    const flowManager = await taskGateFixture(root);
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => false,
    };
    let result;
    try {
      result = await executeTaskGate(root, flowManager);
    } finally {
      container.get = originalGet;
    }
    assert.equal(result.result, "fail");
    assert.match(result.artifacts.sourceFingerprint, /^[a-f0-9]{64}$/);
    const reloaded = makeFlowManager(root);
    const saved = savedTaskGate(reloaded);
    assert.equal(saved.result.type, "error");
    assert.equal(saved.result.error.data.evidence.failure.category, "tooling");
    assert.equal(saved.settlement.kind, "failure");
    assert.equal(implementationNonblockingEligibilityForResult(saved.result).strictDisposition.operation, "external-blocked");
    const before = canonicalSnapshot(reloaded);
    const next = await new GetNextActionCommand().execute({ root, mainRoot: root, executionRoot: root,
      specId: SPEC_ID, phase: "task-impl", flowManager: reloaded, flowState: reloaded.loadReadOnly(SPEC_ID) });
    assert.equal(next.directive.kind, "await_user_decision");
    assert.equal(next.directive.requiresUserAction, true);
    assert.deepEqual(canonicalSnapshot(reloaded), before, "an advisory activation offer must retain the failed Gate");
  });

  it("binds the canonical source byte-limit refusal before a fresh reader classifies it", async () => {
    root = createTmpDir("gate-source-oversized-");
    const flowManager = await taskGateFixture(root,
      `export const currentTaskBehavior = "${"x".repeat(1024 * 1024)}";\n`);
    const review = flowManager.readCurrentStepSettlement({ specId: SPEC_ID,
      stepId: "task-review", taskId: "T-1", completed: true });
    assert.equal(review.result.kind, "task-review-gate-required");
    // Prompt-sized source is now partitionable. The independent canonical
    // source admission limit remains 1 MiB and must still refuse before AI.
    let calls = 0;
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async () => { calls += 1; return "unreachable"; },
    };
    let result;
    try {
      result = await executeTaskGate(root, flowManager);
    } finally {
      container.get = originalGet;
    }
    assert.equal(result.result, "fail");
    assert.equal(calls, 0);
    assert.match(result.artifacts.issues.join("\n"), /exceeds limit 1048576/);
    assert.match(result.artifacts.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.artifacts.sourceFingerprint, review.result.evidence.sourceFingerprint);
    const reloaded = makeFlowManager(root);
    assert.equal(reloaded.readCurrentStepSettlement({ specId: SPEC_ID,
      stepId: "task-review", taskId: "T-1", completed: true }).receipt.id, review.receipt.id);
    const saved = savedTaskGate(reloaded);
    assert.equal(saved.result.type, "error");
    assert.equal(saved.result.error.data.evidence.failure.category, "local");
    assert.equal(saved.settlement.kind, "failure");
    assert.equal(implementationNonblockingEligibilityForResult(saved.result).strictDisposition.operation, "blocked");
    const before = canonicalSnapshot(reloaded);
    const next = await new GetNextActionCommand().execute({ root, mainRoot: root, executionRoot: root,
      specId: SPEC_ID, phase: "task-impl", flowManager: reloaded, flowState: reloaded.loadReadOnly(SPEC_ID) });
    assert.equal(next.directive.kind, "await_user_decision");
    assert.equal(next.directive.requiresUserAction, true);
    assert.deepEqual(canonicalSnapshot(reloaded), before, "an advisory activation offer must retain the failed Gate");
  });
});
