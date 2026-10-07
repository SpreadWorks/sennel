import { isDeepStrictEqual } from "node:util";
import { CanonicalFlowArtifactWrite } from "./current-flow-state.js";
import { SpecGateRepairSourceSnapshots, SpecGateRepairSourceSnapshotManifest,
  SpecGateRepairSourceSnapshotReference } from "./spec-gate-repair-values.js";
import { SpecGateRepairSourceCaptureBudget } from "./spec-gate-repair-sources.js";

const BLOB_KEY = "spec.gate.repair.source.blob";
const MANIFEST_KEY = "spec.gate.repair.source.manifest";

/** All immutable source artifacts accompany the first canonical checkpoint transaction. */
export class SpecGateRepairSourcePublication {
  #manifest;
  #writes;
  constructor({ snapshots, captureBudget = new SpecGateRepairSourceCaptureBudget() }) {
    if (!(snapshots instanceof SpecGateRepairSourceSnapshots)
      || !(captureBudget instanceof SpecGateRepairSourceCaptureBudget)) {
      throw new TypeError("Repair source publication requires typed snapshots and capture budget");
    }
    this.#manifest = SpecGateRepairSourceSnapshotManifest.fromSnapshots(snapshots);
    const blobs = new Map();
    for (const source of snapshots.sources()) {
      if (source.availability !== "available" || blobs.has(source.digest)) continue;
      blobs.set(source.digest, Buffer.from(source.content, "utf8"));
    }
    const manifestBytes = this.#manifest.bytes();
    captureBudget.admitArtifacts([...blobs.values(), manifestBytes]);
    this.#writes = Object.freeze([...blobs].map(([digest, bytes]) => Object.freeze({
      logicalKey: BLOB_KEY, parameters: Object.freeze({ digest }), bytes,
    })).concat(Object.freeze({ logicalKey: MANIFEST_KEY,
      parameters: Object.freeze({ digest: this.#manifest.reference().digest }), bytes: manifestBytes })));
    Object.freeze(this);
  }
  reference() { return this.#manifest.reference(); }
  artifactWrites() { return this.#writes.map((write) => new CanonicalFlowArtifactWrite({ ...write,
    mediaType: write.logicalKey === BLOB_KEY ? "text/plain" : "application/json" })); }
}

/** Resolve only catalog-owned exact identities using the progress reader's coherent view. */
export function readSpecGateRepairSourceSnapshots({ flowManager, specId, consumerNodeId, reference,
  progressActivityId, view, activities }) {
  const identity = new SpecGateRepairSourceSnapshotReference(reference);
  const ledger = [...activities.values()];
  const progressIndex = ledger.findIndex((activity) => activity.id === progressActivityId);
  if (progressIndex < 0) throw new Error("Repair source progress publication has no canonical Activity");
  const read = (logicalKey, digest, byteLength, latestIndex) => {
    const artifact = flowManager.readArtifact({ specId, consumerNodeId, logicalKey, parameters: { digest }, view });
    const index = ledger.findIndex((activity) => activity.id === artifact.descriptor.activityId);
    if (artifact.descriptor.hash !== digest || artifact.descriptor.size !== byteLength
      || index < 0 || index > latestIndex || ledger[index].nodeId !== "spec-gate-repair") {
      throw new Error("Repair source reference differs from its canonical publication identity");
    }
    new SpecGateRepairSourceSnapshotReference({ digest, byteLength }).assertBytes(artifact.bytes);
    return { artifact, index };
  };
  const { artifact, index } = read(MANIFEST_KEY, identity.digest, identity.byteLength, progressIndex);
  const manifest = SpecGateRepairSourceSnapshotManifest.fromJSON(JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(artifact.bytes)));
  if (!artifact.bytes.equals(manifest.bytes())) throw new Error("Repair source manifest differs from its exact serialization");
  const blobs = new Map();
  return manifest.restore((digest, byteLength) => {
    if (!blobs.has(digest)) blobs.set(digest, read(BLOB_KEY, digest, byteLength, index).artifact.bytes);
    const bytes = blobs.get(digest);
    if (bytes.length !== byteLength) throw new Error("Conflicting repair source blob byte lengths");
    return bytes;
  });
}

/** A selected UTF-8 slice must retain its full source identity after readback. */
export function assertSpecGateRepairSelectedSources(context, snapshots) {
  const sources = new Map(snapshots.sources().map((source) => [source.id, source]));
  for (const selected of context.bundle?.sources ?? []) {
    const source = sources.get(selected.snapshotId);
    if (source === undefined || selected.origin !== source.origin || selected.revision !== source.revision
      || selected.snapshotDigest !== source.digest || selected.snapshotByteLength !== source.byteLength
      || selected.availability !== source.availability || !isDeepStrictEqual(selected.appliesTo, source.appliesTo)
      || !Number.isSafeInteger(selected.byteStart) || !Number.isSafeInteger(selected.byteEnd)
      || selected.byteStart < 0 || selected.byteEnd > source.byteLength || selected.byteStart > selected.byteEnd
      || !Buffer.from(source.content, "utf8").subarray(selected.byteStart, selected.byteEnd)
        .equals(Buffer.from(selected.content, "utf8"))) {
      throw new Error("Repair selected source differs from its captured revision or exact byte range");
    }
  }
}
