import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
const { join } = path;
import { standaloneTestEnvironment } from "../../../../src/lib/process.js";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson, writeFile } from "../../../support/builders/tmp-dir.js";
const CMD = join(process.cwd(), "src/sennel.js");
const CMD_ARGS_PREFIX = ["docs", "forge"];

describe("forge CLI validation", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function makeEnv(t) {
    return { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: t, SENNEL_SOURCE_ROOT: t };
  }

  it("rejects invalid --max-runs", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    try {
      execFileSync("node", [CMD, ...CMD_ARGS_PREFIX, "--prompt", "test", "--max-runs", "0"], {
        encoding: "utf8",
        env: makeEnv(tmp),
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      assert.match(err.stderr, /max-runs/);
    }
  });

  it("rejects invalid --mode", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    try {
      execFileSync("node", [CMD, ...CMD_ARGS_PREFIX, "--prompt", "test", "--mode", "invalid"], {
        encoding: "utf8",
        env: makeEnv(tmp),
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      assert.match(err.stderr, /mode/);
    }
  });

  it("exits with error when no prompt given", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });

    try {
      execFileSync("node", [CMD, ...CMD_ARGS_PREFIX], {
        encoding: "utf8",
        env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      assert.match(err.stderr, /prompt is required|prompt が必要/);
    }
  });

  it("shows help with --help", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });

    const result = execFileSync("node", [CMD, ...CMD_ARGS_PREFIX, "--help"], {
      encoding: "utf8",
      env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /--prompt/);
  });

  it("--dry-run skips writes, review, and agent calls", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    writeFile(tmp, "docs/test.md", "# Test\n\nContent\n");

    const result = execFileSync("node", [
      CMD, ...CMD_ARGS_PREFIX,
      "--prompt", "test",
      "--dry-run",
    ], {
      encoding: "utf8",
      env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /DRY-RUN/);
    assert.match(result, /DONE \(dry-run\)/);
    // Review was skipped
    assert.match(result, /review: \(skipped\)/);
  });

  it("runs review in local mode and handles pass", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", { lang: "ja", type: "sample-node-command", docs: { languages: ["ja"], defaultLanguage: "ja" } });
    // Create docs that will pass review
    const lines = ["# Test", ""];
    for (let i = 0; i < 20; i++) lines.push(`Content line ${i}`);
    writeFile(tmp, "docs/test.md", lines.join("\n"));

    // Use a review command that always passes
    const result = execFileSync("node", [
      CMD, ...CMD_ARGS_PREFIX,
      "--prompt", "test",
      "--review-cmd", JSON.stringify({ kind: "native", executable: process.execPath, args: ["-e", "process.stdout.write('review-passed\\n')"] }),
      "--max-runs", "1",
    ], {
      encoding: "utf8",
      env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /DONE/);
  });

  it("uses per-file mode when systemPromptFlag is set", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: {
        default: "echo-agent",
        providers: {
          "echo-agent": {
            name: "echo-agent",
            command: "echo",
            args: ["{{PROMPT}}"],
            systemPromptFlag: "--system-prompt",
          },
        },
      },
    });
    writeFile(tmp, "docs/test.md", "# Test\n\ncontent\n");
    writeFile(tmp, "docs/arch.md", "# Arch\n\ncontent\n");

    const result = execFileSync("node", [
      CMD, ...CMD_ARGS_PREFIX,
      "--prompt", "improve",
      "--mode", "agent",
      "--review-cmd", JSON.stringify({ kind: "native", executable: process.execPath, args: ["-e", "process.stdout.write('review-passed\\n')"] }),
      "--max-runs", "1",
    ], {
      encoding: "utf8",
      env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    assert.match(result, /per-file mode/);
    assert.match(result, /2 files/);
    assert.match(result, /DONE/);
  });

  it("uses legacy mode when systemPromptFlag is not set", () => {
    tmp = createTmpDir();
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: {
        default: "echo-agent",
        providers: {
          "echo-agent": {
            name: "echo-agent",
            command: "echo",
            args: ["{{PROMPT}}"],
          },
        },
      },
    });
    writeFile(tmp, "docs/01_test.md", "# Test\n\ncontent\n");

    const result = execFileSync("node", [
      CMD, ...CMD_ARGS_PREFIX,
      "--prompt", "improve",
      "--mode", "agent",
      "--review-cmd", JSON.stringify({ kind: "native", executable: process.execPath, args: ["-e", "process.stdout.write('review-passed\\n')"] }),
      "--max-runs", "1",
    ], {
      encoding: "utf8",
      env: { ...standaloneTestEnvironment(), SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    // Should NOT show per-file mode
    assert.ok(!result.includes("per-file mode"), "should not use per-file mode");
    assert.match(result, /DONE/);
  });
});
