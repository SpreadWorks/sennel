/**
 * Explicit, one-way managed-directory layout migration.
 *
 * Normal runtime deliberately does not import this module. Legacy names are
 * confined here so opening a current project never creates a compatibility
 * path by accident.
 */

import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

import { AtomicFile, fsyncDirectory } from "./atomic-file.js";
import { loadConfigFromManagedDirectory } from "./config.js";
import { LEGACY_MANAGED_DIRECTORY_NAMES } from "./legacy-managed-directory-migration.js";
import { migrateLegacyManagedGitattributes, migrateLegacyManagedGitignore } from "./legacy-managed-metadata-migration.js";
import { validatePresetChainFromManagedDirectory } from "./presets.js";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { PRODUCT } from "./product.js";
import { TemporaryPaths } from "./temporary-paths.js";

// This is intentionally the complete boundary for retired managed roots.
// Nothing outside the explicit layout revision may interpret these names.
const LEGACY_DIRECTORY_NAMES = LEGACY_MANAGED_DIRECTORY_NAMES;
const STAGING_PREFIX = "sennel-migrate-layout-";
const JOURNAL_FILE_NAME = "sennel-migrate-layout.json";
const JOURNAL_VERSION = 7;
const JOURNAL_PHASES = new Set([
  "staged",
  "legacy-backed-up",
  "placed-canonical",
  "metadata-updated",
  "final-renamed",
  "cleanup-source-verified",
]);
const RAW_COPY_ROOTS = new Set(["plugins", "plugin-sources"]);
const OPEN_ACCESS_MODE_MASK = 0o3;
const ACTIVE_MIGRATION_OWNER_TOKENS = new Set();
const MANAGED_TEMPLATE_FIELD_REPLACEMENTS = Object.freeze(new Map([
  // These were public names in generated template guidance. They are not
  // arbitrary camel-case words: each maps to the current container path key.
  ["sentiDir", "managedDir"],
]));

function relativePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
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
  const stat = lstatOrNull(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
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
  const stat = assertRealDirectory(directory, label);
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(directory, identity, label) {
  const stat = assertRealDirectory(directory, label);
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class ManagedOpenHandle {
  constructor({ pid, descriptor, target }) {
    if (!/^\d+$/.test(pid) || typeof descriptor !== "string" || !path.isAbsolute(target)) {
      throw new Error("managed open handle identity is invalid");
    }
    this.pid = pid;
    this.descriptor = descriptor;
    this.target = target;
    Object.freeze(this);
  }

  toString() {
    return `pid=${this.pid} handle=${this.descriptor}`;
  }
}

class ManagedOpenHandles {
  constructor(entries) {
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  static inspect(directory, procRoot) {
    const root = path.resolve(directory);
    const found = [];
    const inspectLink = (pid, descriptor, linkPath) => {
      let target;
      try {
        target = fs.readlinkSync(linkPath).replace(/ \(deleted\)$/, "");
      } catch (_) {
        return;
      }
      if (!path.isAbsolute(target) || !isWithinDirectory(root, path.resolve(target))) return;
      if (descriptor !== "cwd") {
        let flags;
        try {
          const fdinfo = fs.readFileSync(path.join(procRoot, pid, "fdinfo", descriptor), "utf8");
          const match = fdinfo.match(/^flags:\s+([0-7]+)$/m);
          flags = match ? Number.parseInt(match[1], 8) : null;
        } catch (_) {
          return;
        }
        const writable = flags != null && (flags & OPEN_ACCESS_MODE_MASK) !== fs.constants.O_RDONLY;
        let directoryHandle = false;
        try {
          directoryHandle = fs.statSync(path.resolve(target)).isDirectory();
        } catch (_) {
          // The handle target can disappear between procfs inspection calls.
        }
        if (!writable && !directoryHandle) return;
      }
      found.push(new ManagedOpenHandle({ pid, descriptor, target: path.resolve(target) }));
    };
    const inspectMappings = (pid, mapsPath) => {
      let mappings;
      try {
        mappings = fs.readFileSync(mapsPath, "utf8");
      } catch (_) {
        return;
      }
      for (const line of mappings.split("\n")) {
        const match = line.match(/^([0-9a-f]+-[0-9a-f]+)\s+([r-][w-][x-][ps])\s+\S+\s+\S+\s+\d+\s+(.+)$/i);
        if (!match || match[2][1] !== "w" || match[2][3] !== "s") continue;
        const target = match[3]
          .replace(/ \(deleted\)$/, "")
          .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
        if (!path.isAbsolute(target) || !isWithinDirectory(root, path.resolve(target))) continue;
        found.push(new ManagedOpenHandle({
          pid,
          descriptor: `map:${match[1]}`,
          target: path.resolve(target),
        }));
      }
    };
    for (const pid of fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry))) {
      const processRoot = path.join(procRoot, pid);
      inspectLink(pid, "cwd", path.join(processRoot, "cwd"));
      inspectMappings(pid, path.join(processRoot, "maps"));
      let descriptors;
      try {
        descriptors = fs.readdirSync(path.join(processRoot, "fd"));
      } catch (_) {
        descriptors = [];
      }
      for (const descriptor of descriptors) {
        inspectLink(pid, descriptor, path.join(processRoot, "fd", descriptor));
      }
    }
    return new ManagedOpenHandles(found);
  }

  get isEmpty() {
    return this.entries.length === 0;
  }

  assertEmpty(label) {
    if (this.isEmpty) return;
    const detail = this.entries.slice(0, 5).map((entry) => entry.toString()).join(", ");
    throw new Error(`migration refuses while ${label} has open process handles: ${detail}`);
  }
}

export class ManagedOpenHandleInspector {
  constructor({ platform = process.platform, procRoot = "/proc" } = {}) {
    if (typeof platform !== "string" || platform === "") {
      throw new Error("managed open-handle inspector platform is invalid");
    }
    if (typeof procRoot !== "string" || !path.isAbsolute(procRoot)) {
      throw new Error("managed open-handle inspector proc root is invalid");
    }
    this.platform = platform;
    this.procRoot = path.resolve(procRoot);
    Object.freeze(this);
  }

  inspect(directory) {
    if (this.platform !== "linux" || !fs.existsSync(this.procRoot)) {
      throw new Error(
        `migration cannot safely inspect managed-directory writers on ${this.platform}; no files were changed`,
      );
    }
    return ManagedOpenHandles.inspect(directory, this.procRoot);
  }

  assertEmpty(directory, label) {
    this.inspect(directory).assertEmpty(label);
  }
}

class MigrationOwnerAssessment {
  constructor(status, reason) {
    if (!new Set(["live", "stale", "unknown"]).has(status) || typeof reason !== "string" || reason === "") {
      throw new Error("migration process owner assessment is invalid");
    }
    this.status = status;
    this.reason = reason;
    Object.freeze(this);
  }
}

class MigrationProcessIdentitySource {
  constructor(source = new ProcessIdentitySource()) {
    if (!(source instanceof ProcessIdentitySource)) throw new Error("migration process identity source is invalid");
    this.source = source;
  }

  get pid() {
    return this.source.pid;
  }

  createOwner(ownerToken) {
    if (this.source.platform === "linux") return this.source.createOwner(ownerToken);
    return new ProcessIdentity({
      pid: this.source.pid,
      bootIdentity: `platform:${this.source.platform}`,
      startFingerprint: "0",
      ownerToken,
    });
  }

  assess(owner) {
    if (this.source.platform === "linux") return this.source.assess(owner);
    if (owner.bootIdentity !== `platform:${this.source.platform}`) {
      return new MigrationOwnerAssessment("stale", "migration owner belongs to another platform identity");
    }
    try {
      process.kill(owner.pid, 0);
      return new MigrationOwnerAssessment("live", `migration owner pid ${owner.pid} is active`);
    } catch (error) {
      if (error.code === "ESRCH") {
        return new MigrationOwnerAssessment("stale", `migration owner pid ${owner.pid} no longer exists`);
      }
      if (error.code === "EPERM") {
        return new MigrationOwnerAssessment("live", `migration owner pid ${owner.pid} is active`);
      }
      return new MigrationOwnerAssessment("unknown", `migration owner state is unavailable: ${error.message}`);
    }
  }
}

class MigrationProcessOwner {
  constructor({ processIdentity, identitySource }) {
    this.processIdentity = processIdentity instanceof ProcessIdentity
      ? processIdentity
      : new ProcessIdentity(processIdentity ?? {});
    if (!(identitySource instanceof MigrationProcessIdentitySource)) {
      throw new Error("migration journal process identity source is invalid");
    }
    this.identitySource = identitySource;
    Object.freeze(this);
  }

  get pid() {
    return this.processIdentity.pid;
  }

  get token() {
    return this.processIdentity.ownerToken;
  }

  static current(identitySource) {
    return new MigrationProcessOwner({
      processIdentity: identitySource.createOwner(crypto.randomUUID()),
      identitySource,
    });
  }

  static fromJSON(value, identitySource) {
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(["bootIdentity", "ownerToken", "pid", "startFingerprint"])) {
      throw new Error("migration journal process owner is invalid");
    }
    return new MigrationProcessOwner({ processIdentity: value, identitySource });
  }

  activate() {
    if (this.pid !== this.identitySource.pid || ACTIVE_MIGRATION_OWNER_TOKENS.has(this.token)) {
      throw new Error("migration journal process owner cannot be activated");
    }
    ACTIVE_MIGRATION_OWNER_TOKENS.add(this.token);
  }

  release() {
    if (this.pid === this.identitySource.pid) ACTIVE_MIGRATION_OWNER_TOKENS.delete(this.token);
  }

  assertInactive() {
    if (this.pid === this.identitySource.pid) {
      if (ACTIVE_MIGRATION_OWNER_TOKENS.has(this.token)) {
        throw new Error(`migration journal belongs to an active migration process: pid=${this.pid}`);
      }
      return;
    }
    const assessment = this.identitySource.assess(this.processIdentity);
    if (assessment.status === "live") {
      throw new Error(`migration journal belongs to an active migration process: pid=${this.pid}`);
    }
    if (assessment.status === "unknown") {
      throw new Error(`cannot determine migration journal owner state: ${assessment.reason}`);
    }
  }

  toJSON() {
    return {
      pid: this.processIdentity.pid,
      bootIdentity: this.processIdentity.bootIdentity,
      startFingerprint: this.processIdentity.startFingerprint,
      ownerToken: this.processIdentity.ownerToken,
    };
  }
}

