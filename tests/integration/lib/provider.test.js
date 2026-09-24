import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Provider, ClaudeProvider, CodexProvider, ProviderRegistry } from "../../../src/lib/provider.js";
import { defaultAgentProfiles } from "../../../src/lib/agent-defaults.js";

describe("Provider (abstract base)", () => {
  it("exposes the expected method surface", () => {
    const p = new Provider();
    assert.equal(typeof p.parse, "function");
    assert.equal(typeof p.systemPromptFlag, "function");
    assert.equal(typeof p.workDirFlag, "function");
    assert.equal(typeof p.builtinProfiles, "function");
    assert.equal(typeof p.jsonFlag, "undefined");
  });

  it("parse() on the base class throws (abstract)", () => {
    const p = new Provider();
    assert.throws(() => p.parse("ignored"));
  });

  it("default systemPromptFlag/workDirFlag/builtinProfiles return empty values", () => {
    const p = new Provider();
    assert.equal(p.systemPromptFlag(), null);
    assert.equal(p.workDirFlag(), null);
    assert.deepEqual(p.builtinProfiles(), {});
  });
});

describe("ClaudeProvider", () => {
  const provider = new ClaudeProvider();

  it("static key is \"claude\"", () => {
    assert.equal(ClaudeProvider.key, "claude");
  });

  it("declares systemPromptFlag = '--system-prompt'", () => {
    assert.equal(provider.systemPromptFlag(), "--system-prompt");
  });

  it("declares workDirFlag = null (claude does not use a workdir flag)", () => {
    assert.equal(provider.workDirFlag(), null);
  });

  it("builtin profiles include '--output-format json' literally in args", () => {
    const profiles = provider.builtinProfiles();
    for (const [key, profile] of Object.entries(profiles)) {
      const idx = profile.args.indexOf("--output-format");
      assert.notEqual(idx, -1, `${key} must include '--output-format' in args`);
      assert.equal(profile.args[idx + 1], "json");
    }
  });

  it("parse() extracts text and usage from claude JSON envelope", () => {
    const stdout = JSON.stringify({
      result: "hello",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      },
      total_cost_usd: 0.0025,
    });
    const { text, usage } = provider.parse(stdout);
    assert.equal(text, "hello");
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.cache_read_tokens, 3);
    assert.equal(usage.cache_creation_tokens, 1);
    assert.equal(usage.cost_usd, 0.0025);
  });

  it("parse() extracts result event from claude CLI array envelope (2.1.114+)", () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
      {
        type: "result",
        subtype: "success",
        result: "hello-array",
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        total_cost_usd: 0.0011,
      },
    ];
    const { text, usage } = provider.parse(JSON.stringify(events));
    assert.equal(text, "hello-array");
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, 4);
    assert.equal(usage.cache_read_tokens, 2);
    assert.equal(usage.cache_creation_tokens, 1);
    assert.equal(usage.cost_usd, 0.0011);
  });

  it("parse() throws a descriptive error when array envelope has no result event", () => {
    const stdout = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
    assert.throws(() => provider.parse(stdout), /no 'result' event/);
  });

  it("builtinProfiles includes claude/opus and claude/sonnet", () => {
    const profiles = provider.builtinProfiles();
    assert.ok(profiles["claude/opus"]);
    assert.ok(profiles["claude/sonnet"]);
    assert.equal(profiles["claude/opus"].command, "claude");
  });
});

