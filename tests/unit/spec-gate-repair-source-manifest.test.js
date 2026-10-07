import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots,
  SpecGateRepairSourceSnapshotManifest, SpecGateRepairSourceSnapshotReference } from "../../src/flow/lib/spec-gate-repair-values.js";

function source(id, content, availability = "available") {
  return new SpecGateRepairSource({ id, origin: `${id}.js`, content, availability,
    revision: availability === "available" ? createHash("sha256").update(content).digest("hex") : availability });
}

test("bodyless repair manifests retain exact sorted identities and content-addressed references", () => {
  const sources = [source("source:second", "日本語\n"), source("source:first", "const value = 1;"),
    source("source:missing", "", "missing"), source("source:unavailable", "", "unavailable")];
  const snapshots = new SpecGateRepairSourceSnapshots(sources);
  const manifest = SpecGateRepairSourceSnapshotManifest.fromSnapshots(snapshots);
  const value = manifest.toJSON();
  assert.deepEqual(value.sources, snapshots.sources().map((entry) => entry.descriptor()));
  assert.equal(value.sources.some((entry) => Object.hasOwn(entry, "content")), false);
  assert.deepEqual(SpecGateRepairSourceSnapshotManifest.fromJSON(value).toJSON(), value);
  const reference = manifest.reference();
  assert.equal(reference.digest, createHash("sha256").update(manifest.bytes()).digest("hex"));
  assert.equal(reference.byteLength, manifest.bytes().length);
  assert.deepEqual(new SpecGateRepairSourceSnapshotReference(reference.toJSON()).toJSON(), reference.toJSON());
  assert.throws(() => new SpecGateRepairSourceSnapshotReference({ ...reference.toJSON(), path: "foreign" }), /exact digest/);
});

test("repair manifest admission rejects unsorted, duplicated, malformed and nonavailable body identities", () => {
  const manifest = SpecGateRepairSourceSnapshotManifest.fromSnapshots(new SpecGateRepairSourceSnapshots([
    source("source:first", "a"), source("source:missing", "", "missing"),
  ])).toJSON();
  for (const changed of [
    { ...manifest, sources: [...manifest.sources].reverse() },
    { ...manifest, sources: [manifest.sources[0], manifest.sources[0]] },
    { ...manifest, sources: [{ ...manifest.sources[0], content: "a" }] },
    { ...manifest, sources: [{ ...manifest.sources[1], byteLength: 1 }] },
    { ...manifest, sources: [{ ...manifest.sources[0], digest: "invalid" }] },
  ]) assert.throws(() => SpecGateRepairSourceSnapshotManifest.fromJSON(changed), TypeError);
});
