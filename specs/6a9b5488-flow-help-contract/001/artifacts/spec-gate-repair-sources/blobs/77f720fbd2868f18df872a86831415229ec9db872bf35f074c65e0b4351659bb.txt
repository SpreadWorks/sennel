import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { managedDir } from "./config.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FlowVersion, FlowVersionRelativeLocation } from "./flow-version.js";
import { DEFAULT_FLOW_SPEC_DIR, FlowSpecRoot } from "./flow-workspace.js";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { RepositoryFlowOperationLock, resolveRepositoryLockRoot } from "./repository-maintenance-lock.js";
import { PRODUCT } from "./product.js";

const AUTHORITY_FILE = ".flow-target-identities";
const AUTHORITY_LOCK_FILE = ".flow-target-identities.lock";
const AUTHORITY_REPOSITORY_PATHS = Object.freeze([
  PRODUCT.managedPath(AUTHORITY_FILE),
  PRODUCT.managedPath(AUTHORITY_LOCK_FILE),
]);
const PREPARING_PREFIX = ".active-flow.";
const ACTIVE_MODES = new Set(["worktree", "branch", "direct"]);
const LIFECYCLES = new Set(["preparing", "active"]);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_RUN_ID_LENGTH = 200;

function authorityPath(mainRoot) {
  return path.join(managedDir(mainRoot), AUTHORITY_FILE);
}

