import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { GitPluginArchive } from "../../../src/lib/git-plugin-archive.js";
import { runGit, runGitToFile } from "../../../src/lib/git-helpers.js";
import { FilePermissionHint } from "../../../src/lib/regular-file-snapshot.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

function fixture(t) {
  const root = createTmpDir("git-plugin-archive-");
  t.after(() => removeTmpDir(root));
  const repository = path.join(root, "source");
  const destination = path.join(root, "extracted");
  fs.mkdirSync(repository);
  fs.mkdirSync(destination);
  initGitRepo(repository);
  // The production Git runner records process-control evidence under .tmp and .sennel.
  // Keep that fixture infrastructure out of the package's committed tree.
  fs.writeFileSync(path.join(repository, ".git", "info", "exclude"), ".tmp/\n.sennel/\n");
  return { root, repository, destination, archivePath: path.join(root, "archive.tar") };
}
function generate(fixture) {
  commitAll(fixture.repository, "Archive fixture");
  const commit = runGit(["rev-parse", "HEAD"], { cwd: fixture.repository });
  assert.equal(commit.ok, true, commit.stderr);
  const oid = commit.stdout.trim();
  const result = runGitToFile(["-c", "tar.umask=0022", "archive", "--format=tar", oid],
    { cwd: fixture.repository, outputPath: fixture.archivePath, log: false });
  assert.equal(result.ok, true, result.stderr);
  return oid;
}

test("extracts actual Git PAX, binary, long paths and export attributes with native file permissions", (t) => {
  const f = fixture(t);
  const longPath = `資料/${"long-name-".repeat(13)}.bin`;
  const binary = Buffer.from([0, 255, 128, 13, 10, 0, 1]);
  fs.mkdirSync(path.join(f.repository, "資料"));
  fs.writeFileSync(path.join(f.repository, longPath), binary);
  fs.writeFileSync(path.join(f.repository, "exec.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(f.repository, "ignored"), "private");
  fs.writeFileSync(path.join(f.repository, "substituted"), "$Format:%H$\n");
  fs.writeFileSync(path.join(f.repository, ".gitattributes"), "ignored export-ignore\nsubstituted export-subst\n");
  const add = runGit(["add", "-A"], { cwd: f.repository });
  assert.equal(add.ok, true, add.stderr);
  const chmod = runGit(["update-index", "--chmod=+x", "exec.sh"], { cwd: f.repository });
  assert.equal(chmod.ok, true, chmod.stderr);
  // Preserve the index executable bit on hosts without POSIX chmod support.
  const config = runGit(["config", "core.filemode", "false"], { cwd: f.repository });
  assert.equal(config.ok, true, config.stderr);
  const oid = generate(f);
  const captured = GitPluginArchive.fromFile(f.archivePath);
  assert.equal(captured.comment, oid);
  const rootAuthority = new RealDirectoryAuthority(f.destination);
  captured.extractTo(f.destination, { directoryAuthority: rootAuthority });
  assert.deepEqual(fs.readFileSync(path.join(f.destination, longPath)), binary);
  assert.equal(fs.readFileSync(path.join(f.destination, "substituted"), "utf8"), `${oid}\n`);
  assert.equal(fs.existsSync(path.join(f.destination, "ignored")), false);
  assert.equal(new FilePermissionHint(0o755).matches(FilePermissionHint.fromStat(fs.statSync(path.join(f.destination, "exec.sh")))), true);
  assert.equal(new FilePermissionHint(0o644).matches(FilePermissionHint.fromStat(fs.statSync(path.join(f.destination, longPath)))), true);
  assert.equal(captured.entryCount, 5);
});

test("captures immutable archive bytes and refuses malformed trailing input before writing any entry", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repository, "payload"), "original");
  generate(f);
  const bytes = fs.readFileSync(f.archivePath);
  const captured = GitPluginArchive.fromBuffer(bytes);
  bytes.fill(255);
  captured.extractTo(f.destination);
  assert.equal(fs.readFileSync(path.join(f.destination, "payload"), "utf8"), "original");
  const empty = path.join(f.root, "invalid-output");
  fs.mkdirSync(empty);
  const malformed = fs.readFileSync(f.archivePath);
  malformed[malformed.length - 1] = 1;
  fs.writeFileSync(f.archivePath, malformed);
  assert.throws(() => GitPluginArchive.fromFile(f.archivePath).extractTo(empty), { code: "GIT_PLUGIN_ARCHIVE_INVALID" });
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.equal(fs.readFileSync(path.join(f.destination, "payload"), "utf8"), "original");
});

