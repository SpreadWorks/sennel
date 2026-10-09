/** Exact text and digest invariants shared by Flow values. */
export function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}
export function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}
