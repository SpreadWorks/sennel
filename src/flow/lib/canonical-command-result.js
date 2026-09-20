/**
 * Typed bridge between a normal command's transient return value and its
 * producer-owned Version-1 attempt-history artifact.
 *
 * A command result is part of the CLI/worker boundary and must retain its
 * established enumerable JSON shape.  The durable artifact payload is
 * therefore carried on a private symbol until the registry confirms the
 * current Attempt through CanonicalFlowManagerStore.  It is never a second
 * filesystem writer and cannot survive process restart without that Store
 * confirmation.
 */

const ATTACHED_CANONICAL_ARTIFACT = Symbol("canonical-command-result-artifact");
const ATTACHED_CANONICAL_PUBLICATIONS = Symbol("canonical-command-result-publications");

function jsonPayload(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  try {
    return Object.freeze(JSON.parse(JSON.stringify(value)));
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${error.message}`);
  }
}

function logicalKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("canonical command artifact logicalKey is required");
  }
  return value;
}

/** One validated payload destined for the active Attempt's result history. */
export class CanonicalCommandResultArtifact {
  constructor({ logicalKey: key, payload } = {}) {
    this.logicalKey = logicalKey(key);
    this.payload = jsonPayload(payload, "canonical command artifact payload");
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalCommandResultArtifact
      ? value
      : new CanonicalCommandResultArtifact(value);
  }

  toJSON() {
    return { logicalKey: this.logicalKey, payload: this.payload };
  }
}

/** A non-history producer artifact committed with a command confirmation. */
export class CanonicalCommandResultPublication {
  constructor({ logicalKey: key, parameters = {}, mediaType = "application/json", payload } = {}) {
    this.logicalKey = logicalKey(key);
    this.parameters = jsonPayload(parameters, "canonical command publication parameters");
    if (typeof mediaType !== "string" || mediaType.trim() === "") {
      throw new Error("canonical command publication mediaType is required");
    }
    this.mediaType = mediaType;
    this.payload = jsonPayload(payload, "canonical command publication payload");
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalCommandResultPublication
      ? value
      : new CanonicalCommandResultPublication(value);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      parameters: this.parameters,
      mediaType: this.mediaType,
      payload: this.payload,
    };
  }

  toArtifactWrite() {
    // Review evidence has a typed owner+digest address rather than the
    // generic `{ parameters }` spelling. Keep the public command result
    // generic while letting the Store instantiate its dedicated value object.
    if (this.logicalKey === "review.evidence") {
      return Object.freeze({
        logicalKey: this.logicalKey,
        ...this.parameters,
        mediaType: this.mediaType,
        bytes: Buffer.from(`${JSON.stringify(this.payload, null, 2)}\n`, "utf8"),
      });
    }
    return Object.freeze({
      logicalKey: this.logicalKey,
      parameters: this.parameters,
      mediaType: this.mediaType,
      bytes: Buffer.from(`${JSON.stringify(this.payload, null, 2)}\n`, "utf8"),
    });
  }
}

/**
 * Preserve a command's public output while marking its durable result for the
 * same Store transaction that settles the active Attempt.
 */
export function attachCanonicalCommandResultArtifact(result, artifact) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("canonical command result attachment requires an object result");
  }
  const next = CanonicalCommandResultArtifact.from(artifact);
  if (Object.hasOwn(result, ATTACHED_CANONICAL_ARTIFACT)) {
    throw new Error("canonical command result already has an attached artifact");
  }
  Object.defineProperty(result, ATTACHED_CANONICAL_ARTIFACT, {
    value: next,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

/** Returns null for command results that do not own an attempt artifact. */
export function attachedCanonicalCommandResultArtifact(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const artifact = result[ATTACHED_CANONICAL_ARTIFACT] ?? null;
  return artifact === null ? null : CanonicalCommandResultArtifact.from(artifact);
}

/** Attach one or more durable non-history outputs without changing JSON output. */
export function attachCanonicalCommandResultPublications(result, publications) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("canonical command publication attachment requires an object result");
  }
  if (!Array.isArray(publications) || publications.length === 0) {
    throw new Error("canonical command publication attachment requires one or more publications");
  }
  if (Object.hasOwn(result, ATTACHED_CANONICAL_PUBLICATIONS)) {
    throw new Error("canonical command result already has attached publications");
  }
  const resolved = publications.map((publication) => CanonicalCommandResultPublication.from(publication));
  Object.defineProperty(result, ATTACHED_CANONICAL_PUBLICATIONS, {
    value: Object.freeze(resolved),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function attachedCanonicalCommandResultPublications(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return Object.freeze([]);
  const values = result[ATTACHED_CANONICAL_PUBLICATIONS] ?? [];
  return Object.freeze(values.map((value) => CanonicalCommandResultPublication.from(value)));
}

/** Read the current producer payload from a validated attempts[] document. */
export class CanonicalCommandAttemptArtifactHistory {
  constructor({ logicalKey: key, attempts } = {}) {
    this.logicalKey = logicalKey(key);
    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new Error("canonical command attempt history requires a non-empty attempts array");
    }
    let previous = 0;
    this.attempts = Object.freeze(attempts.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`canonical command attempt history attempts[${index}] must be an object`);
      }
      if (!Number.isSafeInteger(entry.attempt) || entry.attempt <= previous) {
        throw new Error("canonical command attempt history attempts must be strictly increasing positive integers");
      }
      previous = entry.attempt;
      const artifact = entry.artifact;
      if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
        throw new Error("canonical command attempt history artifact payload is required");
      }
      if (artifact.logicalKey !== this.logicalKey) {
        throw new Error("canonical command attempt history artifact logicalKey mismatch");
      }
      return Object.freeze({
        attempt: entry.attempt,
        payload: jsonPayload(artifact.payload, "canonical command attempt artifact payload"),
      });
    }));
    Object.freeze(this);
  }

  static fromBytes({ logicalKey: key, bytes } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new Error("canonical command attempt history bytes must be a Buffer");
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`canonical command attempt history must be JSON: ${error.message}`);
    }
    return new CanonicalCommandAttemptArtifactHistory({ logicalKey: key, attempts: parsed?.attempts });
  }

  get current() {
    return this.attempts.at(-1);
  }
}
