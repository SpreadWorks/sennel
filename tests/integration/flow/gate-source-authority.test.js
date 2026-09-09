import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import RunGateCommand, {
  GateEvaluationScope,
  appendIssueLogFromGateResult,
  findReusablePassedGuardrails,
  runGateFlow,
} from "../../../src/flow/lib/run-gate.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { resolveGateTransition } from "../../../src/flow/definition.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
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
    { id: "R-1", desc: "Keep the first task behavior.", task_ids: ["T-1"] },
    { id: "R-2", desc: "Keep the second task behavior.", task_ids: ["T-1"] },
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
  fixture.settleBefore("scenario-validity").activate("scenario-validity", { settlePredecessors: false });
  commitAll(root, "record canonical baseline");
  flowManager.publishCurrentAttemptResult({
    specId: SPEC_ID,
    commandResult: attachCanonicalCommandResultArtifact({ result: "pass" }, {
      logicalKey: "scenario.validity",
      payload: { version: "1", process: { started: true, exitCode: 1 }, result: "pass" },
    }),
  });
  fixture.settle("scenario-validity");
  fixture.settleBefore("T-1-impl");
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

describe("Task Gate source authority", () => {
  let root;

  afterEach(() => {
    if (root) removeTmpDir(root);
    root = null;
  });

  it("binds a semantic failure before publication, then a fresh reader classifies the same Attempt", async () => {
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
    assert.equal(decision.disposition.operation, "retry");
    const next = await new GetNextActionCommand().execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId: SPEC_ID,
      phase: "task-impl",
      flowManager: makeFlowManager(root),
      flowState: makeFlowManager(root).loadReadOnly(SPEC_ID),
    });
    assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
  });

  it("reuses a prior partial PASS on the Definition-selected retry without another R-1 evaluation", async () => {
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
    reloaded.retryGateTransition({ specId: SPEC_ID, decision });

    const retriedIds = [];
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async (_prompt, options) => {
        const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
        retriedIds.push(...ids);
        return JSON.stringify({ evaluations: ids.map((id) => ({
          guardrail_id: id,
          result: "pass",
          reason: `[REQ:${id}] retry evaluates the remaining Requirement only.`,
        })) });
      },
    };
    try {
      const retried = await executeTaskGate(root, reloaded);
      assert.equal(retried.result, "pass");
    } finally {
      container.get = originalGet;
    }
    assert.deepEqual(retriedIds, ["R-2"]);

    writeJson(root, ".sennel/guardrail.json", {
      guardrails: [{
        id: "retry-scope-change",
        title: "Retry Scope Change",
        body: "A changed Task Gate guardrail requires a fresh Requirement evaluation.",
        meta: { phase: ["task-impl"], category: "process" },
      }],
    });
    const changedIds = [];
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async (_prompt, options) => {
        const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
        changedIds.push(...ids);
        return JSON.stringify({ evaluations: ids.map((id) => ({
          guardrail_id: id,
          result: "pass",
          reason: `[REQ:${id}] changed guardrail requires a fresh evaluation.`,
        })) });
      },
    };
    try {
      const changed = await executeTaskGate(root, reloaded);
      assert.equal(changed.result, "pass");
    } finally {
      container.get = originalGet;
    }
    assert.deepEqual(changedIds.sort(), ["R-1", "R-2"]);
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

  it("binds an oversized-source refusal before a fresh reader classifies it", async () => {
    root = createTmpDir("gate-source-oversized-");
    const flowManager = taskGateFixture(root);
    writeFile(root, "src/task-behavior.js", `export const currentTaskBehavior = "${"x".repeat(140_000)}";\n`);
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
