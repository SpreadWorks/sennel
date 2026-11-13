import path from "node:path";
import { compareText } from "./text-order.js";
import { LogicalPathSet } from "../../lib/portable-path.js";
import { CurrentAttemptIdentity } from "./current-flow-state.js";
import { SourceWorkingFile, WorkerArtifactRepositoryEntry } from "./source-working-file.js";
import { normalizedRelativePath, requiredText as requiredString, exactKeys as exactObjectKeys } from "./source-effect-fields.js";
import { workerArtifactStableStringify as stableStringify, workerArtifactDigest as digest, assertWorkerArtifactStoredValue } from "./worker-artifact-input-format.js";

export const SOURCE_STATE_VERSION = 2;
function requiredDigest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} requires SHA-256`);
  return value;
}

export class SourceMutationEntry {
  constructor({ mutationId, path: relativePath, changeKind, beforeKind, beforeMode, beforeDigest, beforeGeneration, afterKind, afterMode, afterDigest, afterGeneration } = {}) {
    this.mutationId = requiredDigest(mutationId, "source mutation id");
    this.path = normalizedRelativePath(relativePath, "source mutation path");
    this.changeKind = requiredString(changeKind, "source mutation changeKind");
    if (!new Set(["added", "deleted", "content", "mode", "type"]).has(this.changeKind)) {
      throw new Error("source mutation changeKind is invalid");
    }
    const before = new SourceWorkingFile({ kind: beforeKind, digest: beforeDigest, generation: beforeGeneration });
    const after = new SourceWorkingFile({ kind: afterKind, digest: afterDigest, generation: afterGeneration });
    for (const mode of [beforeMode, afterMode]) {
      if (mode !== null && ![0o644, 0o755, 0o777].includes(mode)) throw new Error("source mutation Git-visible mode is invalid");
    }
    if (before.kind !== "file" && beforeMode !== null || after.kind !== "file" && afterMode !== null) throw new Error("non-file source mutation must not carry a Git mode");
    if (before.kind === after.kind && beforeMode === afterMode && before.digest === after.digest) {
      throw new Error("source mutation entry has no before/after change");
    }
    const expectedChangeKind = before.kind === "missing" ? "added"
      : after.kind === "missing" ? "deleted"
        : before.kind !== after.kind ? "type"
          : beforeMode !== afterMode ? "mode" : "content";
    if (this.changeKind !== expectedChangeKind) {
      throw new Error("source mutation changeKind does not match its entry fingerprints");
    }
    this.beforeKind = before.kind;
    this.beforeMode = beforeMode;
    this.beforeDigest = before.digest;
    this.afterKind = after.kind;
    this.afterMode = afterMode;
    this.afterDigest = after.digest;
    this.beforeGeneration = before.generation;
    this.afterGeneration = after.generation;
    Object.freeze(this);
  }
  toJSON() {
    return {
      mutationId: this.mutationId, path: this.path, changeKind: this.changeKind,
      beforeKind: this.beforeKind, beforeMode: this.beforeMode, beforeDigest: this.beforeDigest, beforeGeneration: this.beforeGeneration?.toJSON() ?? null,
      afterKind: this.afterKind, afterMode: this.afterMode, afterDigest: this.afterDigest, afterGeneration: this.afterGeneration?.toJSON() ?? null,
    };
  }
}

export class SourceMutationManifestValue {
  #mutationIdByPath;
  #pathByMutationId;

  constructor({ attempt, baselineDigest, mutations = [], observations = [] } = {}) {
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.baselineDigest = requiredDigest(baselineDigest, "source mutation manifest baselineDigest");
    if (!Array.isArray(mutations)) throw new Error("source mutation manifest mutations must be an array");
    this.mutations = Object.freeze(mutations.map((entry) => entry instanceof SourceMutationEntry ? entry : (() => {
      exactObjectKeys(entry, ["mutationId", "path", "changeKind", "beforeKind", "beforeMode", "beforeDigest", "beforeGeneration", "afterKind", "afterMode", "afterDigest", "afterGeneration"], "source mutation entry");
      return new SourceMutationEntry(entry);
    })())
      .sort((left, right) => compareText(left.path, right.path)));
    if (new Set(this.mutations.map((entry) => entry.mutationId)).size !== this.mutations.length
      || new Set(this.mutations.map((entry) => entry.path)).size !== this.mutations.length) {
      throw new Error("source mutation manifest mutations must be unique");
    }
    for (const entry of this.mutations) {
      if (entry.mutationId !== SourceMutationManifestValue.mutationId(this.attempt, entry.path)) {
        throw new TypeError("source mutation id does not bind its Attempt and path");
      }
    }
    new LogicalPathSet(this.mutations.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    if (!Array.isArray(observations)) throw new TypeError("source mutation observations must be an array");
    this.observations = Object.freeze(observations.map((entry) => entry instanceof WorkerArtifactRepositoryEntry
      ? entry : WorkerArtifactRepositoryEntry.fromStored(entry)).sort((left, right) => compareText(left.path, right.path)));
    new LogicalPathSet(this.observations.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    new LogicalPathSet(this.observations.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    new LogicalPathSet(this.observations.filter((entry) => entry.kind !== "missing").map((entry) => entry.workingPath), { allowDirectoryPrefixes: true });
    new LogicalPathSet(this.observations.filter((entry) => entry.kind === "file").map((entry) => entry.workingPath));
    const observed = new Map(this.observations.map((entry) => [entry.path, entry]));
    for (const mutation of this.mutations) {
      const after = observed.get(mutation.path) ?? WorkerArtifactRepositoryEntry.missing(mutation.path);
      const expected = new SourceWorkingFile({ kind: mutation.afterKind, digest: mutation.afterDigest, generation: mutation.afterGeneration });
      if (!after.working.sameContent(expected) || after.mode !== mutation.afterMode
        || (expected.generation === null ? after.working.generation !== null : !expected.generation.equals(after.working.generation))) {
        throw new TypeError("source mutation after-image differs from its stopped observation");
      }
    }
    this.#mutationIdByPath = new Map(this.mutations.map((entry) => [entry.path, entry.mutationId]));
    this.#pathByMutationId = new Map(this.mutations.map((entry) => [entry.mutationId, entry.path]));
    this.digest = digest(stableStringify(this.unsignedJSON()));
    Object.freeze(this);
  }

  static mutationId(attempt, relativePath) {
    return digest(stableStringify({ attempt: CurrentAttemptIdentity.from(attempt).toJSON(), path: normalizedRelativePath(relativePath, "source mutation id path") }));
  }

  static fromStored(value) {
    exactObjectKeys(value, ["version", "attempt", "baselineDigest", "mutations", "observations", "digest"], "source mutation manifest");
    if (value.version !== SOURCE_STATE_VERSION) throw new Error("source mutation manifest version is invalid");
    const manifest = new this(value);
    if (manifest.digest !== requiredDigest(value.digest, "source mutation manifest digest")) throw new Error("source mutation manifest digest does not match its content");
    assertWorkerArtifactStoredValue(value, manifest.toJSON(), "source mutation manifest");
    return manifest;
  }

  unsignedJSON() { return { version: SOURCE_STATE_VERSION, attempt: this.attempt.toJSON(), baselineDigest: this.baselineDigest, mutations: this.mutations.map((entry) => entry.toJSON()), observations: this.observations.map((entry) => entry.toJSON()) }; }
  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
  paths() { return this.mutations.map((entry) => entry.path); }
  mutationIdForPath(relativePath) {
    const path = normalizedRelativePath(relativePath, "source mutation manifest path");
    const mutationId = this.#mutationIdByPath.get(path);
    if (!mutationId) throw new Error(`repair finding path is absent from the current Attempt manifest: ${path}`);
    return mutationId;
  }
  pathForMutationId(mutationId) {
    const path = this.#pathByMutationId.get(mutationId);
    if (!path) throw new Error(`source mutation id is absent from the current Attempt manifest: ${mutationId}`);
    return path;
  }
}

/** A canonical journal receipt for one closed-stage or absence publication. */
export class SourceRollbackOperationReceipt {
  constructor({ version = 1, path, workingPath, operation, phase, before, after, beforeMode, afterMode, digest: storedDigest = null }) {
    if (version !== 1 || !["write", "remove", "directory"].includes(operation) || !["prepared", "published"].includes(phase)) throw new TypeError("source rollback operation receipt is invalid");
    this.version = version; this.path = normalizedRelativePath(path, "source rollback operation path");
    this.workingPath = normalizedRelativePath(workingPath, "source rollback native working path");
    if (new LogicalPathSet([this.path]).spellingFor(this.workingPath) !== this.path) throw new TypeError("source rollback native path differs from its logical identity");
    this.operation = operation; this.phase = phase;
    this.before = before instanceof SourceWorkingFile ? before : SourceWorkingFile.fromStored(before);
    this.after = after instanceof SourceWorkingFile ? after : SourceWorkingFile.fromStored(after);
    for (const mode of [beforeMode, afterMode]) if (mode !== null && ![0o644, 0o755, 0o777].includes(mode)) throw new TypeError("source rollback receipt Git mode is invalid");
    if (this.after.kind !== (operation === "write" ? "file" : operation === "directory" ? "directory" : "missing")) throw new TypeError("source rollback receipt operation differs from its publication");
    if (this.before.kind !== "file" && beforeMode !== null || this.after.kind !== "file" && afterMode !== null) throw new TypeError("non-file rollback receipt must not carry a Git mode");
    this.beforeMode = beforeMode; this.afterMode = afterMode;
    this.digest = digest(stableStringify(this.unsignedJSON()));
    if (storedDigest !== null && storedDigest !== this.digest) throw new TypeError("source rollback operation digest mismatch");
    Object.freeze(this);
  }
  unsignedJSON() { return { version: this.version, path: this.path, workingPath: this.workingPath, operation: this.operation, phase: this.phase,
    before: this.before.toJSON(), after: this.after.toJSON(), beforeMode: this.beforeMode, afterMode: this.afterMode }; }
  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
  static fromStored(value) {
    exactObjectKeys(value, ["version", "path", "workingPath", "operation", "phase", "before", "after", "beforeMode", "afterMode", "digest"], "source rollback operation receipt");
    requiredDigest(value.digest, "source rollback operation digest");
    const receipt = new this(value);
    assertWorkerArtifactStoredValue(value, receipt.toJSON(), "source rollback operation receipt");
    return receipt;
  }
  /** Project observed spellings plus retained published operations; capture proves physical correspondence. */
  static targetWorkingPath(relativePath, { baselineEntries, stoppedEntries, operations }) {
    const logical = normalizedRelativePath(relativePath, "source rollback target path");
    const baseline = new Map(baselineEntries.map((entry) => [entry.path, entry]));
    const stopped = new Map(stoppedEntries.map((entry) => [entry.path, entry]));
    const current = (candidate) => {
      const receipt = operations.get(candidate);
      if (receipt?.phase === "published") return receipt;
      return stopped.get(candidate);
    };
    const kind = (value) => value instanceof SourceRollbackOperationReceipt ? value.after.kind : value?.kind;
    const observed = current(logical);
    const leaf = observed !== undefined && kind(observed) !== "missing" ? observed : baseline.get(logical) ?? observed;
    if (leaf === undefined) throw new TypeError("source rollback target lacks a captured native spelling");
    let ancestor = path.posix.dirname(logical);
    while (ancestor !== ".") {
      const parent = current(ancestor);
      if (kind(parent) === "directory") {
        const suffix = leaf.workingPath.split("/").slice(ancestor.split("/").length).join("/");
        return path.posix.join(parent.workingPath, suffix);
      }
      ancestor = path.posix.dirname(ancestor);
    }
    return leaf.workingPath;
  }
  assertPathBinding(facts) {
    if (this.workingPath !== SourceRollbackOperationReceipt.targetWorkingPath(this.path, facts)) {
      throw new TypeError("source rollback receipt differs from its captured native target");
    }
    return this;
  }
  matchesEntry(entry, side = "after") {
    const working = entry?.working ?? new SourceWorkingFile({ kind: "missing" });
    return this.matches(working, side) && (entry?.mode ?? null) === this[`${side}Mode`]
      && (working.kind === "missing" || entry.workingPath === this.workingPath);
  }
  published() { return new SourceRollbackOperationReceipt({ ...this.unsignedJSON(), phase: "published" }); }
  matches(working, side = "after") {
    const expected = this[side];
    return expected.sameContent(working) && (expected.generation === null ? working.generation === null : expected.generation.equals(working.generation));
  }
}
