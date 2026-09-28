import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import { buildGuardrailArticleEvalPrompt, checkGuardrail } from "../../../src/flow/lib/run-gate.js";
import { PromptLogicalFootprint, ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";

const specRevision = `sha256:${"a".repeat(64)}`;
const target = { entity: "requirement", id: "R-1", field: "desc" };
const allowedTarget = { target, operationKinds: ["edit-text-field"] };
const rule = (id, body = "Require an observable acceptance condition.") => ({
  id, title: id, body, meta: { phase: ["spec"], category: "testing" },
});
const spec = () => ({ requirements: [{ id: "R-1", desc: "Describe observable behavior." }], tasks: [] });
const observation = (id, observed = "The acceptance condition is absent.", file = "spec.json") => ({
  failureMode: "guardrail-violation", requirementRef: id,
  where: { file, locator: "requirements.R-1.desc" }, observed,
  targets: [target], allowedTargets: [allowedTarget],
});
const fileResponse = (observations = []) => JSON.stringify({ observations, evaluationUnavailable: null });
const filePathFromPrompt = (prompt) => {
  const match = /^Absolute file path: (.+)$/m.exec(prompt);
  assert.ok(match, "Spec prompt must reference its complete temporary file");
  return match[1];
};

async function withRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-file-gate-"));
  try { return await callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it("keeps a small parent Spec inline with the Spec-stage and repair-target contract", async () => withRoot(async (root) => {
  const canonical = spec();
  const source = `${JSON.stringify(canonical, null, 2)}\n`;
  let calls = 0;
  const result = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => [rule("S1")],
    agent: { resolve: () => true, async call(prompt, options) {
      calls += 1;
      assert.equal(prompt.split("## Content\n")[1], source);
      assert.doesNotMatch(prompt, /Absolute file path:/);
      assert.match(options.systemPrompt, /Later implementation and test execution are owned by later steps/);
      assert.deepEqual(options.jsonSchema.required, ["observations"]);
      return JSON.stringify({ observations: [observation("S1")] });
    } },
  });
  assert.equal(calls, 1);
  assert.equal(result.passed, false);
  const [finding] = result.evaluations[0].observations;
  assert.deepEqual(finding.targets, [target]);
  assert.deepEqual(finding.allowedTargets, [allowedTarget]);
  assert.equal(finding.specRevision, specRevision);
}));

