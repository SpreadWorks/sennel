import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";

/** Resolve only a prepared transaction's exact catalog members. */
export function readProspectiveCommandArtifact(publication, { logicalKey, parameters = {}, optional = false }) {
  const resolved = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  const descriptors = Array.isArray(publication.catalog) ? publication.catalog : publication.catalog.artifacts;
  const descriptor = descriptors.find((entry) => entry.logicalKey === logicalKey
    && entry.relativePath === resolved.relativePath) ?? null;
  if (descriptor === null) {
    if (optional) return null;
    throw new Error(`Prospective command publication is missing ${logicalKey}`);
  }
  return { descriptor, relativePath: descriptor.relativePath, bytes: publication.readCatalogedArtifact(descriptor) };
}
