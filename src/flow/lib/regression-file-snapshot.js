import path from "path";
import { DEFAULT_MAX_CHANGED_FILE_ENTRIES } from "../../lib/git-helpers.js";
import { LogicalRelativePath, isNativePathWithin } from "../../lib/portable-path.js";
import { visitRegularFileChunks } from "../../lib/regular-file-snapshot.js";
import { compareText } from "./text-order.js";

const REGRESSION_FILE_STATUSES = Object.freeze(new Set([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
]));
const SNAPSHOT_KEYS = Object.freeze(new Set([
  "status",
  "path",
  "old_path",
  "fingerprint",
]));
const CHANGED_FILE_KEYS = Object.freeze(new Set([
  "status",
  "path",
  "old_path",
]));
const SHA256_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKnownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown property "${key}"`);
    }
  }
}

function normalizeRepoRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);

  const posixValue = value.split("\\").join("/");
  if (path.posix.isAbsolute(posixValue) || /^[A-Za-z]:\//.test(posixValue)) {
    throw new Error(`${label} must be relative`);
  }
  if (posixValue.split("/").includes("..")) {
    throw new Error(`${label} must not escape the repository root`);
  }

  const normalized = path.posix.normalize(posixValue);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  return new LogicalRelativePath(normalized, label).toString();
}

function normalizeSnapshotMetadata(input, allowedKeys, label, { external = false } = {}) {
  assertRecord(input, label);
  assertKnownKeys(input, allowedKeys, label);
  if (!REGRESSION_FILE_STATUSES.has(input.status)) {
    throw new Error(`${label}.status is invalid: ${input.status}`);
  }

  const normalized = {
    status: input.status,
    path: external ? normalizeRepoRelativePath(input.path, `${label}.path`)
      : new LogicalRelativePath(input.path, `${label}.path`).toString(),
  };
  if (input.status === "renamed") {
    if (!Object.hasOwn(input, "old_path")) {
      throw new Error(`${label}.old_path is required for renamed entries`);
    }
    normalized.old_path = external ? normalizeRepoRelativePath(input.old_path, `${label}.old_path`)
      : new LogicalRelativePath(input.old_path, `${label}.old_path`).toString();
  } else if (Object.hasOwn(input, "old_path")) {
    throw new Error(`${label}.old_path is only valid for renamed entries`);
  }
  return normalized;
}

function normalizeFingerprint(input, status, label) {
  if (!Object.hasOwn(input, "fingerprint")) {
    throw new Error(`${label}.fingerprint is required; rerun test-execute`);
  }
  if (status === "deleted") {
    if (input.fingerprint !== null) {
      throw new Error(`${label}.fingerprint must be null for deleted entries`);
    }
    return null;
  }
  if (typeof input.fingerprint !== "string" || !SHA256_FINGERPRINT_RE.test(input.fingerprint)) {
    throw new Error(`${label}.fingerprint must be a lowercase SHA-256 string`);
  }
  return input.fingerprint;
}

function resolveSnapshotFile(root, relativePath) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("regression snapshot root must be a non-empty path");
  }
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!isNativePathWithin(absoluteRoot, absolutePath) || absoluteRoot === absolutePath) {
    throw new Error(`regression snapshot path escapes repository root: ${relativePath}`);
  }
  return absolutePath;
}

function fingerprintFile(root, relativePath) {
  const absolutePath = resolveSnapshotFile(root, relativePath);
  return visitRegularFileChunks(absolutePath, { label: `regression snapshot file ${relativePath}`,
    maxBytes: Number.MAX_SAFE_INTEGER - 1, visit() {} }).digest;
}

function compareSnapshots(left, right) {
  return compareText(left.path, right.path)
    || compareText(left.status, right.status)
    || compareText(left.old_path || "", right.old_path || "");
}

function assertSnapshotCount(entries, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array`);
  if (entries.length > DEFAULT_MAX_CHANGED_FILE_ENTRIES) {
    throw new Error(`${label} exceeds the ${DEFAULT_MAX_CHANGED_FILE_ENTRIES}-entry limit`);
  }
}

export class RegressionFileSnapshot {
  constructor(input, label = "regression snapshot") {
    const metadata = normalizeSnapshotMetadata(input, SNAPSHOT_KEYS, label);
    this.status = metadata.status;
    this.path = metadata.path;
    if (metadata.old_path) this.old_path = metadata.old_path;
    this.fingerprint = normalizeFingerprint(input, metadata.status, label);
    Object.freeze(this);
  }

  static fromChangedFile(root, input, label = "changed file") {
    const metadata = normalizeSnapshotMetadata(input, CHANGED_FILE_KEYS, label, { external: true });
    return new RegressionFileSnapshot({
      ...metadata,
      fingerprint: metadata.status === "deleted"
        ? null
        : fingerprintFile(root, metadata.path),
    }, label);
  }

  static fromJSON(input, label = "regression snapshot") {
    return new RegressionFileSnapshot(input, label);
  }

  identityKey() {
    return `${this.status}\0${this.path}\0${this.old_path || ""}`;
  }

  equals(other) {
    return other instanceof RegressionFileSnapshot
      && this.status === other.status
      && this.path === other.path
      && this.old_path === other.old_path
      && this.fingerprint === other.fingerprint;
  }

  toJSON() {
    return {
      status: this.status,
      path: this.path,
      ...(this.old_path ? { old_path: this.old_path } : {}),
      fingerprint: this.fingerprint,
    };
  }
}

export class RegressionFileSnapshotList {
  constructor(entries, label = "regression snapshot list") {
    assertSnapshotCount(entries, label);
    const snapshots = entries.map((entry, index) => (
      entry instanceof RegressionFileSnapshot
        ? entry
        : RegressionFileSnapshot.fromJSON(entry, `${label}[${index}]`)
    ));
    const identities = new Set();
    for (const snapshot of snapshots) {
      const key = snapshot.identityKey();
      if (identities.has(key)) {
        throw new Error(`${label} contains duplicate entry: ${snapshot.path}`);
      }
      identities.add(key);
    }
    this.entries = Object.freeze([...snapshots].sort(compareSnapshots));
    Object.freeze(this);
  }

  static fromChangedFiles(root, entries) {
    assertSnapshotCount(entries, "changed files");
    return new RegressionFileSnapshotList(entries.map((entry, index) => (
      RegressionFileSnapshot.fromChangedFile(root, entry, `changed files[${index}]`)
    )));
  }

  static fromJSON(input, label = "regression snapshot list") {
    assertSnapshotCount(input, label);
    return new RegressionFileSnapshotList(input, label);
  }

  equals(other) {
    return other instanceof RegressionFileSnapshotList
      && this.entries.length === other.entries.length
      && this.entries.every((entry, index) => entry.equals(other.entries[index]));
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}
