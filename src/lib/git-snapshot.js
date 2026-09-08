/** Pure validation helpers for persisted Git snapshot values. */

export const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function isGitObjectId(value) {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

export function isGitSnapshot(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 2
    && typeof value.available === "boolean"
    && (value.available ? isGitObjectId(value.commit) : value.commit === null);
}
