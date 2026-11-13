import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { captureRepairBaseline } from "../../../src/flow/lib/repair-state-identity.js";
import { withManagedProcessScopeSync } from "../../../src/lib/managed-process.js";
import { SynchronousManagedFixture } from "../../support/infrastructure/synchronous-managed-fixture.js";

class RepairBaselineFixture extends SynchronousManagedFixture {
  constructor(t, format = null) {
    super(t, "repair-baseline-observation-");
    if (format !== null) {
      this.git("init", "-q", "-b", "main", `--object-format=${format}`);
      this.git("config", "user.name", "Test User");
      this.git("config", "user.email", "test@example.invalid");
    }
  }
  git = (...args) => execFileSync("git", args, { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  commit = (content) => {
    fs.writeFileSync(path.join(this.root, "source.txt"), content);
    this.git("add", "source.txt");
    this.git("-c", "commit.gpgsign=false", "commit", "-qm", "Baseline fixture");
    return this.git("rev-parse", "HEAD");
  };
}

for (const format of ["sha1", "sha256"]) {
  it(`retains pinned, peeled and merge-base identities in ${format} repositories`, (t) => {
    const fixture = new RepairBaselineFixture(t, format);
    const { root, git, commit } = fixture;
    const original = commit("seed\n");
    const originalTree = git("rev-parse", "HEAD^{tree}");
    git("tag", "-am", "Annotated baseline", "baseline-tag");
    withManagedProcessScopeSync({ executionRoot: root }, () => {
      const pinned = captureRepairBaseline({ root, baseRef: "main", runId: "observation" });
      assert.equal(pinned.objectFormat, format);
      assert.equal(pinned.commitOid, original);
      assert.equal(pinned.treeOid, originalTree);
      assert.equal(pinned.createdRef, true);
      assert.equal(git("rev-parse", pinned.ref), original);

      const advanced = commit("main advanced\n");
      const retained = captureRepairBaseline({ root, baseRef: "refs/heads/absent", runId: "observation" });
      assert.equal(retained.commitOid, original);
      assert.equal(retained.treeOid, originalTree);
      assert.equal(retained.ref, pinned.ref);
      assert.equal(retained.createdRef, false);

      const peeled = captureRepairBaseline({ root, baseRef: "baseline-tag", pin: false });
      assert.equal(peeled.commitOid, original);
      assert.equal(peeled.treeOid, originalTree);
      assert.equal(peeled.ref, null);
      assert.equal(peeled.createdRef, false);
      const head = captureRepairBaseline({ root, baseRef: "HEAD", pin: false });
      assert.equal(head.commitOid, advanced);
      assert.equal(head.treeOid, git("rev-parse", "HEAD^{tree}"));

      git("switch", "-qc", "feature", original);
      commit("feature advanced\n");
      const merged = captureRepairBaseline({ root, baseRef: "main", useMergeBase: true, pin: false });
      assert.equal(merged.commitOid, original);
      assert.equal(merged.treeOid, originalTree);
      assert.notEqual(merged.commitOid, advanced);
    });
    fixture.complete = true;
  });
}

it("distinguishes unavailable repositories from unresolved and unborn baseline sources", (t) => {
  const plain = new RepairBaselineFixture(t);
  withManagedProcessScopeSync({ executionRoot: plain.root }, () => {
    assert.throws(() => captureRepairBaseline({ root: plain.root, baseRef: "HEAD", pin: false }),
      { code: "REPAIR_GIT_UNAVAILABLE" });
  });
  const unborn = new RepairBaselineFixture(t, "sha1");
  withManagedProcessScopeSync({ executionRoot: unborn.root }, () => {
    assert.throws(() => captureRepairBaseline({ root: unborn.root, baseRef: "HEAD", pin: false }),
      { code: "REPAIR_BASELINE_UNRESOLVABLE" });
    unborn.commit("seed\n");
    const refs = unborn.git("show-ref");
    assert.throws(() => captureRepairBaseline({ root: unborn.root, baseRef: "refs/heads/absent", runId: "unresolved" }),
      { code: "REPAIR_BASELINE_UNRESOLVABLE" });
    assert.equal(unborn.git("show-ref"), refs, "an unresolved source must not create a baseline ref");
  });
  plain.complete = unborn.complete = true;
});
