import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { checkSpecText, checkSpecJson } from "../../../../src/flow/lib/run-gate.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";
import { execFileSync, spawnSync } from "child_process";
import { CanonicalFlowFixture, makeFlowManager } from "../../../support/infrastructure/flow-setup.js";
import { findInProgressLeaf } from "../../../../src/flow/lib/step-tree.js";
import { commitAll, initGitRepo } from "../../../support/infrastructure/git-repo.js";

const SENNEL = join(process.cwd(), "src/sennel.js");

function initGateProject(tmp, { specId = "001-test", specRecord = null } = {}) {
  initGitRepo(tmp);
  commitAll(tmp, "init");
  const taskDocuments = specRecord?.tasks ?? [];
  const fixture = new CanonicalFlowFixture({
    flowManager: makeFlowManager(tmp),
    specId,
    execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${specId}` },
    specRecord: specRecord ? { ...specRecord, tasks: [] } : null,
  }).create().addTasks(taskDocuments).registerActive().activate("spec-gate");
  writeJson(tmp, ".sennel/config.json", {
    lang: "en", type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    agent: {
      default: "stub",
      providers: {
        stub: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('{\"observations\":[]}')"],
        },
      },
    },
  });
  return fixture;
}

function runLocallyBlockedGate(tmp, args) {
  const result = spawnSync(process.execPath, [SENNEL, "flow", "run", "gate", ...args], {
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.ok(envelope.errors.some((error) => error.code === "GATE_LOCAL_INPUT_INVALID"));
  assert.equal(envelope.data.artifacts.gateTransitionFailureCategory.category, "local");
  assert.equal(findInProgressLeaf(makeFlowManager(tmp).load().steps).id, "spec-gate");
  return envelope;
}

function validSpecJson(overrides = {}) {
  const result = {
    goal: "test goal",
    background: "test background",
    scope: { in: ["a"], out: ["b"] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "REQ-1", desc: "placeholder requirement" }],
    acceptance_criteria: ["placeholder acceptance criterion"],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    // spec 226: tasks[] is required to be non-empty for spec gate to pass
    tasks: [
      {
        id: "T-1",
        title: "placeholder",
        goal: "placeholder",
        origin: "plan",
        added_round: 0,
        status: "pending",
        parent: null,
        test_strategy: "Run focused unit tests.",
      },
    ],
    ...overrides,
  };
  const taskIds = result.tasks.map((task) => task.id);
  result.requirements = result.requirements.map((requirement) => ({
    ...requirement,
    ...(requirement.task_ids == null && taskIds.length > 0 ? { task_ids: [...taskIds] } : {}),
    ...(requirement.testable === false || requirement.preimplementation_test_expectation != null
      ? {}
      : { preimplementation_test_expectation: "fail" }),
  }));
  return result;
}

// ---------------------------------------------------------------------------
// checkSpecText — markdown checker (used by phase=task-spec for task drafts)
// ---------------------------------------------------------------------------

describe("checkSpecText (task-spec markdown)", () => {
  it("returns no issues for a valid spec", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
      "- test passes",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.deepEqual(issues, []);
  });

  it("detects missing Clarifications section", () => {
    const text = [
      "# Spec",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("Clarifications")));
  });

  it("detects missing Open Questions section", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("Open Questions")));
  });

  it("detects missing User Confirmation section", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("User Confirmation")));
  });

  it("detects missing Acceptance Criteria", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("Acceptance Criteria")));
  });

  it("detects unresolved markers (TBD/TODO/FIXME)", () => {
    const text = [
      "# Spec",
      "- TBD: decide later",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("unresolved token")));
  });

  it("detects unchecked tasks", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "- [ ] Need to clarify",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("unchecked task")));
  });

  it("accepts User Scenarios & Testing as alternative", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## User Scenarios & Testing",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.deepEqual(issues, []);
  });

  it("skips unchecked items in Acceptance Criteria (lenient)", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
      "- [ ] feature works",
      "- [ ] tests pass",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.deepEqual(issues, []);
  });

  it("skips unchecked items in Status section", () => {
    const text = [
      "# Spec",
      "## Status",
      "- [x] Spec created",
      "- [ ] Implementation complete",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
      "- [ ] done",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.deepEqual(issues, []);
  });

  it("still detects unchecked items outside skip-listed sections", () => {
    const text = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "- [ ] unresolved question",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
      "- [ ] done",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.ok(issues.some((i) => i.includes("unchecked task")));
  });

  it("ignores unresolved tokens inside table rows", () => {
    const text = [
      "# Spec",
      "| Phase | TODO |",
      "| --- | --- |",
      "| spec | skip TODO items |",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
    ].join("\n");
    const issues = checkSpecText(text);
    assert.deepEqual(issues, []);
  });
});

// ---------------------------------------------------------------------------
// checkSpecJson — JSON checker (used by phase=spec for parent spec.json)
// ---------------------------------------------------------------------------

describe("checkSpecJson (parent spec.json)", () => {
  it("returns no issues for a valid spec.json (R1, R2)", () => {
    const issues = checkSpecJson(validSpecJson());
    assert.deepEqual(issues, []);
  });

  it("returns no issues for a fully populated spec.json", () => {
    const spec = validSpecJson({
      goal: "deliver feature X",
      background: "current behavior is broken because Y",
      scope: { in: ["module A"], out: ["module B"] },
      constraints: ["no external deps"],
      design_principles: ["fail fast"],
      requirements: [{ id: "R1", desc: "When X happens, system shall Y." }],
      acceptance_criteria: ["X test passes"],
      clarifications: [{ q: "what if Z?", a: "do W" }],
      alternatives_considered: [{ option: "approach A", reason: "rejected because slow" }],
      open_questions: [],
      overview: {
        modules: [{ text: "module A handles X" }],
        data_flow: [{ text: "input -> A -> output" }],
        decisions: [{ text: "use sync IO" }],
      },
    });
    const issues = checkSpecJson(spec);
    assert.deepEqual(issues, []);
  });

  it("detects unresolved TBD marker in goal (R3)", () => {
    const spec = validSpecJson({ goal: "TBD" });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => i.includes("goal") && /TBD/.test(i)),
      `expected goal/TBD issue, got: ${JSON.stringify(issues)}`,
    );
  });

  it("detects unresolved TODO marker in background (R3)", () => {
    const spec = validSpecJson({ background: "TODO: write background later" });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => i.includes("background") && /TODO/.test(i)),
      `expected background/TODO issue, got: ${JSON.stringify(issues)}`,
    );
  });

  it("detects unresolved FIXME marker in requirements[].desc (R3)", () => {
    const spec = validSpecJson({
      requirements: [{ id: "R1", desc: "When X, FIXME shall happen" }],
    });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => /requirements\[0\]\.desc/.test(i) && /FIXME/.test(i)),
      `expected requirements[0].desc/FIXME issue, got: ${JSON.stringify(issues)}`,
    );
  });

  it("detects [NEEDS CLARIFICATION] marker in scope.in[] (R3)", () => {
    const spec = validSpecJson({
      scope: { in: ["[NEEDS CLARIFICATION] which module?"], out: [] },
    });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => /scope\.in\[0\]/.test(i) && /NEEDS CLARIFICATION/i.test(i)),
      `expected scope.in[0]/NEEDS CLARIFICATION issue, got: ${JSON.stringify(issues)}`,
    );
  });

  it("detects unresolved markers in clarifications[].q and .a (R3)", () => {
    const spec = validSpecJson({
      clarifications: [{ q: "TBD question", a: "TODO answer" }],
    });
    const issues = checkSpecJson(spec);
    assert.ok(issues.some((i) => /clarifications\[0\]\.q/.test(i) && /TBD/.test(i)));
    assert.ok(issues.some((i) => /clarifications\[0\]\.a/.test(i) && /TODO/.test(i)));
  });

  it("detects markers case-insensitively (R3)", () => {
    const spec = validSpecJson({ goal: "tbd" });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => i.includes("goal") && /tbd/i.test(i)),
      `expected case-insensitive marker detection, got: ${JSON.stringify(issues)}`,
    );
  });

  it("does not flag substrings that are part of larger words", () => {
    const spec = validSpecJson({ background: "We will subdivide the work" });
    const issues = checkSpecJson(spec);
    assert.deepEqual(
      issues.filter((i) => /tbd|todo|fixme/i.test(i)),
      [],
    );
  });

  it("walks overview.modules[].text for markers (R3)", () => {
    const spec = validSpecJson({
      overview: {
        modules: [{ text: "TODO describe later" }],
        data_flow: [],
        decisions: [],
      },
    });
    const issues = checkSpecJson(spec);
    assert.ok(
      issues.some((i) => /overview\.modules\[0\]\.text/.test(i) && /TODO/.test(i)),
      `expected overview.modules[0].text issue, got: ${JSON.stringify(issues)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// gate CLI
// ---------------------------------------------------------------------------

describe("gate CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("exits 0 on a valid explicit task-spec markdown target", () => {
    tmp = createTmpDir();
    initGateProject(tmp);
    const specContent = [
      "# Spec",
      "## Clarifications (Q&A)",
      "## Open Questions",
      "## User Confirmation",
      "- [x] User approved this spec",
      "## Acceptance Criteria",
      "- done",
    ].join("\n");
    writeFile(tmp, "spec.md", specContent);

    // This is the explicit task-spec markdown surface. The canonical gate
    // retains the spec-gate Attempt as its authority while validating it.
    const result = spawnSync("node", [
      join(process.cwd(), "src/sennel.js"),
      "flow", "run", "gate",
      "--phase", "task-spec",
      "--spec", join(tmp, "spec.md"),
    ], { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
  });

  it("returns a typed local-input block when task-spec markdown is empty", () => {
    tmp = createTmpDir();
    initGateProject(tmp);
    writeFile(tmp, "spec.md", "# Empty spec\n");

    const envelope = runLocallyBlockedGate(tmp, [
      "--phase", "task-spec",
      "--spec", join(tmp, "spec.md"),
    ]);
    assert.equal(envelope.data.result, "fail");
    assert.ok(envelope.data.artifacts.issues.length > 0);
  });

  it("phase=spec reads spec.json and returns ok:true with PASS-eligible textCheck (R1, R5, R7)", () => {
    tmp = createTmpDir();
    const validSpec = validSpecJson({
      // T-default matches the seed task in flow.json (monotonic check).
      tasks: [
        {
          id: "T-default",
          title: "Default test task",
          goal: "Placeholder task for test fixtures.",
          origin: "plan",
          added_round: 0,
          status: "pending",
          parent: null,
          test_strategy: "Run focused unit tests.",
        },
      ],
    });
    const fixture = initGateProject(tmp, { specRecord: validSpec });

    // Pass spec.md path; resolveSpecJsonPath should resolve to spec.json (R5).
    const result = execFileSync("node", [
      join(process.cwd(), "src/sennel.js"),
      "flow", "run", "gate",
      "--phase", "spec",
      "--spec", fixture.location().specFile,
    ], { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } });
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.result, "pass");
  });

  it("phase=spec returns mechanical failures before required evaluation (R5)", () => {
    tmp = createTmpDir();
    const invalidSpec = validSpecJson({
      requirements: [
        { id: "R1", desc: "one", priority: "must" },
        { id: "R2", desc: "two" },
        { id: "R3", desc: "three", priority: "should" },
        { id: "R4", desc: "four", priority: "nice-to-have" },
      ],
      tasks: [
        {
          id: "T-default",
          title: "Default test task",
          goal: "Placeholder task for test fixtures.",
          origin: "plan",
          added_round: 0,
          status: "pending",
          parent: null,
        },
      ],
    });
    const fixture = initGateProject(tmp, { specRecord: invalidSpec });

    const envelope = runLocallyBlockedGate(tmp, [
      "--phase", "spec",
      "--spec", fixture.location().specFile,
    ]);

    assert.equal(envelope.data.result, "fail");
    assert.equal(envelope.data.artifacts.failureKind, "mechanical");
    assert.deepEqual(envelope.data.artifacts.evaluations, []);
    assert.ok(
      envelope.data.artifacts.issues.includes(
        "requirements[1].priority: missing priority for requirement R2 (required when requirements length is greater than 3)",
      ),
    );
    assert.ok(
      envelope.data.artifacts.issues.includes(
        "tasks[0].test_strategy: missing test strategy for task T-default",
      ),
    );
  });

  it("phase=spec FAILs when spec.json has unresolved marker in goal (R3, R7)", () => {
    tmp = createTmpDir();
    const spec = {
      goal: "TBD",
      background: "",
      scope: { in: [], out: [] },
      constraints: [],
      design_principles: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      requirements: [],
      acceptance_criteria: [],
      clarifications: [],
      alternatives_considered: [],
      open_questions: [],
    };
    const fixture = initGateProject(tmp, { specId: "002-test", specRecord: spec });

    const envelope = runLocallyBlockedGate(tmp, [
      "--phase", "spec",
      "--spec", fixture.location().specFile,
    ]);
    assert.equal(envelope.data.result, "fail");
    assert.ok(
      envelope.data.artifacts.issues.some((i) => i.includes("goal") && /TBD/.test(i)),
      `expected goal/TBD issue, got: ${JSON.stringify(envelope.data.artifacts.issues)}`,
    );
  });

  it("phase=spec FAILs when spec.json fails schema validation (R2)", () => {
    tmp = createTmpDir();
    // Missing required field: acceptance_criteria
    const spec = {
      goal: "g",
      background: "",
      scope: { in: [], out: [] },
      constraints: [],
      design_principles: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      requirements: [],
      clarifications: [],
      alternatives_considered: [],
      open_questions: [],
    };
    const fixture = initGateProject(tmp, { specId: "003-test", specRecord: spec });

    const envelope = runLocallyBlockedGate(tmp, [
      "--phase", "spec",
      "--spec", fixture.location().specFile,
    ]);
    assert.equal(envelope.data.result, "fail");
    assert.ok(
      envelope.data.artifacts.issues.some((i) => /schema|acceptance_criteria/i.test(i)),
      `expected schema validation issue, got: ${JSON.stringify(envelope.data.artifacts.issues)}`,
    );
  });
});
