function invalidSpecRevisionIdentity(message) {
  const error = new Error(message);
  error.code = "SPEC_REVIEW_ARTIFACT_INVALID";
  error.issues = Object.freeze([message]);
  return error;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSpecRevisionIdentity(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalidSpecRevisionIdentity(`${field} has an invalid schema`);
  }
}

class SpecRevisionNumber {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidSpecRevisionIdentity("spec revision must be a positive safe integer");
    }
    this.value = value;
    Object.freeze(this);
  }

  toJSON() { return this.value; }
  toString() { return String(this.value).padStart(3, "0"); }
}

/** Cycle-free identity of one immutable canonical Spec revision. */
export class SpecRevisionIdentity {
  constructor(value) {
    exactKeys(value, ["specId", "revision", "digest", "byteLength"], "spec revision identity");
    if (typeof value.specId !== "string" || value.specId.trim() === "") {
      throw invalidSpecRevisionIdentity("spec revision identity.specId requires non-empty text");
    }
    this.specId = value.specId.trim();
    this.revision = new SpecRevisionNumber(value.revision);
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) {
      throw invalidSpecRevisionIdentity("spec revision identity requires a SHA-256 digest");
    }
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      throw invalidSpecRevisionIdentity("spec revision identity requires byteLength");
    }
    this.digest = value.digest;
    this.byteLength = value.byteLength;
    Object.freeze(this);
  }

  equals(other) {
    return other instanceof SpecRevisionIdentity
      && this.specId === other.specId
      && this.revision.value === other.revision.value
      && this.digest === other.digest
      && this.byteLength === other.byteLength;
  }

  toJSON() {
    return {
      specId: this.specId,
      revision: this.revision.value,
      digest: this.digest,
      byteLength: this.byteLength,
    };
  }
}
