import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import {
  DEFAULT_PROMPT_CHARACTER_LIMIT,
  loadJsonFile,
  loadPackageField,
  loadConfig,
  loadRawConfig,
  resolvePromptCharacterLimit,
  resolveWorkDir,
} from "../../../src/lib/config.js";
import { createTmpDir, removeTmpDir, writeJson, writeFile } from "../../support/builders/tmp-dir.js";

describe("loadJsonFile", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("loads a valid JSON file", () => {
    tmp = createTmpDir();
    writeJson(tmp, "data.json", { key: "value" });
    const result = loadJsonFile(join(tmp, "data.json"));
    assert.deepEqual(result, { key: "value" });
  });

  it("throws when file is missing", () => {
    assert.throws(() => loadJsonFile("/nonexistent/file.json"), /Missing file/);
  });
});

describe("loadPackageField", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns the field value", () => {
    tmp = createTmpDir();
    writeJson(tmp, "package.json", { name: "test-pkg", version: "1.0.0" });
    assert.equal(loadPackageField(tmp, "name"), "test-pkg");
    assert.equal(loadPackageField(tmp, "version"), "1.0.0");
  });

  it("returns undefined when field is missing", () => {
    tmp = createTmpDir();
    writeJson(tmp, "package.json", { name: "test" });
    assert.equal(loadPackageField(tmp, "missing"), undefined);
  });

  it("returns undefined when package.json is missing", () => {
    tmp = createTmpDir();
    assert.equal(loadPackageField(tmp, "name"), undefined);
  });
});

describe("loadConfig", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("loads and validates config", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    const cfg = loadConfig(tmp);
    assert.equal(cfg.lang, "ja");
    assert.equal(cfg.type, "sample-command");
    assert.equal(cfg.docs.defaultLanguage, "ja");
  });

  it("validates flow.hooks as a string map", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      flow: {
        hooks: {
          PostWorktree: "printf ok",
          CustomHook: "printf custom",
        },
      },
    });
    const cfg = loadConfig(tmp);
    assert.equal(cfg.flow.hooks.PostWorktree, "printf ok");
    assert.equal(cfg.flow.hooks.CustomHook, "printf custom");

    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      flow: {
        hooks: {
          CustomHook: ["printf", "custom"],
        },
      },
    });
    assert.throws(() => loadConfig(tmp), /flow\.hooks\.CustomHook: must be string/);
  });

  it("accepts only repository-relative normalized flow.specDir values", () => {
    tmp = createTmpDir();
    const base = {
      lang: "ja",
      type: "sample-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
    };
    writeJson(tmp, ".sennel/config.json", {
      ...base,
      flow: { specDir: "flow-artifacts/specs" },
    });
    assert.equal(loadConfig(tmp).flow.specDir, "flow-artifacts/specs");

    for (const specDir of ["/tmp/specs", "../specs", "specs//nested", "specs\\nested"]) {
      writeJson(tmp, ".sennel/config.json", { ...base, flow: { specDir } });
      assert.throws(() => loadConfig(tmp), /flow\.specDir/);
    }
  });

  it("throws when config is missing", () => {
    tmp = createTmpDir();
    assert.throws(() => loadConfig(tmp), /Missing file/);
  });

  it("merges ignored local config overlay into plugin sources and packages by id", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      plugin: {
        sources: [{ id: "public", type: "local", path: "./plugins/public" }],
        packages: [{ id: "public-plugin", source: "public", commit: "a".repeat(40) }],
        config: { public: { enabled: true } },
      },
    });
    writeJson(tmp, ".sennel/config.local.json", {
      plugin: {
        sources: [
          { id: "private", type: "git", url: "git@example.invalid:private/plugin.git" },
          { id: "public", type: "local", path: "./local-public" },
        ],
        packages: [{ id: "private-plugin", source: "private", commit: "b".repeat(40) }],
        config: { private: { enabled: true } },
      },
    });

    const raw = loadRawConfig(tmp);
    assert.deepEqual(raw.plugin.sources, [
      { id: "public", type: "local", path: "./local-public" },
      { id: "private", type: "git", url: "git@example.invalid:private/plugin.git" },
    ]);
    assert.deepEqual(raw.plugin.packages, [
      { id: "public-plugin", source: "public", commit: "a".repeat(40) },
      { id: "private-plugin", source: "private", commit: "b".repeat(40) },
    ]);
    assert.equal(raw.plugin.config.public.enabled, true);
    assert.equal(raw.plugin.config.private.enabled, true);
    assert.equal(loadConfig(tmp).plugin.packages.length, 2);
  });
});

describe("resolveWorkDir", () => {
  let savedEnv;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SENNEL_WORK_DIR;
    else process.env.SENNEL_WORK_DIR = savedEnv;
  });

  it("ignores SENNEL_WORK_DIR and uses config.agent.workDir", () => {
    savedEnv = process.env.SENNEL_WORK_DIR;
    process.env.SENNEL_WORK_DIR = ".env-work";
    assert.equal(resolveWorkDir("/project", { agent: { workDir: ".config-work" } }), "/project/.config-work");
  });

  it("uses agentWorkDir override before config.agent.workDir", () => {
    assert.equal(
      resolveWorkDir("/project", { agent: { workDir: ".config-work" } }, { agentWorkDirOverride: ".agent-work" }),
      "/project/.agent-work",
    );
  });
});

describe("resolvePromptCharacterLimit", () => {
  it("defaults to the global 120000-character hard maximum", () => {
    assert.equal(DEFAULT_PROMPT_CHARACTER_LIMIT, 120_000);
    assert.equal(resolvePromptCharacterLimit({}), 120_000);
  });

  it("uses the configured lower character limit", () => {
    assert.equal(
      resolvePromptCharacterLimit({ agent: { promptCharacterLimit: 12_000 } }),
      12_000,
    );
  });
});
