import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";
import { standaloneTestEnvironment } from "../../src/lib/process.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

const quiet = { log() {}, error() {} };
const journalRelative = ".tmp/sennel-migrate-layout.json";

class MigrationOwnerFixture {
  constructor(t) {
    this.root = createTmpDir("migration-owner-");
    t.after(() => removeTmpDir(this.root));
    fs.mkdirSync(path.join(this.root, ".senti"));
    fs.writeFileSync(path.join(this.root, ".senti/config.json"), JSON.stringify({ name: "owner-fixture", lang: "en", type: "base" }));
    fs.writeFileSync(path.join(this.root, ".senti/payload.bin"), Buffer.from([0, 255, 17, 128]));
  }
  readJournal() { return JSON.parse(fs.readFileSync(path.join(this.root, journalRelative), "utf8")); }
  snapshot() {
    const visit = (directory) => fs.readdirSync(directory).sort().flatMap((name) => {
      const target = path.join(directory, name);
      return fs.lstatSync(target).isDirectory() ? visit(target) : [[path.relative(this.root, target), fs.readFileSync(target).toString("base64")]];
    });
    return visit(this.root);
  }
}

test("released migration writer permits fresh readback and exact cleanup recovery", (t) => {
  const fixture = new MigrationOwnerFixture(t);
  const remove = fs.rmSync;
  try {
    fs.rmSync = function (target, options) {
      if (path.basename(target) === "legacy-source-backup") throw new Error("owned cleanup fault");
      return remove.call(fs, target, options);
    };
    assert.throws(() => new LayoutMigrationRevisionOne(fixture.root, { logger: quiet }).run(), /owned cleanup fault/);
  } finally { fs.rmSync = remove; }
  const record = fixture.readJournal();
  assert.equal(record.version, 8);
  assert.deepEqual(Object.keys(record.owner).sort(), ["ownerSession", "ownerToken", "released"]);
  assert.equal(record.owner.released, true);
  const payload = fs.readFileSync(path.join(fixture.root, ".sennel/payload.bin"));
  const recovered = new LayoutMigrationRevisionOne(fixture.root, { logger: quiet }).run();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.complete, true);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, ".sennel/payload.bin")), payload);
  assert.equal(fs.existsSync(path.join(fixture.root, journalRelative)), false);
});

test("an exited journal writer without its explicit release remains unknown and preserves every byte", (t) => {
  const fixture = new MigrationOwnerFixture(t);
  const moduleUrl = pathToFileURL(path.resolve("src/lib/layout-migration.js")).href;
  const source = `import fs from "node:fs"; import path from "node:path";
    import { LayoutMigrationRevisionOne } from ${JSON.stringify(moduleUrl)};
    const remove = fs.rmSync;
    fs.rmSync = function(target, options) { if (path.basename(target) === "legacy-source-backup") process.exit(19); return remove.call(fs,target,options); };
    new LayoutMigrationRevisionOne(${JSON.stringify(fixture.root)}, {logger:{log(){},error(){}}}).run();`;
  const result = spawnSync(process.execPath, ["--import", path.resolve("src/sennel.js"), "--input-type=module", "-e", source], {
    env: standaloneTestEnvironment(), encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 19, result.stderr);
  assert.equal(fixture.readJournal().owner.released, false);
  const before = fixture.snapshot();
  assert.throws(() => new LayoutMigrationRevisionOne(fixture.root, { logger: quiet }).run(), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.reason, "owner-unknown");
    return true;
  });
  assert.deepEqual(fixture.snapshot(), before);
});

test("actual revision 7 PID-owner journal is explicitly rejected without conversion", (t) => {
  const fixture = new MigrationOwnerFixture(t);
  const seedRoot = path.resolve("tests/fixtures/process-owner-v7");
  const bytes = fs.readFileSync(path.join(seedRoot, "layout-journal.json"));
  const provenance = JSON.parse(fs.readFileSync(path.join(seedRoot, "provenance.json"), "utf8"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.sha256);
  fs.mkdirSync(path.join(fixture.root, ".tmp"));
  fs.writeFileSync(path.join(fixture.root, journalRelative), bytes);
  const before = fixture.snapshot();
  assert.throws(() => new LayoutMigrationRevisionOne(fixture.root, { logger: quiet }).run(), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.reason, "legacy-owner-format");
    return true;
  });
  assert.deepEqual(fixture.snapshot(), before);
});
