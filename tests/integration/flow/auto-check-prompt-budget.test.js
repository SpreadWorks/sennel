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
