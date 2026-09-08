import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGuardrailTargetTextForPrompt,
  compactDiffForGuardrailPrompt,
  excludeGeneratedSpecArtifactsFromGateDiff,
  excludeGateLifecycleArtifactsFromGateDiff,
  excludeScenarioValidityEvidenceFromTaskGateDiff,
  PlanGateEvidenceTarget,
  default as RunGateCommand,
} from "../../../src/flow/lib/run-gate.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
  SourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { container } from "../../../src/lib/container.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";

function deletionOnlyDiff(file, removedBody) {
  return [
    `diff --git a/${file} b/${file}`,
    "deleted file mode 100644",
    "index 1111111..0000000",
    `--- a/${file}`,
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    ...removedBody.split("\n").map((line) => `-${line}`),
    "",
  ].join("\n");
}

function modifiedDiff(file) {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,4 @@",
    " const existing = true;",
    "+const addedGuardrailRelevantLine = true;",
    "",
  ].join("\n");
}

function specTestDiff(file, header, testNames) {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${testNames.length + 1} @@`,
    `+${header}`,
    ...testNames.map((name) => `+test(\"${name}\", () => {});`),
    "",
  ].join("\n");
}

describe("guardrail diff prompt compaction", () => {
  it("keeps added-line diffs and summarizes deletion-only file bodies", () => {
    const removedBody = Array.from({ length: 200 }, (_, i) => `removed line ${i}`).join("\n");
    const diff = deletionOnlyDiff("src/removed-plugin/large-template.md", removedBody)
      + modifiedDiff("src/flow/lib/run-gate.js");

    const compacted = compactDiffForGuardrailPrompt(diff, 1200);

    assert.ok(compacted.length <= 1200);
    assert.match(compacted, /diff compacted for guardrail prompt/);
    assert.match(compacted, /src\/removed-plugin\/large-template\.md: \+0 -200/);
    assert.match(compacted, /\+const addedGuardrailRelevantLine = true;/);
    assert.doesNotMatch(compacted, /removed line 199/);
  });

  it("bounds spec plus diff target text for integration guardrail calls", () => {
    const diff = deletionOnlyDiff(
      "src/removed-plugin/large-template.md",
      Array.from({ length: 300 }, (_, i) => `removed line ${i}`).join("\n"),
    ) + modifiedDiff("src/lib/include.js");

    const targetText = buildGuardrailTargetTextForPrompt("## Spec\n- R1: test", diff, 1400);

    assert.ok(targetText.length <= 1400);
    assert.match(targetText, /## Spec/);
    assert.match(targetText, /## Git Diff/);
    assert.match(targetText, /\+const addedGuardrailRelevantLine = true;/);
  });

  it("reserves bounded spec-local header and test declaration evidence", () => {
    const largeDiff = deletionOnlyDiff(
      "src/removed-plugin/large-template.md",
      Array.from({ length: 400 }, (_, i) => `removed line ${i}`).join("\n"),
    );
    const diff = largeDiff + specTestDiff(
      "specs/999-example/tests/review-regression.test.js",
      "// spec: R2 R9",
      [
        "R2: rejects stale target evidence",
        "R9: keeps advisory evidence after projection failure",
      ],
    );

    const targetText = buildGuardrailTargetTextForPrompt("## Spec\n- R2\n- R9", diff, 2_000);

    assert.ok(targetText.length <= 2_000);
    assert.match(targetText, /## Spec Test Header And Declaration Evidence/);
    assert.match(targetText, /review-regression\.test\.js: \/\/ spec: R2 R9/);
    assert.match(targetText, /R2: rejects stale target evidence/);
    assert.match(targetText, /R9: keeps advisory evidence after projection failure/);
  });
});

describe("task gate scenario-validity evidence", () => {
  it("excludes active Version artifacts while retaining implementation and foreign evidence", () => {
    const specDir = "specs/999-example/001";
    const preamble = "diagnostic preamble\n";
    const malformed = [
      "diff --git malformed-header",
      "+malformed content remains",
      "",
    ].join("\n");
    const quoted = [
      'diff --git "a/specs/999-example/001/steps/scenario-validity/output.log" "b/specs/999-example/001/steps/scenario-validity/output.log"',
      '--- "a/specs/999-example/001/steps/scenario-validity/output.log"',
      '+++ "b/specs/999-example/001/steps/scenario-validity/output.log"',
      "@@ -0,0 +1 @@",
      "+quoted path remains",
      "",
    ].join("\n");
    const special = modifiedDiff("specs/999-example/証拠-ß.json");
    const scenarioResult = modifiedDiff(`${specDir}/steps/scenario-validity/result.json`);
    const scenarioLog = modifiedDiff(`${specDir}/steps/scenario-validity/output.log`);
    const testExecuteResult = modifiedDiff(`${specDir}/steps/test-execute/result.json`);
    const testExecutionLog = modifiedDiff(`${specDir}/steps/test-execute/output.log`);
    const otherSpecScenario = modifiedDiff("specs/998-other/001/steps/scenario-validity/result.json");
    const implementation = modifiedDiff("src/flow/lib/review-convergence.js");
    const diff = [
      preamble,
      scenarioResult,
      malformed,
      scenarioLog,
      quoted,
      testExecuteResult,
      testExecutionLog,
      otherSpecScenario,
      special,
      implementation,
    ].join("");
    const expected = [
      preamble,
      malformed,
      quoted,
      otherSpecScenario,
      special,
      implementation,
    ].join("");

    const filtered = excludeScenarioValidityEvidenceFromTaskGateDiff(
      diff,
      `${specDir}/spec.json`,
    );

    assert.equal(filtered, expected);
    assert.doesNotMatch(filtered, new RegExp(`${specDir}/steps/test-execute/result\\.json`));
    assert.doesNotMatch(filtered, new RegExp(`${specDir}/steps/test-execute/output\\.log`));
    assert.match(filtered, /specs\/998-other\/001\/steps\/scenario-validity\/result\.json/);
    assert.match(filtered, /src\/flow\/lib\/review-convergence\.js/);
    assert.ok(filtered.startsWith(preamble));
    assert.match(filtered, /diff --git malformed-header\n\+malformed content remains/);
    assert.match(filtered, /diff --git "a\/specs\/999-example\/001\/steps\/scenario-validity\/output\.log"/);
    assert.match(filtered, /\+quoted path remains/);
    assert.match(filtered, /specs\/999-example\/証拠-ß\.json/);
    assert.ok(filtered.indexOf("malformed-header") < filtered.indexOf("quoted path remains"));
  });
});

describe("gate lifecycle evidence", () => {
  it("binds plan-gate retry identity to catalog descriptors, not root sibling files", () => {
    const draft = {
      logicalKey: "draft",
      relativePath: "steps/draft/result.json",
      hash: "a".repeat(64),
      activityId: "activity-draft-1",
    };
    const unrelated = {
      logicalKey: "test.execute",
      relativePath: "steps/test-execute/result.json",
      hash: "b".repeat(64),
      activityId: "activity-test-1",
    };
    const flowState = { schemaRevision: 3, specId: "999-example" };
    const resolve = (artifacts) => PlanGateEvidenceTarget.resolve({
      phase: "draft",
      flowState,
      flowManager: { artifactCatalog: () => ({ artifacts }) },
    }).fingerprint();

    assert.equal(resolve([draft]), resolve([draft, unrelated]));
    assert.notEqual(resolve([draft]), resolve([{ ...draft, hash: "c".repeat(64) }]));
    assert.throws(
      () => PlanGateEvidenceTarget.resolve({
        phase: "draft",
        flowState: { schemaRevision: 2, specId: "999-example" },
        flowManager: { artifactCatalog: () => ({ artifacts: [draft] }) },
      }),
      /Version-1 Flow artifact catalog/,
    );
  });

  it("excludes active Version artifacts while retaining product and cataloged test sources", () => {
    const specDir = "specs/999-example/001";
    const flowState = modifiedDiff(`${specDir}/flow.json`);
    const gateResult = modifiedDiff(`${specDir}/steps/impl/T-1/gate/result.json`);
    const testResult = modifiedDiff(`${specDir}/steps/test-execute/result.json`);
    const specTest = modifiedDiff(`${specDir}/artifacts/tests/review-scope.test.js`);
    const implementation = modifiedDiff("src/flow/lib/run-review.js");

    const filtered = excludeGateLifecycleArtifactsFromGateDiff(
      flowState + gateResult + testResult + specTest + implementation,
      `${specDir}/spec.json`,
    );

    assert.doesNotMatch(filtered, /flow\.json/);
    assert.doesNotMatch(filtered, /steps\/impl\/T-1\/gate\/result\.json/);
    assert.doesNotMatch(filtered, /steps\/test-execute\/result\.json/);
    assert.match(filtered, /artifacts\/tests\/review-scope\.test\.js/);
    assert.match(filtered, /src\/flow\/lib\/run-review\.js/);
  });

  it("excludes generated spec artifacts while retaining requirement tests", () => {
    const specDir = "specs/999-example/001";
    const result = modifiedDiff(`${specDir}/steps/test-execute/result.json`);
    const review = modifiedDiff(`${specDir}/steps/impl/review/result.json`);
    const specTest = modifiedDiff(`${specDir}/artifacts/tests/review-scope.test.js`);
    const implementation = modifiedDiff("src/flow/lib/run-review.js");

    const filtered = excludeGeneratedSpecArtifactsFromGateDiff(
      result + review + specTest + implementation,
      `${specDir}/spec.json`,
    );

    assert.doesNotMatch(filtered, /steps\/test-execute\/result\.json/);
    assert.doesNotMatch(filtered, /steps\/impl\/review\/result\.json/);
    assert.match(filtered, /artifacts\/tests\/review-scope\.test\.js/);
    assert.match(filtered, /src\/flow\/lib\/run-review\.js/);
  });
});

const TASK_GATE_SPEC_ID = "001-task-gate-evidence";

function setupTaskGateRepository(root) {
  writeJson(root, ".sennel/config.json", {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  });
  writeFile(root, "README.md", "task gate fixture\n");
  initGitRepo(root);
  commitAll(root, "initial fixture");
  const flowManager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: TASK_GATE_SPEC_ID,
    runId: "run-task-gate-evidence",
    request: "Validate task gate evidence.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: {
      goal: "Validate task gate evidence.",
      requirements: [{ id: "R-1", desc: "Task implementation evidence is evaluated.", task_ids: ["T-1"] }],
      acceptance_criteria: ["R-1 task evidence is checked."],
    },
  }).create().addTask({
    id: "T-1",
    title: "Validate task gate evidence",
    goal: "Evaluate implementation evidence without plan-phase runtime output.",
    test_strategy: "Run the task gate against implementation and test changes.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
  }).registerActive();
  fixture.settleBefore("scenario-validity").activate("scenario-validity", { settlePredecessors: false });
  commitAll(root, "record canonical pre-validation baseline");
  return { flowManager, fixture };
}

