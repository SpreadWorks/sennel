import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson, writeFile } from "../../../support/builders/tmp-dir.js";

const CMD = join(process.cwd(), "src/sennel.js");
const CMD_ARGS = ["docs", "init"];

describe("init CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("creates docs/ from template", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-node-command"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const docsDir = join(tmp, "docs");
    assert.ok(fs.existsSync(docsDir), "docs/ should be created");
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    assert.ok(files.length > 0, "should have chapter files");
  });

  it("--dry-run shows files without writing", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    const result = execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-node-command", "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /DRY-RUN/);
    // docs/ should NOT have chapter files
    const docsDir = join(tmp, "docs");
    if (fs.existsSync(docsDir)) {
      const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, 0, "no files should be written in dry-run");
    }
  });

  it("shows help with --help", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });

    const result = execFileSync("node", [CMD, ...CMD_ARGS, "--help"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /--type/);
  });

  it("falls back to ja templates when en templates are missing (multi-lang)", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "en",
      type: "sample-preset",
      docs: { languages: ["en", "ja"], defaultLanguage: "en" },
    });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-preset", "--force"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const docsDir = join(tmp, "docs");
    assert.ok(fs.existsSync(docsDir), "docs/ should be created");
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    assert.deepEqual(files.sort(), ["overview.md", "project_structure.md", "stack_and_ops.md"]);
  });

  it("generates all sample-preset chapters with single lang en (en templates exist)", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "en",
      type: "sample-preset",
      docs: { languages: ["en"], defaultLanguage: "en" },
    });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-preset", "--force"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const docsDir = join(tmp, "docs");
    assert.ok(fs.existsSync(docsDir), "docs/ should be created");
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    assert.deepEqual(files.sort(), ["overview.md", "project_structure.md", "stack_and_ops.md"]);
  });

  it("uses config.chapters to skip AI filtering and generate only specified chapters", () => {
    tmp = createTmpDir();
    const promptCapture = join(tmp, "prompt.txt");
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      chapters: [{ chapter: "overview.md" }, { chapter: "development.md" }],
      agent: {
        default: "capture",
        providers: {
          capture: {
            command: "node",
            args: [
              "-e",
              "const fs=require('fs');fs.writeFileSync(process.env.PROMPT_CAPTURE,'called','utf8');process.stdout.write('[\"overview.md\"]');",
              "{{PROMPT}}",
            ],
          },
        },
      },
    });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-node-command", "--force"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SENNEL_WORK_ROOT: tmp,
        SENNEL_SOURCE_ROOT: tmp,
        PROMPT_CAPTURE: promptCapture,
      },
    });

    const docsDir = join(tmp, "docs");
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 2, `expected 2 chapters but got ${files.length}: ${files.join(", ")}`);
    // AI agent should NOT have been called
    assert.ok(!fs.existsSync(promptCapture), "AI agent should not be called when config.chapters is set");
  });

  it("passes docs.style.purpose to AI chapter-selection prompt", () => {
    tmp = createTmpDir();
    const promptCapture = join(tmp, "prompt.txt");
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      docs: { languages: ["ja"], defaultLanguage: "ja", style: { purpose: "user-guide", tone: "polite" } },
      type: "sample-node-command",
      agent: {
        default: "capture",
        providers: {
          capture: {
            command: "node",
            args: [
              "-e",
              "const fs=require('fs');const prompt=process.argv[process.argv.length-1]||'';fs.writeFileSync(process.env.PROMPT_CAPTURE,prompt,'utf8');process.stdout.write('{\"chapters\":[\"overview.md\"]}');",
              "{{PROMPT}}",
            ],
          },
        },
      },
    });
    writeJson(tmp, "package.json", { name: "test-proj" });
    writeJson(tmp, ".sennel/output/analysis.json", {
      analyzedAt: "2026-01-01",
      files: { summary: { total: 1 } },
    });

    execFileSync("node", [CMD, ...CMD_ARGS, "--type", "sample-node-command"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SENNEL_WORK_ROOT: tmp,
        SENNEL_SOURCE_ROOT: tmp,
        PROMPT_CAPTURE: promptCapture,
      },
    });

    const prompt = fs.readFileSync(promptCapture, "utf8");
    // purpose="user-guide" → purposeClause に purpose 値がそのまま埋め込まれる
    assert.match(prompt, /user-guide/);
  });
});