function removeTree(directory, label) {
  const stat = lstatOrNull(directory);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${directory}`);
  fs.rmSync(directory, { recursive: true, force: true });
}

function legacyTokenToCanonical(value) {
  let transformed = value;
  for (const [legacy, canonical] of MANAGED_TEMPLATE_FIELD_REPLACEMENTS) {
    transformed = transformed.replaceAll(legacy, canonical);
  }
  return transformed
    .replace(/(?<![A-Za-z0-9_])sdd-forge(?=$|[^A-Za-z0-9_])/g, PRODUCT.machineName)
    .replace(/(?<![A-Za-z0-9_])sddForge(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.machineName)
    .replace(/(?<![A-Za-z0-9_])senti(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.machineName)
    .replace(/(?<![A-Za-z0-9_])senrail(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.machineName)
    .replace(/(?<![A-Za-z0-9_])SddForge(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.displayName)
    .replace(/(?<![A-Za-z0-9_])Senti(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.displayName)
    .replace(/(?<![A-Za-z0-9_])Senrail(?=$|[A-Z]|[^A-Za-z0-9_])/g, PRODUCT.displayName)
    .replace(/(?<![A-Za-z0-9_])SDD_FORGE(?=$|[^A-Za-z0-9_])/g, PRODUCT.machineName.toUpperCase())
    // An underscore is a word character here, intentionally preserving
    // project-owned SENTI_* environment variable names.
    .replace(/(?<![A-Za-z0-9_])SENTI(?=$|[^A-Za-z0-9_])/g, PRODUCT.machineName.toUpperCase())
    .replace(/(?<![A-Za-z0-9_])SENRAIL(?=$|[^A-Za-z0-9_])/g, PRODUCT.machineName.toUpperCase());
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
    index > templateIndex ? legacyTokenToCanonical(component) : component
  )).join("/");
}

function transformedLinkTarget(target) {
  return target.split(/([/\\])/).map((component) => {
    if (LEGACY_DIRECTORY_NAMES.includes(component)) return PRODUCT.managedDirName;
    return component;
  }).join("");
}

function transformManagedTemplate(content) {
  return legacyTokenToCanonical(content);
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function transformedFileBytes(relative, bytes) {
  return managedTemplateComponentIndex(relative) >= 0 && isUtf8(bytes)
    ? Buffer.from(transformManagedTemplate(bytes.toString("utf8")), "utf8")
    : bytes;
}

class MigrationTreePlan {
  constructor(entries) {
    if (!Array.isArray(entries)) throw new Error("migration tree plan entries are invalid");
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
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
      if (entry.kind === "symlink" && entry.target !== entry.transformedTarget) {
        return `stage symbolic link ${mapping} (${entry.target} -> ${entry.transformedTarget})`;
      }
      return `stage ${entry.kind} ${mapping}`;
    });
  }
}

class SourceTreeSnapshot {
  #targetPaths;

  constructor({ rootIdentity, rootMode, entries }) {
    this.rootIdentity = Object.freeze({ ...rootIdentity });
    this.rootMode = rootMode;
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.serialized = JSON.stringify({ rootIdentity: this.rootIdentity, rootMode: this.rootMode, entries: this.entries });
    this.#targetPaths = new Set(this.entries.map((entry) => entry.targetPath));
    Object.freeze(this.entries);
    Object.freeze(this);
  }

  static capture(root) {
    const rootStat = assertRealDirectory(root, "legacy managed directory");
    const entries = [];
    const targetPaths = new Set();
    const visit = (directory, relative = "") => {
      const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        const source = path.join(directory, name);
        const childRelative = relative === "" ? name : `${relative}/${name}`;
        const stat = fs.lstatSync(source);
        const targetPath = transformedRelativePath(childRelative);
        if (targetPaths.has(targetPath)) {
          throw new Error(`migration path collision: ${childRelative} maps to ${targetPath}`);
        }
        targetPaths.add(targetPath);
        if (stat.isDirectory()) {
          if (stat.isSymbolicLink()) throw new Error(`managed directory contains a symbolic-link directory: ${childRelative}`);
          entries.push({
            path: childRelative,
            targetPath,
            kind: "directory",
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode & 0o777,
          });
          visit(source, childRelative);
        } else if (stat.isFile()) {
          const bytes = fs.readFileSync(source);
          const transformed = transformedFileBytes(childRelative, bytes);
          entries.push({
            path: childRelative,
            targetPath,
            kind: "file",
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode & 0o777,
            hash: hashBytes(bytes),
            transformedHash: hashBytes(transformed),
          });
        } else if (stat.isSymbolicLink()) {
          entries.push({
            path: childRelative,
            targetPath,
            kind: "symlink",
            target: fs.readlinkSync(source),
            transformedTarget: transformedLinkTarget(fs.readlinkSync(source)),
          });
        } else {
          throw new Error(`managed directory contains an unsupported entry: ${childRelative}`);
        }
      }
    };
    visit(root);
    return new SourceTreeSnapshot({
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      rootMode: rootStat.mode & 0o777,
      entries,
    });
  }

  static fromJSON(value) {
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(["entries", "rootIdentity", "rootMode"])
      || !value.rootIdentity || !Array.isArray(value.entries)
      || !Number.isSafeInteger(value.rootIdentity.dev) || !Number.isSafeInteger(value.rootIdentity.ino)
      || !Number.isSafeInteger(value.rootMode) || value.rootMode < 0 || value.rootMode > 0o777) {
      throw new Error("migration journal source snapshot is invalid");
    }
    const validPath = (candidate) => typeof candidate === "string"
      && candidate !== ""
      && !path.posix.isAbsolute(candidate)
      && !candidate.split("/").includes("..");
    for (const entry of value.entries) {
      const entryKeys = entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
      const commonValid = validPath(entry?.path) && validPath(entry?.targetPath)
        && new Set(["directory", "file", "symlink"]).has(entry?.kind);
      if (!commonValid) throw new Error("migration journal source snapshot entry is invalid");
      if (entry.kind === "directory") {
        if (JSON.stringify(entryKeys) !== JSON.stringify(["dev", "ino", "kind", "mode", "path", "targetPath"])
          || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)
          || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
          throw new Error("migration journal source directory snapshot entry is invalid");
        }
      } else if (entry.kind === "file") {
        if (JSON.stringify(entryKeys) !== JSON.stringify(["dev", "hash", "ino", "kind", "mode", "path", "targetPath", "transformedHash"])
          || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)
          || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
          || !/^[0-9a-f]{64}$/.test(entry.hash) || !/^[0-9a-f]{64}$/.test(entry.transformedHash)) {
          throw new Error("migration journal source file snapshot entry is invalid");
        }
      } else if (JSON.stringify(entryKeys) !== JSON.stringify(["kind", "path", "target", "targetPath", "transformedTarget"])
        || typeof entry.target !== "string" || typeof entry.transformedTarget !== "string") {
        throw new Error("migration journal source symbolic-link snapshot entry is invalid");
      }
    }
    return new SourceTreeSnapshot(value);
  }

  toJSON() {
    return {
      rootIdentity: this.rootIdentity,
      rootMode: this.rootMode,
      entries: this.entries,
    };
  }

  get treePlan() {
    return new MigrationTreePlan(this.entries);
  }

  get fingerprint() {
    return hashBytes(this.serialized);
  }

  hasTargetPath(relative) {
    return this.#targetPaths.has(relative.split(path.sep).join("/"));
  }

  assertUnchanged(root) {
    const current = SourceTreeSnapshot.capture(root);
    if (current.serialized !== this.serialized) {
      throw new Error("legacy managed directory changed while migration staging was in progress");
    }
  }

  assertRemainingSubset(root) {
    const current = SourceTreeSnapshot.capture(root);
    if (JSON.stringify(current.rootIdentity) !== JSON.stringify(this.rootIdentity)
      || current.rootMode !== this.rootMode) {
      throw new Error("legacy managed directory authority changed during cleanup");
    }
    const expected = new Map(this.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    for (const entry of current.entries) {
      if (expected.get(entry.path) !== JSON.stringify(entry)) {
        throw new Error(`legacy managed directory changed during cleanup: ${entry.path}`);
      }
    }
  }

  assertStaged(root) {
    const rootStat = assertRealDirectory(root, "migration staged directory");
    if ((rootStat.mode & 0o777) !== this.rootMode) {
      throw new Error("migration staged tree does not preserve the managed root directory mode");
    }
    const actual = [];
    const visit = (directory, relative = "") => {
      for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
        const target = path.join(directory, name);
        const childRelative = relative === "" ? name : `${relative}/${name}`;
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) {
          if (stat.isSymbolicLink()) throw new Error(`migration staged tree has a symbolic-link directory: ${childRelative}`);
          actual.push({ path: childRelative, kind: "directory", mode: stat.mode & 0o777 });
          visit(target, childRelative);
        } else if (stat.isFile()) {
          actual.push({
            path: childRelative,
            kind: "file",
            mode: stat.mode & 0o777,
            hash: hashBytes(fs.readFileSync(target)),
          });
        } else if (stat.isSymbolicLink()) {
          actual.push({ path: childRelative, kind: "symlink", target: fs.readlinkSync(target) });
        } else {
          throw new Error(`migration staged tree contains an unsupported entry: ${childRelative}`);
        }
      }
    };
    visit(root);
    const expected = this.entries.map((entry) => {
      if (entry.kind === "directory") {
        return { path: entry.targetPath, kind: entry.kind, mode: entry.mode };
      }
      if (entry.kind === "file") {
        return { path: entry.targetPath, kind: entry.kind, mode: entry.mode, hash: entry.transformedHash };
      }
      return { path: entry.targetPath, kind: entry.kind, target: entry.transformedTarget };
    });
    const comparePath = (left, right) => left.path.localeCompare(right.path);
    const serializedActual = JSON.stringify(actual.sort(comparePath));
    if (serializedActual !== JSON.stringify(expected.sort(comparePath))) {
      throw new Error("migration staged tree does not match the source-derived transformation");
    }
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
 * Invalid historical configuration remains opaque data for this revision;
 * only a change caused by the path conversion itself is rejected.
 */
function assertTemplateReferencesRemainResolvable(projectRoot, sourceRoot, snapshot) {
  let config;
  try {
    config = loadConfigFromManagedDirectory(sourceRoot);
  } catch (_) {
    return;
  }
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

class RootMetadataFile {
  constructor({ root, name, existed, original, planned }) {
    this.root = root;
    this.name = name;
    this.existed = existed;
    this.original = Buffer.from(original);
    this.planned = Buffer.from(planned);
    Object.freeze(this);
  }

  get filePath() {
    return path.join(this.root, this.name);
  }

  static plan(root, name, transform) {
    const filePath = path.join(root, name);
    const stat = lstatOrNull(filePath);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error(`root metadata file must be a regular file: ${name}`);
    }
    const original = stat ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const planned = Buffer.from(transform(original.toString("utf8")), "utf8");
    return new RootMetadataFile({ root, name, existed: Boolean(stat), original, planned });
  }

  static fromJSON(root, value) {
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(["existed", "name", "original", "planned"])
      || typeof value.name !== "string" || typeof value.existed !== "boolean"
      || typeof value.original !== "string" || typeof value.planned !== "string") {
      throw new Error("migration root metadata journal entry is invalid");
    }
    return new RootMetadataFile({
      root,
      name: value.name,
      existed: value.existed,
      original: Buffer.from(value.original, "base64"),
      planned: Buffer.from(value.planned, "base64"),
    });
  }

  toJSON() {
    return {
      name: this.name,
      existed: this.existed,
      original: this.original.toString("base64"),
      planned: this.planned.toString("base64"),
    };
  }

  stage(stagingRoot) {
    fs.writeFileSync(path.join(stagingRoot, this.name), this.planned, "utf8");
  }

  stagedContent(stagingRoot) {
    const stagedPath = path.join(stagingRoot, this.name);
    assertRegularFile(stagedPath, `staged root metadata ${this.name}`);
    const content = fs.readFileSync(stagedPath);
    if (!content.equals(this.planned)) {
      throw new Error(`staged root metadata changed before migration commit: ${this.name}`);
    }
    return content;
  }

  #assertExact(expected) {
    const stat = lstatOrNull(this.filePath);
    if (!expected) {
      if (stat) throw new Error(`root metadata appeared before migration: ${this.name}`);
      return false;
    }
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`root metadata changed before migration: ${this.name}`);
    }
    if (!fs.readFileSync(this.filePath).equals(expected)) {
      throw new Error(`root metadata content changed before migration: ${this.name}`);
    }
    return true;
  }

  assertOriginal() {
    return this.#assertExact(this.existed ? this.original : null);
  }

  assertPlanned() {
    return this.#assertExact(this.planned);
  }

  #assertRestorable() {
    const stat = lstatOrNull(this.filePath);
    if (this.existed) {
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`cannot restore root metadata with changed authority: ${this.name}`);
      }
      const current = fs.readFileSync(this.filePath);
      if (!current.equals(this.planned) && !current.equals(this.original)) {
        throw new Error(`cannot restore root metadata changed by another process: ${this.name}`);
      }
      return true;
    }
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(this.filePath).equals(this.planned)) {
      throw new Error(`cannot remove root metadata changed by another process: ${this.name}`);
    }
    return true;
  }

  apply(stagingRoot) {
    const staged = this.stagedContent(stagingRoot);
    this.assertOriginal();
    new AtomicFile(this.filePath, {
      phaseNamespace: "layout-migration-metadata",
      commitGuard: () => this.assertOriginal(),
    }).write(staged);
  }

  restore() {
    const present = this.#assertRestorable();
    if (this.existed) {
      new AtomicFile(this.filePath, {
        phaseNamespace: "layout-migration-metadata-restore",
        commitGuard: () => this.#assertRestorable(),
      }).write(this.original);
      return;
    }
    if (!present) return;
    new AtomicFile(this.filePath, {
      phaseNamespace: "layout-migration-metadata-restore",
      commitGuard: () => this.#assertRestorable(),
    }).remove();
  }
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
    stagedSnapshotFingerprint,
    metadata,
    owner,
    tempRootCreated,
    tempRootIdentity,
    phase = "staged",
  }) {
    if (!LEGACY_DIRECTORY_NAMES.includes(sourceName)) throw new Error("migration journal source directory is invalid");
    if (!JOURNAL_PHASES.has(phase)) throw new Error(`migration journal phase is invalid: ${phase}`);
    if (!new RegExp(`^\\.tmp/runtime/migrate-layout/${STAGING_PREFIX}[A-Za-z0-9]{6}$`).test(stagingRelative)) {
      throw new Error("migration journal staging path is invalid");
    }
    new TemporaryPaths(root).validate(path.join(root, stagingRelative));
    for (const identity of [sourceIdentity, stagedManagedIdentity]) {
      if (!identity || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(["dev", "ino"])
        || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) {
        throw new Error("migration journal directory identity is invalid");
      }
    }
    if (!(sourceSnapshot instanceof SourceTreeSnapshot)
      || JSON.stringify(sourceSnapshot.rootIdentity) !== JSON.stringify(sourceIdentity)
      || sourceSnapshot.fingerprint !== sourceSnapshotFingerprint) {
      throw new Error("migration journal source snapshot authority is invalid");
    }
    for (const [label, fingerprint] of [
      ["source", sourceSnapshotFingerprint],
      ["staged", stagedSnapshotFingerprint],
    ]) {
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new Error(`migration journal ${label} snapshot fingerprint is invalid`);
      }
    }
    if (typeof tempRootCreated !== "boolean") throw new Error("migration journal temporary-directory state is invalid");
    if (tempRootCreated !== Boolean(tempRootIdentity)
      || (tempRootIdentity
        && (JSON.stringify(Object.keys(tempRootIdentity).sort()) !== JSON.stringify(["dev", "ino"])
          || !Number.isSafeInteger(tempRootIdentity.dev) || !Number.isSafeInteger(tempRootIdentity.ino)))) {
      throw new Error("migration journal temporary-directory identity is invalid");
    }
    if (!(owner instanceof MigrationProcessOwner)) throw new Error("migration journal process owner is invalid");
    const metadataNames = metadata.map((entry) => entry.name).sort();
    if (JSON.stringify(metadataNames) !== JSON.stringify([".gitattributes", ".gitignore"])) {
      throw new Error("migration journal metadata authority is invalid");
    }
    this.root = path.resolve(root);
    if (relativePath(this.root, path.join(this.root, stagingRelative)) !== stagingRelative) {
      throw new Error("migration journal staging path escapes the project root");
    }
    this.sourceName = sourceName;
    this.stagingRelative = stagingRelative;
    this.sourceIdentity = sourceIdentity;
    this.sourceSnapshot = sourceSnapshot;
    this.sourceSnapshotFingerprint = sourceSnapshotFingerprint;
    this.stagedManagedIdentity = stagedManagedIdentity;
    this.stagedSnapshotFingerprint = stagedSnapshotFingerprint;
    this.metadata = metadata;
    this.owner = owner;
    this.tempRootCreated = tempRootCreated;
    this.tempRootIdentity = tempRootIdentity;
    this.phase = phase;
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
    if (!sameDirectoryIdentity(directory, this.sourceIdentity, "legacy managed directory")) {
      throw new Error("legacy managed directory identity changed before cleanup");
    }
    if (SourceTreeSnapshot.capture(directory).fingerprint !== this.sourceSnapshotFingerprint) {
      throw new Error(`legacy managed directory changed before cleanup; preserved at ${relativePath(this.root, directory)}`);
    }
  }

  assertSourceSnapshotSubset(directory) {
    this.sourceSnapshot.assertRemainingSubset(directory);
  }

  assertStagedSnapshot(directory) {
    if (!sameDirectoryIdentity(directory, this.stagedManagedIdentity, "migrated managed directory")) {
      throw new Error("migrated managed directory identity changed before commit completed");
    }
    if (SourceTreeSnapshot.capture(directory).fingerprint !== this.stagedSnapshotFingerprint) {
      throw new Error("migrated managed directory changed before commit completed");
    }
  }

  preserveConcurrentStagedTree(directory) {
    if (lstatOrNull(this.concurrentWritePath)) {
      throw new Error("concurrent managed write backup already exists");
    }
    if (!sameDirectoryIdentity(directory, this.stagedManagedIdentity, "changed staged managed directory")) {
      throw new Error("cannot preserve a changed staged managed directory with different authority");
    }
    fs.renameSync(directory, this.concurrentWritePath);
    fsyncDirectory(path.dirname(directory));
    fsyncDirectory(this.stagingRoot);
  }

  toJSON() {
    return {
      version: JOURNAL_VERSION,
      root: this.root,
      sourceName: this.sourceName,
      stagingRelative: this.stagingRelative,
      sourceIdentity: this.sourceIdentity,
      sourceSnapshot: this.sourceSnapshot.toJSON(),
      sourceSnapshotFingerprint: this.sourceSnapshotFingerprint,
      stagedManagedIdentity: this.stagedManagedIdentity,
      stagedSnapshotFingerprint: this.stagedSnapshotFingerprint,
      metadata: this.metadata.map((entry) => entry.toJSON()),
      owner: this.owner.toJSON(),
      tempRootCreated: this.tempRootCreated,
      tempRootIdentity: this.tempRootIdentity,
      phase: this.phase,
    };
  }

  write() {
    const payload = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal",
      commitGuard: () => this.#assertJournalAuthority(),
    }).write(payload);
    const stat = assertRegularFile(this.journalPath, "migration journal");
    this.journalIdentity = { dev: stat.dev, ino: stat.ino };
    this.journalHash = hashBytes(payload);
  }

  publish() {
    const payload = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    let descriptor = null;
    let primaryError = null;
    try {
      // `wx` makes the initial publication a reservation: a second migration
      // cannot replace an in-progress journal between preflight and commit.
      descriptor = fs.openSync(
        this.journalPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("migration journal was created by another migration; source was not changed", { cause: error });
      }
      throw error;
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("migration journal authority changed during publication");
      this.reservationIdentity = { dev: stat.dev, ino: stat.ino };
      fs.writeFileSync(descriptor, payload);
      fs.fsyncSync(descriptor);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        if (primaryError) {
          throw new AggregateError([primaryError, closeError], "migration journal publication and descriptor cleanup both failed", { cause: primaryError });
        }
        throw closeError;
      }
    }
    fsyncDirectory(path.dirname(this.journalPath));
    this.journalIdentity = { ...this.reservationIdentity };
    this.journalHash = hashBytes(payload);
  }

  #assertJournalAuthority() {
    if (!this.journalIdentity || !this.journalHash) {
      throw new Error("migration journal authority is unavailable");
    }
    const stat = assertRegularFile(this.journalPath, "migration journal");
    if (stat.dev !== this.journalIdentity.dev || stat.ino !== this.journalIdentity.ino
      || hashBytes(fs.readFileSync(this.journalPath)) !== this.journalHash) {
      throw new Error("migration journal changed while the migration was active");
    }
  }

  discardReservation() {
    if (!this.reservationIdentity) return;
    const removal = new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal-reservation",
      commitGuard: () => {
        const stat = assertRegularFile(this.journalPath, "migration journal reservation");
        if (stat.dev !== this.reservationIdentity.dev || stat.ino !== this.reservationIdentity.ino) {
          throw new Error("migration journal reservation changed before cleanup");
        }
      },
    }).remove();
    if (!removal.committed) throw new Error("migration journal reservation disappeared before cleanup");
    this.reservationIdentity = null;
  }

  advance(phase) {
    if (!JOURNAL_PHASES.has(phase)) throw new Error(`unsupported migration phase: ${phase}`);
    this.phase = phase;
    this.write();
  }

  remove() {
    new AtomicFile(this.journalPath, {
      phaseNamespace: "migration-journal",
      commitGuard: () => this.#assertJournalAuthority(),
    }).remove();
  }

  static read(root, identitySource) {
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
    try {
      journalBytes = fs.readFileSync(journalPath);
      raw = JSON.parse(journalBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`migration journal is invalid: ${error.message}`);
    }
    const readStat = assertRegularFile(journalPath, "migration journal");
    if (readStat.dev !== stat.dev || readStat.ino !== stat.ino) {
      throw new Error("migration journal changed while it was being read");
    }
    const keys = raw && typeof raw === "object" ? Object.keys(raw).sort() : [];
    const expectedKeys = ["metadata", "owner", "phase", "root", "sourceIdentity", "sourceName", "sourceSnapshot", "sourceSnapshotFingerprint", "stagedManagedIdentity", "stagedSnapshotFingerprint", "stagingRelative", "tempRootCreated", "tempRootIdentity", "version"];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || raw.version !== JOURNAL_VERSION || path.resolve(raw.root || "") !== path.resolve(root)
      || !Array.isArray(raw.metadata) || !raw.sourceIdentity || !raw.stagedManagedIdentity) {
      throw new Error("migration journal has an unsupported schema");
    }
    const journal = new LayoutMigrationJournal({
      root,
      sourceName: raw.sourceName,
      stagingRelative: raw.stagingRelative,
      sourceIdentity: raw.sourceIdentity,
      sourceSnapshot: SourceTreeSnapshot.fromJSON(raw.sourceSnapshot),
      sourceSnapshotFingerprint: raw.sourceSnapshotFingerprint,
      stagedManagedIdentity: raw.stagedManagedIdentity,
      stagedSnapshotFingerprint: raw.stagedSnapshotFingerprint,
      metadata: raw.metadata.map((entry) => RootMetadataFile.fromJSON(root, entry)),
      owner: MigrationProcessOwner.fromJSON(raw.owner, identitySource),
      tempRootCreated: raw.tempRootCreated,
      tempRootIdentity: raw.tempRootIdentity,
      phase: raw.phase,
    });
    journal.journalIdentity = { dev: readStat.dev, ino: readStat.ino };
    journal.journalHash = hashBytes(journalBytes);
    for (const entry of journal.metadata) {
      const expected = entry.name === ".gitignore"
        ? Buffer.from(migrateLegacyManagedGitignore(entry.original.toString("utf8")), "utf8")
        : Buffer.from(migrateLegacyManagedGitattributes(entry.original.toString("utf8")), "utf8");
      if (!expected.equals(entry.planned)) throw new Error("migration journal metadata plan is invalid");
    }
    return journal;
  }
}

// The previous Senrail migration journal has a deliberately separate reader.
// It is never converted to the Sennel format: a malformed or unsupported old
// journal is an authority boundary and must remain byte-for-byte untouched.
const OLD_JOURNAL_FILE_NAME = "senrail-upgrade-migrate.json";
const OLD_STAGING_PREFIX = "senrail-upgrade-migrate-";
const OLD_JOURNAL_PHASES = new Set([
  "staged", "legacy-backed-up", "placed-senti", "metadata-updated", "final-renamed", "cleanup-source-verified",
]);

function oldMetadataPlan(name, original) {
  const lines = original.toString("utf8").split("\n");
  const legacyRoots = [".sdd-forge", ".senti"];
  if (name === ".gitattributes") {
    const kept = lines.filter((line) => !legacyRoots.some((root) => line.trim() === `${root}/output/analysis.json merge=ours`));
    const body = kept.at(-1) === "" ? kept.slice(0, -1) : kept;
    body.push(".senrail/output/analysis.json merge=ours");
    return Buffer.from(`${body.join("\n")}\n`, "utf8");
  }
  const oldLines = new Set(legacyRoots.flatMap((root) => [
    `${root}/*`, `!${root}/config.json`, `!${root}/templates/`, `!${root}/output/`, `!${root}/presets/`,
    `${root}/output/acceptance-report-*.json`, `${root}/`,
  ]));
  const kept = lines.filter((line) => !oldLines.has(line.trim()));
  const body = kept.at(-1) === "" ? kept.slice(0, -1) : kept;
  body.push(
    ".senrail/*", "!.senrail/config.json", "!.senrail/templates/", "!.senrail/output/", "!.senrail/presets/",
    ".senrail/output/acceptance-report-*.json",
  );
  return Buffer.from(`${body.join("\n")}\n`, "utf8");
}

class LegacySenrailMigrationJournal {
  constructor({ root, raw, bytes, identity, owner, sourceSnapshot, metadata }) {
    this.root = path.resolve(root);
    this.raw = raw;
    this.bytes = bytes;
    this.identity = identity;
    this.owner = owner;
    this.sourceSnapshot = sourceSnapshot;
    this.metadata = metadata;
    Object.freeze(this);
  }

  get sourcePath() { return path.join(this.root, this.raw.sourceName); }
  get stagingRoot() { return path.join(this.root, this.raw.stagingRelative); }
  get stagedPath() { return path.join(this.stagingRoot, ".senti"); }
  get backupPath() { return path.join(this.stagingRoot, "legacy-source-backup"); }
  get canonicalPath() { return path.join(this.root, ".senrail"); }
  get journalPath() { return path.join(this.root, ".tmp", OLD_JOURNAL_FILE_NAME); }

  static read(root, identitySource) {
    const journalPath = path.join(root, ".tmp", OLD_JOURNAL_FILE_NAME);
    const stat = lstatOrNull(journalPath);
    if (!stat) return null;
    assertRegularFile(journalPath, "old migration journal");
    const bytes = fs.readFileSync(journalPath);
    let raw;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch (error) {
      throw new Error(`old migration journal is invalid: ${error.message}`);
    }
    const readStat = assertRegularFile(journalPath, "old migration journal");
    if (readStat.dev !== stat.dev || readStat.ino !== stat.ino) throw new Error("old migration journal changed while it was being read");
    const expectedKeys = ["metadata", "owner", "phase", "root", "sourceIdentity", "sourceName", "sourceSnapshot", "sourceSnapshotFingerprint", "stagedSentiIdentity", "stagedSnapshotFingerprint", "stagingRelative", "tempRootCreated", "tempRootIdentity", "version"];
    if (JSON.stringify(Object.keys(raw || {}).sort()) !== JSON.stringify(expectedKeys)
      || raw.version !== 6 || path.resolve(raw.root || "") !== path.resolve(root)
      || ![".sdd-forge", ".senti"].includes(raw.sourceName) || !OLD_JOURNAL_PHASES.has(raw.phase)
      || !new RegExp(`^\\.tmp/${OLD_STAGING_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(raw.stagingRelative)
      || !Array.isArray(raw.metadata)) throw new Error("old migration journal has an unsupported schema");
    const sourceSnapshot = SourceTreeSnapshot.fromJSON(raw.sourceSnapshot);
    if (JSON.stringify(sourceSnapshot.rootIdentity) !== JSON.stringify(raw.sourceIdentity)
      || sourceSnapshot.fingerprint !== raw.sourceSnapshotFingerprint) throw new Error("old migration journal source snapshot authority is invalid");
    const metadata = raw.metadata.map((entry) => RootMetadataFile.fromJSON(root, entry));
    if (JSON.stringify(metadata.map((entry) => entry.name).sort()) !== JSON.stringify([".gitattributes", ".gitignore"])) {
      throw new Error("old migration journal metadata authority is invalid");
    }
    for (const entry of metadata) {
      if (!oldMetadataPlan(entry.name, entry.original).equals(entry.planned)) {
        throw new Error("old migration journal metadata plan is invalid");
      }
    }
    const stagedIdentity = raw.stagedSentiIdentity;
    if (!stagedIdentity || !Number.isSafeInteger(stagedIdentity.dev) || !Number.isSafeInteger(stagedIdentity.ino)) {
      throw new Error("old migration journal staged identity is invalid");
    }
    return new LegacySenrailMigrationJournal({
      root, raw, bytes, identity: { dev: readStat.dev, ino: readStat.ino },
      owner: MigrationProcessOwner.fromJSON(raw.owner, identitySource), sourceSnapshot, metadata,
    });
  }

  assertJournalAuthority() {
    const stat = assertRegularFile(this.journalPath, "old migration journal");
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || !fs.readFileSync(this.journalPath).equals(this.bytes)) {
      throw new Error("old migration journal changed during recovery");
    }
  }

  removeJournal() {
    new AtomicFile(this.journalPath, { phaseNamespace: "old-migration-journal", commitGuard: () => this.assertJournalAuthority() }).remove();
  }
}

function copyTree(sourceRoot, destinationRoot, relative = "") {
  for (const name of fs.readdirSync(sourceRoot).sort((left, right) => left.localeCompare(right))) {
    const source = path.join(sourceRoot, name);
    const sourceRelative = relative === "" ? name : `${relative}/${name}`;
    const targetRelative = transformedRelativePath(sourceRelative);
    const destination = path.join(destinationRoot, targetRelative);
    if (lstatOrNull(destination)) throw new Error(`migration path collision: ${sourceRelative} maps to ${targetRelative}`);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      if (stat.isSymbolicLink()) throw new Error(`managed directory contains a symbolic-link directory: ${sourceRelative}`);
      fs.mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 });
      fs.chmodSync(destination, stat.mode & 0o777);
      copyTree(source, destinationRoot, sourceRelative);
    } else if (stat.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(transformedLinkTarget(fs.readlinkSync(source)), destination);
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const bytes = fs.readFileSync(source);
      const transformed = transformedFileBytes(sourceRelative, bytes);
      if (transformed === bytes) fs.copyFileSync(source, destination);
      else fs.writeFileSync(destination, transformed);
      fs.chmodSync(destination, stat.mode & 0o777);
    } else {
      throw new Error(`managed directory contains an unsupported entry: ${sourceRelative}`);
    }
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
    const value = JSON.parse(fs.readFileSync(activePath, "utf8"));
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
  if (!stat) fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const verified = assertRealDirectory(temp, "migration temporary directory");
  return { temp, created, identity: created ? { dev: verified.dev, ino: verified.ino } : null };
}

function removeCreatedTempRoot(root, created, identity) {
  const temp = path.join(root, ".tmp");
  if (!created || !lstatOrNull(temp)
    || !sameDirectoryIdentity(temp, identity, "migration temporary directory")) return;
  const temporaryPaths = new TemporaryPaths(root);
  const purpose = temporaryPaths.runtime("migrate-layout");
  for (const directory of [purpose, path.dirname(purpose), temp]) {
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

/**
 * Owns the migration preflight, staged tree construction, commit, rollback,
 * and journal-driven recovery boundaries.
 */
export class LayoutMigrationRevisionOne {
  constructor(root, {
    dryRun = false,
    logger = console,
    processIdentitySource = new ProcessIdentitySource(),
    openHandleInspector = new ManagedOpenHandleInspector(),
  } = {}) {
    this.root = path.resolve(root);
    this.dryRun = dryRun;
    this.logger = logger;
    this.processIdentitySource = new MigrationProcessIdentitySource(processIdentitySource);
    if (!(openHandleInspector instanceof ManagedOpenHandleInspector)) {
      throw new Error("migration managed open-handle inspector is invalid");
    }
    this.openHandleInspector = openHandleInspector;
  }

  run() {
    const oldRecovery = LegacySenrailMigrationJournal.read(this.root, this.processIdentitySource);
    if (oldRecovery) {
      oldRecovery.owner.assertInactive();
      if (this.dryRun) {
        this.logger.log("[migrate] DRY-RUN: a valid old Senrail migration journal would be recovered; no files were changed.");
        // A dry-run never mutates the journal, so it cannot prove the
        // post-recovery preflight (a rollback could expose another legacy
        // directory or a collision).  Surface recovery as an explicit
        // incomplete plan rather than claiming the target was reached.
        return { migrated: false, recovered: true, noop: false, complete: false, requiresRecovery: true };
      }
      this.#recoverOldSenrailJournal(oldRecovery);
      this.logger.log("[migrate] recovered an old Senrail migration journal without converting it.");
      // Recovery can leave a completed old `.senrail` migration.  Re-enter
      // through the normal preflight so it receives the same collision and
      // writer checks as every other legacy source.
      return { ...this.run(), recovered: true };
    }
    const recovery = LayoutMigrationJournal.read(this.root, this.processIdentitySource);
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
      return { ...this.run(), recovered: true };
    }

    const state = migrationState(this.root);
    const canonical = state.get(PRODUCT.managedDirName);
    if (canonical) {
      // The reached target is still a successful command result, but an
      // existing canonical root is an explicit operator warning: no legacy
      // source is inspected or merged while this authority exists.
      this.logger.error(`[migrate] ${PRODUCT.managedDirName} already exists; layout revision 1 is already applied.`);
      return { migrated: false, recovered: false, noop: true, complete: true };
    }
    const sources = LEGACY_DIRECTORY_NAMES.filter((name) => state.has(name));
    if (sources.length === 0) {
      this.logger.log("[migrate] no managed directory requires layout revision 1.");
      return { migrated: false, recovered: false, noop: true, complete: true };
    }
    if (sources.length !== 1) {
      throw new Error(`migration refuses to merge legacy managed directories automatically: ${sources.join(", ")}`);
    }

    const sourceName = sources[0];
    const sourceRoot = path.join(this.root, sourceName);
    assertRealDirectory(sourceRoot, "legacy managed directory");
    this.openHandleInspector.assertEmpty(sourceRoot, "the legacy managed directory");
    if (activeFlowPresent(sourceRoot)) throw new Error("migration refuses while a legacy Flow is active or preparing");
    const busy = findBusyMarkers(sourceRoot);
    if (busy.length > 0) throw new Error(`migration refuses while another process may be writing managed files: ${busy.join(", ")}`);

    const snapshot = SourceTreeSnapshot.capture(sourceRoot);
    assertTemplateReferencesRemainResolvable(this.root, sourceRoot, snapshot);
    const treePlan = snapshot.treePlan;
    const metadata = [
      RootMetadataFile.plan(this.root, ".gitignore", migrateLegacyManagedGitignore),
      RootMetadataFile.plan(this.root, ".gitattributes", migrateLegacyManagedGitattributes),
    ];
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
    let journal = null;
    let stagingCreated = false;
    let retainStagingForRecovery = false;
    try {
      stagingRoot = temporaryPaths.create(temporaryPaths.runtime("migrate-layout"), STAGING_PREFIX);
      stagingCreated = true;
      const stagedManaged = path.join(stagingRoot, "managed-directory");
      fs.mkdirSync(stagedManaged, { mode: 0o700 });
      fs.chmodSync(stagedManaged, snapshot.rootMode);
      copyTree(sourceRoot, stagedManaged);
      snapshot.assertStaged(stagedManaged);
      const stagedSnapshot = SourceTreeSnapshot.capture(stagedManaged);
      snapshot.assertUnchanged(sourceRoot);
      for (const entry of metadata) {
        entry.stage(stagingRoot);
        entry.stagedContent(stagingRoot);
      }
      const pendingJournal = new LayoutMigrationJournal({
        root: this.root,
        sourceName,
        stagingRelative: relativePath(this.root, stagingRoot),
        sourceIdentity: directoryIdentity(sourceRoot, "legacy managed directory"),
        sourceSnapshot: snapshot,
        sourceSnapshotFingerprint: snapshot.fingerprint,
        stagedManagedIdentity: directoryIdentity(stagedManaged, "migration staged directory"),
        stagedSnapshotFingerprint: stagedSnapshot.fingerprint,
        metadata,
        owner: MigrationProcessOwner.current(this.processIdentitySource),
        tempRootCreated: tempState.created,
        tempRootIdentity: tempState.identity,
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
      return { migrated: true, recovered: false, noop: false, complete: true };
    } catch (error) {
      if (journal) {
        const canonicalVisible = lstatOrNull(path.join(this.root, PRODUCT.managedDirName));
        if (this.#finalRenameVisible(journal)
          || (journal.phase === "final-renamed" && canonicalVisible?.isDirectory() && !canonicalVisible.isSymbolicLink())) {
          // The final state is authoritative. Leave its journal for the next
          // next layout-migration invocation to complete cleanup safely.
          throw error;
        }
        try {
          this.#rollback(journal);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "migration and rollback both failed", { cause: error });
        }
      } else if (!retainStagingForRecovery) {
        if (stagingCreated) removeTree(stagingRoot, "migration staging directory");
        removeCreatedTempRoot(this.root, tempState.created, tempState.identity);
      }
      throw error;
    } finally {
      journal?.owner.release();
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
    fs.renameSync(sourceRoot, journal.backupPath);
    journal.advance("legacy-backed-up");
    for (const entry of journal.metadata) entry.apply(journal.stagingRoot);
    journal.advance("metadata-updated");
    fs.renameSync(journal.stagedManagedPath, canonical);
    journal.advance("final-renamed");
    this.#completeCleanup(journal);
  }

  #finalRenameVisible(journal) {
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    const stat = lstatOrNull(canonical);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || lstatOrNull(path.join(this.root, journal.sourceName))) return false;
    try {
      journal.assertStagedSnapshot(canonical);
      for (const entry of journal.metadata) entry.assertPlanned();
      return true;
    } catch (_) {
      return false;
    }
  }

  #completeCleanup(journal) {
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    try {
      journal.assertStagedSnapshot(canonical);
    } catch (error) {
      // A writer that races with the final canonical tree is data we must not
      // discard. Preserve it under the journal authority, then let rollback
      // restore the legacy source on the next recovery attempt.
      journal.preserveConcurrentStagedTree(canonical);
      throw error;
    }
    this.openHandleInspector.assertEmpty(canonical, "the migrated managed directory");
    const source = path.join(this.root, journal.sourceName);
    const sourceExists = Boolean(lstatOrNull(source));
    const backupExists = Boolean(lstatOrNull(journal.backupPath));
    if (sourceExists && backupExists) {
      throw new Error("legacy managed directory and its cleanup backup both exist");
    }
    if (lstatOrNull(source)) {
      throw new Error(`legacy managed directory path reappeared during cleanup: ${journal.sourceName}`);
    }
    if (lstatOrNull(journal.backupPath)) {
      this.openHandleInspector.assertEmpty(journal.backupPath, "the legacy managed directory backup");
      if (journal.phase !== "cleanup-source-verified") {
        journal.assertSourceSnapshot(journal.backupPath);
        journal.advance("cleanup-source-verified");
      } else {
        journal.assertSourceSnapshotSubset(journal.backupPath);
      }
      removeTree(journal.backupPath, `legacy ${journal.sourceName} backup`);
    }
    if (lstatOrNull(source)) {
      throw new Error(`legacy managed directory path reappeared during cleanup: ${journal.sourceName}`);
    }
    removeTree(journal.stagingRoot, "migration staging directory");
    journal.remove();
    this.#removeCreatedTempRoot(journal);
  }

  #rollback(journal) {
    if (this.#finalRenameVisible(journal)) {
      throw new Error("cannot roll back after the final rename; cleanup recovery is required");
    }
    const canonical = path.join(this.root, PRODUCT.managedDirName);
    const backupExists = Boolean(lstatOrNull(journal.backupPath));
    if (lstatOrNull(canonical)) {
      if (!sameDirectoryIdentity(canonical, journal.stagedManagedIdentity, "staged canonical directory")) {
        throw new Error("cannot remove canonical directory changed by another process");
      }
      const openHandles = this.openHandleInspector.inspect(canonical);
      try {
        openHandles.assertEmpty("the staged canonical managed directory");
        journal.assertStagedSnapshot(canonical);
      } catch (_) {
        journal.preserveConcurrentStagedTree(canonical);
      }
      if (lstatOrNull(canonical)) removeTree(canonical, "staged canonical directory");
    }
    for (const entry of journal.metadata) entry.restore();
    const source = path.join(this.root, journal.sourceName);
    if (backupExists) {
      if (lstatOrNull(source)) throw new Error(`cannot restore legacy directory because its original path is occupied: ${journal.sourceName}`);
      if (!sameDirectoryIdentity(journal.backupPath, journal.sourceIdentity, "legacy managed directory backup")) {
        throw new Error("cannot restore legacy managed directory backup changed by another process");
      }
      fs.renameSync(journal.backupPath, source);
    } else if (!lstatOrNull(source)) {
      throw new Error("legacy managed directory disappeared before rollback");
    }
    if (lstatOrNull(journal.concurrentWritePath)) {
      throw new Error(`concurrent managed write was preserved at ${relativePath(this.root, journal.concurrentWritePath)}`);
    }
    removeTree(journal.stagingRoot, "migration staging directory");
    journal.remove();
    this.#removeCreatedTempRoot(journal);
  }

  #removeCreatedTempRoot(journal) {
    removeCreatedTempRoot(this.root, journal.tempRootCreated, journal.tempRootIdentity);
  }

  #recover(journal) {
    if (this.#finalRenameVisible(journal)) {
      this.#completeCleanup(journal);
      return "cleanup";
    }
    this.#rollback(journal);
    return "rollback";
  }

  #recoverOldSenrailJournal(journal) {
    const canonical = journal.canonicalPath;
    // v6 staged the converted directory under stagingRoot until it placed it
    // at the root as `.senti`.  The latter location is authoritative for the
    // placed-senti and metadata-updated phases; treating it as stagingRoot
    // would leave it in place and make the backup restore collide.
    const temporary = ["placed-senti", "metadata-updated"].includes(journal.raw.phase)
      ? path.join(this.root, ".senti")
      : journal.stagedPath;
    const backup = journal.backupPath;
    const source = journal.sourcePath;
    const stagedIdentity = journal.raw.stagedSentiIdentity;
    const assertOldStaged = (directory) => {
      if (!sameDirectoryIdentity(directory, stagedIdentity, "old staged managed directory")) {
        throw new Error("old migration staged directory identity changed");
      }
      if (SourceTreeSnapshot.capture(directory).fingerprint !== journal.raw.stagedSnapshotFingerprint) {
        throw new Error("old migration staged directory changed");
      }
    };
    const assertOldSource = (directory) => {
      if (!sameDirectoryIdentity(directory, journal.raw.sourceIdentity, "old legacy managed directory")) {
        throw new Error("old migration legacy directory identity changed");
      }
      if (SourceTreeSnapshot.capture(directory).fingerprint !== journal.raw.sourceSnapshotFingerprint) {
        throw new Error("old migration legacy directory changed");
      }
    };
    if (lstatOrNull(canonical)) {
      assertRealDirectory(canonical, "old migration canonical directory");
      assertOldStaged(canonical);
      if (lstatOrNull(source) && lstatOrNull(backup)) throw new Error("old migration has both source and backup during cleanup");
      if (lstatOrNull(source)) {
        this.openHandleInspector.assertEmpty(source, "the old legacy managed directory");
        assertOldSource(source);
        fs.renameSync(source, backup);
      }
      if (lstatOrNull(backup)) {
        this.openHandleInspector.assertEmpty(backup, "the old legacy managed directory backup");
        if (journal.raw.phase === "cleanup-source-verified") {
          journal.sourceSnapshot.assertRemainingSubset(backup);
        } else {
          assertOldSource(backup);
        }
        removeTree(backup, "old migration legacy backup");
      }
      if (lstatOrNull(source)) throw new Error("old migration source reappeared during cleanup");
      removeTree(journal.stagingRoot, "old migration staging directory");
      journal.removeJournal();
      return;
    }
    if (journal.raw.phase === "final-renamed") {
      throw new Error("old migration journal says final rename completed, but .senrail is not safely present");
    }
    if (lstatOrNull(temporary)) {
      // For a `.senti` source in the earliest phase this is the original
      // source, not a staged tree, and therefore must not be removed.
      const originalStillInPlace = journal.raw.phase === "staged" && journal.raw.sourceName === ".senti"
        && sameDirectoryIdentity(temporary, journal.raw.sourceIdentity, "old legacy .senti directory");
      if (!originalStillInPlace) {
        assertOldStaged(temporary);
        this.openHandleInspector.assertEmpty(temporary, "the old staged managed directory");
        removeTree(temporary, "old staged managed directory");
      }
    }
    for (const entry of journal.metadata) entry.restore();
    if (lstatOrNull(backup)) {
      if (lstatOrNull(source)) throw new Error("cannot restore old legacy directory because its path is occupied");
      assertOldSource(backup);
      fs.renameSync(backup, source);
    } else if (!lstatOrNull(source)) {
      throw new Error("old migration legacy source disappeared before rollback");
    }
    removeTree(journal.stagingRoot, "old migration staging directory");
    journal.removeJournal();
  }
}
