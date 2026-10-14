import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

/** Physical persistence protected by refusal and exact replay. A semantic
 * projection alone cannot detect a byte rewrite or a changed artifact identity.
 */
export class CanonicalPersistenceSnapshot {
  #files;

  constructor(manager, specId, additionalPaths = []) {
    const location = manager.specLocation(specId);
    this.flow = fs.readFileSync(location.flowStateFile);
    this.activities = fs.readFileSync(location.activitiesFile);
    this.catalog = fs.readFileSync(location.catalogFile);
    this.catalogHash = createHash("sha256").update(this.catalog).digest("hex");
    this.permanentArtifacts = manager.artifactCatalog(specId).toJSON().artifacts
      .filter((artifact) => artifact.retention === "permanent")
      .map(({ logicalKey, relativePath, hash, activityId }) =>
        Object.freeze({ logicalKey, relativePath, hash, activityId }));
    this.permanentBytes = new Map(this.permanentArtifacts.map(({ relativePath }) =>
      [relativePath, fs.readFileSync(location.resolve(relativePath))]));
    // Include attempted publication destinations even when no descriptor
    // exists yet, so a refusal cannot leave an uncataloged artifact behind.
    this.additionalPaths = Object.freeze([...additionalPaths]);
    this.additionalBytes = new Map(this.additionalPaths.map((file) =>
      [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    this.#files = new Map([
      [location.flowStateFile, this.flow], [location.activitiesFile, this.activities],
      [location.catalogFile, this.catalog],
      ...[...this.permanentBytes].map(([relativePath, bytes]) => [location.resolve(relativePath), bytes]),
      ...this.additionalBytes,
    ]);
    Object.freeze(this.permanentArtifacts);
    Object.freeze(this);
  }

  /** A held writer lock forbids manager reads. Inspect the captured physical
   * destinations without acquiring that lock or changing its ownership.
   */
  assertPhysicalUnchanged(operation, expectedChanges = new Map()) {
    for (const [file, expected] of this.#files) {
      const actual = fs.existsSync(file) ? fs.readFileSync(file) : null;
      // A deliberate malformed input is captured before invoking its consumer.
      // Its changed bytes still need exact protection while catalog reads fail.
      const input = expectedChanges.has(file) ? expectedChanges.get(file) : expected;
      assert.deepEqual(actual, input, `${operation} must retain ${file}`);
    }
  }

  assertUnchanged(manager, specId, operation) {
    const actual = new CanonicalPersistenceSnapshot(manager, specId, this.additionalPaths);
    assert.deepEqual(actual.flow, this.flow, `${operation} must not rewrite flow.json`);
    assert.deepEqual(actual.activities, this.activities, `${operation} must not append an Activity`);
    assert.deepEqual(actual.catalog, this.catalog, `${operation} must not rewrite the catalog`);
    assert.equal(actual.catalogHash, this.catalogHash, `${operation} must retain the catalog hash`);
    assert.deepEqual(actual.permanentArtifacts, this.permanentArtifacts,
      `${operation} must retain permanent artifact identity`);
    assert.deepEqual(actual.permanentBytes, this.permanentBytes,
      `${operation} must retain permanent artifact bytes`);
    assert.deepEqual(actual.additionalBytes, this.additionalBytes,
      `${operation} must not publish rejected artifact bytes`);
  }
}
