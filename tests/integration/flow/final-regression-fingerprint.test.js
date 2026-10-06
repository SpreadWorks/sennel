import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { finalRegressionWorktreeFingerprint, FinalRegressionRepositoryBinding } from "../../../src/flow/lib/test-artifacts.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function deterministicBinary(seed) {
  const bytes = Buffer.alloc(700_000);
  let state = seed;
  for (let index = 1; index < bytes.length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

// The prior contract hashes complete Git stdout decoded as UTF-8, then raw
// untracked file bytes. This fixture oracle deliberately buffers the output.
function completeGitFingerprint(root, pathspecExcludes = []) {
  const pathspec = ["--", ".", ...pathspecExcludes];
  const run = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const staged = run(["diff", "--cached", "--no-ext-diff", "--binary", "HEAD", ...pathspec]);
  const unstaged = run(["diff", "--no-ext-diff", "--binary", ...pathspec]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec])
    .toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update("staged\0").update(staged.toString("utf8"))
    .update("\0unstaged\0").update(unstaged.toString("utf8"));
  for (const relative of untracked) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isFile() && !stat.isSymbolicLink()) hash.update("\0").update(relative).update("\0")
      .update(fs.readFileSync(absolute));
  }
  return { fingerprint: hash.digest("hex"), staged, unstaged };
}

test("fingerprints complete oversized text and binary diffs, preserving Unicode and stale binding checks", (t) => {
  const root = createTmpDir("final-regression-large-fingerprint-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  fs.writeFileSync(path.join(root, "tracked.bin"), deterministicBinary(1));
  initGitRepo(root);
  commitAll(root, "Create complete fingerprint fixture");
  fs.writeFileSync(path.join(root, "tracked.txt"), "界🧭".repeat(200_000) + "\nstaged\n");
  fs.writeFileSync(path.join(root, "tracked.bin"), deterministicBinary(2));
  execFileSync("git", ["add", "tracked.txt", "tracked.bin"], { cwd: root });
  fs.writeFileSync(path.join(root, "tracked.txt"), "🧭界".repeat(200_000) + "\nunstaged\n");
  fs.writeFileSync(path.join(root, "tracked.bin"), deterministicBinary(3));
  const untracked = path.join(root, "証拠🧭.dat");
  fs.writeFileSync(untracked, deterministicBinary(4));
  fs.mkdirSync(path.join(root, "ignored-output"));
  const excluded = path.join(root, "ignored-output", "result.txt");
  fs.writeFileSync(excluded, "first generated result\n");
  const options = { pathspecExcludes: [":(exclude)ignored-output/**"] };
  const oracle = completeGitFingerprint(root, options.pathspecExcludes);
  for (const output of [oracle.staged, oracle.unstaged]) {
    assert.ok(output.length > 1024 * 1024, "Each complete diff exceeds the former Git output buffer");
    const boundaries = Array.from({ length: Math.floor((output.length - 1) / (64 * 1024)) },
      (_, index) => (index + 1) * 64 * 1024);
    assert.ok(boundaries.some((offset) => (output[offset] & 0xc0) === 0x80),
      "The complete UTF-8 diff contains a multibyte character across a chunk boundary");
  }
  assert.equal(finalRegressionWorktreeFingerprint(root, options), oracle.fingerprint);
  const binding = FinalRegressionRepositoryBinding.capture(root, options);
  assert.equal(binding.worktreeSha256, oracle.fingerprint);
  assert.equal(binding.matches(FinalRegressionRepositoryBinding.capture(root, options)), true);

  fs.writeFileSync(excluded, "changed generated result\n");
  assert.equal(finalRegressionWorktreeFingerprint(root, options), oracle.fingerprint);
  assert.equal(binding.matches(FinalRegressionRepositoryBinding.capture(root, options)), true);
  fs.writeFileSync(untracked, deterministicBinary(5));
  const changed = completeGitFingerprint(root, options.pathspecExcludes).fingerprint;
  assert.notEqual(changed, oracle.fingerprint);
  assert.equal(finalRegressionWorktreeFingerprint(root, options), changed);
  assert.equal(binding.matches(FinalRegressionRepositoryBinding.capture(root, options)), false);
});

test("keeps temporary Git output outside a repository-owned TMPDIR and restores the caller environment", (t) => {
  const root = createTmpDir("final-regression-internal-tmp-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  initGitRepo(root);
  commitAll(root, "Create repository-owned temporary directory fixture");
  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "retain this untracked input\n");
  const temporary = path.join(root, "local-tmp");
  fs.mkdirSync(temporary);
  const expected = completeGitFingerprint(root).fingerprint;
  const original = process.env.TMPDIR;
  try {
    process.env.TMPDIR = temporary;
    assert.equal(finalRegressionWorktreeFingerprint(root), expected);
    assert.deepEqual(fs.readdirSync(temporary), []);
    assert.equal(process.env.TMPDIR, temporary);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
  assert.equal(process.env.TMPDIR, original);
  assert.equal(finalRegressionWorktreeFingerprint(root), expected);
});
