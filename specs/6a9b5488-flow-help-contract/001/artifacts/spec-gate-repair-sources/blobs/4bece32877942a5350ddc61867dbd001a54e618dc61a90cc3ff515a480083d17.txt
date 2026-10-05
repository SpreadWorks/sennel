/**
 * Boundary translation for the stable worker-handoff contract.
 *
 * Workers keep receiving the established logical filenames (`draft.json`,
 * `tests/foo.test.js`, …); those names are part of the agent input contract,
 * not persisted paths.  This module resolves them once to the Version-1
 * catalog contract so neither the dispatcher nor a worker publication guesses
 * a path below the canonical root.
 */

import crypto from "node:crypto";
import path from "node:path";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";

function requiredPath(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${field} must be a normalized relative path`);
  }
  return normalized;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requiredFlowManager(value) {
  if (!value || typeof value.readArtifact !== "function" || typeof value.artifactCatalog !== "function") {
    throw new Error("canonical worker artifact access requires the FlowManager catalog surface");
  }
  return value;
}

function catalogDescriptor(value, address) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("canonical worker artifact catalog descriptor is invalid");
  }
  if (value.logicalKey !== address.logicalKey || (!address.currentSpecReview && value.relativePath !== address.canonicalRelativePath())) {
    throw new Error(`canonical worker artifact catalog identity is invalid: ${address.workerPath}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`canonical worker artifact catalog digest is invalid: ${address.workerPath}`);
  }
  return value;
}

/**
 * Catalog-resolved bytes for one stable worker-visible artifact name.
 *
 * Worker-visible names are parent-materialized aliases for cataloged inputs.
 * Spec review uses `review.json`, the current revision-scoped authority;
 * consumers therefore cannot turn a worker name into an unchecked filesystem
 * read.
 */
export class CanonicalWorkerArtifactInput {
  constructor({ address, descriptor, bytes } = {}) {
    if (!(address instanceof CanonicalWorkerArtifactAddress)) {
      throw new Error("canonical worker input requires an artifact address");
    }
    this.address = address;
    this.descriptor = Object.freeze({ ...catalogDescriptor(descriptor, address) });
    if (!Buffer.isBuffer(bytes)) throw new Error("canonical worker input requires artifact bytes");
    if (bytes.length !== this.descriptor.size) {
      throw new Error(`canonical worker input size does not match its catalog: ${address.workerPath}`);
    }
    this.bytes = Buffer.from(bytes);
    Object.freeze(this);
  }

  get workerPath() { return this.address.workerPath; }

  snapshot() {
    return Object.freeze({ digest: this.descriptor.hash, byteLength: this.descriptor.size });
  }

  /**
   * The catalog retains every review, gate, and execution Attempt in one
   * append-only `attempts[]` document.  A worker protocol filename, however,
   * has always meant that producer's current logical JSON document.  Expose
   * that document here instead of leaking the persistence wrapper into the
   * unchanged handoff/prompt contract.
   */
  currentDocument(label = this.workerPath) {
    if (this.address.contract.contentContract !== null) {
      try {
        return CanonicalCommandAttemptArtifactHistory.fromBytes({
          logicalKey: this.address.logicalKey,
          bytes: this.bytes,
        }).current.payload;
      } catch (error) {
        throw new Error(`${label} canonical Attempt history is invalid: ${error.message}`);
      }
    }
    let document;
    try {
      document = JSON.parse(this.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`${label} must be JSON: ${error.message}`);
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error(`${label} must contain an object`);
    }
    return Object.freeze(structuredClone(document));
  }

  jsonDocument(label = this.workerPath) {
    return this.currentDocument(label);
  }

  text(label = this.workerPath) {
    const value = this.bytes.toString("utf8").trim();
    if (value === "") throw new Error(`${label} must not be empty`);
    return value;
  }
}

