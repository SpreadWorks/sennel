import assert from "node:assert/strict";
import { it } from "node:test";
import { ClaudeProvider, CodexProvider, ProviderRegistry } from "../../src/lib/provider.js";

it("preserves partial Claude measurements and distinguishes reported zero from missing usage", () => {
  const provider = new ClaudeProvider();
  const missing = provider.parse(JSON.stringify({ result: "response" })).usage;
  assert.deepEqual(missing, { input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, cost_usd: null });
  const partial = provider.parse(JSON.stringify({ result: "response", usage: {
    input_tokens: 0, cache_creation_input_tokens: 0,
  }, total_cost_usd: 0 })).usage;
  assert.deepEqual(partial, { input_tokens: 0, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: 0, cost_usd: 0 });
});

const codexCases = [
    ["normalizes Codex cache reads and explicit cache writes", { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, cache_write_input_tokens: 3 },
      { input_tokens: 6, output_tokens: 2, cache_read_tokens: 4, cache_creation_tokens: 3, cost_usd: null }],
    ["preserves explicit Codex zero measurements", { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0 },
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null }],
    ["keeps Codex derived input unknown without the cache read operand", { input_tokens: 10 },
      { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, cost_usd: null }],
    ["keeps Codex derived input unknown without the raw input operand", { cached_input_tokens: 4 },
      { input_tokens: null, output_tokens: null, cache_read_tokens: 4, cache_creation_tokens: null, cost_usd: null }],
];
for (const [name, usage, expected] of codexCases) {
  it(name, () => {
    const provider = new CodexProvider();
    assert.deepEqual(provider.parse(JSON.stringify({ type: "turn.completed", usage })).usage, expected);
  });
}

it("keeps all Codex measurements unknown when no completed turn reported usage", () => {
  const provider = new CodexProvider();
  assert.deepEqual(provider.parse(JSON.stringify({ type: "item.completed", item: {
    type: "agent_message", text: "response",
  } })).usage, { input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, cost_usd: null });
});

it("keeps plain-text provider usage unavailable", () => {
  const registry = new ProviderRegistry({ local: { command: "local-fixture", args: [] } });
  assert.deepEqual(registry.resolveProfile("local").provider.parse("response"), { text: "response", usage: null });
});

it("keeps malformed provider token measurements unknown", () => {
  for (const invalid of ["12", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const claude = new ClaudeProvider().parse(JSON.stringify({ result: "response", usage: {
      input_tokens: invalid, output_tokens: invalid,
      cache_read_input_tokens: invalid, cache_creation_input_tokens: invalid,
    } })).usage;
    const codex = new CodexProvider().parse(JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: invalid, output_tokens: invalid,
      cached_input_tokens: invalid, cache_write_input_tokens: invalid,
    } })).usage;
    const unknown = { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null, cost_usd: null };
    assert.deepEqual(claude, unknown);
    assert.deepEqual(codex, unknown);
  }
});

it("does not report a negative Codex input when cache reads exceed reported input", () => {
  const usage = new CodexProvider().parse(JSON.stringify({ type: "turn.completed", usage: {
    input_tokens: 5, cached_input_tokens: 6, output_tokens: 0,
  } })).usage;
  assert.deepEqual(usage, { input_tokens: null, output_tokens: 0, cache_read_tokens: 6,
    cache_creation_tokens: null, cost_usd: null });
});
