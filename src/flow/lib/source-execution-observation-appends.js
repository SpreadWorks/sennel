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
  matches(entries, mode) {
    const entry = entries.get(this.relativePath);
    // A Git difference snapshot omits ignored and clean tracked files. This
    // append already has exact bytes authenticated by its current catalog view.
    if (entry === undefined) return mode === "git";
    return entry.kind === "file" && entry.digest === this.digest;
  }
}

/** Actual prior catalog boundary; it does not fabricate a filesystem snapshot. */
export class SourceExecutionObservationCatalogBaseline {
  constructor({ catalog, root }) {
    if (!(catalog instanceof FlowArtifactCatalog)) throw new TypeError("Execution observation baseline requires its typed prior catalog");
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError("Execution observation baseline requires an absolute repository root");
    this.catalog = catalog;
    this.root = root;
    Object.freeze(this);
  }
}

/** Valid immutable additions are independent observations, never worker mutation authority. */
export class SourceExecutionObservationAppends {
  #paths = new Set();
  #catalog;
  constructor(view, baseline) {
    const observation = view instanceof SourceExecutionObservationCatalog ? view : new SourceExecutionObservationCatalog(view);
    this.#catalog = observation.catalog;
    this.root = baseline.root;
    const before = new Set(baseline instanceof SourceExecutionObservationCatalogBaseline
      ? baseline.catalog.artifacts.map((descriptor) => observation.relativePath(descriptor.relativePath, baseline.root))
        .filter((relativePath) => relativePath !== null)
      : baseline.entries.map((entry) => entry.path));
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
  matches(snapshot) {
    if (snapshot.root !== this.root) return false;
    const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    return this.appended.every((append) => append.matches(entries, snapshot.mode));
  }
  allowsPath(relativePath) { return this.#paths.has(relativePath); }
  allowsFilePath(relativePath) { return this.appended.some((append) => append.relativePath === relativePath); }
  retainedCatalog(expectedCatalog = this.#catalog) {
    if (expectedCatalog !== this.#catalog) throw new TypeError("Execution observation appends belong to another catalog view");
    const added = new Set(this.appended.map((append) => append.catalogRelativePath));
    return FlowArtifactCatalog.regenerate(this.#catalog.artifacts.filter((descriptor) => !added.has(descriptor.relativePath)));
  }
  preservesCatalog(previous) {
    if (!(previous instanceof SourceExecutionObservationCatalog)) throw new TypeError("Execution observation append requires its retained catalog boundary");
    return this.preservesCatalogHash(previous.catalog.hash);
  }
  preservesCatalogHash(hash) {
    return this.retainedCatalog().hash === hash;
  }
  explainsUnjournaled(changedPaths) {
    return this.appended.length > 0 && changedPaths.every((entry) => entry === this.catalogPath || this.#paths.has(entry));
  }
}
