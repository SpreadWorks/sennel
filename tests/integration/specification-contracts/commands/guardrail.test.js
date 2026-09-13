import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { createTmpDir, removeTmpDir, writeJson } from "../../../support/builders/tmp-dir.js";
import { spawnSync } from "child_process";
import { CanonicalFlowFixture, makeFlowManager } from "../../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../../support/infrastructure/git-repo.js";

const SENNEL = join(process.cwd(), "src/sennel.js");

// Dynamically import gate functions for unit tests
const { buildGuardrailPrompt, parseGuardrailArticleEvaluation, IMPL_DIFF_SCOPE_LINES } = await import(
  "../../../../src/flow/lib/run-gate.js"
);

// ---------------------------------------------------------------------------
// gate integration: guardrail warning
// ---------------------------------------------------------------------------

describe("gate guardrail integration", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  const validSpec = {
    goal: "test goal",
    background: "test background",
    scope: { in: ["a"], out: ["b"] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{
      id: "REQ-1", desc: "placeholder requirement", task_ids: ["T-default"], testable: false,
    }],
    acceptance_criteria: ["placeholder acceptance criterion"],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
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
  };

  function createGateFixture({ config, guardrails } = {}) {
    tmp = createTmpDir();
    initGitRepo(tmp);
    commitAll(tmp, "init");
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specRecord: { ...validSpec, tasks: [] },
    }).create().addTasks(validSpec.tasks).registerActive().activate("spec-gate");
    writeJson(tmp, ".sennel/config.json", config || {
      lang: "en", type: "base",
      docs: { languages: ["en"], defaultLanguage: "en" },
    });
    if (guardrails) {
      writeJson(tmp, ".sennel/guardrail.json", { guardrails });
    }
    return { root: tmp, fixture };
  }

  function runGate({ root, fixture }, { phase = "spec", extraArgs = [] } = {}) {
    // Explicit `phase` is required under the post-spec-221 contract: when no
    // gate-type step is in_progress in the flow state, the gate command
    // errors out unless --phase is passed. The helper centralizes the flag so
    // callers cannot accidentally pass a conflicting --phase via extraArgs.
    return spawnSync("node", [
      SENNEL, "flow", "run", "gate",
      "--phase", phase,
      "--spec", fixture.location().specFile,
      ...extraArgs,
    ], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: root },
    });
  }

  function parseGateResult(result) {
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    return envelope;
  }

  it("fails closed when no evaluation agent is configured", () => {
    const fixture = createGateFixture();
    const envelope = parseGateResult(runGate(fixture));
    assert.equal(envelope.data.artifacts.failureCode, "GATE_REQUIRED_AGENT_UNSET");
  });

  it("fails closed with configured guardrails but no evaluation agent", () => {
    const fixture = createGateFixture({
      guardrails: [
        {
          id: "no-external-deps",
          title: "No External Dependencies",
          body: "Use only Node.js built-in modules.",
          meta: { phase: ["spec"], category: "code-quality" },
        },
      ],
    });
    const envelope = parseGateResult(runGate(fixture));
    assert.equal(envelope.data.artifacts.failureCode, "GATE_REQUIRED_AGENT_UNSET");
  });

  it("rejects --skip-guardrail as a public CLI option", () => {
    const fixture = createGateFixture({
      config: {
        lang: "en", type: "base",
        docs: { languages: ["en"], defaultLanguage: "en" },
        agent: { default: "claude", providers: { claude: { command: "echo", args: ["FAIL"] } } },
      },
      guardrails: [
        {
          id: "rule",
          title: "Rule",
          body: "Some rule.",
          meta: { phase: ["spec"], category: "process" },
        },
      ],
    });
    const result = runGate(fixture, { extraArgs: ["--skip-guardrail"] });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unknown option.*--skip-guardrail/i);
  });
});

// ---------------------------------------------------------------------------
// buildGuardrailPrompt: structured JSON output format
// ---------------------------------------------------------------------------

describe("buildGuardrailPrompt (structured JSON)", () => {
  it("includes all guardrails and spec text", () => {
    const guardrails = [
      { id: "a", title: "Rule A", body: "Description A", meta: { phase: ["spec"], category: "requirements" } },
      { id: "b", title: "Rule B", body: "Description B", meta: { phase: ["spec"], category: "requirements" } },
    ];
    const prompt = buildGuardrailPrompt("spec content here", guardrails, "spec");
    assert.ok(prompt.includes("Rule A"));
    assert.ok(prompt.includes("Rule B"));
    assert.ok(prompt.includes("spec content here"));
    assert.ok(prompt.includes("evaluations"));
    assert.ok(prompt.includes("pass"));
    assert.ok(prompt.includes("fail"));
    assert.ok(prompt.includes("JSON"));
    assert.ok(prompt.includes("Evaluate only explicit requirements stated in the listed guardrail article body"));
    assert.ok(prompt.includes("This is a readiness gate, not a design review"));
    assert.ok(prompt.includes("not directly grounded in a listed guardrail article"));
  });
});

