import { RepairFingerprintManifest, buildRepairStateManifest } from "./repair-state-identity.js";

function requiredSpecPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("repair fingerprint requires a manager-bound spec path");
  }
  return value.trim();
}

/**
 * Capture the execution target used to bind review and test evidence.
 * Durable artifacts are excluded by the manifest builder; callers must pass
 * the Version-resolved spec path rather than asking this value API to infer a
 * legacy sibling from projected Flow state.
 */
export function buildRepairFingerprint({ root, artifactRoot = null, specPath, truncated = false } = {}) {
  if (truncated) throw new Error("truncated repair fingerprint is not valid evidence");
  return buildRepairStateManifest({
    root,
    artifactRoot,
    specPath: requiredSpecPath(specPath),
  });
}

export function assertRepairFingerprint({ artifact, fingerprint, label = "artifact" } = {}) {
  const current = fingerprint instanceof RepairFingerprintManifest
    ? fingerprint
    : new RepairFingerprintManifest(fingerprint);
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`${label} must be an object`);
  }
  if (artifact.repairFingerprint !== current.hash) {
    throw new Error(`${label} repairFingerprint mismatch: expected ${current.hash}, got ${artifact.repairFingerprint}`);
  }
  return artifact;
}
