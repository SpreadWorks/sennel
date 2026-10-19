import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
import { dispatchRepositoryFingerprint } from "../../../src/flow/lib/run-dispatch.js";
import { RegressionFileSnapshot } from "../../../src/flow/lib/regression-file-snapshot.js";
import { AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { runGitToFile } from "../../../src/lib/git-helpers.js";
import { Logger } from "../../../src/lib/log.js";
import { container } from "../../../src/lib/container.js";
import { todayLocal, readJsonl } from "../../support/infrastructure/log-fixtures.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function repository(t, prefix) {
  const root = createTmpDir(prefix);
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  initGitRepo(root);
  commitAll(root, "Create fingerprint review fixture");
  return root;
}

function realLogger(t, root) {
  // No ignore file or pathspec excludes this directory from the fingerprint.
  const logDir = path.join(root, "included-log-output");
  fs.mkdirSync(logDir);
  const logFile = path.join(logDir, `sennel-${todayLocal()}.jsonl`);
  fs.writeFileSync(logFile, '{"type":"fixture","value":"fixed input"}\n');
  const logger = new Logger({ logDir, enabled: true, flowAttribution: "none", cwd: root });
  container.reset();
  container.register("logger", logger);
  t.after(async () => {
    await logger.flush();
    container.reset();
  });
  return [logger, logFile];
}

// Observe real file I/O without replacing Git or the fingerprint algorithm.
class GitOutputObserver {
  constructor(t) {
    this.directories = [];
    this.existingBeforeWrite = [];
    this.readDescriptors = [];
    this.peakBytes = 0;
    const create = fs.mkdtempSync;
    const open = fs.openSync;
    const close = fs.closeSync;
    const writes = new Set();
    t.mock.method(fs, "mkdtempSync", (...args) => {
      const directory = create(...args);
      this.directories.push(directory);
      return directory;
    });
    t.mock.method(fs, "openSync", (file, flags, ...args) => {
      const owned = this.directories.includes(path.dirname(file));
      if (owned && (flags === "wx" || flags === "wx+")) {
        this.existingBeforeWrite.push(fs.readdirSync(path.dirname(file)));
      }
      const descriptor = open(file, flags, ...args);
      if (owned && (flags === "wx" || flags === "wx+")) writes.add(descriptor);
      if (owned && flags === "r") this.readDescriptors.push(descriptor);
      return descriptor;
    });
    t.mock.method(fs, "closeSync", (descriptor) => {
      close(descriptor);
      if (writes.delete(descriptor)) {
        const bytes = this.directories.reduce((sum, directory) => sum
          + fs.readdirSync(directory).reduce((total, name) => total
            + fs.statSync(path.join(directory, name)).size, 0), 0);
        this.peakBytes = Math.max(this.peakBytes, bytes);
      }
    });
  }

  assertRemoved() {
    assert.equal(this.directories.length, 1, "One calculation owns one temporary directory");
    assert.equal(fs.existsSync(this.directories[0]), false);
  }
}