/** An immutable catalog-only baseline for worker-owned spec test sources. */
export class CanonicalWorkerTestTreeSnapshot {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new Error("canonical worker test tree snapshot requires entries");
    this.entries = Object.freeze(entries.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("canonical worker test tree snapshot entry is invalid");
      }
      const targetRelativePath = requiredPath(entry.targetRelativePath, "canonical worker test tree target");
      const address = new CanonicalWorkerArtifactAddress(targetRelativePath);
      if (address.logicalKey !== "tests.source") {
        throw new Error("canonical worker test tree snapshot must contain tests/ entries");
      }
      if (!/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
        throw new Error(`canonical worker test tree snapshot digest is invalid: ${targetRelativePath}`);
      }
      return Object.freeze({ targetRelativePath, digest: entry.digest, byteLength: entry.byteLength });
    }).sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath)));
    if (new Set(this.entries.map((entry) => entry.targetRelativePath)).size !== this.entries.length) {
      throw new Error("canonical worker test tree snapshot must not duplicate a test source");
    }
    Object.freeze(this);
  }
}

/** A typed address for one handoff-visible name and its canonical catalog key. */
export class CanonicalWorkerArtifactAddress {
  constructor(workerPath) {
    this.workerPath = requiredPath(workerPath, "worker artifact path");
    if (this.workerPath === "review.json") {
      this.logicalKey = "spec.review";
      this.parameters = Object.freeze({});
      this.contract = FLOW_ARTIFACT_CONTRACTS.require(this.logicalKey);
      this.artifact = null;
      this.currentSpecReview = true;
      Object.freeze(this);
      return;
    }
    if (this.workerPath.startsWith("tests/")) {
      this.logicalKey = "tests.source";
      this.parameters = Object.freeze({ testPath: this.workerPath.slice("tests/".length) });
      this.artifact = FLOW_ARTIFACT_CONTRACTS.resolve(this.logicalKey, this.parameters);
      this.contract = this.artifact.contract;
      this.currentSpecReview = false;
      Object.freeze(this);
      return;
    }
    const target = FLOW_ARTIFACT_CONTRACTS.switchTargets.find((candidate) => (
      candidate.action === "switch" && candidate.matchesLegacyPath(this.workerPath)
    ));
    if (!target) throw new Error(`worker artifact name has no canonical contract: ${this.workerPath}`);
    this.logicalKey = target.logicalKey;
    this.parameters = Object.freeze({});
    this.artifact = FLOW_ARTIFACT_CONTRACTS.resolve(this.logicalKey);
    this.contract = this.artifact.contract;
    this.currentSpecReview = false;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalWorkerArtifactAddress
      ? value
      : new CanonicalWorkerArtifactAddress(value);
  }

  /** Location-relative path used only to read an already cataloged input. */
  canonicalRelativePath() {
    if (this.currentSpecReview) throw new Error("current Spec review has no static canonical path");
    return this.artifact.relativePath;
  }

  /**
   * Resolve this stable protocol name through the V1 catalog and authorized
   * FlowManager reader.  The caller supplies the actual consuming Step;
   * ownership is checked by the Store rather than inferred from a path.
   */
  read({ flowManager, specId, consumerNodeId, optional = false } = {}) {
    const manager = requiredFlowManager(flowManager);
    if (this.currentSpecReview) {
      try {
        const resolved = manager.readCurrentSpecReview({
          specId: requiredText(specId, "canonical worker artifact specId"),
          consumerNodeId: requiredText(consumerNodeId, "canonical worker artifact consumer nodeId"),
        });
        return new CanonicalWorkerArtifactInput({ address: this, descriptor: resolved.descriptor, bytes: resolved.bytes });
      } catch (cause) {
        if (optional && /review is absent/.test(cause.message)) return null;
        throw cause;
      }
    }
    const resolved = manager.readArtifact({
      specId: requiredText(specId, "canonical worker artifact specId"),
      logicalKey: this.logicalKey,
      parameters: this.parameters,
      consumerNodeId: requiredText(consumerNodeId, "canonical worker artifact consumer nodeId"),
      optional,
    });
    if (resolved === null) return null;
    return new CanonicalWorkerArtifactInput({
      address: this,
      descriptor: resolved.descriptor,
      bytes: resolved.bytes,
    });
  }

