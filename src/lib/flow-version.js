import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { AtomicFile } from "./atomic-file.js";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { ProcessLock } from "./process-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { ArtifactAuthority, ArtifactAuthoritySlot, ArtifactCardinality } from "./artifact-authority.js";
import {
  ArtifactPublicationClaim,
  requiresWorkerSourceHandoff,
} from "../flow/lib/flow-artifact-authority.js";
import {
  FLOW_ARTIFACT_CONTRACTS,
  FlowArtifactActivityEvidence,
  FlowArtifactReviewEvidence,
  FlowArtifactUpdater,
} from "./flow-artifact-contract.js";

export { ArtifactAuthority, ArtifactAuthoritySlot, ArtifactCardinality } from "./artifact-authority.js";
export { ArtifactPublicationClaim } from "../flow/lib/flow-artifact-authority.js";

const CATALOG_SCHEMA_REVISION = 2;
const MIGRATION_CLASSIFICATIONS = new Set(["fresh", "legacy", "versioned", "conflict"]);
const MIGRATION_OPERATIONS = new Set(["copy", "transform", "generate", "exclude-runtime"]);
const MIGRATION_ARTIFACT_ROLES = new Set([
  "flow-state", "activity-ledger", "spec-record", "issue-log",
  "review-evidence", "artifact", "runtime",
]);
const VERSION_AUTHORITY_SCOPES = new Set(["canonical", "execution"]);
const TASK_ARTIFACT_SEGMENTS = new Set(["impl", "review", "triage", "repair", "gate"]);
const TASK_ARTIFACT_SEGMENT_BY_LOGICAL_KEY = new Map([
  ["task.review", "review"],
  ["task.triage", "triage"],
  ["task.repair", "repair"],
  ["task.gate.source", "gate"],
  ["task.gate", "gate"],
]);
// Transient implementation state is allowed only below `.runtime/`.  Keeping
// this empty deliberately makes a root-level lock or transaction marker an
// invalid Version artifact instead of silently accepting a second layout.
const VERSION_TRANSIENT_FILES = new Set();
const STEP_OWNED_ARTIFACT_KINDS = new Set(["review-evidence"]);
const SOURCE_COMPLETION_OPERATIONS = new Set([
  "confirm_attempt",
  "repair_implementation",
  "triage_implementation_for_repair",
  "triage_implementation_no_repair",
]);
// Every typed Task transition updates the single state authority and appends
// its Activity.  Those flow-wide records are intentionally associated with
// the Task Activity for journal ordering, but are not Task-owned deliverables.
// `issue.log` has the same ledger-wide ownership rule for task-gate facts.
// A typed task-impl overview contribution likewise updates the one root Spec
// record, rather than creating a task-local deliverable.
const FLOW_WIDE_TASK_ACTIVITY_ARTIFACTS = new Set([
  "flow.state",
  "flow.activities",
  "spec.record",
  // A task-owned Spec contribution publishes a new immutable global
  // revision. Snapshots and their canonical review ledger are revision-wide,
  // not task-local implementation deliverables.
  "spec.snapshot",
  "spec.review",
  "issue.log",
  // Task Review can defer semantic findings to the one flow-wide acceptance
  // handoff without manufacturing a task-local copy.
  "flow.findings",
  // Task implementation contributes the flow-wide requirement map.  Its
  // bytes intentionally remain at the implementation owner path so every
  // later task and the flow-level gate resolve one authoritative catalog key.
  "file.map",
]);
const RETRY_RECOVERY_TASK_ARTIFACTS = new Set([
  "retry.recovery.baseline",
  "retry.recovery.receipt",
]);
const SOURCE_HANDOFF_TASK_ARTIFACTS = new Set([
  "source.handoff.rollback-blob",
  "source.handoff.checkpoint",
  "source.handoff.event",
  "source.handoff.settlement",
]);
const MIGRATION_CATALOG_INITIALIZATION = Symbol("migration-catalog-initialization");
const CATALOG_LOCK_RETRY_INTERVAL_MS = 250;
const CATALOG_LOCK_WAIT_TIMEOUT_MS = 10_000;
const ACTIVE_VERSION_TRANSACTIONS = new Set();
const FLOW_STATE_RELATIVE_PATH = FLOW_ARTIFACT_CONTRACTS.resolve("flow.state").relativePath;
const FLOW_ACTIVITIES_RELATIVE_PATH = FLOW_ARTIFACT_CONTRACTS.resolve("flow.activities").relativePath;
const SPEC_RECORD_RELATIVE_PATH = FLOW_ARTIFACT_CONTRACTS.resolve("spec.record").relativePath;
const ARTIFACT_CATALOG_RELATIVE_PATH = FLOW_ARTIFACT_CONTRACTS.resolve("artifact.catalog").relativePath;
const CATALOG_SERIALIZED_FIELDS = new Set(["schemaRevision", "artifacts", "hash"]);
const CATALOG_DESCRIPTOR_SERIALIZED_FIELDS = new Set([
  "logicalKey", "kind", "relativePath", "hash", "size", "mediaType", "authority",
  "cardinality", "memberId", "publicationStep", "retention", "activityId",
  "migrationMaterialization",
]);
const DEFAULT_CATALOG_SNAPSHOT_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxCatalogBytes: 16 * 1024 * 1024,
  maxArtifacts: 10_000,
  maxManagedEntries: 10_000,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxConfirmedLedgerBytes: 32 * 1024 * 1024,
  maxTotalArtifactBytes: 64 * 1024 * 1024,
});

function artifactCatalogLockError(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  if (status === "live" || status === "timeout") {
    error.name = "FlowArtifactCatalogBusyError";
    error.code = "FLOW_ARTIFACT_CATALOG_BUSY";
  } else {
    error.name = "ProcessLockError";
    error.code = `PROCESS_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  }
  error.lockPath = lockPath;
  return error;
}

/** Typed path/Task relation for the route-scoped retry artifacts. */
class TaskRetryRecoveryArtifactOwner {
  constructor({ logicalKey, relativePath } = {}) {
    if (!RETRY_RECOVERY_TASK_ARTIFACTS.has(logicalKey)) {
      throw new Error("task retry recovery owner requires a retry recovery artifact");
    }
    const directory = logicalKey === "retry.recovery.baseline" ? "baselines" : "receipts";
    const match = relativePath.match(new RegExp(`^artifacts/retry-recovery/${directory}/([^/]+)/([^/]+)\\.json$`));
    if (match === null) throw new Error(`task retry recovery artifact path is invalid: ${relativePath}`);
    this.routeId = match[1];
    this.attemptId = match[2];
    Object.freeze(this);
  }

  assertActivityNode(nodeId) {
    const taskStep = nodeId.match(/^(.+)-(review|gate)$/);
    if (taskStep === null) throw new Error("task retry recovery artifact requires a Task review or gate Activity");
    const [, taskId, role] = taskStep;
    const expectedRouteId = role === "review"
      ? `review-impl-${taskId}`
      : `gate-task-impl-${taskId}`;
    if (this.routeId !== expectedRouteId) {
      throw new Error("task retry recovery artifact route does not match its related Activity Task");
    }
    return this;
  }
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function identifier(value, field) {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new Error(`${field} must be an identifier`);
  return result;
}

function relativePath(value, field) {
  const result = text(value, field);
  if (result.includes("\\") || path.posix.isAbsolute(result) || path.posix.normalize(result) !== result) {
    throw new Error(`${field} must be a normalized POSIX relative path`);
  }
  if (result.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must not contain empty, current, or parent segments`);
  }
  return result;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function codeUnitOrder(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function assertFilesystemAuthority(repositoryRoot, target, { mustExist = false } = {}) {
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Version authority path escapes the repository root");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Version repository root must be a real directory");
  }
  let current = root;
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === "ENOENT" && !mustExist) return;
      if (error.code === "ENOENT") throw new Error(`Version authority path does not exist: ${relative}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Version authority path contains a symbolic link: ${relative}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Version authority ancestor is not a directory: ${relative}`);
    }
  }
}

function beforeImage(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`publication authority is not a real regular file: ${file}`);
    return Object.freeze({ file, exists: true, bytes: fs.readFileSync(file), mode: stat.mode & 0o777 });
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze({ file, exists: false, bytes: null, mode: null });
    throw error;
  }
}

function restoreBeforeImage(image) {
  const directory = path.dirname(image.file);
  if (image.exists) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(image.file, image.bytes, { mode: image.mode });
    fs.chmodSync(image.file, image.mode);
    const descriptor = fs.openSync(image.file, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } else {
    try { fs.unlinkSync(image.file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  fsyncDirectory(directory);
}

function catalogManagedPath(value) {
  if (value === "flow-migration-report.json" || value.startsWith("artifacts/migration/")) return true; // migration materialization namespace only
  try { return FLOW_ARTIFACT_CONTRACTS.classify(value).cataloged; } catch { return false; }
}

function knownNoncatalogedPath(value) {
  try { return FLOW_ARTIFACT_CONTRACTS.classify(value).cataloged === false; } catch { return false; }
}

function managedFiles(location, {
  current = location.directory,
  result = [],
  scan = { count: 0 },
  maxEntries = Infinity,
} = {}) {
  location.assertAuthority(null, { mustExist: true });
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    scan.count += 1;
    if (scan.count > maxEntries) throw new Error("Version storage entry count exceeds the managed artifact limit");
    const absolute = path.join(current, entry.name);
    const rel = path.relative(location.directory, absolute).split(path.sep).join("/");
    // `.runtime/` is the sole explicitly transient subtree. Its contents
    // include locks and untrusted worker handoff work units, so catalog
    // verification must neither classify nor recursively inspect them. The
    // root itself remains a real directory authority; a symlink there would
    // still escape the Version and is rejected.
    if (rel === ".runtime") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Version runtime authority must be a real directory");
      }
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Version storage must not contain symbolic links: ${rel}`);
    if (entry.isDirectory()) {
      managedFiles(location, { current: absolute, result, scan, maxEntries });
      continue;
    }
    if (!entry.isFile()) throw new Error(`Version storage contains an unsupported entry: ${rel}`);
    const stat = fs.lstatSync(absolute);
    if (stat.nlink !== 1) throw new Error(`Version storage artifact must not be hard linked: ${rel}`);
    if (rel === ARTIFACT_CATALOG_RELATIVE_PATH || VERSION_TRANSIENT_FILES.has(rel) || knownNoncatalogedPath(rel)) continue;
    if (!catalogManagedPath(rel)) throw new Error(`Version storage contains an unclassified artifact: ${rel}`);
    result.push(rel);
  }
  return result.sort(codeUnitOrder);
}

function requireBoundedLimit(value, field, { minimum = 0, allowInfinity = true } = {}) {
  if (value === Infinity && allowInfinity) return value;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

async function readBoundedRealFile(location, file, maxBytes) {
  const safePath = relativePath(file, "Version snapshot artifact path");
  const target = location.resolve(safePath);
  location.assertAuthority(safePath, { mustExist: true });
  let handle;
  try {
    handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || await fs.promises.realpath(target) !== target) {
      throw new Error(`Version snapshot artifact is not a single-link real regular file: ${safePath}`);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      throw new Error(`Version snapshot artifact exceeds the bounded size: ${safePath}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`Version snapshot artifact exceeds the bounded size: ${safePath}`);
    return bytes;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

class VersionTreeSnapshot {
  constructor(location, { directories = null, files = null } = {}) {
    this.location = location;
    if ((directories === null) !== (files === null)) throw new Error("Version tree snapshot image must be complete");
    this.directories = directories === null ? new Set([""]) : new Set(directories);
    this.files = files === null ? new Map() : new Map(files);
    if (directories === null) this.#capture(location.directory);
  }
  #capture(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(this.location.directory, absolute).split(path.sep).join("/");
      if (relative === ".runtime") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("Version runtime authority must be a real directory");
        }
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Version storage must not contain symbolic links: ${relative}`);
      if (VERSION_TRANSIENT_FILES.has(relative) || knownNoncatalogedPath(relative)) continue;
      if (entry.isDirectory()) {
        this.directories.add(relative);
        this.#capture(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Version storage contains an unsupported entry: ${relative}`);
      const stat = fs.lstatSync(absolute);
      if (stat.nlink !== 1) throw new Error(`Version storage artifact must not be hard linked: ${relative}`);
      this.files.set(relative, Object.freeze({ bytes: fs.readFileSync(absolute), mode: stat.mode & 0o777 }));
    }
  }
  assertOnlyDeclaredChanges(paths) {
    const current = new VersionTreeSnapshot(this.location);
    const allPaths = new Set([...this.files.keys(), ...current.files.keys()]);
    for (const file of allPaths) {
      if (paths.has(file)) continue;
      const before = this.files.get(file);
      const after = current.files.get(file);
      if (!before || !after || before.mode !== after.mode || !before.bytes.equals(after.bytes)) {
        throw new Error(`catalog publication changed an undeclared Version artifact: ${file}`);
      }
    }
  }
  restore() {
    const files = [];
    const directories = [];
    const collect = (directory) => {
      let containsTransientEntry = false;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(this.location.directory, absolute).split(path.sep).join("/");
        if (
          relative === ".runtime"
          || VERSION_TRANSIENT_FILES.has(relative)
          || knownNoncatalogedPath(relative)
        ) {
          containsTransientEntry = true;
          continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (collect(absolute)) containsTransientEntry = true;
          else directories.push(absolute);
        } else {
          files.push(absolute);
        }
      }
      return containsTransientEntry;
    };
    collect(this.location.directory);
    for (const file of files) fs.unlinkSync(file);
    for (const directory of directories.sort((left, right) => right.length - left.length)) fs.rmdirSync(directory);
    for (const directory of [...this.directories].filter(Boolean).sort(codeUnitOrder)) {
      fs.mkdirSync(this.location.resolve(directory), { recursive: true, mode: 0o755 });
    }
    for (const [file, image] of this.files) {
      const absolute = this.location.resolve(file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o755 });
      fs.writeFileSync(absolute, image.bytes, { mode: image.mode });
      fs.chmodSync(absolute, image.mode);
      const descriptor = fs.openSync(absolute, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    fsyncDirectory(this.location.directory);
  }
  toJSON() {
    return {
      directories: [...this.directories].sort(codeUnitOrder),
      files: [...this.files].sort(([left], [right]) => codeUnitOrder(left, right)).map(([file, image]) => ({
        path: file, mode: image.mode, bytes: image.bytes.toString("base64"),
      })),
    };
  }
  static fromStored(location, value) {
    if (value === null || typeof value !== "object" || !Array.isArray(value.directories) || !Array.isArray(value.files)) {
      throw new Error("Version transaction snapshot is invalid");
    }
    if (Object.keys(value).sort().join(",") !== "directories,files") throw new Error("Version transaction snapshot fields are invalid");
    const directories = new Set(value.directories.map((entry) => {
      const directory = entry === "" ? "" : relativePath(entry, "Version transaction directory");
      if (directory === ".runtime" || directory.startsWith(".runtime/")) throw new Error("Version transaction directory is runtime-owned");
      return directory;
    }));
    const files = new Map(value.files.map((entry) => {
      if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "bytes,mode,path") {
        throw new Error("Version transaction file image fields are invalid");
      }
      const file = relativePath(entry?.path, "Version transaction file");
      if (file === ".runtime" || file.startsWith(".runtime/")
        || (!catalogManagedPath(file) && file !== ARTIFACT_CATALOG_RELATIVE_PATH)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
        || typeof entry.bytes !== "string" || Buffer.from(entry.bytes, "base64").toString("base64") !== entry.bytes) {
        throw new Error("Version transaction file image is invalid");
      }
      return [file, Object.freeze({ mode: entry.mode, bytes: Buffer.from(entry.bytes, "base64") })];
    }));
    if (files.size !== value.files.length || directories.size !== value.directories.length || !directories.has("")) throw new Error("Version transaction snapshot contains duplicate paths or lacks its root");
    for (const directory of directories) {
      if (directory !== "" && !directories.has(path.posix.dirname(directory) === "." ? "" : path.posix.dirname(directory))) {
        throw new Error("Version transaction snapshot directory ancestry is incomplete");
      }
    }
    return new VersionTreeSnapshot(location, { directories, files });
  }
}