test("hashes complete large output while releasing each stdout before the next Git execution", (t) => {
  const root = repository(t, "fingerprint-sequential-output-");
  fs.writeFileSync(path.join(root, "tracked.txt"), "界🧭".repeat(200_000) + "\nstaged\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "tracked.txt"), "🧭界".repeat(200_000) + "\nunstaged\n");
  const untrackedName = "証拠🧭.dat";
  const payload = Buffer.from([0, 255, 42]);
  fs.writeFileSync(path.join(root, untrackedName), payload);
  const gitOutput = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const staged = gitOutput(["diff", "--cached", "--no-ext-diff", "--binary", "HEAD", "--", "."]);
  const unstaged = gitOutput(["diff", "--no-ext-diff", "--binary", "--", "."]);
  const listing = gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  assert.ok(staged.length > 1024 * 1024 && unstaged.length > 1024 * 1024);
  assert.equal(listing.toString("utf8"), `${untrackedName}\0`);
  const expected = createHash("sha256").update("staged\0").update(staged.toString("utf8"))
    .update("\0unstaged\0").update(unstaged.toString("utf8"))
    .update("\0").update(untrackedName).update("\0").update(payload).digest("hex");
  const observer = new GitOutputObserver(t);

  assert.equal(finalRegressionWorktreeFingerprint(root), expected);
  observer.assertRemoved();
  t.diagnostic(JSON.stringify({
    checksum: expected,
    stdoutBytes: [staged.length, unstaged.length, listing.length],
    peakBytes: observer.peakBytes,
    sequentialPeakBytes: Math.max(staged.length, unstaged.length, listing.length),
    existingBeforeWrite: observer.existingBeforeWrite,
  }));
  assert.deepEqual(observer.existingBeforeWrite, [[], [], []]);
  assert.equal(observer.peakBytes, Math.max(staged.length, unstaged.length, listing.length));
});

for (const [name, capture] of [
  ["direct", (root) => finalRegressionWorktreeFingerprint(root)],
  ["dispatcher", (root) => dispatchRepositoryFingerprint({ root: path.dirname(root), executionRoot: root })],
]) {
  test(`${name} fingerprint stays stable across real Logger.flush with included log output`, async (t) => {
    const root = repository(t, `fingerprint-${name}-logger-`);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    const [logger, logFile] = realLogger(t, root);
    const originalLog = fs.readFileSync(logFile);
    const first = capture(root);
    await logger.flush();
    const second = capture(root);
    await logger.flush();
    t.diagnostic(JSON.stringify({ first, second, gitRecords: readJsonl(logFile).filter((entry) => entry.type === "git").length }));

    assert.equal(second, first);
    assert.deepEqual(fs.readFileSync(logFile), originalLog);
    logger.event("deliberate-input-change", { value: "changed" });
    await logger.flush();
    assert.notEqual(capture(root), first, "Logger output remains part of the checksum input");
    await logger.flush();
  });
}

test("runGitToFile logs by default and for true, and false preserves execution without logging", async (t) => {
  const root = repository(t, "git-file-logging-option-");
  const [logger, logFile] = realLogger(t, root);
  const args = ["rev-parse", "HEAD"];
  const expected = execFileSync("git", args, { cwd: root });
  const results = [];
  for (const [name, options] of [["default", {}], ["true", { log: true }], ["false", { log: false }]]) {
    const outputPath = path.join(root, `${name}.out`);
    results.push(runGitToFile(args, { cwd: root, outputPath, ...options }));
    assert.deepEqual(fs.readFileSync(outputPath), expected);
  }
  await logger.flush();
  assert.deepEqual(results[0], { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false });
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  const records = readJsonl(logFile).filter((entry) => entry.type === "git");
  t.diagnostic(JSON.stringify({ gitRecords: records.length, results }));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.deepEqual(record.cmd, ["git", ...args]);
    assert.equal(record.exitCode, 0);
    assert.equal(record.stderr, "");
  }
});

test("runGitToFile false keeps Git failure output and status while suppressing its log", async (t) => {
  const root = repository(t, "git-file-failure-logging-");
  const [logger, logFile] = realLogger(t, root);
  const args = ["not-a-git-subcommand"];
  const normalPath = path.join(root, "default-failure.out");
  const silentPath = path.join(root, "silent-failure.out");
  const normal = runGitToFile(args, { cwd: root, outputPath: normalPath });
  const silent = runGitToFile(args, { cwd: root, outputPath: silentPath, log: false });
  await logger.flush();

  assert.equal(normal.ok, false);
  assert.notEqual(normal.status, 0);
  assert.ok(normal.stderr.length > 0);
  assert.deepEqual(silent, normal);
  assert.deepEqual(fs.readFileSync(silentPath), fs.readFileSync(normalPath));
  const records = readJsonl(logFile).filter((entry) => entry.type === "git");
  assert.equal(records.length, 1);
  assert.equal(records[0].exitCode, normal.status);
  assert.equal(records[0].stderr, normal.stderr);
});

test("runGitToFile publishes complete stdout from a nonzero Git diff without buffering it", (t) => {
  const root = repository(t, "git-file-nonzero-stdout-");
  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  const args = ["diff", "--exit-code", "--no-ext-diff", "--", "tracked.txt"];
  let expected;
  try { execFileSync("git", args, { cwd: root }); }
  catch (error) { assert.equal(error.status, 1); expected = error.stdout; }
  assert.ok(expected.length > 0);
  const outputPath = path.join(root, "nonzero.diff");
  const result = runGitToFile(args, { cwd: root, outputPath, log: false });
  assert.equal(result.status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readFileSync(outputPath), expected);
});