function advanceToTaskGate(flowManager, fixture, padding = "", mutateImplementation = null) {
  flowManager.publishCurrentAttemptResult({
    specId: TASK_GATE_SPEC_ID,
    commandResult: attachCanonicalCommandResultArtifact({ result: "pass" }, {
      logicalKey: "scenario.validity",
      payload: {
        version: "1",
        process: { started: true, exitCode: 1 },
        result: "pass",
        padding,
      },
    }),
  });
  fixture.settle("scenario-validity");
  fixture.settleBefore("T-1-impl");
  fixture.activateTask("T-1", { settlePredecessors: false });
  if (mutateImplementation === null) {
    fixture.settle("T-1-impl");
  } else {
    const state = flowManager.canonicalState(TASK_GATE_SPEC_ID);
    const baseline = SourceMutationBaseline.capture({ root: fixture.location().repositoryRoot, attempt: state.attempt });
    mutateImplementation();
    const manifest = SourceMutationManifest.capture({ baseline });
    flowManager.confirmSourceWorkerHandoff({
      specId: TASK_GATE_SPEC_ID,
      mutationManifest: manifest,
      handoffDigest: "e".repeat(64),
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: manifest.mutations.length === 0 ? [] : [{
          requirementId: "R-1",
          mutationIds: manifest.mutations.map((mutation) => mutation.mutationId),
        }],
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: null,
      }),
      result: { outcome: "passed", summary: "Task source captured.", confirmedAt: "2026-09-03T00:00:00.000Z", artifactRefs: [] },
    });
  }
  fixture.activate("T-1-review", { settlePredecessors: false });
  fixture.settle("T-1-review");
  fixture.settle("T-1-triage", "skipped");
  fixture.settle("T-1-repair", "skipped");
  fixture.activate("T-1-gate", { settlePredecessors: false });
}

