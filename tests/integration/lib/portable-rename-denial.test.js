import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile, AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("a real permission-denied rename preserves old bytes and retains only its owned stage for cleanup", {
  skip: process.platform === "win32" ? "requires an actual Windows ACL denial fixture; POSIX mode is not ACL evidence"
    : process.getuid() === 0 ? "requires a non-root process that cannot bypass directory permissions" : false,
}, (t) => {
  const root = createTmpDir("real-rename-denial-");
  t.after(() => removeTmpDir(root));
  const directory = path.join(root, "publication");
  fs.mkdirSync(directory);
  const mode = fs.statSync(directory).mode & 0o777;
  const file = path.join(directory, "visible.bin");
  const sentinel = path.join(directory, "other-actor.bin");
  const original = Buffer.from([0, 255, 42, 10]);
  const foreign = Buffer.from("retain other actor bytes\n");
  fs.writeFileSync(file, original);
  fs.writeFileSync(sentinel, foreign);
  const writer = new AtomicFile(file, { commitGuard() { fs.chmodSync(directory, 0o555); } });
  const stage = writer.createStage(Buffer.from("new bytes\n"));
  try {
    assert.throws(() => writer.publishStage(stage), (error) => error instanceof AtomicFileWriteError
      && error.cause.syscall === "rename" && ["EACCES", "EPERM"].includes(error.cause.code)
      && error.committedToVisibleName === false && error.publicationUnknown === false && error.cleanupFailed === true);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readFileSync(sentinel), foreign);
    assert.equal(stage.active, true);
    assert.equal(fs.existsSync(stage.path), true, "failed physical cleanup keeps the owned stage observable");
  } finally {
    fs.chmodSync(directory, mode);
    if (stage.active) stage.dispose();
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), ["other-actor.bin", "visible.bin"]);
});
