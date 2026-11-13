import { isUtf8 } from "node:buffer";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { ProcessExecutionCanonicalAcknowledgement, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { WorkerArtifactRepositoryMutationSnapshot, WorkerArtifactSourceRollbackCheckpoint, WorkerArtifactMutationAuthoritySnapshot, SourceMutationBaseline, SourceMutationManifest } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { SourceWorkingFileCapture } from "../../../src/flow/lib/source-working-file-capture.js";
import { TaskReviewUnsealedCheckpoint } from "../../../src/flow/lib/task-review-recovery-checkpoint.js";

function fixture(t, { git = true } = {}) {
  const root = createTmpDir("source-portable-"); t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  if (git) { initGitRepo(root); fs.writeFileSync(path.join(root, "seed"), "seed\n"); commitAll(root, "source baseline"); }
  return root;
}
function command(root, ...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function capture(root) { return WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] }); }
function baseline(snapshot) { return new SourceMutationBaseline({ snapshot, attempt: { id: "attempt", nodeId: "implement", sequence: 1 } }); }

function sourceTest(name, callback) {
  it(name, async (t) => {
    const root = fixture(t);
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    try { await runtime.enter(() => callback(t, root)); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(cause); throw cause; }
    finally {
      try { await runtime.close(); }
      catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(cause); throw cause; }
    }
  });
}

// Simulate only a normalization-insensitive native lookup. Node's realpath
// preserves requested non-link spelling; it is not a Unicode spelling resolver.
// This is a boundary test on Linux, not proof of macOS hardware behavior.
function mockNativeNormalization(t, root) {
  const native = (value) => typeof value === "string" && value.startsWith(`${root}${path.sep}`)
    ? root + value.slice(root.length).normalize("NFD") : value;
  const lstat = fs.lstatSync; const open = fs.openSync; const realpath = fs.realpathSync;
  t.mock.method(fs, "lstatSync", (value, ...args) => lstat(native(value), ...args));
  t.mock.method(fs, "openSync", (value, ...args) => open(native(value), ...args));
  t.mock.method(fs, "realpathSync", (value, ...args) => {
    const requested = native(value); const resolved = realpath(requested, ...args);
    return resolved === requested ? value : resolved;
  });
}

it("projects one native source inventory onto Git spelling only after physical identity proof", (t) => {
  const root = fixture(t, { git: false });
  const nativeParent = "Cafe\u0301"; const nativeFile = `${nativeParent}/e\u0301.bin`;
  const bytes = Buffer.from([0, 255, 13, 10]);
  fs.mkdirSync(path.join(root, nativeParent));
  fs.writeFileSync(path.join(root, nativeFile), bytes);
  fs.writeFileSync(path.join(root, nativeParent, "untracked"), "untracked");
  const physical = capture(root).entries;
  mockNativeNormalization(t, root);
  const direct = SourceWorkingFileCapture.capture(root, "Café/é.bin", { maxBytes: 1024, retainBytes: true });
  assert.deepEqual(direct.snapshot.bytes, bytes, "direct source readers retain binary bytes through native normalization");
  const projected = SourceWorkingFileCapture.projectGitPaths(root, physical, ["Café/é.bin", "Café/missing"], { maxBytes: 1024 });
  assert.deepEqual(projected.map((entry) => [entry.path, entry.workingPath]), [
    ["Café", nativeParent], ["Café/untracked", `${nativeParent}/untracked`], ["Café/é.bin", nativeFile],
  ]);
  assert.equal(projected.find((entry) => entry.path === "Café/é.bin").working.generation.equals(direct.working.generation), true);
  assert.equal(SourceWorkingFileCapture.capture(root, "Café/missing", { maxBytes: 1024 }).working.kind, "missing");
  assert.throws(() => SourceWorkingFileCapture.projectGitPaths(root, physical, ["Café/é.bin", "Cafe\u0301/other"], { maxBytes: 1024 }), /paths collide/);
});

it("refuses separate physical Unicode aliases without treating them as one Git source", { skip: process.platform !== "linux" }, (t) => {
  const root = fixture(t, { git: false });
  fs.writeFileSync(path.join(root, "e\u0301.bin"), "native");
  const original = capture(root).entries;
  assert.throws(() => SourceWorkingFileCapture.projectGitPaths(root, original, ["é.bin"], { maxBytes: 1024 }), /paths collide/,
    "a missing logical name cannot adopt a merely equivalent physical name on Linux");
  fs.writeFileSync(path.join(root, "é.bin"), "distinct");
  assert.throws(() => capture(root), /paths collide/);
  assert.equal(fs.readFileSync(path.join(root, "e\u0301.bin"), "utf8"), "native");
  assert.equal(fs.readFileSync(path.join(root, "é.bin"), "utf8"), "distinct");
});

