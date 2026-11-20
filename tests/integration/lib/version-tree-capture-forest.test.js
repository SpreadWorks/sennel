import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FlowVersionLocation, FlowVersionAuthorityScope, VersionTreeSnapshot } from "../../../src/lib/flow-version.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("a transaction image refuses an earlier parent replacement during a later file read and preserves both generations", (t) => {
  const root = createTmpDir("version-image-capture-forest-");
  t.after(() => removeTmpDir(root));
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "image-forest", version: 1 });
  const files = ["left/one.bin", "right/two.bin"].map(relative =>
    location.resolve(`artifacts/migration/${relative}`));
  const bytes = Buffer.from([0, 255, 17, 13, 10]);
  for (const file of files) {
    const directoryAuthority = RealDirectoryAuthority.resolve(path.dirname(file), { create: true });
    new AtomicFile(file, { directoryAuthority }).write(bytes);
  }
  const replacement = Buffer.from("replacement generation\n");
  const open = fs.openSync;
  let first = null, displaced = null;
  t.mock.method(fs, "openSync", function (file, ...args) {
    if (files.includes(file)) {
      if (first === null) first = file;
      else if (file !== first && displaced === null) {
        const directory = path.dirname(first);
        displaced = directory + "-displaced";
        fs.renameSync(directory, displaced);
        fs.mkdirSync(directory);
        fs.writeFileSync(first, replacement);
      }
    }
    return open.call(this, file, ...args);
  });
  assert.throws(() => new VersionTreeSnapshot(location),
    error => RealDirectoryAuthority.isAuthorityFailure(error));
  assert.notEqual(displaced, null, "the later real read must replace an already captured parent");
  assert.deepEqual(fs.readFileSync(path.join(displaced, path.basename(first))), bytes);
  assert.deepEqual(fs.readFileSync(first), replacement);
  assert.deepEqual(fs.readFileSync(files.find(file => file !== first)), bytes);
});
