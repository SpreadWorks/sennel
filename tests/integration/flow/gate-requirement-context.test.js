import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IntegrationExecutionEvidence,
  RequirementGateBatch,
  buildImplCheckPrompt,
  buildRequirementGateContext,
  classifyRequirementObligation,
} from "../../../src/flow/lib/run-gate.js";
import { PromptLogicalFootprint } from "../../../src/lib/prompt-batching.js";

function specFixture() {
  return {
    scope: { in: [], out: ["Do not replace delegated behavior"] },
    constraints: ["Use the exact schema contract"],
    design_principles: ["R1 preserves `resultField`"],
    overview: {
      modules: [{ text: "R1 is owned by `src/result.js`" }],
      data_flow: [{ text: "R1 returns `resultField`" }],
      decisions: [{ text: "R1 schema field contract is `resultField`" }],
    },
    acceptance_criteria: ["AC1 (R1): preserve `resultField` unchanged"],
    implementationTargets: ["src/result.js"],
    tasks: [{
      id: "T-1",
      title: "Preserve result",
      goal: "Preserve R1 in `src/result.js`.",
      acceptance: ["R1 uses the exact field."],
      origin: "plan",
      added_round: 0,
      status: "pending",
    }],
  };
}

describe("requirement gate context", () => {
  it("renders complete linked sources with stable references and obligation semantics", () => {
    const requirement = { id: "R1", desc: "Preserve delegated `resultField` behavior", priority: "must" };
    const context = buildRequirementGateContext({
      spec: specFixture(),
      requirement,
      fileMap: { R1: ["src/result.js"] },
      relatedDiff: "+return { resultField };",
    });
    const text = context.toPromptText();
    assert.equal(context.obligation.kind, "preservation/non-interception");
    assert.match(text, /\[REQ:R1\]/);
    assert.match(text, /\[AC:1\]/);
    assert.match(text, /\[SCHEMA:DECISION:1:1\]/);
    assert.match(text, /\[FILE-MAP:R1:1\]/);
    assert.match(text, /\[EVIDENCE:R1\]/);
    for (const entry of context.entries) assert.ok(text.includes(entry.toPromptText()));
  });

  it("counts rendered contexts toward batch and prompt identity", () => {
    const requirement = { id: "R1", desc: "Add `resultField` behavior", priority: "must" };
    const context = buildRequirementGateContext({
      spec: specFixture(),
      requirement,
      fileMap: { R1: ["src/result.js"] },
      relatedDiff: "+return { resultField };",
    });
    const diff = "x".repeat(120001 - context.toPromptText().length);
    const batch = new RequirementGateBatch({ requirements: [requirement], contexts: [context], diff });
    assert.equal(batch.promptCharCount, PromptLogicalFootprint.measure(batch.buildPrompt().build()).total);
    assert.ok(batch.promptCharCount > 120000);
    const prompt = buildImplCheckPrompt({ contexts: [context], diff, knownIds: ["R1"] }).build();
    assert.match(prompt.userPrompt, /## Requirement Contexts/);
    assert.match(prompt.systemPrompt, /Every evaluation reason MUST cite \[REQ:<id>\]/);
    assert.match(prompt.systemPrompt, /Deferred full-project regression evidence is valid at this integration gate/);
  });

  it("provides validated execution evidence and preserves its stage boundary", () => {
    const executionEvidence = new IntegrationExecutionEvidence({
      result: {
        summary: [{
          id: "R1",
          result: "pass",
          evidence: {
            command: "node --test specs/demo/tests/migration.test.js",
            test_name: "R1: current contract",
          },
        }],
        regression: { category: "full-regression-deferred" },
      },
      review: { verdict: "pass" },
    });
    const context = buildRequirementGateContext({
      spec: specFixture(),
      requirement: { id: "R1", desc: "Verify current contract", priority: "must" },
      fileMap: { R1: ["src/result.js"] },
      executionEvidence,
    });
    const prompt = buildImplCheckPrompt({ contexts: [context], diff: "+current contract", knownIds: ["R1"] }).build();

    assert.match(context.toPromptText(), /\[TEST:R1\].*node --test/);
    assert.match(context.toPromptText(), /\[REGRESSION\].*final-regression/);
    assert.match(prompt.systemPrompt, /Definition owns semantic retry exhaustion.*deferred findings/i);
    assert.match(prompt.systemPrompt, /full-regression-deferred.*final-regression/i);
  });

  it("uses matching acceptance criteria when classifying obligations", () => {
    assert.equal(classifyRequirementObligation(
      { id: "R1", desc: "Verify delegated routing" },
      ["AC1 (R1): no regression in existing routing"],
    ).kind, "regression-only");
    assert.equal(classifyRequirementObligation(
      { id: "R1", desc: "Verify delegated routing" },
      ["AC1 (R1): preserve the route unchanged"],
    ).kind, "preservation/non-interception");
  });
});