describe("portable source raw before-images", () => {
  sourceTest("joins native decomposed names to a composed Git index and restores their raw before-images", (t, root) => {
    const logical = "Café/é.bin"; const nativeParent = "Cafe\u0301"; const nativeFile = `${nativeParent}/e\u0301.bin`;
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 255, 13, 10]);
    command(root, "config", "core.filemode", "false");
    command(root, "config", "core.precomposeUnicode", "true");
    fs.mkdirSync(path.join(root, nativeParent)); fs.writeFileSync(path.join(root, nativeFile), bytes);
    fs.writeFileSync(path.join(root, nativeParent, "untracked"), "untracked before");
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: bytes }).toString("ascii").trim();
    command(root, "update-index", "--add", "--cacheinfo", "100644", oid, logical);
    command(root, "update-index", "--add", "--cacheinfo", "100644", oid, "Café/missing");
    command(root, "commit", "-qm", "composed index with decomposed native names");
    const index = fs.readFileSync(path.join(root, ".git", "index"));
    mockNativeNormalization(t, root);
    const prior = SourceMutationBaseline.capture({ root, attempt: { id: "attempt", nodeId: "implement", sequence: 1 } });
    const stored = prior.toJSON();
    assert.equal(prior.snapshot.entries.find((entry) => entry.path === logical).workingPath, nativeFile);
    assert.equal(prior.snapshot.entries.find((entry) => entry.path === "Café/untracked").workingPath, `${nativeParent}/untracked`);
    assert.equal(prior.snapshot.entries.find((entry) => entry.path === "Café/missing").kind, "missing");
    assert.deepEqual(SourceMutationBaseline.fromStored(stored, { root }).toJSON(), stored);
    const blob = new WorkerArtifactSourceRollbackCheckpoint([prior.snapshot]).blobBytes();
    fs.unlinkSync(path.join(root, nativeFile)); fs.writeFileSync(path.join(root, nativeParent, "untracked"), "worker");
    const stopped = SourceMutationManifest.capture({ baseline: prior });
    assert.deepEqual(stopped.paths(), ["Café/untracked", logical]);
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.deepEqual(fs.readFileSync(path.join(root, nativeFile)), bytes);
    assert.equal(fs.readFileSync(path.join(root, nativeParent, "untracked"), "utf8"), "untracked before");
    assert.equal(fs.existsSync(path.join(root, nativeParent, "missing")), false);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
    assert.deepEqual(SourceMutationManifest.capture({ baseline: prior }).paths(), []);
  });
  sourceTest("reloads clean and dirty raw CRLF/BOM/binary bytes without applying source filters", (t, root) => {
    const clean = Buffer.from([0xef, 0xbb, 0xbf, 65, 13, 10, 66, 10, 0, 255]);
    const dirty = Buffer.from("dirty\r\nmixed\n");
    const cleanText = Buffer.from("clean\r\n");
    command(root, "config", "core.autocrlf", "true");
    fs.writeFileSync(path.join(root, "clean.txt"), cleanText);
    fs.writeFileSync(path.join(root, ".gitattributes"), "clean.txt text eol=crlf\n*.txt filter=source-ident ident\n");
    command(root, "config", "filter.source-ident.clean", `"${process.execPath.replaceAll("\\", "/")}" -e "process.stdin.pipe(process.stdout)"`);
    command(root, "config", "filter.source-ident.smudge", `"${process.execPath.replaceAll("\\", "/")}" -e "process.stdout.write('transformed')"`);
    fs.writeFileSync(path.join(root, "clean.bin"), clean);
    fs.writeFileSync(path.join(root, "dirty.txt"), "index\n");
    command(root, "add", "clean.txt", ".gitattributes", "clean.bin", "dirty.txt"); command(root, "commit", "-qm", "raw files");
    fs.writeFileSync(path.join(root, "dirty.txt"), dirty);
    assert.deepEqual(execFileSync("git", ["show", ":clean.txt"], { cwd: root }), Buffer.from("clean\n"));
    const before = capture(root); const prior = baseline(before);
    const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.writeFileSync(path.join(root, "clean.bin"), "changed"); fs.writeFileSync(path.join(root, "clean.txt"), "changed"); fs.writeFileSync(path.join(root, "dirty.txt"), "changed");
    assert.equal(SourceMutationManifest.capture({ baseline: prior }).mutations.length, 3);
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.deepEqual(fs.readFileSync(path.join(root, "clean.bin")), clean);
    assert.deepEqual(fs.readFileSync(path.join(root, "clean.txt")), cleanText);
    assert.deepEqual(fs.readFileSync(path.join(root, "dirty.txt")), dirty);
    assert.deepEqual(SourceMutationManifest.capture({ baseline: prior }).mutations, []);
  });
  sourceTest("preserves native Git mode of an untracked input through saved raw rollback reload", (t, root) => {
    const name = "untracked-mode.sh"; const file = path.join(root, name);
    command(root, "config", "core.filemode", "true");
    const nativeMode = () => {
      const result = spawnSync("git", ["diff", "--no-index", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      const match = /^:000000 (100644|100755) /.exec(result.stdout);
      assert.notEqual(match, null, result.stdout);
      return match[1];
    };
    fs.writeFileSync(file, "untracked before\r\n"); fs.chmodSync(file, 0o755);
    const expectedMode = nativeMode();
    const before = capture(root); const prior = baseline(before);
    assert.equal(before.entries.find((entry) => entry.path === name).git.worktreeMode, expectedMode);
    const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.writeFileSync(file, "worker changed bytes"); fs.chmodSync(file, 0o644);
    assert.equal(SourceMutationManifest.capture({ baseline: prior }).mutations.some((entry) => entry.path === name), true);
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.readFileSync(file, "utf8"), "untracked before\r\n");
    assert.equal(nativeMode(), expectedMode);
    assert.equal(capture(root).entries.find((entry) => entry.path === name).git.worktreeMode, expectedMode);
    assert.equal(command(root, "ls-files", "--", name), "", "rollback retains the untracked source policy");
  });
  sourceTest("restores Git-observed executable mode under both effective filemode policies", (t, root) => {
    for (const filemode of [true, false]) {
      const name = `program-${filemode}`; const file = path.join(root, name);
      fs.writeFileSync(file, "original\r\n"); fs.chmodSync(file, 0o755);
      command(root, "add", name); command(root, "commit", "-qm", "executable file");
      command(root, "config", "core.filemode", String(filemode));
      const before = capture(root); const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
      fs.writeFileSync(file, "worker"); fs.chmodSync(file, 0o644);
      WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
      assert.equal(fs.readFileSync(file, "utf8"), "original\r\n");
      assert.equal(capture(root).entries.find((entry) => entry.path === name).git.worktreeMode, "100755");
      assert.equal(command(root, "diff", "--raw", "--", name), "");
    }
  });
  sourceTest("materializes a logical symlink represented by a regular file without changing the user index", (t, root) => {
    command(root, "config", "core.symlinks", "false");
    fs.writeFileSync(path.join(root, "link"), "seed");
    const oid = command(root, "hash-object", "-w", "link");
    command(root, "update-index", "--add", "--cacheinfo", "120000", oid, "link"); command(root, "commit", "-qm", "logical link");
    const before = capture(root); const index = command(root, "ls-files", "--stage");
    assert.equal(before.entries.find((entry) => entry.path === "link").git.logicalMode, "120000");
    assert.equal(before.entries.find((entry) => entry.path === "link").kind, "file");
    const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.writeFileSync(path.join(root, "link"), "changed-target");
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.readFileSync(path.join(root, "link"), "utf8"), "seed"); assert.equal(command(root, "ls-files", "--stage"), index);
  });
  sourceTest("preserves assume-unchanged and sparse index flags through raw rollback reload", (t, root) => {
    fs.writeFileSync(path.join(root, "assumed"), "raw before\r\n"); fs.writeFileSync(path.join(root, "excluded"), "excluded before\n");
    command(root, "add", "assumed", "excluded"); command(root, "commit", "-qm", "flagged files");
    command(root, "sparse-checkout", "init", "--no-cone");
    command(root, "sparse-checkout", "set", "--no-cone", "/seed", "/assumed");
    command(root, "update-index", "--assume-unchanged", "assumed");
    const flags = command(root, "ls-files", "-v"); const index = command(root, "ls-files", "--stage");
    assert.match(flags, /^h assumed$/m); assert.match(flags, /^S excluded$/m);
    assert.equal(fs.existsSync(path.join(root, "excluded")), false);
    const before = capture(root); const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.writeFileSync(path.join(root, "assumed"), "worker changed hidden file"); fs.writeFileSync(path.join(root, "excluded"), "worker materialized sparse file");
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.readFileSync(path.join(root, "assumed"), "utf8"), "raw before\r\n");
    assert.equal(fs.existsSync(path.join(root, "excluded")), false);
    assert.equal(command(root, "ls-files", "-v"), flags); assert.equal(command(root, "ls-files", "--stage"), index);
  });
  sourceTest("rejects a real unsupported Git index mode before creating source authority", (t, root) => {
    command(root, "update-index", "--add", "--cacheinfo", "160000", command(root, "rev-parse", "HEAD"), "nested-module");
    const index = command(root, "ls-files", "--stage"); const source = fs.readFileSync(path.join(root, "seed"));
    assert.throws(() => capture(root), (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
      && /unsupported or unmerged Git source entry/.test(error.message));
    assert.equal(command(root, "ls-files", "--stage"), index); assert.deepEqual(fs.readFileSync(path.join(root, "seed")), source);
  });
  sourceTest("rejects an undecodable missing indexed path hidden from status by skip-worktree", (t, root) => {
    const rawPath = Buffer.concat([Buffer.from("missing-"), Buffer.from([0xff]), Buffer.from("-source")]);
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: Buffer.from("raw source\n") }).toString("ascii").trim();
    execFileSync("git", ["update-index", "-z", "--index-info"], { cwd: root,
      input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), rawPath, Buffer.from([0])]) });
    execFileSync("git", ["update-index", "--skip-worktree", "-z", "--stdin"], { cwd: root,
      input: Buffer.concat([rawPath, Buffer.from([0])]) });
    command(root, "commit", "-qm", "missing indexed path");
    const status = execFileSync("git", ["status", "--porcelain=v2", "-z"], { cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    assert.equal(isUtf8(status), true, "unrelated registered runtime entries remain valid status text");
    assert.equal(status.includes(rawPath), false, "the missing indexed pathname is not emitted by the strict status boundary");
    assert.ok(execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root }).includes(rawPath));
    const indexPath = path.resolve(root, command(root, "rev-parse", "--git-path", "index"));
    const indexBytes = fs.readFileSync(indexPath); const sourceBytes = fs.readFileSync(path.join(root, "seed"));
    assert.throws(() => capture(root), (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
      && /source path that is not valid UTF-8/.test(error.message));
    assert.deepEqual(fs.readFileSync(indexPath), indexBytes);
    assert.deepEqual(fs.readFileSync(path.join(root, "seed")), sourceBytes);
    assert.equal(fs.existsSync(path.join(root, rawPath.toString("utf8"))), false, "no replacement-character source alias is created");
  });
  sourceTest("restores an indexed child after the worker replaces its directory with a regular file", (t, root) => {
    fs.mkdirSync(path.join(root, "directory")); fs.writeFileSync(path.join(root, "directory", "child"), "child before\r\n");
    command(root, "add", "directory/child"); command(root, "commit", "-qm", "directory baseline");
    const before = capture(root); const prior = baseline(before);
    const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.unlinkSync(path.join(root, "directory", "child")); fs.rmdirSync(path.join(root, "directory"));
    fs.writeFileSync(path.join(root, "directory"), "worker parent");
    const mutations = SourceMutationManifest.capture({ baseline: prior }).mutations;
    assert.equal(mutations.find((entry) => entry.path === "directory/child").afterKind, "missing");
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.lstatSync(path.join(root, "directory")).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(root, "directory", "child"), "utf8"), "child before\r\n");
    assert.equal(command(root, "diff", "--raw"), "");
  });
  sourceTest("refuses changed sparse pattern bytes without index refresh and unsafe sparse policy types", (t, root) => {
    command(root, "config", "core.sparseCheckout", "true");
    const sparse = path.resolve(root, command(root, "rev-parse", "--git-path", "info/sparse-checkout"));
    fs.mkdirSync(path.dirname(sparse), { recursive: true }); fs.writeFileSync(sparse, "/*\n");
    const index = command(root, "ls-files", "--stage");
    const blob = new WorkerArtifactSourceRollbackCheckpoint([capture(root)]).blobBytes();
    fs.writeFileSync(path.join(root, "seed"), "worker bytes"); fs.writeFileSync(sparse, "/*\n!seed\n");
    assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(),
      (error) => error.code === "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION");
    assert.equal(command(root, "ls-files", "--stage"), index);
    assert.equal(fs.readFileSync(path.join(root, "seed"), "utf8"), "worker bytes");
    assert.equal(fs.readFileSync(sparse, "utf8"), "/*\n!seed\n");
    fs.unlinkSync(sparse); fs.symlinkSync("../../seed", sparse);
    assert.throws(() => capture(root), /unsupported native type/);
  });
  sourceTest("refuses same-value replacements of named Git controls and a same-OID symbolic HEAD switch", (t, root) => {
    command(root, "branch", "same-commit-alias");
    const before = capture(root); const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    const headOid = command(root, "rev-parse", "HEAD");
    const effectiveConfig = command(root, "config", "--null", "--list", "--show-origin");
    const logicalIndex = command(root, "ls-files", "--stage");
    const gitDirectory = path.resolve(root, command(root, "rev-parse", "--absolute-git-dir"));
    const commonDirectory = path.resolve(root, command(root, "rev-parse", "--git-common-dir"));
    const controls = [
      { name: "head", file: path.resolve(root, command(root, "rev-parse", "--git-path", "HEAD")), bytes: () => Buffer.from("ref: refs/heads/same-commit-alias\n") },
      { name: "index", file: path.resolve(root, command(root, "rev-parse", "--git-path", "index")), bytes: (original) => original },
      { name: "commonConfig", file: path.join(commonDirectory, "config"), bytes: (original) => Buffer.concat([original, Buffer.from("\n# worker comment\n")]) },
      { name: "worktreeConfig", file: path.join(gitDirectory, "config.worktree"), bytes: (original) => Buffer.concat([original ?? Buffer.alloc(0), Buffer.from("# worker comment\n")]) },
    ];
    fs.writeFileSync(path.join(root, "seed"), "worker source bytes");
    const protectedAuthority = new WorkerArtifactMutationAuthoritySnapshot({ specId: "source-control", repositories: [capture(root)] });
    for (const control of controls) {
      const present = fs.existsSync(control.file); const original = present ? fs.readFileSync(control.file) : null;
      const saved = path.join(root, ".tmp", `original-${control.name}`);
      if (present) fs.renameSync(control.file, saved);
      const actorBytes = control.bytes(original); fs.writeFileSync(control.file, actorBytes);
      try {
        assert.equal(command(root, "rev-parse", "HEAD"), headOid);
        assert.equal(command(root, "config", "--null", "--list", "--show-origin"), effectiveConfig);
        assert.equal(command(root, "ls-files", "--stage"), logicalIndex);
        if (control.name === "head") assert.equal(command(root, "symbolic-ref", "HEAD"), "refs/heads/same-commit-alias");
        if (control.name === "index") assert.throws(() => protectedAuthority.assertUnchanged(),
          (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
            && JSON.stringify(error.data.changedPaths) === JSON.stringify(["<git-control>"]),
          "semantic digest equality cannot bypass raw Git control authority");
        assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(),
          (error) => error.code === "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION", control.name);
        assert.equal(fs.readFileSync(path.join(root, "seed"), "utf8"), "worker source bytes");
        assert.deepEqual(fs.readFileSync(control.file), actorBytes, "rollback never overwrites the changed Git control");
      } finally {
        fs.unlinkSync(control.file);
        if (present) fs.renameSync(saved, control.file);
      }
    }
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.readFileSync(path.join(root, "seed"), "utf8"), "seed\n");
    assert.equal(command(root, "ls-files", "--stage"), logicalIndex);
  });
  it("accepts newly created ancestors of an exactly ignored contract in a persisted stopped checkpoint", (t) => {
    const root = fixture(t, { git: false });
    fs.mkdirSync(path.join(root, "canonical"));
    fs.writeFileSync(path.join(root, "canonical", "spec.json"), "ordinary protected source\n");
    const contract = "canonical/execution-contracts/g0/contract.json";
    const attempt = { id: "attempt", nodeId: "T1-review", sequence: 1 };
    const prior = SourceMutationBaseline.capture({ root, attempt, ignoredDirectories: [contract] });
    fs.mkdirSync(path.dirname(path.join(root, contract)), { recursive: true });
    fs.writeFileSync(path.join(root, contract), "exact parent-owned contract\n");
    const observed = captureWithScope();
    function captureWithScope() { return WorkerArtifactRepositoryMutationSnapshot.capture(prior.snapshot); }
    assert.deepEqual(prior.snapshot.changedEntryPaths(observed.entries), []);
    assert.equal(prior.snapshot.sameObservation(observed), true);
    assert.equal(observed.sameObservation(prior.snapshot), false, "removing recorded ancestors is not an exempt creation");
    const stopped = TaskReviewUnsealedCheckpoint.capture({ runId: "run", specId: "spec", taskId: "T1", attempt,
      manifestDigest: "a".repeat(64), taskSourceFingerprint: "b".repeat(64), baseline: prior });
    const reloaded = new TaskReviewUnsealedCheckpoint(JSON.parse(JSON.stringify(stopped)), { root });
    assert.equal(reloaded.digest, stopped.digest);
    assert.deepEqual(reloaded.observed.toJSON(), observed.toJSON(), "stored observations retain the created directories and their generations");
    fs.writeFileSync(path.join(root, "canonical", "execution-contracts", "g0", "foreign.txt"), "not ignored");
    assert.equal(reloaded.observed.sameObservation(captureWithScope()), false, "a sibling of the exact ignored contract is still source");
  });
  it("refuses same-byte ordinary and recorded ignored-ancestor generation changes in observation equality", (t) => {
    const root = fixture(t, { git: false });
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "same source bytes\n");
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    const contract = "canonical/execution-contracts/g0/contract.json";
    fs.mkdirSync(path.dirname(path.join(root, contract)), { recursive: true });
    fs.writeFileSync(path.join(root, contract), "exact contract bytes\n");
    const attempt = { id: "attempt", nodeId: "T1-review", sequence: 1 };
    const prior = SourceMutationBaseline.capture({ root, attempt, ignoredDirectories: [contract] });
    const oldSource = path.join(root, ".tmp", "old-source");
    fs.renameSync(source, oldSource); fs.writeFileSync(source, fs.readFileSync(oldSource));
    const replacedSource = WorkerArtifactRepositoryMutationSnapshot.capture(prior.snapshot);
    assert.deepEqual(prior.snapshot.allChangedPaths(replacedSource), [], "generation-only source replacement is not semantic progress");
    assert.equal(prior.snapshot.sameObservation(replacedSource), false);
    assert.throws(() => TaskReviewUnsealedCheckpoint.capture({ runId: "run", specId: "spec", taskId: "T1", attempt,
      manifestDigest: "a".repeat(64), taskSourceFingerprint: "b".repeat(64), baseline: prior }), /zero-effect worker boundary/);
    fs.unlinkSync(source); fs.renameSync(oldSource, source);
    const ancestor = path.dirname(path.join(root, contract));
    fs.renameSync(ancestor, path.join(root, ".tmp", "old-ancestor"));
    fs.mkdirSync(ancestor); fs.writeFileSync(path.join(root, contract), "exact contract bytes\n");
    const replacedAncestor = WorkerArtifactRepositoryMutationSnapshot.capture(prior.snapshot);
    assert.deepEqual(prior.snapshot.allChangedPaths(replacedAncestor), []);
    assert.equal(prior.snapshot.sameObservation(replacedAncestor), false, "an already observed directory cannot be replaced under the creation exception");
  });
  it("projects exact publication leaves and only their newly created directory ancestors", (t) => {
    const root = fixture(t, { git: false });
    fs.mkdirSync(path.join(root, "canonical", "existing"), { recursive: true });
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    const source = path.join(root, "canonical", "existing", "source.txt");
    fs.writeFileSync(source, "ordinary source\n");
    const before = capture(root);
    const leaves = ["canonical/new/g0/receipt.json", "canonical/existing/authorization.json"];
    for (const leaf of leaves) {
      fs.mkdirSync(path.dirname(path.join(root, leaf)), { recursive: true });
      fs.writeFileSync(path.join(root, leaf), "authenticated parent publication\n");
    }
    const published = capture(root);
    const allowed = before.publicationPaths(published, leaves);
    assert.deepEqual([...allowed].sort(), [...leaves, "canonical/new", "canonical/new/g0"].sort());
    assert.ok(before.observationChanges(published).every((relativePath) => allowed.has(relativePath)));
    assert.equal(allowed.has("canonical"), false);
    assert.equal(allowed.has("canonical/existing"), false, "already observed ancestors are not explained by a publication");
    const retainedSource = path.join(root, ".tmp", "old-source");
    fs.renameSync(source, retainedSource); fs.writeFileSync(source, fs.readFileSync(retainedSource));
    const replacedSource = capture(root);
    assert.ok(before.allChangedPaths(replacedSource).every((relativePath) => allowed.has(relativePath)),
      "the semantic comparison alone cannot distinguish the extra generation-only source effect");
    assert.ok(before.observationChanges(replacedSource).includes("canonical/existing/source.txt"));
    assert.equal(before.publicationPaths(replacedSource, leaves).has("canonical/existing/source.txt"), false);
    fs.unlinkSync(source); fs.renameSync(retainedSource, source);
    const existing = path.join(root, "canonical", "existing");
    const retainedAncestor = path.join(root, ".tmp", "old-ancestor");
    fs.renameSync(existing, retainedAncestor); fs.mkdirSync(existing);
    fs.renameSync(path.join(retainedAncestor, "source.txt"), source);
    fs.renameSync(path.join(retainedAncestor, "authorization.json"), path.join(existing, "authorization.json"));
    const replacedAncestor = capture(root);
    assert.ok(before.observationChanges(replacedAncestor).includes("canonical/existing"));
    assert.equal(before.publicationPaths(replacedAncestor, leaves).has("canonical/existing"), false);
    fs.writeFileSync(path.join(root, "canonical", "new", "sibling.txt"), "unapproved sibling");
    const sibling = capture(root);
    assert.ok(before.observationChanges(sibling).includes("canonical/new/sibling.txt"));
    assert.equal(before.publicationPaths(sibling, leaves).has("canonical/new/sibling.txt"), false);
    assert.deepEqual([...before.publicationPaths(before, leaves)].sort(), [...leaves].sort(),
      "absent parent directories are not granted from path spelling alone");
  });
  it("restores non-Git regular/missing/directory state after discarding the checkpoint instance", (t) => {
    const root = fixture(t, { git: false }); fs.mkdirSync(path.join(root, "empty")); fs.writeFileSync(path.join(root, "original"), "raw\r\n");
    const before = capture(root); const blob = new WorkerArtifactSourceRollbackCheckpoint([before]).blobBytes();
    fs.rmdirSync(path.join(root, "empty")); fs.writeFileSync(path.join(root, "empty"), "worker file");
    fs.writeFileSync(path.join(root, "original"), "changed"); fs.mkdirSync(path.join(root, "added")); fs.writeFileSync(path.join(root, "added", "file"), "new");
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.readFileSync(path.join(root, "original"), "utf8"), "raw\r\n"); assert.equal(fs.existsSync(path.join(root, "added")), false);
    assert.equal(fs.statSync(path.join(root, "empty")).isDirectory(), true);
  });
  it("restores a regular before-image over an owned worker directory after removing its scoped children", (t) => {
    const root = fixture(t, { git: false });
    fs.writeFileSync(path.join(root, "original"), "before\r\n");
    const blob = new WorkerArtifactSourceRollbackCheckpoint([capture(root)]).blobBytes();
    fs.unlinkSync(path.join(root, "original")); fs.mkdirSync(path.join(root, "original"));
    fs.writeFileSync(path.join(root, "original", "worker-child"), "worker");
    WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
    assert.equal(fs.lstatSync(path.join(root, "original")).isFile(), true);
    assert.equal(fs.readFileSync(path.join(root, "original"), "utf8"), "before\r\n");
  });
  it("resumes only the unfinished path after a publication failure without repeating confirmed writes", (t) => {
    const root = fixture(t, { git: false });
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(root, name), `${name}-before`);
    const blob = new WorkerArtifactSourceRollbackCheckpoint([capture(root)]).blobBytes();
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(root, name), `${name}-worker`);
    const rename = fs.renameSync; const publications = [];
    fs.renameSync = (source, target) => {
      if (target === path.join(root, "b")) throw Object.assign(new Error("injected source publication refusal"), { code: "EACCES" });
      publications.push(target); return rename(source, target);
    };
    try { assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), /injected source publication refusal/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(root, "a"), "utf8"), "a-before");
    assert.equal(fs.readFileSync(path.join(root, "b"), "utf8"), "b-worker");
    fs.renameSync = (source, target) => { publications.push(target); return rename(source, target); };
    try { WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(root, "b"), "utf8"), "b-before");
    assert.equal(publications.filter((target) => target === path.join(root, "a")).length, 1);
  });
  it("rejects a physically enumerated source that disappears before its raw capture", (t) => {
    const root = fixture(t, { git: false });
    const target = path.join(root, "disappearing"); const peer = path.join(root, "untouched");
    fs.writeFileSync(target, "original"); fs.writeFileSync(peer, "peer bytes");
    const lstat = fs.lstatSync; let removed = false;
    fs.lstatSync = (file, ...options) => {
      if (file === target && !removed) { removed = true; fs.unlinkSync(target); }
      return lstat(file, ...options);
    };
    try { assert.throws(() => capture(root), (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
      && /inventory entry disappeared/.test(error.message)); }
    finally { fs.lstatSync = lstat; }
    assert.equal(removed, true); assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(peer, "utf8"), "peer bytes");
  });
  it("persists same-byte stopped generations without counting them as semantic mutations", (t) => {
    const root = fixture(t, { git: false });
    const unchanged = path.join(root, "unchanged"); const changed = path.join(root, "changed");
    fs.writeFileSync(unchanged, "same bytes"); fs.writeFileSync(changed, "before");
    const prior = baseline(capture(root));
    const replacement = path.join(root, "replacement"); fs.writeFileSync(replacement, "same bytes"); fs.renameSync(replacement, unchanged);
    const generationOnly = SourceMutationManifest.capture({ baseline: prior });
    assert.deepEqual(generationOnly.paths(), []);
    assert.equal(generationOnly.observations.find((entry) => entry.path === "unchanged").working.generation
      .equals(prior.snapshot.entries.find((entry) => entry.path === "unchanged").working.generation), false);
    fs.writeFileSync(changed, "worker");
    const manifest = SourceMutationManifest.capture({ baseline: prior });
    const restored = SourceMutationManifest.fromStored(JSON.parse(JSON.stringify(manifest.toJSON())));
    assert.deepEqual(restored.paths(), ["changed"]); assert.equal(restored.assertBinding(prior), restored);
    assert.deepEqual(restored.assertMatchesCurrent(prior).toJSON(), manifest.toJSON());
    const omitted = new SourceMutationManifest({ ...manifest.unsignedJSON(), mutations: [] });
    assert.throws(() => omitted.assertBinding(prior), (error) => error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_BINDING_INVALID");
    const missingObservations = manifest.toJSON(); delete missingObservations.observations;
    assert.throws(() => SourceMutationManifest.fromStored(missingObservations), /invalid schema/);
    fs.writeFileSync(replacement, "same bytes"); fs.renameSync(replacement, unchanged);
    assert.throws(() => restored.assertMatchesCurrent(prior), (error) => error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_STALE");
    assert.equal(fs.readFileSync(changed, "utf8"), "worker");
  });
  sourceTest("retains its owned Git stage when registered materialization lacks publication acknowledgement", async (t, root) => {
    const snapshot = capture(root); const source = fs.readFileSync(path.join(root, "seed"));
    const index = command(root, "ls-files", "--stage"); const runtime = ProcessExecutionRuntime.current();
    let failPublication = true; let failure;
    await runtime.withBinding({ contract: "source-stage-publication" }, async () => {
      try { new WorkerArtifactSourceRollbackCheckpoint([snapshot]); }
      catch (cause) { failure = cause; }
      assert.equal(failure instanceof ProcessExecutionControlFailure, true);
      assert.equal(failure.code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
      assert.notEqual(failure.processExecutionStopReceipt, undefined, "publication failure retains the observed Git child receipt");
      testTemporaryRoot().retainOnUnconfirmedExecution(failure);
      const retainedRoot = path.join(root, ".tmp", "runtime", "source-restore");
      const stages = fs.readdirSync(retainedRoot).filter((name) => name.startsWith("git-"));
      assert.equal(stages.length, 1);
      assert.equal(fs.lstatSync(path.join(retainedRoot, stages[0], "repository.git")).isDirectory(), true);
      assert.match(failure.cause.message, /source Git restore stage retained at/);
      assert.deepEqual(fs.readFileSync(path.join(root, "seed")), source);
      assert.equal(command(root, "ls-files", "--stage"), index);
      failPublication = false;
      await ProcessExecutionRuntime.current().drainEvents();
      assert.equal(fs.lstatSync(path.join(retainedRoot, stages[0])).isDirectory(), true,
        "later acknowledgement does not retroactively authorize stage cleanup");
    }, { eventWriter: (event) => {
      if (failPublication) throw new Error("injected canonical publication failure");
      return ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
    } });
  });
  it("refuses an oversized non-Git before-image without allocating or changing it", (t) => {
    const root = fixture(t, { git: false }); const target = path.join(root, "too-large");
    const descriptor = fs.openSync(target, "wx");
    try { fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(descriptor); }
    const before = fs.lstatSync(target, { bigint: true });
    assert.throws(() => capture(root), (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
      && error.cause?.code === "REGULAR_FILE_READ_LIMIT");
    const after = fs.lstatSync(target, { bigint: true });
    assert.equal(after.size, before.size); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  });
  it("refuses unregistered nested Git directories and worktree files before source capture", (t) => {
    for (const kind of ["directory", "file"]) {
      const root = fixture(t, { git: false });
      fs.writeFileSync(path.join(root, "source"), "original"); fs.mkdirSync(path.join(root, "nested"));
      const marker = path.join(root, "nested", ".git");
      if (kind === "directory") fs.mkdirSync(marker); else fs.writeFileSync(marker, "gitdir: external\n");
      assert.throws(() => capture(root), (error) => error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
        && /independent nested Git boundary/.test(error.message));
      assert.equal(fs.readFileSync(path.join(root, "source"), "utf8"), "original");
      assert.equal(fs.lstatSync(marker).isDirectory(), kind === "directory");
    }
  });
  it("refuses an untouched same-byte foreign generation before publishing source", (t) => {
    const root = fixture(t, { git: false });
    fs.writeFileSync(path.join(root, "changed"), "before"); fs.writeFileSync(path.join(root, "untouched"), "same bytes");
    const blob = new WorkerArtifactSourceRollbackCheckpoint([capture(root)]).blobBytes();
    fs.writeFileSync(path.join(root, "changed"), "worker");
    const write = fs.writeSync; let replaced = false;
    fs.writeSync = (descriptor, buffer, ...args) => {
      const result = write(descriptor, buffer, ...args);
      if (!replaced && Buffer.isBuffer(buffer) && buffer.equals(Buffer.from("before"))) {
        replaced = true;
        fs.writeFileSync(path.join(root, "replacement"), "same bytes");
        fs.renameSync(path.join(root, "replacement"), path.join(root, "untouched"));
      }
      return result;
    };
    try { assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), /source generation: untouched/); }
    finally { fs.writeSync = write; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(path.join(root, "changed"), "utf8"), "worker");
    assert.equal(fs.readFileSync(path.join(root, "untouched"), "utf8"), "same bytes");
  });
  sourceTest("refuses dangling or broken Git boundaries without selecting filesystem authority", (t, root) => {
    const marker = path.join(root, ".git"); const saved = path.join(root, "saved-git");
    fs.renameSync(marker, saved);
    try {
      fs.symlinkSync("missing-git", marker);
      assert.throws(() => capture(root), /unsupported native type/);
      fs.unlinkSync(marker); fs.writeFileSync(marker, "gitdir: missing-git\n");
      assert.throws(() => capture(root), /failed to resolve selected source Git repository/);
      assert.equal(fs.readFileSync(path.join(root, "seed"), "utf8"), "seed\n");
    } finally { fs.unlinkSync(marker); fs.renameSync(saved, marker); }
  });
  sourceTest("refuses native links before capture and refuses changed Git control without modifying source", (t, root) => { fs.symlinkSync("seed", path.join(root, "native"));
    assert.throws(() => capture(root), /unsupported native type/); fs.unlinkSync(path.join(root, "native"));
    const blob = new WorkerArtifactSourceRollbackCheckpoint([capture(root)]).blobBytes();
    fs.writeFileSync(path.join(root, "seed"), "worker\n"); command(root, "config", "core.filemode", "false");
    assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), /HEAD, index, flags, refs, configuration/);
    assert.equal(fs.readFileSync(path.join(root, "seed"), "utf8"), "worker\n");
  });
});

