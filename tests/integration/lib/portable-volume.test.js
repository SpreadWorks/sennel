import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { OwnedTemporaryDirectory } from "../../../src/lib/owned-temporary-directory.js";
import { RealDirectoryAuthority, RealDirectoryOperationError } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";

const secondVolume = process.env.SENNEL_TEST_SECOND_VOLUME_ROOT;

test("a real cross-volume move refuses publication and preserves the original tree", {
  skip: secondVolume === undefined ? "set SENNEL_TEST_SECOND_VOLUME_ROOT to a writable directory on another volume" : false,
}, (t) => {
  const root = createTmpDir("portable-volume-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const other = OwnedTemporaryDirectory.create(new RealDirectoryAuthority(fs.realpathSync(secondVolume)), "portable-volume-");
  t.after(() => other.cleanup());
  const source = OwnedTemporaryDirectory.create(new RealDirectoryAuthority(root), "source-");
  assert.notEqual(source.authority.identity.dev, other.authority.identity.dev,
    "the acceptance fixture must actually use different volumes");
  const name = "space 日本語.bin";
  const bytes = Buffer.from([0, 255, 13, 10, 17]);
  new AtomicFile(path.join(source.path, name), { directoryAuthority: source.authority }).write(bytes);
  const destination = path.join(other.path, "destination");
  assert.throws(() => source.authority.moveTo(destination), (error) => {
    assert(error instanceof RealDirectoryOperationError);
    assert.equal(error.operation, "move");
    assert.equal(error.committedToVisibleName, false);
    assert.equal(error.publicationUnknown, false);
    t.diagnostic(`actual filesystem refusal: ${error.cause.code}`);
    return true;
  });
  assert.deepEqual(fs.readFileSync(path.join(source.path, name)), bytes);
  assert.equal(fs.existsSync(destination), false);
  source.authority.assertStable();
  other.authority.assertStable();
});
