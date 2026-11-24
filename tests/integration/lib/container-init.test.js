import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { container, initContainer } from "../../../src/lib/container.js";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";

describe("initContainer — config registration contract (R1, #175)", () => {
  let tmp;
  let savedEnv;

  beforeEach(() => {
    tmp = createTmpDir();
    savedEnv = { ...process.env };
    process.env.SENNEL_WORK_ROOT = tmp;
    delete process.env.SENNEL_SOURCE_ROOT;
    container.reset();
  });

  afterEach(() => {
    container.reset();
    removeTmpDir(tmp);
    process.env = savedEnv;
  });

  it("registers null for config when .sennel/config.json is missing", () => {
    initContainer();
    assert.strictEqual(container.get("config"), null);
  });

  it("registers the loaded config object when .sennel/config.json exists", () => {
    mkdirSync(join(tmp, ".sennel"), { recursive: true });
    const validConfig = {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
    };
    writeJson(tmp, ".sennel/config.json", validConfig);
    initContainer();
    const got = container.get("config");
    assert.notStrictEqual(got, null);
    assert.equal(got.lang, "ja");
    assert.equal(got.type, "sample-node-command");
  });

  it("registers Renderable base class and concrete classes for preset use", () => {
    initContainer();
    for (const name of [
      "base.Renderable",
      "base.Table",
      "base.BulletList",
      "base.OrderedList",
      "base.Paragraph",
      "base.CodeBlock",
      "base.Blockquote",
      "base.Heading",
      "base.Fragment",
    ]) {
      const cls = container.get(name);
      assert.equal(typeof cls, "function", `${name} should be a class`);
    }
  });

  it("keeps the CLI execution directory while logs and scratch use independent defaults", () => {
    mkdirSync(join(tmp, ".sennel"), { recursive: true });
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: { workDir: ".tmp" },
    });

    initContainer({ agentWorkDirOverride: ".agent-run" });

    const paths = container.get("paths");
    assert.equal(paths.agentWorkDir, join(tmp, ".agent-run"));
    assert.equal(paths.logDir, join(tmp, ".tmp", "logs"));
    assert.equal(paths.temporaryRoot, join(tmp, ".tmp", "runtime", "agent"));
  });

  it("semantic CLI initialization selects the work directory override only for Flow run", () => {
    writeJson(tmp, ".sennel/config.json", {
      lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
      agent: { workDir: ".configured" },
    });
    const observed = join(tmp, "observed-paths.json");
    for (const group of ["run", "get"]) {
      const source = [
        `import fs from "node:fs";`,
        `process.argv = [process.execPath, "sennel", "flow", ${JSON.stringify(group)}, "unregistered-container-probe", "--agent-work-dir", ".agent-run"];`,
        `await import(${JSON.stringify(new URL("../../../src/cli-main.js", import.meta.url).href)});`,
        `const { container } = await import(${JSON.stringify(new URL("../../../src/lib/container.js", import.meta.url).href)});`,
        `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(container.get("paths").agentWorkDir));`,
      ].join("\n");
      const result = spawnSync(process.execPath, ["--import", SENNEL_BOOTSTRAP, "--input-type=module", "-e", source], {
        cwd: tmp, env: process.env, encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.equal(JSON.parse(readFileSync(observed, "utf8")),
        join(tmp, group === "run" ? ".agent-run" : ".configured"));
    }
  });

  it("keeps logger flow authority usable after finalize removes the managed worktree", async () => {
    const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
    initGitRepo(tmp);
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      logs: { enabled: true },
    });
    commitAll(tmp, "fixture");
    const worktree = join(tmp, ".sennel", "worktree", "feature-demo");
    git("worktree", "add", "--quiet", "-b", "feature/demo", worktree);

    process.env.SENNEL_WORK_ROOT = worktree;
    container.reset();
    initContainer({
      entryCommand: "flow run finalize-cleanup",
      finalizeCleanupDurablePaths: true,
    });
    const logger = container.get("logger");
    const paths = container.get("paths");
    assert.equal(paths.agentWorkDir, join(tmp, ".sennel", "agent-work"));
    assert.equal(paths.temporaryRoot, join(tmp, ".tmp", "runtime", "agent"));
    assert.equal(paths.logDir, join(tmp, ".tmp", "logs"));
    await logger.flush();
    git("worktree", "remove", "--force", worktree);

    let stderr = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      await logger.event("after-cleanup");
      await logger.flush();
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(stderr, "");
    assert.equal(existsSync(worktree), false, "logging must not recreate the removed worktree");
    const events = readdirSync(paths.logDir).filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(paths.logDir, name), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(events.filter((event) => event.type === "event" && event.name === "after-cleanup").length, 1);
  });
});
