import { requiredText, exactKeys } from "./source-effect-fields.js";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FINDINGS = 256;
const MAX_PATHS = 256;
const MAX_PATH_BYTES = 500;


function requiredDigest(value, field) {
  const result = requiredText(value, field);
  if (!SHA256.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
}


function normalizedPath(value, field) {
  const candidate = requiredText(value, field).replaceAll("\\", "/");
  if (Buffer.byteLength(candidate) > MAX_PATH_BYTES
    || candidate.startsWith("/")
    || candidate.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} must be a normalized project-relative path`);
  }
  return candidate;
}

function boundedUnique(values, { field, normalize, max = MAX_PATHS } = {}) {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) {
    throw new Error(`${field} must be a bounded non-empty array`);
  }
  const normalized = values.map((value) => normalize(value, field));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze(normalized);
}

export class RepairFindingPathClaim {
  constructor(value = {}) {
    exactKeys(value, ["findingKey", "paths"], "repair finding path claim");
    this.findingKey = requiredText(value.findingKey, "repair findingKey");
    this.paths = boundedUnique(value.paths, { field: "repair finding paths", normalize: normalizedPath });
    Object.freeze(this);
  }

  bind(manifest) {
    if (manifest === null || typeof manifest?.mutationIdForPath !== "function") {
      throw new Error("repair finding path claim requires a source mutation manifest");
    }
    return new RepairFindingMutation({
      findingKey: this.findingKey,
      mutationIds: this.paths.map((relativePath) => manifest.mutationIdForPath(relativePath)),
    });
  }

  toJSON() { return { findingKey: this.findingKey, paths: [...this.paths] }; }
}

export class RepairFindingMutation {
  constructor(value = {}) {
    exactKeys(value, ["findingKey", "mutationIds"], "repair finding mutation");
    this.findingKey = requiredText(value.findingKey, "repair findingKey");
    this.mutationIds = boundedUnique(value.mutationIds, {
      field: "repair finding mutationIds",
      normalize: requiredDigest,
    });
    Object.freeze(this);
  }

  paths(manifest) {
    if (manifest === null || typeof manifest?.pathForMutationId !== "function") {
      throw new Error("repair finding mutation requires a source mutation manifest");
    }
    return this.mutationIds.map((mutationId) => manifest.pathForMutationId(mutationId));
  }

  toJSON() { return { findingKey: this.findingKey, mutationIds: [...this.mutationIds] }; }
}

class RepairFindingCollection {
  constructor(entries, Entry, field) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_FINDINGS) {
      throw new Error(`${field} must be a bounded non-empty array`);
    }
    this.entries = Object.freeze(entries.map((entry) => entry instanceof Entry ? entry : new Entry(entry)));
    if (new Set(this.entries.map((entry) => entry.findingKey)).size !== this.entries.length) {
      throw new Error(`${field} must contain each findingKey exactly once`);
    }
  }

  get appliedFindingKeys() { return Object.freeze(this.entries.map((entry) => entry.findingKey)); }

  assertFindingKeys(expectedFindingKeys) {
    if (!Array.isArray(expectedFindingKeys)) throw new Error("repair finding comparison requires canonical finding keys");
    const actual = this.appliedFindingKeys;
    const expected = new Set(expectedFindingKeys);
    const actualSet = new Set(actual);
    const missing = expectedFindingKeys.filter((findingKey) => !actualSet.has(findingKey));
    const unknown = actual.filter((findingKey) => !expected.has(findingKey));
    if (expected.size !== expectedFindingKeys.length || missing.length > 0 || unknown.length > 0) {
      const error = new Error("repair findings must exactly match the canonical applied findings");
      error.code = "FLOW_REPAIR_FINDING_COVERAGE_INVALID";
      error.data = { missingFindingKeys: missing.slice(0, 20), unknownFindingKeys: unknown.slice(0, 20) };
      throw error;
    }
    return this;
  }
}

/** Worker-authored finding-to-path claims, before parent observation binding. */
export class RepairFindingPathClaims extends RepairFindingCollection {
  constructor(entries) {
    super(entries, RepairFindingPathClaim, "repair finding path claims");
    Object.freeze(this);
  }

  bind(manifest) {
    const observed = manifest?.paths?.();
    if (!Array.isArray(observed)) throw new Error("repair finding path claims require a source mutation manifest");
    const claimed = new Set(this.entries.flatMap((entry) => entry.paths));
    const observedSet = new Set(observed);
    const missing = observed.filter((relativePath) => !claimed.has(relativePath));
    const unknown = [...claimed].filter((relativePath) => !observedSet.has(relativePath));
    if (missing.length > 0 || unknown.length > 0) {
      const error = new Error("repair finding path claims must exactly cover the parent-observed mutation paths");
      error.code = "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID";
      error.data = { missing: missing.slice(0, 20), unknown: unknown.slice(0, 20) };
      throw error;
    }
    return new RepairFindingMutations(this.entries.map((entry) => entry.bind(manifest)));
  }

  toJSON() { return this.entries.map((entry) => entry.toJSON()); }
}

/** Parent-bound finding-to-mutation identities used by canonical repair evidence. */
export class RepairFindingMutations extends RepairFindingCollection {
  constructor(entries) {
    super(entries, RepairFindingMutation, "repair finding mutations");
    Object.freeze(this);
  }

  assertManifest(manifest) {
    const observed = Array.isArray(manifest?.mutations) ? manifest.mutations.map((entry) => entry.mutationId) : null;
    if (observed === null) {
      throw new Error("repair finding mutations require a source mutation manifest");
    }
    const claimed = new Set(this.entries.flatMap((entry) => entry.mutationIds));
    const observedSet = new Set(observed);
    const missing = observed.filter((mutationId) => !claimed.has(mutationId));
    const unknown = [...claimed].filter((mutationId) => !observedSet.has(mutationId));
    if (missing.length > 0 || unknown.length > 0) {
      const error = new Error("repair finding mutations must exactly cover the parent-observed mutation manifest");
      error.code = "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID";
      error.data = { missingMutationIds: missing.slice(0, 20), unknownMutationIds: unknown.slice(0, 20) };
      throw error;
    }
    if (typeof manifest?.pathForMutationId === "function") {
      for (const entry of this.entries) entry.paths(manifest);
    }
    return this;
  }

  toJSON() { return this.entries.map((entry) => entry.toJSON()); }
}
