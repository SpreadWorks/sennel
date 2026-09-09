import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AtomicJsonFile } from "./atomic-json-file.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { PRODUCT } from "./product.js";

const VERSION = 7;
const PHASES = new Set(["staged", "applying", "rolling-back", "rolled-back", "applied"]);

export class OfflineMigrationJournalRemovalError extends Error {
  constructor(message, { cause, phase, journalPath, journal, durabilityUnknown, residue }) {
    super(message, { cause });
    this.name = "OfflineMigrationJournalRemovalError";
    this.code = durabilityUnknown
      ? "OFFLINE_MIGRATION_JOURNAL_DURABILITY_UNCERTAIN"
      : "OFFLINE_MIGRATION_JOURNAL_REMOVE_FAILED";
    this.phase = phase;
    this.journalPath = journalPath;
    this.journal = journal;
    this.durabilityUnknown = durabilityUnknown;
    this.residue = residue;
  }
}

function exactKeys(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an invalid schema`);
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function withinRoot(root, filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`migration authority is outside the repository: ${filePath}`);
  }
  return { resolved, relative: relative.split(path.sep).join("/") };
}

function statRealFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || fs.realpathSync(filePath) !== path.resolve(filePath)
  ) {
    throw new Error(`${label} must be one real non-hardlinked file: ${filePath}`);
  }
  return stat;
}

function statRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  return stat;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  let primary = null;
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    primary = error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (cleanupError) {
      if (primary) {
        throw new AggregateError([primary, cleanupError], `directory fsync cleanup failed: ${directory}`, { cause: primary });
      }
      throw cleanupError;
    }
  }
  if (primary) throw primary;
}

class OfflineMigrationWorkspaceAuthority {
  constructor({ root, relativePath, token, dev = null, ino = null }) {
    this.root = path.resolve(root);
    const located = withinRoot(this.root, path.join(this.root, relativePath));
    if (
      !located.relative.startsWith(`${PRODUCT.managedPath("recovery", "offline-migration-workspaces")}/`)
      || typeof token !== "string"
      || !/^[0-9a-f-]{36}$/.test(token)
      || (dev === null) !== (ino === null)
      || (dev !== null && ![dev, ino].every(Number.isSafeInteger))
    ) {
      throw new Error("migration workspace authority is invalid");
    }
    this.relativePath = located.relative;
    this.token = token;
    this.dev = dev;
    this.ino = ino;
    Object.freeze(this);
  }

  static plan(root) {
    const token = crypto.randomUUID();
    return new OfflineMigrationWorkspaceAuthority({
      root,
      relativePath: `${PRODUCT.managedPath("recovery", "offline-migration-workspaces")}/${token}`,
      token,
    });
  }

  static fromStored(root, value) {
    exactKeys(value, ["relativePath", "token", "dev", "ino"], "migration workspace authority");
    return new OfflineMigrationWorkspaceAuthority({ root, ...value });
  }

  withIdentity(stat) {
    return new OfflineMigrationWorkspaceAuthority({
      root: this.root,
      relativePath: this.relativePath,
      token: this.token,
      dev: stat.dev,
      ino: stat.ino,
    });
  }

  matches(stat) {
    return this.dev !== null && stat.dev === this.dev && stat.ino === this.ino;
  }

  toJSON() {
    return { relativePath: this.relativePath, token: this.token, dev: this.dev, ino: this.ino };
  }
}

class OfflineMigrationWorkspace {
  constructor(authority) {
    this.authority = authority;
    this.root = authority.root;
    this.directory = path.join(this.root, authority.relativePath);
  }

  static acquire(authority, { allowMissing = false } = {}) {
    const directory = path.join(authority.root, authority.relativePath);
    const parent = path.dirname(directory);
    if (allowMissing && authority.dev !== null && !fs.existsSync(directory)) return null;
    const managedDirectory = new RealDirectoryAuthority(path.join(authority.root, PRODUCT.managedDirName));
    managedDirectory.ensure();
    const recovery = new RealDirectoryAuthority(path.join(authority.root, PRODUCT.managedDirName, "recovery"), {
      create: true,
      parentAuthority: managedDirectory,
    });
    recovery.ensure();
    new RealDirectoryAuthority(parent, { create: true, parentAuthority: recovery }).ensure();
    let created = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing && authority.dev !== null) return null;
      if (error.code !== "EEXIST") throw error;
    }
    let stat;
    try {
      stat = statRealDirectory(directory, "migration private workspace");
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing && authority.dev !== null) return null;
      throw error;
    }
    if (
      (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (authority.dev !== null && !authority.matches(stat))
    ) {
      throw new Error("migration private workspace authority changed");
    }
    const markerPath = path.join(directory, ".owner");
    const marker = `${authority.token}\n`;
    if (fs.existsSync(markerPath)) {
      statRealFile(markerPath, "migration workspace owner marker");
      if (fs.readFileSync(markerPath, "utf8") !== marker) {
        throw new Error("migration private workspace owner marker changed");
      }
    } else {
      if (!created) {
        throw new Error("migration private workspace is not owned");
      }
      const descriptor = fs.openSync(markerPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, marker);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fsyncDirectory(directory);
    }
    return new OfflineMigrationWorkspace(authority.withIdentity(stat));
  }

  assertAuthority() {
    const stat = statRealDirectory(this.directory, "migration private workspace");
    if (!this.authority.matches(stat)) throw new Error("migration private workspace identity changed");
  }

  planGenerationPath(targetPath) {
    this.assertAuthority();
    const targetDirectory = statRealDirectory(path.dirname(targetPath), "migration target directory");
    const workspaceDirectory = statRealDirectory(this.directory, "migration private workspace");
    if (targetDirectory.dev !== workspaceDirectory.dev) {
      throw new Error("migration target and private workspace are on different filesystems");
    }
    const fileName = `.${path.basename(targetPath)}.${crypto.randomUUID()}.migration.tmp`;
    return path.join(this.directory, fileName);
  }

  assertContains(filePath) {
    this.assertAuthority();
    if (path.dirname(path.resolve(filePath)) !== this.directory) {
      throw new Error("migration generation is outside its private workspace");
    }
  }

  cleanup() {
    this.assertAuthority();
    const entries = fs.readdirSync(this.directory);
    if (entries.some((entry) => entry !== ".owner")) {
      throw new Error("migration private workspace contains generation residue");
    }
    const markerPath = path.join(this.directory, ".owner");
    statRealFile(markerPath, "migration workspace owner marker");
    if (fs.readFileSync(markerPath, "utf8") !== `${this.authority.token}\n`) {
      throw new Error("migration private workspace owner marker changed");
    }
    fs.unlinkSync(markerPath);
    fs.rmdirSync(this.directory);
    fsyncDirectory(path.dirname(this.directory));
  }
}

class OfflineMigrationDirectoryEntry {
  constructor({ name, kind, dev, ino, mode, revision }) {
    if (typeof name !== "string" || name === "" || name.includes("/")) {
      throw new Error("migration directory entry name is invalid");
    }
    if (!["file", "directory", "symlink", "other"].includes(kind)) {
      throw new Error("migration directory entry kind is invalid");
    }
    if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
      throw new Error("migration directory entry identity is invalid");
    }
    if (kind === "file") {
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
        throw new Error("migration directory entry mode is invalid");
      }
      if (!/^[a-f0-9]{64}$/.test(String(revision))) {
        throw new Error("migration directory entry revision is invalid");
      }
    } else if (mode !== null || revision !== null) {
      throw new Error("non-file migration directory entry cannot have file authority");
    }
    this.name = name;
    this.kind = kind;
    this.dev = dev;
    this.ino = ino;
    this.mode = mode;
    this.revision = revision;
    Object.freeze(this);
  }

  static fromStored(value) {
    exactKeys(value, ["name", "kind", "dev", "ino", "mode", "revision"], "migration directory entry");
    return new OfflineMigrationDirectoryEntry(value);
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      dev: this.dev,
      ino: this.ino,
      mode: this.mode,
      revision: this.revision,
    };
  }
}

function directoryEntryKind(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

export class OfflineMigrationDirectorySnapshot {
  constructor({ root, relativePath, includedNames, entries, digest }) {
    this.root = path.resolve(root);
    this.relativePath = relativePath;
    this.includedNames = includedNames == null ? null : Object.freeze([...includedNames].sort());
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof OfflineMigrationDirectoryEntry ? entry : OfflineMigrationDirectoryEntry.fromStored(entry)
    )));
    this.digest = digest;
    if (!/^[a-f0-9]{64}$/.test(String(digest))) throw new Error("migration directory snapshot digest is invalid");
  }

  static capture(root, directory, { includedNames = null } = {}) {
    const authorityRoot = path.resolve(root);
    const located = withinRoot(authorityRoot, directory);
    statRealDirectory(located.resolved, "migration closed-world directory");
    const filter = includedNames == null ? null : new Set(includedNames);
    const entries = fs.readdirSync(located.resolved)
      .filter((name) => filter == null || filter.has(name))
      .sort()
      .map((name) => {
        const filePath = path.join(located.resolved, name);
        const stat = fs.lstatSync(filePath);
        const kind = directoryEntryKind(stat);
        return new OfflineMigrationDirectoryEntry({
          name,
          kind,
          dev: stat.dev,
          ino: stat.ino,
          mode: kind === "file" ? stat.mode & 0o777 : null,
          revision: kind === "file" ? hash(fs.readFileSync(filePath)) : null,
        });
      });
    return new OfflineMigrationDirectorySnapshot({
      root: authorityRoot,
      relativePath: located.relative,
      includedNames: includedNames == null ? null : [...filter].sort(),
      entries,
      digest: hash(Buffer.from(JSON.stringify(entries.map((entry) => entry.toJSON())))),
    });
  }

  static fromStored(root, value) {
    exactKeys(value, ["relativePath", "includedNames", "entries", "digest"], "migration directory snapshot");
    if (value.includedNames != null && !Array.isArray(value.includedNames)) {
      throw new Error("migration directory snapshot includedNames is invalid");
    }
    if (!Array.isArray(value.entries)) throw new Error("migration directory snapshot entries are invalid");
    withinRoot(root, path.join(root, value.relativePath));
    const snapshot = new OfflineMigrationDirectorySnapshot({ root, ...value });
    const calculated = hash(Buffer.from(JSON.stringify(snapshot.entries.map((entry) => entry.toJSON()))));
    if (calculated !== snapshot.digest) throw new Error("migration directory snapshot digest does not match entries");
    return snapshot;
  }

  assertUnchanged({ identity = true, mutablePaths = [] } = {}) {
    const current = OfflineMigrationDirectorySnapshot.capture(
      this.root,
      path.join(this.root, this.relativePath),
      { includedNames: this.includedNames },
    );
    const mutable = new Set(mutablePaths);
    const project = (entry) => {
      const relativePath = path.posix.join(this.relativePath, entry.name);
      if (mutable.has(relativePath)) return { name: entry.name, kind: entry.kind };
      const authority = {
        name: entry.name,
        kind: entry.kind,
        mode: entry.mode,
        revision: entry.revision,
      };
      if (identity) {
        authority.dev = entry.dev;
        authority.ino = entry.ino;
      }
      return authority;
    };
    const expected = this.entries.map(project);
    const expectedNames = new Set(this.entries.map((entry) => entry.name));
    const actual = current.entries
      .filter((entry) => expectedNames.has(entry.name) || !mutable.has(path.posix.join(this.relativePath, entry.name)))
      .map(project);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`migration closed-world snapshot changed after planning: ${this.relativePath}`);
    }
  }

  toJSON() {
    return {
      relativePath: this.relativePath,
      includedNames: this.includedNames,
      entries: this.entries.map((entry) => entry.toJSON()),
      digest: this.digest,
    };
  }
}

class OfflineMigrationGeneration {
  constructor({ root, targetRelativePath, relativeTempPath, reservationToken, dev, ino, mode, revision, reserved, prepared }) {
    this.root = path.resolve(root);
    const target = withinRoot(this.root, path.join(this.root, targetRelativePath));
    const temporary = withinRoot(this.root, path.join(this.root, relativeTempPath));
    if (
      typeof targetRelativePath !== "string"
      || typeof relativeTempPath !== "string"
      || !relativeTempPath.endsWith(".migration.tmp")
      || !path.basename(relativeTempPath).startsWith(`.${path.basename(targetRelativePath)}.`)
      || typeof reservationToken !== "string"
      || !/^[0-9a-f-]{36}$/.test(reservationToken)
      || !Number.isSafeInteger(mode)
      || !/^[a-f0-9]{64}$/.test(String(revision))
      || typeof reserved !== "boolean"
      || typeof prepared !== "boolean"
      || (reserved && ![dev, ino].every(Number.isSafeInteger))
      || (!reserved && (dev !== null || ino !== null || prepared))
    ) {
      throw new Error("migration generation authority is invalid");
    }
    this.targetRelativePath = targetRelativePath;
    this.relativeTempPath = relativeTempPath;
    this.reservationToken = reservationToken;
    this.dev = dev;
    this.ino = ino;
    this.mode = mode;
    this.revision = revision;
    this.reserved = reserved;
    this.prepared = prepared;
    Object.freeze(this);
  }

  static fromStored(root, value) {
    exactKeys(
      value,
      ["targetRelativePath", "relativeTempPath", "reservationToken", "dev", "ino", "mode", "revision", "reserved", "prepared"],
      "migration generation",
    );
    return new OfflineMigrationGeneration({ root, ...value });
  }

  matchesIdentity(stat) {
    return this.reserved
      && stat.dev === this.dev
      && stat.ino === this.ino
      && (stat.mode & 0o777) === this.mode;
  }

  matches(stat, bytes) {
    return this.prepared && this.matchesIdentity(stat) && hash(bytes) === this.revision;
  }

  matchesReservation(stat, bytes) {
    return !this.reserved
      && stat.nlink === 1
      && (stat.mode & 0o777) === this.mode
      && bytes.equals(Buffer.from(`${PRODUCT.protocol("migration-reservation", "v1")}:${this.reservationToken}\n`));
  }

  asPrepared() {
    return new OfflineMigrationGeneration({
      root: this.root,
      targetRelativePath: this.targetRelativePath,
      relativeTempPath: this.relativeTempPath,
      reservationToken: this.reservationToken,
      dev: this.dev,
      ino: this.ino,
      mode: this.mode,
      revision: this.revision,
      reserved: true,
      prepared: true,
    });
  }

  asReserved(stat) {
    return new OfflineMigrationGeneration({
      root: this.root,
      targetRelativePath: this.targetRelativePath,
      relativeTempPath: this.relativeTempPath,
      reservationToken: this.reservationToken,
      dev: stat.dev,
      ino: stat.ino,
      mode: this.mode,
      revision: this.revision,
      reserved: true,
      prepared: false,
    });
  }

  toJSON() {
    return {
      relativeTempPath: this.relativeTempPath,
      targetRelativePath: this.targetRelativePath,
      reservationToken: this.reservationToken,
      dev: this.dev,
      ino: this.ino,
      mode: this.mode,
      revision: this.revision,
      reserved: this.reserved,
      prepared: this.prepared,
    };
  }
}

class AtomicBytesFile {
  constructor(root, filePath, workspace) {
    this.root = path.resolve(root);
    this.filePath = filePath;
    this.directory = path.dirname(filePath);
    this.authority = new RealDirectoryAuthority(this.directory);
    if (!(workspace instanceof OfflineMigrationWorkspace)) {
      throw new Error("migration private workspace is required");
    }
    this.workspace = workspace;
  }

  plan(bytes, mode) {
    this.authority.assertStable();
    const tempPath = this.workspace.planGenerationPath(this.filePath);
    return new OfflineMigrationGeneration({
      root: this.root,
      targetRelativePath: withinRoot(this.root, this.filePath).relative,
      relativeTempPath: withinRoot(this.root, tempPath).relative,
      reservationToken: crypto.randomUUID(),
      dev: null,
      ino: null,
      mode,
      revision: hash(bytes),
      reserved: false,
      prepared: false,
    });
  }

  reserve(generation) {
    if (generation.reserved) return generation;
    if (generation.targetRelativePath !== withinRoot(this.root, this.filePath).relative) {
      throw new Error("migration generation intent targets a different file");
    }
    const tempPath = path.join(this.root, generation.relativeTempPath);
    this.workspace.assertContains(tempPath);
    let descriptor = null;
    let created = false;
    try {
      descriptor = fs.openSync(tempPath, "wx", generation.mode);
      created = true;
      fs.writeFileSync(descriptor, `${PRODUCT.protocol("migration-reservation", "v1")}:${generation.reservationToken}\n`);
      fs.fchmodSync(descriptor, generation.mode);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      this.authority.assertStable();
      const stat = statRealFile(tempPath, "migration prepared generation");
      fsyncDirectory(this.directory);
      return generation.asReserved(stat);
    } catch (primary) {
      const cleanup = [];
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (error) { cleanup.push(error); }
      }
      if (created) {
        try {
          fs.unlinkSync(tempPath);
          fsyncDirectory(this.directory);
        } catch (error) {
          if (error.code !== "ENOENT") cleanup.push(error);
        }
      }
      if (cleanup.length > 0) {
        throw new AggregateError([primary, ...cleanup], `migration write and cleanup failed: ${this.filePath}`, { cause: primary });
      }
      throw primary;
    }
  }

  prepare(generation, bytes) {
    if (generation.prepared) return generation;
    if (!generation.reserved) throw new Error("migration generation intent is not reserved");
    if (generation.targetRelativePath !== withinRoot(this.root, this.filePath).relative) {
      throw new Error("migration reserved generation targets a different file");
    }
    const tempPath = path.join(this.root, generation.relativeTempPath);
    this.workspace.assertContains(tempPath);
    const descriptor = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || !generation.matchesIdentity(opened)) {
        throw new Error("migration reserved generation identity changed before preparation");
      }
      fs.ftruncateSync(descriptor, 0);
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, generation.mode);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const stat = statRealFile(tempPath, "migration prepared generation");
    if (!generation.matchesIdentity(stat) || hash(fs.readFileSync(tempPath)) !== generation.revision) {
      throw new Error("migration reserved generation did not reach its planned revision");
    }
    return generation.asPrepared();
  }

  commit(generation) {
    if (generation.targetRelativePath !== withinRoot(this.root, this.filePath).relative) {
      throw new Error("migration prepared generation targets a different file");
    }
    if (!generation.prepared) throw new Error("migration generation is not prepared for commit");
    const tempPath = path.join(this.root, generation.relativeTempPath);
    this.workspace.assertContains(tempPath);
    const stat = statRealFile(tempPath, "migration prepared generation");
    const bytes = fs.readFileSync(tempPath);
    if (!generation.matches(stat, bytes)) throw new Error("migration prepared generation changed before rename");
    this.authority.assertStable();
    fs.renameSync(tempPath, this.filePath);
    fsyncDirectory(this.directory);
  }
}

export class OfflineMigrationAuthority {
  constructor({ root, relativePath, kind, dev, ino, mode, revision }) {
    this.root = path.resolve(root);
    this.relativePath = relativePath;
    this.kind = kind;
    this.dev = dev;
    this.ino = ino;
    this.mode = mode;
    this.revision = revision;
  }

  static capture(root, filePath, kind) {
    const authorityRoot = path.resolve(root);
    const located = withinRoot(authorityRoot, filePath);
    const stat = kind === "directory"
      ? statRealDirectory(located.resolved, "migration directory authority")
      : statRealFile(located.resolved, "migration file authority");
    const revision = kind === "directory" ? null : hash(fs.readFileSync(located.resolved));
    return new OfflineMigrationAuthority({
      root: authorityRoot,
      relativePath: located.relative,
      kind,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode & 0o777,
      revision,
    });
  }

  static fromStored(root, value) {
    exactKeys(value, ["relativePath", "kind", "dev", "ino", "mode", "revision"], "migration authority");
    if (!['directory', 'file'].includes(value.kind)) throw new Error("migration authority kind is invalid");
    if (![value.dev, value.ino, value.mode].every(Number.isSafeInteger)) throw new Error("migration authority identity is invalid");
    if (value.kind === "file" && !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error("migration authority revision is invalid");
    if (value.kind === "directory" && value.revision !== null) throw new Error("directory authority revision must be null");
    withinRoot(root, path.join(root, value.relativePath));
    return new OfflineMigrationAuthority({ root, ...value });
  }

  assertUnchanged() {
    const filePath = path.join(this.root, this.relativePath);
    const stat = this.kind === "directory"
      ? statRealDirectory(filePath, "migration directory authority")
      : statRealFile(filePath, "migration file authority");
    if (stat.dev !== this.dev || stat.ino !== this.ino || (stat.mode & 0o777) !== this.mode) {
      throw new Error(`migration authority identity changed: ${this.relativePath}`);
    }
    if (this.kind === "file" && hash(fs.readFileSync(filePath)) !== this.revision) {
      throw new Error(`migration authority content changed: ${this.relativePath}`);
    }
  }

  toJSON() {
    return {
      relativePath: this.relativePath,
      kind: this.kind,
      dev: this.dev,
      ino: this.ino,
      mode: this.mode,
      revision: this.revision,
    };
  }
}

export class OfflineMigrationTarget {
  constructor({
    root,
    relativePath,
    original,
    planned,
    mode,
    dev,
    ino,
    plannedGeneration = null,
    rollbackGeneration = null,
  }) {
    this.root = path.resolve(root);
    this.relativePath = relativePath;
    this.original = Buffer.from(original);
    this.planned = Buffer.from(planned);
    this.mode = mode;
    this.dev = dev;
    this.ino = ino;
    this.originalRevision = hash(this.original);
    this.plannedRevision = hash(this.planned);
    this.plannedGeneration = plannedGeneration == null
      ? null
      : plannedGeneration instanceof OfflineMigrationGeneration
        ? plannedGeneration
        : OfflineMigrationGeneration.fromStored(this.root, plannedGeneration);
    this.rollbackGeneration = rollbackGeneration == null
      ? null
      : rollbackGeneration instanceof OfflineMigrationGeneration
        ? rollbackGeneration
        : OfflineMigrationGeneration.fromStored(this.root, rollbackGeneration);
    this.workspace = null;
  }

  static capture(root, filePath, planned) {
    const authorityRoot = path.resolve(root);
    const located = withinRoot(authorityRoot, filePath);
    const stat = statRealFile(located.resolved, "migration target");
    return new OfflineMigrationTarget({
      root: authorityRoot,
      relativePath: located.relative,
      original: fs.readFileSync(located.resolved),
      planned,
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
    });
  }

  static fromStored(root, value) {
    exactKeys(value, [
      "relativePath", "original", "planned", "mode", "dev", "ino",
      "originalRevision", "plannedRevision", "plannedGeneration", "rollbackGeneration",
    ], "migration target");
    if (![value.mode, value.dev, value.ino].every(Number.isSafeInteger)) throw new Error("migration target identity is invalid");
    withinRoot(root, path.join(root, value.relativePath));
    const target = new OfflineMigrationTarget({
      root,
      relativePath: value.relativePath,
      original: Buffer.from(value.original, "base64"),
      planned: Buffer.from(value.planned, "base64"),
      mode: value.mode,
      dev: value.dev,
      ino: value.ino,
      plannedGeneration: value.plannedGeneration,
      rollbackGeneration: value.rollbackGeneration,
    });
    if (target.originalRevision !== value.originalRevision || target.plannedRevision !== value.plannedRevision) {
      throw new Error(`migration target bytes do not match revisions: ${value.relativePath}`);
    }
    return target;
  }

  get filePath() {
    return path.join(this.root, this.relativePath);
  }

  assertInitialIdentity() {
    const stat = statRealFile(this.filePath, "migration target");
    if (stat.dev !== this.dev || stat.ino !== this.ino || (stat.mode & 0o777) !== this.mode) {
      throw new Error(`migration target identity changed before apply: ${this.relativePath}`);
    }
    if (this.classify() !== "original") throw new Error(`migration target changed before apply: ${this.relativePath}`);
  }

  classify() {
    const stat = statRealFile(this.filePath, "migration target");
    if ((stat.mode & 0o777) !== this.mode) return "foreign";
    const bytes = fs.readFileSync(this.filePath);
    if (
      bytes.equals(this.original)
      && (
        (stat.dev === this.dev && stat.ino === this.ino)
        || this.rollbackGeneration?.matches(stat, bytes)
      )
    ) return "original";
    if (bytes.equals(this.planned) && this.plannedGeneration?.matches(stat, bytes)) return "planned";
    return "foreign";
  }

  bindWorkspace(workspace) {
    if (!(workspace instanceof OfflineMigrationWorkspace)) {
      throw new Error("migration target workspace is invalid");
    }
    this.workspace = workspace;
  }

  planOriginal() {
    if (this.rollbackGeneration == null) {
      this.rollbackGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace).plan(this.original, this.mode);
    }
  }

  reserveOriginal() {
    this.rollbackGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace)
      .reserve(this.rollbackGeneration);
  }

  prepareOriginal() {
    this.rollbackGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace)
      .prepare(this.rollbackGeneration, this.original);
  }

  commitOriginal() {
    new AtomicBytesFile(this.root, this.filePath, this.workspace).commit(this.rollbackGeneration);
  }

  planPlanned() {
    if (this.plannedGeneration == null) {
      this.plannedGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace).plan(this.planned, this.mode);
    }
  }

  reservePlanned() {
    this.plannedGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace)
      .reserve(this.plannedGeneration);
  }

  preparePlanned() {
    this.plannedGeneration = new AtomicBytesFile(this.root, this.filePath, this.workspace)
      .prepare(this.plannedGeneration, this.planned);
  }

  commitPlanned() {
    new AtomicBytesFile(this.root, this.filePath, this.workspace).commit(this.plannedGeneration);
  }

  cleanupPreparedGenerations() {
    for (const generation of [this.plannedGeneration, this.rollbackGeneration]) {
      if (generation == null) continue;
      const tempPath = path.join(this.root, generation.relativeTempPath);
      this.workspace.assertContains(tempPath);
      try {
        const stat = statRealFile(tempPath, "migration cleanup generation");
        const bytes = fs.readFileSync(tempPath);
        if (
          generation.targetRelativePath !== this.relativePath
          || (generation.reserved
            ? !generation.matchesIdentity(stat)
            : !generation.matchesReservation(stat, bytes))
        ) {
          throw new Error("migration cleanup generation authority changed");
        }
        fs.unlinkSync(tempPath);
        fsyncDirectory(path.dirname(tempPath));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  toJSON() {
    return {
      relativePath: this.relativePath,
      original: this.original.toString("base64"),
      planned: this.planned.toString("base64"),
      mode: this.mode,
      dev: this.dev,
      ino: this.ino,
      originalRevision: this.originalRevision,
      plannedRevision: this.plannedRevision,
      plannedGeneration: this.plannedGeneration?.toJSON() ?? null,
      rollbackGeneration: this.rollbackGeneration?.toJSON() ?? null,
    };
  }
}

class MigrationJournal {
  constructor({ name, root, phase, applyIndex, rollbackIndex, workspace, authorities, snapshots, targets, updatedAt }) {
    if (typeof name !== "string" || name === "") throw new Error("migration journal name is invalid");
    if (!PHASES.has(phase)) throw new Error(`migration journal phase is invalid: ${phase}`);
    if (!Number.isSafeInteger(applyIndex) || !Number.isSafeInteger(rollbackIndex)) {
      throw new Error("migration journal indexes are invalid");
    }
    this.name = name;
    this.root = path.resolve(root);
    this.phase = phase;
    this.applyIndex = applyIndex;
    this.rollbackIndex = rollbackIndex;
    this.workspace = workspace instanceof OfflineMigrationWorkspaceAuthority
      ? workspace
      : OfflineMigrationWorkspaceAuthority.fromStored(this.root, workspace);
    this.authorities = authorities;
    this.snapshots = snapshots;
    this.targets = targets;
    this.updatedAt = updatedAt;
    if (typeof updatedAt !== "string" || updatedAt === "") throw new Error("migration journal updatedAt is invalid");
    if (applyIndex < 0 || applyIndex > targets.length || rollbackIndex < -1 || rollbackIndex >= targets.length) {
      throw new Error("migration journal indexes are out of range");
    }
  }

  static create(name, root, authorities, snapshots, targets) {
    return new MigrationJournal({
      name,
      root,
      phase: "staged",
      applyIndex: 0,
      rollbackIndex: targets.length - 1,
      workspace: OfflineMigrationWorkspaceAuthority.plan(root),
      authorities,
      snapshots,
      targets,
      updatedAt: new Date().toISOString(),
    });
  }

  static fromStored(name, root, value) {
    exactKeys(value, [
      "version", "name", "root", "phase", "applyIndex", "rollbackIndex",
      "workspace", "authorities", "snapshots", "targets", "updatedAt",
    ], "migration journal");
    if (value.version !== VERSION || value.name !== name || path.resolve(value.root) !== path.resolve(root)) {
      throw new Error("migration journal targets a different authority");
    }
    if (!Array.isArray(value.authorities) || !Array.isArray(value.snapshots) || !Array.isArray(value.targets)) {
      throw new Error("migration journal lists are invalid");
    }
    const authorities = value.authorities.map((item) => OfflineMigrationAuthority.fromStored(root, item));
    const snapshots = value.snapshots.map((item) => OfflineMigrationDirectorySnapshot.fromStored(root, item));
    const targets = value.targets.map((item) => OfflineMigrationTarget.fromStored(root, item));
    if (new Set(targets.map((target) => target.relativePath)).size !== targets.length) {
      throw new Error("migration journal contains duplicate targets");
    }
    return new MigrationJournal({
      ...value,
      root,
      workspace: OfflineMigrationWorkspaceAuthority.fromStored(root, value.workspace),
      authorities,
      snapshots,
      targets,
    });
  }

  advance(phase, { applyIndex = this.applyIndex, rollbackIndex = this.rollbackIndex } = {}) {
    this.phase = phase;
    this.applyIndex = applyIndex;
    this.rollbackIndex = rollbackIndex;
    this.updatedAt = new Date().toISOString();
  }

  ownWorkspace(authority) {
    if (!(authority instanceof OfflineMigrationWorkspaceAuthority)) {
      throw new Error("migration workspace authority is invalid");
    }
    if (authority.token !== this.workspace.token || authority.relativePath !== this.workspace.relativePath) {
      throw new Error("migration workspace intent changed");
    }
    this.workspace = authority;
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      version: VERSION,
      name: this.name,
      root: this.root,
      phase: this.phase,
      applyIndex: this.applyIndex,
      rollbackIndex: this.rollbackIndex,
      workspace: this.workspace.toJSON(),
      authorities: this.authorities.map((item) => item.toJSON()),
      snapshots: this.snapshots.map((item) => item.toJSON()),
      targets: this.targets.map((item) => item.toJSON()),
      updatedAt: this.updatedAt,
    };
  }
}

class MigrationJournalStore {
  constructor(root, relativePath) {
    const located = withinRoot(path.resolve(root), path.join(root, relativePath));
    this.path = located.resolved;
    const managedDirectory = new RealDirectoryAuthority(path.join(root, PRODUCT.managedDirName));
    managedDirectory.ensure();
    this.directoryAuthority = new RealDirectoryAuthority(path.dirname(this.path), {
      create: true,
      parentAuthority: managedDirectory,
    });
    this.directoryAuthority.ensure();
    this.file = new AtomicJsonFile(this.path);
  }

  exists() {
    try {
      const stat = fs.lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(this.path) !== this.path) {
        throw new Error(`migration journal must be one real non-hardlinked file: ${this.path}`);
      }
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  read(name, root) {
    if (!this.exists()) return null;
    return MigrationJournal.fromStored(name, root, this.file.read(null));
  }

  write(journal) {
    this.file.write(journal.toJSON());
  }

  remove(journal) {
    let unlinked = false;
    try {
      fs.unlinkSync(this.path);
      unlinked = true;
      fsyncDirectory(path.dirname(this.path));
    } catch (cause) {
      let residue = true;
      try {
        fs.lstatSync(this.path);
      } catch (error) {
        if (error.code === "ENOENT") residue = false;
        else {
          throw new AggregateError(
            [cause, error],
            `migration journal removal and residue inspection both failed: ${this.path}`,
            { cause },
          );
        }
      }
      throw new OfflineMigrationJournalRemovalError(
        `migration journal removal failed during ${unlinked ? "directory-fsync" : "unlink"}: ${this.path}`,
        {
          cause,
          phase: unlinked ? "journal-remove-directory-fsync" : "journal-remove-unlink",
          journalPath: this.path,
          journal: journal.toJSON(),
          durabilityUnknown: unlinked,
          residue,
        },
      );
    }
  }
}

export class OfflineMigrationTransaction {
  constructor({ root, name, journalPath, authorities, snapshots = [], targets }) {
    this.root = path.resolve(root);
    this.name = name;
    this.store = new MigrationJournalStore(this.root, journalPath);
    this.journal = MigrationJournal.create(name, this.root, authorities, snapshots, targets);
  }

  static recover({ root, name, journalPath }) {
    const authorityRoot = path.resolve(root);
    const store = new MigrationJournalStore(authorityRoot, journalPath);
    const journal = store.read(name, authorityRoot);
    if (!journal) return { recovered: false, completed: false };
    const transaction = new OfflineMigrationTransaction({
      root: authorityRoot,
      name,
      journalPath,
      authorities: journal.authorities,
      snapshots: journal.snapshots,
      targets: journal.targets,
    });
    transaction.store = store;
    transaction.journal = journal;
    return transaction.#recover();
  }

  apply() {
    if (this.store.exists()) throw new Error(`migration journal already exists: ${this.store.path}`);
    for (const authority of this.journal.authorities) authority.assertUnchanged();
    for (const snapshot of this.journal.snapshots) snapshot.assertUnchanged();
    for (const target of this.journal.targets) target.assertInitialIdentity();
    this.store.write(this.journal);
    this.journal.advance("applying");
    this.store.write(this.journal);
    let primary = null;
    try {
      this.#acquireWorkspace();
      for (let index = 0; index < this.journal.targets.length; index += 1) {
        const target = this.journal.targets[index];
        if (target.classify() !== "original") throw new Error(`migration target is not original: ${target.relativePath}`);
        target.planPlanned();
        this.store.write(this.journal);
        target.reservePlanned();
        this.store.write(this.journal);
        target.preparePlanned();
        this.store.write(this.journal);
        target.commitPlanned();
        if (target.classify() !== "planned") throw new Error(`migration target write was not durable: ${target.relativePath}`);
        this.journal.advance("applying", { applyIndex: index + 1 });
        this.store.write(this.journal);
      }
      this.journal.advance("applied", { applyIndex: this.journal.targets.length, rollbackIndex: -1 });
      this.store.write(this.journal);
    } catch (error) {
      primary = error;
    }
    if (!primary) {
      this.#cleanupWorkspace(this.#acquireWorkspace({ allowMissing: true }));
      this.store.remove(this.journal);
      return;
    }
    try {
      this.#rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [primary, rollbackError],
        "migration apply and rollback both failed",
        { cause: primary },
      );
    }
    throw primary;
  }

  #recover() {
    for (const authority of this.journal.authorities) authority.assertUnchanged();
    const mutablePaths = this.journal.targets.flatMap((target) => [
      target.relativePath,
      target.plannedGeneration?.relativeTempPath,
      target.rollbackGeneration?.relativeTempPath,
    ].filter(Boolean));
    for (const snapshot of this.journal.snapshots) {
      snapshot.assertUnchanged({ identity: false, mutablePaths });
    }
    if (this.journal.phase === "applied") {
      for (const target of this.journal.targets) {
        if (target.classify() !== "planned") throw new Error(`applied migration target is foreign: ${target.relativePath}`);
      }
      this.#cleanupWorkspace(this.#acquireWorkspace({ allowMissing: true }));
      this.store.remove(this.journal);
      return { recovered: true, completed: true };
    }
    if (this.journal.phase === "rolled-back") {
      for (const target of this.journal.targets) {
        if (target.classify() !== "original") throw new Error(`rolled-back migration target is foreign: ${target.relativePath}`);
      }
      this.#cleanupWorkspace(this.#acquireWorkspace({ allowMissing: true }));
      this.store.remove(this.journal);
      return { recovered: true, completed: false };
    }
    if (this.journal.phase === "rolling-back") {
      this.#acquireWorkspace();
      this.#continueRollback();
      this.store.remove(this.journal);
      return { recovered: true, completed: false };
    }
    if (this.journal.phase === "staged") {
      for (const target of this.journal.targets) {
        if (target.classify() !== "original") {
          throw new Error(`staged migration target is foreign: ${target.relativePath}`);
        }
      }
      this.#acquireWorkspace();
      this.#rollback();
      this.store.remove(this.journal);
      return { recovered: true, completed: false };
    }

    this.#acquireWorkspace();

    let contiguousPlanned = 0;
    for (let index = 0; index < this.journal.targets.length; index += 1) {
      const target = this.journal.targets[index];
      const state = target.classify();
      if (state === "planned" && contiguousPlanned === index) contiguousPlanned += 1;
      else if (state !== "original") throw new Error(`migration recovery target is foreign: ${target.relativePath}`);
    }
    if (contiguousPlanned < this.journal.applyIndex) {
      throw new Error("migration recovery lost journaled apply progress");
    }
    if (contiguousPlanned > this.journal.applyIndex) {
      this.journal.advance("applying", { applyIndex: contiguousPlanned });
      this.store.write(this.journal);
    }
    if (contiguousPlanned === this.journal.targets.length) {
      this.journal.advance("applied", { applyIndex: contiguousPlanned, rollbackIndex: -1 });
      this.store.write(this.journal);
      this.#cleanupWorkspace(this.#acquireWorkspace({ allowMissing: true }));
      this.store.remove(this.journal);
      return { recovered: true, completed: true };
    }
    this.#rollback();
    this.store.remove(this.journal);
    return { recovered: true, completed: false };
  }

  #rollback() {
    this.#acquireWorkspace();
    this.journal.advance("rolling-back", { rollbackIndex: this.journal.targets.length - 1 });
    this.store.write(this.journal);
    this.#continueRollback();
  }

  #continueRollback() {
    for (let index = this.journal.targets.length - 1; index > this.journal.rollbackIndex; index -= 1) {
      const state = this.journal.targets[index].classify();
      if (state !== "original") {
        throw new Error(`completed migration rollback target is foreign: ${this.journal.targets[index].relativePath}`);
      }
    }
    for (let index = this.journal.rollbackIndex; index >= 0; index -= 1) {
      const target = this.journal.targets[index];
      const state = target.classify();
      if (state === "foreign") throw new Error(`migration rollback target is foreign: ${target.relativePath}`);
      if (state === "planned") {
        target.planOriginal();
        this.store.write(this.journal);
        target.reserveOriginal();
        this.store.write(this.journal);
        target.prepareOriginal();
        this.store.write(this.journal);
        target.commitOriginal();
      }
      if (target.classify() !== "original") throw new Error(`migration rollback was not durable: ${target.relativePath}`);
      this.journal.advance("rolling-back", { rollbackIndex: index - 1 });
      this.store.write(this.journal);
    }
    for (const target of this.journal.targets) target.cleanupPreparedGenerations();
    this.journal.advance("rolled-back", { applyIndex: 0, rollbackIndex: -1 });
    this.store.write(this.journal);
    this.#cleanupWorkspace(this.#acquireWorkspace({ allowMissing: true }));
  }

  #acquireWorkspace({ allowMissing = false } = {}) {
    const workspace = OfflineMigrationWorkspace.acquire(this.journal.workspace, { allowMissing });
    if (workspace == null) return null;
    if (this.journal.workspace.dev === null) {
      this.journal.ownWorkspace(workspace.authority);
      this.store.write(this.journal);
    }
    for (const target of this.journal.targets) target.bindWorkspace(workspace);
    return workspace;
  }

  #cleanupWorkspace(workspace) {
    if (workspace == null) return;
    for (const target of this.journal.targets) target.cleanupPreparedGenerations();
    workspace.cleanup();
  }
}
