/**
 * Explicit, offline diagnostic. Copies an existing checkout and its canonical
 * Flow; never dispatches, resumes, or changes the original checkout/Flow.
 * Usage: node scripts/measure-task-review-regressions.js <worktree> <canonical-spec-directory>
 * The caller owns the printed temporary evidence directory (retained for audit).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TestTemporaryRoot } from "../tests/test-temporary-root.js";

const authorRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revisions = ["5cf1d97e0", "39148ea56", "9e839d1dc", "4dab68ee2", "857c2a64c"];
const testFile = "tests/integration/flow/task-review-causal-scenarios.test.js";
const supportFile = "tests/support/builders/task-review-scenario.js";

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function digestTree(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) entries.push([relative, "symlink", fs.readlinkSync(absolute)]);
      else if (stat.isFile()) entries.push([relative, stat.mode & 0o777, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
      else throw new Error(`Cannot snapshot non-file: ${absolute}`);
    }
  }
  visit(root);
  return { digest: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: false, preserveTimestamps: true });
}

class ReviewRegressionMeasurement {
  constructor(worktree, specDirectory) {
    this.worktree = fs.realpathSync(worktree);
    this.specDirectory = fs.realpathSync(specDirectory);
    this.output = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-review-measurement-"));
    this.seed = path.join(this.output, "immutable-seed");
    this.rows = [];
    this.before = null;
  }
  write(name, value) {
    fs.writeFileSync(path.join(this.output, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  originalSnapshot() {
    return {
      head: git(this.worktree, ["rev-parse", "HEAD"]).trim(),
      status: git(this.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
      source: digestTree(path.join(this.worktree, "src")),
      canonical: digestTree(this.specDirectory),
      runtime: digestTree(path.join(this.worktree, ".sennel")),
    };
  }
  capture() {
    // Deliberately omit the linked-worktree .git pointer. It must never enter
    // an executable copy, where Git could otherwise affect the real repository.
    this.before = this.originalSnapshot();
    this.write("original-before.json", this.before);
    const files = git(this.worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const file of files) {
      const source = path.join(this.worktree, file);
      if (fs.existsSync(source)) copy(source, path.join(this.seed, file));
    }
    copy(path.join(this.worktree, ".sennel"), path.join(this.seed, ".sennel"));
    const state = JSON.parse(fs.readFileSync(path.join(this.specDirectory, "flow.json"), "utf8"));
    this.specId = state.specId;
    const destination = path.join(this.seed, "specs", this.specId, path.basename(this.specDirectory));
    copy(this.specDirectory, destination);
    assert.equal(digestTree(destination).digest, this.before.canonical.digest);
    for (const file of [testFile, supportFile, "scripts/task-review-snapshot-probe.js"]) {
      copy(path.join(authorRoot, file), path.join(this.seed, file));
    }
    assert.equal(fs.existsSync(path.join(this.seed, ".git")), false);
    this.write("seed-manifest.json", digestTree(this.seed));
  }
  runVariant(index, removed) {
    const name = `${index}-${removed.length === 0 ? "current" : `without-${removed.at(-1)}`}`;
    const root = path.join(this.output, name);
    copy(this.seed, root);
    // Apply product deltas only. The same new tests are frozen for every run.
    for (const revision of removed) {
      const patch = git(this.worktree, ["diff", `${revision}^`, revision, "--", "src/"]);
      execFileSync("git", ["apply", "--reverse", "--check", "-"], { cwd: root, input: patch });
      execFileSync("git", ["apply", "--reverse", "-"], { cwd: root, input: patch });
    }
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("SENNEL_") || key.startsWith("GIT_")) delete environment[key];
    }
    const logPath = path.join(this.output, `${name}.tap`);
    const fd = fs.openSync(logPath, "w");
    const temporary = TestTemporaryRoot.createOnTmpfs() ?? TestTemporaryRoot.createOnSystem();
    environment.TMPDIR = temporary.path;
    let result;
    try {
      result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
        cwd: root, env: environment, stdio: ["ignore", fd, fd], timeout: 600_000,
      });
    } finally {
      fs.closeSync(fd);
      temporary.remove();
      environment.TMPDIR = os.tmpdir();
    }
    if (result.error) throw result.error;
    const log = fs.readFileSync(logPath, "utf8");
    const snapshot = spawnSync(process.execPath, ["scripts/task-review-snapshot-probe.js", root, this.specId], {
      cwd: root, env: environment, encoding: "utf8", timeout: 30_000,
    });
    fs.writeFileSync(path.join(this.output, `${name}-snapshot.log`), snapshot.stdout + snapshot.stderr);
    if (snapshot.error) throw snapshot.error;
    const row = {
      name, removed, exitCode: result.status, signal: result.signal,
      passed: [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((entry) => entry[1]),
      failed: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((entry) => entry[1]),
      snapshotExitCode: snapshot.status,
      testDigest: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, testFile))).digest("hex"),
    };
    const names = [...row.passed, ...row.failed].sort();
    assert.ok(names.length > 1, "runner must execute individual scenario contracts, not just fail loading a file");
    assert.equal(row.signal, null, "terminated tests are not regression detection evidence");
    assert.ok(row.exitCode === 0 || row.exitCode === 1, "runner must complete normally");
    if (this.rows.length > 0) {
      const reference = this.rows[0];
      assert.deepEqual(names, [...reference.passed, ...reference.failed].sort(), "every variant must execute the same scenarios");
      assert.equal(row.testDigest, reference.testDigest, "tests must remain frozen during ablation");
    }
    this.rows.push(row);
    this.write("results.json", this.rows);
    process.stdout.write(`${name}: ${row.passed.length} passed, ${row.failed.length} failed; snapshot=${snapshot.status}\n`);
  }
  verifyOriginal() {
    const after = this.originalSnapshot();
    this.write("original-after.json", after);
    assert.deepEqual(after, this.before, "original Flow and worktree must remain unchanged");
  }
}

const [worktree, specDirectory, mode] = process.argv.slice(2);
if (!worktree || !specDirectory) throw new Error("Supply the source worktree and canonical version directory explicitly");
if (mode !== undefined && mode !== "--current-only") throw new Error("Optional mode must be --current-only");
const measurement = new ReviewRegressionMeasurement(worktree, specDirectory);
process.stdout.write(`Evidence directory: ${measurement.output}\n`);
measurement.capture();
try {
  const last = mode === "--current-only" ? 0 : revisions.length;
  for (let index = 0; index <= last; index += 1) measurement.runVariant(index, revisions.slice(0, index));
} finally { measurement.verifyOriginal(); }
