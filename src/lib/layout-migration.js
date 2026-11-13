/**
 * Explicit, one-way managed-directory layout migration.
 *
 * Normal runtime deliberately does not import this module. Legacy names are
 * confined here so opening a current project never creates a compatibility
 * path by accident.
 */

import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import { LayoutTemplateTransformation } from "./layout-template-transformation.js";
import { LayoutFileContent } from "./layout-file-content.js";
import { LayoutBeforeImageRequest, LayoutMigrationEvidence } from "./layout-migration-evidence.js";
import { combineProcessExecutionFailures } from "./process-execution-completion.js";
import fs from "node:fs";
import path from "node:path";

import { captureRegularFile, DEFAULT_MAX_FILE_BYTES, MAX_IN_MEMORY_FILE_BYTES, FilePermissionHint, visitRegularFileChunks } from "./regular-file-snapshot.js";
import { FileIdentity } from "./file-identity.js";
import { AtomicFile } from "./atomic-file.js";
import { RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { loadConfigFromManagedDirectory } from "./config.js";
import { LEGACY_MANAGED_DIRECTORY_NAMES } from "./legacy-managed-directory-migration.js";
import { migrateLegacyManagedGitattributes, migrateLegacyManagedGitignore } from "./legacy-managed-metadata-migration.js";
import { validatePresetChainFromManagedDirectory } from "./presets.js";
import { MigrationProcessOwner } from "./migration-process-owner.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { PRODUCT } from "./product.js";
import { TemporaryPaths } from "./temporary-paths.js";
import { withRepositoryMigrationExclusion } from "./migration.js";
import { LogicalRelativePath, LogicalPathSet, isNativePathWithin } from "./portable-path.js";

const MIGRATION_READ_OPTIONS = Object.freeze({ label: "migration regular file", maxBytes: DEFAULT_MAX_FILE_BYTES });
const ROOT_METADATA_READ_OPTIONS = Object.freeze({ label: "migration root metadata", maxBytes: MAX_IN_MEMORY_FILE_BYTES });

// This is intentionally the complete boundary for retired managed roots.
// Nothing outside the explicit layout revision may interpret these names.
const LEGACY_DIRECTORY_NAMES = LEGACY_MANAGED_DIRECTORY_NAMES;
const STAGING_PREFIX = "sennel-migrate-layout-";
const JOURNAL_FILE_NAME = "sennel-migrate-layout.json";
const JOURNAL_VERSION = 10;
const SNAPSHOT_VERSION = 3;
// Only the explicit migration reader can finish an already released revision 9
// operation. Its original snapshot serialization and publication receipt stay
// in that format throughout cleanup/rollback; normal preflight uses revision 10.
const PREVIOUS_JOURNAL_VERSION = 9;
const PREVIOUS_SNAPSHOT_VERSION = 2;
const JOURNAL_PHASES = new Set([
  "staged",
  "legacy-backed-up",
  "metadata-updated",
  "final-renamed",
  "cleanup-source-verified",
  "cleanup-complete",
  "rollback-complete",
]);
const RAW_COPY_ROOTS = new Set(["plugins", "plugin-sources"]);
const TEMPLATE_TRANSFORMATION = new LayoutTemplateTransformation();

function relativePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative === "" || !isNativePathWithin(path.resolve(root), path.resolve(filePath))) {
    throw new Error(`migration path escapes the project root: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(directory, label) {
  try { new RealDirectoryAuthority(directory).assertStable(); }
  catch (cause) { throw new Error(`${label} must be a real directory: ${directory}`, { cause }); }
  const stat = lstatOrNull(directory);
  if (!stat) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  return stat;
}

function assertRegularFile(filePath, label) {
  const stat = lstatOrNull(filePath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return stat;
}

function directoryIdentity(directory, label) {
  assertRealDirectory(directory, label);
  return FileIdentity.capture(fs.lstatSync(directory, { bigint: true })).toJSON();
}

function sameDirectoryIdentity(directory, identity, label) {
  assertRealDirectory(directory, label);
  return sameFileIdentity(fs.lstatSync(directory, { bigint: true }), identity);
}


function removeTree(directory, label, expectedIdentity) {
  const authority = new RealDirectoryAuthority(directory);
  if (!authority.exists()) return;
  if (!sameFileIdentity(authority.identity, expectedIdentity)) throw new Error(`${label} directory generation changed before removal`);
  authority.removeTree();
}


function isRawCopyPath(relative) {
  return RAW_COPY_ROOTS.has(relative.split("/")[0]);
}

function managedTemplateComponentIndex(relative) {
  if (relative === "" || isRawCopyPath(relative)) return -1;
  const components = relative.split("/");
  if (components[0] === "templates") return 0;
  if (components[0] !== "presets") return -1;
  const templateIndex = components.indexOf("templates", 1);
  return templateIndex > 1 ? templateIndex : -1;
}

function transformedRelativePath(relative) {
  const templateIndex = managedTemplateComponentIndex(relative);
  if (templateIndex < 0) return relative;
  return relative.split("/").map((component, index) => (
    index > templateIndex ? TEMPLATE_TRANSFORMATION.transformText(component) : component
  )).join("/");
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function transformedFileBytes(relative, bytes) {
  return managedTemplateComponentIndex(relative) >= 0 ? TEMPLATE_TRANSFORMATION.transform(bytes) : bytes;
}

class MigrationTreePlan {
  constructor(entries) {
    if (!Array.isArray(entries)) throw new Error("migration tree plan entries are invalid");
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  get size() {
    return this.entries.length;
  }

  toDryRunLines() {
    return this.entries.map((entry) => {
      const mapping = `${entry.path} -> ${PRODUCT.managedDirName}/${entry.targetPath}`;
      if (entry.kind === "file" && entry.hash !== entry.transformedHash) {
        return `stage transformed template file ${mapping}`;
      }
      return `stage ${entry.kind} ${mapping}`;
    });
  }
}

class MigrationDirectoryEntry {
  constructor({ path: sourcePath, targetPath, generation }) {
    this.path = LogicalRelativePath.from(sourcePath).toString();
    this.targetPath = LogicalRelativePath.from(targetPath).toString();
    if (this.targetPath !== transformedRelativePath(this.path)) throw new Error("migration snapshot path transformation is invalid");
    this.generation = Object.freeze(FileIdentity.fromStored(generation).toJSON());
  }
  get kind() { return "directory"; }
  baseJSON() { return { path: this.path, targetPath: this.targetPath, kind: this.kind, generation: this.generation }; }
  toJSON() { return this.baseJSON(); }
}

class MigrationFileEntry extends MigrationDirectoryEntry {
  #content;
  constructor({ content = null, hash, transformedHash, byteLength, transformedByteLength, permissionHint = null, ...entry }) {
    super(entry);
    if (![hash, transformedHash].every(value => typeof value === "string" && /^[0-9a-f]{64}(?![\s\S])/.test(value))
      || ![byteLength, transformedByteLength].every(value => Number.isSafeInteger(value) && value >= 0)
      || byteLength > MAX_IN_MEMORY_FILE_BYTES || transformedByteLength > MAX_IN_MEMORY_FILE_BYTES
      || permissionHint !== null && !(permissionHint instanceof FilePermissionHint)) throw new Error("migration file receipt is invalid");
    if (content !== null && (!(content instanceof LayoutFileContent) || content.original.digest !== hash
      || content.transformedDigest !== transformedHash || content.original.byteLength !== byteLength
      || content.transformedByteLength !== transformedByteLength || !sameFileIdentity(content.original.identity, FileIdentity.fromStored(this.generation)))) {
      throw new Error("migration source content does not match its captured entry");
    }
    this.#content = content;
    this.hash = hash;
    this.transformedHash = transformedHash;
    this.byteLength = byteLength;
    this.transformedByteLength = transformedByteLength;
    this.permissionHint = permissionHint;
    if (new.target === MigrationFileEntry) Object.freeze(this);
  }
  get kind() { return "file"; }
  beforeImageRequest() {
    if (this.#content === null) throw new Error("stored migration receipts cannot create new source before-images");
    return new LayoutBeforeImageRequest(this.path, this.#content);
  }
  copyTo(destination) {
    if (this.#content === null) throw new Error("stored migration receipts cannot reconstruct source content");
    return this.#content.copyTo(destination);
  }
  toJSON() { return { ...this.baseJSON(), hash: this.hash, transformedHash: this.transformedHash,
    byteLength: this.byteLength, transformedByteLength: this.transformedByteLength }; }
}

/** Exact previous serializer, confined to recovery of genuine revision 9 work. */
class PreviousMigrationFileEntry extends MigrationFileEntry {
  #bytes;
  constructor({ bytes, hash, transformedHash, permissionHint = null, ...entry }) {
    if (!Buffer.isBuffer(bytes)) throw new Error("migration snapshot bytes are invalid");
    const transformed = transformedFileBytes(entry.path, bytes);
    if (hash !== hashBytes(bytes) || transformedHash !== hashBytes(transformed)) throw new Error("migration snapshot bytes or hash is invalid");
    super({ ...entry, hash, transformedHash, permissionHint, byteLength: bytes.length,
      transformedByteLength: transformed.length });
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  toJSON() { return { ...this.baseJSON(), bytes: this.#bytes.toString("base64"), hash: this.hash, transformedHash: this.transformedHash }; }
}

class SourceTreeSnapshot {
  #targetPaths;
  constructor({ rootIdentity, entries, version = SNAPSHOT_VERSION }) {
    if (![PREVIOUS_SNAPSHOT_VERSION, SNAPSHOT_VERSION].includes(version)
      || entries.some(entry => version === PREVIOUS_SNAPSHOT_VERSION
        ? entry instanceof MigrationFileEntry && !(entry instanceof PreviousMigrationFileEntry)
        : entry instanceof PreviousMigrationFileEntry)) throw new Error("migration snapshot revision does not match its entry representation");
    new LogicalPathSet(entries.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    try { new LogicalPathSet(entries.map((entry) => entry.targetPath), { allowDirectoryPrefixes: true }); }
    catch (cause) { throw Object.assign(new Error(`migration path collision: ${cause.message}`, { cause }), { code: cause.code }); }
    if (!entries.every((entry) => entry instanceof MigrationDirectoryEntry)) throw new Error("migration snapshot requires typed entries");
    const targetKinds = new Map(entries.map((entry) => [entry.targetPath, entry.kind]));
    for (const entry of entries) {
      let parent = path.posix.dirname(entry.targetPath);
      while (parent !== ".") {
        if (targetKinds.get(parent) !== "directory") throw new Error(`migration target parent is not a directory: ${parent}`);
        parent = path.posix.dirname(parent);
      }
    }
    this.rootIdentity = Object.freeze(FileIdentity.fromStored(rootIdentity).toJSON());
    this.version = version;
    this.entries = Object.freeze([...entries]);
    this.serialized = JSON.stringify(this.toJSON());
    this.#targetPaths = new Set(entries.map((entry) => entry.targetPath));
    Object.freeze(this);
  }
  static capture(root, { version = SNAPSHOT_VERSION } = {}) {
    const authority = new RealDirectoryAuthority(root);
    const rootStat = fs.lstatSync(root, { bigint: true });
    authority.assertStable();
    const entries = [];
    let storedBytes = 0;
    const append = (entry) => {
      storedBytes += Buffer.byteLength(JSON.stringify(entry));
      if (storedBytes > DEFAULT_MAX_FILE_BYTES) throw new ProcessExecutionControlFailure("input-invalid", "Layout snapshot exceeds the bounded stored-byte limit");
      entries.push(entry);
    };
    const visit = (directory, relative = "") => {
      const directoryAuthority = new RealDirectoryAuthority(directory);
      for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
        const source = path.join(directory, name);
        const sourcePath = relative === "" ? name : `${relative}/${name}`;
        const stat = fs.lstatSync(source, { bigint: true });
        const entry = { path: sourcePath, targetPath: transformedRelativePath(sourcePath), generation: FileIdentity.capture(stat).toJSON() };
        if (stat.isSymbolicLink()) {
          throw new ProcessExecutionControlFailure("input-invalid", `managed directory contains a native symbolic link: ${sourcePath}`);
        } else if (stat.isDirectory()) {
          append(Object.freeze(new MigrationDirectoryEntry(entry)));
          visit(source, sourcePath);
        } else if (stat.isFile()) {
          if (version === PREVIOUS_SNAPSHOT_VERSION) {
            const captured = captureRegularFile(source, { ...MIGRATION_READ_OPTIONS, expectedIdentity: stat, directoryAuthority });
            append(new PreviousMigrationFileEntry({ ...entry, bytes: captured.bytes, hash: captured.digest, permissionHint: captured.permissionHint,
              transformedHash: hashBytes(transformedFileBytes(sourcePath, captured.bytes)) }));
          } else {
            const content = LayoutFileContent.capture(source, { transform: managedTemplateComponentIndex(sourcePath) >= 0,
              expectedIdentity: stat, directoryAuthority });
            append(new MigrationFileEntry({ ...entry, content, hash: content.original.digest, transformedHash: content.transformedDigest,
              byteLength: content.original.byteLength, transformedByteLength: content.transformedByteLength, permissionHint: content.original.permissionHint }));
          }
        } else throw new ProcessExecutionControlFailure("input-invalid", `managed directory contains an unsupported entry: ${sourcePath}`);
      }
      directoryAuthority.assertStable();
    };
    visit(root);
    authority.assertStable();
    return new SourceTreeSnapshot({ rootIdentity: FileIdentity.capture(rootStat).toJSON(), entries, version });
  }
  static fromJSON(value) {
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["entries", "rootIdentity", "version"])
      || ![PREVIOUS_SNAPSHOT_VERSION, SNAPSHOT_VERSION].includes(value.version) || !Array.isArray(value.entries)) throw new Error("migration journal source snapshot format is invalid");
    FileIdentity.fromStored(value.rootIdentity);
    const entries = value.entries.map((entry) => {
      const keys = Object.keys(entry ?? {}).sort();
      if (entry.kind === "directory" && JSON.stringify(keys) === JSON.stringify(["generation", "kind", "path", "targetPath"])) {
        return Object.freeze(new MigrationDirectoryEntry(entry));
      }
      if (value.version === PREVIOUS_SNAPSHOT_VERSION && entry.kind === "file" && JSON.stringify(keys) === JSON.stringify(["bytes", "generation", "hash", "kind", "path", "targetPath", "transformedHash"])
        && typeof entry.bytes === "string" && Buffer.from(entry.bytes, "base64").toString("base64") === entry.bytes) {
        return new PreviousMigrationFileEntry({ ...entry, bytes: Buffer.from(entry.bytes, "base64") });
      }
      if (value.version === SNAPSHOT_VERSION && entry.kind === "file" && JSON.stringify(keys) === JSON.stringify([
        "byteLength", "generation", "hash", "kind", "path", "targetPath", "transformedByteLength", "transformedHash",
      ])) {
        return new MigrationFileEntry(entry);
      }
      throw new Error("migration journal source snapshot entry format is invalid");
    });
    return new SourceTreeSnapshot({ rootIdentity: value.rootIdentity, entries, version: value.version });
  }
  toJSON() { return { version: this.version, rootIdentity: this.rootIdentity, entries: this.entries.map((entry) => entry.toJSON()) }; }
  captureLike(root) { return SourceTreeSnapshot.capture(root, { version: this.version }); }
  get treePlan() { return new MigrationTreePlan(this.entries); }
  createBeforeImages(repositoryRoot) {
    return LayoutMigrationEvidence.create(repositoryRoot, this.entries.filter(entry => entry.kind === "file").map(entry => entry.beforeImageRequest()));
  }
  get fingerprint() { return hashBytes(this.serialized); }
  hasTargetPath(relative) { return this.#targetPaths.has(relative.split(path.sep).join("/")); }
  assertUnchanged(root) {
    if (this.captureLike(root).serialized !== this.serialized) throw new Error("legacy managed directory changed while migration staging was in progress");
  }
  assertRemainingSubset(root) {
    const current = this.captureLike(root);
    if (JSON.stringify(current.rootIdentity) !== JSON.stringify(this.rootIdentity)) throw new Error("legacy managed directory authority changed during cleanup");
    const expected = new Map(this.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    for (const entry of current.entries) {
      if (expected.get(entry.path) !== JSON.stringify(entry)) throw new Error(`legacy managed directory changed during cleanup: ${entry.path}`);
    }
  }
  assertStaged(root) {
    const actual = this.captureLike(root).entries.map((entry) => ({ path: entry.path, kind: entry.kind,
      ...(entry instanceof MigrationFileEntry ? { hash: entry.hash } : {}) }));
    const expected = this.entries.map((entry) => ({ path: entry.targetPath, kind: entry.kind,
      ...(entry instanceof MigrationFileEntry ? { hash: entry.transformedHash } : {}) }));
    const compare = (left, right) => left.path.localeCompare(right.path);
    if (JSON.stringify(actual.sort(compare)) !== JSON.stringify(expected.sort(compare))) throw new Error("migration staged tree does not match the source-derived transformation");
  }
  copyTo(destinationRoot) {
    for (const entry of this.entries) {
      const destination = path.join(destinationRoot, entry.targetPath);
      if (lstatOrNull(destination)) throw new Error(`migration path collision: ${entry.targetPath}`);
      if (entry.kind === "directory") RealDirectoryAuthority.resolve(path.dirname(destination)).createExclusiveChild(path.basename(destination));
      else entry.copyTo(destination);
    }
    this.assertStaged(destinationRoot);
  }
}

function templateReferenceValidationError(projectRoot, sourceRoot, config, options = {}) {
  try {
    if (config.type) {
      validatePresetChainFromManagedDirectory(config.type, projectRoot, sourceRoot, {
        languages: config.docs?.languages || [],
        configChapters: config.chapters,
        reportUnlistedTemplates: false,
        ...options,
      });
    }
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

/**
 * A layout revision may rename managed template paths, but must never leave a
 * configuration that previously resolved them pointing at a removed path.
 * The shared config boundary validates saved invocation values before transfer.
 * No shell parsing, converter or plugin-specific schema rules live here.
 */
function assertTemplateReferencesRemainResolvable(projectRoot, sourceRoot, snapshot) {
  const config = loadConfigFromManagedDirectory(sourceRoot);
  const sourceError = templateReferenceValidationError(projectRoot, sourceRoot, config);
  const migratedError = templateReferenceValidationError(projectRoot, sourceRoot, config, {
    templateExists(candidate) {
      const relative = path.relative(sourceRoot, candidate);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return fs.existsSync(candidate);
      }
      const normalized = relative.split(path.sep).join("/");
      return isRawCopyPath(normalized)
        ? fs.existsSync(candidate)
        : snapshot.hasTargetPath(normalized);
    },
  });
  if (migratedError && migratedError !== sourceError) {
    throw new Error([
      "migration would break a managed template reference; update the configuration or template name before retrying",
      migratedError,
    ].join("\n"));
  }
}

class LayoutMetadataPayload {
  constructor(byteLength, digest) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_IN_MEMORY_FILE_BYTES
      || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw new TypeError("root metadata payload requires its bounded byte length and digest");
    this.byteLength = byteLength;
    this.digest = digest;
  }
  matches(receipt) { return receipt.byteLength === this.byteLength && receipt.digest === this.digest; }
}

class LayoutMetadataBytes extends LayoutMetadataPayload {
  #bytes;
  constructor(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("root metadata requires raw bytes");
    super(bytes.length, hashBytes(bytes));
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  bytes() { return Buffer.from(this.#bytes); }
}

class LayoutStoredMetadataPayload extends LayoutMetadataPayload {
  #evidence;
  constructor(evidence, key) {
    if (!(evidence instanceof LayoutMigrationEvidence)) throw new TypeError("root metadata requires its owned payload evidence");
    const receipt = evidence.receipt(key);
    super(receipt.byteLength, receipt.digest);
    this.#evidence = evidence;
    this.key = key;
    Object.freeze(this);
  }
  bytes() { return this.#evidence.readBytes(this.key); }
  belongsTo(evidence) { return this.#evidence === evidence; }
}

class RootMetadataFile {
  #original;
  #planned;
  constructor({ root, name, existed, original, planned, originalIdentity = null, plannedIdentity = null, restoredIdentity = null,
    pendingStage = null }) {
    if (![".gitignore", ".gitattributes"].includes(name) || typeof existed !== "boolean"
      || !(original instanceof LayoutMetadataPayload) || !(planned instanceof LayoutMetadataPayload)) {
      throw new Error("migration root metadata input is invalid");
    }
    if (!existed && (original.byteLength !== 0 || original.digest !== hashBytes(Buffer.alloc(0)))) throw new Error("absent root metadata cannot have original bytes");
    for (const identity of [originalIdentity, plannedIdentity, restoredIdentity, pendingStage?.identity ?? null]) {
      if (identity !== null) FileIdentity.fromStored(identity);
    }
    if (existed !== (originalIdentity !== null)) throw new Error("migration root metadata original generation is invalid");
    if (pendingStage !== null && (JSON.stringify(Object.keys(pendingStage).sort()) !== JSON.stringify(["hash", "identity", "name"])
      || typeof pendingStage.name !== "string" || !pendingStage.name.startsWith(`.${name}.`)
      || !/^[0-9a-f-]{36}\.tmp$/.test(pendingStage.name.slice(name.length + 2))
      || ![original.digest, planned.digest].includes(pendingStage.hash))) throw new Error("migration metadata stage receipt is invalid");
    this.root = root;
    this.name = name;
    this.existed = existed;
    this.#original = original;
    this.#planned = planned;
    this.originalIdentity = originalIdentity;
    this.plannedIdentity = plannedIdentity;
    this.restoredIdentity = restoredIdentity;
    this.pendingStage = pendingStage;
  }

  get original() { return this.#original.bytes(); }
  get planned() { return this.#planned.bytes(); }
  get filePath() { return path.join(this.root, this.name); }
  #key(kind) { return `root-${this.name.slice(1)}-${kind}`; }
  evidenceKeys() { return [...(this.existed ? [this.#key("original")] : []), this.#key("planned")]; }

  static plan(root, name, transform) {
    const filePath = path.join(root, name);
    const stat = lstatOrNull(filePath);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`root metadata file must be a regular file: ${name}`);
    const captured = stat ? captureRegularFile(filePath, ROOT_METADATA_READ_OPTIONS) : null;
    const original = captured?.bytes ?? Buffer.alloc(0);
    const planned = Buffer.from(transform(original.toString("utf8")), "utf8");
    return new RootMetadataFile({ root, name, existed: Boolean(stat), original: new LayoutMetadataBytes(original),
      planned: new LayoutMetadataBytes(planned), originalIdentity: captured === null ? null : captured.identity.toJSON() });
  }

  static #assertFields(value) {
    if (JSON.stringify(Object.keys(value ?? {}).sort()) !== JSON.stringify(["existed", "name", "original", "originalIdentity", "pendingStage", "planned", "plannedIdentity", "restoredIdentity"])
      || typeof value.name !== "string" || typeof value.existed !== "boolean") throw new Error("migration root metadata journal entry is invalid");
  }

  static fromPreviousJSON(root, value) {
    this.#assertFields(value);
    if ([value.original, value.planned].some(encoded => typeof encoded !== "string"
      || Buffer.from(encoded, "base64").toString("base64") !== encoded)) throw new Error("migration root metadata journal entry is invalid");
    const planned = Buffer.from(value.planned, "base64");
    if (!isUtf8(planned)) throw new Error("migration root metadata plan is not UTF-8");
    return new this({ root, ...value, original: new LayoutMetadataBytes(Buffer.from(value.original, "base64")),
      planned: new LayoutMetadataBytes(planned) });
  }

  static fromJSON(root, value, evidence) {
    this.#assertFields(value);
    const originalKey = `root-${value.name.slice(1)}-original`;
    const plannedKey = `root-${value.name.slice(1)}-planned`;
    if (value.original !== (value.existed ? originalKey : null) || value.planned !== plannedKey) throw new Error("migration root metadata payload binding is invalid");
    return new this({ root, ...value,
      original: value.existed ? new LayoutStoredMetadataPayload(evidence, originalKey) : new LayoutMetadataBytes(Buffer.alloc(0)),
      planned: new LayoutStoredMetadataPayload(evidence, plannedKey) });
  }

  toPreflightJSON() {
    return { name: this.name, existed: this.existed, originalIdentity: this.originalIdentity,
      original: { byteLength: this.#original.byteLength, digest: this.#original.digest },
      planned: { byteLength: this.#planned.byteLength, digest: this.#planned.digest } };
  }

  toJSON(version) {
    const previous = version === PREVIOUS_JOURNAL_VERSION;
    if (!previous && !(this.#planned instanceof LayoutStoredMetadataPayload)) throw new Error("current root metadata has no durable payload evidence");
    return { name: this.name, existed: this.existed,
      original: previous ? this.original.toString("base64") : this.existed ? this.#original.key : null,
      planned: previous ? this.planned.toString("base64") : this.#planned.key,
      originalIdentity: this.originalIdentity, plannedIdentity: this.plannedIdentity,
      restoredIdentity: this.restoredIdentity, pendingStage: this.pendingStage };
  }

  evidenceRequests(stagingRoot) {
    const requests = [];
    if (this.existed) {
      requests.push(new LayoutBeforeImageRequest(this.#key("original"), LayoutFileContent.capture(this.filePath, {
        expectedIdentity: this.originalIdentity, maxBytes: MAX_IN_MEMORY_FILE_BYTES,
      })));
    }
    requests.push(new LayoutBeforeImageRequest(this.#key("planned"), LayoutFileContent.capture(path.join(stagingRoot, this.name), {
      maxBytes: MAX_IN_MEMORY_FILE_BYTES,
    })));
    return requests;
  }

  bindEvidence(evidence) {
    const original = this.existed ? new LayoutStoredMetadataPayload(evidence, this.#key("original")) : this.#original;
    const planned = new LayoutStoredMetadataPayload(evidence, this.#key("planned"));
    if (!this.#original.matches(original) || !this.#planned.matches(planned)) throw new Error("root metadata payload differs from its captured plan");
    this.#original = original;
    this.#planned = planned;
  }

  assertEvidence(evidence) {
    if (!(this.#planned instanceof LayoutStoredMetadataPayload) || !this.#planned.belongsTo(evidence)
      || this.existed && (!(this.#original instanceof LayoutStoredMetadataPayload) || !this.#original.belongsTo(evidence))) {
      throw new Error("migration root metadata belongs to another payload store");
    }
  }

  stage(stagingRoot) { new AtomicFile(path.join(stagingRoot, this.name)).write(this.planned); }

  stagedContent(stagingRoot) {
    const stagedPath = path.join(stagingRoot, this.name);
    assertRegularFile(stagedPath, `staged root metadata ${this.name}`);
    const content = captureRegularFile(stagedPath, ROOT_METADATA_READ_OPTIONS);
    if (!this.#planned.matches(content)) throw new Error(`staged root metadata changed before migration commit: ${this.name}`);
    return content.bytes;
  }

  #capture(filePath = this.filePath, expectedIdentity = null) {
    return visitRegularFileChunks(filePath, { ...ROOT_METADATA_READ_OPTIONS, expectedIdentity, visit() {} });
  }

  #assertExact(expected, identity) {
    const stat = lstatOrNull(this.filePath);
    if (expected === null) {
      if (stat) throw new Error(`root metadata appeared before migration: ${this.name}`);
      return false;
    }
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`root metadata changed before migration: ${this.name}`);
    if (!expected.matches(this.#capture(this.filePath, identity))) throw new Error(`root metadata content changed before migration: ${this.name}`);
    return true;
  }

  assertOriginal() { return this.#assertExact(this.existed ? this.#original : null, this.originalIdentity); }
  assertPlanned() {
    if (this.plannedIdentity === null) throw new Error("migration planned metadata generation is unavailable");
    return this.#assertExact(this.#planned, this.plannedIdentity);
  }
  assertRestored() {
    return this.#assertExact(this.existed ? this.#original : null, this.restoredIdentity ?? this.originalIdentity);
  }

  #assertRestorable() {
    const stat = lstatOrNull(this.filePath);
    if (this.existed) {
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`cannot restore root metadata changed by another process: ${this.name}`);
      const current = this.#capture();
      const original = this.#original.matches(current) && [this.originalIdentity, this.restoredIdentity]
        .some(identity => identity !== null && sameFileIdentity(current.identity, identity));
      const planned = this.#planned.matches(current) && this.plannedIdentity !== null && sameFileIdentity(current.identity, this.plannedIdentity);
      if (!planned && !original) throw new Error(`cannot restore root metadata changed by another process: ${this.name}`);
      return true;
    }
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink() || this.plannedIdentity === null
      || !this.#planned.matches(this.#capture(this.filePath, this.plannedIdentity))) throw new Error(`cannot remove root metadata changed by another process: ${this.name}`);
    return true;
  }

  #publish(bytes, phaseNamespace, guard, record, identityField) {
    const writer = new AtomicFile(this.filePath, { phaseNamespace, commitGuard: guard });
    const stage = writer.createStage(bytes);
    this[identityField] = stage.identity.toJSON();
    this.pendingStage = { name: path.basename(stage.path), identity: this[identityField], hash: hashBytes(bytes) };
    try { record(); writer.publishStage(stage); }
    catch (error) {
      if (stage.active) {
        try { stage.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "metadata publication and stage cleanup both failed", { cause: error }); }
      }
      throw error;
    }
  }

  cleanupStage() {
    if (this.pendingStage === null) return;
    const target = path.join(this.root, this.pendingStage.name);
    const guard = () => {
      if (this.#capture(target, this.pendingStage.identity).digest !== this.pendingStage.hash) throw new Error("migration metadata stage changed before cleanup");
    };
    if (lstatOrNull(target)) new AtomicFile(target, { commitGuard: guard }).remove();
  }

  apply(stagingRoot, { record, assertCurrent }) {
    const staged = this.stagedContent(stagingRoot);
    this.assertOriginal();
    this.#publish(staged, "layout-migration-metadata", () => { assertCurrent(); this.assertOriginal(); }, record, "plannedIdentity");
    this.assertPlanned();
  }

  restore({ record, assertCurrent }) {
    assertCurrent();
    const present = this.#assertRestorable();
    this.cleanupStage();
    if (this.existed) {
      const current = this.#capture();
      if (this.#original.matches(current) && [this.originalIdentity, this.restoredIdentity]
        .some(identity => identity !== null && sameFileIdentity(current.identity, identity))) return;
      this.#publish(this.original, "layout-migration-metadata-restore", () => { assertCurrent(); this.#assertRestorable(); }, record, "restoredIdentity");
      return;
    }
    if (!present) return;
    new AtomicFile(this.filePath, {
      phaseNamespace: "layout-migration-metadata-restore", commitGuard: () => { assertCurrent(); this.#assertRestorable(); },
    }).remove();
  }
}

class LayoutPublicationReceipt {
  constructor({ operation, sourceFingerprint, targetFingerprint }) {
    if (typeof operation !== "string" || !/^[0-9a-f-]{36}$/.test(operation)
      || ![sourceFingerprint, targetFingerprint].every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) {
      throw new Error("layout migration publication receipt is invalid");
    }
    this.operation = operation;
    this.sourceFingerprint = sourceFingerprint;
    this.targetFingerprint = targetFingerprint;
    Object.freeze(this);
  }
  static fromJSON(value) {
    if (value === null || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["operation", "sourceFingerprint", "targetFingerprint"])) {
      throw new Error("layout migration publication receipt format is invalid");
    }
    return new LayoutPublicationReceipt(value);
  }
  toJSON() { return { operation: this.operation, sourceFingerprint: this.sourceFingerprint, targetFingerprint: this.targetFingerprint }; }
}

class LayoutMigrationJournal {
  constructor({
    root,
    sourceName,
    stagingRelative,
    sourceIdentity,
    sourceSnapshot,
    sourceSnapshotFingerprint,
    stagedManagedIdentity,
    stagingIdentity,
    stagedSnapshotFingerprint,
    metadata,
    owner,
    tempRootCreated,
    tempRootIdentity,
    stagingParentIdentity,
    phase = "staged",
    operation = crypto.randomUUID(),
    receipt = null,
    version = JOURNAL_VERSION,
    beforeImages = null,
    metadataImages = null,
  }) {
    if (!LEGACY_DIRECTORY_NAMES.includes(sourceName)) throw new Error("migration journal source directory is invalid");
    if (!JOURNAL_PHASES.has(phase)) throw new Error(`migration journal phase is invalid: ${phase}`);
    if (!new RegExp(`^\\.tmp/runtime/migrate-layout/${STAGING_PREFIX}[A-Za-z0-9]{6}$`).test(stagingRelative)) {
      throw new Error("migration journal staging path is invalid");
    }
    new TemporaryPaths(root).validate(path.join(root, stagingRelative));
    for (const identity of [sourceIdentity, stagedManagedIdentity, stagingIdentity, ...(stagingParentIdentity === null ? [] : [stagingParentIdentity])]) {
      FileIdentity.fromStored(identity);
    }
    if (!(sourceSnapshot instanceof SourceTreeSnapshot)
      || ![PREVIOUS_JOURNAL_VERSION, JOURNAL_VERSION].includes(version)
      || sourceSnapshot.version !== (version === PREVIOUS_JOURNAL_VERSION ? PREVIOUS_SNAPSHOT_VERSION : SNAPSHOT_VERSION)
      || !FileIdentity.fromStored(sourceSnapshot.rootIdentity).equals(FileIdentity.fromStored(sourceIdentity))
      || sourceSnapshot.fingerprint !== sourceSnapshotFingerprint) {
      throw new Error("migration journal source snapshot authority is invalid");
    }
    if (version === PREVIOUS_JOURNAL_VERSION ? beforeImages !== null || ["cleanup-complete", "rollback-complete"].includes(phase)
      : !(beforeImages instanceof LayoutMigrationEvidence) || beforeImages.repositoryRoot !== path.resolve(root)
        || !beforeImages.matchesSource(sourceSnapshot.entries)) throw new Error("migration journal raw before-image authority is invalid");
    for (const [label, fingerprint] of [
      ["source", sourceSnapshotFingerprint],
      ["staged", stagedSnapshotFingerprint],
    ]) {
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new Error(`migration journal ${label} snapshot fingerprint is invalid`);
      }
    }
    if (typeof tempRootCreated !== "boolean") throw new Error("migration journal temporary-directory state is invalid");
    if (tempRootCreated !== Boolean(tempRootIdentity)) throw new Error("migration journal temporary-directory identity is invalid");
    if (tempRootIdentity !== null) FileIdentity.fromStored(tempRootIdentity);
    if (!(owner instanceof MigrationProcessOwner)) throw new Error("migration journal process owner is invalid");
    const metadataNames = metadata.map((entry) => entry.name).sort();
    if (JSON.stringify(metadataNames) !== JSON.stringify([".gitattributes", ".gitignore"])) {
      throw new Error("migration journal metadata authority is invalid");
    }
    if (version === PREVIOUS_JOURNAL_VERSION) {
      if (metadataImages !== null) throw new Error("previous migration journal cannot contain current metadata evidence");
    } else {
      if (!(metadataImages instanceof LayoutMigrationEvidence) || metadataImages.repositoryRoot !== path.resolve(root)
        || metadataImages.relativeDirectory === beforeImages.relativeDirectory
        || JSON.stringify(metadataImages.files.map(file => file.sourcePath).sort()) !== JSON.stringify(metadata.flatMap(entry => entry.evidenceKeys()).sort())) {
        throw new Error("migration root metadata payload authority is invalid");
      }
      for (const entry of metadata) entry.assertEvidence(metadataImages);
    }
    this.root = path.resolve(root);
    if (relativePath(this.root, path.join(this.root, stagingRelative)) !== stagingRelative) {
      throw new Error("migration journal staging path escapes the project root");
    }
    this.version = version;
    this.sourceName = sourceName;
    this.stagingRelative = stagingRelative;
    this.sourceIdentity = sourceIdentity;
    this.sourceSnapshot = sourceSnapshot;
    this.sourceSnapshotFingerprint = sourceSnapshotFingerprint;
    this.beforeImages = beforeImages;
    this.metadataImages = metadataImages;
    this.stagedManagedIdentity = stagedManagedIdentity;
    this.stagingIdentity = stagingIdentity;
    this.stagedSnapshotFingerprint = stagedSnapshotFingerprint;
    this.metadata = metadata;
    this.owner = owner;
    this.tempRootCreated = tempRootCreated;
    this.tempRootIdentity = tempRootIdentity;
    this.stagingParentIdentity = stagingParentIdentity;
    this.phase = phase;
    this.operation = operation;
    const expectedReceipt = new LayoutPublicationReceipt({ operation, sourceFingerprint: sourceSnapshotFingerprint,
      targetFingerprint: stagedSnapshotFingerprint });
    if (receipt !== null && (!(receipt instanceof LayoutPublicationReceipt)
      || JSON.stringify(receipt) !== JSON.stringify(expectedReceipt))) throw new Error("layout migration receipt does not match its journal");
    if (["final-renamed", "cleanup-source-verified", "cleanup-complete"].includes(phase) !== (receipt !== null)) throw new Error("layout migration receipt does not match its publication phase");
    if (["metadata-updated", "final-renamed", "cleanup-source-verified", "cleanup-complete"].includes(phase)
      && metadata.some((entry) => entry.plannedIdentity === null)) throw new Error("layout migration published metadata generation is missing");
    this.receipt = receipt;
    this.reservationIdentity = null;
    this.journalIdentity = null;
    this.journalHash = null;
  }

  get stagingRoot() {
    return path.join(this.root, this.stagingRelative);
  }

  get stagedManagedPath() {
    return path.join(this.stagingRoot, "managed-directory");
  }

  get backupPath() {
    return path.join(this.stagingRoot, "legacy-source-backup");
  }

  get concurrentWritePath() {
    return path.join(this.stagingRoot, "concurrent-managed-write");
  }

  get journalPath() {
    return path.join(this.root, ".tmp", JOURNAL_FILE_NAME);
  }

  assertSourceSnapshot(directory) {
    this.assertStagingAuthority();
    if (!sameDirectoryIdentity(directory, this.sourceIdentity, "legacy managed directory")) {
      throw new Error("legacy managed directory identity changed before cleanup");
    }
    if (this.sourceSnapshot.captureLike(directory).fingerprint !== this.sourceSnapshotFingerprint) {
      throw new Error(`legacy managed directory changed before cleanup; preserved at ${relativePath(this.root, directory)}`);
    }
  }

  assertSourceSnapshotSubset(directory) {
    this.sourceSnapshot.assertRemainingSubset(directory);
  }

  assertBeforeImages() {
    this.beforeImages?.assertIntact();
    this.metadataImages?.assertIntact();
  }

  assertStagedSnapshot(directory) {
    if (path.resolve(directory) === this.stagedManagedPath) this.assertStagingAuthority();
    if (!sameDirectoryIdentity(directory, this.stagedManagedIdentity, "migrated managed directory")) {
      throw new Error("migrated managed directory identity changed before commit completed");
    }
    if (this.sourceSnapshot.captureLike(directory).fingerprint !== this.stagedSnapshotFingerprint) {
      throw new Error("migrated managed directory changed before commit completed");
    }
  }

  assertPublishedState() {
    this.assertStagedSnapshot(path.join(this.root, PRODUCT.managedDirName));
    for (const entry of this.metadata) entry.assertPlanned();
  }

  preserveConcurrentStagedTree(directory) {
    this.assertCurrent();
    this.assertStagingAuthority();
    if (lstatOrNull(this.concurrentWritePath)) {
      throw new Error("concurrent managed write backup already exists");
    }
    const changed = new RealDirectoryAuthority(directory);
    if (!sameFileIdentity(changed.identity, this.stagedManagedIdentity)) {
      throw new Error("cannot preserve a changed staged managed directory with different authority");
    }
    changed.moveTo(this.concurrentWritePath, {
      commitGuard: () => { this.assertCurrent(); this.assertStagingAuthority(); changed.assertStable(); },
    });
  }

  toJSON() {
    return {
      version: this.version,
      root: this.root,
      sourceName: this.sourceName,
      stagingRelative: this.stagingRelative,
      sourceIdentity: this.sourceIdentity,
      sourceSnapshot: this.sourceSnapshot.toJSON(),
      sourceSnapshotFingerprint: this.sourceSnapshotFingerprint,
      stagedManagedIdentity: this.stagedManagedIdentity,
      stagingIdentity: this.stagingIdentity,
      stagedSnapshotFingerprint: this.stagedSnapshotFingerprint,
      metadata: this.metadata.map((entry) => entry.toJSON(this.version)),
      owner: this.owner.toJSON(),
      tempRootCreated: this.tempRootCreated,
      tempRootIdentity: this.tempRootIdentity,
      stagingParentIdentity: this.stagingParentIdentity,
      phase: this.phase,
      operation: this.operation,
      receipt: this.receipt?.toJSON() ?? null,
      ...(this.version === JOURNAL_VERSION ? { beforeImages: this.beforeImages.toJSON(), metadataImages: this.metadataImages.toJSON() } : {}),
    };
  }

  write() {
    const payload = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    const writer = new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal",
      maxBytes: DEFAULT_MAX_FILE_BYTES,
      commitGuard: () => this.assertCurrent(),
    });
    const stage = writer.createStage(payload);
    let publication;
    try { publication = writer.publishStage(stage); }
    catch (error) {
      // A response can be lost after rename. Only this retained stage's exact
      // physical generation and bytes can confirm our journal publication.
      let observed;
      try { observed = writer.readSnapshot(); }
      catch (observationError) { throw combineProcessExecutionFailures(error, observationError); }
      if (observed !== null && sameFileIdentity(observed.identity, stage.identity)
        && observed.byteLength === Buffer.byteLength(payload) && observed.digest === hashBytes(payload)) {
        this.journalIdentity = observed.identity.toJSON();
        this.journalHash = observed.digest;
      }
      throw error;
    }
    this.journalIdentity = publication.snapshot.identity.toJSON();
    this.journalHash = hashBytes(payload);
  }

  publish() {
    const payload = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    const writer = new AtomicFile(this.journalPath, { phaseNamespace: "migration-journal", maxBytes: DEFAULT_MAX_FILE_BYTES });
    const stage = writer.createStage(payload, { exclusive: true });
    const identity = stage.identity.toJSON();
    try {
      writer.publishStage(stage, { exclusive: true });
    } catch (error) {
      if (error.committedToVisibleName) this.reservationIdentity = identity;
      if (error.cause?.code === "EEXIST") {
        throw new Error("migration journal was created by another migration; source was not changed", { cause: error });
      }
      throw error;
    }
    this.reservationIdentity = identity;
    this.journalIdentity = { ...identity };
    this.journalHash = hashBytes(payload);
  }

  assertCurrent() {
    if (!this.journalIdentity || !this.journalHash) {
      throw new Error("migration journal authority is unavailable");
    }
    try {
      const captured = captureRegularFile(this.journalPath, { ...MIGRATION_READ_OPTIONS, expectedIdentity: this.journalIdentity });
      if (captured.digest !== this.journalHash) throw new Error("migration journal bytes changed");
    } catch (cause) { throw new Error("migration journal changed while the migration was active", { cause }); }
  }

  discardReservation() {
    if (!this.reservationIdentity) return;
    const removal = new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal-reservation",
      commitGuard: () => {
        const stat = assertRegularFile(this.journalPath, "migration journal reservation");
        if (!sameFileIdentity(stat, this.reservationIdentity)) {
          throw new Error("migration journal reservation changed before cleanup");
        }
      },
    }).remove();
    if (!removal.committed) throw new Error("migration journal reservation disappeared before cleanup");
    this.reservationIdentity = null;
  }

  advance(phase) {
    if (!JOURNAL_PHASES.has(phase)) throw new Error(`unsupported migration phase: ${phase}`);
    const previousPhase = this.phase;
    const previousReceipt = this.receipt;
    const previousIdentity = this.journalIdentity;
    this.phase = phase;
    if (phase === "final-renamed") this.receipt = new LayoutPublicationReceipt({ operation: this.operation,
      sourceFingerprint: this.sourceSnapshotFingerprint, targetFingerprint: this.stagedSnapshotFingerprint });
    try { this.write(); }
    catch (error) {
      if (this.journalIdentity === previousIdentity) {
        this.phase = previousPhase;
        this.receipt = previousReceipt;
      }
      throw error;
    }
  }

  assertStagingAuthority() {
    if (!sameDirectoryIdentity(this.stagingRoot, this.stagingIdentity, "migration staging directory")) {
      throw new Error("migration staging directory generation changed");
    }
  }

  removeStaging() {
    if (!lstatOrNull(this.stagingRoot)) {
      for (const entry of this.metadata) entry.cleanupStage();
      return;
    }
    this.assertStagingAuthority();
    const allowed = new Set(["managed-directory", "legacy-source-backup", "concurrent-managed-write", ...this.metadata.map((entry) => entry.name)]);
    if (fs.readdirSync(this.stagingRoot).some((name) => !allowed.has(name))) throw new Error("migration staging directory contains a foreign entry");
    if (lstatOrNull(this.concurrentWritePath)) throw new Error("concurrent managed write remains preserved in staging");
    if (lstatOrNull(this.stagedManagedPath)) this.assertStagedSnapshot(this.stagedManagedPath);
    if (lstatOrNull(this.backupPath)) this.assertSourceSnapshot(this.backupPath);
    for (const entry of this.metadata) {
      if (lstatOrNull(path.join(this.stagingRoot, entry.name))) entry.stagedContent(this.stagingRoot);
      entry.cleanupStage();
    }
    removeTree(this.stagingRoot, "migration staging directory", this.stagingIdentity);
  }

  remove() {
    new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal",
      commitGuard: () => this.assertCurrent(),
    }).remove();
  }

  static read(root) {
    const temporaryRoot = path.join(root, ".tmp");
    const temporaryStat = lstatOrNull(temporaryRoot);
    if (!temporaryStat) return null;
    assertRealDirectory(temporaryRoot, "migration temporary directory");
    const journalPath = path.join(temporaryRoot, JOURNAL_FILE_NAME);
    const stat = lstatOrNull(journalPath);
    if (!stat) return null;
    assertRegularFile(journalPath, "migration journal");
    let raw;
    let journalBytes;
    let journalSnapshot;
    try {
      journalSnapshot = captureRegularFile(journalPath, MIGRATION_READ_OPTIONS);
      journalBytes = journalSnapshot.bytes;
      raw = JSON.parse(journalBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`migration journal is invalid: ${error.message}`);
    }
    const keys = raw && typeof raw === "object" ? Object.keys(raw).sort() : [];
    const expectedKeys = ["metadata", "operation", "owner", "phase", "receipt", "root", "sourceIdentity", "sourceName", "sourceSnapshot", "sourceSnapshotFingerprint", "stagedManagedIdentity", "stagedSnapshotFingerprint", "stagingIdentity", "stagingParentIdentity", "stagingRelative", "tempRootCreated", "tempRootIdentity", "version",
      ...(raw?.version === JOURNAL_VERSION ? ["beforeImages", "metadataImages"] : [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || ![PREVIOUS_JOURNAL_VERSION, JOURNAL_VERSION].includes(raw.version) || path.resolve(raw.root || "") !== path.resolve(root)
      || !Array.isArray(raw.metadata) || !raw.sourceIdentity || !raw.stagedManagedIdentity) {
      throw new ProcessExecutionControlFailure("legacy-owner-format", "Migration journal requires revision 10 streaming evidence or a recoverable revision 9 byte/generation snapshot with token/session ownership; older journal records remain unchanged");
    }
    const metadataImages = raw.version === JOURNAL_VERSION ? LayoutMigrationEvidence.fromJSON(root, raw.metadataImages) : null;
    const journal = new LayoutMigrationJournal({
      root,
      version: raw.version,
      beforeImages: raw.version === JOURNAL_VERSION ? LayoutMigrationEvidence.fromJSON(root, raw.beforeImages) : null,
      metadataImages,
      sourceName: raw.sourceName,
      stagingRelative: raw.stagingRelative,
      sourceIdentity: raw.sourceIdentity,
      sourceSnapshot: SourceTreeSnapshot.fromJSON(raw.sourceSnapshot),
      sourceSnapshotFingerprint: raw.sourceSnapshotFingerprint,
      stagedManagedIdentity: raw.stagedManagedIdentity,
      stagingIdentity: raw.stagingIdentity,
      stagedSnapshotFingerprint: raw.stagedSnapshotFingerprint,
      metadata: raw.metadata.map(entry => raw.version === PREVIOUS_JOURNAL_VERSION
        ? RootMetadataFile.fromPreviousJSON(root, entry) : RootMetadataFile.fromJSON(root, entry, metadataImages)),
      owner: MigrationProcessOwner.fromJSON(raw.owner),
      tempRootCreated: raw.tempRootCreated,
      tempRootIdentity: raw.tempRootIdentity,
      stagingParentIdentity: raw.stagingParentIdentity,
      phase: raw.phase,
      operation: raw.operation,
      receipt: raw.receipt === null ? null : LayoutPublicationReceipt.fromJSON(raw.receipt),
    });
    journal.journalIdentity = journalSnapshot.identity.toJSON();
    journal.journalHash = hashBytes(journalBytes);
    // After the terminal cutoff only evidence retirement remains. A previous
    // cleanup can have removed individual payloads; live tree, metadata digest
    // and generation checks still precede every remaining cleanup effect.
    for (const entry of ["cleanup-complete", "rollback-complete"].includes(journal.phase) ? [] : journal.metadata) {
      const expected = entry.name === ".gitignore"
        ? Buffer.from(migrateLegacyManagedGitignore(entry.original.toString("utf8")), "utf8")
        : Buffer.from(migrateLegacyManagedGitattributes(entry.original.toString("utf8")), "utf8");
      if (!expected.equals(entry.planned)) throw new Error("migration journal metadata plan is invalid");
    }
    return journal;
  }
}

// Historical journals have no token/session release authority. Detect them
// before selecting a new migration and leave their contents and effects intact.
function refuseLegacyMigrationJournal(root) {
  const journalPath = path.join(root, ".tmp", "senrail-upgrade-migrate.json");
  if (lstatOrNull(journalPath)) {
    throw new ProcessExecutionControlFailure("legacy-owner-format",
      "Legacy migration journal has no transferable token/session owner; revision 8 writer authority is required and all existing evidence remains unchanged");
  }
}

function activeFlowPresent(sourceRoot) {
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".active-flow.")) return true;
  }
  const activePath = path.join(sourceRoot, ".active-flow");
  if (!lstatOrNull(activePath)) return false;
  assertRegularFile(activePath, "legacy active-flow registry");
  try {
    const value = JSON.parse(captureRegularFile(activePath, MIGRATION_READ_OPTIONS).text());
    return !Array.isArray(value) || value.length > 0;
  } catch (error) {
    throw new Error(`legacy active-flow registry is invalid: ${error.message}`);
  }
}

function findBusyMarkers(sourceRoot) {
  const found = [];
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const source = path.join(directory, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(source);
      if (name.endsWith(".lock")) found.push(childRelative);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(source, childRelative);
    }
  };
  visit(sourceRoot);
  return found;
}

function ensureTempRoot(root) {
  const temporaryPaths = new TemporaryPaths(root);
  const temp = path.join(root, ".tmp");
  temporaryPaths.validate(temp);
  const stat = lstatOrNull(temp);
  const created = !stat;
  if (!stat) RealDirectoryAuthority.resolve(temp, { create: true, creationMode: 0o700 });
  assertRealDirectory(temp, "migration temporary directory");
  const purpose = temporaryPaths.runtime("migrate-layout");
  const purposeCreated = !lstatOrNull(purpose);
  if (purposeCreated) RealDirectoryAuthority.resolve(path.dirname(purpose), { create: true }).createExclusiveChild(path.basename(purpose));
  else assertRealDirectory(purpose, "migration staging parent");
  return { temp, created, identity: created ? directoryIdentity(temp, "migration temporary directory") : null,
    stagingParentIdentity: purposeCreated ? directoryIdentity(purpose, "migration staging parent") : null };
}

function removeCreatedTempRoot(root, created, identity, stagingParentIdentity) {
  const temp = path.join(root, ".tmp");
  if (!lstatOrNull(temp)) return;
  const temporaryPaths = new TemporaryPaths(root);
  const purpose = temporaryPaths.runtime("migrate-layout");
  if (stagingParentIdentity !== null && lstatOrNull(purpose)
    && sameDirectoryIdentity(purpose, stagingParentIdentity, "migration staging parent") && fs.readdirSync(purpose).length === 0) {
    new RealDirectoryAuthority(purpose).removeEmpty();
  }
  if (!created || !sameDirectoryIdentity(temp, identity, "migration temporary directory")) return;
  for (const directory of [path.dirname(purpose), temp]) {
    if (!lstatOrNull(directory)) continue;
    temporaryPaths.validate(directory);
    assertRealDirectory(directory, "migration temporary directory");
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}

function migrationState(root) {
  const states = new Map();
  for (const name of [...LEGACY_DIRECTORY_NAMES, PRODUCT.managedDirName]) {
    const target = path.join(root, name);
    const stat = lstatOrNull(target);
    if (stat) states.set(name, stat);
  }
  return states;
}

/** Captured domain input; repository exclusion must not change this baseline. */
class LayoutMigrationPreflight {
  constructor(root) {
    this.root = root;
    this.authority = new RealDirectoryAuthority(root);
    refuseLegacyMigrationJournal(root);
    this.journal = LayoutMigrationJournal.read(root);
    this.journal?.owner.assertInactive();
    if (this.journal !== null) this.#assertMovableFromCwd([this.journal.stagingRoot,
      ...(this.journal.beforeImages === null ? [] : [this.journal.beforeImages.directory]),
      ...(this.journal.receipt === null ? [path.join(root, this.journal.sourceName), path.join(root, PRODUCT.managedDirName)] : [])]);
    const state = migrationState(root);
    this.canonicalExists = state.has(PRODUCT.managedDirName);
    this.identities = [...(this.journal === null && this.canonicalExists ? [[PRODUCT.managedDirName, state.get(PRODUCT.managedDirName)]] : state)].map(([name, stat]) => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`managed directory must be a real directory: ${name}`);
      return [name, directoryIdentity(path.join(root, name), "managed directory")];
    });
    this.noop = this.journal === null && (state.has(PRODUCT.managedDirName) || state.size === 0);
    this.source = null;
    this.sourceName = null;
    this.metadata = [];
    if (this.journal === null && !this.noop) {
      if (state.size !== 1) throw new Error(`migration refuses to merge legacy managed directories automatically: ${[...state.keys()].join(", ")}`);
      const sourceName = [...state.keys()][0];
      this.sourceName = sourceName;
      const sourceRoot = path.join(root, sourceName);
      this.#assertMovableFromCwd([sourceRoot]);
      if (lstatOrNull(path.join(sourceRoot, "process-runtime"))) throw new ProcessExecutionControlFailure("record-unsupported", "Legacy managed runtime requires explicit execution-receipt investigation before layout migration; its evidence remains unchanged");
      if (activeFlowPresent(sourceRoot)) throw new Error("migration refuses while a legacy Flow is active or preparing");
      const busy = findBusyMarkers(sourceRoot);
      if (busy.length) throw new Error(`migration refuses while another process may be writing managed files: ${busy.join(", ")}`);
      this.source = SourceTreeSnapshot.capture(sourceRoot);
      assertTemplateReferencesRemainResolvable(root, sourceRoot, this.source);
      this.metadata = [RootMetadataFile.plan(root, ".gitignore", migrateLegacyManagedGitignore),
        RootMetadataFile.plan(root, ".gitattributes", migrateLegacyManagedGitattributes)];
    }
    this.serialized = this.#serialize();
  }

  #serialize() {
    return JSON.stringify({ identities: this.identities, journal: this.journal?.journalHash ?? null,
      journalIdentity: this.journal?.journalIdentity ?? null,
      source: this.source?.fingerprint ?? null, metadata: this.metadata.map((entry) => entry.toPreflightJSON()) });
  }

  #assertMovableFromCwd(directories) {
    if (directories.some((directory) => isNativePathWithin(directory, process.cwd()))) {
      throw new ProcessExecutionControlFailure("input-invalid", "Layout migration cannot move its own current working directory; run from the project root");
    }
  }

  assertUnchanged() {
    this.authority.assertStable();
    const current = new LayoutMigrationPreflight(this.root);
    if (current.serialized !== this.serialized) throw new Error("layout migration input changed after preflight");
  }
}

/**
 * Owns the migration preflight, staged tree construction, commit, rollback,
 * and journal-driven recovery boundaries.
 */
export class LayoutMigrationRevisionOne {
  constructor(root, {
    dryRun = false,
    logger = console,
  } = {}) {
    this.root = path.resolve(root);
    this.dryRun = dryRun;
    this.logger = logger;
  }

  run() {
    const preflight = new LayoutMigrationPreflight(this.root);
    if (this.dryRun || preflight.noop) return this.#runOwned(preflight);
    return withRepositoryMigrationExclusion(this.root, { revalidate: () => preflight.assertUnchanged() },
      () => this.#runOwned(preflight));
  }

  #runOwned(preflight) {
    const recovery = preflight.journal;
    if (recovery) {
      recovery.owner.assertInactive();
      if (this.dryRun) {
        this.logger.log("[migrate] DRY-RUN: a valid migration journal would be recovered; no files were changed.");
        return { migrated: false, recovered: true, noop: false, complete: false, requiresRecovery: true };
      }
      const recovered = this.#recover(recovery);
      this.logger.log(recovered === "cleanup"
        ? "[migrate] recovered incomplete cleanup after the final rename."
        : "[migrate] recovered an interrupted migration by restoring the legacy directory.");
      // Do not report success just because a journal was removed.  Cleanup
      // recovery must validate the canonical target through normal preflight,
      // and rollback recovery must make one safe same-invocation attempt to
      // migrate the restored legacy source.
      return { ...this.#runOwned(new LayoutMigrationPreflight(this.root)), recovered: true,
        ...(recovered === "cleanup" ? { receipt: recovery.receipt.toJSON() } : {}) };
    }

    if (preflight.canonicalExists) {
      this.logger.error(`[migrate] ${PRODUCT.managedDirName} already exists; layout revision 1 is already applied.`);
      return { migrated: false, recovered: false, noop: true, complete: true };
    }
    if (preflight.sourceName === null) {
      this.logger.log("[migrate] no managed directory requires layout revision 1.");
      return { migrated: false, recovered: false, noop: true, complete: true };
    }
    const sourceName = preflight.sourceName;
    const sourceRoot = path.join(this.root, sourceName);
    const snapshot = preflight.source;
    const treePlan = snapshot.treePlan;
    const metadata = preflight.metadata;
    if (this.dryRun) {
      this.#printDryRunPlan(sourceName, treePlan, metadata);
      return {
        migrated: false,
        sourceName,
        recovered: false,
        noop: false,
      };
    }

    const tempState = ensureTempRoot(this.root);
    const temporaryPaths = new TemporaryPaths(this.root);
    let stagingRoot = null;
    let stagingIdentity = null;
    let journal = null;
    let beforeImages = null;
    let metadataImages = null;
    let stagingCreated = false;
    let retainStagingForRecovery = false;
    let primaryFailure = null;
    try {
      stagingRoot = temporaryPaths.create(temporaryPaths.runtime("migrate-layout"), STAGING_PREFIX);
      stagingIdentity = directoryIdentity(stagingRoot, "migration staging directory");
      stagingCreated = true;
      beforeImages = snapshot.createBeforeImages(this.root);
      const stagedManaged = path.join(stagingRoot, "managed-directory");
      RealDirectoryAuthority.resolve(path.dirname(stagedManaged)).createExclusiveChild(path.basename(stagedManaged), { creationMode: 0o700 });
      snapshot.copyTo(stagedManaged);
      snapshot.assertStaged(stagedManaged);
      const stagedSnapshot = SourceTreeSnapshot.capture(stagedManaged);
      snapshot.assertUnchanged(sourceRoot);
      for (const entry of metadata) {
        entry.stage(stagingRoot);
        entry.stagedContent(stagingRoot);
      }
      metadataImages = LayoutMigrationEvidence.create(this.root, metadata.flatMap(entry => entry.evidenceRequests(stagingRoot)));
      for (const entry of metadata) entry.bindEvidence(metadataImages);
      const pendingJournal = new LayoutMigrationJournal({
        root: this.root,
        sourceName,
        stagingRelative: relativePath(this.root, stagingRoot),
        sourceIdentity: directoryIdentity(sourceRoot, "legacy managed directory"),
        sourceSnapshot: snapshot,
        sourceSnapshotFingerprint: snapshot.fingerprint,
        beforeImages,
        metadataImages,
        stagedManagedIdentity: directoryIdentity(stagedManaged, "migration staged directory"),
        stagingIdentity: directoryIdentity(stagingRoot, "migration staging directory"),
        stagedSnapshotFingerprint: stagedSnapshot.fingerprint,
        metadata,
        owner: MigrationProcessOwner.current(),
        tempRootCreated: tempState.created,
        tempRootIdentity: tempState.identity,
        stagingParentIdentity: tempState.stagingParentIdentity,
      });
      try {
        pendingJournal.publish();
      } catch (error) {
        if (pendingJournal.reservationIdentity) {
          try {
            pendingJournal.discardReservation();
          } catch (cleanupError) {
            retainStagingForRecovery = true;
            throw new AggregateError(
              [error, cleanupError],
              "migration journal publication and reservation cleanup both failed",
              { cause: error },
            );
          }
        }
        throw error;
      }
      pendingJournal.owner.activate();
      journal = pendingJournal;
      this.#commit(journal, snapshot);
      this.logger.log(`[migrate] migrated ${sourceName} to ${PRODUCT.managedDirName}.`);
      return { migrated: true, recovered: false, noop: false, complete: true, receipt: journal.receipt.toJSON() };
    } catch (error) {
      primaryFailure = error;
      if (journal) {
        const canonicalVisible = lstatOrNull(path.join(this.root, PRODUCT.managedDirName));
        if (journal.receipt !== null || this.#finalRenameVisible(journal)
          || (journal.phase === "final-renamed" && canonicalVisible?.isDirectory() && !canonicalVisible.isSymbolicLink())) {
          // The final state is authoritative. Leave its journal for the next
          // next layout-migration invocation to complete cleanup safely.
          throw error;
        }
        try {
          this.#rollback(journal);
        } catch (rollbackError) {
          primaryFailure = new AggregateError([error, rollbackError], `migration and rollback both failed: ${error.message}; rollback: ${rollbackError.message}`, { cause: error });
          throw primaryFailure;
        }
      } else if (!retainStagingForRecovery) {
        try {
          metadataImages?.discardPrepared();
          beforeImages?.discardPrepared();
          if (stagingCreated) removeTree(stagingRoot, "migration staging directory", stagingIdentity);
          removeCreatedTempRoot(this.root, tempState.created, tempState.identity, tempState.stagingParentIdentity);
        } catch (cleanupError) {
          primaryFailure = combineProcessExecutionFailures(error, cleanupError);
          throw primaryFailure;
        }
      }
      throw error;
    } finally {
      if (journal) {
        try {
          journal.owner = journal.owner.release();
          // This releases only the synchronous journal writer. Snapshot and
          // effect validation remain mandatory in the existing recovery path.
          if (lstatOrNull(journal.journalPath)) journal.write();
        } catch (releaseFailure) {
          if (primaryFailure === null) throw releaseFailure;
          throw new AggregateError([primaryFailure, releaseFailure], `migration and writer release both failed: ${primaryFailure.message}; release: ${releaseFailure.message}`, { cause: primaryFailure });
        }
      }
    }
  }

  #printDryRunPlan(sourceName, treePlan, metadata) {
    this.logger.log(`[migrate] DRY-RUN: ${sourceName} -> ${PRODUCT.managedDirName}`);
    this.logger.log(`[migrate] DRY-RUN: stage ${treePlan.size} managed entries under .tmp/runtime/migrate-layout/${STAGING_PREFIX}<id>/managed-directory`);
    for (const line of treePlan.toDryRunLines()) this.logger.log(`[migrate] DRY-RUN: ${line}`);
    for (const entry of metadata) {
      const status = entry.original.equals(entry.planned) ? "unchanged" : "replace";
      this.logger.log(`[migrate] DRY-RUN: ${status} ${entry.name}`);
    }
    this.logger.log("[migrate] DRY-RUN: no files, directories, journals, or metadata were changed.");
  }

  #commit(journal, snapshot) {
    journal.assertCurrent();
    journal.assertBeforeImages();
    const sourceRoot = path.join(this.root, journal.sourceName);
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    if (lstatOrNull(canonical) || lstatOrNull(journal.backupPath)) {
      throw new Error("migration destination appeared after preflight");
    }
    if (!sameDirectoryIdentity(sourceRoot, journal.sourceIdentity, "legacy managed directory")) {
      throw new Error("legacy managed directory identity changed before migration commit");
    }
    snapshot.assertUnchanged(sourceRoot);
    for (const entry of journal.metadata) entry.assertOriginal();

    // Keep the pre-existing root only in the private staging directory.  A
    // migration never materializes a retired product path as an intermediate.
    if (fs.lstatSync(sourceRoot, { bigint: true }).dev !== fs.lstatSync(journal.stagingRoot, { bigint: true }).dev) {
      throw new Error("migration staging and source must share one volume");
    }
    new RealDirectoryAuthority(sourceRoot).moveTo(journal.backupPath, {
      commitGuard: () => { journal.assertCurrent(); snapshot.assertUnchanged(sourceRoot); },
    });
    journal.advance("legacy-backed-up");
    for (const entry of journal.metadata) entry.apply(journal.stagingRoot, {
      record: () => journal.write(), assertCurrent: () => journal.assertCurrent(),
    });
    journal.advance("metadata-updated");
    new RealDirectoryAuthority(journal.stagedManagedPath).moveTo(canonical, {
      commitGuard: () => { journal.assertCurrent(); journal.assertStagedSnapshot(journal.stagedManagedPath); for (const entry of journal.metadata) entry.assertPlanned(); },
    });
    journal.assertPublishedState();
    journal.advance("final-renamed");
    this.#completeCleanup(journal);
  }

  #finalRenameVisible(journal) {
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    const stat = lstatOrNull(canonical);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || lstatOrNull(path.join(this.root, journal.sourceName))) return false;
    try {
      journal.assertPublishedState();
      return true;
    } catch (_) {
      return false;
    }
  }

  #completeCleanup(journal) {
    journal.assertCurrent();
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    try {
      journal.assertStagedSnapshot(canonical);
    } catch (error) {
      // An unconfirmed target can still use the owned quarantine and rollback.
      // A receipt-confirmed published tree stays in place with its journal.
      if (journal.receipt === null) journal.preserveConcurrentStagedTree(canonical);
      throw error;
    }
    for (const entry of journal.metadata) entry.assertPlanned();
    if (journal.receipt === null) journal.advance("final-renamed");
    const source = path.join(this.root, journal.sourceName);
    const sourceExists = Boolean(lstatOrNull(source));
    const backupExists = Boolean(lstatOrNull(journal.backupPath));
    if (sourceExists && backupExists) {
      throw new Error("legacy managed directory and its cleanup backup both exist");
    }
    if (lstatOrNull(source)) {
      throw new Error(`legacy managed directory path reappeared during cleanup: ${journal.sourceName}`);
    }
    journal.assertBeforeImages();
    if (lstatOrNull(journal.backupPath)) {
      if (journal.phase !== "cleanup-source-verified") {
        journal.assertSourceSnapshot(journal.backupPath);
        journal.advance("cleanup-source-verified");
      } else {
        journal.assertSourceSnapshotSubset(journal.backupPath);
      }
      journal.assertCurrent();
      removeTree(journal.backupPath, `legacy ${journal.sourceName} backup`, journal.sourceIdentity);
    }
    if (lstatOrNull(source)) {
      throw new Error(`legacy managed directory path reappeared during cleanup: ${journal.sourceName}`);
    }
    journal.assertPublishedState();
    journal.removeStaging();
    journal.assertBeforeImages();
    journal.assertPublishedState();
    this.#finishJournalCleanup(journal, "cleanup-complete");
  }

  #rollback(journal) {
    journal.assertCurrent();
    journal.assertBeforeImages();
    if (journal.receipt !== null || this.#finalRenameVisible(journal)) {
      throw new Error("cannot roll back after the final rename; cleanup recovery is required");
    }
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    const backupExists = Boolean(lstatOrNull(journal.backupPath));
    if (lstatOrNull(canonical)) {
      if (!sameDirectoryIdentity(canonical, journal.stagedManagedIdentity, "staged canonical directory")) {
        throw new Error("cannot remove canonical directory changed by another process");
      }
      try {
        journal.assertStagedSnapshot(canonical);
      } catch (_) {
        journal.preserveConcurrentStagedTree(canonical);
      }
      if (lstatOrNull(canonical)) removeTree(canonical, "staged canonical directory", journal.stagedManagedIdentity);
    }
    for (const entry of journal.metadata) entry.restore({
      record: () => journal.write(), assertCurrent: () => journal.assertCurrent(),
    });
    const source = path.join(this.root, journal.sourceName);
    if (backupExists) {
      if (lstatOrNull(source)) throw new Error(`cannot restore legacy directory because its original path is occupied: ${journal.sourceName}`);
      if (!sameDirectoryIdentity(journal.backupPath, journal.sourceIdentity, "legacy managed directory backup")) {
        throw new Error("cannot restore legacy managed directory backup changed by another process");
      }
      journal.assertSourceSnapshot(journal.backupPath);
      new RealDirectoryAuthority(journal.backupPath).moveTo(source);
    } else if (!lstatOrNull(source)) {
      throw new Error("legacy managed directory disappeared before rollback");
    }
    if (lstatOrNull(journal.concurrentWritePath)) {
      throw new Error(`concurrent managed write was preserved at ${relativePath(this.root, journal.concurrentWritePath)}`);
    }
    journal.removeStaging();
    if (journal.beforeImages !== null) {
      journal.assertBeforeImages();
    }
    this.#finishJournalCleanup(journal, "rollback-complete");
  }

  #finishJournalCleanup(journal, cutoff) {
    if (journal.beforeImages !== null) {
      if (lstatOrNull(journal.stagingRoot)) throw new Error("migration cleanup cutoff requires completed staging cleanup");
      const source = path.join(this.root, journal.sourceName);
      if (cutoff === "cleanup-complete") {
        if (lstatOrNull(source)) throw new Error(`legacy managed directory path reappeared during cleanup: ${journal.sourceName}`);
        journal.assertPublishedState();
      } else {
        if (lstatOrNull(path.join(this.root, PRODUCT.managedDirName))) {
          throw new Error("cannot finish rollback with a canonical directory present");
        }
        journal.sourceSnapshot.assertUnchanged(source);
        for (const entry of journal.metadata) entry.assertRestored();
      }
      if (journal.phase !== cutoff) journal.advance(cutoff);
      journal.beforeImages.removeAfterCompletion();
      journal.metadataImages.removeAfterCompletion();
    }
    journal.remove();
    this.#removeCreatedTempRoot(journal);
  }

  #removeCreatedTempRoot(journal) {
    removeCreatedTempRoot(this.root, journal.tempRootCreated, journal.tempRootIdentity, journal.stagingParentIdentity);
  }

  #recover(journal) {
    journal.assertCurrent();
    if (["cleanup-complete", "rollback-complete"].includes(journal.phase)) {
      const cutoff = journal.phase;
      this.#finishJournalCleanup(journal, cutoff);
      return cutoff === "cleanup-complete" ? "cleanup" : "rollback";
    }
    journal.assertBeforeImages();
    if (journal.receipt !== null || this.#finalRenameVisible(journal)) {
      this.#completeCleanup(journal);
      return "cleanup";
    }
    this.#rollback(journal);
    return "rollback";
  }

}
