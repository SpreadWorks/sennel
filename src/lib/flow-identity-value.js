export function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export function identifier(value, field) {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new Error(`${field} must be an identifier`);
  return result;
}

export class IdentityValue {
  constructor(value, field) { this.value = identifier(value, field); Object.freeze(this); }
  toString() { return this.value; }
  toJSON() { return this.value; }
  equals(other) { return other instanceof this.constructor && other.value === this.value; }
}