test("regression file snapshots preserve complete byte hashes and strict saved logical paths", (t) => {
  const root = createTmpDir("regression-stream-snapshot-");
  t.after(() => removeTmpDir(root));
  fs.mkdirSync(path.join(root, "src"));
  const bytes = Buffer.alloc(200000, 0xa5);
  fs.writeFileSync(path.join(root, "src", "資料.bin"), bytes);
  const concat = Buffer.concat;
  let captured;
  Buffer.concat = () => { throw new Error("fingerprint must not concatenate file contents"); };
  try { captured = RegressionFileSnapshot.fromChangedFile(root, { status: "modified", path: "src\\資料.bin" }); }
  finally { Buffer.concat = concat; }
  assert.equal(captured.fingerprint, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(captured.path, "src/資料.bin");
  assert.deepEqual(RegressionFileSnapshot.fromJSON(captured.toJSON()), captured);
  assert.throws(() => RegressionFileSnapshot.fromJSON({ ...captured.toJSON(), path: "src\\資料.bin" }), /logical path/);
  assert.throws(() => RegressionFileSnapshot.fromChangedFile(root, { status: "added", path: "CON.bin" }), /logical path/);
  assert.equal(RegressionFileSnapshot.fromChangedFile(root, { status: "deleted", path: "missing.bin" }).fingerprint, null);
});

test("regression fingerprint refuses an observed replacement while preserving the actor bytes", (t) => {
  const root = createTmpDir("regression-stream-replacement-");
  t.after(() => removeTmpDir(root));
  const file = path.join(root, "entry.bin");
  fs.writeFileSync(file, "old");
  const read = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (!replaced && count > 0) {
      replaced = true;
      fs.writeFileSync(`${file}.new`, "new");
      fs.renameSync(`${file}.new`, file);
    }
    return count;
  });
  assert.throws(() => RegressionFileSnapshot.fromChangedFile(root, { status: "modified", path: "entry.bin" }),
    (error) => error.reason === "identity");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("closes the input file and removes all temporary output when Buffer allocation fails", (t) => {
  const root = repository(t, "fingerprint-allocation-failure-");
  const observer = new GitOutputObserver(t);
  const failure = new RangeError("fixture Buffer allocation failure");
  const allocate = Buffer.allocUnsafe;
  t.mock.method(Buffer, "allocUnsafe", (size) => {
    if (size === 64 * 1024) throw failure;
    return allocate(size);
  });

  assert.throws(() => finalRegressionWorktreeFingerprint(root), (error) => {
    assert.ok(error instanceof AtomicFileWriteError);
    assert.equal(error.cause, failure);
    assert.equal(error.committedToVisibleName, false);
    assert.equal(error.publicationUnknown, false);
    assert.equal(error.cleanupFailed, false);
    return true;
  });
  assert.ok(observer.readDescriptors.length > 0);
  for (const descriptor of observer.readDescriptors) {
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  }
  observer.assertRemoved();
});

test("refuses a failed stdout deletion and still removes the complete temporary directory", (t) => {
  const root = repository(t, "fingerprint-output-deletion-failure-");
  const observer = new GitOutputObserver(t);
  const failure = Object.assign(new Error("fixture output deletion denied"), { code: "EACCES" });
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file) => {
    // The scenario refuses removal of published stdout, after shared stage
    // publication/cleanup has completed; stage unlink has its own boundary tests.
    if (!path.basename(file).startsWith(".")) throw failure;
    return unlink(file);
  });

  assert.throws(() => finalRegressionWorktreeFingerprint(root), (error) => {
    assert.ok(error instanceof AtomicFileWriteError);
    assert.equal(error.cause, failure);
    assert.equal(error.code, "ATOMIC_FILE_WRITE_FAILED");
    assert.equal(error.committedToVisibleName, false);
    assert.equal(error.publicationUnknown, false);
    assert.equal(error.cleanupFailed, false);
    return true;
  });
  observer.assertRemoved();
});
