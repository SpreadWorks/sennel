import crypto from "node:crypto";

const SHA256_RE = /^[a-f0-9]{64}$/;

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireFieldNames(value, field) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new Error(`${field} must be an array of field names`);
  }
  return value;
}

function normalizeText(value, { caseFold, collapseWhitespace }) {
  if (value == null) return null;
  let text = String(value).trim();
  if (collapseWhitespace) text = text.replace(/\s+/g, " ");
  if (text === "") return null;
  return caseFold ? text.toLowerCase() : text;
}

function normalizePath(value) {
  if (value == null) return null;
  const file = String(value).trim().replaceAll("\\", "/");
  return file === "" ? null : file;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
    )).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("canonical finding value must be JSON serializable");
  return serialized;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Immutable, normalized field selection shared by finding fingerprints. */
export class CanonicalFindingIdentity {
  constructor(fields, {
    caseFoldedFields = null,
    casePreservingFields = [],
    pathFields = [],
    preserveWhitespaceFields = [],
  } = {}) {
    const source = requireRecord(fields, "canonical finding identity fields");
    const names = Object.keys(source);
    const folded = new Set(requireFieldNames(caseFoldedFields ?? names, "caseFoldedFields"));
    const preserving = new Set(requireFieldNames(casePreservingFields, "casePreservingFields"));
    const paths = new Set(requireFieldNames(pathFields, "pathFields"));
    const preserveWhitespace = new Set(requireFieldNames(preserveWhitespaceFields, "preserveWhitespaceFields"));
    const modes = new Map();

    for (const [mode, selected] of [["case-folded", folded], ["case-preserving", preserving], ["path", paths]]) {
      for (const name of selected) {
        if (!Object.hasOwn(source, name)) throw new Error(`canonical finding identity field is missing: ${name}`);
        if (modes.has(name)) throw new Error(`canonical finding identity field has multiple normalizers: ${name}`);
        modes.set(name, mode);
      }
    }
    for (const name of preserveWhitespace) {
      if (!Object.hasOwn(source, name)) throw new Error(`canonical finding identity field is missing: ${name}`);
      if (modes.get(name) !== "case-preserving") {
        throw new Error(`preserveWhitespaceFields requires a case-preserving field: ${name}`);
      }
    }
    if (modes.size !== names.length) {
      throw new Error("every canonical finding identity field must select a normalizer");
    }

    const normalized = {};
    for (const name of names) {
      if (modes.get(name) === "path") {
        normalized[name] = normalizePath(source[name]);
      } else {
        normalized[name] = normalizeText(source[name], {
          caseFold: modes.get(name) === "case-folded",
          collapseWhitespace: !preserveWhitespace.has(name),
        });
      }
    }
    this.fields = Object.freeze(normalized);
    Object.freeze(this);
  }

  static fromFields(fields, options) {
    return new CanonicalFindingIdentity(fields, options);
  }

  static normalizeCaseFoldedText(value) {
    return normalizeText(value, { caseFold: true, collapseWhitespace: true });
  }

  static normalizeCasePreservingText(value, { collapseWhitespace = true } = {}) {
    return normalizeText(value, { caseFold: false, collapseWhitespace });
  }

  static normalizePath(value) {
    return normalizePath(value);
  }

  hasValue() {
    return Object.values(this.fields).some((value) => value !== null);
  }

  serialize() {
    return canonicalStringify(this.fields);
  }

  equals(other) {
    return other instanceof CanonicalFindingIdentity && this.serialize() === other.serialize();
  }

  toJSON() {
    return { ...this.fields };
  }
}

/** Immutable SHA-256 fingerprint for a canonical finding value. */
export class CanonicalFindingFingerprint {
  constructor(value) {
    const fingerprint = value instanceof CanonicalFindingFingerprint ? value.value : value;
    if (typeof fingerprint !== "string" || !SHA256_RE.test(fingerprint)) {
      throw new Error("finding fingerprint must be a lowercase SHA-256 string");
    }
    this.value = fingerprint;
    Object.freeze(this);
  }

  static fromIdentity(identity) {
    if (!(identity instanceof CanonicalFindingIdentity)) {
      throw new Error("canonical finding fingerprint requires a CanonicalFindingIdentity");
    }
    return new CanonicalFindingFingerprint(digest(identity.serialize()));
  }

  static fromCanonicalValue(value) {
    return new CanonicalFindingFingerprint(digest(canonicalStringify(value)));
  }

  static fromCanonicalTuple(values) {
    if (!Array.isArray(values)) throw new Error("canonical finding value must be an array");
    return CanonicalFindingFingerprint.fromCanonicalValue(values);
  }

  equals(other) {
    return other instanceof CanonicalFindingFingerprint && other.value === this.value;
  }

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }
}
