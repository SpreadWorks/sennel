import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
import { SelectedSourceGitRepository, selectedSourceGitRoot } from "../../../src/flow/lib/source-working-file-capture.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { SynchronousManagedFixture } from "../../support/infrastructure/synchronous-managed-fixture.js";

it("reads selected repository paths afresh for ordinary and linked worktrees without discovering an ancestor", (t) => {
  const fixture = new SynchronousManagedFixture(t, "selected-source-git-");
  const root = fixture.root;
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "seed"), "source\n");
  commitAll(root, "source boundary");
  const native = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8",
    env: new GitRepositoryPolicy({ repositoryRoot: cwd, readOnly: true }).environment(process.env) }).trim();
  const check = (cwd) => {
    const selected = SelectedSourceGitRepository.read(cwd);
    assert.ok(selected instanceof SelectedSourceGitRepository);
    assert.deepEqual(selected.physicalPaths, native(cwd, ["rev-parse", "--absolute-git-dir", "--git-common-dir",
      "--git-path", "info/sparse-checkout", "--git-path", "HEAD", "--git-path", "index"]).split("\n"));
    assert.equal(fs.realpathSync(native(cwd, ["rev-parse", "--show-toplevel"])), fs.realpathSync(cwd));
    assert.equal(Object.isFrozen(selected.physicalPaths), true);
    return selected;
  };
  const ordinary = check(root);
  const nested = path.join(root, "nested"); fs.mkdirSync(nested);
  assert.equal(SelectedSourceGitRepository.read(nested), null);
  assert.equal(selectedSourceGitRoot(nested), false);
  const linked = path.join(root, ".tmp", "linked"); fs.mkdirSync(path.dirname(linked), { recursive: true });
  native(root, ["worktree", "add", "--detach", linked, "HEAD"]);
  const worktree = check(linked);
  assert.notEqual(path.resolve(linked, worktree.physicalPaths[0]), path.resolve(root, ordinary.physicalPaths[0]));
  assert.equal(fs.realpathSync(path.resolve(linked, worktree.physicalPaths[1])), fs.realpathSync(path.resolve(root, ordinary.physicalPaths[1])));
  fs.renameSync(path.join(linked, ".git"), path.join(linked, "retained-marker"));
  assert.equal(SelectedSourceGitRepository.read(linked), null, "a prior successful observation cannot authorize a later read");
  fs.renameSync(path.join(linked, "retained-marker"), path.join(linked, ".git"));
  const actualMarker = fs.readFileSync(path.join(linked, ".git"), "utf8");
  fs.writeFileSync(path.join(linked, ".git"), "gitdir: missing-native-boundary\n");
  assert.throws(() => SelectedSourceGitRepository.read(linked), /failed to resolve selected source Git repository/);
  fs.writeFileSync(path.join(linked, ".git"), actualMarker);
  if (process.platform !== "win32") {
    const newlineRoot = path.join(root, ".tmp", "root\nname"); fs.mkdirSync(newlineRoot);
    initGitRepo(newlineRoot);
    assert.equal(selectedSourceGitRoot(newlineRoot), true, "the root-only API retains its original whole-path parsing");
  }
  fixture.complete = true;
});
