import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { Logger } from "../../src/lib/log.js";
import { PromptLogicalFootprint } from "../../src/lib/prompt-batching.js";
import { checkGuardrail } from "../../src/flow/lib/run-gate.js";

// Frozen expected findings are derived from these rules, independently of the
// baseline implementation's output. No real Flow artifacts enter this fixture.
const rules = [
  { id: "planned-threshold", title: "Verification threshold", body: "Every testable requirement must state a planned verification method and an explicit passing condition. At Spec stage do not require executed test results. A requirement explicitly marked non-testable is exempt only when its justification establishes that no runtime behavior can be tested." },
  { id: "consistent-timeout", title: "Consistent timeout", body: "All normative definitions of the upload timeout must agree exactly. Different values for the same upload timeout in separate sections are a violation." },
  { id: "justified-exception", title: "Non-testable exception", body: "Non-testable requirements must carry a justification. Exception: an explicit justification elsewhere in the same document may be referenced by its exact decision ID. Read the referenced decision before reporting a missing justification." },
  { id: "spec-stage", title: "Spec stage evidence", body: "The document must identify itself as pre-implementation and state that executed results will be supplied in later implementation and acceptance stages. This rule checks only that stage declaration. Executed test evidence is not required at Spec stage, so its absence is never a violation of this rule." },
].map((rule) => ({ ...rule, meta: { phase: ["spec"], category: "testing" } }));
const descriptions = [
  "Report upload status. Verification: inspect a status report. The passing condition has not been decided.",
  "Rename the internal concept in the explanatory glossary. Justification: decision D2 below.",
  "Enforce the upload timeout of exactly 10 seconds. Planned verification: a deterministic timer test must reject at exactly 10 seconds and allow completion before 10 seconds.",
  ...Array.from({ length: 90 }, (_, index) => `Export the record-${index + 1} field without modification. Planned verification: compare exported field with the supplied record-${index + 1} fixture; pass if the values are byte-for-byte identical. This requirement has no relation to upload timeouts or glossary terminology.`),
];
const source = JSON.stringify({
  goal: "Plan a record export and upload status change.",
  background: "This is a pre-implementation Spec. All checks are planned, not executed. No tests have run yet. Execution results will be supplied during implementation and acceptance.",
  requirements: descriptions.map((desc, index) => ({ id: `R${index + 1}`, desc, task_ids: ["T1"],
    testable: index !== 1, ...(index === 1 ? {} : { preimplementation_test_expectation: "fail" }) })),
  overview: { modules: [], data_flow: [], decisions: [{ text: "D2: R2 only renames an explanatory glossary concept; it changes no runtime behavior, observable output, API or data. It is non-testable for that reason. This is the explicit justification referenced by R2." }] },
  constraints: ["The upload timeout is exactly 20 seconds. This constraint is normative for the same upload operation described by R3; it is not a separate timeout or environment."],
  tasks: [{ id: "T1", title: "Implement the plan", goal: "Implement the specified planned behavior", origin: "plan", added_round: 0, status: "pending" }],
  scope: { in: ["Planned behavior"], out: [] }, design_principles: [], acceptance_criteria: [],
}, null, 2) + "\n";
const expectedViolations = ["consistent-timeout", "planned-threshold"];

test("real model preserves cross-range violations, justified exceptions and Spec-stage semantics", { timeout: 1_800_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-spec-gate-quality-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = process.env.SENNEL_GATE_QUALITY_MODEL || "gpt-6-luna";
  const profile = "quality-frozen";
  const config = { agent: { default: profile, timeout: 240, retryCount: 0, promptCharacterLimit: 18000,
    providers: { [profile]: { command: "codex", args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "{{PROMPT}}"],
      jsonOutputFlag: "--json", jsonSchemaFlag: "--output-schema", jsonSchemaMode: "file" } } } };
  const real = new Agent({ config, paths: { root, agentWorkDir: root }, registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
  const report = { version: 1, model, promptCharacterLimit: 18000,
    inputDigest: createHash("sha256").update(JSON.stringify({ source, rules })).digest("hex"), expectedViolations, runs: [] };
  const variants = [];
  if (process.env.SENNEL_GATE_QUALITY_BASELINE) {
    const baseline = await import(pathToFileURL(path.join(process.env.SENNEL_GATE_QUALITY_BASELINE, "src/flow/lib/run-gate.js")));
    variants.push({ name: "baseline", evaluate: baseline.checkGuardrail, shared: false });
  }
  variants.push({ name: "shared", evaluate: checkGuardrail, shared: true });
  for (const variant of variants) {
    const measurement = { name: variant.name, calls: [], phaseMetrics: [], result: null };
    report.runs.push(measurement);
    const agent = {
      promptCharacterLimit: real.promptCharacterLimit,
      resolve: (...args) => real.resolve(...args),
      projectInvocation: (...args) => real.projectInvocation(...args),
      call: async (prompt, options) => {
        const call = { inputCharacters: PromptLogicalFootprint.measure({ userPrompt: prompt, ...options }).total, durationMs: null };
        measurement.calls.push(call);
        const start = Date.now();
        try { return await real.call(prompt, { ...options, cacheMode: "bypass" }); }
        finally { call.durationMs = Date.now() - start; }
      },
    };
    const start = Date.now();
    measurement.result = await variant.evaluate(root, source, "spec", undefined, [], {
      agent, loadGuardrails: () => rules, sharedGuardrailEvidence: variant.shared,
      recordPromptMetric: (entry) => measurement.phaseMetrics.push(entry),
      ...(variant.shared ? { structuredSource: JSON.parse(source) } : {}),
    });
    measurement.durationMs = Date.now() - start;
    measurement.inputCharacters = measurement.calls.reduce((sum, call) => sum + call.inputCharacters, 0);
    measurement.callCount = measurement.calls.length;
  }
  if (process.env.SENNEL_GATE_QUALITY_REPORT) fs.writeFileSync(process.env.SENNEL_GATE_QUALITY_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  for (const measurement of report.runs) {
    t.diagnostic(JSON.stringify({ name: measurement.name, callCount: measurement.callCount, inputCharacters: measurement.inputCharacters, durationMs: measurement.durationMs }));
    const actual = [...new Set((measurement.result.evaluations ?? []).filter((entry) => entry.result === "fail").map((entry) => entry.guardrail_id))].sort();
    if (measurement.name === "shared") {
      assert.deepEqual(actual, expectedViolations, JSON.stringify(measurement.result));
      const threshold = measurement.result.evaluations.filter((entry) => entry.guardrail_id === "planned-threshold");
      assert.match(JSON.stringify(threshold), /R1|requirements\/0/);
      const timeout = measurement.result.evaluations.filter((entry) => entry.guardrail_id === "consistent-timeout");
      assert.match(JSON.stringify(timeout), /10/);
      assert.match(JSON.stringify(timeout), /20/);
    }
  }
});
