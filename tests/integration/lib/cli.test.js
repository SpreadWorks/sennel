import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { parseArgs, repoRoot, sourceRoot, isInsideWorktree, getMainRepoPath } from "../../../src/lib/cli.js";
import { runBootstrapGitProbe } from "../../../src/lib/bootstrap-process.js";
import { resolveWorktreeLocalCli } from "../../../src/lib/worktree-cli-execution.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";

describe("parseArgs", () => {
  it("parses flags", () => {
    const result = parseArgs(["--dry-run", "--force"], {
      flags: ["--dry-run", "--force"],
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.force, true);
    assert.equal(result.help, false);
  });

  it("parses options with values", () => {
    const result = parseArgs(["--type", "sample-preset", "--agent", "claude"], {
      options: ["--type", "--agent"],
    });
    assert.equal(result.type, "sample-preset");
    assert.equal(result.agent, "claude");
  });

  it("parses options with optional values", () => {
    const withoutValue = parseArgs(["--reset", "--dry-run"], {
      flags: ["--dry-run"],
      optionalOptions: ["--reset"],
    });
    assert.equal(withoutValue.reset, true);
    assert.equal(withoutValue.dryRun, true);

    const withValue = parseArgs(["--reset", "modules,commands"], {
      optionalOptions: ["--reset"],
    });
    assert.equal(withValue.reset, "modules,commands");
  });

  it("parses --help / -h", () => {
    assert.equal(parseArgs(["--help"], {}).help, true);
    assert.equal(parseArgs(["-h"], {}).help, true);
  });

  it("applies defaults", () => {
    const result = parseArgs([], {
      flags: ["--force"],
      defaults: { force: false, count: "5" },
    });
    assert.equal(result.force, false);
    assert.equal(result.count, "5");
  });

  it("resolves aliases", () => {
    const result = parseArgs(["-v"], {
      flags: ["--verbose"],
      aliases: { "-v": "--verbose" },
    });
    assert.equal(result.verbose, true);
  });

  it("throws on unknown option", () => {
    assert.throws(() => parseArgs(["--unknown"], { flags: [] }), {
      message: /Unknown option/,
    });
  });

  it("throws when an option value is missing", () => {
    assert.throws(() => parseArgs(["--type"], { options: ["--type"] }), {
      message: /Missing value for option: --type/,
    });
    assert.throws(() => parseArgs(["--type", "--agent"], { options: ["--type", "--agent"] }), {
      message: /Missing value for option: --type/,
    });
  });

  it("skips --", () => {
    const result = parseArgs(["--"], { flags: [] });
    assert.equal(result.help, false);
  });

  it("converts kebab-case to camelCase", () => {
    const result = parseArgs(["--dry-run"], {
      flags: ["--dry-run"],
    });
    assert.equal(result.dryRun, true);
  });
});

describe("repoRoot", () => {
  const origWorkRoot = process.env.SENNEL_WORK_ROOT;

  afterEach(() => {
    if (origWorkRoot !== undefined) {
      process.env.SENNEL_WORK_ROOT = origWorkRoot;
    } else {
      delete process.env.SENNEL_WORK_ROOT;
    }
  });

  it("returns SENNEL_WORK_ROOT when set", () => {
    process.env.SENNEL_WORK_ROOT = "/tmp/test-root";
    assert.equal(repoRoot(), "/tmp/test-root");
  });

  it("returns a string when SENNEL_WORK_ROOT is not set", () => {
    delete process.env.SENNEL_WORK_ROOT;
    const result = repoRoot();
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("falls back to the current directory when the Git probe cannot start", (t) => {
    const tmp = createTmpDir("repo-root-git-unavailable-");
    const previousCwd = process.cwd();
    const previousWorkRoot = process.env.SENNEL_WORK_ROOT;
    const previousPath = process.env.PATH;
    const previousPathAlias = process.platform === "win32" ? undefined : process.env.Path;
    t.after(() => {
      process.chdir(previousCwd);
      if (previousWorkRoot === undefined) delete process.env.SENNEL_WORK_ROOT;
      else process.env.SENNEL_WORK_ROOT = previousWorkRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (process.platform !== "win32") {
        if (previousPathAlias === undefined) delete process.env.Path;
        else process.env.Path = previousPathAlias;
      }
      removeTmpDir(tmp);
    });
    delete process.env.SENNEL_WORK_ROOT;
    process.env.PATH = "";
    if (process.platform !== "win32") delete process.env.Path;
    process.chdir(tmp);

    const probe = runBootstrapGitProbe("repository-root");
    assert.equal(probe.ok, false);
    assert.equal(probe.errorCode, "ENOENT");
    assert.equal(repoRoot(), tmp);
  });
});

describe("bootstrap Git probes", () => {
  it("discovers a nested repository from a subdirectory despite inherited Git location overrides", (t) => {
    const tmp = createTmpDir("bootstrap-nested-git-");
    t.after(() => removeTmpDir(tmp));
    const outer = path.join(tmp, "outer");
    const nested = path.join(outer, "nested");
    const cwd = path.join(nested, "packages", "app");
    fs.mkdirSync(cwd, { recursive: true });
    initGitRepo(outer);
    initGitRepo(nested);

    const previous = new Map(["GIT_DIR", "GIT_CEILING_DIRECTORIES"].map((name) => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    process.env.GIT_DIR = path.join(outer, ".git");
    process.env.GIT_CEILING_DIRECTORIES = nested;

    const result = runBootstrapGitProbe("repository-root", { cwd });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(path.resolve(result.stdout.trim()), nested);
  });

  it("keeps common-directory discovery inside an already selected non-Git boundary", (t) => {
    const tmp = createTmpDir("bootstrap-common-boundary-");
    t.after(() => removeTmpDir(tmp));
    const repository = path.join(tmp, "repository");
    const selected = path.join(repository, "project", "checkout");
    fs.mkdirSync(selected, { recursive: true });
    initGitRepo(repository);

    const result = runBootstrapGitProbe("common-directory", { cwd: selected });
    assert.equal(result.ok, false);
    assert.equal(result.status, 128);
  });
});

describe("worktree CLI selection from nested directories", () => {
  it("selects the real worktree CLI when invoked below its repository root", (t) => {
    const root = createTmpDir("nested-worktree-cli-");
    t.after(() => removeTmpDir(root));
    const sourceDirectory = path.join(root, "src");
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@fixture/sennel", type: "module" }));
    fs.writeFileSync(path.join(sourceDirectory, "sennel.js"), "process.exit(0);\n");
    initGitRepo(root);
    commitAll(root, "worktree CLI fixture");

    const worktreeRoot = path.join(root, "feature-worktree");
    execFileSync("git", ["-C", root, "worktree", "add", worktreeRoot, "-b", "feature"], { stdio: "ignore" });
    const nestedCwd = path.join(worktreeRoot, "packages", "app");
    fs.mkdirSync(nestedCwd, { recursive: true });

    const target = resolveWorktreeLocalCli({
      executionPath: path.join(root, "src", "sennel.js"),
      cwd: nestedCwd,
    });

    assert.ok(target, "the matching local CLI must be selected from a nested worktree directory");
    assert.equal(target.worktreeRoot, fs.realpathSync(worktreeRoot));
    assert.equal(target.localCliPath, path.join(worktreeRoot, "src", "sennel.js"));
  });
});

describe("sourceRoot", () => {
  const origSourceRoot = process.env.SENNEL_SOURCE_ROOT;
  const origWorkRoot = process.env.SENNEL_WORK_ROOT;

  afterEach(() => {
    if (origSourceRoot !== undefined) {
      process.env.SENNEL_SOURCE_ROOT = origSourceRoot;
    } else {
      delete process.env.SENNEL_SOURCE_ROOT;
    }
    if (origWorkRoot !== undefined) {
      process.env.SENNEL_WORK_ROOT = origWorkRoot;
    } else {
      delete process.env.SENNEL_WORK_ROOT;
    }
  });

  it("returns SENNEL_SOURCE_ROOT when set", () => {
    process.env.SENNEL_SOURCE_ROOT = "/tmp/src-root";
    assert.equal(sourceRoot(), "/tmp/src-root");
  });

  it("falls back to repoRoot when SENNEL_SOURCE_ROOT is not set", () => {
    delete process.env.SENNEL_SOURCE_ROOT;
    process.env.SENNEL_WORK_ROOT = "/tmp/work";
    assert.equal(sourceRoot(), "/tmp/work");
  });
});

describe("isInsideWorktree", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns false for a normal git repo", () => {
    tmp = createTmpDir();
    execFileSync("git", ["init", tmp], { encoding: "utf8" });
    assert.equal(isInsideWorktree(tmp), false);
  });

  it("returns false for a directory without .git", () => {
    tmp = createTmpDir();
    assert.equal(isInsideWorktree(tmp), false);
  });

  it("returns true inside a git worktree", () => {
    tmp = createTmpDir();
    execFileSync("git", ["init", tmp], { encoding: "utf8" });
    execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"], { encoding: "utf8" });
    const wtPath = path.join(tmp, "wt");
    execFileSync("git", ["-C", tmp, "worktree", "add", wtPath, "-b", "wt-branch"], { encoding: "utf8" });
    assert.equal(isInsideWorktree(wtPath), true);
    // Cleanup worktree
    execFileSync("git", ["-C", tmp, "worktree", "remove", wtPath], { encoding: "utf8" });
  });
});

describe("getMainRepoPath", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns main repo path from a worktree", () => {
    tmp = createTmpDir();
    execFileSync("git", ["init", tmp], { encoding: "utf8" });
    execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"], { encoding: "utf8" });
    const wtPath = path.join(tmp, "wt");
    execFileSync("git", ["-C", tmp, "worktree", "add", wtPath, "-b", "wt-branch"], { encoding: "utf8" });
    const mainPath = getMainRepoPath(wtPath);
    assert.equal(mainPath, tmp);
    // Cleanup worktree
    execFileSync("git", ["-C", tmp, "worktree", "remove", wtPath], { encoding: "utf8" });
  });

  it("returns repo path for a normal repo", () => {
    tmp = createTmpDir();
    execFileSync("git", ["init", tmp], { encoding: "utf8" });
    const mainPath = getMainRepoPath(tmp);
    assert.equal(mainPath, tmp);
  });
});
