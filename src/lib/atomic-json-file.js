import { AtomicFile, AtomicFileWriteError } from "./atomic-file.js";

export class AtomicJsonWriteError extends AtomicFileWriteError {
  constructor(message, details) {
    super(message, details);
    this.name = "AtomicJsonWriteError";
    this.code = this.publicationUnknown ? "ATOMIC_JSON_PUBLICATION_UNCERTAIN" : "ATOMIC_JSON_WRITE_FAILED";
  }
}

export class AtomicJsonFile extends AtomicFile {
  constructor(filePath, options = {}) { super(filePath, { ...options, phaseNamespace: "json" }); }
  read(fallback) {
    const content = this.readBytes(null);
    return content === null ? structuredClone(fallback) : JSON.parse(content.toString("utf8"));
  }
  readBytes(fallback = null) { return super.read(fallback); }
  write(value, options = {}) { return super.write(Buffer.from(`${JSON.stringify(value, null, 2)}\n`), options); }
  createWriteError(message, details) { return new AtomicJsonWriteError(message, details); }
}