test("refuses linked input, occupied staging and replaced retained staging authority without overwriting", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repository, "payload"), "new");
  generate(f);
  const linked = path.join(f.root, "linked.tar");
  fs.linkSync(f.archivePath, linked);
  assert.throws(() => GitPluginArchive.fromFile(linked), { code: "REGULAR_FILE_READ_IDENTITY" });
  fs.unlinkSync(linked);
  const captured = GitPluginArchive.fromFile(f.archivePath);
  fs.writeFileSync(path.join(f.destination, "payload"), "preserved");
  assert.throws(() => captured.extractTo(f.destination), /empty staging directory/);
  assert.equal(fs.readFileSync(path.join(f.destination, "payload"), "utf8"), "preserved");
  const authority = new RealDirectoryAuthority(f.destination);
  fs.renameSync(f.destination, path.join(f.root, "original-stage"));
  fs.mkdirSync(f.destination);
  assert.throws(() => captured.extractTo(f.destination, { directoryAuthority: authority }),
    { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.deepEqual(fs.readdirSync(f.destination), []);
  assert.equal(fs.readFileSync(path.join(f.root, "original-stage", "payload"), "utf8"), "preserved");
});

test("rejects actual Git symbolic links before extracting otherwise valid preceding files", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repository, "a-normal"), "valid");
  // Build the Git index link directly so this test also runs without symlink privilege.
  const target = path.join(f.root, "target.txt");
  fs.writeFileSync(target, "../outside");
  const blob = runGit(["hash-object", "-w", target], { cwd: f.repository });
  assert.equal(blob.ok, true, blob.stderr);
  const add = runGit(["add", "a-normal"], { cwd: f.repository });
  assert.equal(add.ok, true, add.stderr);
  const link = runGit(["update-index", "--add", "--cacheinfo", `120000,${blob.stdout.trim()},z-link`], { cwd: f.repository });
  assert.equal(link.ok, true, link.stderr);
  const commit = runGit(["commit", "-qm", "Link fixture"], { cwd: f.repository });
  assert.equal(commit.ok, true, commit.stderr);
  const result = runGitToFile(["archive", "--format=tar", "HEAD"], { cwd: f.repository, outputPath: f.archivePath, log: false });
  assert.equal(result.ok, true, result.stderr);
  assert.throws(() => GitPluginArchive.fromFile(f.archivePath).extractTo(f.destination), { code: "GIT_PLUGIN_ARCHIVE_INVALID" });
  assert.deepEqual(fs.readdirSync(f.destination), []);
  assert.equal(fs.readFileSync(target, "utf8"), "../outside");
});

test("retains created directory identities between successive archive entries", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repository, "dir"));
  fs.writeFileSync(path.join(f.repository, "dir", "a"), "first");
  fs.writeFileSync(path.join(f.repository, "dir", "b"), "second");
  generate(f);
  const captured = GitPluginArchive.fromFile(f.archivePath);
  const write = AtomicFile.prototype.write;
  AtomicFile.prototype.write = function (...args) {
    const result = write.apply(this, args);
    if (this.filePath === path.join(f.destination, "dir", "a")) {
      fs.renameSync(path.join(f.destination, "dir"), path.join(f.root, "retained-dir"));
      fs.mkdirSync(path.join(f.destination, "dir"));
    }
    return result;
  };
  try {
    assert.throws(() => captured.extractTo(f.destination),
      { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  } finally { AtomicFile.prototype.write = write; }
  assert.deepEqual(fs.readdirSync(path.join(f.destination, "dir")), []);
  assert.equal(fs.readFileSync(path.join(f.root, "retained-dir", "a"), "utf8"), "first");
});
