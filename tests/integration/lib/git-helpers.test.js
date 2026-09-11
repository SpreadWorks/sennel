/**
 * Tests for runGit.
 *
 * runGit reads the Logger from the Container, so tests register a test
 * Logger into the container before exercising the helper.
 *
 * Verifies:
 *   R1  業務 git 操作のロギング (cmd, exitCode, stderr)
 *   R2  worktree 内で再帰なくログ記録
 *   R4  失敗時の exitCode/stderr 記録
 *   R5  失敗時に ok:false かつ status 非 0
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  GitCommitPathSet,
  GitPorcelainV2Status,
  GitPorcelainV2StatusError,
  getPorcelainV2Status,
  runGit,
} from "../../../src/lib/git-helpers.js";
import { runCmd } from "../../../src/lib/process.js";
import { Logger } from "../../../src/lib/log.js";
import { container } from "../../../src/lib/container.js";
import { todayLocal, readJsonl } from "../../support/infrastructure/log-fixtures.js";

function initRepo(dir) {
  runCmd("git", ["init", "-q", "-b", "main", dir]);
  runCmd("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  runCmd("git", ["-C", dir, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  runCmd("git", ["-C", dir, "add", "."]);
  runCmd("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

function registerLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logger = new Logger({ logDir, enabled: true, entryCommand: "test" });
  container.reset();
  container.register("logger", logger);
  return logger;
}

describe("runGit — basic logging", () => {
  let tmpDir;
  let logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rungit-"));
    initRepo(tmpDir);
    logger = registerLogger(path.join(tmpDir, "logs"));
  });

  afterEach(async () => {
    await logger.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("R1: returns runCmd-compatible result on success and writes a git log record", async () => {
    const result = runGit(["status", "--short"], { cwd: tmpDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");

    await logger.flush();
    const jsonl = path.join(tmpDir, "logs", `sennel-${todayLocal()}.jsonl`);
    const lines = readJsonl(jsonl);
    const gitLines = lines.filter((l) => l.type === "git");
    assert.equal(gitLines.length, 1);
    assert.deepEqual(gitLines[0].cmd, ["git", "status", "--short"]);
    assert.equal(gitLines[0].exitCode, 0);
    assert.equal(gitLines[0].stderr, "");
  });

  it("R4, R5: failure produces ok:false with non-zero status and is logged with stderr", async () => {
    const result = runGit(["this-is-not-a-real-subcommand"], { cwd: tmpDir });
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.length > 0, "stderr should be captured");

    await logger.flush();
    const jsonl = path.join(tmpDir, "logs", `sennel-${todayLocal()}.jsonl`);
    const lines = readJsonl(jsonl);
    const gitLines = lines.filter((l) => l.type === "git");
    assert.equal(gitLines.length, 1);
    assert.notEqual(gitLines[0].exitCode, 0);
    assert.ok(String(gitLines[0].stderr).length > 0);
  });

  it("resolves current and tracked-deleted paths while excluding committed deletions", () => {
    const committedDeletion = "committed-deletion.txt";
    const trackedDeletion = "tracked-deletion.txt";
    const untracked = "untracked.txt";
    fs.writeFileSync(path.join(tmpDir, committedDeletion), "committed deletion\n");
    fs.writeFileSync(path.join(tmpDir, trackedDeletion), "tracked deletion\n");
    runCmd("git", ["-C", tmpDir, "add", committedDeletion, trackedDeletion]);
    runCmd("git", ["-C", tmpDir, "commit", "-q", "-m", "add deletion fixtures"]);
    fs.unlinkSync(path.join(tmpDir, committedDeletion));
    runCmd("git", ["-C", tmpDir, "add", "-A", "--", committedDeletion]);
    runCmd("git", ["-C", tmpDir, "commit", "-q", "-m", "commit one deletion"]);
    fs.unlinkSync(path.join(tmpDir, trackedDeletion));
    fs.writeFileSync(path.join(tmpDir, untracked), "untracked\n");

    const resolved = GitCommitPathSet.resolve({
      root: tmpDir,
      treeish: "HEAD",
      candidates: [
        committedDeletion,
        trackedDeletion,
        untracked,
        "transient-removed.txt",
      ],
    });

    assert.deepEqual(resolved.toArray(), [trackedDeletion, untracked]);
  });

  it("treats Git pathspec metacharacters as literal repository paths", () => {
    const literalPath = "src/routes/[dataKey]/page.js";
    fs.mkdirSync(path.dirname(path.join(tmpDir, literalPath)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, literalPath), "export const page = true;\n");
    runCmd("git", ["-C", tmpDir, "add", "--", `:(literal)${literalPath}`]);
    runCmd("git", ["-C", tmpDir, "commit", "-q", "-m", "add literal route"]);

    const resolved = GitCommitPathSet.resolve({
      root: tmpDir,
      treeish: "HEAD",
      candidates: [literalPath],
    });

    assert.deepEqual(resolved.toArray(), [literalPath]);
  });
});

describe("runGit — worktree regression (R2)", () => {
  let mainDir;
  let worktreeDir;
  let logger;

  beforeEach(() => {
    mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "rungit-main-"));
    initRepo(mainDir);
    worktreeDir = path.join(os.tmpdir(), `rungit-wt-${Date.now()}`);
    const r = runCmd("git", ["-C", mainDir, "worktree", "add", "-b", "feature-x", worktreeDir]);
    if (!r.ok) throw new Error("worktree add failed: " + r.stderr);

    // Simulate container init with main-repo-side log dir (matches buildPaths behavior).
    logger = registerLogger(path.join(mainDir, ".tmp", "logs"));
  });

  afterEach(async () => {
    await logger.flush();
    runCmd("git", ["-C", mainDir, "worktree", "remove", "--force", worktreeDir]);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    container.reset();
  });

  it("logs to the main-repo-side log dir even when called inside a worktree", async () => {
    const result = runGit(["status", "--short"], { cwd: worktreeDir });
    assert.equal(result.ok, true);
    await logger.flush();
    const jsonl = path.join(mainDir, ".tmp", "logs", `sennel-${todayLocal()}.jsonl`);
    assert.ok(fs.existsSync(jsonl), `expected log file at ${jsonl}`);
    const lines = readJsonl(jsonl);
    const gitLines = lines.filter((l) => l.type === "git");
    assert.ok(gitLines.length >= 1);
  });
});

describe("runCmd no longer logs git commands", () => {
  let tmpDir;
  let logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rungit-rc-"));
    initRepo(tmpDir);
    logger = registerLogger(path.join(tmpDir, "logs"));
  });

  afterEach(async () => {
    await logger.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("R3: runCmd('git', ...) does NOT emit a git log record (use runGit instead)", async () => {
    const result = runCmd("git", ["status", "--short"], { cwd: tmpDir });
    assert.equal(result.ok, true);
    await logger.flush();
    const jsonl = path.join(tmpDir, "logs", `sennel-${todayLocal()}.jsonl`);
    if (fs.existsSync(jsonl)) {
      const lines = readJsonl(jsonl);
      const gitLines = lines.filter((l) => l.type === "git");
      assert.equal(gitLines.length, 0);
    }
  });
});

describe("Git porcelain v2 difference authority", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-status-v2-"));
    initRepo(tmpDir);
    container.reset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("parses ordinary, deleted, untracked, type-changed, and special-character paths", () => {
    const ordinary = "ordinary file.txt";
    const deleted = "deleted.txt";
    const typeChanged = "type-change.txt";
    for (const relativePath of [ordinary, deleted, typeChanged]) {
      fs.writeFileSync(path.join(tmpDir, relativePath), `${relativePath}\n`);
    }
    runCmd("git", ["-C", tmpDir, "add", "--", ordinary, deleted, typeChanged]);
    runCmd("git", ["-C", tmpDir, "commit", "-q", "-m", "status fixtures"]);
    fs.writeFileSync(path.join(tmpDir, ordinary), "changed\n");
    fs.unlinkSync(path.join(tmpDir, deleted));
    fs.unlinkSync(path.join(tmpDir, typeChanged));
    fs.symlinkSync("README.md", path.join(tmpDir, typeChanged));
    const special = "untracked\tline\nbreak.txt";
    fs.writeFileSync(path.join(tmpDir, special), "untracked\n");

    const status = getPorcelainV2Status(tmpDir);
    assert.ok(status instanceof GitPorcelainV2Status);
    assert.deepEqual(new Set(status.pathSet.toArray()), new Set([
      ordinary, deleted, typeChanged, special,
    ]));
    assert.equal(status.entries.find((entry) => entry.path === deleted).worktreeMode, 0);
    assert.equal(status.entries.find((entry) => entry.path === typeChanged).worktreeMode, 0o120000);
    assert.equal(status.entries.find((entry) => entry.path === special).kind, "untracked");
  });

  it("forces executable-bit observation when repository core.fileMode is false", () => {
    runCmd("git", ["-C", tmpDir, "config", "core.fileMode", "false"]);
    const readme = path.join(tmpDir, "README.md");
    fs.chmodSync(readme, 0o755);

    const status = getPorcelainV2Status(tmpDir);

    const entry = status.entries.find((candidate) => candidate.path === "README.md");
    assert.equal(entry.worktreeMode, 0o100755);
    assert.equal(entry.worktreeStatus, "M");
  });

  it("rejects malformed boundary data and Git command failure", () => {
    const oid = "a".repeat(40);
    for (const malformed of [
      "1 .M N... 100644 100644 100644 abc def missing-terminator",
      "2 R. N... 100644 100644 100644 abc def R100 renamed.txt\0",
      "? ../escape.txt\0",
      "x unsupported.txt\0",
      Buffer.from([0x3f, 0x20, 0xff, 0x00]),
      `1 .M N..X 100644 100644 100644 ${oid} ${oid} invalid-submodule.txt\0`,
      `1 .M N... 100644 100644 777777 ${oid} ${oid} invalid-mode.txt\0`,
      `1 .M N... 100644 100644 100644 ${"a".repeat(39)} ${oid} short-object.txt\0`,
      `1 R. N... 100644 100644 100644 ${oid} ${oid} wrong-record.txt\0`,
      `2 .M N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt\0original.txt\0`,
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R101 renamed.txt\0original.txt\0`,
      `u .M N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} unmerged.txt\0`,
      "? duplicate.txt\0? duplicate.txt\0",
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 same.txt\0same.txt\0`,
    ]) {
      assert.throws(
        () => GitPorcelainV2Status.from(malformed),
        (error) => error instanceof GitPorcelainV2StatusError
          && error.code === "GIT_STATUS_PORCELAIN_V2_INVALID",
      );
    }
    const rename = GitPorcelainV2Status.from(
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt\0original.txt\0`,
    );
    assert.deepEqual(rename.pathSet.toArray(), ["renamed.txt", "original.txt"]);
    const nonRepository = fs.mkdtempSync(path.join(os.tmpdir(), "git-status-v2-nonrepo-"));
    try {
      assert.throws(
        () => getPorcelainV2Status(nonRepository),
        (error) => error.code === "GIT_STATUS_PORCELAIN_V2_FAILED",
      );
    } finally {
      fs.rmSync(nonRepository, { recursive: true, force: true });
    }
  });

  it("preserves raw Git status bytes and rejects an invalid UTF-8 repository path", () => {
    const invalidPath = Buffer.concat([
      Buffer.from(`${tmpDir}${path.sep}invalid-`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(".txt", "utf8"),
    ]);
    fs.writeFileSync(invalidPath, "invalid path bytes\n");

    assert.throws(
      () => getPorcelainV2Status(tmpDir),
      (error) => error instanceof GitPorcelainV2StatusError
        && error.code === "GIT_STATUS_PORCELAIN_V2_INVALID",
    );
  });
});