// ---------------------------------------------------------------------------
// parseEvaluationResponse: sanity delegating tests — full contract covered in
// tests/unit/flow/gate-evaluation-schema.test.js.
// ---------------------------------------------------------------------------

describe("parseGuardrailArticleEvaluation (smoke)", () => {
  it("parses a well-formed response", () => {
    const resp = JSON.stringify({
      evaluations: [{ guardrail_id: "a", result: "pass", reason: "ok" }],
    });
    const r = parseGuardrailArticleEvaluation(resp, ["a"]);
    assert.equal(r.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildGuardrailPrompt includes all guardrails (no exemption filtering)
// ---------------------------------------------------------------------------

describe("buildGuardrailPrompt ignores exemption sections", () => {
  const guardrails = [
    { id: "a", title: "Rule A", body: "Description A", meta: { phase: ["spec"], category: "requirements" } },
    { id: "b", title: "Rule B", body: "Description B", meta: { phase: ["spec"], category: "requirements" } },
    { id: "c", title: "Rule C", body: "Description C", meta: { phase: ["spec"], category: "requirements" } },
  ];

  it("includes all spec-phase guardrails even with exemptions section in spec", () => {
    const spec = "## Guardrail Exemptions\n- Rule B \u2014 reason\n\n## Requirements\n- R1\n";
    const prompt = buildGuardrailPrompt(spec, guardrails, "spec");
    assert.ok(prompt.includes("Rule A"));
    assert.ok(prompt.includes("Rule B"), "Rule B should NOT be filtered out");
    assert.ok(prompt.includes("Rule C"));
    assert.ok(!prompt.includes("Exempted Articles"), "should not have Exempted Articles section");
  });

  it("includes inapplicable instruction", () => {
    const prompt = buildGuardrailPrompt("## Requirements\n- R1\n", guardrails, "spec");
    assert.ok(prompt.includes("inapplicable"), "should include inapplicable instruction");
  });
});

// ---------------------------------------------------------------------------
// buildGuardrailPrompt: diff-scope constraint for task-impl and integration
// ---------------------------------------------------------------------------

describe("buildGuardrailPrompt diff-scope constraint (task-impl / integration)", () => {
  const implGuardrails = [
    {
      id: "no-sync-io",
      title: "No Sync I/O in Hot Paths",
      body: "Avoid sync I/O",
      meta: { phase: ["task-impl", "integration"], category: "code-quality" },
    },
  ];
  const DIFF_SCOPE_HEADING = "## Diff Scope Constraint";
  const DIFF_SCOPE_SECTION_RE = /^## Diff Scope Constraint$/m;
  const CANONICAL_PHRASES = IMPL_DIFF_SCOPE_LINES.join("\n");

  it("embeds diff-scope heading in task-impl prompts", () => {
    const targetText = "## Spec\nR1\n\n## Git Diff\ndiff --git a/x.js b/x.js\n+new line\n";
    const prompt = buildGuardrailPrompt(targetText, implGuardrails, "task-impl");
    assert.ok(prompt, "task-impl prompt should be generated");
    assert.ok(DIFF_SCOPE_SECTION_RE.test(prompt));
  });

  it("embeds diff-scope heading in integration prompts", () => {
    const targetText = "## Spec\nR1\n\n## Git Diff\ndiff --git a/x.js b/x.js\n+new line\n";
    const prompt = buildGuardrailPrompt(targetText, implGuardrails, "integration");
    assert.ok(prompt, "integration prompt should be generated");
    assert.ok(DIFF_SCOPE_SECTION_RE.test(prompt));
  });

  it("embeds the full canonical diff-scope instruction block", () => {
    const targetText = "## Spec\nR1\n\n## Git Diff\ndiff --git a/x.js b/x.js\n+new line\n";
    const prompt = buildGuardrailPrompt(targetText, implGuardrails, "task-impl");
    assert.ok(
      prompt.includes(CANONICAL_PHRASES.trim()),
      "task-impl prompt should embed IMPL_DIFF_SCOPE_LINES verbatim",
    );
  });

  it("does not add diff-scope constraint to draft/spec/task-spec phase prompts", () => {
    const multiPhaseGuardrails = [
      {
        id: "rule-a",
        title: "Rule A",
        body: "Desc A",
        meta: { phase: ["draft", "spec", "task-spec", "task-impl", "integration"], category: "requirements" },
      },
    ];
    for (const phase of ["draft", "spec", "task-spec"]) {
      const prompt = buildGuardrailPrompt("content", multiPhaseGuardrails, phase);
      assert.ok(prompt, `${phase} prompt should be generated`);
      assert.ok(
        !DIFF_SCOPE_SECTION_RE.test(prompt),
        `${phase} prompt should not carry diff-scope heading`,
      );
    }
  });
});
