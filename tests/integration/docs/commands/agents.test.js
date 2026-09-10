import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson, writeFile } from "../../../support/builders/tmp-dir.js";
import { stubAgentConfig, writeStubAgentScript } from "../../../support/fakes/stub-agent.js";
import { runAgents } from "../../../../src/docs/commands/agents.js";
import { container, initContainer } from "../../../../src/lib/container.js";

const CMD = join(process.cwd(), "src/sennel.js");
const CMD_ARGS = ["docs", "agents"];

function projectDirectiveDocument(footer) {
  return [
    "# Fixture",
    "",
    '<!-- {{data("base.agents.flow")}} -->',
    "<!-- {{/data}} -->",
    "",
    '<!-- {{data("base.agents.project")}} -->',
    "<!-- {{/data}} -->",
    "",
    footer,
  ].join("\n");
}

function setupProjectDirectiveFixture(dir, { agent, footer }) {
  writeJson(dir, ".sennel/config.json", {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    agent,
  });
  writeJson(dir, ".sennel/output/analysis.json", { analyzedAt: "2026-01-01" });
  const original = projectDirectiveDocument(footer);
  writeFile(dir, "AGENTS.md", original);
  return original;
}

function assertAgentsCliFailure(dir) {
  assert.throws(
    () => execFileSync("node", [CMD, ...CMD_ARGS], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: dir, SENNEL_SOURCE_ROOT: dir },
    }),
    (error) => {
      assert.match(error.stderr, /AI agent call failed/);
      return true;
    },
  );
}

