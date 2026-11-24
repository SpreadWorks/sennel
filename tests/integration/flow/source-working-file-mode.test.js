import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { SynchronousManagedFixture } from "../../support/infrastructure/synchronous-managed-fixture.js";
import { SourceWorkingFileCapture, observeSourceUntrackedMode } from "../../../src/flow/lib/source-working-file-capture.js";

it("observes permission-only changes from fresh metadata instead of retaining an inode-based mode", (t) => {
  const fixture = new SynchronousManagedFixture(t, "source-working-mode-");
  initGitRepo(fixture.root);
  const file = path.join(fixture.root, "source");
  fs.writeFileSync(file, "source\r\n"); fs.chmodSync(file, 0o644);
  const first = SourceWorkingFileCapture.capture(fixture.root, "source", { maxBytes: 32 });
  const modeBefore = observeSourceUntrackedMode(fixture.root, "source", { filemode: true, maxBytes: 32 });
  fs.chmodSync(file, 0o755);
  const second = SourceWorkingFileCapture.capture(fixture.root, "source", { maxBytes: 32 });
  const modeAfter = observeSourceUntrackedMode(fixture.root, "source", { filemode: true, maxBytes: 32 });
  assert.equal(first.working.generation.equals(second.working.generation), true);
  assert.equal(first.working.digest, second.working.digest);
  if (process.platform !== "win32") {
    assert.equal(modeBefore, "100644");
    assert.equal(modeAfter, "100755");
    assert.equal(first.permissionHint.mode & 0o100, 0);
    assert.notEqual(second.permissionHint.mode & 0o100, 0);
  } else {
    assert.match(modeBefore, /^100(?:644|755)$/);
    assert.match(modeAfter, /^100(?:644|755)$/);
  }
  assert.equal(observeSourceUntrackedMode(fixture.root, "source", { filemode: false, maxBytes: 32 }), "100644");
  fixture.complete = true;
});

it("keeps the caller's complete bounded no-follow capture at the mode observation boundary", (t) => {
  const fixture = new SynchronousManagedFixture(t, "source-mode-boundary-");
  initGitRepo(fixture.root);
  const file = path.join(fixture.root, "source");
  fs.writeFileSync(file, "source bytes");
  assert.throws(() => observeSourceUntrackedMode(fixture.root, "source", { filemode: true, maxBytes: 1 }), { code: "REGULAR_FILE_READ_LIMIT" });
  fs.linkSync(file, path.join(fixture.root, "alias"));
  assert.throws(() => observeSourceUntrackedMode(fixture.root, "source", { filemode: true, maxBytes: 32 }), { name: "RegularFileLinkCountError" });
  assert.equal(fs.readFileSync(file, "utf8"), "source bytes");
  fixture.complete = true;
});
