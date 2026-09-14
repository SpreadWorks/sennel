import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import RunGateCommand, {
  GateEvaluationScope,
  appendIssueLogFromGateResult,
  findReusablePassedGuardrails,
  runGateFlow,
} from "../../../src/flow/lib/run-gate.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { resolveGateTransition } from "../../../src/flow/definition.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import { canonicalPlanGateRepairForTarget } from "../../../src/flow/lib/plan-gate-repair.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { container } from "../../../src/lib/container.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";

const SPEC_ID = "961-gate-source-authority";

function taskGateFixture(root) {
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
    mutate: () => writeFile(root, "src/task-behavior.js", "export const currentTaskBehavior = false;\n"),
    effect: {
      version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      triage: null, repair: null, noChangeReason: null,
    },
  });
  fixture.activate("T-1-review", { settlePredecessors: false });
  fixture.settle("T-1-review");
  fixture.settle("T-1-triage", "skipped");
  fixture.settle("T-1-repair", "skipped");
  fixture.activate("T-1-gate", { settlePredecessors: false });
  return flowManager;
}

async function executeTaskGate(root, flowManager) {
  return new RunGateCommand().execute({
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    phase: "task-impl",
    flowState: flowManager.loadReadOnly(SPEC_ID),
    flowManager,
    config: {},
    skipGuardrail: true,
  });
}

function settleTaskGateFailure(root, flowManager, result) {
  const facts = () => readCurrentGateTransitionFacts({
    flowManager,
    flowState: flowManager.loadReadOnly(SPEC_ID),
    phase: "task-impl",
    root,
  });
  let decision = resolveGateTransition(facts());
  flowManager.recordGateObservationDecision({ specId: SPEC_ID, decision });
  decision = resolveGateTransition(facts());
  flowManager.recordTaskGateSettlementMetric({ specId: SPEC_ID, decision });
  decision = resolveGateTransition(facts());
  appendIssueLogFromGateResult({
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    flowManager,
    flowState: flowManager.loadReadOnly(SPEC_ID),
    phase: "task-impl",
    gateTransitionDecision: decision,
  }, result);
  return resolveGateTransition(facts());
}

async function publishPassingTaskReview(root, flowManager) {
  const review = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), `${JSON.stringify({
        version: 1,
        phase: "impl",
        generatedAt: "2026-09-08T00:00:00.000Z",
        verdict: "PASS",
        summary: { blocking: 0, nonBlocking: 0, total: 0 },
        blockingFindings: [],
        nonBlockingImprovements: [],
        excluded: { missingFile: 0, outOfScope: 0 },
      })}\n`);
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const ctx = {
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    flowManager,
    flowState: flowManager.loadReadOnly(SPEC_ID),
    config: {},
  };
  const result = await review.execute(ctx);
  if (result.ok !== false) await FLOW_COMMANDS.run.review.post(ctx, result);
  return result;
}

describe("Task Gate source authority", () => {
  let root;

  afterEach(() => {
    if (root) removeTmpDir(root);
    root = null;
  });

  it("binds a semantic failure before publication, then a fresh reader selects the sealed repair route", async () => {
    root = createTmpDir("gate-source-authority-");
    const flowManager = taskGateFixture(root);
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
    flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: result });

    const reloaded = makeFlowManager(root);
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID),
      phase: "task-impl",
      root,
    });
    assert.equal(facts.failure.category, "semantic");
    const decision = settleTaskGateFailure(root, reloaded, result);
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
    const flowManager = taskGateFixture(root);
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
      flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: first });
      const repairDecision = settleTaskGateFailure(root, flowManager, first);
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
      flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: passed });

      const status = new GetStatusCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager, flowState: flowManager.loadReadOnly(SPEC_ID),
      });
      assert.equal(status.gateObservationConvergence.entries[0].finalDisposition, "passed");

      const restarted = makeFlowManager(root);
      const restartedStatus = new GetStatusCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID,
        flowManager: restarted, flowState: restarted.loadReadOnly(SPEC_ID),
      });
      assert.deepEqual(restartedStatus.gateObservationConvergence, status.gateObservationConvergence);

      let passDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: restarted, flowState: restarted.loadReadOnly(SPEC_ID), phase: "task-impl", root,
      }));
      restarted.recordTaskGateSettlementMetric({ specId: SPEC_ID, decision: passDecision });
      passDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: restarted, flowState: restarted.loadReadOnly(SPEC_ID), phase: "task-impl", root,
      }));
      appendIssueLogFromGateResult({
        root, mainRoot: root, executionRoot: root, specId: SPEC_ID, flowManager: restarted,
        flowState: restarted.loadReadOnly(SPEC_ID), phase: "task-impl", gateTransitionDecision: passDecision,
      }, passed);
      passDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: restarted, flowState: restarted.loadReadOnly(SPEC_ID), phase: "task-impl", root,
      }));
      restarted.confirmCurrentAttempt({ specId: SPEC_ID, status: "done", gateTransitionDecision: passDecision });
    } finally {
      container.get = originalGet;
    }
  });

  it("reuses a prior partial PASS for the exact scope before selecting the sealed repair route", async () => {
    root = createTmpDir("gate-source-reuse-");
    const flowManager = taskGateFixture(root);
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
    flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: result });

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
    const decision = settleTaskGateFailure(root, reloaded, result);
    assert.equal(decision.disposition.operation, "repair");
    assert.throws(
      () => reloaded.retryGateTransition({ specId: SPEC_ID, decision }),
      /stale or no longer admitted/,
    );
  });

  it("refuses provider-time canonical spec drift without publishing a Task Gate result", async () => {
    root = createTmpDir("gate-source-spec-drift-");
    const flowManager = taskGateFixture(root);
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
    const flowManager = taskGateFixture(root);
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
    const flowManager = taskGateFixture(root);
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
    flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: result });
    const reloaded = makeFlowManager(root);
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID),
      phase: "task-impl",
      root,
    });
    assert.equal(facts.failure.category, "tooling");
    assert.equal(resolveGateTransition(facts).disposition.operation, "external-blocked");
  });

  it("binds the canonical source byte-limit refusal before a fresh reader classifies it", async () => {
    root = createTmpDir("gate-source-oversized-");
    const flowManager = taskGateFixture(root);
    // Prompt-sized source is now partitionable. The independent canonical
    // source admission limit remains 1 MiB and must still refuse before AI.
    writeFile(root, "src/task-behavior.js", `export const currentTaskBehavior = "${"x".repeat(1024 * 1024)}";\n`);
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
    flowManager.publishCurrentAttemptResult({ specId: SPEC_ID, commandResult: result });
    const reloaded = makeFlowManager(root);
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID),
      phase: "task-impl",
      root,
    });
    assert.equal(facts.failure.category, "local");
    assert.equal(resolveGateTransition(facts).disposition.operation, "blocked");
  });
});