class VersionCatalogTransactionJournal {
  constructor({ file, document }) {
    if (!(file instanceof AtomicJsonFile) || document === null || typeof document !== "object") {
      throw new Error("Version catalog transaction journal is invalid");
    }
    this.file = file;
    this.document = document;
  }
  prepare(targetCatalogHash) {
    this.document = { ...this.document, targetCatalogHash };
    this.file.write({ ...this.document, digest: sha256(Buffer.from(JSON.stringify(this.document), "utf8")) });
  }
  finish() {
    this.file.remove();
    ACTIVE_VERSION_TRANSACTIONS.delete(this.file.filePath);
  }
  abandon() { ACTIVE_VERSION_TRANSACTIONS.delete(this.file.filePath); }
}

class IdentityValue {
  constructor(value, field) { this.value = identifier(value, field); Object.freeze(this); }
  toString() { return this.value; }
  toJSON() { return this.value; }
  equals(other) { return other instanceof this.constructor && other.value === this.value; }
}

export class FlowId extends IdentityValue {
  constructor(value) { super(value, "flowId"); }
  static from(value) { return value instanceof FlowId ? value : new FlowId(value); }
}

export class FlowVersionId extends IdentityValue {
  constructor(value) { super(value, "flowVersionId"); }
  static from(value) { return value instanceof FlowVersionId ? value : new FlowVersionId(value); }
}

export class FlowSpecIdentity extends IdentityValue {
  constructor(value) { super(value, "specId"); }
  static from(value) { return value instanceof FlowSpecIdentity ? value : new FlowSpecIdentity(value); }
}

export class FlowRunId extends IdentityValue {
  constructor(value) { super(value, "runId"); }
  static from(value) { return value instanceof FlowRunId ? value : new FlowRunId(value); }
}

export class FlowActivityId extends IdentityValue {
  constructor(value) { super(value, "flowActivityId"); }
  static from(value) { return value instanceof FlowActivityId ? value : new FlowActivityId(value); }
}

/** Binds a canonical artifact mutation to the Flow Activity that authorized it. */
export class FlowArtifactPublicationContext {
  constructor({ updater, activityId, publicationClaim } = {}) {
    this.updater = updater instanceof FlowArtifactUpdater ? updater : new FlowArtifactUpdater(updater);
    this.activityId = FlowActivityId.from(activityId);
    if (!(publicationClaim instanceof ArtifactPublicationClaim)) {
      throw new Error("artifact publication context requires an ArtifactPublicationClaim");
    }
    this.publicationClaim = publicationClaim;
    Object.freeze(this);
  }
  publication(artifact, { mediaType } = {}) {
    if (!artifact || typeof artifact.publication !== "function") {
      throw new Error("artifact publication context requires a resolved artifact");
    }
    return Object.freeze({
      ...artifact.publication({
        updater: this.updater.toString(),
        activityId: this.activityId,
        mediaType,
      }),
      publicationClaim: this.publicationClaim,
    });
  }
}

export class FlowVersion {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("version must be a positive safe integer");
    this.value = value;
    Object.freeze(this);
  }
  static from(value) { return value instanceof FlowVersion ? value : new FlowVersion(value); }
  get pathSegment() { return String(this.value).padStart(3, "0"); }
  toJSON() { return this.value; }
  toString() { return String(this.value); }
}

/** Positive revision identity for the immutable canonical Spec collection. */
export class FlowSpecRevision {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Spec revision must be a positive safe integer");
    }
    this.value = value;
    Object.freeze(this);
  }
  static from(value) { return value instanceof FlowSpecRevision ? value : new FlowSpecRevision(value); }
  get pathSegment() { return String(this.value).padStart(3, "0"); }
  toJSON() { return this.value; }
  toString() { return this.pathSegment; }
}

/** Repository-relative identity of one canonical Flow Version. */
export class FlowVersionRelativeLocation {
  constructor({ specRoot = "specs", specId, version } = {}) {
    this.specRoot = relativePath(specRoot, "specRoot");
    this.specId = FlowSpecIdentity.from(specId);
    this.version = FlowVersion.from(version);
    this.relativeDirectory = path.posix.join(
      this.specRoot,
      this.specId.toString(),
      this.version.pathSegment,
    );
    Object.freeze(this);
  }
  static fromArtifactPath({ relativeArtifactPath, logicalKey, version = new FlowVersion(1) } = {}) {
    const candidate = relativePath(relativeArtifactPath, "Version artifact path");
    const artifactPath = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey).relativePath;
    const candidateSegments = candidate.split("/");
    const artifactSegments = artifactPath.split("/");
    const versionIndex = candidateSegments.length - artifactSegments.length - 1;
    const specIdIndex = versionIndex - 1;
    const expectedVersion = FlowVersion.from(version);
    if (
      specIdIndex < 1
      || candidateSegments[versionIndex] !== expectedVersion.pathSegment
      || candidateSegments.slice(versionIndex + 1).join("/") !== artifactPath
    ) {
      throw new Error("Version artifact path does not match its canonical contract");
    }
    const location = new FlowVersionRelativeLocation({
      specRoot: candidateSegments.slice(0, specIdIndex).join("/"),
      specId: candidateSegments[specIdIndex],
      version: expectedVersion,
    });
    if (location.relativeArtifact(logicalKey) !== candidate) {
      throw new Error("Version artifact path does not match its resolved location");
    }
    return location;
  }
  relativePath(value) {
    return path.posix.join(this.relativeDirectory, relativePath(value, "version-relative path"));
  }
  relativeArtifact(logicalKey, parameters = {}) {
    return this.relativePath(FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters).relativePath);
  }
}

export class FlowVersionAuthorityScope {
  constructor(value) {
    this.value = text(value, "Version authority scope");
    if (!VERSION_AUTHORITY_SCOPES.has(this.value)) throw new Error(`invalid Version authority scope: ${this.value}`);
    Object.freeze(this);
  }
  static canonical() { return new FlowVersionAuthorityScope("canonical"); }
  static execution() { return new FlowVersionAuthorityScope("execution"); }
  static from(value) { return value instanceof FlowVersionAuthorityScope ? value : new FlowVersionAuthorityScope(value); }
  toString() { return this.value; }
  toJSON() { return this.value; }
}

export class AuthoritativeSpecRecord {
  #document;
  constructor(document) {
    if (!isPlainObject(document)) throw new Error("authoritative Spec record must be a plain object");
    const id = document.id ?? document.specId;
    if (document.id != null && document.specId != null && document.id !== document.specId) {
      throw new Error("authoritative Spec record id and specId must agree");
    }
    this.specId = FlowSpecIdentity.from(id);
    this.#document = structuredClone(document);
    Object.freeze(this);
  }
  static from(value) { return value instanceof AuthoritativeSpecRecord ? value : new AuthoritativeSpecRecord(value); }
  toJSON() { return structuredClone(this.#document); }
  get canonicalText() { return `${JSON.stringify(this.#document, null, 2)}\n`; }
  schemaPayload() {
    return new AuthoritativeSpecPayload({ document: this.#document, identity: this.specId });
  }
}

/**
 * Schema-owned Spec content separated from the Version-owned identity used to
 * locate and validate it.  The payload never serializes `id`/`specId`: those
 * are transport identities, not fields of the canonical Spec schema.
 */
export class AuthoritativeSpecPayload {
  #document;
  constructor({ document, identity } = {}) {
    if (!isPlainObject(document)) throw new Error("authoritative Spec payload requires a plain object document");
    this.identity = FlowSpecIdentity.from(identity);
    // Reuse the identity record invariant so a dual id/specId declaration
    // cannot silently collapse to one value while the schema fields are
    // projected away.
    const declared = new AuthoritativeSpecRecord({
      ...document,
      id: document.id ?? document.specId ?? this.identity.toString(),
    });
    if (!declared.specId.equals(this.identity)) {
      throw new Error("authoritative Spec payload identity must match its declared document identity");
    }
    const payload = structuredClone(document);
    delete payload.id;
    delete payload.specId;
    this.#document = structuredClone(payload);
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.#document); }
  get canonicalText() { return `${JSON.stringify(this.#document, null, 2)}\n`; }
}

export class FlowVersionSemanticValidator {
  validateState() { throw new Error("Flow Version semantic validator must implement validateState"); }
  validateMaterialized() { throw new Error("Flow Version semantic validator must implement validateMaterialized"); }
}

export class FlowVersionMigrationOutput {
  constructor({ outputKey, targetPath, operation, bytes, mediaType, authoritySlot, retention, activityId = null } = {}) {
    this.outputKey = identifier(outputKey, "migration output key");
    this.targetPath = relativePath(targetPath, "migration output targetPath");
    this.operation = FlowVersionMigrationOperation.from(operation);
    if (!new Set(["transform", "generate"]).has(this.operation.value)) throw new Error("migration output must be transform or generate");
    if (!Buffer.isBuffer(bytes)) throw new Error("migration output bytes must be a Buffer");
    this.bytes = Buffer.from(bytes);
    this.mediaType = text(mediaType, "migration output mediaType");
    if (!(authoritySlot instanceof ArtifactAuthoritySlot)) throw new Error("migration output ArtifactAuthoritySlot is required");
    this.authoritySlot = authoritySlot;
    this.retention = identifier(retention, "migration output retention");
    if (activityId !== null && !(activityId instanceof FlowActivityId)) throw new Error("migration output activity association requires FlowActivityId");
    this.activityId = activityId;
    Object.freeze(this);
  }
}

function sameMigrationAuthoritySlot(left, right) {
  return left instanceof ArtifactAuthoritySlot
    && right instanceof ArtifactAuthoritySlot
    && left.kind === right.kind
    && left.authority.toString() === right.authority.toString()
    && left.cardinality.toString() === right.cardinality.toString()
    && left.memberId === right.memberId
    && left.publicationStep === right.publicationStep;
}

function sameMigrationOutputContract(left, right, { compareBytes = false } = {}) {
  return left.targetPath === right.targetPath
    && left.outputKey === right.outputKey
    && left.operation.value === right.operation.value
    && left.mediaType === right.mediaType
    && sameMigrationAuthoritySlot(left.authoritySlot, right.authoritySlot)
    && left.retention === right.retention
    && (left.activityId?.toString() ?? null) === (right.activityId?.toString() ?? null)
    && (!compareBytes || left.bytes.equals(right.bytes));
}

function sameMigrationAggregate(left, right) {
  return left.operation.value === "transform"
    && right.operation.value === "transform"
    && left.outputKey !== null
    && sameMigrationOutputContract(left, right);
}

export class FlowVersionMigrationOutputSet {
  constructor(outputs = []) {
    if (!Array.isArray(outputs) || outputs.some((output) => !(output instanceof FlowVersionMigrationOutput))) {
      throw new Error("typed migration outputs are required");
    }
    this.byKey = new Map();
    this.byTarget = new Map();
    for (const output of outputs) {
      const existingKey = this.byKey.get(output.outputKey);
      if (existingKey && !sameMigrationOutputContract(existingKey, output, { compareBytes: true })) {
        throw new Error(`migration output key conflict: ${output.outputKey}`);
      }
      const existingTarget = this.byTarget.get(output.targetPath);
      if (existingTarget && existingTarget.outputKey !== output.outputKey) {
        throw new Error(`migration output target conflict: ${output.targetPath}`);
      }
      this.byKey.set(output.outputKey, output);
      this.byTarget.set(output.targetPath, output);
    }
    Object.freeze(this);
  }
  require(outputKey) {
    const output = this.byKey.get(identifier(outputKey, "migration output key"));
    if (!output) throw new Error(`migration output builder did not provide ${outputKey}`);
    return output;
  }
  values() { return [...this.byTarget.values()]; }
}

export class FlowVersionMigrationOutputBuilder {
  build() { throw new Error("Flow Version migration output builder must implement build"); }
}

/** Consumer paths remain authority-scoped and resolve only canonical contracts. */
export class FlowVersionConsumerPaths {
  constructor(location) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required for consumer paths");
    this.location = location;
    Object.freeze(this);
  }
  report() { return this.location.artifact("report"); }
}

export class FlowVersionLocation {
  constructor({ repositoryRoot, authorityScope, specRoot = "specs", specId, version, storageRelativeDirectory = null } = {}) {
    if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) throw new Error("repositoryRoot must be an absolute path");
    this.repositoryRoot = path.resolve(repositoryRoot);
    const rootStat = fs.lstatSync(this.repositoryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(this.repositoryRoot) !== this.repositoryRoot) {
      throw new Error("repositoryRoot must be a canonical real directory without symbolic-link ancestors");
    }
    this.authorityScope = FlowVersionAuthorityScope.from(authorityScope);
    const relativeLocation = new FlowVersionRelativeLocation({ specRoot, specId, version });
    this.specRoot = relativeLocation.specRoot;
    this.specId = relativeLocation.specId;
    this.version = relativeLocation.version;
    const canonicalRelativeDirectory = relativeLocation.relativeDirectory;
    if (storageRelativeDirectory !== null) {
      const staged = relativePath(storageRelativeDirectory, "Version staging directory");
      const expectedParent = path.posix.dirname(canonicalRelativeDirectory);
      if (path.posix.dirname(staged) !== expectedParent || !path.posix.basename(staged).startsWith(`.${this.version.pathSegment}.`)) {
        throw new Error("Version staging directory must be a sibling of its canonical Version root");
      }
      this.relativeDirectory = staged;
      this.isStaging = true;
    } else {
      this.relativeDirectory = canonicalRelativeDirectory;
      this.isStaging = false;
    }
    this.canonicalRelativeDirectory = canonicalRelativeDirectory;
    this.directory = path.join(this.repositoryRoot, ...this.relativeDirectory.split("/"));
    this.consumers = new FlowVersionConsumerPaths(this);
    Object.freeze(this);
  }
  requireScope(value) {
    if (this.authorityScope.value !== value) throw new Error(`${value} Version authority is required`);
    return this;
  }
  stagingSibling(token) {
    const suffix = identifier(token, "Version staging token");
    return new FlowVersionLocation({
      repositoryRoot: this.repositoryRoot,
      authorityScope: this.authorityScope,
      specRoot: this.specRoot,
      specId: this.specId,
      version: this.version,
      storageRelativeDirectory: path.posix.join(
        path.posix.dirname(this.canonicalRelativeDirectory),
        `.${this.version.pathSegment}.${suffix}.tmp`,
      ),
    });
  }
  assertAuthority(value = null, options = {}) {
    const target = value == null ? this.directory : this.resolve(value);
    assertFilesystemAuthority(this.repositoryRoot, target, options);
    return target;
  }
  relativePath(value) { return path.posix.join(this.relativeDirectory, relativePath(value, "version-relative path")); }
  resolve(value) { return path.join(this.directory, ...relativePath(value, "version-relative path").split("/")); }
  /** Migration-only preservation location; normal callers use artifact(logicalKey). */
  artifactPath(value) { return this.resolve(path.posix.join("artifacts/migration", relativePath(value, "migration artifact path"))); }
  artifact(logicalKey, parameters = {}) { return this.resolve(FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters).relativePath); }
  relativeArtifact(logicalKey, parameters = {}) { return this.relativePath(FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters).relativePath); }
  runtimeLock(logicalKey) { return new FlowVersionRuntimeLockLocation({ location: this, logicalKey }); }
  // State consumers need repository-relative paths, but must not reconstruct
  // a Version directory themselves.  These accessors are the canonical
  // counterpart of the retired FlowSpecLocation conveniences.
  get relativeFlowStateFile() { return this.relativeArtifact("flow.state"); }
  get relativeActivitiesFile() { return this.relativeArtifact("flow.activities"); }
  get relativeSpecFile() { return this.relativeArtifact("spec.record"); }
  get relativeCatalogFile() { return this.relativeArtifact("artifact.catalog"); }
  get relativeIssueLogFile() { return this.relativeArtifact("issue.log"); }
  get relativeIssueSnapshotFile() { return this.relativeArtifact("issue.snapshot"); }
  get flowStateFile() { return this.artifact("flow.state"); }
  get activitiesFile() { return this.artifact("flow.activities"); }
  get specFile() { return this.artifact("spec.record"); }
  get catalogFile() { return this.artifact("artifact.catalog"); }
  get issueLogFile() { return this.artifact("issue.log"); }
  get issueSnapshotFile() { return this.artifact("issue.snapshot"); }
  get reportFile() { return this.artifact("report"); }
  specSnapshotFile(revision) { return this.artifact("spec.snapshot", { revision: FlowSpecRevision.from(revision).pathSegment }); }
  specReviewFile(revision) { return this.artifact("spec.review", { revision: FlowSpecRevision.from(revision).pathSegment }); }
  taskArtifactLocation(taskId) {
    return new FlowTaskArtifactLocation({ versionLocation: this, taskId });
  }
  reviewEvidencePath({ reviewStep = null, taskId = null, digest } = {}) {
    return this.resolve(FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep, taskId, digest }).relativePath);
  }
}