  /** Read a producer baseline from catalog metadata without opening a path. */
  catalogSnapshot({ flowManager, specId } = {}) {
    const manager = requiredFlowManager(flowManager);
    if (this.currentSpecReview) {
      if (typeof manager.readCurrentSpecReview !== "function") {
        throw new Error("canonical worker artifact current review requires the FlowManager revision authority reader");
      }
      const current = manager.readCurrentSpecReview({
        specId: requiredText(specId, "canonical worker artifact specId"),
        consumerNodeId: "spec-review",
      });
      const normalized = catalogDescriptor(current.descriptor, this);
      return Object.freeze({ digest: normalized.hash, byteLength: normalized.size });
    }
    const catalog = manager.artifactCatalog(requiredText(specId, "canonical worker artifact specId"));
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === this.canonicalRelativePath()) ?? null;
    if (descriptor === null) return null;
    const normalized = catalogDescriptor(descriptor, this);
    return Object.freeze({ digest: normalized.hash, byteLength: normalized.size });
  }

  /** Plain input accepted by CanonicalFlowArtifactWrite at the Store boundary. */
  publication(bytes, mediaType = "application/json") {
    return Object.freeze({
      logicalKey: this.logicalKey,
      parameters: this.parameters,
      mediaType,
      bytes,
    });
  }
}

