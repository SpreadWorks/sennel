import { AtomicFile } from "./atomic-file.js";

export class AtomicJsonWriteError extends Error {
  constructor(message, { cause, phase, committedToVisibleName, durabilityUnknown }) {
    super(message, { cause });
    this.name = "AtomicJsonWriteError";
    this.code = durabilityUnknown
      ? "ATOMIC_JSON_DURABILITY_UNCERTAIN"
      : "ATOMIC_JSON_WRITE_FAILED";
    this.phase = phase;
    this.committedToVisibleName = committedToVisibleName;
    this.durabilityUnknown = durabilityUnknown;
    // Retained as a concise compatibility alias for callers deciding whether
    // an idempotent fresh-read retry is required.
    this.committed = committedToVisibleName;
  }
}

export class AtomicJsonFile extends AtomicFile {
  constructor(filePath, { faultInjector = () => {} } = {}) {
    super(filePath, { faultInjector, phaseNamespace: "json" });
  }

  read(fallback) {
    const content = this.readBytes(null);
    return content == null ? structuredClone(fallback) : JSON.parse(content.toString("utf8"));
  }

  readBytes(fallback = null) {
    return super.read(fallback);
  }

  write(value) {
    return super.write(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }

  createWriteError(message, details) {
    return new AtomicJsonWriteError(message.replace(/^file /, "JSON "), details);
  }
}