/**
 * Typed location for one non-authoritative Version runtime lock.  Lock
 * consumers receive this value rather than reconstructing a `.runtime` path,
 * so repository authority checks can distinguish a Store-owned lock from an
 * arbitrary worker-created runtime file.
 */
export class FlowVersionRuntimeLockLocation {
  constructor({ location, logicalKey } = {}) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new Error("runtime lock location requires a FlowVersionLocation");
    }
    const key = identifier(logicalKey, "runtime lock logicalKey");
    const contract = FLOW_ARTIFACT_CONTRACTS.require(key);
    if (
      !key.startsWith("runtime.lock.")
      || contract.cataloged
      || contract.retention.toString() !== "transient"
      || contract.canonicalPath.parameters.length !== 0
    ) {
      throw new Error("runtime lock location requires a singleton transient runtime-lock contract");
    }
    this.location = location;
    this.logicalKey = key;
    this.repositoryRoot = location.repositoryRoot;
    this.relativeRepositoryPath = location.relativeArtifact(key);
    this.path = location.artifact(key);
    this.directory = path.dirname(this.path);
    this.fileName = path.basename(this.path);
    this.runtimeDirectory = path.dirname(this.directory);
    Object.freeze(this);
  }

  matchesRepositoryPath(value) {
    const candidate = relativePath(value, "runtime lock repository path");
    if (candidate === this.relativeRepositoryPath) return true;
    return path.posix.dirname(candidate) === path.posix.dirname(this.relativeRepositoryPath)
      && ProcessLock.isOwnerTemporaryFileName(this.fileName, path.posix.basename(candidate));
  }
}

/**
 * Typed location for one materialized Task's durable artifact topology.
 *
 * Task identifiers are never interpolated by callers into a Version path.
 * This value owns the sole Version-layer mapping from a stable Task id to
 * `steps/impl/<taskId>/{impl,review,triage,repair,gate}` and verifies that every task
 * artifact it resolves is the artifact-contract member for that same id.
 */
export class FlowTaskArtifactLocation {
  constructor({ versionLocation, taskId } = {}) {
    if (!(versionLocation instanceof FlowVersionLocation)) {
      throw new Error("task artifact location requires a FlowVersionLocation");
    }
    this.versionLocation = versionLocation;
    this.taskId = identifier(taskId, "taskId");
    this.relativeDirectory = path.posix.dirname(
      FLOW_ARTIFACT_CONTRACTS.taskDirectory(this.taskId, "impl"),
    );
    this.directory = this.versionLocation.resolve(this.relativeDirectory);
    Object.freeze(this);
  }

  relativeDirectoryFor(segment) {
    const resolved = identifier(segment, "task artifact segment");
    if (!TASK_ARTIFACT_SEGMENTS.has(resolved)) {
      throw new Error(`task artifact segment is invalid: ${resolved}`);
    }
    return FLOW_ARTIFACT_CONTRACTS.taskDirectory(this.taskId, resolved);
  }

  directoryFor(segment) {
    return this.versionLocation.resolve(this.relativeDirectoryFor(segment));
  }

  get implDirectory() { return this.directoryFor("impl"); }
  get reviewDirectory() { return this.directoryFor("review"); }
  get triageDirectory() { return this.directoryFor("triage"); }
  get repairDirectory() { return this.directoryFor("repair"); }
  get gateDirectory() { return this.directoryFor("gate"); }

  relativeArtifact(logicalKey) {
    return this.versionLocation.relativePath(this.#artifact(logicalKey).relativePath);
  }

  artifact(logicalKey) {
    return this.versionLocation.resolve(this.#artifact(logicalKey).relativePath);
  }

  get reviewResultFile() { return this.artifact("task.review"); }
  get triageResultFile() { return this.artifact("task.triage"); }
  get repairResultFile() { return this.artifact("task.repair"); }
  get gateSourceFile() { return this.artifact("task.gate.source"); }
  get gateResultFile() { return this.artifact("task.gate"); }

  #artifact(logicalKey) {
    const key = text(logicalKey, "task artifact logicalKey");
    const segment = TASK_ARTIFACT_SEGMENT_BY_LOGICAL_KEY.get(key);
    if (segment === undefined) {
      throw new Error(`task artifact location does not own logical key: ${key}`);
    }
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(key, { taskId: this.taskId });
    const directory = this.relativeDirectoryFor(segment);
    if (path.posix.dirname(artifact.relativePath) !== directory) {
      throw new Error(`task artifact contract does not match its Task directory: ${key}`);
    }
    return artifact;
  }
}

export class FlowArtifactDescriptor {
  constructor({ logicalKey = null, kind, relativePath: file, hash, size, mediaType, authoritySlot = null, authority, cardinality, memberId = null, publicationStep, retention, activityId = null, migrationMaterialization = false } = {}) {
    this.slot = authoritySlot instanceof ArtifactAuthoritySlot
      ? authoritySlot
      : new ArtifactAuthoritySlot({ kind, authority, cardinality, memberId, publicationStep });
    if (kind != null && this.slot.kind !== kind) throw new Error("artifact kind does not match its authority slot");
    this.kind = this.slot.kind;
    this.relativePath = relativePath(file, "artifact relativePath");
    let contract = null;
    if (logicalKey !== null) contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
    else {
      try { contract = FLOW_ARTIFACT_CONTRACTS.classify(this.relativePath); } catch (error) {
        if (migrationMaterialization !== true || (this.relativePath !== "flow-migration-report.json" && !this.relativePath.startsWith("artifacts/migration/"))) throw error;
      }
    }
    if (contract !== null && !contract.matchesCanonicalPath(this.relativePath)) {
      throw new Error(`artifact path does not match logical contract ${contract.logicalKey}`);
    }
    if (contract?.logicalKey.toString() === "review.evidence") {
      FlowArtifactReviewEvidence.fromCanonicalPath(contract, this.relativePath).assertAuthoritySlot(this.slot);
    }
    if (contract?.logicalKey.toString() === "activity.evidence") {
      FlowArtifactActivityEvidence.fromCanonicalPath(contract, this.relativePath).assertAuthoritySlot(this.slot);
    }
    if (contract !== null) contract.assertAuthoritySlot(this.relativePath, this.slot);
    this.logicalKey = contract?.logicalKey.toString() ?? null;
    this.migrationMaterialization = migrationMaterialization === true;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("artifact hash must be a lowercase SHA-256 digest");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("artifact size must be a non-negative safe integer");
    this.hash = hash;
    this.size = size;
    this.mediaType = text(mediaType, "artifact mediaType");
    this.authority = this.slot.authority;
    this.cardinality = this.slot.cardinality;
    this.memberId = this.slot.memberId;
    this.retention = identifier(retention, "artifact retention");
    if (contract !== null && this.retention !== contract.retention.toString()) {
      throw new Error(`artifact retention does not match logical contract ${contract.logicalKey}`);
    }
    this.activityId = activityId == null ? null : identifier(activityId, "artifact activityId");
    if (contract?.logicalKey.toString() === "activity.evidence" && this.activityId === null) {
      throw new Error("activity evidence requires an associated Flow Activity");
    }
    Object.freeze(this);
  }
  static fromFile({ location, logicalKey = null, authoritySlot, relativePath: file, mediaType, retention, activityId = null, migrationMaterialization = false } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required to capture an artifact");
    if (!(authoritySlot instanceof ArtifactAuthoritySlot)) throw new Error("ArtifactAuthoritySlot is required to capture an artifact");
    if (activityId !== null && !(activityId instanceof FlowActivityId)) throw new Error("FlowActivityId is required for an artifact activity association");
    const safePath = relativePath(file, "artifact relativePath");
    const filePath = location.resolve(safePath);
    if (!catalogManagedPath(safePath)) throw new Error(`artifact is outside catalog-managed storage: ${safePath}`);
    location.assertAuthority(safePath, { mustExist: true });
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact must be a regular non-symlink file");
    if (stat.nlink !== 1) throw new Error("artifact must not be hard linked");
    const bytes = fs.readFileSync(filePath);
    const descriptor = new FlowArtifactDescriptor({ logicalKey, authoritySlot, relativePath: safePath, hash: sha256(bytes), size: bytes.length, mediaType, retention, activityId: activityId?.toString() ?? null, migrationMaterialization });
    if (descriptor.logicalKey !== null && !descriptor.logicalKey.startsWith("transition.")) {
      FLOW_ARTIFACT_CONTRACTS.require(descriptor.logicalKey).assertContentPublication(null, bytes);
    }
    return descriptor;
  }
  verify(location) {
    const actual = FlowArtifactDescriptor.fromFile({
      location, logicalKey: this.logicalKey, authoritySlot: this.slot, relativePath: this.relativePath,
      mediaType: this.mediaType, retention: this.retention, migrationMaterialization: this.migrationMaterialization,
      activityId: this.activityId == null ? null : new FlowActivityId(this.activityId),
    });
    if (actual.hash !== this.hash || actual.size !== this.size) throw new Error(`artifact content does not match the catalog: ${this.relativePath}`);
    return actual;
  }
  verifyBytes(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("artifact verification requires Buffer bytes");
    if (bytes.length !== this.size || sha256(bytes) !== this.hash) {
      throw new Error(`artifact content does not match the catalog: ${this.relativePath}`);
    }
    return this;
  }
  authorityKey() { return this.slot.claimKey(); }
  toJSON() {
    return {
      logicalKey: this.logicalKey, kind: this.kind, relativePath: this.relativePath, hash: this.hash, size: this.size,
      mediaType: this.mediaType, ...this.slot.toJSON(), retention: this.retention, activityId: this.activityId,
      migrationMaterialization: this.migrationMaterialization,
    };
  }
}

/** Catalog-side view of the Activity fields that establish artifact updater provenance. */
export class FlowArtifactActivityAssociation {
  constructor({ id, nodeId, nodeKey, confirmationOrder, operation = null } = {}) {
    this.id = identifier(id, "cataloged Flow Activity id");
    this.nodeId = nodeId == null ? null : text(nodeId, "cataloged Flow Activity nodeId");
    this.nodeKey = nodeKey == null ? null : identifier(nodeKey, "cataloged Flow Activity nodeKey");
    if ((this.nodeId === null) !== (this.nodeKey === null)) throw new Error("cataloged Flow Activity node identity must be complete");
    if (!Number.isSafeInteger(confirmationOrder) || confirmationOrder < 1) {
      throw new Error("cataloged Flow Activity confirmationOrder must be a positive safe integer");
    }
    this.confirmationOrder = confirmationOrder;
    this.operation = operation == null ? null : text(operation, "cataloged Flow Activity operation");
    Object.freeze(this);
  }
  get updaterStep() {
    return this.nodeId === null ? null : FlowArtifactUpdater.fromActivityNodeId(this.nodeId).toString();
  }
  assertRelatedArtifact(artifact) {
    if (!(artifact instanceof FlowArtifactDescriptor)) throw new Error("FlowArtifactDescriptor is required for an Activity association");
    if (artifact.activityId !== this.id) throw new Error("artifact Activity association id does not match the descriptor");
    if (artifact.logicalKey === null || artifact.logicalKey.startsWith("transition.")) return this;
    if (artifact.logicalKey === "activity.evidence") {
      const owner = FlowArtifactActivityEvidence.fromCanonicalPath(
        FLOW_ARTIFACT_CONTRACTS.require("activity.evidence"),
        artifact.relativePath,
      ).owner;
      // Activity evidence has an owner-bound path contract, including the
      // explicit system namespace for a historical node. Resolve its
      // publication actor from that typed owner before consulting the generic
      // current-Step updater; the content validator then binds the document
      // owner to this exact ledger Activity.
      if (artifact.slot.publicationStep !== owner.publicationStep) {
        throw new Error(`cataloged Activity evidence updater does not match its typed owner: ${artifact.relativePath}`);
      }
      return this;
    }
    // A source worker may seal optional upgrade evidence, but only its parent
    // may publish the system-owned result in that exact completion Activity.
    // The regular upgrade command remains associated with its dedicated Flow
    // root publication Activity. No other system Activity may claim it.
    if (artifact.logicalKey === "upgrade.result" && artifact.slot.publicationStep === "system") {
      const sourceCompletion = this.operation !== null
        && SOURCE_COMPLETION_OPERATIONS.has(this.operation)
        && requiresWorkerSourceHandoff(this.updaterStep);
      const externalUpgrade = this.operation === "publish_upgrade_result" && this.nodeId === "flow";
      if (sourceCompletion || externalUpgrade) return this;
      throw new Error("system upgrade.result may be associated only with a source completion or publish_upgrade_result Activity");
    }
    let updaterStep;
    try {
      updaterStep = this.updaterStep;
    } catch (error) {
      // Task-scoped observations are anchored to the stable Task ID, not a
      // synthetic producer Step. They only republish the flow-wide system
      // records that make the Activity durable, so they must not be forced
      // through an artifact producer actor.
      if (FLOW_WIDE_TASK_ACTIVITY_ARTIFACTS.has(artifact.logicalKey)) return this;
      throw error;
    }
    if (updaterStep === null) throw new Error(`cataloged artifact related Activity has no node identity: ${artifact.relativePath}`);
    if (artifact.slot.publicationStep !== updaterStep) {
      throw new Error(`cataloged artifact updater does not match its related Activity node: ${artifact.relativePath}`);
    }
    if (updaterStep.startsWith("task-") && RETRY_RECOVERY_TASK_ARTIFACTS.has(artifact.logicalKey)) {
      new TaskRetryRecoveryArtifactOwner({
        logicalKey: artifact.logicalKey,
        relativePath: artifact.relativePath,
      }).assertActivityNode(this.nodeId);
      return this;
    }
    if (updaterStep.startsWith("task-") && SOURCE_HANDOFF_TASK_ARTIFACTS.has(artifact.logicalKey)) return this;
    if (updaterStep.startsWith("task-") && !FLOW_WIDE_TASK_ACTIVITY_ARTIFACTS.has(artifact.logicalKey)) {
      const taskPath = artifact.relativePath.match(/^steps\/impl\/([^/]+)\/(?:impl|review|triage|repair|gate)(?:\/|$)/);
      if (taskPath === null) throw new Error(`task-scoped updater Activity is not bound to a task artifact: ${artifact.relativePath}`);
      const taskId = taskPath[1];
      const taskLeaf = updaterStep.slice("task-".length);
      if (this.nodeId !== `${taskId}-${taskLeaf}`) {
        throw new Error(`cataloged task artifact owner does not match its related Activity node: ${artifact.relativePath}`);
      }
    }
    return this;
  }
  assertLaterThan(previous) {
    if (!(previous instanceof FlowArtifactActivityAssociation)) throw new Error("previous Flow Activity association is required");
    if (this.confirmationOrder <= previous.confirmationOrder) {
      throw new Error("artifact Activity association must advance to the latest updater Activity");
    }
    return this;
  }
  toJSON() {
    return {
      id: this.id,
      nodeId: this.nodeId,
      nodeKey: this.nodeKey,
      confirmationOrder: this.confirmationOrder,
      operation: this.operation,
    };
  }
}

export class FlowArtifactActivityIndex {
  constructor(activities = []) {
    if (!Array.isArray(activities) || activities.some((activity) => !(activity instanceof FlowArtifactActivityAssociation))) {
      throw new Error("artifact Activity index requires typed associations");
    }
    this.byId = new Map();
    let order = 0;
    for (const activity of activities) {
      if (this.byId.has(activity.id)) throw new Error(`activities.jsonl contains duplicate Activity id: ${activity.id}`);
      if (activity.confirmationOrder !== order + 1) throw new Error("activities.jsonl confirmationOrder must be contiguous");
      this.byId.set(activity.id, activity);
      order = activity.confirmationOrder;
    }
    Object.freeze(this);
  }
  static fromFile(file) {
    return FlowArtifactActivityIndex.fromBytes(fs.readFileSync(file));
  }
  static fromBytes(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("artifact Activity index requires file bytes");
    const activities = [];
    const lines = bytes.toString("utf8").split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      let value;
      try { value = JSON.parse(line); } catch (error) { throw new Error(`activities.jsonl contains malformed JSON: ${error.message}`); }
      activities.push(new FlowArtifactActivityAssociation({
        id: value?.id,
        nodeId: value?.nodeId,
        nodeKey: value?.nodeKey,
        confirmationOrder: value?.confirmationOrder,
        operation: value?.transition?.operation ?? null,
      }));
    }
    return new FlowArtifactActivityIndex(activities);
  }
  require(activityId) {
    const id = identifier(activityId, "artifact activityId");
    const activity = this.byId.get(id);
    if (!activity) throw new Error(`cataloged artifact references a missing Activity: ${id}`);
    return activity;
  }
}

