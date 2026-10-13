import crypto from "node:crypto";
import { FlowArtifactCatalog } from "../lib/flow-version.js";
import { FLOW_QUERY_ERROR_CODES as ERROR_CODES, FLOW_QUERY_LIMITS } from "./query-contract.js";

class QueryError extends Error {
  constructor(code, jsonPath, message, { cause = null, reason = null, referenceId = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
    this.jsonPath = jsonPath;
    this.reason = reason;
    this.referenceId = referenceId;
  }
}


function canonicalJson(value, depth = 0) {
  if (depth > FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH) throw new Error("canonical JSON depth exceeds the limit");
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, depth + 1));
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalJson(value[key], depth + 1);
  return output;
}

function canonicalDigest(value, { maxBytes = FLOW_QUERY_LIMITS.MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES } = {}) {
  const text = JSON.stringify(canonicalJson(value));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) throw new Error("identity exceeds the canonical JSON byte limit");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}


function requireExactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function requirePublicString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return publicString(value, label);
}

function requirePublicInteger(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function requirePublicStringList(value, label, {
  limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS,
  unique = false,
} = {}) {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${label} must be a bounded array`);
  }
  if (unique && new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value.map((entry) => requirePublicString(entry, label));
}


function publicString(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES) {
    throw new Error(`${field} exceeds the public string limit`);
  }
  return value;
}

function uniqueLimited(values, field, limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) {
  const result = [...new Set(values)];
  if (result.length > limit) throw new Error(`${field} exceeds the public collection limit`);
  return result;
}

function uniqueObjectList(values, field, limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) {
  const serialized = uniqueLimited(values.map((value) => JSON.stringify(value)), field, limit);
  return serialized.map((value) => JSON.parse(value));
}

function publicArtifactId(descriptor) {
  return canonicalDigest(artifactIdentity(descriptor));
}

function publicArtifactKey(descriptor, flowVersionId) {
  const stored = descriptor.toJSON();
  return `artifact:${canonicalDigest({ flowVersionId, relativePath: descriptor.relativePath, kind: descriptor.kind,
    authority: stored.authority, cardinality: stored.cardinality, memberId: stored.memberId })}`;
}

function boundedPublic(value, field, depth = 0) {
  if (depth > FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH) throw new Error(`${field} exceeds the public nesting limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return publicString(value, field);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error(`${field} exceeds the public collection limit`);
    return value.map((entry, index) => boundedPublic(entry, `${field}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error(`${field} exceeds the public collection limit`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundedPublic(entry, `${field}.${key}`, depth + 1)]));
  }
  throw new Error(`${field} has an unsupported public value`);
}


function artifactIdentity(descriptor) {
  const stored = descriptor.toJSON();
  return {
    logicalKey: stored.logicalKey,
    kind: stored.kind,
    relativePath: stored.relativePath,
    hash: stored.hash,
    size: stored.size,
    mediaType: stored.mediaType,
    authority: stored.authority,
    cardinality: stored.cardinality,
    memberId: stored.memberId,
    publicationStep: stored.publicationStep,
    retention: stored.retention,
    activityId: stored.activityId,
    migrationMaterialization: stored.migrationMaterialization,
  };
}


class ReferenceResolver {
  constructor(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) throw new Error("Artifact reference resolution requires a validated catalog");
    this.catalog = catalog;
    this.byPath = new Map();
    this.byLogicalKey = new Map();
    this.byKindPath = new Map();
    this.byHashKind = new Map();
    const add = (index, key, descriptor) => index.set(key, [...(index.get(key) ?? []), descriptor]);
    for (const descriptor of catalog.artifacts) {
      add(this.byPath, descriptor.relativePath, descriptor);
      if (descriptor.logicalKey !== null) add(this.byLogicalKey, descriptor.logicalKey, descriptor);
      add(this.byKindPath, JSON.stringify([descriptor.kind, descriptor.relativePath]), descriptor);
      add(this.byHashKind, JSON.stringify([descriptor.kind, descriptor.hash]), descriptor);
      if (descriptor.logicalKey !== null && descriptor.logicalKey !== descriptor.kind) add(this.byHashKind, JSON.stringify([descriptor.logicalKey, descriptor.hash]), descriptor);
    }
    Object.freeze(this);
  }

  matchingDescriptors(reference, label) {
    if (reference === null || typeof reference !== "object") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} is invalid`);
    }
    const kind = Object.hasOwn(reference, "kind") ? reference.kind : reference.label;
    if (typeof kind !== "string" || typeof reference.id !== "string") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} is invalid`);
    }
    if (kind === "path") return this.byPath.get(reference.id) ?? [];
    if (kind === "logical") return this.byLogicalKey.get(reference.id) ?? [];
    return [...new Set([...(this.byKindPath.get(JSON.stringify([kind, reference.id])) ?? []),
      ...(/^[a-f0-9]{64}$/.test(reference.id) ? this.byHashKind.get(JSON.stringify([kind, reference.id])) ?? [] : [])])];
  }

  resolve(reference, label, { optional = false } = {}) {
    return this.#resolve(reference, label, { optional });
  }

  resolveActivityReference(reference, label, { optional = false } = {}) {
    return this.#resolve(reference, label, { optional });
  }

  resolveResultReference(reference, label) {
    const matches = this.matchingDescriptors(reference, label);
    if (matches.length === 1) return matches[0];
    const kind = Object.hasOwn(reference, "kind") ? reference.kind : reference.label;
    const claimsCatalogRelation = kind === "path"
      || kind === "logical"
      || this.catalog.artifacts.some((descriptor) => descriptor.kind === kind || descriptor.logicalKey === kind);
    if (matches.length === 0 && !claimsCatalogRelation) return null;
    throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} does not resolve to one canonical Artifact`);
  }

  #resolve(reference, label, { optional = false } = {}) {
    const matches = this.matchingDescriptors(reference, label);
    if (matches.length !== 1) {
      if (optional && matches.length === 0) return null;
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} does not resolve to one canonical Artifact`);
    }
    return matches[0];
  }

  validateCanonicalActivityResults(activities) {
    for (const activity of activities) {
      for (const reference of activity.result?.artifactRefs ?? []) {
        this.resolveResultReference(reference, "Activity result artifact reference");
      }
    }
  }

  activityRelations(activities) { return new ArtifactActivityRelations(this, activities); }
}

class ArtifactActivityRelations {
  #references = new Map();

  constructor(resolver, activities) {
    if (!(resolver instanceof ReferenceResolver)) throw new Error("artifact relations require the canonical resolver");
    for (const activity of activities) {
      const descriptors = [
        ...activity.references.artifacts.map((entry) => resolver.resolveActivityReference(entry, "Activity artifact reference", { optional: true })),
        ...(activity.result?.artifactRefs ?? []).map((entry) => resolver.resolveResultReference(entry, "Activity result artifact reference")),
      ];
      for (const descriptor of descriptors) {
        if (descriptor === null) continue;
        const ids = this.#references.get(descriptor.relativePath) ?? new Set();
        ids.add(activity.id);
        this.#references.set(descriptor.relativePath, ids);
      }
    }
    Object.freeze(this);
  }

  activityIdsFor(descriptor) { return [...(this.#references.get(descriptor.relativePath) ?? [])]; }
}

export {
  QueryError,
  canonicalJson,
  canonicalDigest,
  isPlainObject,
  requireExactObject,
  requirePublicString,
  requirePublicInteger,
  requirePublicStringList,
  publicString,
  uniqueLimited,
  uniqueObjectList,
  publicArtifactId,
  publicArtifactKey,
  boundedPublic,
  artifactIdentity,
  ReferenceResolver,
};
