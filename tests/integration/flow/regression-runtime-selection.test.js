import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { listChangedFilesDetailed } from "../../../src/lib/git-helpers.js";
import { RepositoryLockAuthority } from "../../../src/lib/repository-control-lock.js";
import { RegressionFileSnapshotList } from "../../../src/flow/lib/regression-file-snapshot.js";
import { listRegressionChangedFiles } from "../../../src/flow/lib/test-regression.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

function repository(t) {
  const root = createTmpDir("regression-runtime-selection-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "project.js"), "export const project = 1;\n");
  commitAll(root, "Create regression selection fixture");
  return root;
}

function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

test("regression selection excludes an owned atomic stage before strict project fingerprint readback", (t) => {
  const root = repository(t);
  const expected = new Map([
    ["project.js", "export const project = 2;\n"],
    ["資料 file.js", "export const unicode = true;\n"],
    [".tmp-lookalike/user.js", "export const user = true;\n"],
  ]);
  for (const [relative, bytes] of expected) write(root, relative, bytes);
  write(root, "caller-output/result.txt", "caller-owned excluded output\n");
  const lockPath = RepositoryLockAuthority.pathFor(root, {
    namespace: "process-runtime", identity: root, fileName: "admission.lock",
  });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const writer = new AtomicFile(lockPath);
  const stage = writer.createStage("complete staging bytes\n");
  try {
    const relativeStage = path.relative(root, stage.path).split(path.sep).join("/");
    const ordinary = listChangedFilesDetailed({ cwd: root, repositoryRoot: root,
      baseBranch: "main", untrackedFiles: "all" });
    assert.equal(ordinary.some((entry) => entry.path === relativeStage), true,
      "the generic Git observer must retain the actual runtime stage");
    const selected = listRegressionChangedFiles({ root, state: { baseBranch: "main" },
      pathspecExcludes: [":(exclude,literal)caller-output/result.txt"] });
    assert.equal(selected.some((entry) => entry.path === relativeStage), false,
      "regression selection must exclude the actual owned atomic stage");
    assert.deepEqual(selected.map((entry) => entry.path).sort(), [...expected.keys()].sort());
    stage.dispose();
    assert.equal(fs.existsSync(stage.path), false);
    const snapshots = RegressionFileSnapshotList.fromChangedFiles(root, selected);
    assert.equal(RegressionFileSnapshotList.fromJSON(snapshots.toJSON()).equals(snapshots), true);
    for (const snapshot of snapshots.entries) {
      assert.equal(snapshot.fingerprint,
        crypto.createHash("sha256").update(expected.get(snapshot.path)).digest("hex"));
    }
  } finally {
    if (stage.active) stage.dispose();
  }
});

test("a disappeared selected ordinary project file still fails strict regression fingerprinting", (t) => {
  const root = repository(t);
  write(root, "ordinary-vanishing.js", "export const ordinary = true;\n");
  const selected = listRegressionChangedFiles({ root, state: { baseBranch: "main" } });
  const ordinary = selected.find((entry) => entry.path === "ordinary-vanishing.js");
  assert.ok(ordinary);
  const file = path.join(root, ordinary.path);
  fs.unlinkSync(file);
  assert.throws(() => RegressionFileSnapshotList.fromChangedFiles(root, [ordinary]),
    (error) => error.code === "ENOENT" && error.path === file);
});