describe("agents CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("creates AGENTS.md from template when missing", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeJson(tmp, ".sennel/output/analysis.json", { analyzedAt: "2026-01-01" });
    writeJson(tmp, "package.json", { name: "test-pkg", version: "1.0.0" });

    assert.ok(!fs.existsSync(join(tmp, "AGENTS.md")), "AGENTS.md should not exist before");
    execFileSync("node", [CMD, ...CMD_ARGS], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.ok(fs.existsSync(join(tmp, "AGENTS.md")), "AGENTS.md should be created");
    const content = fs.readFileSync(join(tmp, "AGENTS.md"), "utf8");
    assert.ok(content.includes("Spec-Driven Development"), "should contain Spec-Driven Development section");
  });

  it("exits non-zero when analysis.json is missing", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeFile(tmp, "AGENTS.md", [
      '<!-- {{data("base.agents.flow")}} -->',
      '<!-- {{/data}} -->',
    ].join("\n"));

    try {
      execFileSync("node", [CMD, ...CMD_ARGS], {
        encoding: "utf8",
        env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      assert.match(err.stderr, /analysis\.json/);
    }
  });

  it("exits non-zero when no agent configured (for project directive)", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 5 } },
    });
    writeFile(tmp, "AGENTS.md", [
      '<!-- {{data("base.agents.flow")}} -->',
      '<!-- {{/data}} -->',
      '',
      '<!-- {{data("base.agents.project")}} -->',
      '<!-- {{/data}} -->',
    ].join("\n"));

    try {
      execFileSync("node", [CMD, ...CMD_ARGS], {
        encoding: "utf8",
        env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      assert.match(err.stderr, /default agent/i);
    }

    // File should remain unchanged (write only happens on success)
    const content = fs.readFileSync(join(tmp, "AGENTS.md"), "utf8");
    assert.match(content, /agents\.flow/);
  });

  it("resolves the flow directive when no project directive exists", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 5 } },
    });
    writeFile(tmp, "AGENTS.md", [
      '<!-- {{data("base.agents.flow")}} -->',
      '<!-- {{/data}} -->',
      '',
      'Custom content below',
    ].join("\n"));

    // No project directive = no AI needed = should succeed without agent
    execFileSync("node", [CMD, ...CMD_ARGS], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const content = fs.readFileSync(join(tmp, "AGENTS.md"), "utf8");
    // Spec-Driven Development template should be resolved
    assert.match(content, /## Sennel Flow/);
    // Custom content should remain
    assert.match(content, /Custom content below/);
    // Directive tags should still be present
    assert.match(content, /agents\.flow/);
  });

  it("publishes directly synthesized PROJECT output while preserving manual AGENTS sections", () => {
    tmp = createTmpDir();
    const stubPath = writeStubAgentScript(tmp, ".stub-agent.js", "## Project Context\n\n- Run npm test.");
    writeJson(tmp, ".sennel/config.json", {
      lang: "en",
      type: "base",
      docs: { languages: ["en"], defaultLanguage: "en" },
      agent: stubAgentConfig(stubPath),
    });
    writeJson(tmp, ".sennel/output/analysis.json", { analyzedAt: "2026-01-01" });
    writeJson(tmp, "package.json", { name: "fixture", version: "1.0.0", scripts: { test: "node --test" } });
    writeFile(tmp, "AGENTS.md", [
      "# Fixture",
      "",
      "Manual introduction stays unchanged.",
      "",
      '<!-- {{data("base.agents.project")}} -->',
      "<!-- {{/data}} -->",
      "",
      "Manual footer stays unchanged.",
    ].join("\n"));

    execFileSync("node", [CMD, ...CMD_ARGS], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const content = fs.readFileSync(join(tmp, "AGENTS.md"), "utf8");
    assert.match(content, /Manual introduction stays unchanged\./);
    assert.match(content, /## Project Context\n\n- Run npm test\./);
    assert.match(content, /Manual footer stays unchanged\./);
    assert.match(content, /agents\.project/);
  });

  it("publishes a fitting final PROJECT request with a validated configured limit", async () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "en",
      docs: { languages: ["en"], defaultLanguage: "en" },
      agent: { promptCharacterLimit: 1000 },
    });
    writeJson(tmp, ".sennel/output/analysis.json", { analyzedAt: "2026-01-01" });
    writeFile(tmp, "AGENTS.md", [
      "# Fixture",
      "",
      "## Sennel Flow",
      "",
      "Manual Flow section stays unchanged.",
      "",
      "Manual introduction stays unchanged.",
      "",
      '<!-- {{data("base.agents.project")}} -->',
      "<!-- {{/data}} -->",
      "",
      "Manual footer stays unchanged.",
    ].join("\n"));
    const previousWorkRoot = process.env.SENNEL_WORK_ROOT;
    const previousSourceRoot = process.env.SENNEL_SOURCE_ROOT;
    const previousPluginAgent = globalThis.__sennelPluginAgent;
    const calls = [];
    const agent = {
      resolve: () => ({ provider: "fixture" }),
      async call(prompt, options) {
        calls.push({ prompt, options });
        return "## Project Context\n\n- Run npm test.";
      },
      async projectInvocation() {
        return { assertWithinLimit(limit) { assert.equal(limit.maxCharacters, 1000); } };
      },
    };
    const t = Object.assign(() => "", { raw: () => ["Return repository instructions."] });

    try {
      process.env.SENNEL_WORK_ROOT = tmp;
      process.env.SENNEL_SOURCE_ROOT = tmp;
      container.reset();
      initContainer();
      container.set("agent", agent);
      await runAgents({
        root: tmp,
        srcRoot: tmp,
        config: {
          lang: "en",
          docs: { languages: ["en"], defaultLanguage: "en" },
          agent: { promptCharacterLimit: 1000 },
        },
        lang: "en",
        type: "base",
        t,
        dryRun: false,
      });
    } finally {
      container.reset();
      if (previousWorkRoot === undefined) delete process.env.SENNEL_WORK_ROOT;
      else process.env.SENNEL_WORK_ROOT = previousWorkRoot;
      if (previousSourceRoot === undefined) delete process.env.SENNEL_SOURCE_ROOT;
      else process.env.SENNEL_SOURCE_ROOT = previousSourceRoot;
      if (previousPluginAgent === undefined) delete globalThis.__sennelPluginAgent;
      else globalThis.__sennelPluginAgent = previousPluginAgent;
    }

    const content = fs.readFileSync(join(tmp, "AGENTS.md"), "utf8");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.jsonSchema, null);
    assert.match(content, /Manual Flow section stays unchanged\./);
    assert.match(content, /Manual introduction stays unchanged\./);
    assert.match(content, /## Project Context\n\n- Run npm test\./);
    assert.match(content, /Manual footer stays unchanged\./);
  });

  it("does not publish resolved directives when final PROJECT provider output fails", () => {
    tmp = createTmpDir();
    const failingStub = ".failing-agent.js";
    writeFile(tmp, failingStub, [
      'process.stderr.write("authentication failed");',
      "process.exit(1);",
    ].join("\n"));
    const original = setupProjectDirectiveFixture(tmp, {
      agent: stubAgentConfig(join(tmp, failingStub)),
      footer: "Manual footer remains byte-identical on failure.",
    });

    assertAgentsCliFailure(tmp);

    assert.equal(fs.readFileSync(join(tmp, "AGENTS.md"), "utf8"), original);
  });

  it("does not publish resolved directives when final PROJECT output is blank", () => {
    tmp = createTmpDir();
    const blankStub = writeStubAgentScript(tmp, ".blank-agent.js", "");
    const original = setupProjectDirectiveFixture(tmp, {
      agent: { ...stubAgentConfig(blankStub), retryCount: 1 },
      footer: "Manual footer remains byte-identical on blank output.",
    });

    assertAgentsCliFailure(tmp);

    assert.equal(fs.readFileSync(join(tmp, "AGENTS.md"), "utf8"), original);
  });
});