function authorityRevision(bytes) {
  return bytes == null ? null : crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalIdentityValue({ runId, issue, specId, lifecycle, mode, stateLocation }) {
  return JSON.stringify({ runId, issue, specId, lifecycle, mode, stateLocation });
}

function identityRevision(value) {
  return crypto.createHash("sha256").update(canonicalIdentityValue(value)).digest("hex");
}

function validIssue(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function validRepositoryRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\") || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value
    && value !== "."
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function exactKeys(value, keys) {
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export class FlowTargetAuthorityError extends Error {
  constructor(message, { cause, data } = {}) {
    super(message, { cause });
    this.name = "FlowTargetAuthorityError";
    this.code = "FLOW_TARGET_AUTHORITY_CORRUPT";
    this.data = data;
  }
}

export class FlowTargetRecoveryError extends Error {
  constructor(identity, message, { cause, reason } = {}) {
    super(message, { cause });
    this.name = "FlowTargetRecoveryError";
    this.code = "FLOW_TARGET_RECOVERY_REQUIRED";
    this.data = {
      reason: reason ?? cause?.code ?? "FLOW_TARGET_STATE_INVALID",
      ...identity.toErrorData(),
    };
  }
}

export class FlowTargetIdentity {
  constructor({ runId, issue = null, specId = null, lifecycle, mode = null, stateLocation, revision = null } = {}) {
    if (
      typeof runId !== "string"
      || runId.length > MAX_RUN_ID_LENGTH
      || !SAFE_RUN_ID.test(runId)
      || runId === "."
      || runId === ".."
    ) {
      throw new FlowTargetAuthorityError("flow target identity runId is invalid");
    }
    const normalizedIssue = issue == null ? null : Number(issue);
    if (!validIssue(normalizedIssue)) {
      throw new FlowTargetAuthorityError(`flow target identity Issue is invalid for ${runId}`);
    }
    if (!LIFECYCLES.has(lifecycle)) {
      throw new FlowTargetAuthorityError(`flow target identity lifecycle is invalid for ${runId}`);
    }
    let normalizedSpecId = null;
    if (specId != null) {
      try {
        normalizedSpecId = FlowSpecId.from(specId).toString();
      } catch (cause) {
        throw new FlowTargetAuthorityError(`flow target identity specId is invalid for ${runId}`, { cause });
      }
    }
    if (lifecycle === "preparing" && (normalizedSpecId !== null || mode !== null)) {
      throw new FlowTargetAuthorityError(`preparing target identity must not have a spec or mode: ${runId}`);
    }
    if (lifecycle === "active" && (normalizedSpecId === null || !ACTIVE_MODES.has(mode))) {
      throw new FlowTargetAuthorityError(`active target identity requires a spec and mode: ${runId}`);
    }
    if (!validRepositoryRelativePath(stateLocation)) {
      throw new FlowTargetAuthorityError(`flow target identity state location is invalid for ${runId}`);
    }
    if (lifecycle === "active") {
      try {
        const location = FlowVersionRelativeLocation.fromArtifactPath({
          relativeArtifactPath: stateLocation,
          logicalKey: "flow.state",
        });
        if (location.specId.toString() !== normalizedSpecId) {
          throw new Error("active target location specId does not match its identity");
        }
      } catch (cause) {
        throw new FlowTargetAuthorityError(`active flow target state location is invalid for ${runId}`, { cause });
      }
    }
    const value = {
      runId,
      issue: normalizedIssue,
      specId: normalizedSpecId,
      lifecycle,
      mode,
      stateLocation,
    };
    const expectedRevision = identityRevision(value);
    if (revision != null && revision !== expectedRevision) {
      throw new FlowTargetAuthorityError(`flow target identity revision is stale for ${runId}`, {
        data: { runId, issue: normalizedIssue, specId: normalizedSpecId },
      });
    }
    this.runId = runId;
    this.issue = normalizedIssue;
    this.specId = normalizedSpecId;
    this.lifecycle = lifecycle;
    this.mode = mode;
    this.stateLocation = stateLocation;
    this.revision = expectedRevision;
    Object.freeze(this);
  }

  static fromStored(value) {
    if (!exactKeys(value, ["runId", "issue", "specId", "lifecycle", "mode", "stateLocation", "revision"])) {
      throw new FlowTargetAuthorityError("flow target identity entry has an invalid schema");
    }
    return new FlowTargetIdentity(value);
  }

  static preparing(state) {
    if (state?.lifecycle !== "preparing" || state?.specId !== null) {
      throw new FlowTargetAuthorityError("preparing flow state must retain preparing lifecycle and null specId");
    }
    return new FlowTargetIdentity({
      runId: state?.runId,
      issue: state?.issue ?? null,
      specId: null,
      lifecycle: "preparing",
      mode: null,
      stateLocation: PRODUCT.managedPath(`${PREPARING_PREFIX}${state?.runId}`),
    });
  }

  static active(state, mode, specRoot = DEFAULT_FLOW_SPEC_DIR) {
    const lifecycle = state?.lifecycle?.state ?? state?.lifecycle;
    if (lifecycle === "preparing") {
      throw new FlowTargetAuthorityError("active flow state must not use preparing lifecycle");
    }
    const executionMode = state?.execution?.mode;
    if (!ACTIVE_MODES.has(executionMode)) {
      throw new FlowTargetAuthorityError("active flow state requires a canonical execution mode");
    }
    if (mode !== executionMode) {
      throw new FlowTargetAuthorityError("active flow registry mode must match canonical execution mode");
    }
    const normalizedSpecId = FlowSpecId.from(state?.specId).toString();
    const versionLocation = new FlowVersionRelativeLocation({
      specRoot: FlowSpecRoot.from(specRoot).toString(),
      specId: normalizedSpecId,
      version: new FlowVersion(1),
    });
    return new FlowTargetIdentity({
      runId: state?.runId,
      issue: state?.issue ?? null,
      specId: normalizedSpecId,
      lifecycle: "active",
      mode,
      stateLocation: versionLocation.relativeArtifact("flow.state"),
    });
  }

  get preparing() {
    return this.lifecycle === "preparing";
  }

  matches(expectation) {
    return expectation.mismatchAgainst(this.toSelectionJSON()) == null;
  }

  assertState(state) {
    let actual;
    try {
      actual = this.preparing
        ? FlowTargetIdentity.preparing(state)
        : FlowTargetIdentity.active(
          state,
          this.mode,
          FlowVersionRelativeLocation.fromArtifactPath({
            relativeArtifactPath: this.stateLocation,
            logicalKey: "flow.state",
          }).specRoot,
        );
    } catch (cause) {
      throw new FlowTargetRecoveryError(
        this,
        `selected flow target state identity is invalid: ${this.runId}`,
        { cause, reason: "FLOW_TARGET_STATE_IDENTITY_INVALID" },
      );
    }
    if (actual.revision !== this.revision || actual.stateLocation !== this.stateLocation) {
      throw new FlowTargetRecoveryError(
        this,
        `selected flow target state does not match its identity authority: ${this.runId}`,
        { reason: "FLOW_TARGET_STATE_REVISION_MISMATCH" },
      );
    }
    return state;
  }

  toSelectionJSON() {
    return { runId: this.runId, issue: this.issue, specId: this.specId };
  }

  toErrorData() {
    return {
      runId: this.runId,
      issue: this.issue,
      specId: this.specId,
      lifecycle: this.lifecycle,
      mode: this.mode,
      stateLocation: this.stateLocation,
    };
  }

  toJSON() {
    return {
      ...this.toSelectionJSON(),
      lifecycle: this.lifecycle,
      mode: this.mode,
      stateLocation: this.stateLocation,
      revision: this.revision,
    };
  }
}

class FlowTargetIdentityDocument {
  constructor(entries = []) {
    if (!Array.isArray(entries)) {
      throw new FlowTargetAuthorityError("flow target identity authority must contain an array");
    }
    this.entries = entries.map((entry) => (
      entry instanceof FlowTargetIdentity ? entry : FlowTargetIdentity.fromStored(entry)
    ));
    const runIds = new Set();
    const activeSpecs = new Set();
    const locations = new Set();
    for (const entry of this.entries) {
      if (runIds.has(entry.runId)) {
        throw new FlowTargetAuthorityError(`flow target identity authority duplicates runId: ${entry.runId}`);
      }
      runIds.add(entry.runId);
      if (locations.has(entry.stateLocation)) {
        throw new FlowTargetAuthorityError(`flow target identity authority duplicates state location: ${entry.stateLocation}`);
      }
      locations.add(entry.stateLocation);
      if (entry.lifecycle === "active") {
        if (activeSpecs.has(entry.specId)) {
          throw new FlowTargetAuthorityError(`flow target identity authority duplicates specId: ${entry.specId}`);
        }
        activeSpecs.add(entry.specId);
      }
    }
  }

  findRunId(runId) {
    return this.entries.find((entry) => entry.runId === runId) ?? null;
  }

  findActiveSpec(specId) {
    return this.entries.find((entry) => entry.lifecycle === "active" && entry.specId === specId) ?? null;
  }

  addPreparing(state) {
    const next = FlowTargetIdentity.preparing(state);
    if (this.findRunId(next.runId)) {
      throw new FlowTargetAuthorityError(`flow target identity already exists: ${next.runId}`);
    }
    this.entries.push(next);
    return next;
  }

  addActive(state, mode, specRoot) {
    const next = FlowTargetIdentity.active(state, mode, specRoot);
    const sameRun = this.findRunId(next.runId);
    const sameSpec = this.findActiveSpec(next.specId);
    if (sameSpec && sameSpec.runId !== next.runId) {
      throw new FlowTargetAuthorityError(`active flow identity already exists for spec: ${next.specId}`);
    }
    if (sameRun && sameRun.lifecycle === "active" && sameRun.revision === next.revision) return sameRun;
    if (sameRun && sameRun.lifecycle !== "preparing") {
      throw new FlowTargetAuthorityError(`flow target runId conflicts during activation: ${next.runId}`);
    }
    this.entries = this.entries.filter((entry) => entry.runId !== next.runId && entry.specId !== next.specId);
    this.entries.push(next);
    return next;
  }

  replace(identity) {
    const index = this.entries.findIndex((entry) => entry.runId === identity.runId);
    if (index < 0) {
      throw new FlowTargetAuthorityError(`flow target identity is missing: ${identity.runId}`, {
        data: identity.toErrorData(),
      });
    }
    const current = this.entries[index];
    if (current.lifecycle !== identity.lifecycle || current.specId !== identity.specId || current.mode !== identity.mode) {
      throw new FlowTargetAuthorityError(`flow target identity replacement changes target ownership: ${identity.runId}`);
    }
    this.entries[index] = identity;
    return current;
  }

  remove({ runId = null, specId = null, lifecycle = null } = {}) {
    const matches = this.entries.filter((entry) => (
      (runId == null || entry.runId === runId)
      && (specId == null || entry.specId === specId)
      && (lifecycle == null || entry.lifecycle === lifecycle)
    ));
    if (matches.length > 1) {
      throw new FlowTargetAuthorityError("flow target identity removal is ambiguous");
    }
    if (matches.length === 0) return null;
    const selected = matches[0];
    this.entries = this.entries.filter((entry) => entry !== selected);
    return selected;
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}

export class FlowTargetIdentitySnapshot {
  constructor({ entries, revision }) {
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof FlowTargetIdentity ? entry : FlowTargetIdentity.fromStored(entry)
    )));
    if (revision != null && typeof revision !== "string") {
      throw new FlowTargetAuthorityError("flow target identity authority revision is invalid");
    }
    this.revision = revision;
    Object.freeze(this);
  }
}

function readAuthority(filePath) {
  try {
    fs.lstatSync(path.dirname(filePath));
  } catch (cause) {
    if (cause.code === "ENOENT") {
      return { document: new FlowTargetIdentityDocument(), revision: null };
    }
    throw new FlowTargetAuthorityError(`flow target identity authority is unreadable: ${filePath}`, { cause });
  }
  let bytes;
  try {
    bytes = new AtomicFile(filePath).read(null);
  } catch (cause) {
    throw new FlowTargetAuthorityError(`flow target identity authority is unreadable: ${filePath}`, { cause });
  }
  if (bytes == null) return { document: new FlowTargetIdentityDocument(), revision: null };
  let stored;
  try {
    stored = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new FlowTargetAuthorityError(`flow target identity authority is malformed: ${filePath}`, { cause });
  }
  return {
    document: new FlowTargetIdentityDocument(stored),
    revision: authorityRevision(bytes),
  };
}

export class FlowTargetIdentityAuthority {
  constructor({ mainRoot, specRoot = DEFAULT_FLOW_SPEC_DIR, processIdentitySource, faultInjector = () => {} } = {}) {
    this._mainRoot = resolveRepositoryLockRoot(mainRoot);
    this._specRoot = FlowSpecRoot.from(specRoot);
    this._processIdentitySource = processIdentitySource;
    this._faultInjector = faultInjector;
    const rootAuthority = new RealDirectoryAuthority(this._mainRoot);
    const directoryAuthority = new RealDirectoryAuthority(managedDir(this._mainRoot), {
      create: true,
      parentAuthority: rootAuthority,
    });
    this._lock = new FileLock({
      directoryAuthority,
      fileName: AUTHORITY_LOCK_FILE,
      kind: "flow-target-identity-authority",
      authority: { mainRoot: this._mainRoot, path: authorityPath(this._mainRoot) },
      ...(processIdentitySource && { processIdentitySource }),
      errorFactory: (status, message, { lockPath, cause } = {}) => {
        const error = new FlowTargetAuthorityError(message, { cause });
        error.code = status === "live" || status === "timeout"
          ? "FLOW_TARGET_AUTHORITY_BUSY"
          : `FLOW_TARGET_AUTHORITY_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
        error.lockPath = lockPath;
        return error;
      },
    });
  }

  static pathFor(mainRoot) {
    return authorityPath(resolveRepositoryLockRoot(mainRoot));
  }

  static managesRepositoryPath(filePath) {
    return AUTHORITY_REPOSITORY_PATHS.includes(filePath);
  }

  static repositoryPaths() {
    return AUTHORITY_REPOSITORY_PATHS;
  }

  snapshot() {
    const current = readAuthority(authorityPath(this._mainRoot));
    return new FlowTargetIdentitySnapshot({ entries: current.document.entries, revision: current.revision });
  }

  addPreparing(state, options = {}) {
    return this.#mutate((document) => document.addPreparing(state), options);
  }

  addActive(state, mode, options = {}) {
    return this.#mutate((document) => document.addActive(state, mode, this._specRoot), options);
  }

  replacePreparing(state, options = {}) {
    const identity = FlowTargetIdentity.preparing(state);
    return this.#mutate((document) => document.replace(identity), options);
  }

  replaceActive(state, mode, options = {}) {
    const identity = FlowTargetIdentity.active(state, mode, this._specRoot);
    return this.#mutate((document) => document.replace(identity), options);
  }

  removePreparing(runId, options = {}) {
    return this.#mutate((document) => document.remove({ runId, lifecycle: "preparing" }), options);
  }

  removeActive(specId, options = {}) {
    return this.#mutate((document) => document.remove({ specId, lifecycle: "active" }), options);
  }

  restore(identity, options = {}) {
    if (!(identity instanceof FlowTargetIdentity)) {
      throw new FlowTargetAuthorityError("restored flow target identity is invalid");
    }
    return this.#mutate((document) => {
      if (document.findRunId(identity.runId)) {
        throw new FlowTargetAuthorityError(`flow target identity already exists: ${identity.runId}`);
      }
      if (identity.lifecycle === "active" && document.findActiveSpec(identity.specId)) {
        throw new FlowTargetAuthorityError(`active flow identity already exists for spec: ${identity.specId}`);
      }
      if (document.entries.some((entry) => entry.stateLocation === identity.stateLocation)) {
        throw new FlowTargetAuthorityError(
          `flow target identity already exists for state location: ${identity.stateLocation}`,
        );
      }
      document.entries.push(identity);
      return identity;
    }, options);
  }

  #mutate(mutation, options) {
    const operationLock = new RepositoryFlowOperationLock({
      mainRoot: this._mainRoot,
      maintenanceOwnerToken: options.maintenanceOwnerToken ?? null,
      operationOwnerToken: options.operationOwnerToken ?? null,
      ...(this._processIdentitySource && { processIdentitySource: this._processIdentitySource }),
    });
    operationLock.acquire();
    let result;
    let primary = null;
    try {
      result = this._lock.runExclusive(() => {
        const current = readAuthority(authorityPath(this._mainRoot));
        const mutationResult = mutation(current.document);
        const fresh = readAuthority(authorityPath(this._mainRoot));
        if (fresh.revision !== current.revision) {
          const error = new FlowTargetAuthorityError("flow target identity authority changed concurrently");
          error.code = "FLOW_TARGET_AUTHORITY_REVISION_CONFLICT";
          throw error;
        }
        new AtomicJsonFile(authorityPath(this._mainRoot), { faultInjector: this._faultInjector })
          .write(current.document.toJSON());
        return mutationResult;
      });
    } catch (error) {
      primary = error;
    }
    let releaseError = null;
    try {
      operationLock.release();
    } catch (error) {
      releaseError = error;
    }
    if (primary && releaseError) {
      throw new AggregateError(
        [primary, releaseError],
        "flow target identity mutation and repository lock release both failed",
        { cause: primary },
      );
    }
    if (primary) throw primary;
    if (releaseError) throw releaseError;
    return result;
  }
}
