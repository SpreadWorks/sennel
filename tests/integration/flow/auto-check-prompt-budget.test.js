import assert from "node:assert/strict";
import { it } from "node:test";
import { runAutoCheckCore } from "../../../src/flow/lib/run-auto-check.js";

it("auto-check rejects an unsplittable request before calling the provider", async () => {
  let calls = 0;
  const container = { get: () => ({
    resolve: () => true,
    call: async () => { calls += 1; throw new Error("provider must not receive oversized input"); },
  }) };
  const result = await runAutoCheckCore(container, "x".repeat(120000));
  assert.equal(result.eligible, false);
  assert.equal(result.failure.code, "PROMPT_ELEMENT_TOO_LARGE");
  assert.equal(calls, 0);
});

it("auto-check includes fixed schema and instructions in the configured request limit", async () => {
  let calls = 0;
  const container = { get: () => ({
    resolve: () => true, promptCharacterLimit: 4000,
    call: async () => { calls += 1; throw new Error("provider must not receive over-budget input"); },
  }) };
  const result = await runAutoCheckCore(container, "x".repeat(3900));
  assert.equal(result.eligible, false);
  assert.ok(["PROMPT_ELEMENT_TOO_LARGE", "PROMPT_FIXED_CONTEXT_TOO_LARGE"].includes(result.failure.code));
  assert.equal(calls, 0);
});

it("auto-check executes a valid response through the common executor and projection", async () => {
  let projected = false;
  let calls = 0;
  const container = { get: () => ({
    resolve: () => true,
    promptCharacterLimit: 120000,
    projectInvocation: (prompt, options) => {
      projected = true;
      assert.equal(options.commandId, "flow.auto-check");
      assert.equal(prompt, options.userPrompt);
      return { assertWithinLimit: () => {} };
    },
    call: async (_prompt, options) => {
      calls += 1;
      assert.equal(projected, true);
      assert.equal(options.commandId, "flow.auto-check");
      assert.ok(options.providerCallAdmission);
      return JSON.stringify({
        specBuildability: 2,
        ambiguity: 2,
        verifiability: 2,
        scopeBoundedness: 2,
        targetSpecificity: 2,
        precedent: 2,
        goal: "bounded goal",
        reason: "valid",
      });
    },
  }) };
  const result = await runAutoCheckCore(container, "add a bounded feature");
  assert.equal(result.eligible, true);
  assert.equal(result.score, 24);
  assert.equal(calls, 1);
});

it("auto-check fails closed for malformed and oversized provider responses", async () => {
  for (const response of ["not json", "x".repeat(120001)]) {
    let calls = 0;
    const container = { get: () => ({
      resolve: () => true,
      call: async () => {
        calls += 1;
        return response;
      },
    }) };
    const result = await runAutoCheckCore(container, "add a bounded feature");
    assert.equal(result.eligible, false);
    assert.ok(result.failure, `failure should be present for ${response.length} chars`);
    assert.ok(result.failure.code.startsWith("PROMPT_"));
    assert.equal(calls, 1);
  }
});
