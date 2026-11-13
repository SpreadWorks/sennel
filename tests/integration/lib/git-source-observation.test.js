import { withReadOnlyManagedProcessScope } from "../../../src/lib/managed-process.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { GitConfigurationObservation, GitReferenceObservation, GitIndexObservation, readGitBoolean } from "../../../src/lib/git-source-observation.js";
import { captureRegularFile } from "../../../src/lib/regular-file-snapshot.js";

const maxBytes = 64 * 1024 * 1024;
function fixture(t) {
  const root = createTmpDir("sennel-git-source-observation-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);
  const git = (args, input) => execFileSync("git", args, { cwd: root, input, maxBuffer: maxBytes,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_PARAMETERS: "'diff.autoRefreshIndex=false'" } });
  git(["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(root, "included")); fs.mkdirSync(path.join(root, "excluded"));
  for (const [name, content] of [["plain.txt", "plain\n"], ["space é.txt", "raw\r\n"], ["NFD-e\u0301.txt", "raw\n"],
    ["included/one.txt", "one\n"], ["excluded/two.txt", "two\n"], [".gitattributes", "*.txt text eol=lf\n*.bin -text\n"]]) {
    fs.writeFileSync(path.join(root, name), content);
  }
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 255, 1]));
  commitAll(root, "Source observation seed");
  return { root, git };
}

function compare(root, git, limit = maxBytes) {
  const indexPath = path.join(root, ".git", "index");
  const before = fs.existsSync(indexPath) ? captureRegularFile(indexPath, { label: "source observation index", maxBytes }) : null;
  const references = git(["show-ref", "--head"]);
  const head = new GitReferenceObservation(references).head;
  assert.equal(head, git(["rev-parse", "HEAD"]).toString().trim());
  const observed = GitIndexObservation.read({ snapshot: before, objectIdLength: head.length, maxBytes: limit, read: (args) => git(args) });
  assert.deepEqual(observed.index, git(["ls-files", "--stage", "-z"]));
  assert.deepEqual(observed.flags, git(["ls-files", "-v", "-z"]));
  assert.deepEqual(observed.materialization, git(["ls-files", "--eol", "-z"]));
  if (before !== null) {
    const after = captureRegularFile(indexPath, { label: "source observation index", maxBytes });
    assert.deepEqual(after.bytes, before.bytes);
    assert.ok(after.identity.equals(before.identity));
  } else assert.equal(fs.existsSync(indexPath), false);
}

it("preserves exact Git streams for ordinary, extended, compressed, split and missing indexes", (t) => {
  const { root, git } = fixture(t);
  for (const version of [2, 3, 4]) {
    git(["update-index", `--index-version=${version}`]); compare(root, git);
  }
  git(["update-index", "--index-version=3"]);
  git(["update-index", "--assume-unchanged", "--", "plain.txt"]);
  git(["update-index", "--skip-worktree", "--", "space é.txt"]);
  compare(root, git);
  fs.writeFileSync(path.join(root, "intent.txt"), "intent\n"); git(["add", "--intent-to-add", "--", "intent.txt"]);
  compare(root, git);
  const oid = git(["rev-parse", "HEAD:plain.txt"]).toString().trim();
  git(["update-index", "--add", "--cacheinfo", `160000,${oid},gitlink`]);
  git(["update-index", "--index-info"], Buffer.from(`100644 ${oid} 1\tconflict.txt\n100644 ${oid} 2\tconflict.txt\n100644 ${oid} 3\tconflict.txt\n`));
  compare(root, git);
  git(["update-index", "--split-index"]); compare(root, git);
  // A conservative bound selects independent queries before execution. Each
  // stream still equals the native stream at a smaller admissible budget.
  compare(root, git, 4096);
  fs.unlinkSync(path.join(root, ".git", "index")); compare(root, git);
  git(["update-ref", "--no-deref", "HEAD", git(["rev-parse", "HEAD"]).toString().trim()]); compare(root, git);
});

it("retains native sparse-index expansion and leaves the physical index unchanged", (t) => {
  const { root, git } = fixture(t);
  git(["sparse-checkout", "init", "--cone", "--sparse-index"]);
  git(["sparse-checkout", "set", "included"]);
  compare(root, git);
});

it("matches native last-value and uncommon boolean semantics from the captured configuration", (t) => {
  const { git } = fixture(t);
  for (const value of ["true", "false", "YES", "off", "", "2k", "-1"]) {
    const prefix = ["-c", `observation.value=${value}`];
    const configuration = new GitConfigurationObservation(git([...prefix, "config", "--null", "--list", "--show-origin"]));
    const expected = git([...prefix, "config", "--bool", "--get", "observation.value"]).toString().trim() === "true";
    assert.equal(configuration.boolean("observation.value", false,
      () => git([...prefix, "config", "--bool", "--get", "observation.value"]).toString().trim() === "true"), expected);
  }
  const prefix = ["-c", "observation.value=invalid", "-c", "observation.value=true"];
  const configuration = new GitConfigurationObservation(git([...prefix, "config", "--null", "--list", "--show-origin"]));
  assert.equal(configuration.boolean("observation.value", false, () => assert.fail("the shadowed invalid value is not selected")), true);
});

