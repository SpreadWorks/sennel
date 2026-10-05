const ARTIFACT_AUTHORITIES = new Set([
  "canonical-flow-artifacts", "execution-checkout", "dispatcher-handoff",
  "repository-metadata", "user-decision",
]);
const ARTIFACT_CARDINALITIES = new Set(["singleton", "collection"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requiredIdentifier(value, field) {
  const result = requiredText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new Error(`${field} must be an identifier`);
  return result;
}

export class ArtifactAuthority {
  constructor(value) {
    this.value = requiredText(value, "artifact authority");
    if (!ARTIFACT_AUTHORITIES.has(this.value)) throw new Error(`invalid artifact authority: ${this.value}`);
    Object.freeze(this);
  }
  static from(value) { return value instanceof ArtifactAuthority ? value : new ArtifactAuthority(value); }
  toString() { return this.value; }
  toJSON() { return this.value; }
}

export class ArtifactCardinality {
  constructor(value) {
    this.value = requiredText(value, "artifact cardinality");
    if (!ARTIFACT_CARDINALITIES.has(this.value)) throw new Error(`invalid artifact cardinality: ${this.value}`);
    Object.freeze(this);
  }
  static singleton() { return new ArtifactCardinality("singleton"); }
  static collection() { return new ArtifactCardinality("collection"); }
  static from(value) { return value instanceof ArtifactCardinality ? value : new ArtifactCardinality(value); }
  toString() { return this.value; }
  toJSON() { return this.value; }
}

export class ArtifactAuthoritySlot {
  constructor({ kind, authority, cardinality, memberId = null, publicationStep } = {}) {
    this.kind = requiredIdentifier(kind, "artifact kind");
    this.authority = ArtifactAuthority.from(authority);
    this.cardinality = ArtifactCardinality.from(cardinality);
    this.memberId = memberId == null ? null : requiredIdentifier(memberId, "artifact memberId");
    this.publicationStep = publicationStep === "system"
      ? "system"
      : requiredIdentifier(publicationStep, "artifact publicationStep");
    if (this.cardinality.value === "singleton" && this.memberId !== null) {
      throw new Error("singleton artifact authority slot must not have a memberId");
    }
    if (this.cardinality.value === "collection" && this.memberId === null) {
      throw new Error("collection artifact authority slot requires a memberId");
    }
    Object.freeze(this);
  }
  static singleton({ kind, authority, publicationStep = "system" } = {}) {
    return new ArtifactAuthoritySlot({ kind, authority, cardinality: ArtifactCardinality.singleton(), publicationStep });
  }
  static collectionMember({ kind, authority, memberId, publicationStep } = {}) {
    return new ArtifactAuthoritySlot({ kind, authority, cardinality: ArtifactCardinality.collection(), memberId, publicationStep });
  }
  claimKey() { return `${this.kind}\0${this.authority}\0${this.cardinality}\0${this.memberId ?? ""}`; }
  toJSON() {
    return {
      authority: this.authority.toJSON(), cardinality: this.cardinality.toJSON(),
      memberId: this.memberId, publicationStep: this.publicationStep,
    };
  }
}
