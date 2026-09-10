import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../support/builders/tmp-dir.js";
import { initGitRepo, commitAll, checkoutNewBranch } from "../support/infrastructure/git-repo.js";
import { CanonicalFlowFixture, makeFlowManager } from "../support/infrastructure/flow-setup.js";
import { completeCanonicalSourceHandoff } from "../support/builders/source-handoff-scenario.js";

const CMD = path.resolve("src/sennel.js");
const SPEC_ID = "001-cli-lifecycle";
const FEATURE_BRANCH = `feature/${SPEC_ID}`;

const PASS_REVIEW = JSON.stringify({
  blockingFindings: [],
  nonBlockingImprovements: [],
});

const PASS_GATE = JSON.stringify({
  evaluations: [{ guardrail_id: "R1", result: "pass", reason: "R1 is implemented." }],
});

const PASS_TEST_REVIEW = JSON.stringify({
  blockingFindings: [],
  advisoryFindings: [],
});

const PASS_ACCEPTANCE = JSON.stringify({
  requirementJudgments: [{
    requirementId: "R1",
    status: "met",
    requestRefs: ["flow.request"],
    requirementRefs: ["spec.json#R1"],
    diffRefs: ["diff:src/value.js"],
    repairRefs: ["acceptance:no-repair"],
    testRefs: ["test-execute-result.json#R1"],
    missingEvidence: [],
  }],
  deferredFindingDispositions: [],
});

const FAIL_REVIEW = JSON.stringify({
  blockingFindings: [{
    findingKey: "zero-operands-wrong-sum",
    title: "Zero operands return the wrong sum",
    failureMode: "spec_behavior_contradiction",
    file: "src/value.js",
    requirementId: "R1",
    issue: "The implementation returns zero whenever either operand is zero.",
    suggestion: "Return left + right for every numeric operand.",
    disposition: "must-fix",
    rationale: "R1 requires ordinary addition for all numeric inputs.",
  }],
  nonBlockingImprovements: [],
});

