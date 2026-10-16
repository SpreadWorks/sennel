import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { MigrationBlocker } from "./migration.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { LEGACY_MANAGED_DIRECTORY_NAMES } from "./legacy-managed-directory-migration.js";
import { PRODUCT } from "./product.js";

function compareEntryNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function readObject(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain an object`);
  }
  return value;
}

function configuredSpecDir(config, label) {
  const value = config.flow?.specDir;
  if (value == null) return "specs";
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label}.flow.specDir must be a non-empty relative path`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label}.flow.specDir must be a normalized relative path`);
  }
  return normalized;
}

function configAt(directory) {
  const configPath = path.join(directory, "config.json");
  if (!fs.existsSync(configPath)) return null;
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${configPath} must be a regular file`);
  return { path: configPath, config: readObject(configPath, configPath) };
}

/** Resolves the sole project spec root used by revisioned specs migrations. */
export class MigrationSpecRoot {
  constructor({ root, relativePath, authority } = {}) {
    this.root = path.resolve(root);
    if (typeof relativePath !== "string" || relativePath === "") throw new Error("migration spec root path is required");
    if (path.posix.isAbsolute(relativePath) || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("migration spec root path is invalid");
    }
    if (!new Set(["canonical", "legacy", "default"]).has(authority)) throw new Error("migration spec root authority is invalid");
    this.relativePath = relativePath;
    this.authority = authority;
    this.path = path.join(this.root, ...relativePath.split("/"));
    Object.freeze(this);
  }
}

/**
 * Returns either a resolved root or a typed project blocker.  This is kept at
 * the system boundary so individual spec adapters never choose a different
 * root from each other.
 */
export function resolveMigrationSpecRoot(root) {
  const projectRoot = path.resolve(root);
  const canonicalDirectory = path.join(projectRoot, PRODUCT.managedDirName);
  try {
    // A managed directory is not an authority by itself.  Layout migration
    // can leave retired directories beside the canonical one, and a clean
    // checkout may deliberately contain more than one such directory while
    // only the canonical config owns the Flow root.  Read configuration
    // records first, then resolve their explicit authority order.
    const canonical = fs.existsSync(canonicalDirectory) ? configAt(canonicalDirectory) : null;
    const legacy = LEGACY_MANAGED_DIRECTORY_NAMES
      .map((name) => ({ name, directory: path.join(projectRoot, name) }))
      .filter(({ directory }) => fs.existsSync(directory))
      .flatMap(({ name, directory }) => {
        const configuration = configAt(directory);
        return configuration === null ? [] : [{ name, ...configuration }];
      });
    const canonicalSpecDir = canonical === null ? null : configuredSpecDir(canonical.config, canonical.path);
    const legacySpecDirs = legacy.map((entry) => ({
      name: entry.name,
      path: entry.path,
      relativePath: configuredSpecDir(entry.config, entry.path),
    }));

    // Canonical configuration wins, but every actual legacy configuration
    // must agree with it.  A directory without config has no competing
    // authority and therefore cannot make this decision ambiguous.
    const conflictingLegacy = canonicalSpecDir === null
      ? null
      : legacySpecDirs.find((entry) => entry.relativePath !== canonicalSpecDir);
    if (conflictingLegacy !== null && conflictingLegacy !== undefined) {
      return { blocker: new MigrationBlocker({
        code: "SPEC_ROOT_CONFLICT",
        message: `canonical and legacy configuration disagree on flow.specDir (${canonicalSpecDir} / ${conflictingLegacy.relativePath})`,
      }) };
    }
    if (canonicalSpecDir !== null) return { root: new MigrationSpecRoot({ root: projectRoot, relativePath: canonicalSpecDir, authority: "canonical" }) };
    // Without canonical configuration there may be at most one legacy
    // configuration authority.  Equal values do not turn two independent
    // legacy authority records into one authoritative source: either could
    // change independently before the next migration invocation.
    if (legacySpecDirs.length > 1) {
      return { blocker: new MigrationBlocker({
        code: "MULTIPLE_LEGACY_SPEC_ROOT_AUTHORITIES",
        message: `multiple legacy configurations define flow.specDir (${legacySpecDirs.map((entry) => `${entry.name}:${entry.relativePath}`).join(", ")})`,
      }) };
    }
    if (legacySpecDirs.length === 1) {
      return { root: new MigrationSpecRoot({ root: projectRoot, relativePath: legacySpecDirs[0].relativePath, authority: "legacy" }) };
    }
    return { root: new MigrationSpecRoot({ root: projectRoot, relativePath: "specs", authority: "default" }) };
  } catch (error) {
    return { blocker: new MigrationBlocker({ code: "SPEC_ROOT_CONFIG_INVALID", message: error.message }) };
  }
}

export { LEGACY_MANAGED_DIRECTORY_NAMES };

/** One literal spec, or the existing project-wide migration selection. */
export class MigrationSpecSelection {
  constructor(specId = null) {
    this.specId = specId === null ? null : FlowSpecId.from(specId).toString();
    Object.freeze(this);
  }

  static from(specId) {
    return specId instanceof MigrationSpecSelection ? specId : new MigrationSpecSelection(specId);
  }

  entries(specRoot) {
    let stat;
    try { stat = fs.lstatSync(specRoot.path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (this.specId === null) return [];
      throw this.#failure("SPEC_NOT_FOUND", `selected spec does not exist: ${this.specId}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(specRoot.path) !== path.resolve(specRoot.path)) {
      throw this.#failure("SPEC_ROOT_INVALID", "resolved spec root must be a real directory");
    }
    const entries = fs.readdirSync(specRoot.path, { withFileTypes: true });
    if (this.specId === null) return entries.sort(compareEntryNames);
    const selected = entries.find((entry) => entry.name === this.specId);
    if (!selected) throw this.#failure("SPEC_NOT_FOUND", `selected spec does not exist: ${this.specId}`);
    if (!selected.isDirectory() || selected.isSymbolicLink()) {
      throw this.#failure("UNSAFE_SPEC_ROOT_ENTRY", `selected spec must be a real directory: ${this.specId}`);
    }
    return [selected];
  }

  journalFileName(specRoot, revision = 1) {
    if (this.specId === null) throw new Error("migration journal identity requires one spec");
    if (![1, 2, 3, 4].includes(revision)) throw new Error("migration journal revision is invalid");
    const suffix = revision === 1 ? "" : `\0${revision === 2 ? "revision-root" : `revision-root-${revision}`}`;
    return `${createHash("sha256").update(`${specRoot.relativePath}\0${this.specId}${suffix}`).digest("hex")}.json`;
  }

  recoveryEntries(specRoot, journalDirectory) {
    const entries = fs.readdirSync(journalDirectory, { withFileTypes: true });
    const names = this.specId === null ? null : new Set([1, 2, 3, 4].map((revision) => this.journalFileName(specRoot, revision)));
    return entries.filter((entry) => names === null || names.has(entry.name))
      .sort(compareEntryNames);
  }

  #failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}
