const MAX_APPROVAL_NOTES_LENGTH = 2000;

function requiredIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new Error("canonical Spec approval confirmedAt must be an ISO timestamp");
  }
  return new Date(Date.parse(value)).toISOString();
}

/** Immutable user approval applied to the cataloged Spec authority. */
export class CanonicalSpecApproval {
  constructor({ confirmedAt, notes = null } = {}) {
    this.confirmedAt = requiredIsoTimestamp(confirmedAt);
    if (notes !== null && (typeof notes !== "string" || notes.length > MAX_APPROVAL_NOTES_LENGTH)) {
      throw new Error(`canonical Spec approval notes must be at most ${MAX_APPROVAL_NOTES_LENGTH} characters`);
    }
    this.notes = notes === "" ? null : notes;
    Object.freeze(this);
  }

  apply(spec) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("canonical Spec approval requires a Spec object");
    }
    return Object.freeze({
      ...structuredClone(spec),
      user_approval: {
        approved: true,
        confirmed_at: this.confirmedAt,
        ...(this.notes === null ? {} : { notes: this.notes }),
      },
    });
  }

  toJSON() {
    return {
      approved: true,
      confirmed_at: this.confirmedAt,
      ...(this.notes === null ? {} : { notes: this.notes }),
    };
  }
}

export { MAX_APPROVAL_NOTES_LENGTH };
