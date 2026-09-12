import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeForgeAgentPrompt } from "../../../../src/docs/lib/documentation-forge-batching.js";

describe("documentation forge prompt batching", () => {
  it("executes a bounded atomic prompt through provider projection and a typed reducer", async () => {
    const calls = [];
    const projections = [];
    const result = await executeForgeAgentPrompt({
      agent: {
        async projectInvocation(prompt, options) {
          projections.push({ prompt, options });
          return { assertWithinLimit(limit) { assert.equal(limit.maxCharacters, 4000); } };
        },
        async call(prompt, options) {
          calls.push({ prompt, options });
          return "forge completed";
        },
      },
      prompt: "Edit the referenced targets.",
      systemPrompt: "Follow repository instructions.",
      maxCharacters: 4000,
    });

    assert.equal(result, "forge completed");
    assert.equal(projections.length, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Edit the referenced targets/);
    assert.equal(calls[0].options.systemPrompt, "Follow repository instructions.");
    assert.ok(calls[0].options.providerCallAdmission);
  });

  it("rejects projected provider overflow before invoking forge", async () => {
    let calls = 0;
    await assert.rejects(
      executeForgeAgentPrompt({
        agent: {
          async projectInvocation() {
            return {
              assertWithinLimit() {
                const error = new Error("provider projection overflow");
                error.code = "PROMPT_INVOCATION_PROJECTION_OVERFLOW";
                throw error;
              },
            };
          },
          async call() { calls += 1; return "unexpected"; },
        },
        prompt: "Edit docs.",
        maxCharacters: 4000,
      }),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
    );
    assert.equal(calls, 0);
  });
});