/** A Version-1 catalog resolver for a complete worker-supplied test tree. */
export class CanonicalWorkerTestTree {
  constructor(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("worker test tree requires at least one entry");
    }
    this.entries = Object.freeze(entries.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("worker test tree entry must be an object");
      }
      const address = new CanonicalWorkerArtifactAddress(entry.targetRelativePath);
      if (address.logicalKey !== "tests.source") {
        throw new Error("worker test tree entry must be below tests/");
      }
      return Object.freeze({ address, bytes: entry.bytes, mediaType: entry.mediaType ?? mediaTypeForPath(address.workerPath) });
    }));
    Object.freeze(this);
  }

  publications() {
    return this.entries.map(({ address, bytes, mediaType }) => address.publication(bytes, mediaType));
  }

  /**
   * Build one Store-owned replacement of the worker test collection.  The
   * catalog snapshot, not a guessed `artifacts/tests` directory, decides
   * which prior worker sources must be removed.  Command-owned runtime logs
   * are non-cataloged and are therefore deliberately outside this operation.
   */
  replacement(baseline = new CanonicalWorkerTestTreeSnapshot()) {
    if (!(baseline instanceof CanonicalWorkerTestTreeSnapshot)) {
      throw new Error("canonical worker test replacement requires a catalog snapshot baseline");
    }
    const desired = new Set(this.entries.map(({ address }) => address.workerPath));
    const artifactRemovals = baseline.entries
      .filter((entry) => !desired.has(entry.targetRelativePath))
      .map((entry) => {
        const address = new CanonicalWorkerArtifactAddress(entry.targetRelativePath);
        return Object.freeze({ logicalKey: address.logicalKey, parameters: address.parameters });
      });
    return Object.freeze({
      artifactWrites: Object.freeze(this.publications()),
      artifactRemovals: Object.freeze(artifactRemovals),
      // This is Store-only CAS data, not another worker payload. The
      // Version Store compares it with the catalog under its publication
      // lock before replacing the collection.
      testSourceBaseline: Object.freeze(baseline.entries.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  /**
   * Parent-owned composition for a bounded repair payload.  The worker sees
   * only allowed files; this method reconstructs the complete canonical tree
   * from the immutable catalog snapshot and rejects every omission or escape.
   */
  repairComposition({ baseline, allowedTestPaths, canonicalEntries }) {
    if (!(baseline instanceof CanonicalWorkerTestTreeSnapshot) || !Array.isArray(allowedTestPaths) || allowedTestPaths.length === 0 || !Array.isArray(canonicalEntries)) {
      throw new Error("bounded repair composition requires a snapshot and allowed test paths");
    }
    const allowed = new Set(allowedTestPaths.map((entry) => `tests/${requiredPath(entry, "bounded repair allowed test path")}`));
    const submitted = new Map(this.entries.map((entry) => [entry.address.workerPath, entry]));
    if ([...submitted].some(([workerPath]) => !allowed.has(workerPath))) {
      throw new Error("bounded repair output changed a test path outside its capability");
    }
    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.targetRelativePath, entry]));
    for (const workerPath of allowed) {
      if (!submitted.has(workerPath)) throw new Error(`bounded repair omitted allowed test path: ${workerPath}`);
    }
    const canonicalByPath = new Map(canonicalEntries.map((entry) => [`tests/${requiredPath(entry.testPath, "bounded repair canonical test path")}`, entry]));
    const full = new Map();
    for (const entry of baseline.entries) {
      const submittedEntry = submitted.get(entry.targetRelativePath);
      if (submittedEntry) full.set(entry.targetRelativePath, submittedEntry);
      else {
        const address = new CanonicalWorkerArtifactAddress(entry.targetRelativePath);
        const canonical = canonicalByPath.get(entry.targetRelativePath);
        if (!canonical || !Buffer.isBuffer(canonical.bytes)) throw new Error(`bounded repair lacks canonical bytes for ${entry.targetRelativePath}`);
        if (crypto.createHash("sha256").update(canonical.bytes).digest("hex") !== entry.digest) {
          throw new Error(`bounded repair canonical snapshot changed while composing ${entry.targetRelativePath}`);
        }
        full.set(entry.targetRelativePath, { address, bytes: canonical.bytes, mediaType: mediaTypeForPath(entry.targetRelativePath), baseline: entry });
      }
    }
    for (const [workerPath, entry] of submitted) if (!baselineByPath.has(workerPath)) full.set(workerPath, entry);
    const changedPaths = [];
    for (const [workerPath, entry] of full) {
      const before = baselineByPath.get(workerPath) ?? null;
      const afterDigest = crypto.createHash("sha256").update(entry.bytes).digest("hex");
      if (before === null || before.digest !== afterDigest) changedPaths.push(Object.freeze({
        path: workerPath.slice("tests/".length), beforeDigest: before?.digest ?? null, afterDigest,
      }));
    }
    if (changedPaths.length === 0) throw new Error("bounded repair did not change the canonical test tree");
    return Object.freeze({
      artifactWrites: Object.freeze([...full.values()].map((entry) => entry.address.publication(entry.bytes, entry.mediaType))),
      artifactRemovals: Object.freeze([]),
      // Full-tree CAS remains parent-owned even though only the selected
      // bounded subset was materialized in the worker payload.
      testSourceBaseline: Object.freeze(baseline.entries.map((entry) => Object.freeze({ ...entry }))),
      changedPaths: Object.freeze(changedPaths.sort((left, right) => left.path.localeCompare(right.path))),
    });
  }

  /** Resolve the current worker-owned test collection from catalog metadata. */
  static catalogSnapshot({ flowManager, specId } = {}) {
    const manager = requiredFlowManager(flowManager);
    const catalog = manager.artifactCatalog(requiredText(specId, "canonical worker test tree specId"));
    return new CanonicalWorkerTestTreeSnapshot(catalog.artifacts
      .filter((descriptor) => descriptor.logicalKey === "tests.source")
      .map((descriptor) => {
        const prefix = "artifacts/tests/";
        if (!descriptor.relativePath.startsWith(prefix)) {
          throw new Error("canonical worker test catalog path is invalid");
        }
        return {
          targetRelativePath: `tests/${descriptor.relativePath.slice(prefix.length)}`,
          digest: descriptor.hash,
          byteLength: descriptor.size,
        };
      }));
  }

  /**
   * The destination root used only by the static-import bootstrap validator.
   * It is derived from the typed test-source contract and the Version Store's
   * resolved location, never from a Spec root or a worker protocol path.
   */
  static artifactRoot({ flowManager, specId } = {}) {
    const manager = requiredFlowManager(flowManager);
    if (typeof manager.specLocation !== "function") {
      throw new Error("canonical worker test artifact root requires the FlowManager Version location surface");
    }
    const location = manager.specLocation(requiredText(specId, "canonical worker test artifact root specId"));
    if (!location || typeof location.resolve !== "function") {
      throw new Error("canonical worker test artifact root requires a resolved Version location");
    }
    const probe = new CanonicalWorkerArtifactAddress("tests/__canonical_probe__").canonicalRelativePath();
    return location.resolve(path.posix.dirname(path.posix.dirname(probe)));
  }
}

