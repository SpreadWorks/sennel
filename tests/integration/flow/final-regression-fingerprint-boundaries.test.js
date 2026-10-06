import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
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

function observeTemporaryDirectories(t) {
  const directories = [];
  const create = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const directory = create(...args);
    directories.push(directory);
    return directory;
  });
  return directories;
}

function assertTemporaryOutputsRemoved(directories, repositoryTmpdir) {
  assert.ok(directories.length > 0, "Git output used a temporary directory");
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readdirSync(repositoryTmpdir), []);
  assert.equal(process.env.TMPDIR, repositoryTmpdir);
}

test("removes temporary Git output when an unborn HEAD prevents fingerprinting", (t) => {
  const root = createTmpDir("fingerprint-git-failure-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  const temporary = useRepositoryTmpdir(t, root);
  const directories = observeTemporaryDirectories(t);

  assert.throws(() => finalRegressionWorktreeFingerprint(root), /final-regression git diff failed: exit=128/);
  assertTemporaryOutputsRemoved(directories, temporary);
});

test("closes input descriptors and removes Git output when filesystem reading fails", (t) => {
  const root = createTmpDir("fingerprint-read-failure-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  initGitRepo(root);
  commitAll(root, "Create read failure fixture");
  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  const temporary = useRepositoryTmpdir(t, root);
  const directories = observeTemporaryDirectories(t);
  const descriptors = [];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file, flags, ...args) => {
    const descriptor = open(file, flags, ...args);
    if (flags === "r") descriptors.push(descriptor);
    return descriptor;
  });
  const failure = Object.assign(new Error("filesystem read unavailable"), { code: "EIO" });
  t.mock.method(fs, "readSync", () => { throw failure; });

  assert.throws(() => finalRegressionWorktreeFingerprint(root), (error) => error === failure);
  assert.ok(descriptors.length > 0, "A Git output file was opened before the read failure");
  for (const descriptor of descriptors) {
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  }
  assertTemporaryOutputsRemoved(directories, temporary);
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