function writeLifecycleStubAgentScript(tmp) {
  const scriptPath = path.join(tmp, ".stub-agent.cjs");
  const repairedSource = [
    "export function add(left, right) {",
    "  return left + right;",
    "}",
    "",
  ].join("\n");
  const routes = [
    { includes: "if (!left || !right) return 0;", response: FAIL_REVIEW },
    { includes: "bounded static test review mapper", response: PASS_TEST_REVIEW },
    { includes: "guardrail_id MUST be one of the requirement ids", response: PASS_GATE },
    { includes: "## Guardrail Articles", response: JSON.stringify({ observations: [] }) },
    { includes: "semantic acceptance reviewer", response: PASS_ACCEPTANCE },
  ];
  fs.writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const routes = ${JSON.stringify(routes)};`,
    `const fallback = ${JSON.stringify(PASS_REVIEW)};`,
    "const prompt = process.argv.slice(2).join('\\n');",
    "const route = routes.find((candidate) => prompt.includes(candidate.includes));",
    `if (route?.repair) fs.writeFileSync(${JSON.stringify(path.join(tmp, "src/value.js"))}, ${JSON.stringify(repairedSource)});`,
    "process.stdout.write(route ? route.response : fallback);",
    "",
  ].join("\n"));
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function run(tmp, args) {
  return spawnSync("node", [CMD, ...args], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      SENNEL_WORK_ROOT: tmp,
      SENNEL_SOURCE_ROOT: tmp,
    },
  });
}

function runOk(tmp, args) {
  const result = run(tmp, args);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runEnvelope(tmp, args) {
  const result = runOk(tmp, args);
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.ok, true, `${args.join(" ")} returned ${result.stdout}`);
  return envelope;
}

function assertNext(tmp, step, taskId) {
  const envelope = runEnvelope(tmp, ["flow", "get", "next-action"]);
  assert.equal(
    envelope.data.step,
    step,
    JSON.stringify(makeFlowManager(tmp).loadReadOnly(SPEC_ID), null, 2),
  );
  assert.equal(envelope.data.taskId, taskId);
  if (envelope.data.directive?.actionId === "CLAIM_NEXT_ACTION") {
    runEnvelope(tmp, ["flow", "run", "claim-next-action"]);
  }
}

function git(tmp, args) {
  const result = spawnSync("git", args, {
    cwd: tmp,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function completeTaskStage(tmp, role, effect, edit = null) {
  const manager = makeFlowManager(tmp);
  const state = manager.canonicalState(SPEC_ID);
  assert.equal(state.current.at(-1), `T-1-${role}`);
  return completeCanonicalSourceHandoff({
    root: tmp, manager, specId: SPEC_ID, stepId: `task-${role}`, taskId: "T-1",
    mutate: edit ?? (() => {}), effect,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  }).reconciliation;
}

function setupFixture(tmp) {
  const stubPath = writeLifecycleStubAgentScript(tmp);
  writeJson(tmp, ".sennel/config.json", {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    flow: { merge: "squash" },
    test: {
      command: "node --test tests/project.test.js",
      testExecuteRegression: "targeted",
      timeout: 30,
    },
    commands: { gh: "disable" },
    agent: {
      timeout: 30,
      retryCount: 1,
      useProfile: "lifecycle-e2e",
      profiles: { "lifecycle-e2e": { flow: "stub-agent" } },
      providers: {
        "stub-agent": {
          name: "stub-agent",
          command: "node",
          args: [stubPath],
        },
      },
    },
  });
  writeJson(tmp, "package.json", {
    name: "cli-lifecycle-fixture",
    version: "0.0.0",
    type: "module",
    scripts: { test: "node --test tests/project.test.js" },
  });
  writeFile(tmp, ".gitignore", [
    ".sennel/*",
    "!.sennel/config.json",
    "!.sennel/output/",
    ".tmp/",
    "",
  ].join("\n"));
  writeFile(tmp, "src/value.js", [
    "export function add() {",
    "  throw new Error(\"not implemented\");",
    "}",
    "",
  ].join("\n"));
  writeFile(tmp, "tests/project.test.js", [
    "import assert from \"node:assert/strict\";",
    "import { test } from \"node:test\";",
    "import { add } from \"../src/value.js\";",
    "test(\"project addition\", () => assert.equal(add(2, 3), 5));",
    "",
  ].join("\n"));

  initGitRepo(tmp);
  commitAll(tmp, "initial fixture");
  checkoutNewBranch(tmp, FEATURE_BRANCH);

  const fm = makeFlowManager(tmp);
  const fixture = new CanonicalFlowFixture({
    flowManager: fm,
    specId: SPEC_ID,
    runId: `run-${SPEC_ID}`,
    request: "Implement numeric addition through the complete CLI lifecycle.",
    execution: { mode: "branch", baseBranch: "main", featureBranch: FEATURE_BRANCH },
    specRecord: {
      goal: "Implement numeric addition through the complete CLI lifecycle.",
      background: "CLI-only lifecycle fixture.",
      scope: { in: ["src/value.js"], out: [] },
      requirements: [{ id: "R1", desc: "add returns the arithmetic sum of two numeric operands", priority: "must", task_ids: ["T-1"] }],
      acceptance_criteria: ["add(2, 3) returns 5"],
      user_approval: { approved: true, confirmed_at: "2026-01-01T00:00:00.000Z", notes: "E2E fixture approval" },
    },
  }).create().addTasks([{
    id: "T-1",
    title: "Implement addition",
    goal: "Implement R1 in src/value.js.",
    acceptance: ["Positive operands are added."],
    test_strategy: "Run the spec-local R1 test.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
  }]).activate("test");
  fm.publishArtifacts({
    specId: SPEC_ID,
    nodeId: "test",
    artifactWrites: [{
      logicalKey: "tests.source",
      parameters: { testPath: "r1.test.js" },
      mediaType: "text/javascript",
      bytes: Buffer.from([
        "// spec: R1",
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { add } from '../../../../../src/value.js';",
        "test('R1: add returns the arithmetic sum', () => assert.equal(add(2, 3), 5));",
        "",
      ].join("\n"), "utf8"),
    }],
  });
  fixture.settle("test").activate("scenario-validity", { settlePredecessors: false }).registerActive();
  for (const segment of ["impl", "review", "triage", "repair", "gate"]) {
    assert.equal(
      fixture.location().taskArtifactLocation("T-1")[`${segment}Directory`],
      path.join(fixture.location().directory, "steps", "impl", "T-1", segment),
    );
  }
}

describe("231: full lifecycle through CLI and the typed source handoff boundary", { timeout: 180_000 }, () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("stale integration evidence recovery regenerates the acceptance lifecycle", () => {
    tmp = createTmpDir("sennel-cli-lifecycle-");
    setupFixture(tmp);

    // The command creates both scenario-validity artifacts. The test never
    // writes generated flow artifacts or mutates flow.json directly.
    const scenarioValidity = runEnvelope(tmp, ["flow", "run", "scenario-validity"]);
    const scenarioValidityHistory = JSON.parse(makeFlowManager(tmp).readArtifact({
      specId: SPEC_ID,
      logicalKey: "scenario.validity",
      consumerNodeId: "acceptance-review",
    }).bytes.toString("utf8"));
    assert.equal(
      scenarioValidity.data.result,
      "pass",
      JSON.stringify({ scenarioValidity, scenarioValidityHistory }, null, 2),
    );
    assert.equal(scenarioValidityHistory.attempts.at(-1).artifact.payload.result, "pass");

    assertNext(tmp, "test-review", null);
    const testDesignReview = runEnvelope(tmp, ["flow", "run", "review", "--phase", "test"]);
    assert.equal(testDesignReview.data.artifacts.verdict, "PASS");
    assertNext(tmp, "implement", null);

    writeFile(tmp, "src/value.js", [
      "export function add(left, right) {",
      "  if (!left || !right) return 0;",
      "  return left + right;",
      "}",
      "",
    ].join("\n"));
    runEnvelope(tmp, ["flow", "set", "step", "implement", "done"]);
    assertNext(tmp, "task-impl", "T-1");
    const manager = makeFlowManager(tmp);
    completeCanonicalSourceHandoff({
      root: tmp, manager, specId: SPEC_ID, stepId: "task-impl", taskId: "T-1",
      mutate: () => writeFile(tmp, "src/value.js", [
        "// Task-scoped implementation evidence.",
        "export function add(left, right) {",
        "  if (!left || !right) return 0;",
        "  return left + right;",
        "}",
        "",
      ].join("\n")),
      effect: {
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: null,
      },
    });
    assertNext(tmp, "task-review", "T-1");

    const failedReview = runEnvelope(tmp, ["flow", "run", "review"]);
    assert.equal(failedReview.data.artifacts.verdict, "REJECTED");
    assert.equal(failedReview.data.artifacts.taskId, "T-1");
    assertNext(tmp, "task-triage", "T-1");
    const failedFinding = JSON.parse(FAIL_REVIEW).blockingFindings[0];
    assert.equal(completeTaskStage(tmp, "triage", {
      version: 1,
      stepId: "task-triage",
      completionStatus: "done",
      issues: [],
      overview: null,
      triage: {
        version: 1,
        dispositions: [{
          findingKey: failedFinding.findingKey,
          disposition: "apply",
          basis: "repair-required",
          rationale: "R1 confirms that the zero-value branch must be removed.",
        }],
      },
      repair: null,
      noChangeReason: null,
    }).completed, true);
    assertNext(tmp, "task-repair", "T-1");
    assert.equal(completeTaskStage(tmp, "repair", {
      version: 1,
      stepId: "task-repair",
      completionStatus: "done",
      issues: [],
      overview: null,
      triage: null,
      repair: {
        version: 1,
        findings: [{ findingKey: failedFinding.findingKey, paths: ["src/value.js"] }],
        summary: "Removed the invalid zero-value branch.",
        recurrenceResolutions: [],
      },
      noChangeReason: null,
    }, () => writeFile(tmp, "src/value.js", [
      "export function add(left, right) {",
      "  return left + right;",
      "}",
      "",
    ].join("\n"))).completed, true);
    assertNext(tmp, "task-review", "T-1");
    const passedTaskReview = runEnvelope(tmp, ["flow", "run", "review"]);
    assert.equal(passedTaskReview.data.artifacts.verdict, "PASS");
    assertNext(tmp, "task-gate", "T-1");

    runEnvelope(tmp, ["flow", "run", "gate", "--phase", "task-impl"]);
    // TaskLifecycleFixture enters task-impl after the flow-level implement
    // leaf is confirmed. Completing the Task gate therefore advances the
    // canonical definition directly to its next pending producer.
    assertNext(tmp, "test-execute", null);

    runOk(tmp, ["docs", "scan"]);
    runEnvelope(tmp, ["flow", "run", "test-execute"]);
    assertNext(tmp, "test-result-review", null);
    runEnvelope(tmp, ["flow", "run", "test-result-review"]);
    assertNext(tmp, "impl-review", null);
    const passedFlowReview = runEnvelope(tmp, ["flow", "run", "review"]);
    assert.equal(passedFlowReview.data.artifacts.verdict, "PASS");
    assertNext(tmp, "impl-gate", null);
    const taskReviewHistory = JSON.parse(makeFlowManager(tmp).readArtifact({
      specId: "001-cli-lifecycle",
      logicalKey: "task.review",
      parameters: { taskId: "T-1" },
      consumerNodeId: "task-gate",
    }).bytes.toString("utf8"));
    const matchingHistory = taskReviewHistory.attempts
      .map((attempt) => attempt.artifact.payload)
      .filter((artifact) => artifact.blockingFindings?.some(
        (finding) => finding.findingKey === failedFinding.findingKey,
      ));
    assert.ok(matchingHistory.length > 0);
    assert.deepEqual(matchingHistory.map((artifact) => artifact.taskId ?? null), ["T-1"]);

    writeFile(tmp, "src/value.js", [
      "export function add(left, right) {",
      "  // Material implementation change after test evidence was recorded.",
      "  return left + right;",
      "}",
      "",
    ].join("\n"));
    const recoveredGate = runEnvelope(
      tmp,
      ["flow", "run", "gate", "--phase", "integration"],
    );
    assert.equal(recoveredGate.data.result, "recovered");
    assert.equal(recoveredGate.data.next, "test-execute");
    assert.equal(recoveredGate.data.artifacts.evidenceRefresh.recovered, true);
    assertNext(tmp, "test-execute", null);

    runEnvelope(tmp, ["flow", "run", "test-execute"]);
    assertNext(tmp, "test-result-review", null);
    runEnvelope(tmp, ["flow", "run", "test-result-review"]);
    assertNext(tmp, "impl-review", null);
    const regeneratedReview = runEnvelope(tmp, ["flow", "run", "review"]);
    assert.equal(regeneratedReview.data.artifacts.verdict, "PASS");
    assertNext(tmp, "impl-gate", null);
    runEnvelope(tmp, ["flow", "run", "gate", "--phase", "integration"]);
    assertNext(tmp, "retro", null);
    runEnvelope(tmp, ["flow", "run", "retro"]);
    assertNext(tmp, "acceptance-review", null);
    const acceptance = runEnvelope(tmp, ["flow", "run", "acceptance-review"]);
    assert.equal(acceptance.data.verdict, "pass", JSON.stringify(acceptance));
    assertNext(tmp, "final-regression", null);

    const regression = runEnvelope(tmp, ["flow", "run", "final-regression"]);
    assert.equal(regression.data.result, "pass");
    assertNext(tmp, "report", null);
    runEnvelope(tmp, ["flow", "run", "report"]);
    assertNext(tmp, "finalize-commit", null);

    runEnvelope(tmp, [
      "flow", "run", "finalize-commit",
      "--message", "test: complete CLI lifecycle",
    ]);
    assertNext(tmp, "finalize-merge", null);
    runEnvelope(tmp, ["flow", "run", "finalize-merge"]);
    assertNext(tmp, "finalize-sync", null);
    runEnvelope(tmp, ["flow", "run", "finalize-sync"]);
    assertNext(tmp, "finalize-cleanup", null);
    const cleanup = runEnvelope(tmp, ["flow", "run", "finalize-cleanup"]);
    assert.match(cleanup.data.report.text, /Final regression: result=pass/);
    assert.match(cleanup.data.report.text, /T-1 status=done/);

    const status = runEnvelope(tmp, ["flow", "get", "status"]);
    assert.equal(status.data.active, false);
    const report = runOk(tmp, ["flow", "report", "show"]);
    assert.equal(report.stdout.trim(), cleanup.data.report.text.trim());
    assert.equal(fs.existsSync(path.join(tmp, ".sennel", "last-finalized-spec")), true);
    assert.equal(git(tmp, ["branch", "--list", FEATURE_BRANCH]).stdout.trim(), "");
  });
});
