import { QueryError } from "./query-values.js";

/** Capture must hydrate a cataloged input before continuing its pure projection. */
export class QueryDetailArtifactRequired extends Error {
  constructor(descriptor) {
    super(`Query projection requires captured artifact bytes: ${descriptor.relativePath}`);
    this.name = "QueryDetailArtifactRequired";
    this.descriptor = descriptor;
  }
}

/** One read/hydrate boundary shared by detail and execution projections. */
export class QueryArtifactCapture {
  constructor(artifactBytes, readArtifact = null) {
    if (!(artifactBytes instanceof Map)) throw new TypeError("Query artifact capture requires its admitted byte map");
    this.artifactBytes = artifactBytes;
    this.readArtifact = readArtifact;
  }
  read(descriptor) {
    if (!this.artifactBytes.has(descriptor.relativePath)) throw new QueryDetailArtifactRequired(descriptor);
    const bytes = this.artifactBytes.get(descriptor.relativePath);
    if (!Buffer.isBuffer(bytes)) throw new QueryError("CANONICAL_RECORD_UNREADABLE", "/canonical", "Captured artifact bytes are missing", { referenceId: descriptor.relativePath });
    return bytes;
  }
  async hydrate(project) {
    while (true) {
      try { return await project(); }
      catch (error) {
        if (!(error instanceof QueryDetailArtifactRequired)) throw error;
        if (this.artifactBytes.has(error.descriptor.relativePath)) throw new Error("Query hydration repeated a captured input");
        this.artifactBytes.set(error.descriptor.relativePath, await this.readArtifact(error.descriptor));
      }
    }
  }
}
