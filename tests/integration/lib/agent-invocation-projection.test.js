import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  Agent,
  MAX_AGENT_ARGUMENT_BYTES,
  ResolvedAgentInvocationProjection,
} from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import {
  PromptInvocationProjectionOverflowFailure,
  PromptRequestLimit,
} from "../../../src/lib/prompt-batching.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeAgent(profile, agentOverrides = {}, supervision = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-projection-"));
  roots.push(root);
  const agentWorkDir = path.join(root, ".tmp");
  const config = {
    agent: {
      default: "test/exec",
      providers: { "test/exec": profile },
      timeout: 30,
      ...agentOverrides,
    },
  };
  return {
    root,
    agentWorkDir,
    agent: new Agent({
      config,
      paths: { root, agentWorkDir },
      registry: new ProviderRegistry(config.agent.providers),
      logger: new Logger({ logDir: root, enabled: false }),
      supervision,
    }),
  };
}

describe("Agent.projectInvocation()", () => {
  it("projects the same transport argv and counts as actual invocation construction", () => {
    const { agent } = makeAgent({
      command: "worker",
      args: ["run", "{{PROMPT}}"],
      systemPromptFlag: "--system",
      jsonSchemaFlag: "--schema",
      jsonSchemaMode: "inline",
    });
    const options = {
      commandId: "test",
      systemPrompt: "system",
      jsonSchema: { type: "object" },
      fmtFallback: "unused fallback",
    };

    const projection = agent.projectInvocation("prompt", options);
    const invocation = agent._buildInvocationForTest("prompt", options);

    assert.ok(projection instanceof ResolvedAgentInvocationProjection);
    assert.deepEqual(projection.finalArgs, invocation.finalArgs);
    assert.equal(
      projection.argvByteCount,
      invocation.finalArgs.reduce((sum, argument) => sum + Buffer.byteLength(String(argument)), 0),
    );
    assert.equal(projection.schemaMode, "inline");
    assert.equal(projection.usesStdin, false);
  });

  it("counts a system prompt exactly once when the provider concatenates it into the user prompt", () => {
    const { agent } = makeAgent({ command: "worker", args: ["{{PROMPT}}"] });

    const projection = agent.projectInvocation("user", {
      commandId: "test",
      systemPrompt: "system",
    });

    assert.equal(projection.systemPromptCharacterCount, 6);
    assert.equal(projection.promptCharacterCount, "system\n\nuser".length);
    assert.deepEqual(projection.finalArgs, ["system\n\nuser"]);
  });

  it("counts every provider-visible prompt substitution and its template wrapper", () => {
    const { agent } = makeAgent({
      command: "worker",
      args: ["prefix={{PROMPT}}", "copy={{PROMPT}}"],
    });

    const projection = agent.projectInvocation("abc", { commandId: "test" });

    assert.equal(projection.promptCharacterCount, "prefix=abc".length + "copy=abc".length);
    assert.deepEqual(projection.finalArgs, ["prefix=abc", "copy=abc"]);
  });

  it("keeps character limits independent from UTF-8 argv byte fallback", () => {
    const { agent } = makeAgent(
      { command: "worker", args: ["{{PROMPT}}"] },
      { stdinFallbackThreshold: 10 },
    );

    const projection = agent.projectInvocation("漢".repeat(4), { commandId: "test" });

    assert.equal(projection.promptCharacterCount, 4);
    assert.equal(projection.inlineArgvByteCount, 12);
    assert.equal(projection.argvByteCount, 0);
    assert.equal(projection.usesStdin, true);
  });

  it("accounts for adapted file schema content without creating a schema file", () => {
    const { agent, agentWorkDir } = makeAgent({
      command: "worker",
      args: ["{{PROMPT}}"],
      jsonSchemaFlag: "--schema",
      jsonSchemaMode: "file",
    });
    const schema = { type: "object", required: ["result"] };

    const projection = agent.projectInvocation("prompt", {
      commandId: "test",
      jsonSchema: schema,
    });

    assert.equal(projection.schemaMode, "file");
    assert.equal(projection.schemaCharacterCount, JSON.stringify(schema).length);
    assert.equal(
      projection.promptCharacterCount,
      "prompt".length + JSON.stringify(schema).length,
    );
    assert.equal(fs.existsSync(agentWorkDir), false);

    const invocation = agent._buildInvocationForTest("prompt", {
      commandId: "test",
      jsonSchema: schema,
    });
    assert.equal(invocation.pendingSchemaWrite.content, JSON.stringify(schema));
    assert.equal(fs.existsSync(invocation.pendingSchemaWrite.path), false);
    assert.equal(projection.argvByteCount, invocation.finalArgs.reduce(
      (sum, argument) => sum + Buffer.byteLength(String(argument)),
      0,
    ));
  });

  it("projects prompt fallback when the resolved profile cannot transport a schema", () => {
    const { agent } = makeAgent({
      command: "worker",
      args: ["{{PROMPT}}"],
      jsonSchemaFlag: "--schema",
    });

    const projection = agent.projectInvocation("prompt", {
      commandId: "test",
      jsonSchema: { type: "object" },
      fmtFallback: "format exactly",
    });

    assert.equal(projection.schemaMode, "fallback");
    assert.equal(projection.schemaCharacterCount, 0);
    assert.equal(projection.promptCharacterCount, "format exactly\n\nprompt".length);
    assert.deepEqual(projection.finalArgs, ["format exactly\n\nprompt"]);
  });

  it("refuses an oversized final projection before spawning the provider", async () => {
    let spawnCount = 0;
    const { agent } = makeAgent(
      { command: "worker", args: ["{{PROMPT}}"] },
      { promptCharacterLimit: 1_000 },
      { spawn() {
        spawnCount += 1;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      } },
    );
    const projection = agent.projectInvocation("x".repeat(1_001), { commandId: "test" });

    assert.equal(projection.fits(agent.promptCharacterLimit), false);
    assert.throws(
      () => projection.assertWithinLimit(new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit })),
      (error) => (
        error instanceof PromptInvocationProjectionOverflowFailure
        && error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW"
        && error.details.actualCharacters === 1_001
        && error.details.maximumCharacters === 1_000
      ),
    );
    await assert.rejects(
      agent.call("x".repeat(1_001), { commandId: "test", retryCount: 0 }),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
    );
    assert.equal(spawnCount, 0);
  });

  it("refuses a residual non-ASCII system argument that cannot be made safe by stdin fallback", async () => {
    let spawnCount = 0;
    const { agent } = makeAgent(
      { command: "worker", args: ["{{PROMPT}}"], systemPromptFlag: "--system" },
      {},
      { spawn() { spawnCount += 1; } },
    );
    const systemPrompt = "😀".repeat(44_000);
    const projection = agent.projectInvocation("small", { commandId: "test", systemPrompt });

    assert.equal(projection.usesStdin, true);
    assert.ok(projection.maxArgumentByteCount > MAX_AGENT_ARGUMENT_BYTES);
    assert.equal(projection.fits(agent.promptCharacterLimit), false);
    assert.throws(
      () => projection.assertWithinLimit(agent.promptCharacterLimit),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW"
        && error.details.actualArgumentBytes === Buffer.byteLength(systemPrompt),
    );
    await assert.rejects(
      agent.call("small", { commandId: "test", systemPrompt, retryCount: 0 }),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
    );
    assert.equal(spawnCount, 0);
  });

  it("resolves a relative execution directory identically for projection and materialization", () => {
    const { root, agent } = makeAgent({
      command: "worker",
      args: ["{{PROMPT}}"],
      workDirFlag: "--cwd",
    });
    const options = { commandId: "test", executionWorkDir: "nested/work" };

    const projection = agent.projectInvocation("prompt", options);
    const invocation = agent._buildInvocationForTest("prompt", options);

    assert.deepEqual(projection.finalArgs, invocation.finalArgs);
    assert.deepEqual(projection.finalArgs, ["prompt", "--cwd", path.join(root, "nested/work")]);
  });
});
