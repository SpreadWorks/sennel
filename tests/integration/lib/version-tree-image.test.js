import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { AtomicJsonFile } from "../../../src/lib/atomic-json-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FileTreeImageRevisionError } from "../../../src/lib/file-tree-image.js";
import { FlowVersionLocation, FlowVersionAuthorityScope, FlowArtifactCatalogStore, VersionTreeSnapshot } from "../../../src/lib/flow-version.js";

function fixture(t) {
  const root = createTmpDir("portable-tree-image-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = new FlowVersionLocation({repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specId: "portable-image", version: 1});
  RealDirectoryAuthority.resolve(location.directory, {create: true});
  return {root, location};
}

function write(file, bytes) {
  const directoryAuthority = RealDirectoryAuthority.resolve(path.dirname(file), {create: true});
  return new AtomicFile(file, {directoryAuthority}).write(bytes);
}

test("transaction image producer, saved codec, fresh reader and restore preserve kind/path/binary bytes", (t) => {
  const {root, location} = fixture(t);
  const binaryPath = "artifacts/migration/space 日本語.bin";
  const binary = Buffer.from([0, 255, 17, 13, 10]);
  write(location.resolve(binaryPath), binary);
  write(location.resolve("issue.md"), "original\n");
  write(location.resolve(".runtime/retained.json"), "unconfirmed control record\n");
  const produced = new VersionTreeSnapshot(location);
  const record = new AtomicJsonFile(path.join(root, "image.json"));
  record.write(produced.toJSON());
  write(location.resolve(binaryPath), Buffer.from("changed"));
  write(location.resolve("artifacts/report.json"), "{}\n");
  write(location.resolve(".runtime/retained.json"), "later control record\n");
  const reloaded = VersionTreeSnapshot.fromStored(location, new AtomicJsonFile(path.join(root, "image.json")).read(null));
  reloaded.restore();
  assert.deepEqual(fs.readFileSync(location.resolve(binaryPath)), binary);
  assert.equal(fs.readFileSync(location.resolve("issue.md"), "utf8"), "original\n");
  assert.equal(fs.existsSync(location.resolve("artifacts/report.json")), false);
  assert.equal(fs.readFileSync(location.resolve(".runtime/retained.json"), "utf8"), "later control record\n");
  assert.deepEqual(new VersionTreeSnapshot(location).toJSON(), produced.toJSON());
});

test("genuine previous-producer journal is refused without changing source bytes, journal or backup", (t) => {
  const {root, location} = fixture(t);
  const fixtureDirectory = fileURLToPath(new URL("../../fixtures/version-transaction-v1/", import.meta.url));
  const bytes = fs.readFileSync(path.join(fixtureDirectory, "journal.json"));
  const provenance = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "provenance.json"), "utf8"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), provenance.fixtureSha256);
  assert.equal(provenance.producerCommit, "04f5fa481504aa45fd235534ffb80bbd6ee69d96");
  const previous = JSON.parse(bytes);
  for (const file of previous.snapshot.files) write(location.resolve(file.path), Buffer.from(file.bytes, "base64"));
  const runtime = location.runtimeLock("runtime.lock.artifact-catalog").runtimeDirectory;
  const journalPath = path.join(runtime, "catalog-transaction.json");
  write(journalPath, bytes);
  const backup = path.join(root, "previous-journal.backup.json");
  write(backup, bytes);
  const stateBefore = fs.readFileSync(location.flowStateFile);
  assert.throws(() => new FlowArtifactCatalogStore({location}).require(),
    (error) => error instanceof FileTreeImageRevisionError && error.revision === 1);
  assert.deepEqual(fs.readFileSync(journalPath), bytes);
  assert.deepEqual(fs.readFileSync(backup), bytes);
  assert.deepEqual(fs.readFileSync(location.flowStateFile), stateBefore);
});
