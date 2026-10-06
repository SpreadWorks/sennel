/** Pure canonical Review provenance and semantic evidence identities. */
export const MAX_REVIEW_AUTHORED_STRING_CHARS = 4000;

export function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}
export function requireString(value, field, { max = MAX_REVIEW_AUTHORED_STRING_CHARS } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}

export function requireNullableTaskId(value) {
  return value == null ? null : requireString(value, "taskId");
}

export function requireTreeSha(value) {
  const treeSha = requireString(value, "treeSha").toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeSha)) {
    throw new Error("treeSha must be a lowercase SHA-1 or SHA-256 Git object id");
  }
  return treeSha;
}

export function requireSha256(value, field) {
  const digest = requireString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a lowercase SHA-256 string`);
  return digest;
}

export class ReviewProvenance {
  constructor(input = {}) {
    requireObject(input, "review provenance");
    this.provider = requireString(input.provider, "provenance.provider");
    this.invocationId = requireString(input.invocationId, "provenance.invocationId");
    this.capturedAt = requireString(input.capturedAt, "provenance.capturedAt");
    const capturedAtMs = Date.parse(this.capturedAt);
    if (!Number.isFinite(capturedAtMs)) throw new Error("provenance.capturedAt must be an ISO date-time");
    this.capturedAt = new Date(capturedAtMs).toISOString();
    Object.freeze(this);
  }

  toJSON() {
    return {
      provider: this.provider,
      invocationId: this.invocationId,
      capturedAt: this.capturedAt,
    };
  }
}

export class ReviewEvidenceIdentity {
  constructor({ phase, taskId = null, treeSha, provenance, evidenceDigest } = {}) {
    this.phase = requireString(phase, "phase");
    this.taskId = requireNullableTaskId(taskId);
    this.treeSha = requireTreeSha(treeSha);
    this.provenance = provenance instanceof ReviewProvenance
      ? provenance
      : new ReviewProvenance(provenance);
    this.evidenceDigest = requireSha256(evidenceDigest, "evidenceDigest");
    Object.freeze(this);
  }

  get duplicateKey() {
    return [this.phase, this.taskId ?? "", this.treeSha, this.evidenceDigest].join(":");
  }

  toJSON() {
    return {
      phase: this.phase,
      taskId: this.taskId,
      treeSha: this.treeSha,
      provenance: this.provenance.toJSON(),
      evidenceDigest: this.evidenceDigest,
    };
  }
}
