// This file must use a fresh test host: no earlier managed bridge exists.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getPorcelainV2Status } from "../../../src/lib/git-helpers.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("first-use readonly Git with repository-owned temporary storage reports only user files", t => {
  const fixture = createTmpDir("readonly-first-internal-tmp-");
  const original = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeTmpDir(fixture);
  });
  const root = path.join(fixture, "repository"); fs.mkdirSync(root);
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "visible.txt"), "user file\n");
  const temporary = path.join(root, "local-tmp"); fs.mkdirSync(temporary);
  const before = fs.readdirSync(root).sort();
  // Node owns native precedence; the fixture supplies the same directory to
  // every supported selector rather than assuming POSIX TMPDIR on Windows.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = temporary;
  const status = getPorcelainV2Status(root);
  const paths = status.pathSet.toArray();
  assert.equal(paths.length, 1, "first status must not include Sennel bootstrap control output");
  assert.deepEqual(paths, ["visible.txt"]);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.deepEqual(fs.readdirSync(temporary), []);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(process.env[key], temporary);
});
