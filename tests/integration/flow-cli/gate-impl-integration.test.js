import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
/**
 * spec 202 — integration tests for gate-impl wiring.
 *
 * Invokes the real `sennel` CLI as a subprocess against a throwaway git
 * repo fixture, verifying:
 *   R1: PASS wiring (mechanical test-change check admits multi-line +)
 *   R2: FAIL wiring (mechanical check rejects deletions / single-line +)
 *   R3: ESCALATE end-to-end (retry limit enforcement via CLI exit)
 *   R4: post-hook retry counter transitions (PASS resets, FAIL +1)
 *   (spec 215) R5 removed: run-draft-task was removed together with addition origin
 *
 * AI is replaced via config.agent.providers stub (see tests/support/fakes/stub-agent.js).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll, checkoutNewBranch } from "../../support/infrastructure/git-repo.js";
import {
  writeCapturingGateStubAgentScript,
  writePromptDispatchStubAgentScript,
  stubAgentConfig,
} from "../../support/fakes/stub-agent.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";
import {
  CanonicalTestArtifactStore,
  canonicalRawEvidenceFingerprint,
} from "../../../src/flow/lib/canonical-test-artifacts.js";

const CMD = path.join(process.cwd(), "src/sennel.js");
const SPEC_ID = "001-test";

function minimalSpecJson() {
  return {
    goal: "Fixture for integration test.",
    background: "",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "R1", desc: "anything goes", priority: "must", task_ids: ["T-1"] }],
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

function buildPassResponseJson(...ids) {
  return JSON.stringify({
    evaluations: ids.map((id) => ({
      guardrail_id: id,
      result: "pass",
      reason: `stub pass for ${id}`,
    })),
  });
}

function attemptHistoryBytes(nodeId, logicalKey, payload) {
  return Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
    new FlowArtifactAttemptRecord({
      attempt: 1,
      payload: {
        nodeId,
        outcome: "completed",
        result: { result: "ok" },
        artifact: { logicalKey, payload },
      },
    }),
  ]).toJSON(), null, 2)}\n`, "utf8");
}

function publishAttemptArtifact(flowManager, specId, nodeId, logicalKey, payload) {
  flowManager.publishArtifacts({
    specId,
    nodeId,
    artifactWrites: [{
      logicalKey,
      mediaType: "application/json",
      bytes: attemptHistoryBytes(nodeId, logicalKey, payload),
    }],
  });
}

function publishIntegrationDesignArtifacts(fixture, flowManager, specId, requirementIds) {
  fixture.activate("test");
  for (const id of requirementIds) {
    flowManager.publishArtifacts({
      specId,
      nodeId: "test",
      artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: `${id}.test.js` },
        mediaType: "text/javascript",
        bytes: Buffer.from(`// spec: ${id}\nimport test from "node:test";\ntest("${id}: validates integration gate trust", () => {});\n`),
      }],
    });
  }
  fixture.settle("test").activate("scenario-validity", { settlePredecessors: false });
  const testSourceRevision = new CanonicalTestArtifactStore({
    flowManager,
    state: fixture.state(),
  }).testSourceRevision().digest;
  publishAttemptArtifact(flowManager, specId, "scenario-validity", "scenario.validity", {
    version: "1",
    testSourceRevision,
    command: "node --test artifacts/tests/*.test.js",
    process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
    result: "pass",
    raw_output_path: flowManager.specLocation(specId).relativeArtifact("scenario.validity.raw-log"),
    summary: [],
  });
  fixture.settle("scenario-validity").activate("test-review", { settlePredecessors: false });
  publishAttemptArtifact(flowManager, specId, "test-review", "test.review", {
    version: 1,
    phase: "test",
    verdict: "PASS",
    summary: "Canonical test review passed.",
    blockingFindings: [],
    nonBlockingImprovements: [],
  });
  fixture.settle("test-review");
}

function publishIntegrationExecutionArtifacts(fixture, flowManager, specId, requirementIds) {
  fixture.activate("test-execute", { settlePredecessors: false });
  const rawOutputPath = flowManager.specLocation(specId).relativeArtifact("test.execute.raw-log");
  const testSourceRevision = new CanonicalTestArtifactStore({
    flowManager,
    state: fixture.state(),
  }).testSourceRevision().digest;
  const rawBytes = Buffer.from("integration execution evidence\n", "utf8");
  flowManager.writeRuntimeArtifact({
    specId,
    nodeId: "test-execute",
    artifact: { logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: rawBytes },
  });
  const repairFingerprint = buildRepairFingerprint({
    root: fixture.location().repositoryRoot,
    artifactRoot: fixture.location().repositoryRoot,
    specPath: fixture.location().relativeSpecFile,
  }).hash;
  publishAttemptArtifact(flowManager, specId, "test-execute", "test.execute", {
    version: "2",
    repairFingerprint,
    testSourceRevision,
    rawEvidenceFingerprint: canonicalRawEvidenceFingerprint(rawBytes),
    process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
    raw_output_path: rawOutputPath,
    summary: requirementIds.map((id) => ({
      id,
      result: "pass",
      evidence: {
        test_file: `${id}.test.js`,
        test_name: `${id}: validates integration gate trust`,
        command: "node --test artifacts/tests/*.test.js",
        raw_output_lines: { start_line: 1, end_line: 1 },
      },
    })),
    regression: {
      required: false,
      result: "skipped",
      mode: "none",
      category: "full-regression-deferred",
      reason: "fixture full regression is deferred",
      classified_paths: [],
      trigger_relevant_changed_files: [],
      changed_files: [],
    },
  });
  const descriptor = flowManager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "test.execute");
  const activity = flowManager.activityLedger(specId).find((entry) => entry.id === descriptor.activityId);
  fixture.settle("test-execute").activate("test-result-review", { settlePredecessors: false });
  publishAttemptArtifact(flowManager, specId, "test-result-review", "test.result.review", {
    repairFingerprint,
    testSourceRevision,
    testExecute: {
      historyAttempt: 1,
      producerActivityId: descriptor.activityId,
      attemptId: activity.attemptId,
      sequence: activity.sequence,
    },
    rawEvidenceFingerprint: canonicalRawEvidenceFingerprint(rawBytes),
    verdict: "pass",
    checked_items: [{ check: "project_regression_verification", result: "pass", detail: "fixture evidence verified" }],
    result_file_path: flowManager.specLocation(specId).relativeArtifact("test.execute"),
    raw_output_path: rawOutputPath,
  });
  fixture.settle("test-result-review");
}

function setupFixture(tmp, {
  initialTest,
  modifiedTest,
  gateRetry = 0,
  seedIssueLog = false,
  stubResponse = buildPassResponseJson("R1"),
  specJson = minimalSpecJson(),
  fileMap = null,
  capturePromptPath = null,
  integrationTrustRequirementIds = null,
  stubScriptBody = null,
  agentConfigured = true,
} = {}) {
  // Stub AI provider
  const stubPath = capturePromptPath
    ? writeCapturingGateStubAgentScript(tmp, ".stub-agent.js", capturePromptPath, stubResponse)
    : writePromptDispatchStubAgentScript(tmp, ".stub-agent.js", [
      { includes: "## Guardrail Articles", response: JSON.stringify({ observations: [] }) },
    ], stubResponse);
  if (stubScriptBody) writeFile(tmp, path.relative(tmp, stubPath), stubScriptBody);
  writeJson(tmp, ".sennel/config.json", {
    lang: "ja",
    type: "base",
    docs: { languages: ["ja"], defaultLanguage: "ja" },
    ...(agentConfigured ? { agent: stubAgentConfig(stubPath) } : {}),
  });
  writeJson(tmp, "package.json", { name: "fixture", version: "0.0.0" });

  // Initial test file
  writeFile(tmp, "tests/dummy.test.js", initialTest);

  // Git repo with main as base
  initGitRepo(tmp);
  commitAll(tmp, "initial");

  // Feature branch. The Task implementation mutation is applied only after
  // its canonical source baseline has been captured below.
  checkoutNewBranch(tmp, `feature/${SPEC_ID}`);
  commitAll(tmp, "empty feature commit");

  const flowManager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
  const gateTask = specJson.tasks?.[0] ?? {
    id: "T-1",
    title: "Integration Gate fixture task",
    goal: "Exercise the canonical Task Gate boundary.",
    acceptance: [],
    origin: "plan",
    added_round: 0,
    status: "pending",
  };
  const canonicalSpec = {
    ...specJson,
    requirements: (specJson.requirements ?? []).map((requirement) => ({
      ...requirement,
      task_ids: requirement.task_ids ?? [gateTask.id],
    })),
  };
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: SPEC_ID,
    runId: `run-${SPEC_ID}`,
    request: "Verify implementation gate behavior.",
    execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
    specRecord: { ...canonicalSpec, tasks: [] },
  }).create();
  fixture.addTask(gateTask).registerActive();

  if (integrationTrustRequirementIds) {
    publishIntegrationDesignArtifacts(fixture, flowManager, SPEC_ID, integrationTrustRequirementIds);
  }

  fixture.activate("implement");
  if (fileMap) {
    for (const [requirementId, paths] of Object.entries(fileMap)) {
      flowManager.updateFileMap({ specId: SPEC_ID, requirementId, paths });
    }
  }
  fixture.settle("implement");

  fixture.activate(`${gateTask.id}-impl`, { settlePredecessors: false });
  completeCanonicalSourceHandoff({
    root: tmp, manager: flowManager, specId: SPEC_ID, stepId: "task-impl", taskId: gateTask.id,
    mutate: () => {
      if (modifiedTest !== undefined) writeFile(tmp, "tests/dummy.test.js", modifiedTest);
    },
    effect: {
      version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
      overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
      noChangeReason: modifiedTest === undefined
        ? "The fixture Task implementation requires no source change." : null,
    },
  });
  fixture.activate(`${gateTask.id}-review`, { settlePredecessors: false });
  fixture.settle(`${gateTask.id}-review`);
  fixture.settle(`${gateTask.id}-triage`, "skipped");
  fixture.settle(`${gateTask.id}-repair`, "skipped");
  fixture.activate(`${gateTask.id}-gate`, { settlePredecessors: false });

  if (!integrationTrustRequirementIds) {
    for (let i = 0; i < (gateRetry || 0); i++) {
      flowManager.incrementMetric("task-impl", "gateRetry", { specId: SPEC_ID });
    }

    if (seedIssueLog) {
      for (const n of [1, 2, 3]) {
        flowManager.appendIssueLog({
          specId: SPEC_ID,
          idempotencyKey: `gate-seed-${n}`,
          entry: {
            step: `${gateTask.id}-gate`,
            phase: "task-impl",
            reason: `seeded FAIL reason ${n}`,
          },
        });
      }
    }
    return { stubPath, flowManager, location: fixture.location() };
  }

  fixture.settle(`${gateTask.id}-gate`);

  publishIntegrationExecutionArtifacts(fixture, flowManager, SPEC_ID, integrationTrustRequirementIds);

  fixture.activate("impl-review");
  publishAttemptArtifact(flowManager, SPEC_ID, "impl-review", "impl.review", {
    version: 1,
    phase: "impl",
    verdict: "PASS",
    summary: "Canonical implementation review passed.",
    blockingFindings: [],
    nonBlockingImprovements: [],
    canonicalEvidence: { phase: "impl", disposition: "PASS", findings: [] },
  });
  fixture.settle("impl-review").activate("impl-gate");

  return { stubPath, flowManager, location: fixture.location() };
}

function runGate(tmp, extraArgs = [], phase = "task-impl") {
  return spawnSync(
    "node",
    [CMD, "flow", "run", "gate", "--phase", phase, ...extraArgs],
    {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    },
  );
}

function readCounter(tmp) {
  const entries = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false })
    .loadReadOnly(SPEC_ID)?.metrics ?? [];
  let count = 0;
  for (const e of entries) {
    if (e.phase !== "task-impl" || e.counter !== "gateRetry") continue;
    if (e.reset) count = 0;
    else count += e.delta ?? 1;
  }
  return count;
}

function parseEnvelope(stdout) {
  // CLI prints JSON envelope on stdout; be tolerant of trailing newlines.
  return JSON.parse(stdout.trim());
}

const BASE_TEST = [
  "// test fixture",
  "test('a', () => { assert(1 === 1); });",
  "",
].join("\n");

describe("gate-impl integration (spec 202)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("R1: multi-line-only addition in test file → gate PASS", () => {
    tmp = createTmpDir();
    const modified = [
      "// test fixture",
      "test('a', () => { assert(1 === 1); });",
      "test('b', () => {",
      "  assert(2 === 2);",
      "});",
      "",
    ].join("\n");
    setupFixture(tmp, { initialTest: BASE_TEST, modifiedTest: modified });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.data.result, "pass", `envelope=${res.stdout}`);
  });

  it("R2-post-235: test file edits are no longer mechanically rejected", () => {
    tmp = createTmpDir();
    const modifiedTest = BASE_TEST.replace("assert(1 === 1)", "assert(2 === 2)");
    setupFixture(tmp, { initialTest: BASE_TEST, modifiedTest });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `test-file edit should not cause mechanical FAIL. stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass", "gate should PASS despite test file edits");
  });

  it("R3: display retry history cannot exhaust a fresh canonical Attempt", () => {
    tmp = createTmpDir();
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: BASE_TEST + "// trivial change\n",
      gateRetry: 5,
      seedIssueLog: true,
    });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass");
    assert.equal(readCounter(tmp), 0, "PASS resets the display metric without granting it route authority");
  });

  it("R4a: gate PASS resets counter to 0", () => {
    tmp = createTmpDir();
    const modified = [
      "// test fixture",
      "test('a', () => { assert(1 === 1); });",
      "test('b', () => {",
      "  assert(2 === 2);",
      "});",
      "",
    ].join("\n");
    setupFixture(tmp, { initialTest: BASE_TEST, modifiedTest: modified, gateRetry: 2 });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass");
    assert.equal(readCounter(tmp), 0, "counter must reset to 0 on PASS");
  });

  it("R4b-post-235: retry counter increments on AI FAIL, not mechanical test-change FAIL", () => {
    tmp = createTmpDir();
    setupFixture(tmp, { initialTest: BASE_TEST, modifiedTest: `${BASE_TEST}// current Task source\n`, gateRetry: 0 });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass", "identical test file should not trigger mechanical FAIL");
  });

  it("passes bounded cited requirement context through the real gate command", () => {
    tmp = createTmpDir();
    const capturePath = path.join(tmp, "captured-requirement-context-prompt.txt");
    const specJson = minimalSpecJson();
    specJson.scope.out = ["Do not replace delegated behavior"];
    specJson.constraints = ["Use the exact schema contract"];
    specJson.design_principles = ["R1 preserves `resultField`"];
    specJson.overview = {
      modules: [{ text: "R1 is owned by `tests/dummy.test.js`" }],
      data_flow: [{ text: "R1 retains delegated evidence" }],
      decisions: [{ text: "R1 schema field contract is `resultField`" }],
    };
    specJson.requirements = [{
      id: "R1",
      desc: "Preserve delegated `resultField` behavior",
      priority: "must",
      status: "pending",
    }];
    specJson.acceptance_criteria = ["AC1 (R1): regression evidence keeps `resultField` unchanged"];
    specJson.implementationTargets = ["tests/dummy.test.js"];
    specJson.tasks = [{
      id: "T-1",
      title: "Preserve result field",
      goal: "Preserve R1 through `tests/dummy.test.js`.",
      acceptance: ["R1 keeps delegated behavior."],
      origin: "plan",
      added_round: 0,
      status: "pending",
    }];
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: `${BASE_TEST}// regression evidence for resultField\n`,
      specJson,
      fileMap: { R1: ["tests/dummy.test.js"] },
      capturePromptPath: capturePath,
      integrationTrustRequirementIds: ["R1"],
      stubResponse: JSON.stringify({
        evaluations: [{
          guardrail_id: "R1",
          result: "pass",
          reason: "[REQ:R1] [AC:1] [EVIDENCE:R1] preserved",
        }],
      }),
    });

    const res = runGate(tmp, [], "integration");
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass");
    const prompt = fs.readFileSync(capturePath, "utf8");
    assert.match(prompt, /## Requirement Contexts/);
    assert.match(prompt, /Obligation: preservation\/non-interception/);
    assert.match(prompt, /\[SCHEMA:DECISION:1:1\] resultField/);
    assert.match(prompt, /\[FILE-MAP:R1:1\] tests\/dummy\.test\.js/);
    assert.match(prompt, /\[EVIDENCE:R1\]/);
  });

  it("R5a-312: task-impl accepts explicit spec.json ID without file-map", () => {
    tmp = createTmpDir();
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: BASE_TEST + "// spec-json id source\n",
      stubResponse: buildPassResponseJson("R1"),
    });

    const res = runGate(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass");
  });

  for (const { name, fileMap, stubResponse, expectPass } of [
    {
      name: "R5c-312: task-impl accepts explicit spec.json ID with file-map",
      fileMap: { R1: ["tests/dummy.test.js"] },
      stubResponse: buildPassResponseJson("R1"),
      expectPass: true,
    },
  ]) {
    it(name, () => {
      tmp = createTmpDir();
      setupFixture(tmp, {
        initialTest: BASE_TEST,
        modifiedTest: BASE_TEST + `// ${name}\n`,
        fileMap,
        stubResponse,
      });

      const res = runGate(tmp);
      assert.equal(expectPass, true);
      assert.equal(res.status, 0, `stderr=${res.stderr}`);
      const env = parseEnvelope(res.stdout);
      assert.equal(env.data.result, "pass");
    });
  }

  it("R6-312: rejects unusable canonical requirement IDs before source handoff can reach integration", () => {
    tmp = createTmpDir();
    // Canonical source attribution now rejects this malformed Spec before
    // Task completion. Passing it through that boundary to test Gate would
    // manufacture a state that the normal producer can no longer create.
    assert.throws(() => setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: undefined,
      specJson: { ...minimalSpecJson(), requirements: [{ id: "   ", desc: "no usable id" }] },
      integrationTrustRequirementIds: ["REQ-FALLBACK"],
      stubResponse: buildPassResponseJson("REQ-FALLBACK"),
    }), /canonical requirement\[0\]\.id is required/);
    const manager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    assert.equal(manager.loadReadOnly(SPEC_ID).currentNodeId, "T-1-impl");
    assert.deepEqual(manager.taskMutationLineages({ specId: SPEC_ID, taskId: "T-1" }), []);
    assert.equal(manager.artifactCatalog(SPEC_ID).artifacts.some((entry) => entry.logicalKey === "file.map"), false);
  });

  it("integration requirement prompts receive bounded same-spec contract context", () => {
    tmp = createTmpDir();
    const capturePath = path.join(tmp, "captured-prompt.txt");
    const specJson = {
      ...minimalSpecJson(),
      overview: {
        modules: [],
        data_flow: [],
        decisions: [{
          text: "R1 replaces the nullable legacy output.",
          evidence: "current schema",
          consideredAlternatives: "legacy output",
        }],
      },
      requirements: [
        { id: "R1", desc: "Return a required status enum.", priority: "must" },
        { id: "R2", desc: "Preserve the current R1 contract.", priority: "must" },
      ],
      clarifications: [{ q: "Is legacy [] valid?", a: "No." }],
    };
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: `${BASE_TEST}// current contract implementation\n`,
      stubResponse: buildPassResponseJson("R1", "R2"),
      specJson,
      fileMap: { R1: ["tests/dummy.test.js"], R2: ["tests/dummy.test.js"] },
      capturePromptPath: capturePath,
      integrationTrustRequirementIds: ["R1", "R2"],
    });

    const res = runGate(tmp, [], "integration");
    const runtimeLogPath = path.join(tmp, ".tmp/logs", `${SPEC_ID}.log`);
    const runtimeLog = fs.existsSync(runtimeLogPath) ? fs.readFileSync(runtimeLogPath, "utf8") : "(missing)";
    assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}\nruntimeLog=${runtimeLog}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.data.result, "pass", res.stdout);
    const prompt = fs.readFileSync(capturePath, "utf8");
    assert.match(prompt, /## Same-Spec Contract Context/);
    assert.match(prompt, /requirements\[1\] R2: Preserve the current R1 contract\./);
    assert.match(prompt, /requirements\[0\] R1: Return a required status enum\./);
    assert.match(prompt, /overview\.decisions\[0\].*replaces the nullable legacy output/s);
    assert.match(prompt, /clarifications\[0\].*legacy \[\] valid/s);
    assert.match(prompt, /\[REGRESSION\].*full-regression-deferred/s);
  });

  it("rewinds stale cataloged test evidence before integration evaluation", () => {
    tmp = createTmpDir();
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: `${BASE_TEST}\n// integration change\n`,
      integrationTrustRequirementIds: ["R1"],
      fileMap: { R1: ["tests/dummy.test.js"] },
      agentConfigured: false,
    });
    writeFile(tmp, "src/post-test-change.js", "export const changedAfterTests = true;\n");

    const res = runGate(tmp, [], "integration");
    assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.equal(env.data.result, "recovered");
    assert.equal(env.data.next, "test-execute");
    assert.equal(env.data.artifacts.evidenceRefresh.recovered, true);
    const manager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    assert.equal(manager.canonicalState(SPEC_ID).current.at(-1), "test-execute");
    assert.equal(manager.activityLedger(SPEC_ID).at(-1).transition.operation, "rewind_test_evidence");
  });

  it("integration requirement evaluation preserves a terminal agent failure", () => {
    tmp = createTmpDir();
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: `${BASE_TEST}// terminal agent failure evidence\n`,
      integrationTrustRequirementIds: ["R1"],
      fileMap: { R1: ["tests/dummy.test.js"] },
      stubScriptBody: [
        "process.stderr.write('HTTP 401 Unauthorized');",
        "process.exit(1);",
        "",
      ].join("\n"),
    });

    const res = runGate(tmp, [], "integration");

    assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.ok, false);
    assert.equal(
      env.errors[0].code,
      "AGENT_AUTHENTICATION_FAILED",
      `stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    assert.equal(env.data.artifacts.failureKind, "agent-evaluation");
    assert.equal(env.data.artifacts.failureCode, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(env.data.artifacts.retryable, false);
    assert.match(env.data.artifacts.recoveryHint, /authentication/i);
    assert.equal(env.data.artifacts.agentFailureKind, "authentication");
    assert.equal(env.data.artifacts.agentAttemptCount, 1);
    assert.equal(env.data.artifacts.agentMaxAttempts, 3);
    assert.equal(env.data.stepAttempt.outcome.kind, "external-blocked");
    assert.equal(env.data.stepAttempt.outcome.failureCode, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(env.data.stepAttempt.outcome.retryable, false);
    const manager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    const durableHistory = JSON.parse(manager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "impl.gate",
      consumerNodeId: "acceptance-review",
    }).bytes.toString("utf8"));
    const durableAttempt = durableHistory.attempts.at(-1)?.artifact?.payload;
    assert.ok(durableAttempt, "the terminal gate failure must be durable in the producer attempt history");
    assert.equal(durableAttempt.artifacts.failureCode, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(durableAttempt.artifacts.retryable, false);
  });

  it("integration requirement evaluation fails closed when no agent is configured", () => {
    tmp = createTmpDir();
    setupFixture(tmp, {
      initialTest: BASE_TEST,
      modifiedTest: `${BASE_TEST}// missing agent evidence\n`,
      integrationTrustRequirementIds: ["R1"],
      fileMap: { R1: ["tests/dummy.test.js"] },
      agentConfigured: false,
    });

    const res = runGate(tmp, [], "integration");

    assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    const env = parseEnvelope(res.stdout);
    assert.equal(env.ok, false);
    assert.equal(
      env.errors[0].code,
      "GATE_REQUIRED_AGENT_UNSET",
      `stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    assert.equal(env.data.artifacts.failureKind, "agent-unset");
    assert.equal(env.data.artifacts.retryable, false);
    assert.match(env.data.artifacts.recoveryHint, /Configure flow\.spec\.gate/i);
    assert.equal(env.data.stepAttempt.outcome.kind, "external-blocked");
    assert.equal(env.data.stepAttempt.outcome.failureCode, "GATE_REQUIRED_AGENT_UNSET");
    assert.equal(env.data.stepAttempt.outcome.retryable, false);
  });

});