it("evaluates exact oversized Spec bytes once from a temporary file and preserves full rules", async () => withRoot(async (root) => {
  const canonical = spec();
  canonical.requirements[0].desc += ` HEAD ${"あ".repeat(130000)} TAIL`;
  const source = `${JSON.stringify(canonical, null, 2)}\n`;
  const paths = [];
  const metrics = [];
  const articles = [rule("S1", "Rule starts. An exception requires an explicit clause. Rule ends."),
    rule("S2", "Require task and requirement consistency.")];
  const result = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => articles,
    acknowledgedRationale: { markdown: "Explicit exception reason: acknowledged only when the rule permits it." },
    priorMemoryMarkdown: "Prior observation: preserve all distinct violations.",
    recordPromptMetric: (metric) => metrics.push(metric),
    agent: { resolve: () => true, async call(prompt, options) {
      const filePath = filePathFromPrompt(prompt);
      paths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
      assert.match(prompt, new RegExp(crypto.createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex")));
      assert.match(prompt, /Logical artifact name: spec\.json/);
      assert.doesNotMatch(prompt, /## Canonical input ranges/);
      assert.match(prompt, /Rule starts\. An exception requires an explicit clause\. Rule ends\./);
      assert.match(prompt, /Require task and requirement consistency/);
      assert.match(prompt, /Explicit exception reason: acknowledged only when the rule permits it/);
      assert.match(prompt, /Prior observation: preserve all distinct violations/);
      assert.deepEqual(options.jsonSchema.required, ["observations", "evaluationUnavailable"]);
      const item = options.jsonSchema.properties.observations.items;
      assert.ok(item.required.includes("targets") && item.required.includes("allowedTargets"));
      assert.deepEqual(item.properties.where.properties.file.enum, ["spec.json"]);
      return fileResponse([observation("S1")]);
    } },
  });
  assert.equal(result.passed, false);
  assert.ok(result.evaluations[0]?.observations, JSON.stringify(result));
  assert.equal(result.evaluations[0].observations[0].specRevision, specRevision);
  assert.equal(paths.length, 1);
  assert.equal(fs.existsSync(paths[0]), false);
  assert.equal(metrics.find((metric) => metric.stage === "judgment-rule-group").count, 1);
  assert.equal(metrics.some((metric) => ["source-partition", "rule-group", "collection", "reduction"].includes(metric.stage)), false);
}));

it("switches a fitting Spec to file when the provider projection exceeds the request limit", async () => withRoot(async (root) => {
  const canonical = spec();
  const source = `${JSON.stringify(canonical, null, 2)}\n`;
  const article = rule("S1");
  assert.ok(PromptLogicalFootprint.measure(buildGuardrailArticleEvalPrompt(source, [article], "spec", undefined, [],
    { specTargetScope: { spec: canonical, specRevision } }).build()).total < 120000);
  let calls = 0;
  const result = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => [article],
    agent: { resolve: () => true,
      projectInvocation(prompt) {
        return new ResolvedAgentInvocationProjection({
          providerKey: "fixture", profileKey: "fixture", command: "fixture",
          promptCharacterCount: prompt.includes("Absolute file path:") ? 1000 : 120001,
          systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
          finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
        });
      },
      async call(prompt) {
        calls += 1;
        assert.equal(fs.readFileSync(filePathFromPrompt(prompt), "utf8"), source);
        return fileResponse();
      },
    },
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(calls, 1);
}));

it("keeps grouped Spec file alive for each judgment and rejects a later unavailable group without partial findings", async () => withRoot(async (root) => {
  const canonical = spec();
  canonical.requirements[0].desc += "x".repeat(130000);
  const source = `${JSON.stringify(canonical, null, 2)}\n`;
  const paths = [];
  let calls = 0;
  const result = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => [rule("S1"), rule("S2")],
    agent: { resolve: () => true,
      projectInvocation(_prompt, options) {
        const count = options.jsonSchema.properties.observations.items.properties.requirementRef.enum.length;
        return new ResolvedAgentInvocationProjection({
          providerKey: "fixture", profileKey: "fixture", command: "fixture",
          promptCharacterCount: count > 1 ? 120001 : 1000,
          systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
          finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
        });
      },
      async call(prompt, options) {
        calls += 1;
        const filePath = filePathFromPrompt(prompt);
        paths.push(filePath);
        assert.equal(fs.readFileSync(filePath, "utf8"), source);
        const id = options.jsonSchema.properties.observations.items.properties.requirementRef.enum[0];
        return id === "S1" ? fileResponse([observation("S1")])
          : JSON.stringify({ observations: null, evaluationUnavailable: { reason: "Full file exceeds available context." } });
      },
    },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.evaluations, []);
  assert.match(result.failureReason, /Full file exceeds available context/);
  assert.equal(calls, 2);
  assert.deepEqual(paths, [paths[0], paths[0]]);
  assert.equal(fs.existsSync(paths[0]), false);
}));

it("keeps the same Spec file through format repair and validates the logical observation name", async () => withRoot(async (root) => {
  const canonical = spec();
  canonical.requirements[0].desc += "x".repeat(130000);
  const source = `${JSON.stringify(canonical, null, 2)}\n`;
  const paths = [];
  let calls = 0;
  const result = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => [rule("S1")],
    agent: { resolve: () => true, async call(prompt) {
      calls += 1;
      const filePath = filePathFromPrompt(prompt);
      paths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
      return calls === 1 ? "invalid JSON" : fileResponse([observation("S1")]);
    } },
  });
  assert.equal(result.passed, false);
  assert.equal(result.evaluations[0].observations[0].where.file, "spec.json");
  assert.equal(calls, 2);
  assert.deepEqual(paths, [paths[0], paths[0]]);
  assert.equal(fs.existsSync(paths[0]), false);

  let wrongFileCalls = 0;
  const wrongFile = await checkGuardrail(root, source, "spec", undefined, [], {
    specTargetScope: { spec: canonical, specRevision }, loadGuardrails: () => [rule("S1")],
    agent: { resolve: () => true, async call() {
      wrongFileCalls += 1;
      return fileResponse([observation("S1", "The condition is absent.", "other.json")]);
    } },
  });
  assert.equal(wrongFile.passed, false);
  assert.deepEqual(wrongFile.evaluations, []);
  assert.equal(wrongFile.failureKind, "schema");
  assert.equal(wrongFileCalls, 2);
}));

it("rejects one oversized canonical Spec rule before the provider is called", async () => withRoot(async (root) => {
  let calls = 0;
  const result = await checkGuardrail(root, "small Spec", "spec", undefined, [], {
    loadGuardrails: () => [rule("S1", `START ${"x".repeat(130000)} END`)],
    agent: { resolve: () => true, async call() { calls += 1; return "unreachable"; } },
  });
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, "PROMPT_ELEMENT_TOO_LARGE");
  assert.deepEqual(result.evaluations, []);
  assert.equal(calls, 0);
}));