class FlowArtifactActivityIndexFile {
  #bytes = null;
  #index = null;

  constructor(file) {
    this.file = path.resolve(file);
    Object.freeze(this);
  }

  read() {
    const bytes = fs.readFileSync(this.file);
    if (this.#bytes !== null && bytes.equals(this.#bytes)) return this.#index;
    const index = FlowArtifactActivityIndex.fromBytes(bytes);
    this.#bytes = Buffer.from(bytes);
    this.#index = index;
    return index;
  }
}

export class FlowArtifactCatalog {
  constructor({ schemaRevision = CATALOG_SCHEMA_REVISION, artifacts = [] } = {}) {
    if (schemaRevision !== CATALOG_SCHEMA_REVISION) throw new Error(`unsupported artifact catalog schemaRevision: ${schemaRevision}`);
    if (!Array.isArray(artifacts)) throw new Error("artifact catalog artifacts must be an array");
    const sorted = artifacts.map((entry) => entry instanceof FlowArtifactDescriptor ? entry : new FlowArtifactDescriptor(entry));
    sorted.sort((left, right) => codeUnitOrder(left.relativePath, right.relativePath) || codeUnitOrder(left.kind, right.kind));
    const paths = new Set();
    const authorityClaims = new Set();
    for (const artifact of sorted) {
      if (paths.has(artifact.relativePath)) throw new Error(`duplicate artifact path: ${artifact.relativePath}`);
      if (!catalogManagedPath(artifact.relativePath)) throw new Error(`artifact is outside catalog-managed storage: ${artifact.relativePath}`);
      if (authorityClaims.has(artifact.authorityKey())) {
        throw new Error(`duplicate artifact authority slot: ${artifact.kind}/${artifact.authority}/${artifact.memberId ?? "singleton"}`);
      }
      paths.add(artifact.relativePath);
      authorityClaims.add(artifact.authorityKey());
    }
    this.schemaRevision = schemaRevision;
    this.artifacts = Object.freeze(sorted);
    this.hash = sha256(Buffer.from(JSON.stringify(this.content()), "utf8"));
    Object.freeze(this);
  }
  content() { return { schemaRevision: this.schemaRevision, artifacts: this.artifacts.map((artifact) => artifact.toJSON()) }; }
  static regenerate(descriptors) { return new FlowArtifactCatalog({ artifacts: descriptors }); }
  static fromSerialized(value, { maxArtifacts = Infinity } = {}) {
    requireBoundedLimit(maxArtifacts, "catalog maxArtifacts");
    if (!isPlainObject(value) || Object.keys(value).length !== CATALOG_SERIALIZED_FIELDS.size
      || Object.keys(value).some((field) => !CATALOG_SERIALIZED_FIELDS.has(field))
      || !Array.isArray(value.artifacts) || value.artifacts.length > maxArtifacts) {
      throw new Error("artifact catalog serialized form is invalid");
    }
    for (const descriptor of value.artifacts) {
      if (!isPlainObject(descriptor)
        || Object.keys(descriptor).length !== CATALOG_DESCRIPTOR_SERIALIZED_FIELDS.size
        || Object.keys(descriptor).some((field) => !CATALOG_DESCRIPTOR_SERIALIZED_FIELDS.has(field))) {
        throw new Error("artifact catalog descriptor serialized form is invalid");
      }
    }
    const catalog = new FlowArtifactCatalog(value);
    if (value.hash !== catalog.hash) throw new Error("artifact catalog hash does not match its canonical content");
    return catalog;
  }
  static managedFiles(location, { maxEntries = Infinity } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required to inspect managed artifacts");
    requireBoundedLimit(maxEntries, "managed artifact maxEntries");
    location.requireScope("canonical");
    return Object.freeze(managedFiles(location, { maxEntries }));
  }
  resolve(file) {
    const result = this.artifacts.find((artifact) => artifact.relativePath === relativePath(file, "artifact relativePath"));
    if (!result) throw new Error(`artifact is not cataloged: ${file}`);
    return result;
  }
  relatedActivity(file, location, activityIndexFile = null) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required to resolve an artifact Activity");
    if (activityIndexFile !== null && !(activityIndexFile instanceof FlowArtifactActivityIndexFile)) {
      throw new Error("FlowArtifactActivityIndexFile is required to resolve an artifact Activity");
    }
    location.requireScope("canonical");
    location.assertAuthority(FLOW_ACTIVITIES_RELATIVE_PATH, { mustExist: true });
    const artifact = this.resolve(file);
    if (artifact.activityId === null) return null;
    const activityIndex = activityIndexFile?.read() ?? FlowArtifactActivityIndex.fromFile(location.activitiesFile);
    return activityIndex.require(artifact.activityId).assertRelatedArtifact(artifact);
  }
  verify(location, activityIndexFile = null) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required to verify an artifact catalog");
    if (activityIndexFile !== null && !(activityIndexFile instanceof FlowArtifactActivityIndexFile)) {
      throw new Error("FlowArtifactActivityIndexFile is required to verify an artifact catalog");
    }
    location.requireScope("canonical");
    const actual = new Set(FlowArtifactCatalog.managedFiles(location));
    const cataloged = new Set(this.artifacts.map((artifact) => artifact.relativePath));
    for (const file of actual) if (!cataloged.has(file)) throw new Error(`catalog-managed artifact is missing from the catalog: ${file}`);
    for (const artifact of this.artifacts) artifact.verify(location);
    const ledger = this.artifacts.find((artifact) => artifact.relativePath === FLOW_ACTIVITIES_RELATIVE_PATH);
    const associated = this.artifacts.filter((artifact) => artifact.activityId !== null);
    if (ledger || associated.length > 0) {
      if (!ledger) throw new Error(`cataloged Activity associations require ${FLOW_ACTIVITIES_RELATIVE_PATH}`);
      const activityIndex = activityIndexFile?.read() ?? FlowArtifactActivityIndex.fromFile(location.activitiesFile);
      for (const artifact of associated) {
        const activity = activityIndex.require(artifact.activityId).assertRelatedArtifact(artifact);
        if (artifact.logicalKey !== null) {
          const contract = FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey);
          contract.contentContract?.assertCatalogAssociation({
            bytes: fs.readFileSync(location.resolve(artifact.relativePath)),
            descriptor: artifact,
            activity,
          });
        }
      }
    }
    return this;
  }
  async verifySnapshot({
    location,
    activityIndex,
    confirmedLedgerBytes,
    readArtifact,
    maxManagedEntries = Infinity,
  } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required to verify an artifact catalog snapshot");
    if (activityIndex !== null && !(activityIndex instanceof FlowArtifactActivityIndex)) {
      throw new Error("FlowArtifactActivityIndex or null is required to verify an artifact catalog snapshot");
    }
    if (!Buffer.isBuffer(confirmedLedgerBytes)) throw new Error("catalog snapshot requires confirmed Activity ledger bytes");
    if (typeof readArtifact !== "function") throw new Error("catalog snapshot requires an artifact reader");
    const actual = new Set(FlowArtifactCatalog.managedFiles(location, { maxEntries: maxManagedEntries }));
    const cataloged = new Set(this.artifacts.map((artifact) => artifact.relativePath));
    for (const file of actual) if (!cataloged.has(file)) throw new Error(`catalog-managed artifact is missing from the catalog: ${file}`);
    const ledger = this.artifacts.find((artifact) => artifact.relativePath === FLOW_ACTIVITIES_RELATIVE_PATH) ?? null;
    if (ledger !== null) ledger.verifyBytes(confirmedLedgerBytes);
    for (const artifact of this.artifacts) {
      if (artifact === ledger) continue;
      artifact.verifyBytes(await readArtifact(artifact));
    }
    const associated = this.artifacts.filter((artifact) => artifact.activityId !== null);
    if (ledger || associated.length > 0) {
      if (ledger === null) throw new Error(`cataloged Activity associations require ${FLOW_ACTIVITIES_RELATIVE_PATH}`);
      if (!(activityIndex instanceof FlowArtifactActivityIndex)) throw new Error("catalog snapshot requires an Activity index for cataloged Activity associations");
      for (const artifact of associated) {
        const activity = activityIndex.require(artifact.activityId).assertRelatedArtifact(artifact);
        if (artifact.logicalKey !== null) {
          const contract = FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey);
          const bytes = artifact === ledger ? confirmedLedgerBytes : await readArtifact(artifact);
          contract.contentContract?.assertCatalogAssociation({ bytes, descriptor: artifact, activity });
        }
      }
    }
    return this;
  }
  toJSON() { return { ...this.content(), hash: this.hash }; }
}

/** Typed evidence captured by one lock-free committed catalog observation. */
export class FlowArtifactCatalogSnapshotEvidence {
  constructor({ value, activityIndex, confirmedLedgerBytes } = {}) {
    if (!(activityIndex instanceof FlowArtifactActivityIndex)) {
      throw new Error("catalog snapshot evidence requires a FlowArtifactActivityIndex");
    }
    if (!Buffer.isBuffer(confirmedLedgerBytes)) {
      throw new Error("catalog snapshot evidence requires confirmed Activity ledger bytes");
    }
    this.value = value;
    this.activityIndex = activityIndex;
    this.confirmedLedgerBytes = Buffer.from(confirmedLedgerBytes);
    Object.freeze(this);
  }
}

/** One coherent catalog-bound value returned by the lock-free read boundary. */
export class FlowArtifactCatalogCommittedSnapshot {
  constructor({ catalog, value } = {}) {
    if (!(catalog instanceof FlowArtifactCatalog)) throw new Error("committed catalog snapshot requires a FlowArtifactCatalog");
    this.catalog = catalog;
    this.value = value;
    Object.freeze(this);
  }
}

/** Bounded work budget for a lock-free catalog snapshot. */
export class FlowArtifactCatalogSnapshotLimits {
  constructor(value = {}) {
    if (!isPlainObject(value)) throw new Error("catalog snapshot limits must be an object");
    const allowed = new Set(Object.keys(DEFAULT_CATALOG_SNAPSHOT_LIMITS));
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("catalog snapshot limits contain an unknown field");
    const resolved = { ...DEFAULT_CATALOG_SNAPSHOT_LIMITS, ...value };
    this.maxAttempts = requireBoundedLimit(resolved.maxAttempts, "catalog snapshot maxAttempts", { minimum: 1, allowInfinity: false });
    this.maxCatalogBytes = requireBoundedLimit(resolved.maxCatalogBytes, "catalog snapshot maxCatalogBytes", { allowInfinity: false });
    this.maxArtifacts = requireBoundedLimit(resolved.maxArtifacts, "catalog snapshot maxArtifacts", { allowInfinity: false });
    this.maxManagedEntries = requireBoundedLimit(resolved.maxManagedEntries, "catalog snapshot maxManagedEntries", { allowInfinity: false });
    this.maxArtifactBytes = requireBoundedLimit(resolved.maxArtifactBytes, "catalog snapshot maxArtifactBytes", { allowInfinity: false });
    this.maxConfirmedLedgerBytes = requireBoundedLimit(resolved.maxConfirmedLedgerBytes, "catalog snapshot maxConfirmedLedgerBytes", { allowInfinity: false });
    this.maxTotalArtifactBytes = requireBoundedLimit(resolved.maxTotalArtifactBytes, "catalog snapshot maxTotalArtifactBytes", { allowInfinity: false });
    Object.freeze(this);
  }
}

/**
 * Read-only C0 catalog boundary for consumers that must not participate in
 * catalog publication, locking, recovery, or writer caching.
 */
export class FlowArtifactCatalogSnapshotReader {
  constructor({ location } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required for catalog snapshot reads");
    location.requireScope("canonical");
    location.assertAuthority();
    this.location = location;
    Object.freeze(this);
  }

