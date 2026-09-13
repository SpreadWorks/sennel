import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import RunAcceptanceReviewCommand, { AcceptanceReviewResponseSource } from "../../../src/flow/lib/run-acceptance-review.js";
import RunRetroCommand from "../../../src/flow/lib/run-retro.js";
import RunTestExecuteCommand from "../../../src/flow/lib/run-test-execute.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { container } from "../../../src/lib/container.js";
import { attachedCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { RequirementTestArtifactStore } from "../../../src/flow/lib/requirement-test-store.js";
import {
  FlowAtStepFixture,
  makeFlowManager,
  removeCatalogedArtifactForCorruptionFixture,
  promoteCanonicalRequirementTest,
} from "../../support/infrastructure/flow-setup.js";

const roots = [];

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-requirement-downstream-"));
  roots.push(root);
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "checkout", "-b", "main"], { stdio: "ignore" });
  return root;
}

function context(value) {
  return {
    root: value.root,
    mainRoot: value.root,
    executionRoot: value.root,
    specId: value.specId,
    phase: value.phase,
    flowManager: value.flowManager,
    flowState: value.flowManager.loadReadOnly(value.specId),
    config: {},
  };
}

class AcceptanceFixtureResponse extends AcceptanceReviewResponseSource {
  load(input) {
    const summary = input.evidence.testEvidence["test-execute-result.json"].summary;
    assert.equal(summary.find((entry) => entry.id === "R1").execution, "executed");
    assert.equal(summary.find((entry) => entry.id === "R2").execution, "deferred_no_active_test");
    return {
      requirementJudgments: input.evidence.requirements.map((requirement) => ({
        requirementId: requirement.id,
        status: requirement.id === "R1" ? "met" : "notVerifiable",
        requestRefs: ["flow.request"],
        requirementRefs: [`spec.json#${requirement.id}`],
        diffRefs: ["diff:README.md"],
        repairRefs: ["acceptance:no-repair"],
        testRefs: requirement.id === "R1" ? [`test-execute-result.json#${requirement.id}`] : [],
        missingEvidence: requirement.id === "R1" ? [] : ["Requirement test was deferred without an active test source."],
      })),
      deferredFindingDispositions: [],
    };
  }
}

function toolingReviewResult(flowManager, specId) {
  const state = flowManager.canonicalState(specId);
  const store = new RequirementTestArtifactStore({ flowManager, state });
  const item = store.readPlan("test-review").artifact.plan.activeWorkItem();
  const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-review" }).candidate;
  const finding = {
    findingId: `${item.requirementId}-tooling-review`,
    fingerprint: "e".repeat(64),
    requirementId: item.requirementId,
    category: "tooling_failure",
    reason: "fixture review provider unavailable",
  };
  const payload = {
    version: 1,
    phase: "test",
    requirementId: item.requirementId,
    specRevision: item.specRevision.toJSON(),
    bundleRevision: item.bundleRevision.revision,
    candidateDigest: candidate.digest,
    sourceAttempt: item.bundleRevision.lineage.sourceAttempt.toJSON(),
    toolingOutcome: { reason: finding.reason },
    blockingFindings: [finding],
    advisoryFindings: [],
  };
  const result = { result: "tooling-error", artifacts: { phase: "test", toolingOutcome: payload.toolingOutcome } };
  attachCanonicalCommandResultArtifact(result, { logicalKey: "test.requirement.review", payload });
  return result;
}

async function buildMixedFlow() {
  // Direct command execution still uses the same initialized service boundary
  // as CLI dispatch. Keep this scenario's container local to its test process.
  container.register("config", {});
  const root = createRepository();
  const flowManager = makeFlowManager(root);
  const specId = "001-mixed-requirements";
  const fixture = new FlowAtStepFixture({
    flowManager,
    specId,
    runId: "run-mixed-requirements",
    request: "Verify mixed active and deferred Requirement evidence downstream.",
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/mixed-requirements" },
    specRecord: {
      goal: "mixed downstream evidence",
      requirements: [
        { id: "R1", desc: "active Requirement", task_ids: ["T1"], preimplementation_test_expectation: "fail" },
        { id: "R2", desc: "deferred Requirement", task_ids: ["T1"], preimplementation_test_expectation: "fail" },
      ],
    },
    taskDocuments: [
      { id: "T1", title: "active", goal: "active", origin: "plan", added_round: 0, status: "pending" },
    ],
    targetStep: "approval",
  }).create();
  fixture.flow.flow.settle("approval");

  promoteCanonicalRequirementTest({
    flowManager,
    specId,
    requirementId: "R1",
    testPath: "r1.test.js",
    completion: "generate",
    source: "// spec: R1\nimport test from 'node:test';\ntest('R1: active', () => {});\n",
  });
  promoteCanonicalRequirementTest({
    flowManager,
    specId,
    requirementId: "R2",
    testPath: "r2.test.js",
    completion: "generate",
    source: "// spec: R2\nimport test from 'node:test';\ntest('R2: deferred', () => {});\n",
  });
  let currentManager = flowManager;
  // R1 is the first staged review frontier after generation has completed for
  // both Requirements. Resume it through the typed review/Gate connector.
  promoteCanonicalRequirementTest({
    flowManager: currentManager,
    specId,
    requirementId: "R1",
    completion: "gate",
    resumeStaged: true,
  });
  currentManager = makeFlowManager(root);
  assert.equal(currentManager.canonicalState(specId).current.at(-1), "test-review");
  // R2 remains staged and is now the next review frontier. Its tooling
  // exhaustion is intentionally applied after R1 promotion.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reviewContext = {
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      phase: "test-review",
      flowManager: currentManager,
      flowState: currentManager.loadReadOnly(specId),
    };
    const reviewResult = toolingReviewResult(currentManager, specId);
    await FLOW_COMMANDS.run.review.post(reviewContext, reviewResult);
    currentManager = makeFlowManager(root);
  }
  fixture.flow.flow.flowManager = currentManager;
  assert.equal(currentManager.canonicalState(specId).current.at(-1), "implement");
  fixture.flow.flow.activate("test-execute");

  fs.mkdirSync(path.join(root, ".sennel", "output"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "output", "analysis.json"), "{}\n");
  return { root, flowManager: currentManager, specId, fixture };
}

