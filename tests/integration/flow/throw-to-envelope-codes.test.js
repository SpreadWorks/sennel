import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  CanonicalFlowFixture,
  makeFlowManager,
  removeCatalogedArtifactForCorruptionFixture,
} from "../../support/infrastructure/flow-setup.js";
import { writeStubAgentScript, stubAgentConfig } from "../../support/fakes/stub-agent.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";

const SENNEL = path.resolve("src/sennel.js");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lowAutoCheckResponse() {
  return JSON.stringify({
    specBuildability: 1,
    ambiguity: 0,
    verifiability: 1,
    scopeBoundedness: 1,
    targetSpecificity: 0,
    precedent: 0,
    goal: "test goal",
    reason: "stub low",
  });
}

function createTmpProject(agentResponse) {
  const tmp = createTestDirectory("throw-env-");
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "specs", "001-test"), { recursive: true });
  execFileSync("git", ["init", tmp], { stdio: "ignore" });
  execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });

  const stubPath = agentResponse
    ? writeStubAgentScript(tmp, ".stub-agent.js", agentResponse)
    : null;
  fs.writeFileSync(
    path.join(tmp, ".sennel", "config.json"),
    JSON.stringify({
      lang: "ja",
      type: "base",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      ...(stubPath ? { agent: stubAgentConfig(stubPath) } : {}),
    }),
  );
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));
  return tmp;
}

function createFlowState(tmp, extra = {}) {
  const { requirements = [], activeStep = null, ...unsupported } = extra;
  const fields = Object.keys(unsupported);
  if (fields.length > 0) {
    throw new Error(`createFlowState accepts only canonical Spec requirements: ${fields.join(", ")}`);
  }
  const canonicalRequirements = requirements.length === 0
    ? [{ id: "R-T-1", desc: "Exercise the canonical command envelope.", task_ids: ["T-1"] }]
    : requirements.map((requirement) => ({
      ...requirement,
      task_ids: requirement.task_ids ?? ["T-1"],
    }));
  const manager = makeFlowManager(tmp);
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "001-test",
    runId: "run-001-test",
    request: "add a progress bar",
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    specRecord: { goal: "x", requirements: canonicalRequirements },
  }).create().addTask({
    id: "T-1",
    title: "x",
    goal: "x",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
  });
  if (activeStep !== null) fixture.activate(activeStep);
  return fixture.registerActive().state();
}

function run(tmp, argv) {
  return spawnSync("node", [SENNEL, ...argv], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

function parseEnvelope(res) {
  return JSON.parse(res.stdout.trim());
}

// ---------------------------------------------------------------------------
// R1a: AUTO_CHECK_INELIGIBLE
// ---------------------------------------------------------------------------

describe("R1a: set auto on → AUTO_CHECK_INELIGIBLE on reject", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns ok:false envelope with code AUTO_CHECK_INELIGIBLE and score data", () => {
    tmp = createTmpProject(lowAutoCheckResponse());
    createFlowState(tmp);
    const res = run(tmp, ["flow", "set", "auto", "on"]);
    assert.notEqual(res.status, 0);
    const env = parseEnvelope(res);
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "AUTO_CHECK_INELIGIBLE");
    // data should carry judgment evidence
    assert.ok(env.data, "envelope.data must be present");
    assert.equal(typeof env.data.score, "number");
    assert.equal(typeof env.data.maxScore, "number");
    assert.equal(typeof env.data.threshold, "number");
    assert.ok(env.data.breakdown, "data.breakdown must be present");
  });
});

// ---------------------------------------------------------------------------
// R2a/R2b: canonical retro input preconditions
// ---------------------------------------------------------------------------

