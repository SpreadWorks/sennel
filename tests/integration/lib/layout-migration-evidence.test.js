import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LayoutFileContent } from "../../../src/lib/layout-file-content.js";
import { LayoutBeforeImageRequest, LayoutMigrationEvidence } from "../../../src/lib/layout-migration-evidence.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("layout-evidence-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "original sentiDir bytes\n");
  const content = LayoutFileContent.capture(source, { transform: true });
  const evidence = LayoutMigrationEvidence.create(root, [new LayoutBeforeImageRequest("templates/source.txt", content)]);
  return { root, source, evidence, payload: path.join(evidence.directory, evidence.files[0].name) };
}

test("layout raw evidence survives source removal and strict cold manifest readback without embedding payload bytes", t => {
  const { root, source, evidence, payload } = fixture(t);
  const wire = JSON.parse(JSON.stringify(evidence));
  assert.equal(Object.hasOwn(wire.files[0], "bytes"), false);
  fs.unlinkSync(source);
  const cold = LayoutMigrationEvidence.fromJSON(root, wire);
  cold.assertIntact();
  assert.equal(fs.readFileSync(payload, "utf8"), "original sentiDir bytes\n");
  assert.deepEqual(cold.toJSON(), wire);
  cold.discardPrepared();
  assert.equal(fs.existsSync(evidence.directory), false);
});

test("layout evidence refuses changed payload bytes before discarding any owned proof", t => {
  const { evidence, payload } = fixture(t);
  fs.writeFileSync(payload, "foreign payload bytes");
  assert.throws(() => evidence.assertIntact(), /layout raw before-image bytes changed/);
  assert.throws(() => evidence.discardPrepared(), /layout raw before-image bytes changed/);
  assert.equal(fs.readFileSync(payload, "utf8"), "foreign payload bytes");
});

test("layout evidence refuses a same-byte payload replacement instead of adopting its generation", t => {
  const { root, evidence, payload } = fixture(t);
  const bytes = fs.readFileSync(payload);
  const saved = path.join(root, "saved-before-image");
  fs.renameSync(payload, saved);
  fs.writeFileSync(payload, bytes);
  assert.throws(() => evidence.assertIntact(), { code: "REGULAR_FILE_READ_IDENTITY" });
  assert.throws(() => evidence.discardPrepared(), { code: "REGULAR_FILE_READ_IDENTITY" });
  assert.deepEqual(fs.readFileSync(payload), bytes);
  assert.deepEqual(fs.readFileSync(saved), bytes);
});

test("layout evidence preserves foreign directory entries when unpublished cleanup is refused", t => {
  const { evidence, payload } = fixture(t);
  const foreign = path.join(evidence.directory, "foreign.txt");
  fs.writeFileSync(foreign, "foreign bytes");
  assert.throws(() => evidence.discardPrepared(), /foreign or missing evidence/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "foreign bytes");
  assert.equal(fs.readFileSync(payload, "utf8"), "original sentiDir bytes\n");
});
