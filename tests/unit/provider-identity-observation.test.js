import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider, CodexProvider } from "../../src/lib/provider.js";

test("Claude requested flags never become reported identity without response metadata", () => {
  const provider = new ClaudeProvider();
  assert.deepEqual(provider.requestedIdentity(["--model", "requested", "--effort", "high"]), { model: "requested", effort: "high" });
  assert.deepEqual(provider.parse(JSON.stringify({ result: "answer" })).reported, { model: null, effort: null });
  assert.deepEqual(provider.parse(JSON.stringify({ result: "answer", model: "actual", reasoning: { effort: "low" } })).reported,
    { model: "actual", effort: "low" });
});

test("Codex reports only explicit response metadata independently from requested config", () => {
  const provider = new CodexProvider();
  assert.deepEqual(provider.requestedIdentity(["-m", "requested", "-c", 'model_reasoning_effort="high"']), { model: "requested", effort: "high" });
  assert.deepEqual(provider.parse(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } })).reported,
    { model: null, effort: null });
  assert.deepEqual(provider.parse([
    JSON.stringify({ type: "thread.started", model: "actual", reasoning_effort: "medium" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }),
  ].join("\n")).reported, { model: "actual", effort: "medium" });
});


test("invalid external provider cost stays unknown while reported zero remains zero", () => {
  const provider = new ClaudeProvider();
  for (const cost of ["0", -1, null]) {
    assert.equal(provider.parse(JSON.stringify({ result: "answer", total_cost_usd: cost })).usage.cost_usd, null);
  }
  assert.equal(provider.parse(JSON.stringify({ result: "answer", total_cost_usd: 0 })).usage.cost_usd, 0);
});