function directoryRollbackFixture(t) {
  const root = createTmpDir("source-rollback-cleanup-");
  t.after(() => removeTmpDir(root));
  const target = path.join(root, "restored");
  fs.mkdirSync(target);
  const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
  const blob = new WorkerArtifactSourceRollbackCheckpoint([snapshot]).blobBytes();
  fs.rmdirSync(target);
  return { root, target, blob };
}

function containsCause(error, expected) {
  return error === expected || error instanceof Error && (containsCause(error.cause, expected)
    || error instanceof AggregateError && error.errors.some((cause) => containsCause(cause, expected)));
}

it("directory rollback preserves a readback failure after a successful move and resumes without republishing", (t) => {
  const { root, target, blob } = directoryRollbackFixture(t);
  const failure = new Error("injected restored directory readback failure");
  const moveTo = RealDirectoryAuthority.prototype.moveTo;
  const lstat = fs.lstatSync;
  let moved = false;
  let failed = false;
  t.mock.method(RealDirectoryAuthority.prototype, "moveTo", function (destination, options) {
    const result = moveTo.call(this, destination, options);
    if (destination === target) moved = true;
    return result;
  });
  t.mock.method(fs, "lstatSync", (file, ...options) => {
    if (moved && !failed && file === target) { failed = true; throw failure; }
    return lstat(file, ...options);
  });
  assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), (error) => {
    assert.equal(error.code, "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED");
    assert.equal(containsCause(error, failure), true, error.message);
    return true;
  });
  assert.equal(failed, true);
  t.mock.restoreAll();
  const restored = fs.lstatSync(target, { bigint: true });
  assert.equal(restored.isDirectory(), true);
  WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
  const resumed = fs.lstatSync(target, { bigint: true });
  assert.equal(resumed.dev, restored.dev);
  assert.equal(resumed.ino, restored.ino);
  assert.deepEqual(fs.readdirSync(root), ["restored"]);
});

