import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
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

import {
  GitCommitPathSet,
  GitPorcelainV2Status,
  GitPorcelainV2StatusError,
  getPorcelainV2Status,
  getWorktreeStatus,
  listChangedFilesDetailed,
  runGit,
} from "../../../src/lib/git-helpers.js";
import { runCmd } from "../../../src/lib/process.js";
import { Logger } from "../../../src/lib/log.js";
import { container } from "../../../src/lib/container.js";
import { todayLocal, readJsonl } from "../../support/infrastructure/log-fixtures.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "../../../src/flow/lib/flow-repository-runtime-artifacts.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";

function initRepo(dir) {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  commitAll(dir, "init");
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
    tmpDir = createTestDirectory("rungit-");
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

  it("selects exact tracked-deleted and allowed additions without admitting ignored or neighboring files", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored*.txt\n");
    fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "tracked\n");
    fs.writeFileSync(path.join(tmpDir, "ignored-tracked.txt"), "tracked despite ignore\n");
    assert.equal(runCmd("git", ["-C", tmpDir, "add", "--", ".gitignore", "tracked.txt"]).ok, true);
    assert.equal(runCmd("git", ["-C", tmpDir, "add", "-f", "--", "ignored-tracked.txt"]).ok, true);
    assert.equal(runCmd("git", ["-C", tmpDir, "commit", "-q", "-m", "seed exact file selection"]).ok, true);
    fs.unlinkSync(path.join(tmpDir, "tracked.txt"));
    fs.writeFileSync(path.join(tmpDir, "ignored-new.txt"), "ignored\n");
    fs.writeFileSync(path.join(tmpDir, "allowed [literal].txt"), "allowed\n");
    fs.writeFileSync(path.join(tmpDir, "neighbor.txt"), "not a candidate\n");
    const selected = GitCommitPathSet.committableFiles({ root: tmpDir,
      candidates: ["tracked.txt", "ignored-tracked.txt", "ignored-new.txt", "allowed [literal].txt", "missing.txt"] });
    assert.deepEqual(selected.toArray(), ["tracked.txt", "ignored-tracked.txt", "allowed [literal].txt"]);
  });

  it("canonicalizes Windows native paths before traversal, drive and duplicate checks", () => {
    assert.deepEqual(new GitCommitPathSet(["dir\\valid.json"], { pathApi: path.win32 }).toArray(), ["dir/valid.json"]);
    for (const entry of ["../escape", "..\\escape", "dir\\..\\escape", "C:\\escape", "C:escape", "\\\\host\\share\\file"]) {
      assert.throws(() => new GitCommitPathSet([entry], { pathApi: path.win32 }), /path set is invalid/);
    }
    assert.throws(() => new GitCommitPathSet(["dir\\same.json", "dir/same.json"], { pathApi: path.win32 }), /path set is invalid/);
    assert.deepEqual(new GitCommitPathSet(["dir/name\\literal.json"], { pathApi: path.posix }).toArray(), ["dir/name\\literal.json"]);
  });

  it("bounds literal multi-path argv groups and preserves every candidate in order", () => {
    const paths = Array.from({ length: 600 }, (_, index) => `scope/${index}-${"long path ".repeat(12)}[literal].json`);
    const set = new GitCommitPathSet(paths);
    const args = ["add"], root = tmpDir;
    const batches = set.commandBatches({ root, args });
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flatMap((batch) => batch.toArray()), paths);
    for (const batch of batches) {
      assert.ok(batch.size <= 256);
      const argv = ["git", "-C", root, ...args, "--", ...batch.literalArguments];
      assert.ok(Buffer.byteLength(argv.join("\0"), "utf8") + 1 < 32768);
      assert.ok(argv.reduce((length, entry) => length + 2 * entry.length + 3, 0) < 32767,
        "even worst-case Windows argument quoting must fit CreateProcessW");
      assert.deepEqual(batch.literalArguments, batch.paths.map((entry) => `:(literal)${entry}`));
    }
    const long = "scope/" + "x".repeat(9000);
    const isolated = new GitCommitPathSet([paths[0], long, paths[1]]).commandBatches({ root, args });
    assert.equal(isolated.find((batch) => batch.paths.includes(long)).size, 1);
    assert.deepEqual(isolated.flatMap((batch) => batch.toArray()), [paths[0], long, paths[1]]);
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
    mainDir = createTestDirectory("rungit-main-");
    initRepo(mainDir);
    worktreeDir = path.join(testTemporaryRoot().path, `rungit-wt-${Date.now()}`);
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
    tmpDir = createTestDirectory("rungit-rc-");
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

describe("getWorktreeStatus pathspec exclusions", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTestDirectory("worktree-status-excludes-");
    initRepo(tmpDir);
    container.reset();
    fs.mkdirSync(path.join(tmpDir, ".sennel"));
    fs.writeFileSync(path.join(tmpDir, ".sennel", "config.json"), "{}\n");
    const added = runGit(["add", ".sennel/config.json"], { cwd: tmpDir, repositoryRoot: testTemporaryRoot().path });
    assert.equal(added.ok, true, added.stderr);
    const committed = runGit(["commit", "-q", "-m", "Track project config"], { cwd: tmpDir, repositoryRoot: testTemporaryRoot().path });
    assert.equal(committed.ok, true, committed.stderr);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("excludes owned runtime while retaining tracked, untracked, similar-name and non-ASCII user changes", () => {
    const runtime = path.join(tmpDir, ".sennel", "process-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "runtime.json"), "{}\n");
    const options = { pathspecExcludes: new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes() };
    assert.equal(getWorktreeStatus(tmpDir).dirty, true,
      "ordinary status consumers must continue observing runtime changes");
    assert.deepEqual(getWorktreeStatus(tmpDir, options), { dirty: false, dirtyFiles: [] });

    const configured = runGit(["config", "core.quotePath", "false"], { cwd: tmpDir });
    assert.equal(configured.ok, true, configured.stderr);
    fs.appendFileSync(path.join(tmpDir, "README.md"), "user edit\n");
    const lookalike = path.join(tmpDir, ".sennel", "process-runtime-lookalike");
    fs.mkdirSync(lookalike);
    fs.writeFileSync(path.join(lookalike, "user.txt"), "user content\n");
    fs.writeFileSync(path.join(tmpDir, "資料 file.txt"), "user content\n");
    const status = getWorktreeStatus(tmpDir, options);
    assert.equal(status.dirty, true);
    assert.equal(status.dirtyFiles.length, 3);
    assert.match(status.dirtyFiles.join("\n"), /M README\.md/);
    assert.ok(status.dirtyFiles.includes("?? .sennel/process-runtime-lookalike/"));
    assert.ok(status.dirtyFiles.includes('?? "資料 file.txt"'));
  });

  it("retains a user rename across an excluded runtime boundary", () => {
    const runtime = path.join(tmpDir, ".sennel", "process-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const moved = runGit(["mv", "README.md", ".sennel/process-runtime/user-moved.md"], { cwd: tmpDir });
    assert.equal(moved.ok, true, moved.stderr);
    const status = getWorktreeStatus(tmpDir, {
      pathspecExcludes: new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes(),
    });
    assert.equal(status.dirty, true);
    assert.equal(status.dirtyFiles.length, 1);
    assert.match(status.dirtyFiles[0], /README\.md/,
      "moving user content into a runtime directory must retain its user-side deletion");
  });

  it("preserves parent and sibling user changes from a subdirectory while excluding owned runtime", () => {
    const cwd = path.join(tmpDir, "packages", "app");
    const sibling = path.join(tmpDir, "packages", "sibling");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(cwd, "README.md"), "app seed\n");
    fs.writeFileSync(path.join(sibling, "README.md"), "sibling seed\n");
    const added = runGit(["add", "packages"], { cwd: tmpDir });
    assert.equal(added.ok, true, added.stderr);
    const committed = runGit(["commit", "-q", "-m", "Track nested projects"], { cwd: tmpDir });
    assert.equal(committed.ok, true, committed.stderr);
    const configured = runGit(["config", "status.relativePaths", "true"], { cwd: tmpDir });
    assert.equal(configured.ok, true, configured.stderr);

    const runtime = path.join(tmpDir, ".sennel", "process-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "runtime.json"), "{}\n");
    const options = { pathspecExcludes: new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes() };
    assert.equal(getWorktreeStatus(cwd).dirty, true);
    assert.deepEqual(getWorktreeStatus(cwd, options), { dirty: false, dirtyFiles: [] },
      "repository-root runtime ownership must still apply from a nested cwd");

    fs.appendFileSync(path.join(tmpDir, "README.md"), "parent edit\n");
    fs.appendFileSync(path.join(sibling, "README.md"), "sibling edit\n");
    fs.writeFileSync(path.join(tmpDir, "parent-untracked.txt"), "parent content\n");
    fs.writeFileSync(path.join(sibling, "untracked.txt"), "sibling content\n");
    const ordinary = getWorktreeStatus(cwd);
    const excluded = getWorktreeStatus(cwd, options);
    assert.equal(ordinary.dirty, true);
    assert.equal(excluded.dirty, true,
      "runtime exclusions must preserve the ordinary repository-wide observation scope");
    assert.equal(ordinary.dirtyFiles.length, 5);
    assert.equal(excluded.dirtyFiles.length, 4);
    for (const relativePath of ["../../README.md", "../sibling/README.md",
      "../../parent-untracked.txt", "../sibling/untracked.txt"]) {
      assert.ok(ordinary.dirtyFiles.some((line) => line.endsWith(` ${relativePath}`)), relativePath);
      assert.ok(excluded.dirtyFiles.some((line) => line.endsWith(` ${relativePath}`)), relativePath);
    }
  });

  it("distinguishes cwd-relative runtime ownership from Git-root ownership while preserving outside user changes", () => {
    const cwd = path.join(tmpDir, "packages", "app");
    const sibling = path.join(tmpDir, "packages", "sibling");
    fs.mkdirSync(path.join(cwd, ".sennel"), { recursive: true });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(cwd, ".sennel", "config.json"), "{}\n");
    fs.writeFileSync(path.join(sibling, "README.md"), "sibling seed\n");
    const added = runGit(["add", "packages"], { cwd: tmpDir, repositoryRoot: testTemporaryRoot().path });
    assert.equal(added.ok, true, added.stderr);
    const committed = runGit(["commit", "-q", "-m", "Track configured nested project"], { cwd: tmpDir, repositoryRoot: testTemporaryRoot().path });
    assert.equal(committed.ok, true, committed.stderr);
    const configured = runGit(["config", "status.relativePaths", "true"], { cwd: tmpDir, repositoryRoot: testTemporaryRoot().path });
    assert.equal(configured.ok, true, configured.stderr);

    fs.mkdirSync(path.join(cwd, ".sennel", "process-runtime"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".sennel", "process-runtime", "runtime.json"), "{}\n");
    const operationLock = new RepositoryFlowOperationLock({ mainRoot: cwd });
    const operationOwner = operationLock.acquire();
    try {
      assert.equal(operationLock.assertOwned(), operationOwner);
      const registry = new FlowRepositoryRuntimeArtifactRegistry();
      const projectOptions = { pathspecExcludes: registry.gitPathspecExcludes({ relativeToCwd: true }) };
      const repositoryOptions = { pathspecExcludes: registry.gitPathspecExcludes() };
      assert.equal(getWorktreeStatus(cwd, repositoryOptions).dirty, true,
        "the default Git-root authority must not own a nested project's runtime");
      assert.deepEqual(getWorktreeStatus(cwd, projectOptions), { dirty: false, dirtyFiles: [] },
        "the configured project's runtime and operation lock must be excluded from its cwd");

      fs.mkdirSync(path.join(tmpDir, ".sennel", "process-runtime"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".sennel", "process-runtime", "runtime.json"), "{}\n");
      const projectRuntimeOnly = getWorktreeStatus(cwd, projectOptions);
      assert.equal(projectRuntimeOnly.dirty, true);
      assert.deepEqual(projectRuntimeOnly.dirtyFiles, ["?? ../../.sennel/process-runtime/"],
        "cwd-relative ownership must leave another project's Git-root runtime visible");
      const repositoryRuntimeOnly = getWorktreeStatus(cwd, repositoryOptions);
      assert.equal(repositoryRuntimeOnly.dirty, true);
      assert.equal(repositoryRuntimeOnly.dirtyFiles.length, 2);
      assert.ok(repositoryRuntimeOnly.dirtyFiles.includes("?? .sennel/process-runtime/"));
      assert.ok(repositoryRuntimeOnly.dirtyFiles.includes("?? .tmp/"));

      fs.appendFileSync(path.join(tmpDir, "README.md"), "parent edit\n");
      fs.writeFileSync(path.join(sibling, "untracked.txt"), "sibling content\n");
      for (const options of [projectOptions, repositoryOptions]) {
        const status = getWorktreeStatus(cwd, options);
        assert.equal(status.dirty, true);
        assert.ok(status.dirtyFiles.some((line) => line.endsWith(" ../../README.md")));
        assert.ok(status.dirtyFiles.includes("?? ../sibling/untracked.txt"));
      }
    } finally {
      operationLock.release();
    }
  });
});

describe("listChangedFilesDetailed pathspec exclusions", () => {
  let tmpDir;
  let runtime;
  let pathspecExcludes;

  beforeEach(() => {
    tmpDir = createTestDirectory("changed-files-excludes-");
    initRepo(tmpDir);
    container.reset();
    runtime = path.join(tmpDir, ".sennel", "process-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    pathspecExcludes = new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("filters owned tracked, committed and untracked runtime while retaining every user change", () => {
    fs.writeFileSync(path.join(runtime, "registry.json"), "baseline\n");
    assert.equal(runGit(["add", ".sennel/process-runtime/registry.json"], { cwd: tmpDir }).ok, true);
    assert.equal(runGit(["commit", "-q", "-m", "Track runtime baseline"], { cwd: tmpDir }).ok, true);
    assert.equal(runGit(["branch", "regression-base"], { cwd: tmpDir }).ok, true);
    fs.writeFileSync(path.join(runtime, "registry.json"), "committed update\n");
    fs.writeFileSync(path.join(runtime, "committed.json"), "committed runtime\n");
    fs.writeFileSync(path.join(tmpDir, "committed-user.js"), "export const user = true;\n");
    assert.equal(runGit(["add", ".sennel/process-runtime", "committed-user.js"], { cwd: tmpDir }).ok, true);
    assert.equal(runGit(["commit", "-q", "-m", "Record runtime and user changes"], { cwd: tmpDir }).ok, true);
    fs.appendFileSync(path.join(runtime, "registry.json"), "working update\n");
    fs.writeFileSync(path.join(runtime, "untracked.json"), "untracked runtime\n");
    fs.appendFileSync(path.join(tmpDir, "README.md"), "tracked user update\n");
    fs.mkdirSync(path.join(tmpDir, ".sennel", "process-runtime-lookalike"));
    fs.writeFileSync(path.join(tmpDir, ".sennel", "process-runtime-lookalike", "user.txt"), "user content\n");
    fs.writeFileSync(path.join(tmpDir, "資料 file.txt"), "user content\n");
    assert.equal(runGit(["config", "core.quotePath", "false"], { cwd: tmpDir }).ok, true);
    const options = { cwd: tmpDir, baseBranch: "regression-base", untrackedFiles: "all" };
    const ordinary = listChangedFilesDetailed(options);
    assert.ok(ordinary.some((entry) => entry.path.startsWith(".sennel/process-runtime/")),
      "ordinary observers must retain runtime changes");
    const selected = listChangedFilesDetailed({ ...options, pathspecExcludes });
    assert.deepEqual(new Map(selected.map(({ path, status }) => [path, status])), new Map([
      [".sennel/process-runtime-lookalike/user.txt", "untracked"],
      ["committed-user.js", "added"], ["README.md", "modified"], ["資料 file.txt", "untracked"],
    ]));
  });

  it("applies runtime ownership before the changed-file bound without changing the default observer", () => {
    for (const name of ["owner.lock", "registry.json", "call.json"]) fs.writeFileSync(path.join(runtime, name), "runtime\n");
    fs.appendFileSync(path.join(tmpDir, "README.md"), "user change\n");
    const options = { cwd: tmpDir, untrackedFiles: "all", maxChangedFileEntries: 1 };
    assert.throws(() => listChangedFilesDetailed(options), /returned .* entries/);
    assert.deepEqual(listChangedFilesDetailed({ ...options, pathspecExcludes }), [
      { path: "README.md", status: "modified" },
    ]);
  });

  for (const committed of [false, true]) {
    it(`retains the user-side deletion of a ${committed ? "committed" : "staged"} rename into runtime`, () => {
      assert.equal(runGit(["branch", "rename-base"], { cwd: tmpDir }).ok, true);
      assert.equal(runGit(["mv", "README.md", ".sennel/process-runtime/user-moved.md"], { cwd: tmpDir }).ok, true);
      if (committed) assert.equal(runGit(["commit", "-q", "-m", "Move user content"], { cwd: tmpDir }).ok, true);
      const options = { cwd: tmpDir, ...(committed ? { baseBranch: "rename-base" } : {}) };
      assert.ok(listChangedFilesDetailed(options).some((entry) => entry.status === "renamed" && entry.old_path === "README.md"));
      assert.deepEqual(listChangedFilesDetailed({ ...options, pathspecExcludes }), [
        { path: "README.md", status: "deleted" },
      ]);
    });
  }

  it("preserves parent and sibling scope from a nested cwd while excluding Git-root runtime", () => {
    const cwd = path.join(tmpDir, "packages", "app");
    const sibling = path.join(tmpDir, "packages", "sibling");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(cwd, "README.md"), "app baseline\n");
    fs.writeFileSync(path.join(sibling, "README.md"), "sibling baseline\n");
    assert.equal(runGit(["add", "packages"], { cwd: tmpDir }).ok, true);
    assert.equal(runGit(["commit", "-q", "-m", "Track nested projects"], { cwd: tmpDir }).ok, true);
    assert.equal(runGit(["config", "status.relativePaths", "true"], { cwd: tmpDir }).ok, true);
    fs.appendFileSync(path.join(tmpDir, "README.md"), "parent edit\n");
    fs.appendFileSync(path.join(sibling, "README.md"), "sibling edit\n");
    fs.writeFileSync(path.join(runtime, "runtime.json"), "runtime\n");
    const ordinary = listChangedFilesDetailed({ cwd, untrackedFiles: "all" });
    const selected = listChangedFilesDetailed({ cwd, untrackedFiles: "all", pathspecExcludes });
    assert.deepEqual(new Set(selected.map((entry) => entry.path)), new Set(["README.md", "packages/sibling/README.md"]));
    assert.ok(ordinary.some((entry) => entry.path === ".sennel/process-runtime/runtime.json"));
  });

  it("uses the explicit project-relative ownership scope without hiding another project's runtime", () => {
    const cwd = path.join(tmpDir, "packages", "app");
    const owned = path.join(cwd, ".sennel", "process-runtime");
    fs.mkdirSync(owned, { recursive: true });
    fs.writeFileSync(path.join(owned, "runtime.json"), "project runtime\n");
    fs.writeFileSync(path.join(runtime, "runtime.json"), "other project runtime\n");
    fs.appendFileSync(path.join(tmpDir, "README.md"), "parent user change\n");
    const projectExcludes = new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes({ relativeToCwd: true });
    const selected = listChangedFilesDetailed({ cwd, untrackedFiles: "all", pathspecExcludes: projectExcludes });
    assert.deepEqual(new Set(selected.map((entry) => entry.path)), new Set(["README.md", ".sennel/process-runtime/runtime.json"]));
  });
});

describe("Git porcelain v2 difference authority", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTestDirectory("git-status-v2-");
    initRepo(tmpDir);
    container.reset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.reset();
  });

  it("discovers a parent repository only when the observation boundary permits it", () => {
    const nested = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    fs.appendFileSync(path.join(tmpDir, "README.md"), "parent user edit\n");

    const discovered = getPorcelainV2Status(nested);
    assert.ok(discovered instanceof GitPorcelainV2Status);
    assert.deepEqual(discovered.pathSet.toArray(), ["README.md"]);

    const bounded = getPorcelainV2Status(nested, { repositoryRoot: tmpDir });
    assert.ok(bounded instanceof GitPorcelainV2Status);
    assert.deepEqual(bounded.pathSet.toArray(), ["README.md"]);

    assert.throws(
      () => getPorcelainV2Status(nested, { repositoryRoot: nested }),
      (error) => {
        assert.equal(error.code, "GIT_STATUS_PORCELAIN_V2_FAILED");
        assert.equal(error.result.status, 128);
        return true;
      },
    );
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

  it("supports scoped typed status with detected file modes while preserving the raw index and default arguments", async () => {
    runCmd("git", ["-C", tmpDir, "config", "core.fileMode", "false"]);
    const stagedPath = "staged source.json";
    fs.writeFileSync(path.join(tmpDir, stagedPath), "independent staged blob\n");
    runCmd("git", ["-C", tmpDir, "add", "--", stagedPath]);
    fs.writeFileSync(path.join(tmpDir, stagedPath), "authentic working bytes\n");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "parent user edit\n");
    const cwd = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "packages", "sibling"), { recursive: true });
    const siblingPath = "packages/sibling/user 日本語.txt";
    fs.writeFileSync(path.join(tmpDir, siblingPath), "sibling user input\n");
    const runtimePath = ".sennel/process-runtime/owned.json";
    fs.mkdirSync(path.dirname(path.join(tmpDir, runtimePath)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, runtimePath), "{}\n");
    const logger = registerLogger(path.join(tmpDir, "logs"));
    const indexPath = path.resolve(tmpDir, runGit(["rev-parse", "--git-path", "index"], { cwd: tmpDir }).stdout.trim());
    const indexBytes = fs.readFileSync(indexPath);
    const pathspecs = [...new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes()];

    const status = getPorcelainV2Status(cwd, { pathspecs, forceFileMode: false });
    assert.ok(status instanceof GitPorcelainV2Status);
    assert.ok(status.pathSet.toArray().includes("README.md"));
    assert.ok(status.pathSet.toArray().includes(siblingPath));
    assert.equal(status.pathSet.toArray().includes(runtimePath), false);
    assert.equal(status.entries.find((entry) => entry.path === siblingPath).kind, "untracked");
    assert.equal(status.entries.find((entry) => entry.path === stagedPath).kind, "ordinary");
    const selected = getPorcelainV2Status(tmpDir, { pathspecs: ["README.md"], forceFileMode: false });
    assert.deepEqual(selected.pathSet.toArray(), ["README.md"]);
    getPorcelainV2Status(tmpDir);
    assert.deepEqual(fs.readFileSync(indexPath), indexBytes, "all status queries must leave the raw index unchanged");

    await logger.flush();
    const commands = readJsonl(path.join(tmpDir, "logs", `sennel-${todayLocal()}.jsonl`))
      .filter((entry) => entry.type === "git" && entry.cmd.includes("--porcelain=v2"))
      .map((entry) => entry.cmd);
    const common = ["git", "--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"];
    assert.deepEqual(commands, [
      [...common, "--", ...pathspecs],
      [...common, "--", "README.md"],
      ["git", "--no-optional-locks", "-c", "core.fileMode=true", ...common.slice(2)],
    ]);
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
    const nonRepository = createTestDirectory("git-status-v2-nonrepo-");
    try {
      assert.throws(
        () => getPorcelainV2Status(nonRepository, { repositoryRoot: nonRepository }),
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

import { LoggedGitCommandExecution, GitPorcelainV2StatusExecution, runGitAsync } from "../../../src/lib/git-helpers.js";
import { withReadOnlyManagedProcessScope } from "../../../src/lib/managed-process.js";

it("records grouped and asynchronous native Git results once with distinct confirmed exit receipts", { timeout: 60000 }, async (t) => {
  const root = createTestDirectory("logged-git-group-");
  let logger, complete = false;
  t.after(async () => {
    try { if (logger) await logger.flush(); }
    finally {
      container.reset();
      if (complete) fs.rmSync(root, { recursive: true, force: true });
      else testTemporaryRoot().retainOnUnconfirmedExecution();
    }
  });
  initRepo(root); logger = registerLogger(path.join(root, "logs"));
  const malformed = runGitAsync(["status"], { cwd: root, gitPolicy: {} });
  assert.equal(malformed instanceof Promise, true, "async argument rejection remains a promise");
  await assert.rejects(malformed, TypeError);
  let results, stored;
  const commands = [
    new GitPorcelainV2StatusExecution(root, { repositoryRoot: root, forceFileMode: false }),
    new LoggedGitCommandExecution(["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, timeout: 10000 }),
    new LoggedGitCommandExecution(["config", "--get", "fixture.missing"], { cwd: root, timeout: 10000 }),
  ];
  await withReadOnlyManagedProcessScope({ mainRoot: root }, async (runtime) => {
    results = LoggedGitCommandExecution.runTogether(commands);
    results.push(await runGitAsync(["rev-parse", "--verify", "HEAD"], { cwd: root, timeout: 10000 }));
    stored = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
  });
  assert.deepEqual(results.map((result) => result.status), [0, 0, 1, 0]);
  assert.equal(Buffer.isBuffer(results[0].stdout), true);
  assert.equal(typeof results[1].stdout, "string");
  assert.equal(commands[0].parseResult(results[0]).entries.length, 0);
  assert.equal(results[1].stdout.trim().split("\n")[0], results[3].stdout.trim());
  const receipts = results.map((result) => result.processExecutionStopReceipt);
  assert.equal(new Set(receipts.map((receipt) => receipt.callId)).size, 4);
  assert.deepEqual(receipts.map((receipt) => receipt.observation.code), [0, 0, 1, 0]);
  assert.equal(receipts.every((receipt) => receipt.stopEvidence.status === "confirmed"), true);
  assert.equal(stored.calls.length, 4);
  for (const receipt of receipts) assert.deepEqual(stored.calls.find((call) => call.callId === receipt.callId).receipt, receipt.toJSON());
  await logger.flush();
  const records = readJsonl(path.join(root, "logs", `sennel-${todayLocal()}.jsonl`)).filter((entry) => entry.type === "git");
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((record) => record.exitCode), [0, 0, 1, 0]);
  assert.equal(records.every((record) => record.cmd[0] === "git" && typeof record.stderr === "string"), true);
  assert.deepEqual(records[1].cmd, ["git", "rev-parse", "HEAD", "HEAD^{tree}"]);
  assert.deepEqual(records[2].cmd, ["git", "config", "--get", "fixture.missing"]);
  assert.deepEqual(records[3].cmd, ["git", "rev-parse", "--verify", "HEAD"]);
  complete = true;
});
