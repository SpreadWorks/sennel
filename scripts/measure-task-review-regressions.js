/**
 * Explicit, offline diagnostic. Copies an existing checkout and its canonical
 * Flow; never dispatches, resumes, or changes the original checkout/Flow.
 * Usage: node scripts/measure-task-review-regressions.js <worktree> <canonical-spec-directory>
 * The caller owns the printed temporary evidence directory (retained for audit).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
await import("../src/sennel.js");
const { runCmd, assertOk } = await import("../src/lib/process.js");
const { runGit } = await import("../src/lib/git-helpers.js");
const { NativeExecutableInvocation, NodeScriptInvocation } = await import("../src/lib/command-invocation.js");
import { fileURLToPath } from "node:url";
const { TestTemporaryRoot } = await import("../tests/test-temporary-root.js");
const { TemporaryPaths } = await import("../src/lib/temporary-paths.js");
const { AtomicFile } = await import("../src/lib/atomic-file.js");
const { AtomicJsonFile } = await import("../src/lib/atomic-json-file.js");
const { RealDirectoryAuthority } = await import("../src/lib/real-directory-authority.js");
const { captureRegularFile, visitRegularFileChunks, MAX_IN_MEMORY_FILE_BYTES } = await import("../src/lib/regular-file-snapshot.js");

const authorRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revisions = ["5cf1d97e0", "39148ea56", "9e839d1dc", "4dab68ee2", "857c2a64c"];
const testFile = "tests/integration/flow/task-review-causal-scenarios.test.js";
const supportFile = "tests/support/builders/task-review-scenario.js";

function git(root, args, options = {}) {
  const result = runGit(["-C", root, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  assertOk(result, "measurement Git command failed");
  return result.stdout;
}

function digestTree(root) {
  const entries = [];
  const rootAuthority = new RealDirectoryAuthority(root);
  function visit(authority) {
    const directory = authority.directory;
    for (const name of authority.entries().sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isDirectory()) visit(authority.descendant(absolute));
      else if (stat.isSymbolicLink()) entries.push([relative, "symlink", fs.readlinkSync(absolute)]);
      else if (stat.isFile()) {
        const receipt = visitRegularFileChunks(absolute, {
          label: "measurement source file", maxBytes: Number.MAX_SAFE_INTEGER - 1,
          expectedIdentity: stat, directoryAuthority: authority, visit() {},
        });
        // Permission bits describe the measured source checkout, never I/O authority.
        entries.push([relative, Number(stat.mode & 0o777n), receipt.digest]);
      }
      else throw new Error(`Cannot snapshot non-file: ${absolute}`);
    }
    authority.assertStable();
  }
  visit(rootAuthority);
  rootAuthority.assertStable();
  return { digest: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

function copy(source, target) {
  RealDirectoryAuthority.resolve(path.dirname(target), { create: true }).assertStable();
  // This fixture copy preserves source-checkout symlinks and metadata as measured
  // payload; it is not publication of a managed regular-file target set.
  fs.cpSync(source, target, { recursive: true, dereference: false, preserveTimestamps: true });
}

class ReviewRegressionMeasurement {
  constructor(worktree, specDirectory) {
    this.worktree = fs.realpathSync(worktree);
    this.specDirectory = fs.realpathSync(specDirectory);
    const paths = new TemporaryPaths(this.worktree);
    this.output = paths.create(paths.operator(), "sennel-review-measurement-");
    this.outputAuthority = new RealDirectoryAuthority(this.output);
    this.seed = path.join(this.output, "immutable-seed");
    this.rows = [];
    this.before = null;
  }
  write(name, value) {
    new AtomicJsonFile(path.join(this.output, name), { directoryAuthority: this.outputAuthority }).write(value);
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
    const state = JSON.parse(captureRegularFile(path.join(this.specDirectory, "flow.json"), {
      label: "measurement seed Flow state", maxBytes: MAX_IN_MEMORY_FILE_BYTES,
    }).text());
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
      git(root, ["apply", "--reverse", "--check", "-"], { input: patch });
      git(root, ["apply", "--reverse", "-"], { input: patch });
    }
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("SENNEL_") || key.startsWith("GIT_")) delete environment[key];
    }
    const logPath = path.join(this.output, `${name}.tap`);
    const logFile = new AtomicFile(logPath, {
      directoryAuthority: this.outputAuthority, maxBytes: Number.MAX_SAFE_INTEGER - 1,
    });
    const temporary = TestTemporaryRoot.select({ repositoryRoot: root, environment });
    const release = temporary.activate({ environment });
    let result;
    try {
      const stage = logFile.createOutputStage((fd) => {
        result = runCmd(new NativeExecutableInvocation({ executable: process.execPath, args: ["--test", "--test-reporter=tap", testFile],
          cwd: root, env: environment, stdio: ["ignore", fd, fd] }), [], { timeout: 600_000 });
      });
      logFile.publishStage(stage);
    } finally {
      release();
    }
    if (result.errorCode) throw new Error(`measurement command failed: ${result.errorCode}: ${result.stderr}`);
    const log = captureRegularFile(logPath, {
      label: "measurement TAP output", maxBytes: MAX_IN_MEMORY_FILE_BYTES, directoryAuthority: this.outputAuthority,
    }).text();
    const snapshot = runCmd(new NodeScriptInvocation({ script: "scripts/task-review-snapshot-probe.js", args: [root, this.specId],
      cwd: root, env: environment }), [], { encoding: "utf8", timeout: 30_000 });
    new AtomicFile(path.join(this.output, `${name}-snapshot.log`), {
      directoryAuthority: this.outputAuthority,
    }).write(snapshot.stdout + snapshot.stderr);
    if (snapshot.errorCode) throw new Error(`measurement snapshot failed: ${snapshot.errorCode}: ${snapshot.stderr}`);
    const row = {
      name, removed, exitCode: result.status, signal: result.signal,
      passed: [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((entry) => entry[1]),
      failed: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((entry) => entry[1]),
      snapshotExitCode: snapshot.status,
      testDigest: visitRegularFileChunks(path.join(root, testFile), {
        label: "measurement frozen test", maxBytes: Number.MAX_SAFE_INTEGER - 1, visit() {},
      }).digest,
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
