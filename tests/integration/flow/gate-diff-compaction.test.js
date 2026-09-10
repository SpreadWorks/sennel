import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  buildGuardrailTargetTextForPrompt,
  buildPerRequirementDiffs,
  buildRequirementGateBatches,
  collectPerFileDiffsForGate,
  excludeGeneratedSpecArtifactsFromGateDiff,
  excludeGateLifecycleArtifactsFromGateDiff,
  excludeScenarioValidityEvidenceFromTaskGateDiff,
  PlanGateEvidenceTarget,
  planRequirementGateCalls,
  RequirementGateBatch,
  default as RunGateCommand,
} from "../../../src/flow/lib/run-gate.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import {
  CanonicalSourceRequirementAuthority,
} from "../../../src/flow/lib/canonical-file-map.js";
import { container } from "../../../src/lib/container.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
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

describe("guardrail complete prompt source", () => {
  it("keeps added-line diffs and complete deletion-only file bodies", () => {
    const removedBody = Array.from({ length: 200 }, (_, i) => `removed line ${i}`).join("\n");
    const diff = deletionOnlyDiff("src/removed-plugin/large-template.md", removedBody)
      + modifiedDiff("src/flow/lib/run-gate.js");

    const target = buildGuardrailTargetTextForPrompt("spec", diff);
    assert.ok(target.endsWith(diff));
    assert.match(target, /\+const addedGuardrailRelevantLine = true;/);
    assert.match(target, /removed line 199/);
  });

  it("preserves spec plus complete diff for shared batch planning", () => {
    const diff = deletionOnlyDiff(
      "src/removed-plugin/large-template.md",
      Array.from({ length: 300 }, (_, i) => `removed line ${i}`).join("\n"),
    ) + modifiedDiff("src/lib/include.js");

    const targetText = buildGuardrailTargetTextForPrompt("## Spec\n- R1: test", diff);

    assert.ok(targetText.endsWith(diff));
    assert.match(targetText, /## Spec/);
    assert.match(targetText, /## Git Diff/);
    assert.match(targetText, /\+const addedGuardrailRelevantLine = true;/);
  });

  it("retains spec-local header and test declarations alongside complete source", () => {
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

    const targetText = buildGuardrailTargetTextForPrompt("## Spec\n- R2\n- R9", diff);

    assert.ok(targetText.endsWith(diff));
    assert.match(targetText, /## Spec Test Header And Declaration Evidence/);
    assert.match(targetText, /review-regression\.test\.js: \/\/ spec: R2 R9/);
    assert.match(targetText, /R2: rejects stale target evidence/);
    assert.match(targetText, /R9: keeps advisory evidence after projection failure/);
  });
});

describe("requirement diff authority", () => {
  it("keeps shared and overlapping mapped files once for every related Requirement", () => {
    const shared = modifiedDiff("src/shared.js");
    const nested = modifiedDiff("src/nested/value.js");
    const unmapped = modifiedDiff("README.md");
    const perFileDiffs = new Map([
      ["src/shared.js", shared],
      ["src/nested/value.js", nested],
      ["README.md", unmapped],
    ]);
    const related = buildPerRequirementDiffs({
      "R-1": ["src", "src/shared.js"],
      "R-2": ["src/shared.js", "src/nested/value.js"],
    }, perFileDiffs, ["R-1", "R-2"], shared + nested + unmapped);

    assert.equal(related.get("R-1"), shared + nested + unmapped);
    assert.equal(related.get("R-2"), shared + nested + unmapped);
    assert.equal(related.get("R-1").match(/diff --git a\/src\/shared\.js/g)?.length, 1);
    assert.equal(related.get("R-2").match(/diff --git a\/src\/shared\.js/g)?.length, 1);
  });

  it("keeps the complete diff when file-level splitting yields no evidence", () => {
    const fullDiff = "unparsed but authoritative source evidence\n";
    const related = buildPerRequirementDiffs({
      "R-1": ["src/one.js"],
      "R-2": ["src/two.js"],
    }, new Map(), ["R-1", "R-2"], fullDiff);

    assert.equal(related.get("R-1"), fullDiff);
    assert.equal(related.get("R-2"), fullDiff);
  });

  it("retains mixed quoted and unparseable evidence without skipping a Requirement", () => {
    const ordinary = modifiedDiff("src/ordinary.js");
    const quoted = [
      'diff --git "a/src/tab\\tfile.js" "b/src/tab\\tfile.js"',
      '--- "a/src/tab\\tfile.js"',
      '+++ "b/src/tab\\tfile.js"',
      "@@ -1 +1 @@",
      "-before",
      "+quotedRequirementEvidence",
      "",
    ].join("\n");
    const unparseable = "diff --git malformed-header\n+unparseableEvidence\n";
    const diff = ordinary + quoted + unparseable;
    const perFileDiffs = collectPerFileDiffsForGate(diff, "", "");
    const related = buildPerRequirementDiffs({
      "R-1": ["src/ordinary.js"],
      "R-2": ["src/tab\tfile.js"],
      "R-3": ["src/not-present.js"],
    }, perFileDiffs, ["R-1", "R-2", "R-3"], diff);
    const plan = planRequirementGateCalls({
      phase: "task-impl",
      requirements: [
        { id: "R-1", desc: "ordinary evidence" },
        { id: "R-2", desc: "quoted evidence" },
        { id: "R-3", desc: "unparseable evidence" },
      ],
      relatedDiffs: related,
    });

    assert.deepEqual([...perFileDiffs.keys()], ["src/ordinary.js", "src/tab\tfile.js"]);
    assert.equal(perFileDiffs.unparsedSegments.length, 1);
    assert.match(related.get("R-2"), /quotedRequirementEvidence/);
    assert.match(related.get("R-3"), /unparseableEvidence/);
    assert.deepEqual(plan.evaluations, []);
  });

  it("maps actual Git output with spaces, tabs, and escaped Unicode paths", () => {
    const root = createTmpDir("gate-diff-git-paths-");
    const paths = [
      "src/ordinary.js",
      "src/space name.js",
      "src/tab\tfile.js",
      "src/証拠-ß.js",
      "src/a b/nested.js",
    ];
    try {
      for (const file of paths) writeFile(root, file, "before\n");
      initGitRepo(root);
      commitAll(root, "initial paths");
      for (const file of paths) writeFile(root, file, `after ${file}\n`);
      const diff = execFileSync("git", ["diff", "--no-color", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });
      const perFileDiffs = collectPerFileDiffsForGate(diff, "", "");
      const related = buildPerRequirementDiffs({
        "R-1": paths.slice(0, 3),
        "R-2": paths.slice(3),
      }, perFileDiffs, ["R-1", "R-2"], diff);
      const plan = planRequirementGateCalls({
        phase: "task-impl",
        requirements: [
          { id: "R-1", desc: "first group" },
          { id: "R-2", desc: "second group" },
        ],
        relatedDiffs: related,
      });

      assert.deepEqual([...perFileDiffs.keys()].sort(), [...paths].sort());
      assert.equal(perFileDiffs.unparsedSegments.length, 0);
      assert.match(related.get("R-1"), /after src\/tab\tfile\.js/);
      assert.match(related.get("R-1"), /after src\/space name\.js/);
      assert.match(related.get("R-2"), /after src\/証拠-ß\.js/);
      assert.match(related.get("R-2"), /after src\/a b\/nested\.js/);
      assert.deepEqual(plan.evaluations, []);
      assert.equal(plan.calls.length, 2);
    } finally {
      removeTmpDir(root);
    }
  });

  it("keeps one rename or deletion segment for every Requirement mapped to its path", () => {
    const root = createTmpDir("gate-diff-git-rename-");
    try {
      writeFile(root, "src/old name.js", "stable line\nbefore\n");
      writeFile(root, "src/deleted.js", "before delete\n");
      initGitRepo(root);
      commitAll(root, "initial sources");
      execFileSync("git", ["mv", "src/old name.js", "src/new name.js"], { cwd: root });
      execFileSync("git", ["rm", "src/deleted.js"], { cwd: root });
      const diff = execFileSync("git", ["diff", "--cached", "--no-color", "-M"], {
        cwd: root,
        encoding: "utf8",
      });
      const perFileDiffs = collectPerFileDiffsForGate(diff, "", "");
      const related = buildPerRequirementDiffs({
        "R-1": ["src/old name.js"],
        "R-2": ["src/new name.js"],
        "R-3": ["src/deleted.js"],
      }, perFileDiffs, ["R-1", "R-2", "R-3"], diff);
      const plan = planRequirementGateCalls({
        phase: "task-impl",
        requirements: [
          { id: "R-1", desc: "rename source" },
          { id: "R-2", desc: "rename destination" },
          { id: "R-3", desc: "deletion source" },
        ],
        relatedDiffs: related,
      });

      assert.match(related.get("R-1"), /rename from src\/old name\.js/);
      assert.match(related.get("R-2"), /rename to src\/new name\.js/);
      assert.match(related.get("R-3"), /before delete/);
      assert.equal(related.get("R-1").match(/^diff --git /gm)?.length, 1);
      assert.equal(related.get("R-2").match(/^diff --git /gm)?.length, 1);
      assert.deepEqual(plan.evaluations, []);
    } finally {
      removeTmpDir(root);
    }
  });

  it("retains the complete unparseable source for batch planning", () => {
    const malformed = "diff --git malformed-header\n+unparseableEvidence\n";
    const source = `${modifiedDiff("src/a.js")}${malformed}${"x".repeat(2_000)}`;
    const target = buildGuardrailTargetTextForPrompt("spec", source);
    assert.ok(target.endsWith(source));
  });

  it("counts one compact shared source scope when splitting Requirement batches", () => {
    const requirements = [
      { id: "R-1", desc: "x".repeat(80) },
      { id: "R-2", desc: "y".repeat(80) },
    ];
    const diff = "+shared evidence\n";
    const authority = CanonicalSourceRequirementAuthority.fromTaskRequirements(requirements);
    const sourceScope = authority.bindSourceScope([`src/${"z".repeat(180)}.js`]);
    const one = new RequirementGateBatch({ requirements: [requirements[0]], diff, sourceScope });
    const two = new RequirementGateBatch({ requirements, diff, sourceScope });
    const maxChars = Math.floor((one.promptCharCount + two.promptCharCount) / 2);
    const batches = buildRequirementGateBatches({
      requirements,
      relatedDiffs: new Map(requirements.map((requirement) => [requirement.id, diff])),
      maxChars,
      sourceScope,
    });

    assert.equal(batches.length, 2);
    assert.ok(batches.every((batch) => batch.promptCharCount <= maxChars));
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
    assert.doesNotMatch(filtered, /quoted path remains/);
    assert.match(filtered, /specs\/999-example\/証拠-ß\.json/);
    assert.ok(filtered.indexOf("malformed-header") >= 0);
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

function setupTaskGateRepository(root, {
  requirements = [{ id: "R-1", desc: "Task implementation evidence is evaluated.", task_ids: ["T-1"] }],
} = {}) {
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
      requirements,
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
    completeCanonicalSourceHandoff({
      root: fixture.location().repositoryRoot, manager: flowManager,
      specId: TASK_GATE_SPEC_ID, stepId: "task-impl", taskId: "T-1",
      mutate: mutateImplementation,
      effect: {
        version: 1, stepId: "task-impl", completionStatus: "done", issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null, repair: null, noChangeReason: null,
      },
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
        call: async (prompt, options) => {
          capturedPrompt = prompt;
          if (Object.hasOwn(options.jsonSchema.properties, "evaluations")) {
            return JSON.stringify({
              evaluations: [{
                guardrail_id: "R-1",
                result: "pass",
                reason: "[REQ:R-1] current Task source supplies the required evidence.",
              }],
            });
          }
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

  it("evaluates every current Task source file against all mapped Requirements in one call", async () => {
    tmp = createTmpDir("task-gate-complete-source-scope-");
    const requirements = [
      { id: "R-1", desc: "Provide the first Task behavior.", task_ids: ["T-1"] },
      { id: "R-2", desc: "Provide the second Task behavior.", task_ids: ["T-1"] },
    ];
    const { flowManager, fixture } = setupTaskGateRepository(tmp, { requirements });
    advanceToTaskGate(flowManager, fixture, "", () => {
      writeFile(tmp, "src/shared.js", "export const sharedScopeEvidence = true;\n");
      writeFile(tmp, "src/secondary.js", "export const secondaryScopeEvidence = true;");
    });

    const prompts = [];
    const originalGet = container.get.bind(container);
    container.get = (key) => {
      if (key !== "agent") return originalGet(key);
      return {
        resolve: (commandId) => commandId === "flow.spec.gate",
        call: async (prompt, options) => {
          prompts.push(prompt);
          const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
          return JSON.stringify({
            evaluations: ids.map((id) => ({
              guardrail_id: id,
              result: "pass",
              reason: `[REQ:${id}] both current Task source files were evaluated.`,
            })),
          });
        },
      };
    };

    let result;
    try {
      result = await executeTaskGate(tmp, flowManager, true);
    } finally {
      container.get = originalGet;
    }

    assert.equal(result.result, "pass");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /R-1/);
    assert.match(prompts[0], /R-2/);
    assert.equal(prompts[0].match(/sharedScopeEvidence/g)?.length, 1);
    assert.equal(prompts[0].match(/secondaryScopeEvidence/g)?.length, 1);
    assert.match(prompts[0], /secondaryScopeEvidence = true;\n\n## src\/shared\.js/);
    assert.deepEqual(result.artifacts.evaluations.map((entry) => entry.guardrail_id).sort(), ["R-1", "R-2"]);
  });

  it("persists a tooling failure without partial judgments after a later source batch fails", async () => {
    tmp = createTmpDir("task-gate-partial-batch-");
    const { flowManager, fixture } = setupTaskGateRepository(tmp);
    advanceToTaskGate(flowManager, fixture, "", () => {
      writeFile(tmp, "src/oversized.js", "x".repeat(133_813));
    });
    let calls = 0;
    const originalGet = container.get.bind(container);
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => ({ provider: "fixture" }),
      call: async (prompt, options) => {
        calls += 1;
        assert.ok(options.jsonSchema.properties.observations, "final judgment must not run");
        if (calls > 1) return "invalid provider JSON";
        const ranges = JSON.parse(prompt.split("## Canonical input ranges\n")[1]);
        return JSON.stringify({ observations: ranges.map((range) => ({
          requirementId: "R-1", sourceRef: range.sourceRef,
          support: [], contradictions: [], unresolved: [],
        })) });
      },
    };
    let result;
    try {
      result = await executeTaskGate(tmp, flowManager, true);
    } finally {
      container.get = originalGet;
    }
    assert.equal(result.result, "fail");
    assert.equal(calls, 3);
    assert.deepEqual(result.artifacts.evaluations, []);
    flowManager.publishCurrentAttemptResult({ specId: TASK_GATE_SPEC_ID, commandResult: result });
    const reloaded = makeFlowManager(tmp);
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded, flowState: reloaded.loadReadOnly(TASK_GATE_SPEC_ID), phase: "task-impl", root: tmp,
    });
    assert.equal(facts.result, "fail");
    assert.equal(facts.failure.category, "tooling");
  });

  it("evaluates all 133,813 source characters before a single final Task Gate judgment", async () => {
    tmp = createTmpDir("task-gate-oversized-source-");
    const { flowManager, fixture } = setupTaskGateRepository(tmp);
    advanceToTaskGate(flowManager, fixture, "", () => {
      const source = `// HEAD_EVIDENCE\n${"x".repeat(66_800)}\n// MIDDLE_EVIDENCE\n`;
      writeFile(tmp, "src/oversized.js", `${source}${"x".repeat(133_813 - source.length - "\n// TAIL_EVIDENCE\n".length)}\n// TAIL_EVIDENCE\n`);
    });

    let calls = 0;
    let sourceCalls = 0;
    let finalCalls = 0;
    const capturedRanges = [];
    const originalGet = container.get.bind(container);
    container.get = (key) => {
      if (key !== "agent") return originalGet(key);
      return {
        resolve: () => ({ provider: "fixture" }),
        call: async (prompt, options) => {
          calls += 1;
          assert.ok(prompt.length + (options.systemPrompt || "").length
            + JSON.stringify(options.jsonSchema).length + (options.fmtFallback || "").length <= 120_000);
          if (options.jsonSchema.properties.observations) {
            sourceCalls += 1;
            const ranges = JSON.parse(prompt.split("## Canonical input ranges\n")[1]);
            capturedRanges.push(...ranges.filter((range) => range.sourceRef.includes(":source")));
            return JSON.stringify({ observations: ranges.map((range) => ({
              requirementId: "R-1", sourceRef: range.sourceRef,
              support: ["HEAD_EVIDENCE", "MIDDLE_EVIDENCE", "TAIL_EVIDENCE"].filter((marker) => range.content.includes(marker)),
              contradictions: [], unresolved: [],
            })) });
          }
          finalCalls += 1;
          assert.ok(sourceCalls > 1);
          for (const marker of ["HEAD_EVIDENCE", "MIDDLE_EVIDENCE", "TAIL_EVIDENCE"]) assert.ok(prompt.includes(marker));
          return JSON.stringify({ evaluations: [{ guardrail_id: "R-1", result: "pass", reason: "[REQ:R-1] all source evidence is present." }] });
        },
      };
    };
    let result;
    try {
      result = await executeTaskGate(tmp, flowManager, true);
    } finally {
      container.get = originalGet;
    }

    assert.equal(result.result, "pass", JSON.stringify(result.artifacts));
    assert.ok(calls >= 3);
    assert.equal(finalCalls, 1);
    const source = capturedRanges.map((range) => range.content).join("");
    assert.equal(source.match(/HEAD_EVIDENCE/g)?.length, 1);
    assert.equal(source.match(/MIDDLE_EVIDENCE/g)?.length, 1);
    assert.equal(source.match(/TAIL_EVIDENCE/g)?.length, 1);
    flowManager.publishCurrentAttemptResult({ specId: TASK_GATE_SPEC_ID, commandResult: result });
    const reloaded = makeFlowManager(tmp);
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded, flowState: reloaded.loadReadOnly(TASK_GATE_SPEC_ID), phase: "task-impl", root: tmp,
    });
    assert.equal(facts.result, "pass");
  });
});
