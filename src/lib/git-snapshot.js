/** Pure validation helpers for persisted Git snapshot values. */

export const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function isGitObjectId(value) {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

export class GitSnapshot {
  constructor(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "available")
      || !Object.hasOwn(value, "commit")
      || typeof value.available !== "boolean"
      || (value.available ? !isGitObjectId(value.commit) : value.commit !== null)) {
      throw new TypeError("Git snapshot must contain a valid availability and object id pair");
    }
    this.available = value.available;
    this.commit = value.commit;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof GitSnapshot ? value : new GitSnapshot(value);
  }

  toJSON() {
    return { available: this.available, commit: this.commit };
  }
}

export function isGitSnapshot(value) {
  try {
    GitSnapshot.from(value);
    return true;
  } catch {
    return false;
  }
}