it("uses the common native boolean reader for uncommon values, defaults and invalid configuration", async (t) => {
  const { root, git } = fixture(t);
  await withReadOnlyManagedProcessScope({ mainRoot: root }, () => {
    assert.equal(readGitBoolean(root, "observation.missing", false), false);
    git(["config", "observation.numeric", "2k"]);
    assert.equal(readGitBoolean(root, "observation.numeric", false), true);
    git(["config", "observation.numeric", "invalid"]);
    assert.throws(() => readGitBoolean(root, "observation.numeric", true), /failed to read observation.numeric/);
  });
});

import crypto from "node:crypto";
import { WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";

function fixtureWithObjectFormat(t, objectFormat) {
  const previous = process.env.GIT_DEFAULT_HASH;
  const restore = () => {
    if (previous === undefined) delete process.env.GIT_DEFAULT_HASH;
    else process.env.GIT_DEFAULT_HASH = previous;
  };
  t.after(restore);
  try { process.env.GIT_DEFAULT_HASH = objectFormat; return fixture(t); }
  finally { restore(); }
}

it("prepared reads retain exact native index and attribute streams for v2/v3 in both object formats", (t) => {
  for (const objectFormat of ["sha1", "sha256"]) {
    const { root, git } = fixtureWithObjectFormat(t, objectFormat);
    const width = objectFormat === "sha1" ? 40 : 64;
    const head = git(["rev-parse", "HEAD"]).toString().trim(); assert.equal(head.length, width);
    for (const version of [2, 3]) {
      git(["update-index", `--index-version=${version}`]);
      if (version === 3) git(["update-index", "--skip-worktree", "--", "space é.txt"]);
      const before = captureRegularFile(path.join(root, ".git", "index"), { label: "prepared index", maxBytes });
      const plan = GitIndexObservation.prepare({ snapshot: before, maxBytes });
      assert.notEqual(plan, null);
      const observed = plan.observe(git(plan.args), width);
      const expected = git(["ls-files", "--stage", "-z"]);
      assert.deepEqual(observed.index, expected);
      assert.deepEqual(observed.flags, git(["ls-files", "-v", "-z"]));
      assert.deepEqual(observed.materialization, git(["ls-files", "--eol", "-z"]));
      const input = Buffer.from(expected.toString("utf8").split("\0").filter(Boolean).map((record) => record.slice(record.indexOf("\t") + 1)).join("\0") + "\0");
      assert.deepEqual(plan.attributeInput, input);
      for (const args of [["check-attr", "--all", "--stdin", "-z"], ["check-attr", "--cached", "--all", "--stdin", "-z"]]) {
        assert.deepEqual(git(args, plan.attributeInput), git(args, input));
      }
      const after = captureRegularFile(path.join(root, ".git", "index"), { label: "prepared index", maxBytes });
      assert.deepEqual(after.bytes, before.bytes); assert.ok(after.identity.equals(before.identity));
    }
  }
});

it("a genuine index path change after preparation refuses the later native observation", (t) => {
  const { root, git } = fixture(t);
  const captured = captureRegularFile(path.join(root, ".git", "index"), { label: "prepared index", maxBytes });
  const plan = GitIndexObservation.prepare({ snapshot: captured, maxBytes }); assert.notEqual(plan, null);
  git(["mv", "--", "plain.txt", "renamed.txt"]);
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  assert.throws(() => plan.observe(git(plan.args), head.length), /paths differ from the native index/);
});

it("source authority publishes and reloads native index evidence through both prepared and compressed-index reads", (t) => {
  const { root, git } = fixture(t);
  for (const version of [2, 4]) {
    git(["update-index", `--index-version=${version}`]);
    const captured = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
    const native = git(["ls-files", "--stage", "-z"]);
    assert.equal(captured.mode, "git");
    assert.equal(captured.head, git(["rev-parse", "HEAD"]).toString().trim());
    assert.equal(captured.indexDigest, crypto.createHash("sha256").update(native).digest("hex"));
    const stored = JSON.parse(JSON.stringify(captured.toJSON()));
    const reopened = WorkerArtifactRepositoryMutationSnapshot.fromStored(stored, { root, authorities: ["execution"] });
    assert.deepEqual(reopened.toJSON(), captured.toJSON());
    assert.equal(reopened.digest, captured.digest);
    assert.deepEqual(git(["ls-files", "--stage", "-z"]), native);
  }
});
