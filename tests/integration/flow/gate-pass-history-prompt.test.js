import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGuardrailPrompt,
  buildPassedGuardrails,
} from "../../../src/flow/lib/run-gate.js";

const GUARDRAILS = [
  { id: "g1", title: "G1", body: "body1", meta: { category: "test", phase: ["draft"] } },
  { id: "g2", title: "G2", body: "body2", meta: { category: "test", phase: ["draft"] } },
  { id: "g3", title: "G3", body: "body3", meta: { category: "test", phase: ["draft"] } },
];

describe("pass history prompt injection (spec 229)", () => {
  it("includes Previously Passed Guardrails section when previouslyPassed is provided", () => {
    const prompt = buildGuardrailPrompt("some content", GUARDRAILS, "draft", null, ["g1", "g2"]);
    assert.ok(prompt, "prompt should not be null");
    assert.ok(prompt.includes("Previously Passed Guardrails"), "prompt should contain Previously Passed Guardrails section");
    assert.ok(prompt.includes("g1"), "prompt should list g1");
    assert.ok(prompt.includes("g2"), "prompt should list g2");
  });

  it("does not include Previously Passed Guardrails section when previouslyPassed is empty", () => {
    const prompt = buildGuardrailPrompt("some content", GUARDRAILS, "draft", null, []);
    assert.ok(prompt, "prompt should not be null");
    assert.ok(!prompt.includes("Previously Passed Guardrails"), "prompt should not contain Previously Passed Guardrails section");
  });

  it("does not include Previously Passed Guardrails section when previouslyPassed is undefined", () => {
    const prompt = buildGuardrailPrompt("some content", GUARDRAILS, "draft");
    assert.ok(prompt, "prompt should not be null");
    assert.ok(!prompt.includes("Previously Passed Guardrails"), "prompt should not contain Previously Passed Guardrails section");
  });

  it("produces identical prompt with and without empty previouslyPassed", () => {
    const promptWithout = buildGuardrailPrompt("content", GUARDRAILS, "draft");
    const promptWithEmpty = buildGuardrailPrompt("content", GUARDRAILS, "draft", null, []);
    assert.equal(promptWithout, promptWithEmpty);
  });
});

describe("buildPassedGuardrails", () => {
  it("extracts pass-only guardrail IDs", () => {
    const evals = [
      { guardrail_id: "g1", result: "pass" },
      { guardrail_id: "g2", result: "fail" },
      { guardrail_id: "g3", result: "pass" },
    ];
    assert.deepEqual(buildPassedGuardrails(evals), ["g1", "g3"]);
  });

  it("returns empty array for all-fail evaluations", () => {
    const evals = [{ guardrail_id: "g1", result: "fail" }];
    assert.deepEqual(buildPassedGuardrails(evals), []);
  });
});