async function executeTaskGate(root, flowManager, skipGuardrail = true) {
  return new RunGateCommand().execute({
    root,
    mainRoot: root,
    executionRoot: root,
    specId: TASK_GATE_SPEC_ID,
    phase: "task-impl",
    flowState: flowManager.loadReadOnly(TASK_GATE_SPEC_ID),
    flowManager,
    config: {},
    skipGuardrail,
  });
}

describe("task gate scenario-validity evidence through task scope", () => {
  let tmp;

  afterEach(() => {
    if (tmp) removeTmpDir(tmp);
    tmp = null;
  });

  it("rejects an explicitly invoked Task Gate when the Task has no source evidence", async () => {
    tmp = createTmpDir("task-gate-scenario-only-");
    const { flowManager, fixture } = setupTaskGateRepository(tmp);
    advanceToTaskGate(flowManager, fixture);

    const result = await executeTaskGate(tmp, flowManager);

    assert.equal(result.result, "fail");
    assert.ok(result.artifacts.issues.some((issue) => /source|change/i.test(issue)));
  });

  it("sizes and evaluates only implementation and post-fix evidence", async () => {
    tmp = createTmpDir("task-gate-filtered-size-");
    const { flowManager, fixture } = setupTaskGateRepository(tmp);
    advanceToTaskGate(flowManager, fixture, "x".repeat(1_100_000), () => {
      writeFile(tmp, "src/task-evidence.js", "export const taskEvidence = true;\n");
      writeFile(
        tmp,
        "tests/task-evidence.test.js",
        "// spec: R-1\n// post-fix tests pass\n",
      );
    });
    const scenario = flowManager.readArtifact({
      specId: TASK_GATE_SPEC_ID,
      logicalKey: "scenario.validity",
      consumerNodeId: "implement",
    });
    assert.ok(scenario.bytes.length > 1024 * 1024);

    let capturedPrompt = "";
    const originalGet = container.get.bind(container);
    container.get = (key) => {
      if (key !== "agent") return originalGet(key);
      return {
        resolve: (commandId) => commandId === "flow.spec.gate",
        call: async (prompt) => {
          capturedPrompt = prompt;
          return JSON.stringify({ observations: [] });
        },
      };
    };

    let result;
    try {
      result = await executeTaskGate(tmp, flowManager, false);
    } finally {
      container.get = originalGet;
    }

    assert.equal(result.result, "pass");
    assert.match(capturedPrompt, /src\/task-evidence\.js/);
    assert.match(capturedPrompt, /tests\/task-evidence\.test\.js/);
    assert.doesNotMatch(capturedPrompt, /steps\/scenario-validity\/result\.json/);
    assert.doesNotMatch(capturedPrompt, /"padding":"x+/);
  });
});
