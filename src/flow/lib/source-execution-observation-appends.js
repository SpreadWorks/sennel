import { captureExecutionObservationsFromView, isFlowExecutionObservationArtifact } from "../../lib/flow-execution-observation.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { FlowArtifactCatalog } from "../../lib/flow-version.js";
import path from "node:path";

/** Observation bytes validated while the canonical catalog read view is held. */
export class SourceExecutionObservationCatalog {
  constructor(view) {
    captureExecutionObservationsFromView(view);
    if (!(view.catalog instanceof FlowArtifactCatalog)) throw new TypeError("Execution observation boundary requires its typed catalog");
    this.catalog = view.catalog;
    this.directory = view.location.directory;
    Object.freeze(this);
  }
  relativePath(relativePath, root) {
    const relative = path.relative(root, path.join(this.directory, relativePath)).split(path.sep).join("/");
    if (relative === "" || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      return null;
    }
    return relative;
  }
}

class SourceExecutionObservationAppend {
  constructor(descriptor, relativePath) {
    this.relativePath = relativePath;
    this.catalogRelativePath = descriptor.relativePath;
    this.digest = descriptor.hash;
    Object.freeze(this);
  }
  matches(entries) {
    const entry = entries.get(this.relativePath);
    return entry?.kind === "file" && entry.digest === this.digest;
  }
}

/** Valid immutable additions are independent observations, never worker mutation authority. */
export class SourceExecutionObservationAppends {
  #paths = new Set();
  #catalog;
  constructor(view, baseline) {
    const observation = view instanceof SourceExecutionObservationCatalog ? view : new SourceExecutionObservationCatalog(view);
    this.#catalog = observation.catalog;
    const before = new Set(baseline.entries.map((entry) => entry.path));
    this.appended = Object.freeze(this.#catalog.artifacts.filter((descriptor) => isFlowExecutionObservationArtifact(descriptor.logicalKey)
      && descriptor.logicalKey !== "execution.response.adoption").flatMap((descriptor) => {
      const relativePath = observation.relativePath(descriptor.relativePath, baseline.root);
      return relativePath === null || before.has(relativePath) ? [] : [new SourceExecutionObservationAppend(descriptor, relativePath)];
    }));
    for (const append of this.appended) {
      const segments = append.relativePath.split("/");
      for (let index = 1; index <= segments.length; index++) {
        const entry = segments.slice(0, index).join("/");
        if (!before.has(entry)) this.#paths.add(entry);
      }
    }
    this.catalogPath = observation.relativePath(FLOW_ARTIFACT_CONTRACTS.resolve("artifact.catalog").relativePath, baseline.root);
    Object.freeze(this);
  }
  matches(entries) { return this.appended.every((append) => append.matches(entries)); }
  allowsPath(relativePath) { return this.#paths.has(relativePath); }
  preservesCatalog(previous) {
    if (!(previous instanceof SourceExecutionObservationCatalog)) throw new TypeError("Execution observation append requires its retained catalog boundary");
    return this.preservesCatalogHash(previous.catalog.hash);
  }
  preservesCatalogHash(hash) {
    const added = new Set(this.appended.map((append) => append.catalogRelativePath));
    return FlowArtifactCatalog.regenerate(this.#catalog.artifacts.filter((descriptor) => !added.has(descriptor.relativePath))).hash === hash;
  }
  explainsUnjournaled(changedPaths) {
    return this.appended.length > 0 && changedPaths.every((entry) => entry === this.catalogPath || this.#paths.has(entry));
  }
}