  async readCommittedSnapshot({ capture, limits = {} } = {}) {
    if (typeof capture !== "function") throw new Error("committed catalog snapshot requires a capture function");
    const snapshotLimits = new FlowArtifactCatalogSnapshotLimits(limits);
    this.location.assertAuthority(null, { mustExist: true });
    for (let attempt = 1; attempt <= snapshotLimits.maxAttempts; attempt += 1) {
      const startingCatalogBytes = await readBoundedRealFile(
        this.location,
        ARTIFACT_CATALOG_RELATIVE_PATH,
        snapshotLimits.maxCatalogBytes,
      );
      let catalog;
      try {
        catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(startingCatalogBytes.toString("utf8")), {
          maxArtifacts: snapshotLimits.maxArtifacts,
        });
      } catch (error) {
        throw new Error(`catalog snapshot cannot parse the committed catalog: ${error.message}`, { cause: error });
      }
      const artifactBytes = new Map();
      let totalArtifactBytes = 0;
      const readArtifact = async (artifact) => {
        if (!(artifact instanceof FlowArtifactDescriptor)) throw new Error("catalog snapshot reader requires a FlowArtifactDescriptor");
        const cached = artifactBytes.get(artifact.relativePath);
        if (cached !== undefined) return Buffer.from(cached);
        const maximumBytes = artifact.relativePath === FLOW_ACTIVITIES_RELATIVE_PATH
          ? snapshotLimits.maxConfirmedLedgerBytes
          : snapshotLimits.maxArtifactBytes;
        if (artifact.size > maximumBytes) {
          throw new Error(`catalog snapshot artifact exceeds the bounded size: ${artifact.relativePath}`);
        }
        if (totalArtifactBytes + artifact.size > snapshotLimits.maxTotalArtifactBytes) {
          throw new Error("catalog snapshot aggregate artifact bytes exceed the limit");
        }
        const bytes = await readBoundedRealFile(this.location, artifact.relativePath, maximumBytes);
        if (totalArtifactBytes + bytes.length > snapshotLimits.maxTotalArtifactBytes) {
          throw new Error("catalog snapshot aggregate artifact bytes exceed the limit");
        }
        totalArtifactBytes += bytes.length;
        artifactBytes.set(artifact.relativePath, Buffer.from(bytes));
        return Buffer.from(bytes);
      };
      let failure = null;
      let evidence = null;
      try {
        evidence = await capture(Object.freeze({ catalog, readArtifact, attempt }));
        if (!(evidence instanceof FlowArtifactCatalogSnapshotEvidence)) {
          throw new Error("committed catalog snapshot capture must return FlowArtifactCatalogSnapshotEvidence");
        }
        await catalog.verifySnapshot({
          location: this.location,
          activityIndex: evidence.activityIndex,
          confirmedLedgerBytes: evidence.confirmedLedgerBytes,
          readArtifact,
          maxManagedEntries: snapshotLimits.maxManagedEntries,
        });
      } catch (error) {
        failure = error;
      }
      // C0 is the query-start commit marker. Once every artifact referenced by
      // that catalog was captured and verified, later publication must not
      // silently advance this read to C1.
      if (failure === null) return new FlowArtifactCatalogCommittedSnapshot({ catalog, value: evidence.value });
      let endingCatalogBytes;
      try {
        endingCatalogBytes = await readBoundedRealFile(
          this.location,
          ARTIFACT_CATALOG_RELATIVE_PATH,
          snapshotLimits.maxCatalogBytes,
        );
      } catch (error) {
        if (attempt === snapshotLimits.maxAttempts) throw error;
        continue;
      }
      if (startingCatalogBytes.equals(endingCatalogBytes)) throw failure;
      if (attempt === snapshotLimits.maxAttempts) {
        throw new Error("catalog commit changed during the bounded snapshot read", { cause: failure });
      }
    }
    throw new Error("catalog snapshot retry limit was exhausted");
  }
}

export class FlowArtifactCatalogStore {
  #activityIndexFile;
  #catalogBytes = null;
  #catalog = null;

  constructor({ location, faultInjector } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required for artifact catalog storage");
    location.requireScope("canonical");
    location.assertAuthority();
    this.location = location;
    this.file = new AtomicJsonFile(location.catalogFile, ...(faultInjector ? [{ faultInjector }] : []));
    this.#activityIndexFile = new FlowArtifactActivityIndexFile(location.activitiesFile);
    Object.freeze(this);
  }
  load() {
    return this.#withPublicationLock(() => this.#loadUnlocked());
  }
  #loadUnlocked() {
    this.location.assertAuthority();
    const bytes = this.file.readBytes(null);
    if (bytes === null) return null;
    let catalog = this.#catalogBytes !== null && bytes.equals(this.#catalogBytes)
      ? this.#catalog
      : null;
    if (catalog === null) {
      const value = JSON.parse(bytes.toString("utf8"));
      catalog = new FlowArtifactCatalog(value);
      if (value.hash !== catalog.hash) throw new Error("artifact catalog hash does not match its canonical content");
      this.#catalogBytes = Buffer.from(bytes);
      this.#catalog = catalog;
    }
    return catalog.verify(this.location, this.#activityIndexFile);
  }
  require() {
    return this.#withPublicationLock(() => this.#requireUnlocked());
  }
  #requireUnlocked() {
    const catalog = this.#loadUnlocked();
    if (catalog === null) throw new Error("artifact catalog is required for Version authoritative storage");
    return catalog;
  }
  initialize(catalog, authorization = null) {
    return this.#withPublicationLock(() => {
      if (fs.existsSync(this.location.catalogFile)) throw new Error("artifact catalog is already initialized");
      if (authorization !== MIGRATION_CATALOG_INITIALIZATION) {
        this.#assertSystemSlots(catalog.artifacts.map((artifact) => artifact.slot));
      }
      return this.#saveUnlocked(catalog);
    });
  }
  /**
   * Materialize a complete catalog while a one-way migration owns an
   * unpublished Version root.  Migration-only preserved artifacts have no
   * normal runtime producer, so they cannot be initialized through the
   * ordinary system slot path.  The caller still supplies a fully verified
   * typed catalog; this method does not weaken later publication authority.
   */
  initializeMigration(catalog) {
    return this.initialize(catalog, MIGRATION_CATALOG_INITIALIZATION);
  }
  #saveUnlocked(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) throw new Error("FlowArtifactCatalog is required");
    this.location.assertAuthority();
    fs.mkdirSync(this.location.directory, { recursive: true, mode: 0o755 });
    catalog.verify(this.location, this.#activityIndexFile);
    const value = catalog.toJSON();
    this.file.write(value);
    this.#catalogBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    this.#catalog = catalog;
    return catalog;
  }
  read({ relativePaths = [], read } = {}) {
    if (!Array.isArray(relativePaths) || typeof read !== "function") throw new Error("catalog read requires relativePaths and a read function");
    return this.#withPublicationLock(() => {
      const catalog = this.#requireUnlocked();
      for (const file of relativePaths) catalog.resolve(file);
      return read(catalog);
    });
  }
  relatedActivity(file) {
    const artifactPath = relativePath(file, "artifact relativePath");
    return this.read({
      relativePaths: [artifactPath, FLOW_ACTIVITIES_RELATIVE_PATH],
      read: (catalog) => catalog.relatedActivity(artifactPath, this.location, this.#activityIndexFile),
    });
  }
  publish({ logicalKey = null, relativePath: file, authoritySlot, publicationClaim, mediaType, retention, activityId = null, precondition = null, write } = {}) {
    return this.publishMany({
      artifacts: [{ logicalKey, relativePath: file, authoritySlot, mediaType, retention, activityId }], publicationClaim, precondition, write,
    });
  }
  publishSystem(options = {}) {
    return this.#publishMany({
      ...options, artifacts: [{
        logicalKey: options.logicalKey ?? null, relativePath: options.relativePath, authoritySlot: options.authoritySlot,
        mediaType: options.mediaType, retention: options.retention, activityId: options.activityId ?? null,
      }],
    }, true);
  }
  publishManySystem(options = {}) {
    return this.#publishMany(options, true);
  }
  publishMany({ artifacts, removals = [], publicationClaim, precondition = null, write } = {}) {
    return this.#publishMany({ artifacts, removals, publicationClaim, precondition, write }, false);
  }
  writeIssueSnapshot(text, publicationContext = null) {
    if (typeof text !== "string") throw new Error("issue snapshot text must be a string");
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("issue.snapshot");
    const write = () => new AtomicFile(this.location.issueSnapshotFile, { phaseNamespace: "issue-snapshot" })
      .write(Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8"));
    if (publicationContext !== null) {
      if (!(publicationContext instanceof FlowArtifactPublicationContext)) {
        throw new Error("issue snapshot update requires a FlowArtifactPublicationContext");
      }
      return this.publish({
        ...publicationContext.publication(artifact, { mediaType: "text/markdown" }),
        write,
      });
    }
    return this.publishSystem({
      logicalKey: artifact.logicalKey,
      relativePath: artifact.relativePath,
      authoritySlot: artifact.authoritySlot(),
      mediaType: "text/markdown",
      retention: artifact.contract.retention.toString(),
      write,
    });
  }
  readIssueSnapshot() {
    return this.read({ relativePaths: [FLOW_ARTIFACT_CONTRACTS.resolve("issue.snapshot").relativePath], read: () => fs.readFileSync(this.location.issueSnapshotFile, "utf8") });
  }
  #publishMany({ artifacts, removals = [], publicationClaim = null, precondition = null, write } = {}, system) {
    if (typeof write !== "function") throw new Error("catalog publication requires a write function");
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("catalog publication requires artifacts");
    if (!Array.isArray(removals)) throw new Error("catalog publication removals must be an array");
    for (const artifact of artifacts) {
      if (!(artifact.authoritySlot instanceof ArtifactAuthoritySlot)) throw new Error("catalog publication requires explicit ArtifactAuthoritySlot values");
    }
    const normalizedRemovals = removals.map((removal) => {
      if (!isPlainObject(removal)) throw new Error("catalog publication removal must be an object");
      return Object.freeze({
        relativePath: relativePath(removal.relativePath, "artifact removal relativePath"),
        logicalKey: removal.logicalKey == null ? null : text(removal.logicalKey, "artifact removal logicalKey"),
      });
    });
    if (system) this.#assertSystemSlots(artifacts.map((artifact) => artifact.authoritySlot));
    else {
      if (!(publicationClaim instanceof ArtifactPublicationClaim)) throw new Error("catalog publication requires an ArtifactPublicationClaim");
      for (const artifact of artifacts) {
        const contract = artifact.logicalKey === null ? null : FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey);
        if (contract?.logicalKey.toString() === "review.evidence") {
          FlowArtifactReviewEvidence.fromCanonicalPath(contract, artifact.relativePath).assertAuthoritySlot(artifact.authoritySlot);
        }
        contract?.assertAuthoritySlot(artifact.relativePath, artifact.authoritySlot);
        publicationClaim.assertSlot(artifact.authoritySlot, {
          contractBound: contract !== null,
          logicalKey: artifact.logicalKey,
        });
      }
    }
    if (precondition !== null && typeof precondition !== "function") throw new Error("catalog publication precondition must be a function");
    return this.#withPublicationLock(() => {
      const paths = new Set([
        ...artifacts.map((artifact) => relativePath(artifact.relativePath, "artifact relativePath")),
        ...normalizedRemovals.map((removal) => removal.relativePath),
      ]);
      if (paths.size !== artifacts.length + normalizedRemovals.length) {
        throw new Error("catalog publication cannot write and remove the same artifact path");
      }
      for (const file of paths) this.location.assertAuthority(file);
      this.location.assertAuthority(ARTIFACT_CATALOG_RELATIVE_PATH);
      const snapshot = new VersionTreeSnapshot(this.location);
      const previous = this.#requireUnlocked();
      precondition?.(previous);
        for (const artifact of artifacts) {
          if (artifact.logicalKey === null) continue;
          FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey).assertPublicationRole({
            exists: previous.artifacts.some((entry) => entry.relativePath === artifact.relativePath),
            publicationStep: artifact.authoritySlot.publicationStep,
          });
        }
        for (const removal of normalizedRemovals) {
          const prior = previous.artifacts.find((entry) => entry.relativePath === removal.relativePath);
          if (prior === undefined) {
            throw new Error(`catalog removal requires an existing artifact: ${removal.relativePath}`);
          }
          if (removal.logicalKey !== null && prior.logicalKey !== removal.logicalKey) {
            throw new Error(`catalog removal logical key does not match its existing artifact: ${removal.relativePath}`);
          }
          if (prior.logicalKey !== null) {
            const contract = FLOW_ARTIFACT_CONTRACTS.require(prior.logicalKey);
            contract.assertPublicationRole({ exists: true, publicationStep: prior.slot.publicationStep });
          }
          if (system) this.#assertSystemSlots([prior.slot]);
          else publicationClaim.assertSlot(prior.slot, {
            contractBound: prior.logicalKey !== null,
            logicalKey: prior.logicalKey,
          });
        }
        const contentPublications = artifacts.flatMap((artifact) => {
          const contract = artifact.logicalKey === null ? null : FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey);
          return contract?.contentContract == null ? [] : [{ artifact, contract }];
        });
        const previousContent = new Map();
        for (const { artifact } of contentPublications) {
          const prior = previous.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
          previousContent.set(artifact.relativePath, prior === undefined ? null : fs.readFileSync(this.location.resolve(artifact.relativePath)));
        }
      return this.#executeCatalogTransaction(snapshot, previous.hash, write, () => {
        snapshot.assertOnlyDeclaredChanges(paths);
        for (const removal of normalizedRemovals) {
          if (fs.existsSync(this.location.resolve(removal.relativePath))) {
            throw new Error(`catalog removal left its artifact visible: ${removal.relativePath}`);
          }
        }
        for (const { artifact, contract } of contentPublications) {
          contract.assertContentPublication(
            previousContent.get(artifact.relativePath) ?? null,
            fs.readFileSync(this.location.resolve(artifact.relativePath)),
          );
        }
        const descriptors = artifacts.map((artifact) => {
          const prior = previous.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
          const activityId = artifact.activityId ?? (
            prior?.activityId == null ? null : new FlowActivityId(prior.activityId)
          );
          return FlowArtifactDescriptor.fromFile({
            location: this.location,
            ...artifact,
            activityId,
            migrationMaterialization: prior?.migrationMaterialization === true,
          });
        });
        for (const descriptor of descriptors) {
          if (descriptor.logicalKey === null) continue;
          const contract = FLOW_ARTIFACT_CONTRACTS.require(descriptor.logicalKey);
          const prior = previous.artifacts.find((entry) => entry.relativePath === descriptor.relativePath);
          contract.mutationPolicy.assertPublication(prior, descriptor);
          const changed = prior !== undefined && (prior.hash !== descriptor.hash || prior.size !== descriptor.size);
          if (contract.cataloged && changed && descriptor.activityId === null) {
            throw new Error(`artifact content update requires its updater Activity: ${descriptor.relativePath}`);
          }
        }
        const associated = descriptors.filter((descriptor) => descriptor.activityId !== null);
        if (associated.length > 0) {
          const activityIndex = this.#activityIndexFile.read();
          for (const descriptor of associated) {
            const nextActivity = activityIndex.require(descriptor.activityId).assertRelatedArtifact(descriptor);
            const prior = previous.artifacts.find((entry) => entry.relativePath === descriptor.relativePath);
            if (prior?.activityId) {
              if (prior.activityId === descriptor.activityId) {
                if (prior.hash !== descriptor.hash || prior.size !== descriptor.size) {
                  throw new Error("artifact content update must reference a new updater Activity");
                }
              } else {
                nextActivity.assertLaterThan(activityIndex.require(prior.activityId));
              }
            }
          }
        }
        const catalog = new FlowArtifactCatalog({
          artifacts: [...previous.artifacts.filter((artifact) => !paths.has(artifact.relativePath)), ...descriptors],
        });
        return catalog;
      });
    });
  }
  unpublish({ relativePath: file, publicationClaim, allowedKinds = null, write } = {}) {
    return this.#unpublish({ relativePath: file, publicationClaim, allowedKinds, write }, false);
  }
  #unpublish({ relativePath: file, publicationClaim = null, allowedKinds = null, write } = {}, system) {
    if (typeof write !== "function") throw new Error("catalog unpublication requires a write function");
    if (!system && !(publicationClaim instanceof ArtifactPublicationClaim)) throw new Error("catalog unpublication requires an ArtifactPublicationClaim");
    const safePath = relativePath(file, "artifact relativePath");
    if (!catalogManagedPath(safePath) || safePath === ARTIFACT_CATALOG_RELATIVE_PATH || VERSION_TRANSIENT_FILES.has(safePath)) {
      throw new Error(`catalog unpublication requires a managed artifact path: ${safePath}`);
    }
    return this.#withPublicationLock(() => {
      this.location.assertAuthority(safePath, { mustExist: true });
      const snapshot = new VersionTreeSnapshot(this.location);
      const previous = this.#requireUnlocked();
      const artifact = previous.resolve(safePath);
      if (allowedKinds !== null && allowedKinds.has(artifact.kind)) {
        throw new Error("system unpublication is not authorized for this artifact kind");
      }
      if (system) this.#assertSystemSlots([artifact.slot]);
      else publicationClaim.assertSlot(artifact.slot);
      return this.#executeCatalogTransaction(snapshot, previous.hash, write, () => {
        snapshot.assertOnlyDeclaredChanges(new Set([safePath]));
        if (fs.existsSync(this.location.resolve(safePath))) throw new Error(`unpublished artifact still exists: ${safePath}`);
        return new FlowArtifactCatalog({ artifacts: previous.artifacts.filter((artifact) => artifact.relativePath !== safePath) });
      });
    });
  }
  #executeCatalogTransaction(snapshot, baselineCatalogHash, write, validateAndBuildCatalog) {
    const transaction = this.#beginTransaction(snapshot, baselineCatalogHash);
    let catalogCommitted = false;
    try {
      const result = write();
      const catalog = validateAndBuildCatalog();
      transaction.prepare(catalog.hash);
      this.#saveUnlocked(catalog);
      catalogCommitted = true;
      transaction.finish();
      return Object.freeze({ result, catalog });
    } catch (error) {
      if (catalogCommitted) { transaction.abandon(); throw error; }
      try { snapshot.restore(); } catch (rollbackError) {
        transaction.abandon();
        throw new AggregateError([error, rollbackError], "artifact catalog publication authority corrupted during rollback", { cause: error });
      }
      transaction.finish();
      throw error;
    }
  }
  unpublishSystem(options = {}) {
    return this.#unpublish({ ...options, allowedKinds: STEP_OWNED_ARTIFACT_KINDS }, true);
  }
  #assertSystemSlots(slots) {
    if (slots.some((slot) => (
      !(slot instanceof ArtifactAuthoritySlot)
      || slot.publicationStep !== "system"
      || STEP_OWNED_ARTIFACT_KINDS.has(slot.kind)
    ))) throw new Error("system publication is not authorized for one or more artifact kinds");
  }
  #transactionFile() {
    const runtimeDirectory = this.location.runtimeLock("runtime.lock.artifact-catalog").runtimeDirectory;
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o755 });
    return new AtomicJsonFile(path.join(runtimeDirectory, "catalog-transaction.json"));
  }
  #beginTransaction(snapshot, baselineCatalogHash) {
    const file = this.#transactionFile();
    if (ACTIVE_VERSION_TRANSACTIONS.has(file.filePath)) throw new Error("nested Version catalog transaction is not allowed");
    ACTIVE_VERSION_TRANSACTIONS.add(file.filePath);
    const document = {
      version: 1,
      location: { specId: this.location.specId.toString(), version: this.location.version.toString(), relativeDirectory: this.location.relativeDirectory },
      baselineCatalogHash,
      targetCatalogHash: null,
      snapshot: snapshot.toJSON(),
    };
    try { file.write({ ...document, digest: sha256(Buffer.from(JSON.stringify(document), "utf8")) }); }
    catch (error) { ACTIVE_VERSION_TRANSACTIONS.delete(file.filePath); throw error; }
    return new VersionCatalogTransactionJournal({ file, document });
  }
  #recoverTransaction() {
    const file = this.#transactionFile();
    if (ACTIVE_VERSION_TRANSACTIONS.has(file.filePath)) throw new Error("nested Version catalog access during a transaction is not allowed");
    const stored = file.read(null);
    if (stored === null) return;
    const { digest: storedDigest, ...document } = stored;
    if (Object.keys(stored).sort().join(",") !== "baselineCatalogHash,digest,location,snapshot,targetCatalogHash,version"
      || storedDigest !== sha256(Buffer.from(JSON.stringify(document), "utf8"))
      || document.version !== 1 || !/^[a-f0-9]{64}$/.test(document.baselineCatalogHash)
      || (document.targetCatalogHash !== null && !/^[a-f0-9]{64}$/.test(document.targetCatalogHash))) {
      throw new Error("Version transaction journal integrity is invalid");
    }
    if (document.location?.specId !== this.location.specId.toString()
      || document.location?.version !== this.location.version.toString()
      || document.location?.relativeDirectory !== this.location.relativeDirectory) {
      throw new Error("Version transaction journal location binding is invalid");
    }
    const storedCatalog = this.file.read(null);
    const parsedCatalog = storedCatalog === null ? null : new FlowArtifactCatalog(storedCatalog);
    if (parsedCatalog !== null && parsedCatalog.hash !== storedCatalog.hash) throw new Error("Version transaction visible catalog hash is invalid");
    const visibleHash = parsedCatalog?.hash ?? null;
    const committed = document.targetCatalogHash !== null && visibleHash === document.targetCatalogHash;
    if (committed) parsedCatalog.verify(this.location, this.#activityIndexFile);
    else if (visibleHash === document.baselineCatalogHash) VersionTreeSnapshot.fromStored(this.location, document.snapshot).restore();
    else throw new Error("Version transaction visible catalog has an unknown commit identity");
    file.remove();
    this.#catalog = null;
    this.#catalogBytes = null;
  }
  #withPublicationLock(operation) {
    this.location.assertAuthority(null, { mustExist: true });
    if (!fs.lstatSync(this.location.directory).isDirectory()) throw new Error("Version root must be an existing real directory");
    const directoryAuthority = new RealDirectoryAuthority(this.location.directory);
    const runtimeLock = this.location.runtimeLock("runtime.lock.artifact-catalog");
    const runtimeDirectory = runtimeLock.runtimeDirectory;
    const lockDirectory = runtimeLock.directory;
    // Establish the non-authoritative runtime branch before its identity is
    // captured.  Publication never treats these files as catalog entries.
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o755 });
    const runtimeAuthority = new RealDirectoryAuthority(runtimeDirectory, { parentAuthority: directoryAuthority });
    const lockDirectoryAuthority = new RealDirectoryAuthority(lockDirectory, { parentAuthority: runtimeAuthority });
    const lock = new FileLock({
      directoryAuthority: lockDirectoryAuthority, fileName: runtimeLock.fileName, kind: "artifact-catalog-publication",
      authority: { directory: this.location.directory, runtimeDirectory, catalog: this.location.catalogFile },
      waitPolicy: new FileLockWaitPolicy({
        timeoutMs: CATALOG_LOCK_WAIT_TIMEOUT_MS,
        intervalMs: CATALOG_LOCK_RETRY_INTERVAL_MS,
      }),
      errorFactory: artifactCatalogLockError,
    });
    return lock.runExclusive(() => {
      this.#recoverTransaction();
      return operation();
    });
  }
}

