import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test } from "node:test";
import { runGit, listChangedFilesDetailed, listUncommittedFiles } from "../../../src/lib/git-helpers.js";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "../../../src/flow/lib/flow-repository-runtime-artifacts.js";
import { RegressionFileSnapshotList } from "../../../src/flow/lib/regression-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

function repository(t) {
  const root = createTmpDir("git-nul-native-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  for (const name of ["資料 old.txt", "変更 file.txt", "削除.txt"]) {
    fs.writeFileSync(path.join(root, name), `original:${name}\n`);
  }
  commitAll(root, "Create native Git path fixture");
  return root;
}
function git(root, args) {
  const result = runGit(args, { cwd: root });
  assert.equal(result.ok, true, String(result.stderr));
  return result.stdout;
}
const exclusions = () => new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes({ relativeToCwd: true });

test("native default-quoted Unicode committed and working names survive exact fingerprint readback", (t) => {
  const root = repository(t);
  git(root, ["config", "diff.renames", "true"]);
  git(root, ["checkout", "-q", "-b", "feature"]);
  git(root, ["mv", "--", "資料 old.txt", "資料 new.txt"]);
  fs.unlinkSync(path.join(root, "削除.txt"));
  fs.writeFileSync(path.join(root, "確定 file.txt"), "committed Unicode bytes\n");
  commitAll(root, "Record Unicode commit changes");
  fs.appendFileSync(path.join(root, "変更 file.txt"), "working bytes\n");
  fs.writeFileSync(path.join(root, "新規 file.txt"), "untracked Unicode bytes\n");
  const index = path.join(root, ".git", "index");
  const before = fs.readFileSync(index);
  const changes = listChangedFilesDetailed({ cwd: root, repositoryRoot: root,
    baseBranch: "main", untrackedFiles: "all", pathspecExcludes: exclusions() });
  const byPath = new Map(changes.map((entry) => [entry.path, entry]));
  assert.deepEqual([...byPath.keys()].sort(), ["資料 new.txt", "削除.txt", "確定 file.txt", "変更 file.txt", "新規 file.txt"].sort());
  assert.deepEqual(byPath.get("資料 new.txt"), { status: "renamed", path: "資料 new.txt", old_path: "資料 old.txt" });
  assert.equal(byPath.get("削除.txt").status, "deleted");
  assert.equal(byPath.get("確定 file.txt").status, "added");
  assert.equal(byPath.get("変更 file.txt").status, "modified");
  assert.equal(byPath.get("新規 file.txt").status, "untracked");
  const current = listUncommittedFiles({ cwd: root,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }) });
  assert.equal(current.includes("変更 file.txt"), true);
  assert.equal(current.includes("新規 file.txt"), true);
  assert.deepEqual(fs.readFileSync(index), before);
  const snapshots = RegressionFileSnapshotList.fromChangedFiles(root, changes);
  assert.equal(RegressionFileSnapshotList.fromJSON(snapshots.toJSON()).equals(snapshots), true);
  for (const snapshot of snapshots.entries) {
    const expected = snapshot.status === "deleted" ? null
      : crypto.createHash("sha256").update(fs.readFileSync(path.join(root, snapshot.path))).digest("hex");
    assert.equal(snapshot.fingerprint, expected);
  }
});

test("native filename whitespace is retained and POSIX literal quotes and backslashes are not rewritten", (t) => {
  const root = repository(t);
  const names = process.platform === "win32"
    ? ["Unicode 資料 file.txt", "two  internal spaces.txt"]
    : [" leading and trailing .txt ", 'tab\tline\nquote"back\\slash.txt', "Unicode 資料 file.txt"];
  for (const name of names) fs.writeFileSync(path.join(root, name), "literal filename bytes\n");
  const changes = listChangedFilesDetailed({ cwd: root, repositoryRoot: root,
    untrackedFiles: "all", pathspecExcludes: exclusions() });
  assert.deepEqual(changes.map((entry) => entry.path).sort(), [...names].sort());
  const current = listUncommittedFiles({ cwd: root,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }) });
  for (const name of names) assert.equal(current.includes(name), true);
});