it("directory rollback preserves an uncertain move readback failure and its visible directory", (t) => {
  const { root, target, blob } = directoryRollbackFixture(t);
  const failure = new Error("injected directory move readback failure");
  const rename = fs.renameSync;
  const lstat = fs.lstatSync;
  let renamed = false;
  let failed = false;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = rename(source, destination);
    if (destination === target) renamed = true;
    return result;
  });
  t.mock.method(fs, "lstatSync", (file, ...options) => {
    if (renamed && !failed && file === target) { failed = true; throw failure; }
    return lstat(file, ...options);
  });
  assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), (error) => {
    assert.equal(error.code, "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED");
    assert.equal(error.cause.committedToVisibleName, true);
    assert.equal(error.cause.publicationUnknown, true);
    assert.equal(containsCause(error, failure), true, error.message);
    return true;
  });
  assert.equal(failed, true);
  t.mock.restoreAll();
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["restored"]);
});

it("directory rollback retains the move failure before a stage cleanup failure", (t) => {
  const { root, target, blob } = directoryRollbackFixture(t);
  const primary = new Error("injected directory publication failure");
  const cleanup = new Error("injected directory stage cleanup failure");
  const rename = fs.renameSync;
  const rmdir = fs.rmdirSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === target) throw primary;
    return rename(source, destination);
  });
  t.mock.method(fs, "rmdirSync", (directory, ...options) => {
    if (path.dirname(directory) === root) throw cleanup;
    return rmdir(directory, ...options);
  });
  assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), (error) => {
    assert.equal(error.code, "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.cause, error.cause.errors[0]);
    assert.equal(error.cause.errors.length, 2);
    assert.equal(containsCause(error.cause.errors[0], primary), true);
    assert.equal(containsCause(error.cause.errors[1], cleanup), true);
    return true;
  });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(target), false);
  const retained = fs.readdirSync(root);
  assert.equal(retained.length, 1);
  assert.equal(fs.lstatSync(path.join(root, retained[0])).isDirectory(), true);
});

it("directory rollback cleans its unmoved stage while retaining the move failure", (t) => {
  const { root, target, blob } = directoryRollbackFixture(t);
  const primary = new Error("injected directory publication refusal");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === target) throw primary;
    return rename(source, destination);
  });
  assert.throws(() => WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore(), (error) => {
    assert.equal(error.code, "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED");
    assert.equal(containsCause(error, primary), true);
    return true;
  });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
