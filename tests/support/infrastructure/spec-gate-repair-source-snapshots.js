import fs from "node:fs";
import path from "node:path";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { SpecGateRepairSourceSnapshotManifest, SpecGateRepairSourceSnapshotReference } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairSourcePublication } from "../../../src/flow/lib/spec-gate-repair-source-storage.js";

/** Persist the production publication bytes in a caller-owned standalone fixture. */
export function saveFixtureSpecGateRepairSources({ root, snapshots }) {
  const publication = new SpecGateRepairSourcePublication({ snapshots });
  for (const write of publication.artifactWrites()) {
    const target = path.join(root, write.artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.bytes);
  }
  const reference = publication.reference().toJSON();
  const readManifest = () => {
    const manifest = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.source.manifest", { digest: reference.digest });
    const bytes = fs.readFileSync(path.join(root, manifest.relativePath));
    new SpecGateRepairSourceSnapshotReference(reference).assertBytes(bytes);
    return JSON.parse(bytes.toString("utf8"));
  };
  const readBlob = (digest) => {
    const blob = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.source.blob", { digest });
    return fs.readFileSync(path.join(root, blob.relativePath));
  };
  return { reference, readManifest, readBlob,
    restore: () => SpecGateRepairSourceSnapshotManifest.fromJSON(readManifest()).restore(readBlob) };
}
