import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";
import { PROCESS_EVIDENCE_MIGRATION_KEYS } from "../../../src/lib/process-evidence-artifact-migration.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

class CanonicalEvidenceFixtureFile {
  #bytes;
  constructor(root, record) {
    assert.equal(path.posix.isAbsolute(record.relativePath), false);
    assert.equal(record.relativePath.includes("\\"), false);
    assert.equal(record.relativePath.split("/").some(part => ["..", ".tmp"].includes(part)), false);
    this.relativePath = record.relativePath;
    this.#bytes = fs.readFileSync(path.join(root, this.relativePath));
    assert.equal(this.#bytes.length, record.bytes);
    assert.equal(hash(this.#bytes), record.sha256);
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#bytes); }
  get json() { return JSON.parse(this.#bytes.toString("utf8")); }
  materialize(root) {
    const target = path.join(root, this.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, this.#bytes, { flag: "wx" });
  }
}

/** A catalog-bound boundary input. Deliberate malformed JSON remains hash-bound. */
export class CanonicalEvidenceFixtureArtifact {
  #bytes;
  constructor(descriptor, bytes) {
    this.descriptor = descriptor;
    this.#bytes = Buffer.from(bytes);
    assert.equal(descriptor.hash, hash(this.#bytes));
    assert.equal(descriptor.size, this.#bytes.length);
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#bytes); }
  get json() { return JSON.parse(this.#bytes.toString("utf8")); }
  withJSON(value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    return new CanonicalEvidenceFixtureArtifact(new FlowArtifactDescriptor({ ...this.descriptor.toJSON(),
      hash: hash(bytes), size: bytes.length }), bytes);
  }
}

/** Immutable canonical data only; callers own root creation and teardown.
 * SeedWorkRoot owns generic root lifetime, while this fixture owns declared
 * producer-byte validation and the process-evidence artifact projection. */
export class CanonicalProcessEvidenceFixture {
  #provenance;
  #files;
  #catalog;
  #prefix;
  constructor(directory) {
    const root = fileURLToPath(directory);
    this.#provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance.json")));
    const files = this.#provenance.records.map(record => new CanonicalEvidenceFixtureFile(root, record));
    this.#files = new Map(files.map(file => [file.relativePath, file]));
    assert.equal(this.#files.size, files.length);
    const catalogs = files.filter(file => file.relativePath.endsWith("/artifact-catalog.json"));
    assert.equal(catalogs.length, 1, "a canonical process fixture owns one Flow Version");
    this.#catalog = FlowArtifactCatalog.fromSerialized(catalogs[0].json);
    this.#prefix = path.posix.dirname(catalogs[0].relativePath);
    Object.freeze(this);
  }
  get provenance() { return structuredClone(this.#provenance); }
  materialize(root) {
    for (const file of this.#files.values()) file.materialize(root);
  }
  processArtifacts() {
    return this.#catalog.artifacts.filter(descriptor => PROCESS_EVIDENCE_MIGRATION_KEYS.includes(descriptor.logicalKey))
      .map(descriptor => new CanonicalEvidenceFixtureArtifact(descriptor,
        this.#files.get(path.posix.join(this.#prefix, descriptor.relativePath)).bytes));
  }
}
