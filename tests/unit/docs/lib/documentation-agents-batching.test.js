import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { synthesizeProjectInstructions } from "../../../../src/docs/lib/documentation-agents-batching.js";

describe("documentation AGENTS prompt batching", () => {
  it("synthesizes a fitting PROJECT request directly without constructing a summary round", async () => {
    const calls = [];
    const projections = [];
    const agent = {
      async call(prompt, options) {
        calls.push({ prompt, options });
        return "## Project\n\nRun npm test.";
      },
      async projectInvocation(prompt, options) {
        projections.push({ prompt, options });
        return { assertWithinLimit(limit) { assert.equal(limit.maxCharacters, 120_000); } };
      },
    };

    const result = await synthesizeProjectInstructions({
      contexts: [{ label: "PROJECT", text: "Run npm test." }],
      rules: "Return repository instructions.",
      agent,
      maxCharacters: 120_000,
    });

    assert.equal(result, "## Project\n\nRun npm test.");
    assert.equal(calls.length, 1);
    assert.equal(projections.length, 1);
    assert.equal(calls[0].options.jsonSchema, null);
    assert.match(calls[0].options.systemPrompt, /Produce the PROJECT section/);
    assert.doesNotMatch(calls[0].options.systemPrompt, /reduced repository context/);
  });

  it("uses the final envelope at a limit where summary fixed context cannot fit", async () => {
    const calls = [];
    const result = await synthesizeProjectInstructions({
      contexts: [{ label: "PROJECT", text: "Run npm test." }],
      rules: "Return repository instructions.",
      agent: {
        async call(prompt, options) {
          calls.push({ prompt, options });
          return "## Project\n\nRun npm test.";
        },
      },
      maxCharacters: 300,
    });

    assert.equal(result, "## Project\n\nRun npm test.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.jsonSchema, null);
  });

  it("rejects an oversized final fixed context before projection or provider calls", async () => {
    const calls = [];
    const projections = [];
    await assert.rejects(
      synthesizeProjectInstructions({
        contexts: [{ label: "PROJECT", text: "Run npm test." }],
        rules: "R".repeat(120_000),
        agent: {
          async call() { calls.push(true); return "unexpected"; },
          async projectInvocation() {
            projections.push(true);
            return { assertWithinLimit() {} };
          },
        },
        maxCharacters: 120_000,
      }),
      (error) => error.code === "PROMPT_FIXED_CONTEXT_TOO_LARGE",
    );

    assert.equal(calls.length, 0);
    assert.equal(projections.length, 0);
  });

  it("rejects projected final invocation overflow before its provider call", async () => {
    const calls = [];
    const projections = [];
    await assert.rejects(
      synthesizeProjectInstructions({
        contexts: [{ label: "PROJECT", text: "Run npm test." }],
        rules: "Return repository instructions.",
        agent: {
          async call() { calls.push(true); return "unexpected"; },
          async projectInvocation() {
            projections.push(true);
            return {
              assertWithinLimit() {
                const error = new Error("projected provider invocation is too large");
                error.code = "PROMPT_INVOCATION_PROJECTION_OVERFLOW";
                throw error;
              },
            };
          },
        },
        maxCharacters: 120_000,
      }),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
    );

    assert.equal(projections.length, 1);
    assert.equal(calls.length, 0);
  });

  it("does not produce PROJECT output when required oversized-context reduction fails to shrink", async () => {
    const calls = [];
    const agent = {
      async call(prompt, options) {
        calls.push({ prompt, options });
        return '{"summary":"' + "expanded factual summary ".repeat(600) + '"}';
      },
    };

    await assert.rejects(
      synthesizeProjectInstructions({
        contexts: [{ label: "Generated docs", text: "source fact\n".repeat(4_000) }],
        rules: "Return repository instructions.",
        agent,
        maxCharacters: 4_000,
      }),
      (error) => error.code === "PROMPT_REDUCTION_DID_NOT_CONVERGE",
    );

    assert.ok(calls.length > 0);
    assert.ok(calls.every(({ options }) => options.jsonSchema !== null), "a failed reduction must not call final PROJECT synthesis");
  });
});
