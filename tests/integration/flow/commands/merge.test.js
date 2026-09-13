import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CanonicalFinalizeMergeSpecSource,
  parseSpec,
  buildPrTitle,
  buildPrBody,
  fallbackTitleFromSpecId,
} from "../../../../src/flow/commands/merge.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";

let root = null;

afterEach(() => {
  if (root !== null) removeTmpDir(root);
  root = null;
});

const SAMPLE_SPEC_JSON = {
  goal: "flow-finalize の PR ルートで PR description を自動生成する。",
  background: "",
  scope: {
    in: ["merge.js を拡張する", "spec.json を読む"],
    out: ["squash merge の変更"],
  },
  constraints: [],
  design_principles: [],
  overview: { modules: [], data_flow: [], decisions: [] },
  requirements: [
    { id: "R1", desc: "パーサーを追加する", priority: "must" },
    { id: "R2", desc: "buildPrBody を拡張する", priority: "must" },
  ],
  acceptance_criteria: ["PR body に Goal が含まれること"],
  clarifications: [],
  alternatives_considered: [],
  open_questions: [],
};

const MINIMAL_SPEC_JSON = {
  goal: "最小限の spec。",
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

describe("parseSpec (spec.json-based, spec 207 / T8)", () => {
  it("extracts Goal, Scope, Requirements as structured data", () => {
    const result = parseSpec(SAMPLE_SPEC_JSON);
    assert.equal(result.goal, "flow-finalize の PR ルートで PR description を自動生成する。");
    assert.deepEqual(result.scopeIn, ["merge.js を拡張する", "spec.json を読む"]);
    assert.deepEqual(result.scopeOut, ["squash merge の変更"]);
    assert.equal(result.requirements.length, 2);
    assert.equal(result.requirements[0].id, "R1");
    assert.equal(result.requirements[0].desc, "パーサーを追加する");
  });

  it("returns empty collections when scope/requirements are empty", () => {
    const result = parseSpec(MINIMAL_SPEC_JSON);
    assert.equal(result.goal, "最小限の spec。");
    assert.deepEqual(result.scopeIn, []);
    assert.deepEqual(result.scopeOut, []);
    assert.deepEqual(result.requirements, []);
  });

  it("returns null goal and empty collections for null input", () => {
    const result = parseSpec(null);
    assert.equal(result.goal, null);
    assert.deepEqual(result.scopeIn, []);
    assert.deepEqual(result.scopeOut, []);
    assert.deepEqual(result.requirements, []);
  });
});

describe("canonical finalize merge Spec source", () => {
  it("reads the cataloged Version Spec and fails closed when its durable bytes disappear", () => {
    root = createTmpDir("canonical-finalize-merge-spec-");
    const flowManager = makeFlowManager(root);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-finalize-merge-spec",
      runId: "run-finalize-merge-spec",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/finalize-merge-spec" },
      specRecord: {
        goal: "Use the cataloged merge metadata.",
        requirements: [{ id: "R-1", desc: "Do not read the retired root Spec.", task_ids: ["T-1"], testable: false }],
      },
    }).create().addTask({
      id: "T-1",
      title: "Finalize merge fixture",
      goal: "Reach the finalize merge boundary.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    }).registerActive().activate("finalize-merge");
    const retired = path.join(root, "specs", fixture.specId, "spec.json");
    fs.writeFileSync(retired, `${JSON.stringify({ goal: "retired root value" })}\n`);

    const source = new CanonicalFinalizeMergeSpecSource({
      flowManager,
      state: fixture.state(),
    });
    assert.equal(source.relativePath, "spec.json");
    assert.equal(source.summary().goal, "Use the cataloged merge metadata.");

    fs.rmSync(fixture.location().specFile);
    assert.throws(() => new CanonicalFinalizeMergeSpecSource({
      flowManager,
      state: fixture.state(),
    }), /catalog|artifact|missing|does not exist|ENOENT/i);
  });
});

describe("buildPrTitle", () => {
  it("returns Goal first line from spec", () => {
    const spec = { goal: "PR description を自動生成する。\n複数行の Goal", scopeIn: [], scopeOut: [], requirements: [] };
    const title = buildPrTitle(spec, "fallback-title");
    assert.equal(title, "PR description を自動生成する。");
  });

  it("falls back to specTitle when goal is null", () => {
    const spec = { goal: null, scopeIn: [], scopeOut: [], requirements: [] };
    const title = buildPrTitle(spec, "fallback-title");
    assert.equal(title, "fallback-title");
  });

  it("falls back when spec is null", () => {
    const title = buildPrTitle(null, "fallback-title");
    assert.equal(title, "fallback-title");
  });
});

describe("fallbackTitleFromSpecId", () => {
  it("removes the runId-derived tag from the new specId format", () => {
    assert.equal(
      fallbackTitleFromSpecId("04072896-flow-authority-boundaries", "feature/fallback"),
      "flow-authority-boundaries",
    );
  });

  it("uses the feature branch when specId is absent", () => {
    assert.equal(fallbackTitleFromSpecId(null, "feature/fallback"), "feature/fallback");
  });
});

describe("buildPrBody", () => {
  it("generates structured body with issue, goal, requirements, scope", () => {
    const state = { issue: 37, request: "original request" };
    const spec = {
      goal: "PR description を自動生成する。",
      scopeIn: ["merge.js を拡張"],
      scopeOut: [],
      requirements: [
        { id: "R1", desc: "パーサー追加", priority: "must" },
        { id: "R2", desc: "body 拡張" },
      ],
    };
    const body = buildPrBody(state, spec);
    assert.ok(body.includes("fixes #37"));
    assert.ok(body.includes("## Goal"));
    assert.ok(body.includes("PR description を自動生成する。"));
    assert.ok(body.includes("## Requirements"));
    assert.ok(body.includes("- R1 [must]: パーサー追加"));
    assert.ok(body.includes("## Scope"));
    assert.ok(body.includes("- merge.js を拡張"));
  });

  it("omits sections that are empty", () => {
    const state = { issue: 5 };
    const spec = { goal: "ゴール", scopeIn: [], scopeOut: [], requirements: [] };
    const body = buildPrBody(state, spec);
    assert.ok(body.includes("fixes #5"));
    assert.ok(body.includes("## Goal"));
    assert.ok(!body.includes("## Requirements"));
    assert.ok(!body.includes("## Scope"));
  });

  it("falls back to request-based body when spec is null", () => {
    const state = { issue: 10, request: "元のリクエスト" };
    const body = buildPrBody(state, null);
    assert.ok(body.includes("fixes #10"));
    assert.ok(body.includes("元のリクエスト"));
    assert.ok(!body.includes("## Goal"));
  });

  it("handles no issue and no spec", () => {
    const state = { request: "リクエスト" };
    const body = buildPrBody(state, null);
    assert.ok(!body.includes("fixes"));
    assert.ok(body.includes("リクエスト"));
  });

  it("handles no issue with spec", () => {
    const state = {};
    const spec = { goal: "ゴール", scopeIn: [], scopeOut: [], requirements: [] };
    const body = buildPrBody(state, spec);
    assert.ok(!body.includes("fixes"));
    assert.ok(body.includes("## Goal"));
  });
});