afterEach(() => {
  container.reset();
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("mixed active/deferred Requirement downstream lifecycle", () => {
  it("executes only promoted tests, carries deferred evidence through retro, and keeps acceptance non-successful", async () => {
    const value = await buildMixedFlow();
    const selected = [];
    const execution = await new RunTestExecuteCommand({
      runSpecLocal: async ({ files, testNamePattern }) => {
        selected.push({ files: files.map((file) => path.relative(value.root, file)), testNamePattern });
        return {
          command: "node --test tests/r1.test.js",
          noTestsDeclared: false,
          result: {
            started: true,
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: null,
            stdout: "TAP version 13\nok 1 - R1: active\n1..1\n",
            stderr: "",
          },
        };
      },
    }).execute(context({ ...value, phase: "test-execute" }));
    const executionPayload = attachedCanonicalCommandResultArtifact(execution).payload;
    assert.deepEqual(executionPayload.summary.map((entry) => ({ id: entry.id, execution: entry.execution, result: entry.result })), [
      { id: "R1", execution: "executed", result: "pass" },
      { id: "R2", execution: "deferred_no_active_test", result: "deferred" },
    ]);
    assert.deepEqual(selected[0].files, ["specs/001-mixed-requirements/001/artifacts/tests/r1.test.js"]);
    assert.match(selected[0].testNamePattern, /R1/);
    assert.doesNotMatch(selected[0].testNamePattern, /R2/);

    const executeContext = context({ ...value, phase: "test-execute" });
    await FLOW_COMMANDS.run["test-execute"].post(executeContext, execution);
    value.flowManager.updateStepStatus({ stepId: "test-result-review", requestedStatus: "in_progress" }, { specId: value.specId });
    const reviewContext = context({ ...value, phase: "test-result-review" });
    const review = await new RunTestResultReviewCommand().execute(reviewContext);
    assert.equal(attachedCanonicalCommandResultArtifact(review).payload.verdict, "pass");
    await FLOW_COMMANDS.run["test-result-review"].post(reviewContext, review);

    value.fixture.flow.flow.activate("retro");
    const retroContext = context({ ...value, phase: "retro" });
    const retro = await new RunRetroCommand().execute(retroContext);
    assert.equal(retro.artifacts.summary.done, 1);
    assert.equal(retro.artifacts.summary.deferred_count, 1);
    assert.equal(retro.artifacts.requirements.find((entry) => entry.desc === "deferred Requirement").status, "deferred");
    const retroPublication = await new RunRetroCommand().execute(retroContext);
    await FLOW_COMMANDS.run.retro.post(retroContext, retroPublication);

    // Acceptance needs a real implementation diff before it can classify an
    // otherwise fully evidenced Requirement as met.
    fs.writeFileSync(path.join(value.root, "README.md"), "implemented\n");
    value.fixture.flow.flow.activate("acceptance-review");
    const acceptanceContext = context({ ...value, phase: "acceptance-review" });
    const acceptance = await new RunAcceptanceReviewCommand({ responseSource: new AcceptanceFixtureResponse() }).execute(acceptanceContext);
    const acceptancePayload = attachedCanonicalCommandResultArtifact(acceptance).payload;
    assert.equal(
      acceptancePayload.verdict,
      "user_decision_required",
      JSON.stringify(acceptancePayload.mechanicalBlockers),
    );
    assert.equal(acceptancePayload.requirementJudgments.find((entry) => entry.requirementId === "R1").status, "met");
    assert.equal(acceptancePayload.requirementJudgments.find((entry) => entry.requirementId === "R2").status, "notVerifiable");
    assert.match(acceptancePayload.requirementJudgments.find((entry) => entry.requirementId === "R2").missingEvidence[0], /deferred/i);
  });

  it("fails closed when the deferred Requirement receipt is missing", async () => {
    const value = await buildMixedFlow();
    removeCatalogedArtifactForCorruptionFixture(
      value.flowManager,
      value.specId,
      "test.requirement.deferred",
      { requirementId: "R2" },
    );
    await assert.rejects(
      () => new RunTestExecuteCommand({ runSpecLocal: async () => ({
        command: "node --test",
        noTestsDeclared: true,
        result: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null, stdout: "", stderr: "" },
      }) }).execute(context({ ...value, phase: "test-execute" })),
      /deferred receipt is missing or stale/,
    );
  });
});