describe("CodexProvider", () => {
  const provider = new CodexProvider();

  it("static key is \"codex\"", () => {
    assert.equal(CodexProvider.key, "codex");
  });

  it("declares workDirFlag = '-C' (codex requires explicit workdir)", () => {
    assert.equal(provider.workDirFlag(), "-C");
  });

  it("parse() extracts text and usage from codex NDJSON stream", () => {
    const events = [
      { type: "item.completed", item: { type: "agent_message", text: "world" } },
      { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 5 } },
    ];
    const stdout = events.map((e) => JSON.stringify(e)).join("\n");
    const { text, usage } = provider.parse(stdout);
    assert.equal(text, "world");
    assert.equal(usage.input_tokens, 15); // 20 - 5 cached
    assert.equal(usage.output_tokens, 8);
    assert.equal(usage.cache_read_tokens, 5);
    assert.equal(usage.cache_creation_tokens, 0);
  });

  it("parse() uses the final agent message when the stream contains progress messages", () => {
    const events = [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }),
        },
      },
      { type: "item.completed", item: { type: "command_execution", command: "rg example" } },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            blockingFindings: [{ title: "Final finding" }],
            nonBlockingImprovements: [],
          }),
        },
      },
      { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 12, cached_input_tokens: 10 } },
    ];

    const { text, usage } = provider.parse(events.map((event) => JSON.stringify(event)).join("\n"));

    assert.deepEqual(JSON.parse(text), {
      blockingFindings: [{ title: "Final finding" }],
      nonBlockingImprovements: [],
    });
    assert.equal(usage.input_tokens, 20);
    assert.equal(usage.output_tokens, 12);
  });

  it("builtinProfiles entries do NOT contain hardcoded workdir values like '-C .tmp'", () => {
    const profiles = provider.builtinProfiles();
    for (const [, profile] of Object.entries(profiles)) {
      const args = profile.args || [];
      const cIdx = args.indexOf("-C");
      assert.equal(cIdx, -1, `profile must not bake in '-C' workdir flag: got ${JSON.stringify(args)}`);
    }
  });

  it("builtin profiles include '--json' literally in args", () => {
    const profiles = provider.builtinProfiles();
    for (const [key, profile] of Object.entries(profiles)) {
      assert.ok(
        profile.args.includes("--json"),
        `${key} must include '--json' in args: got ${JSON.stringify(profile.args)}`,
      );
    }
  });

  it("builtin profiles use GPT-5.6 tiers with explicit reasoning effort", () => {
    const profiles = provider.builtinProfiles();
    const expected = {
      "codex/gpt-5.6-luna-low": ["gpt-5.6-luna", 'model_reasoning_effort="low"'],
      "codex/gpt-5.6-terra-low": ["gpt-5.6-terra", 'model_reasoning_effort="low"'],
      "codex/gpt-5.6-terra-medium": ["gpt-5.6-terra", 'model_reasoning_effort="medium"'],
      "codex/gpt-5.6-sol-medium": ["gpt-5.6-sol", 'model_reasoning_effort="medium"'],
    };

    assert.deepEqual(Object.keys(profiles).sort(), Object.keys(expected).sort());
    for (const [key, [model, effort]] of Object.entries(expected)) {
      const args = profiles[key].args;
      assert.equal(args[args.indexOf("-m") + 1], model);
      assert.equal(args[args.indexOf("-c") + 1], effort);
    }
  });
});

describe("ProviderRegistry", () => {
  it("resolves a provider instance by command substring", () => {
    const registry = new ProviderRegistry();
    const claude = registry.resolveByCommand("claude");
    const codex = registry.resolveByCommand("codex");
    assert.ok(claude instanceof ClaudeProvider);
    assert.ok(codex instanceof CodexProvider);
  });

  it("returns null for unknown commands (no string-match fallback)", () => {
    const registry = new ProviderRegistry();
    const result = registry.resolveByCommand("unknown-cli");
    assert.equal(result, null);
  });

  it("merges built-in profiles with user-provided profiles", () => {
    const userProviders = {
      "claude/custom": { command: "claude", args: ["-p", "{{PROMPT}}", "--model", "custom"] },
    };
    const registry = new ProviderRegistry(userProviders);
    const resolved = registry.resolveProfile("claude/custom");
    assert.ok(resolved);
    assert.ok(resolved.provider instanceof ClaudeProvider);
    assert.equal(resolved.profile.command, "claude");
  });

  it("returns null when profile key is not registered", () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.resolveProfile("nonexistent/key"), null);
    assert.equal(registry.resolveProfile("codex/gpt-5.4"), null);
  });
});

describe("built-in agent routing", () => {
  it("routes Codex work by GPT-6 tier and explicit effort", () => {
    const profiles = defaultAgentProfiles();
    const codexOnly = profiles["codex-only"];

    assert.equal(codexOnly["docs.readme"], "codex/gpt-6-luna-low");
    assert.equal(codexOnly["docs.text"], "codex/gpt-6-sol-low");
    assert.equal(codexOnly["flow.spec.gate"], "codex/gpt-6-sol-medium");
    assert.equal(codexOnly["flow.impl.review.final"], "codex/gpt-6-astra-medium");

    for (const profile of Object.values(profiles)) {
      for (const providerKey of Object.values(profile)) {
        assert.doesNotMatch(providerKey, /^codex\/gpt-5\.[345](?:$|-)/);
      }
    }
  });
});
