import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
import { GitOutputObserver } from "../../support/infrastructure/git-output-observer.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function useRepositoryTmpdir(t, root) {
  const original = process.env.TMPDIR;
  t.after(() => {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  });
  const directory = path.join(root, "local-tmp");
  fs.mkdirSync(directory);
  process.env.TMPDIR = directory;
  return directory;
}

function assertTemporaryOutputsRemoved(observer, repositoryTmpdir) {
  observer.assertRemoved();
  // Coordinator endpoint replies intentionally outlive their creator. This
  // observer owns only the fingerprint's Git-output namespace.
  assert.equal(fs.readFileSync(path.join(repositoryTmpdir, "caller-sentinel"), "utf8"), "caller bytes");
  assert.equal(process.env.TMPDIR, repositoryTmpdir);
}

test("removes temporary Git output when an unborn HEAD prevents fingerprinting", (t) => {
  const root = createTmpDir("fingerprint-git-failure-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  const temporary = useRepositoryTmpdir(t, root);
  const observer = new GitOutputObserver(t, root);
  fs.writeFileSync(path.join(temporary, "caller-sentinel"), "caller bytes");

  assert.throws(() => finalRegressionWorktreeFingerprint(root), /final-regression git diff failed: exit=128/);
  assertTemporaryOutputsRemoved(observer, temporary);
});

test("closes input descriptors and removes Git output when filesystem reading fails", (t) => {
  const root = createTmpDir("fingerprint-read-failure-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  initGitRepo(root);
  commitAll(root, "Create read failure fixture");
  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  const temporary = useRepositoryTmpdir(t, root);
  const observer = new GitOutputObserver(t, root);
  fs.writeFileSync(path.join(temporary, "caller-sentinel"), "caller bytes");
  const descriptors = [];
  const active = new Map();
  const open = fs.openSync;
  const close = fs.closeSync;
  const read = fs.readSync;
  t.mock.method(fs, "openSync", (file, flags, ...args) => {
    const descriptor = open(file, flags, ...args);
    // A visible path is still read inside AtomicFile publication. Inject only
    // after its real publication method has returned the completed receipt.
    // Runtime authority and publication readback continue using real reads.
    if (observer.publications.some(publication => publication.path === file)) {
      const observed = { descriptor, closed: false };
      active.set(descriptor, observed);
      descriptors.push(observed);
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    close(descriptor);
    const observed = active.get(descriptor);
    if (observed) { observed.closed = true; active.delete(descriptor); }
  });
  const failure = Object.assign(new Error("filesystem read unavailable"), { code: "EIO" });
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    if (active.has(descriptor)) throw failure;
    return read(descriptor, ...args);
  });

  assert.throws(() => finalRegressionWorktreeFingerprint(root), (error) => error === failure);
  assert.ok(descriptors.length > 0, "A published Git output file was opened before the read failure");
  // Record successful close of each opened lifetime. Its numeric descriptor
  // may legitimately be reused by unrelated runtime work after that close.
  assert.ok(descriptors.every(observed => observed.closed));
  assert.equal(active.size, 0);
  assertTemporaryOutputsRemoved(observer, temporary);
});

test("preserves the caller environment when temporary output cannot be created", (t) => {
  const root = createTmpDir("fingerprint-create-failure-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  initGitRepo(root);
  commitAll(root, "Create temporary output failure fixture");
  const temporary = useRepositoryTmpdir(t, root);
  const failure = Object.assign(new Error("temporary directory unavailable"), { code: "EACCES" });
  t.mock.method(fs, "mkdtempSync", () => { throw failure; });

  assert.throws(() => finalRegressionWorktreeFingerprint(root), (error) => error === failure);
  assert.equal(process.env.TMPDIR, temporary);
  assert.deepEqual(fs.readdirSync(temporary), []);
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "original\n");
});