/**
 * The execution-facing location of a worker-owned spec test tree.
 *
 * The worker protocol calls this tree `tests`, while the Version Store
 * publishes it below the Spec's canonical artifact root.  Keep that
 * distinction in one typed value so prompt generation does not infer the
 * final import base from a transient handoff directory.
 */
export class CanonicalSpecTestTopology {
  constructor({ repositoryRoot, canonicalTestRoot } = {}) {
    if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
      throw new Error("canonical spec test topology requires an absolute repository root");
    }
    if (typeof canonicalTestRoot !== "string" || !path.isAbsolute(canonicalTestRoot)) {
      throw new Error("canonical spec test topology requires an absolute canonical test root");
    }
    this.repositoryRoot = path.resolve(repositoryRoot);
    const relativeTestRoot = path.relative(this.repositoryRoot, path.resolve(canonicalTestRoot));
    if (
      relativeTestRoot === ""
      || path.isAbsolute(relativeTestRoot)
      || relativeTestRoot === ".."
      || relativeTestRoot.startsWith(`..${path.sep}`)
    ) {
      throw new Error("canonical spec test root must be contained by its repository root");
    }
    this.canonicalTestRoot = relativeTestRoot.split(path.sep).join("/");
    Object.freeze(this);
  }

  static fromWorkerTestTree({ flowManager, specId, repositoryRoot } = {}) {
    return new CanonicalSpecTestTopology({
      repositoryRoot,
      canonicalTestRoot: path.join(
        CanonicalWorkerTestTree.artifactRoot({ flowManager, specId }),
        "tests",
      ),
    });
  }

  static fromJSON(value, { repositoryRoot } = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("canonical spec test topology descriptor must be an object");
    }
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["canonicalTestRoot", "staticRelativeImportBase"])) {
      throw new Error("canonical spec test topology descriptor has invalid fields");
    }
    if (value.staticRelativeImportBase !== "each canonical test file") {
      throw new Error("canonical spec test topology descriptor has an invalid import base");
    }
    const relativeRoot = requiredPath(value.canonicalTestRoot, "canonical spec test topology root");
    const root = requiredText(repositoryRoot, "canonical spec test topology repository root");
    if (!path.isAbsolute(root)) {
      throw new Error("canonical spec test topology repository root must be absolute");
    }
    return new CanonicalSpecTestTopology({
      repositoryRoot: root,
      canonicalTestRoot: path.resolve(root, ...relativeRoot.split("/")),
    });
  }

  sourcePath(relativeTestPath) {
    return path.posix.join(
      this.canonicalTestRoot,
      requiredPath(relativeTestPath, "canonical spec test relative path"),
    );
  }

  toJSON() {
    return {
      canonicalTestRoot: this.canonicalTestRoot,
      staticRelativeImportBase: "each canonical test file",
    };
  }
}

export function mediaTypeForPath(relativePath) {
  const target = requiredPath(relativePath, "worker artifact media path");
  if (target.endsWith(".json")) return "application/json";
  if (target.endsWith(".md")) return "text/markdown";
  if (target.endsWith(".js") || target.endsWith(".mjs")) return "text/javascript";
  if (target.endsWith(".sh")) return "text/x-shellscript";
  return "text/plain";
}
