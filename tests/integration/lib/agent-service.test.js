import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";

const roots = [];

function tmpDir() {
  const root = createTestDirectory("agent-svc-");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeAgent({ config, paths } = {}) {
  const root = paths?.root || tmpDir();
  const agentWorkDir = paths?.agentWorkDir || path.join(root, ".tmp");
  const cfg = config || {
    agent: {
      default: "claude/opus",
      timeout: 300,
    },
  };
  const resolvedPaths = {
    root,
    agentWorkDir,
    ...(paths || {}),
  };
  const registry = new ProviderRegistry(cfg.agent?.providers || {});
  const logger = new Logger({ logDir: testTemporaryRoot().path, enabled: false });
  return new Agent({ config: cfg, paths: resolvedPaths, registry, logger });
}

describe("Agent.resolve(commandId)", () => {
  it("resolves bare built-in default provider family keys", () => {
    const agent = makeAgent({ config: { agent: { default: "codex" } } });
    const resolved = agent.resolve("workflow.publish");
    assert.ok(resolved);
    assert.equal(resolved.profileKey, "codex/gpt-5.6-terra-medium");
    assert.equal(resolved.profile.command, "codex");
  });
});

describe("Agent.call() — dry run and resolution failure", () => {
  it("returns an empty asynchronous dry run without a configured provider", async () => {
    const agent = makeAgent({ config: { agent: {} } });
    const result = agent.call("ignored", { commandId: "test", _dryRun: true });
    assert.ok(result instanceof Promise);
    assert.equal(await result, "");
  });

  it("includes bounded resolution context when no provider resolves", async () => {
    const agent = makeAgent({
      config: {
        agent: {
          default: "missing-provider",
          useProfile: "codex-only",
          profiles: {
            "codex-only": {},
          },
        },
      },
    });

    await assert.rejects(
      agent.call("PROMPT_SHOULD_NOT_LEAK", {
        commandId: "workflow.publish",
        systemPrompt: "SYSTEM_SHOULD_NOT_LEAK",
        retryCount: 0,
      }),
      (err) => {
        assert.match(err.message, /commandId=workflow\.publish/);
        assert.match(err.message, /providerOverride=none/);
        assert.match(err.message, /profileSource=useProfile/);
        assert.match(err.message, /activeProfile=codex-only/);
        assert.match(err.message, /default=missing-provider/);
        assert.doesNotMatch(err.message, /PROMPT_SHOULD_NOT_LEAK/);
        assert.doesNotMatch(err.message, /SYSTEM_SHOULD_NOT_LEAK/);
        return true;
      },
    );
  });
});

describe("Agent — workDir auto-injection", () => {
  it("appends [workDirFlag, paths.agentWorkDir] to args when provider declares workDirFlag", () => {
    const root = tmpDir();
    const agentWorkDir = path.join(root, ".tmp");
    const cfg = { agent: { default: "codex/gpt-5.6-terra-medium", timeout: 300 } };
    const agent = makeAgent({ config: cfg, paths: { root, agentWorkDir } });
    const built = agent._buildInvocationForTest("hello", { commandId: "test" });
    const idx = built.finalArgs.indexOf("-C");
    assert.notEqual(idx, -1, "expected -C flag to be injected");
    assert.equal(built.finalArgs[idx + 1], agentWorkDir);
  });

  it("does NOT inject anything for providers with workDirFlag === null (e.g. claude)", () => {
    const cfg = { agent: { default: "claude/opus", timeout: 300 } };
    const agent = makeAgent({ config: cfg });
    const built = agent._buildInvocationForTest("hello", { commandId: "test" });
    assert.equal(built.finalArgs.indexOf("-C"), -1);
  });
});

describe("Agent — argv-size threshold (config-driven)", () => {
  it("uses config.agent.stdinFallbackThreshold when set", () => {
    const cfg = { agent: { default: "claude/opus", timeout: 300, stdinFallbackThreshold: 100 } };
    const agent = makeAgent({ config: cfg });
    const built = agent._buildInvocationForTest("X".repeat(500), { commandId: "test" });
    assert.notEqual(built.stdinContent, null, "should fall back to stdin when prompt exceeds 100-byte threshold");
  });

  it("defaults to 100000 bytes when stdinFallbackThreshold is unset", () => {
    const cfg = { agent: { default: "claude/opus", timeout: 300 } };
    const agent = makeAgent({ config: cfg });
    // 50_000 bytes — under 100_000 default
    const built = agent._buildInvocationForTest("X".repeat(50_000), { commandId: "test" });
    assert.equal(built.stdinContent, null, "should NOT fall back to stdin under default threshold");
  });
});

describe("Agent — retry bounds (R9)", () => {
  it("clamps retryCount to a maximum of 5", () => {
    const agent = makeAgent();
    const clamped = agent._normalizeRetryOptionsForTest({ retryCount: 999 });
    assert.equal(clamped.retryCount, 5);
  });

  it("uses default retryCount = 2 when omitted (spec 202)", () => {
    const agent = makeAgent();
    const normalized = agent._normalizeRetryOptionsForTest({});
    assert.equal(normalized.retryCount, 2);
  });

  it("uses default retryDelayMs = 3000 when omitted", () => {
    const agent = makeAgent();
    const normalized = agent._normalizeRetryOptionsForTest({});
    assert.equal(normalized.retryDelayMs, 3000);
  });
});
