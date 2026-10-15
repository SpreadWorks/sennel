import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGitHubConfig, validateGitHubConfig, GitHubProviderConfig } from "../../../src/lib/github/config.js";
import { GitHubRepository } from "../../../src/lib/github/values.js";
import { validate } from "../../../src/lib/config.js";

const base = { lang: "ja", type: "base", docs: { languages: ["ja"], defaultLanguage: "ja" } };

describe("GitHub provider configuration", () => {
  it("resolves the built-in gh defaults and preserves omitted PR route policy", () => {
    const resolved = resolveGitHubConfig({});
    assert.ok(resolved instanceof GitHubProviderConfig);
    assert.deepEqual({ provider: resolved.provider, command: resolved.command, args: resolved.args, timeout: resolved.timeout, maxBuffer: resolved.maxBuffer, maxAttempts: resolved.maxAttempts }, {
      provider: "gh", command: "gh", args: [], timeout: 30_000, maxBuffer: 4_194_304, maxAttempts: 2,
    });
    assert.equal(validate({ ...base }).commands, undefined);
  });

  it("resolves named executable settings and retains repository context", () => {
    const config = {
      github: {
        provider: "fixture",
        providers: { fixture: { command: "/opt/provider", args: ["--json"], timeout: 12_000, maxBuffer: 1024, maxAttempts: 4 } },
        repository: { host: "github.example", name: "owner/repo" },
      },
    };
    validate({ ...base, ...config });
    const resolved = resolveGitHubConfig(config);
    assert.deepEqual({ provider: resolved.provider, command: resolved.command, args: resolved.args, timeout: resolved.timeout, maxBuffer: resolved.maxBuffer, maxAttempts: resolved.maxAttempts, repository: resolved.repository.toJSON() }, {
      provider: "fixture", command: "/opt/provider", args: ["--json"], timeout: 12_000, maxBuffer: 1024, maxAttempts: 4, repository: { host: "github.example", name: "owner/repo" },
    });
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(resolved.args), true);
    assert.equal(Object.isFrozen(resolved.repository), true);
    assert.ok(resolved.repository instanceof GitHubRepository);
    assert.throws(() => { resolved.args.push("mutable"); }, TypeError);
    assert.throws(() => { resolved.repository.name = "other/repo"; }, TypeError);
    assert.throws(() => resolveGitHubConfig({ github: { provider: "secret-token-value" } }), /unknown provider/);
    assert.throws(() => resolveGitHubConfig({ github: { provider: "fixture", providers: { fixture: { command: " ", args: [] } } } }), /command/);
  });

  it("validates provider references, reserved gh, arguments, numeric bounds, and repository identity", () => {
    assert.throws(() => validate({ ...base, github: { provider: "missing" } }), /unknown provider/);
    assert.throws(() => validate({ ...base, github: { providers: { gh: { command: "other", args: [] } } } }), /reserved/);
    assert.throws(() => validate({ ...base, github: { providers: { custom: { command: " ", args: [2] } } } }), /command|args/);
    assert.throws(() => validate({ ...base, github: { timeout: 0 } }), /timeout/);
    assert.throws(() => validate({ ...base, github: { maxBuffer: 1.5 } }), /maxBuffer/);
    assert.throws(() => validate({ ...base, github: { maxAttempts: 6 } }), /maxAttempts/);
    assert.throws(() => validate({ ...base, github: { repository: { host: "github.com", name: "owner" } } }), /repository.name/);
  });

  it("accepts only Node-safe integer timeouts and safe integer output limits", () => {
    assert.equal(resolveGitHubConfig({ github: { timeout: 2_147_483_647, maxBuffer: Number.MAX_SAFE_INTEGER } }).timeout, 2_147_483_647);
    for (const timeout of [0.5, 0, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validate({ ...base, github: { timeout } }), /timeout/);
      assert.throws(() => resolveGitHubConfig({ github: { timeout } }), /timeout/);
    }
    assert.throws(() => validate({ ...base, github: { maxBuffer: Number.MAX_SAFE_INTEGER + 1 } }), /maxBuffer/);
    assert.throws(() => resolveGitHubConfig({ github: { maxBuffer: Number.MAX_SAFE_INTEGER + 1 } }), /maxBuffer/);
  });

  it("appends validation errors without throwing", () => {
    const errors = [];
    validateGitHubConfig({ github: { provider: "missing" } }, errors);
    assert.deepEqual(errors, ["'github.provider': unknown provider"]);
  });
});