/** Publish one producer-owned canonical attempts[] artifact for this scenario. */
function publishCanonicalAttemptArtifact(tmp, { nodeId, logicalKey, payload }) {
  const manager = makeFlowManager(tmp);
  const state = manager.load();
  const history = new FlowArtifactAttemptHistory([
    new FlowArtifactAttemptRecord({
      attempt: 1,
      payload: {
        nodeId,
        outcome: "completed",
        result: { result: "ok" },
        artifact: { logicalKey, payload },
      },
    }),
  ]);
  manager.publishArtifacts({
    specId: state.specId,
    nodeId,
    artifactWrites: [{
      logicalKey,
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(history.toJSON(), null, 2)}\n`, "utf8"),
    }],
  });
}

describe("R2: run retro → upstream-artifact preconditions (spec 251)", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it("R2a: returns TEST_RESULT_REVIEW_MISSING when test-result-review.json is absent", () => {
    tmp = createTmpProject();
    createFlowState(tmp, {
      requirements: [{ id: "R1", desc: "x", priority: "must" }],
    });
    // No upstream artifact prepared → retro must refuse to aggregate.
    const res = run(tmp, ["flow", "run", "retro"]);
    assert.notEqual(res.status, 0);
    const env = parseEnvelope(res);
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "TEST_RESULT_REVIEW_MISSING");
    assert.ok(
      env.errors[0].messages.some((m) => /test-result-review/i.test(m)),
      "messages should reference test-result-review",
    );
  });

  it("R2b: returns TEST_EXECUTE_RESULT_MISSING when only test-result-review.json exists", () => {
    tmp = createTmpProject();
    createFlowState(tmp, {
      requirements: [{ id: "R1", desc: "x", priority: "must" }],
      activeStep: "test-result-review",
    });
    const manager = makeFlowManager(tmp);
    const location = manager.specLocation("001-test");
    publishCanonicalAttemptArtifact(tmp, {
      nodeId: "test-result-review",
      logicalKey: "test.result.review",
      payload: {
        verdict: "pass",
        checked_items: [{ check: "project_regression_verification", result: "pass" }],
        result_file_path: location.relativeArtifact("test.execute"),
        raw_output_path: location.relativeArtifact("test.execute.raw-log"),
      },
    });
    removeCatalogedArtifactForCorruptionFixture(manager, "001-test", "test.execute");
    const res = run(tmp, ["flow", "run", "retro"]);
    assert.notEqual(res.status, 0);
    const env = parseEnvelope(res);
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "TEST_EXECUTE_RESULT_MISSING");
    assert.ok(
      env.errors[0].messages.some((m) => /test-execute/i.test(m)),
      "messages should reference test-execute",
    );
  });
});

// ---------------------------------------------------------------------------
// R3: CLI argument validation codes
// ---------------------------------------------------------------------------

describe("R3: flow set argument validation → structured codes (table-driven)", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  const CASES = [
    { name: "set step with missing args", argv: ["flow", "set", "step"], code: "INVALID_USAGE" },
    { name: "set step with invalid status", argv: ["flow", "set", "step", "draft", "bogus-status"], code: "INVALID_STATUS" },
    { name: "set issue with missing arg", argv: ["flow", "set", "issue"], code: "INVALID_USAGE" },
    { name: "set issue with non-number", argv: ["flow", "set", "issue", "abc"], code: "INVALID_ARG_VALUE" },
    { name: "set note with no text", argv: ["flow", "set", "note"], code: "INVALID_USAGE" },
    { name: "set request with no text", argv: ["flow", "set", "request"], code: "INVALID_USAGE" },
    { name: "set metric with missing args", argv: ["flow", "set", "metric"], code: "INVALID_USAGE" },
    { name: "set metric with invalid phase", argv: ["flow", "set", "metric", "bogus-phase", "docsRead"], code: "INVALID_PHASE" },
    { name: "set metric with invalid counter", argv: ["flow", "set", "metric", "draft", "bogus-counter"], code: "INVALID_ARG_VALUE" },
    { name: "set auto with no argument", argv: ["flow", "set", "auto"], code: "INVALID_USAGE" },
    { name: "set issue-log without required fields", argv: ["flow", "set", "issue-log"], code: "INVALID_USAGE" },
  ];

  for (const { name, argv, code } of CASES) {
    it(`${name} → ${code}`, () => {
      tmp = createTmpProject();
      createFlowState(tmp);
      const res = run(tmp, argv);
      assert.notEqual(res.status, 0, `expected non-zero exit for ${argv.join(" ")}`);
      const env = parseEnvelope(res);
      assert.equal(env.ok, false);
      assert.equal(
        env.errors[0].code,
        code,
        `argv=${argv.join(" ")} expected code ${code}, got ${env.errors[0].code}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// R4: analyze classification-A throws remain unchanged (smoke / regression)
// ---------------------------------------------------------------------------

describe("R4: classification-A throws still propagate as errors", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it("set init with invalid --issue still returns ok:false (code stays structured)", () => {
    tmp = createTmpProject();
    // set init is a preparing-flow command; missing flow is expected
    const res = run(tmp, ["flow", "set", "init", "--issue", "abc"]);
    assert.notEqual(res.status, 0);
    const env = parseEnvelope(res);
    assert.equal(env.ok, false);
    // This particular throw is D (arg validation), not A — expectation: INVALID_ARG_VALUE
    assert.equal(env.errors[0].code, "INVALID_ARG_VALUE");
  });
});
