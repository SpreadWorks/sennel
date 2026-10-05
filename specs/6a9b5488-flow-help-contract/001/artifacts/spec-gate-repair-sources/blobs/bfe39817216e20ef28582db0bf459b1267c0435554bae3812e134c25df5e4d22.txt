/** Shared deterministic hashing and immutable input snapshots for artifact views. */

import crypto from "node:crypto";

function stableJsonValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("artifact view fingerprint input must be JSON-serializable");
  return serialized;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Serialize JSON-compatible values with object keys in deterministic order. */
export function stableArtifactViewJson(value) {
  return stableJsonValue(value);
}

/** SHA-256 digest for one exact text or byte sequence. */
export function artifactViewSha256(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    throw new Error("artifact view SHA-256 input must be text or bytes");
  }
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Clone then recursively freeze a public fingerprint input snapshot. */
export function immutableArtifactViewFingerprintInput(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch (cause) {
    throw new Error(`artifact view fingerprint input must be cloneable: ${cause.message}`);
  }
}
