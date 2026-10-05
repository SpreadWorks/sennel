import { DraftArtifactRevision } from "./draft-artifact-promotion.js";

const DRAFT_REVIEW_BINDING_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

export class DraftReviewRevisionBinding {
  constructor(input = {}) {
    if (input.version !== DRAFT_REVIEW_BINDING_VERSION) {
      throw new Error(`draft review revision binding version must be ${DRAFT_REVIEW_BINDING_VERSION}`);
    }
    this.version = DRAFT_REVIEW_BINDING_VERSION;
    this.phase = requireString(input.phase, "draft review revision binding phase");
    this.reviewArtifact = requireString(input.reviewArtifact, "draft review revision binding artifact");
    this.reviewArtifactDigest = requireDigest(
      input.reviewArtifactDigest,
      "draft review revision binding artifact digest",
    );
    this.revision = DraftArtifactRevision.from(input.revision);
    this.recordedAt = requireString(input.recordedAt, "draft review revision binding recordedAt");
    if (Number.isNaN(Date.parse(this.recordedAt))) {
      throw new Error("draft review revision binding recordedAt must be an ISO timestamp");
    }
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof DraftReviewRevisionBinding ? value : new DraftReviewRevisionBinding(value);
  }

  assertMatches({ state, route, reviewFile, revision }) {
    if (this.phase !== route.retryPhase || this.reviewArtifact !== route.reviewArtifact) {
      throw new Error("draft review revision binding does not match the review route");
    }
    if (this.reviewArtifactDigest !== reviewFile.digest) {
      throw new Error("draft review artifact bytes do not match the recorded route binding");
    }
    this.revision.assertFlow(state);
    if (!this.revision.matches(revision)) {
      throw new Error("draft review source revision does not match the recorded route revision");
    }
  }

  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      reviewArtifact: this.reviewArtifact,
      reviewArtifactDigest: this.reviewArtifactDigest,
      revision: this.revision.toJSON(),
      recordedAt: this.recordedAt,
    };
  }
}

export function createDraftReviewRevisionBinding(input) {
  return new DraftReviewRevisionBinding({
    version: DRAFT_REVIEW_BINDING_VERSION,
    ...input,
  });
}
