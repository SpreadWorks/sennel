/** Refusal preserves original producer evidence and grants no repair authority. */
export class ProcessEvidenceMigrationRefusal extends Error {
  constructor(message, descriptor = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = "UNSAFE_SOURCE_FORMAT";
    this.logicalKey = descriptor?.logicalKey ?? null;
    this.relativePath = descriptor?.relativePath ?? null;
  }
}
