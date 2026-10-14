import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { container, initContainer } from "../../../src/lib/container.js";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";

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

  it("never registers an empty object `{}` for missing config (explicit null, not silent fallback)", () => {
    initContainer();
    const got = container.get("config");
    assert.strictEqual(got, null, "config must be null (not {}) when missing");
    assert.notDeepEqual(got, {}, "config must not be an empty object");
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

  it("CLI entrypoint pre-scans flow run --agent-work-dir before initContainer", () => {
    const source = readFileSync(join(process.cwd(), "src/sennel.js"), "utf8");
    assert.match(source, /let agentWorkDirOverride = null/, "entrypoint must have early flow-run scanner state");
    assert.match(source, /agentWorkDirOverride,/, "initContainer must receive the override");
    assert.match(source, /subCmd\s*===\s*"flow"\s*&&\s*rest\[0\]\s*===\s*"run"/, "scanner must be scoped to flow run");
  });

  it("keeps logger flow authority usable after finalize removes the managed worktree", async () => {
    const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    writeJson(tmp, ".sennel/config.json", {
      lang: "ja",
      type: "sample-node-command",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      logs: { enabled: true },
    });
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
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