export class FlowVersionMigrationClassification {
  constructor({ value, sourcePath = null, target, blockers = [] } = {}) {
    if (!MIGRATION_CLASSIFICATIONS.has(value)) throw new Error(`invalid Flow Version migration classification: ${value}`);
    if (!(target instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required for migration classification");
    target.requireScope("canonical");
    this.value = value;
    this.sourcePath = sourcePath == null ? null : text(sourcePath, "migration sourcePath");
    this.target = target;
    if (!Array.isArray(blockers)) throw new Error("migration blockers must be an array");
    this.blockers = Object.freeze(blockers.map((blocker) => (
      blocker instanceof FlowVersionMigrationBlocker ? blocker : new FlowVersionMigrationBlocker(blocker)
    )));
    Object.freeze(this);
  }
  get migratable() { return this.value === "legacy" && this.blockers.length === 0; }
  toJSON() {
    return {
      classification: this.value, sourcePath: this.sourcePath,
      targetDirectory: this.target.relativeDirectory, migratable: this.migratable,
      blockers: this.blockers.map((blocker) => blocker.toJSON()),
    };
  }
}

export class FlowVersionMigrationBlocker {
  constructor({ code, path: artifactPath = null, message } = {}) {
    this.code = identifier(code, "migration blocker code");
    this.path = artifactPath == null ? null : relativePath(artifactPath, "migration blocker path");
    this.message = text(message, "migration blocker message");
    Object.freeze(this);
  }
  toJSON() { return { code: this.code, path: this.path, message: this.message }; }
}

export class FlowVersionMigrationBlockerError extends Error {
  constructor(blocker) {
    if (!(blocker instanceof FlowVersionMigrationBlocker)) throw new Error("FlowVersionMigrationBlocker is required");
    super(blocker.message);
    this.name = "FlowVersionMigrationBlockerError";
    this.code = "FLOW_VERSION_MIGRATION_BLOCKED";
    this.blocker = blocker;
  }
}

export class FlowVersionMigrationMappingRule {
  constructor({
    match, source, targetPath = null, targetNamespace = null, role, operation,
    mediaType, authority, cardinality, publicationStep = "system", retention,
    activityId = null, outputKey = null,
  } = {}) {
    if (!new Set(["exact", "namespace"]).has(match)) throw new Error("migration mapping match must be exact or namespace");
    this.match = match;
    this.source = relativePath(source, "migration mapping source");
    this.targetPath = targetPath == null ? null : relativePath(targetPath, "migration mapping targetPath");
    this.targetNamespace = targetNamespace == null ? null : relativePath(targetNamespace, "migration mapping target namespace");
    this.role = text(role, "migration mapping role");
    this.operation = FlowVersionMigrationOperation.from(operation);
    this.mediaType = text(mediaType, "migration mapping mediaType");
    this.authority = ArtifactAuthority.from(authority);
    this.cardinality = ArtifactCardinality.from(cardinality);
    this.publicationStep = publicationStep === "system" ? "system" : identifier(publicationStep, "migration mapping publicationStep");
    this.retention = identifier(retention, "migration mapping retention");
    if (activityId !== null && !(activityId instanceof FlowActivityId)) throw new Error("migration mapping activity association requires FlowActivityId");
    this.activityId = activityId;
    this.outputKey = outputKey == null ? null : identifier(outputKey, "migration mapping outputKey");
    if (this.operation.value === "generate") throw new Error("source migration mappings cannot generate artifacts");
    if (this.operation.value === "transform" && this.outputKey === null) throw new Error("transform migration mapping requires an outputKey");
    if (this.operation.value !== "transform" && this.outputKey !== null) throw new Error("migration mapping outputKey is only valid for transform operations");
    if (this.operation.value === "exclude-runtime") {
      if (this.targetPath !== null || this.targetNamespace !== null) throw new Error("exclude-runtime mapping must not have a target");
    } else if (this.match === "exact" ? this.targetPath === null : this.targetNamespace === null) {
      throw new Error("migration mapping target is required");
    }
    Object.freeze(this);
  }
  matches(sourcePath) {
    return this.match === "exact" ? sourcePath === this.source : sourcePath.startsWith(`${this.source}/`);
  }
  map(sourcePath) {
    if (!this.matches(sourcePath)) return null;
    const targetPath = this.operation.value === "exclude-runtime" ? null
      : this.match === "exact" ? this.targetPath
        : path.posix.join(this.targetNamespace, sourcePath.slice(this.source.length + 1));
    const memberId = this.cardinality.value === "collection" ? sha256(Buffer.from(targetPath ?? sourcePath, "utf8")) : null;
    return {
      role: this.role,
      targetPath,
      operation: this.operation,
      mediaType: this.mediaType,
      authoritySlot: new ArtifactAuthoritySlot({
        kind: this.role, authority: this.authority, cardinality: this.cardinality,
        memberId, publicationStep: this.publicationStep,
      }),
      retention: this.retention,
      activityId: this.activityId,
      outputKey: this.outputKey,
    };
  }
}

export class FlowVersionMigrationSourcePolicy {
  constructor({ rules = [] } = {}) {
    if (!Array.isArray(rules) || rules.some((rule) => !(rule instanceof FlowVersionMigrationMappingRule))) {
      throw new Error("migration source policy requires typed mapping rules");
    }
    this.rules = Object.freeze([...rules]);
    Object.freeze(this);
  }
  map(sourcePath) {
    const matches = this.rules.map((rule) => rule.map(sourcePath)).filter(Boolean);
    if (matches.length > 1) throw new Error(`ambiguous migration mapping rules for ${sourcePath}`);
    return matches[0] ?? null;
  }
  ownsDirectory(sourcePath) {
    return this.rules.some((rule) => (
      rule.match === "namespace"
        ? sourcePath === rule.source || sourcePath.startsWith(`${rule.source}/`) || rule.source.startsWith(`${sourcePath}/`)
        : rule.source.startsWith(`${sourcePath}/`)
    ));
  }
}

export class FlowVersionMigrationOperation {
  constructor(value) {
    this.value = text(value, "migration operation");
    if (!MIGRATION_OPERATIONS.has(this.value)) throw new Error(`unsupported migration operation: ${this.value}`);
    Object.freeze(this);
  }
  static copy() { return new FlowVersionMigrationOperation("copy"); }
  static transform() { return new FlowVersionMigrationOperation("transform"); }
  static generate() { return new FlowVersionMigrationOperation("generate"); }
  static excludeRuntime() { return new FlowVersionMigrationOperation("exclude-runtime"); }
  static from(value) { return value instanceof FlowVersionMigrationOperation ? value : new FlowVersionMigrationOperation(value); }
  toJSON() { return this.value; }
}

export class FlowVersionMigrationArtifact {
  constructor({ role, sourcePath, targetPath = null, operation, sourceHash, size, mediaType, authoritySlot, retention, activityId = null, outputKey = null } = {}) {
    if (!MIGRATION_ARTIFACT_ROLES.has(role)) throw new Error(`unknown migration artifact role: ${role}`);
    this.role = role;
    this.sourcePath = relativePath(sourcePath, "migration source artifact path");
    this.operation = FlowVersionMigrationOperation.from(operation);
    this.targetPath = targetPath == null ? null : relativePath(targetPath, "migration target artifact path");
    if (this.operation.value === "exclude-runtime" ? this.targetPath !== null : this.targetPath === null) {
      throw new Error("migration operation target presence is inconsistent");
    }
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("migration sourceHash must be a lowercase SHA-256 digest");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("migration source size must be a non-negative safe integer");
    this.sourceHash = sourceHash;
    this.size = size;
    this.mediaType = text(mediaType, "migration mediaType");
    if (!(authoritySlot instanceof ArtifactAuthoritySlot)) throw new Error("migration ArtifactAuthoritySlot is required");
    this.authoritySlot = authoritySlot;
    this.authority = authoritySlot.authority;
    this.retention = identifier(retention, "migration retention");
    let contract = null;
    const migrationMaterialization = this.targetPath === "flow-migration-report.json" || this.targetPath?.startsWith("artifacts/migration/") === true;
    if (this.targetPath !== null && !migrationMaterialization) {
      try { contract = FLOW_ARTIFACT_CONTRACTS.classify(this.targetPath); } catch {
        throw new Error(`migration target must resolve to a canonical artifact contract: ${this.targetPath}`);
      }
    }
    if (contract !== null && (
      contract.authoritySlot.kind !== authoritySlot.kind
      || contract.authoritySlot.authority.toString() !== authoritySlot.authority.toString()
      || contract.authoritySlot.cardinality.toString() !== authoritySlot.cardinality.toString()
      || contract.retention.toString() !== this.retention
    )) throw new Error(`migration metadata does not match artifact contract: ${contract.logicalKey}`);
    this.logicalKey = contract?.logicalKey.toString() ?? null;
    if (activityId !== null && !(activityId instanceof FlowActivityId)) throw new Error("migration activity association requires FlowActivityId");
    this.activityId = activityId;
    this.outputKey = outputKey == null ? null : identifier(outputKey, "migration artifact outputKey");
    if (this.operation.value === "transform" && this.outputKey === null) throw new Error("transform migration artifact requires an outputKey");
    if (this.operation.value !== "transform" && this.outputKey !== null) throw new Error("migration artifact outputKey is only valid for transform operations");
    const roleMatches = role === "flow-state" ? contract?.logicalKey.toString() === "flow.state"
      : role === "activity-ledger" ? contract?.logicalKey.toString() === "flow.activities"
        : role === "spec-record" ? contract?.logicalKey.toString() === "spec.record"
          : role === "issue-log" ? contract?.logicalKey.toString() === "issue.log"
            : role === "review-evidence" ? contract?.logicalKey.toString() === "review.evidence"
              : role === "artifact" ? contract !== null || migrationMaterialization
                : role === "runtime" && this.operation.value === "exclude-runtime" && this.targetPath === null;
    if (!roleMatches) {
      throw new Error(`migration target does not match its role: ${this.targetPath}`);
    }
    Object.freeze(this);
  }
  verifySource(sourceRoot) {
    const file = path.join(sourceRoot, ...this.sourcePath.split("/"));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`migration source authority changed: ${this.sourcePath}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== this.size || sha256(bytes) !== this.sourceHash) throw new Error(`migration source drift detected: ${this.sourcePath}`);
    return bytes;
  }
  toJSON() {
    return {
      role: this.role, logicalKey: this.logicalKey, sourcePath: this.sourcePath, targetPath: this.targetPath,
      operation: this.operation.toJSON(), sourceHash: this.sourceHash, size: this.size,
      mediaType: this.mediaType, authoritySlot: { kind: this.authoritySlot.kind, ...this.authoritySlot.toJSON() },
      retention: this.retention, activityId: this.activityId?.toJSON() ?? null,
      outputKey: this.outputKey,
      cataloged: this.role !== "runtime",
    };
  }
}

export class FlowVersionGeneratedArtifact {
  constructor({ role, targetPath, operation = FlowVersionMigrationOperation.generate(), mediaType, authoritySlot, retention, activityId = null, outputKey, cataloged = true } = {}) {
    this.role = identifier(role, "generated migration artifact role");
    this.targetPath = relativePath(targetPath, "generated migration artifact path");
    this.operation = FlowVersionMigrationOperation.from(operation);
    if (this.operation.value !== "generate") throw new Error("generated migration artifact requires generate operation");
    this.mediaType = text(mediaType, "generated migration mediaType");
    if (!(authoritySlot instanceof ArtifactAuthoritySlot)) throw new Error("generated migration ArtifactAuthoritySlot is required");
    this.authoritySlot = authoritySlot;
    this.retention = identifier(retention, "generated migration retention");
    if (activityId !== null && !(activityId instanceof FlowActivityId)) throw new Error("generated activity association requires FlowActivityId");
    this.activityId = activityId;
    this.outputKey = identifier(outputKey, "generated migration outputKey");
    if (cataloged && !catalogManagedPath(this.targetPath)) throw new Error(`generated artifact is outside catalog-managed storage: ${this.targetPath}`);
    this.cataloged = cataloged === true;
    Object.freeze(this);
  }
  toJSON() {
    return {
      role: this.role, targetPath: this.targetPath, operation: this.operation.toJSON(),
      mediaType: this.mediaType, authoritySlot: { kind: this.authoritySlot.kind, ...this.authoritySlot.toJSON() },
      retention: this.retention, activityId: this.activityId?.toJSON() ?? null, cataloged: this.cataloged,
      outputKey: this.outputKey,
    };
  }
}

function migrationBlocker(code, sourcePath, message) {
  return new FlowVersionMigrationBlockerError(new FlowVersionMigrationBlocker({ code, path: sourcePath, message }));
}

const BUILTIN_MIGRATION_SOURCE_POLICY = new FlowVersionMigrationSourcePolicy({ rules: [
  new FlowVersionMigrationMappingRule({ match: "exact", source: "flow.json", targetPath: "flow.json", role: "flow-state", operation: "transform", outputKey: "current-flow-state", mediaType: "application/json", authority: "repository-metadata", cardinality: "singleton", retention: "permanent" }),
  new FlowVersionMigrationMappingRule({ match: "exact", source: "activities.jsonl", targetPath: FLOW_ACTIVITIES_RELATIVE_PATH, role: "activity-ledger", operation: "copy", mediaType: "application/x-ndjson", authority: "canonical-flow-artifacts", cardinality: "singleton", retention: "permanent" }),
  new FlowVersionMigrationMappingRule({ match: "exact", source: "spec.json", targetPath: "spec.json", role: "spec-record", operation: "transform", outputKey: "authoritative-spec-record", mediaType: "application/json", authority: "repository-metadata", cardinality: "singleton", retention: "permanent" }),
  new FlowVersionMigrationMappingRule({ match: "exact", source: "issue-log.json", targetPath: "issue-log.json", role: "issue-log", operation: "copy", mediaType: "application/json", authority: "canonical-flow-artifacts", cardinality: "singleton", retention: "permanent" }),
  new FlowVersionMigrationMappingRule({ match: "namespace", source: ".runtime", role: "runtime", operation: "exclude-runtime", mediaType: "application/octet-stream", authority: "execution-checkout", cardinality: "collection", retention: "transient" }),
  new FlowVersionMigrationMappingRule({ match: "namespace", source: "artifacts", targetNamespace: "artifacts/migration", role: "artifact", operation: "copy", mediaType: "application/octet-stream", authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent" }),
] });

function classifyMigrationArtifact(sourcePath, sourcePolicy) {
  if (sourcePath === "manifest.md" || sourcePath === "manifest.json") {
    throw migrationBlocker("FORBIDDEN_MANIFEST", sourcePath, `forbidden legacy migration artifact: ${sourcePath}`);
  }
  if (sourcePath === "flow-version.json" || sourcePath === ARTIFACT_CATALOG_RELATIVE_PATH) {
    throw migrationBlocker("RESERVED_VERSION_ARTIFACT", sourcePath, `legacy source contains reserved Version artifact: ${sourcePath}`);
  }
  const sourceName = path.posix.basename(sourcePath);
  if (
    VERSION_TRANSIENT_FILES.has(sourcePath)
    || sourceName.endsWith(".lock")
    || sourceName.endsWith(".tmp")
    || sourceName.endsWith(".transaction")
    || sourceName.includes(".transaction.")
    || sourceName.includes(".lock.")
    || sourceName.includes(".tmp.")
  ) {
    throw migrationBlocker("ACTIVE_TRANSACTION_MARKER", sourcePath, `active legacy transaction marker blocks migration: ${sourcePath}`);
  }
  const builtin = BUILTIN_MIGRATION_SOURCE_POLICY.map(sourcePath);
  if (builtin?.operation.value === "exclude-runtime") return builtin;
  if (sourcePath.split("/").some((segment) => segment.startsWith("."))) {
    throw migrationBlocker("UNKNOWN_HIDDEN_ARTIFACT", sourcePath, `unknown hidden legacy artifact blocks migration: ${sourcePath}`);
  }
  const mapped = builtin ?? sourcePolicy.map(sourcePath);
  if (mapped) return mapped;
  throw migrationBlocker("UNKNOWN_VISIBLE_ARTIFACT", sourcePath, `unknown visible legacy artifact blocks migration: ${sourcePath}`);
}

export class FlowVersionMigrationInspection {
  constructor({ classification, artifacts = [], inventory, sourcePolicy, semanticValidator, outputBuilder } = {}) {
    if (!(classification instanceof FlowVersionMigrationClassification)) throw new Error("FlowVersionMigrationClassification is required");
    this.classification = classification;
    this.artifacts = Object.freeze(artifacts.map((artifact) => artifact instanceof FlowVersionMigrationArtifact ? artifact : new FlowVersionMigrationArtifact(artifact)));
    if (!(inventory instanceof FlowVersionMigrationInventory)) throw new Error("FlowVersionMigrationInventory is required");
    this.inventory = inventory;
    this.sourcePolicy = sourcePolicy;
    this.semanticValidator = semanticValidator;
    this.outputBuilder = outputBuilder;
    Object.freeze(this);
  }
  plan() {
    return new FlowVersionMigrationPlan({
      classification: this.classification, artifacts: this.artifacts, inventory: this.inventory,
      sourcePolicy: this.sourcePolicy, semanticValidator: this.semanticValidator, outputBuilder: this.outputBuilder,
    });
  }
  toJSON() {
    return {
      ...this.classification.toJSON(), inventory: this.inventory.toJSON(),
      artifacts: this.artifacts.map((artifact) => artifact.toJSON()),
    };
  }
}

export class FlowVersionMigrationInventoryEntry {
  constructor({ sourcePath, entryType, hash = null, size = 0 } = {}) {
    this.sourcePath = relativePath(sourcePath, "migration inventory sourcePath");
    if (!new Set(["file", "directory", "symlink", "special"]).has(entryType)) throw new Error("invalid migration inventory entry type");
    this.entryType = entryType;
    if (hash !== null && !/^[a-f0-9]{64}$/.test(hash)) throw new Error("migration inventory hash must be SHA-256");
    this.hash = hash;
    this.size = size;
    Object.freeze(this);
  }
  toJSON() { return { sourcePath: this.sourcePath, entryType: this.entryType, hash: this.hash, size: this.size }; }
}

export class FlowVersionMigrationInventory {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new Error("migration inventory entries must be an array");
    this.entries = Object.freeze(entries.map((entry) => entry instanceof FlowVersionMigrationInventoryEntry ? entry : new FlowVersionMigrationInventoryEntry(entry))
      .sort((left, right) => codeUnitOrder(left.sourcePath, right.sourcePath)));
    const paths = new Set();
    for (const entry of this.entries) {
      if (paths.has(entry.sourcePath)) throw new Error(`duplicate migration inventory path: ${entry.sourcePath}`);
      paths.add(entry.sourcePath);
    }
    this.treeDigest = sha256(Buffer.from(JSON.stringify(this.entries.map((entry) => entry.toJSON())), "utf8"));
    Object.freeze(this);
  }
  toJSON() { return { treeDigest: this.treeDigest, entries: this.entries.map((entry) => entry.toJSON()) }; }
}

function portablePathSegments(value) {
  return value.split("/").map((segment) => segment.normalize("NFKC").toLocaleLowerCase("en-US"));
}

function portablePathConflict(left, right) {
  const a = portablePathSegments(left);
  const b = portablePathSegments(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export class FlowVersionMigrationClassifier {
  constructor({ target, sourcePolicy = new FlowVersionMigrationSourcePolicy(), semanticValidator = null, outputBuilder = null } = {}) {
    if (!(target instanceof FlowVersionLocation)) throw new Error("FlowVersionLocation is required for migration classification");
    target.requireScope("canonical");
    if (!(sourcePolicy instanceof FlowVersionMigrationSourcePolicy)) throw new Error("FlowVersionMigrationSourcePolicy is required");
    this.target = target;
    this.sourcePolicy = sourcePolicy;
    if (semanticValidator !== null && !(semanticValidator instanceof FlowVersionSemanticValidator)) {
      throw new Error("FlowVersionSemanticValidator is required");
    }
    this.semanticValidator = semanticValidator;
    if (outputBuilder !== null && !(outputBuilder instanceof FlowVersionMigrationOutputBuilder)) throw new Error("FlowVersionMigrationOutputBuilder is required");
    this.outputBuilder = outputBuilder;
    Object.freeze(this);
  }
  inspect(sourceDirectory) {
    const root = path.resolve(text(sourceDirectory, "migration source directory"));
    let sourcePresent = false;
    const sourceBlockers = [];
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
        sourceBlockers.push(new FlowVersionMigrationBlocker({
          code: "UNSAFE_SOURCE_ROOT", message: "migration source root and ancestors must be canonical real directories",
        }));
      }
      sourcePresent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const targetStatus = this.#targetStatus();
    const scan = sourcePresent && sourceBlockers.length === 0
      ? this.#artifacts(root)
      : { artifacts: [], blockers: [], inventory: new FlowVersionMigrationInventory() };
    const blockers = [...sourceBlockers, ...scan.blockers, ...targetStatus.blockers];
    let value;
    if (targetStatus.present && !targetStatus.valid) value = "conflict";
    else if (sourcePresent && targetStatus.valid) {
      value = "conflict";
      blockers.push(new FlowVersionMigrationBlocker({
        code: "SOURCE_TARGET_CONFLICT", message: "legacy source and complete Version target both exist",
      }));
    } else if (targetStatus.valid) value = "versioned";
    else if (sourcePresent) value = "legacy";
    else value = "fresh";
    if (sourcePresent) {
      if (this.semanticValidator === null) blockers.push(new FlowVersionMigrationBlocker({ code: "MISSING_SEMANTIC_VALIDATOR", message: "migration planning requires a semantic validator" }));
      if (this.outputBuilder === null) blockers.push(new FlowVersionMigrationBlocker({ code: "MISSING_OUTPUT_BUILDER", message: "migration planning requires an output builder" }));
      for (const requiredRole of ["flow-state", "spec-record"]) {
        if (!scan.artifacts.some((artifact) => artifact.role === requiredRole)) {
          blockers.push(new FlowVersionMigrationBlocker({
            code: "MISSING_SOURCE_AUTHORITY", message: `legacy source is missing required ${requiredRole}`,
          }));
        }
      }
      const targeted = scan.artifacts.filter((artifact) => artifact.targetPath !== null);
      const authorityClaims = new Map();
      for (let left = 0; left < targeted.length; left += 1) {
        for (let right = left + 1; right < targeted.length; right += 1) {
          const sameAggregate = sameMigrationAggregate(targeted[left], targeted[right]);
          if (!sameAggregate && portablePathConflict(targeted[left].targetPath, targeted[right].targetPath)) {
            blockers.push(new FlowVersionMigrationBlocker({
              code: "PORTABLE_TARGET_COLLISION",
              path: targeted[right].sourcePath,
              message: `portable migration target collision: ${targeted[left].targetPath} / ${targeted[right].targetPath}`,
            }));
          }
        }
      }
      for (const artifact of targeted) {
        const claim = artifact.authoritySlot.claimKey();
        const existing = authorityClaims.get(claim);
        const sameAggregate = existing && sameMigrationAggregate(existing, artifact);
        if (existing && !sameAggregate) blockers.push(new FlowVersionMigrationBlocker({
          code: "DUPLICATE_AUTHORITY_SLOT", path: artifact.sourcePath,
          message: `duplicate migration authority slot: ${artifact.authoritySlot.kind}/${artifact.authoritySlot.authority}`,
        }));
        else authorityClaims.set(claim, artifact);
      }
    }
    const classification = new FlowVersionMigrationClassification({
      value, sourcePath: sourcePresent ? root : null, target: this.target, blockers,
    });
    const artifacts = value === "legacy" ? scan.artifacts : [];
    return new FlowVersionMigrationInspection({
      classification, artifacts, inventory: scan.inventory,
      sourcePolicy: this.sourcePolicy, semanticValidator: this.semanticValidator, outputBuilder: this.outputBuilder,
    });
  }
  #targetStatus() {
    try { this.target.assertAuthority(); } catch (error) {
      return {
        present: true,
        valid: false,
        blockers: [new FlowVersionMigrationBlocker({
          code: "INVALID_VERSION_TARGET", message: `existing Version target is unsafe: ${error.message}`,
        })],
      };
    }
    let present = false;
    try { fs.lstatSync(this.target.directory); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!present) return { present: false, valid: false, blockers: [] };
    try {
      this.target.assertAuthority(null, { mustExist: true });
      if (!fs.lstatSync(this.target.directory).isDirectory()) throw new Error("Version target is not a directory");
      const catalog = new FlowArtifactCatalogStore({ location: this.target }).require();
      for (const required of [FLOW_STATE_RELATIVE_PATH, FLOW_ACTIVITIES_RELATIVE_PATH, SPEC_RECORD_RELATIVE_PATH]) catalog.resolve(required);
      const spec = new AuthoritativeSpecRecord(JSON.parse(fs.readFileSync(this.target.specFile, "utf8")));
      if (!spec.specId.equals(this.target.specId)) throw new Error("Version Spec identity does not match target");
      if (this.semanticValidator === null) throw new Error("Version target semantic validator is unavailable");
      this.semanticValidator.validateMaterialized({ location: this.target, spec });
      return { present: true, valid: true, blockers: [] };
    } catch (error) {
      return {
        present: true,
        valid: false,
        blockers: [new FlowVersionMigrationBlocker({
          code: "INVALID_VERSION_TARGET", message: `existing Version target is incomplete or corrupt: ${error.message}`,
        })],
      };
    }
  }
  #artifacts(root) {
    const artifacts = [];
    const blockers = [];
    const inventoryEntries = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const sourcePath = path.relative(root, absolute).split(path.sep).join("/");
        if (entry.isSymbolicLink()) {
          inventoryEntries.push(new FlowVersionMigrationInventoryEntry({
            sourcePath, entryType: "symlink", hash: sha256(Buffer.from(fs.readlinkSync(absolute))), size: 0,
          }));
          blockers.push(new FlowVersionMigrationBlocker({ code: "UNSAFE_SOURCE_SYMLINK", path: sourcePath, message: `unsafe migration source symlink: ${sourcePath}` }));
          continue;
        }
        if (entry.isDirectory()) {
          inventoryEntries.push(new FlowVersionMigrationInventoryEntry({ sourcePath, entryType: "directory" }));
          const sourceName = path.posix.basename(sourcePath);
          const active = sourceName.endsWith(".lock") || sourceName.endsWith(".tmp")
            || sourceName.endsWith(".transaction") || sourceName.includes(".transaction.")
            || sourceName.includes(".lock.") || sourceName.includes(".tmp.");
          const builtinOwned = BUILTIN_MIGRATION_SOURCE_POLICY.ownsDirectory(sourcePath);
          const customOwned = this.sourcePolicy.ownsDirectory(sourcePath);
          if (active) blockers.push(new FlowVersionMigrationBlocker({
            code: "ACTIVE_TRANSACTION_MARKER", path: sourcePath,
            message: `active legacy transaction marker blocks migration: ${sourcePath}`,
          }));
          else if (!builtinOwned && !customOwned) blockers.push(new FlowVersionMigrationBlocker({
            code: sourcePath.split("/").some((segment) => segment.startsWith("."))
              ? "UNKNOWN_HIDDEN_DIRECTORY" : "UNKNOWN_VISIBLE_DIRECTORY",
            path: sourcePath, message: `unowned legacy source directory blocks migration: ${sourcePath}`,
          }));
          visit(absolute);
          continue;
        }
        if (!entry.isFile()) {
          inventoryEntries.push(new FlowVersionMigrationInventoryEntry({ sourcePath, entryType: "special" }));
          blockers.push(new FlowVersionMigrationBlocker({ code: "UNSUPPORTED_SOURCE_ENTRY", path: sourcePath, message: `unsupported migration source entry: ${sourcePath}` }));
          continue;
        }
        if (fs.lstatSync(absolute).nlink !== 1) {
          blockers.push(new FlowVersionMigrationBlocker({ code: "UNSAFE_SOURCE_HARDLINK", path: sourcePath, message: `unsafe hard-linked migration source artifact: ${sourcePath}` }));
        }
        const bytes = fs.readFileSync(absolute);
        inventoryEntries.push(new FlowVersionMigrationInventoryEntry({ sourcePath, entryType: "file", hash: sha256(bytes), size: bytes.length }));
        let classified;
        try { classified = classifyMigrationArtifact(sourcePath, this.sourcePolicy); } catch (error) {
          if (error instanceof FlowVersionMigrationBlockerError) { blockers.push(error.blocker); continue; }
          blockers.push(new FlowVersionMigrationBlocker({ code: "AMBIGUOUS_SOURCE_MAPPING", path: sourcePath, message: error.message }));
          continue;
        }
        const extension = path.extname(sourcePath);
        const inferredMediaType = extension === ".json" ? "application/json"
          : extension === ".jsonl" ? "application/x-ndjson"
            : extension === ".md" ? "text/markdown" : "application/octet-stream";
        artifacts.push(new FlowVersionMigrationArtifact({
          sourcePath,
          ...classified,
          sourceHash: sha256(bytes),
          size: bytes.length,
          mediaType: classified.mediaType === "application/octet-stream" ? inferredMediaType : classified.mediaType,
        }));
      }
    };
    visit(root);
    return {
      artifacts: artifacts.sort((left, right) => codeUnitOrder(left.sourcePath, right.sourcePath)),
      blockers,
      inventory: new FlowVersionMigrationInventory(inventoryEntries),
    };
  }
}

export class FlowVersionMigrationPlan {
  constructor({ classification, artifacts = [], inventory, sourcePolicy, semanticValidator, outputBuilder } = {}) {
    if (!(classification instanceof FlowVersionMigrationClassification)) throw new Error("FlowVersionMigrationClassification is required");
    if (!classification.migratable) throw new Error(`migration cannot plan a ${classification.value} source`);
    if (!(inventory instanceof FlowVersionMigrationInventory)) throw new Error("FlowVersionMigrationInventory is required for migration plan");
    if (!(semanticValidator instanceof FlowVersionSemanticValidator)) throw new Error("FlowVersionSemanticValidator is required for migration plan");
    if (!(outputBuilder instanceof FlowVersionMigrationOutputBuilder)) throw new Error("FlowVersionMigrationOutputBuilder is required for migration plan");
    if (!Array.isArray(artifacts)) throw new Error("migration artifacts must be an array");
    const entries = artifacts.map((artifact) => artifact instanceof FlowVersionMigrationArtifact ? artifact : new FlowVersionMigrationArtifact(artifact));
    const targets = new Map();
    const sources = new Set();
    const assertTargetAvailable = (artifact) => {
      for (const [existingPath, existing] of targets) {
        const sameAggregate = existingPath === artifact.targetPath && sameMigrationAggregate(existing, artifact);
        if (!sameAggregate && portablePathConflict(existingPath, artifact.targetPath)) {
          throw new Error(`migration target conflict: ${artifact.targetPath} conflicts with ${existingPath}`);
        }
      }
    };
    for (const artifact of entries) {
      if (sources.has(artifact.sourcePath)) throw new Error(`duplicate migration source artifact: ${artifact.sourcePath}`);
      if (artifact.targetPath !== null) assertTargetAvailable(artifact);
      sources.add(artifact.sourcePath);
      if (artifact.targetPath !== null) targets.set(artifact.targetPath, artifact);
    }
    const generated = [];
    if (!targets.has(FLOW_ACTIVITIES_RELATIVE_PATH)) {
      generated.push(new FlowVersionGeneratedArtifact({
        role: "activity-ledger", targetPath: FLOW_ACTIVITIES_RELATIVE_PATH,
        outputKey: "activity-ledger",
        mediaType: "application/x-ndjson",
        authoritySlot: ArtifactAuthoritySlot.singleton({
          kind: "activity-ledger", authority: "canonical-flow-artifacts", publicationStep: "system",
        }),
        retention: "permanent", cataloged: true,
      }));
    }
    for (const artifact of generated) {
      assertTargetAvailable(artifact);
      targets.set(artifact.targetPath, artifact);
    }
    this.classification = classification;
    this.inventory = inventory;
    this.sourcePolicy = sourcePolicy;
    this.semanticValidator = semanticValidator;
    this.outputBuilder = outputBuilder;
    this.artifacts = Object.freeze(entries.sort((left, right) => codeUnitOrder(left.targetPath, right.targetPath)));
    this.generatedArtifacts = Object.freeze(generated.sort((left, right) => codeUnitOrder(left.targetPath, right.targetPath)));
    this.writes = Object.freeze([...new Set([
      ...this.artifacts.filter((artifact) => artifact.targetPath !== null).map((artifact) => classification.target.relativePath(artifact.targetPath)),
      ...this.generatedArtifacts.map((artifact) => classification.target.relativePath(artifact.targetPath)),
      classification.target.relativePath(ARTIFACT_CATALOG_RELATIVE_PATH),
    ])].sort(codeUnitOrder));
    Object.freeze(this);
  }
  outputFixture({ state, spec } = {}) {
    return new FlowVersionMigrationFixture({ plan: this, state, spec });
  }
  toJSON() {
    return {
      mode: "dry-run", layout: "flow-version-v1", ...this.classification.toJSON(),
      inventory: this.inventory.toJSON(),
      artifacts: this.artifacts.map((artifact) => artifact.toJSON()),
      generatedArtifacts: this.generatedArtifacts.map((artifact) => artifact.toJSON()), writes: [...this.writes],
    };
  }
}

export class FlowVersionMigrationFixture {
  #state;
  constructor({ plan, state, spec } = {}) {
    if (!(plan instanceof FlowVersionMigrationPlan)) throw new Error("FlowVersionMigrationPlan is required for migration fixture output");
    if (!(spec instanceof AuthoritativeSpecRecord)) throw new Error("AuthoritativeSpecRecord is required for migration fixture output");
    const semanticValidator = plan.semanticValidator;
    const validatedState = semanticValidator.validateState(state);
    if (!isPlainObject(validatedState)) throw new Error("semantic validator must return a plain Current Flow state document");
    if (
      !Number.isSafeInteger(validatedState.schemaRevision)
      || validatedState.schemaRevision < 1
      || validatedState.version !== plan.classification.target.version.value
      || validatedState.specId !== plan.classification.target.specId.toString()
    ) {
      throw new Error("migration fixture state must use the target canonical identity and Version");
    }
    if (!spec.specId.equals(plan.classification.target.specId)) throw new Error("migration fixture Spec record must match its target specId");
    const roles = new Set(plan.artifacts.map((artifact) => artifact.role));
    if (!roles.has("flow-state") || !roles.has("spec-record")) throw new Error("migration fixture requires flow-state and spec-record artifacts");
    this.plan = plan;
    this.spec = spec;
    this.semanticValidator = semanticValidator;
    this.#state = structuredClone(validatedState);
    Object.freeze(this);
  }
  get format() { return "flow-version-v1"; }
  get directory() { return this.plan.classification.target.relativeDirectory; }
  materialize() {
    const sourceRoot = this.plan.classification.sourcePath;
    if (sourceRoot === null) throw new Error("migration fixture materialization requires a legacy source");
    const currentInspection = new FlowVersionMigrationClassifier({
      target: this.plan.classification.target,
      sourcePolicy: this.plan.sourcePolicy,
      semanticValidator: this.plan.semanticValidator,
      outputBuilder: this.plan.outputBuilder,
    }).inspect(sourceRoot);
    if (
      currentInspection.classification.blockers.length > 0
      || currentInspection.classification.value !== "legacy"
      || currentInspection.inventory.treeDigest !== this.plan.inventory.treeDigest
    ) {
      throw new Error("migration source inventory changed after inspection");
    }
    const outputSet = this.plan.outputBuilder.build({
      plan: this.plan, state: structuredClone(this.#state), spec: this.spec,
    });
    if (!(outputSet instanceof FlowVersionMigrationOutputSet)) throw new Error("migration output builder must return FlowVersionMigrationOutputSet");
    const expectedOutputs = new Map();
    for (const artifact of [
      ...this.plan.artifacts.filter((entry) => entry.operation.value === "transform"),
      ...this.plan.generatedArtifacts,
    ]) {
      const existing = expectedOutputs.get(artifact.outputKey);
      if (existing && existing.targetPath !== artifact.targetPath) throw new Error(`migration aggregate output contract conflict: ${artifact.outputKey}`);
      expectedOutputs.set(artifact.outputKey, artifact);
    }
    if (outputSet.values().length !== expectedOutputs.size) throw new Error("migration output builder returned an incomplete or undeclared output set");
    for (const [outputKey, artifact] of expectedOutputs) {
      const output = outputSet.require(outputKey);
      if (
        output.targetPath !== artifact.targetPath
        || output.operation.value !== artifact.operation.value
        || output.mediaType !== artifact.mediaType
        || output.retention !== artifact.retention
        || output.activityId?.toString() !== artifact.activityId?.toString()
        || output.authoritySlot.claimKey() !== artifact.authoritySlot.claimKey()
        || output.authoritySlot.publicationStep !== artifact.authoritySlot.publicationStep
      ) throw new Error(`migration output metadata does not match its declared contract: ${outputKey}`);
    }
    const sourceBytes = new Map(this.plan.artifacts.map((artifact) => [artifact, artifact.verifySource(sourceRoot)]));
    const location = this.plan.classification.target;
    location.assertAuthority();
    if (fs.existsSync(location.directory)) throw new Error("migration fixture target must be absent before materialization");
    // The production Current Flow semantic boundary owns revision-scoped
    // authority publication.  A fixture that claims to materialize a current
    // Flow must use that boundary too; emitting the retired pre-revision tree
    // and asking the normal runtime to accept it would be a fallback.
    if (typeof this.semanticValidator.materializeCurrentFixture === "function") {
      const catalog = this.semanticValidator.materializeCurrentFixture({
        location,
        state: structuredClone(this.#state),
        spec: this.spec,
      });
      return new FlowVersionMigrationMaterialization({ location, catalog });
    }
    let ownsVersionRoot = false;
    try {
      fs.mkdirSync(path.dirname(location.directory), { recursive: true, mode: 0o755 });
      fs.mkdirSync(location.directory, { recursive: false, mode: 0o755 });
      ownsVersionRoot = true;
      for (const artifact of this.plan.artifacts.filter((entry) => entry.operation.value === "copy")) {
        const target = location.resolve(artifact.targetPath);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, sourceBytes.get(artifact), { flag: "wx", mode: 0o600 });
      }
      for (const output of outputSet.values()) {
        const target = location.resolve(output.targetPath);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, output.bytes, { flag: "wx", mode: 0o600 });
      }
      const descriptors = [];
      for (const artifact of this.plan.artifacts.filter((entry) => entry.operation.value === "copy")) {
        descriptors.push(FlowArtifactDescriptor.fromFile({
          location, authoritySlot: artifact.authoritySlot, relativePath: artifact.targetPath,
          mediaType: artifact.mediaType, retention: artifact.retention, activityId: artifact.activityId,
          migrationMaterialization: artifact.role === "artifact",
        }));
      }
      for (const output of outputSet.values()) {
        descriptors.push(FlowArtifactDescriptor.fromFile({
          location,
          authoritySlot: output.authoritySlot,
          relativePath: output.targetPath,
          mediaType: output.mediaType, retention: output.retention, activityId: output.activityId,
        }));
      }
      const store = new FlowArtifactCatalogStore({ location });
      store.initialize(new FlowArtifactCatalog({ artifacts: descriptors }), MIGRATION_CATALOG_INITIALIZATION);
      const catalog = store.require();
      store.read({ relativePaths: this.toJSON().catalogPaths, read: () => null });
      this.semanticValidator.validateMaterialized({ location, spec: this.spec });
      return new FlowVersionMigrationMaterialization({ location, catalog });
    } catch (error) {
      if (!ownsVersionRoot) throw error;
      try { fs.rmSync(location.directory, { recursive: true, force: true }); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "migration fixture materialization cleanup failed", { cause: error });
      }
      throw error;
    }
  }
  toJSON() {
    const catalogPaths = [
      ...this.plan.artifacts.filter((artifact) => artifact.targetPath !== null).map((artifact) => artifact.targetPath),
      ...this.plan.generatedArtifacts.filter((artifact) => artifact.cataloged).map((artifact) => artifact.targetPath),
    ].sort(codeUnitOrder);
    return {
      format: this.format, directory: this.directory,
      state: structuredClone(this.#state), spec: this.spec.toJSON(),
      artifacts: this.plan.artifacts.map((artifact) => artifact.toJSON()),
      generatedArtifacts: this.plan.generatedArtifacts.map((artifact) => artifact.toJSON()), catalogPaths,
    };
  }
}

export class FlowVersionMigrationMaterialization {
  constructor({ location, catalog } = {}) {
    if (!(location instanceof FlowVersionLocation) || !(catalog instanceof FlowArtifactCatalog)) {
      throw new Error("validated migration materialization requires a Version location and catalog");
    }
    this.location = location;
    this.catalog = catalog;
    Object.freeze(this);
  }
}
