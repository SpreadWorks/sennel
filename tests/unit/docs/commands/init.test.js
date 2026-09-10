import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import os from "os";
import fs from "fs";
import { aiFilterChapters } from "../../../../src/docs/commands/init.js";
import { Agent } from "../../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../../src/lib/provider.js";
import { Logger } from "../../../../src/lib/log.js";

const CHAPTERS = [
  { fileName: "overview.md", content: "# Overview\nProject overview." },
  { fileName: "stack_and_ops.md", content: "# Stack & Ops\nTechnology stack." },
  { fileName: "development.md", content: "# Development\nDev setup." },
  { fileName: "db_tables.md", content: "# DB Tables\nDatabase tables." },
  { fileName: "commands.md", content: "# Commands\nBatch jobs." },
];

const ANALYSIS = {
  analyzedAt: "2026-01-01",
  files: { summary: { total: 5 } },
};

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeAgent(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
  roots.push(root);
  const config = {
    agent: { default: "test/exec", providers: { "test/exec": profile }, timeout: 300 },
  };
  const registry = new ProviderRegistry(config.agent.providers);
  return new Agent({
    config,
    paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry,
    logger: new Logger({ logDir: os.tmpdir(), enabled: false }),
  });
}

function respondingAgent(response) {
  return makeAgent({
    command: "node",
    args: ["-e", `process.stdout.write(${JSON.stringify(response)})`, "{{PROMPT}}"],
  });
}

function throwingAgent() {
  return makeAgent({
    command: "node",
    args: ["-e", "process.exit(1)", "{{PROMPT}}"],
  });
}

describe("aiFilterChapters", () => {
  it("filters chapters based on valid AI JSON response", async () => {
    const agent = respondingAgent('{"chapters":["overview.md","development.md"]}');
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((c) => c.fileName), ["overview.md", "development.md"]);
  });

  it("returns all chapters when AI returns invalid JSON", async () => {
    const agent = respondingAgent("not valid json at all");
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, CHAPTERS.length);
  });

  it("returns all chapters when AI returns empty array", async () => {
    const agent = respondingAgent('{"chapters":[]}');
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, CHAPTERS.length);
  });

  it("returns all chapters when AI call throws", async () => {
    const agent = throwingAgent();
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, CHAPTERS.length);
  });

  it("returns all chapters when AI returns a root array", async () => {
    const agent = respondingAgent('["overview.md"]');
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, CHAPTERS.length);
  });

  it("strips markdown fences from AI response", async () => {
    const agent = respondingAgent('```json\n{"chapters":["overview.md","development.md"]}\n```');
    const result = await aiFilterChapters(CHAPTERS, ANALYSIS, agent, process.cwd(), "");
    assert.equal(result.length, 2);
  });
});
