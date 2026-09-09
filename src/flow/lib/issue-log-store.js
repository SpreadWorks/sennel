import crypto from "node:crypto";
import fs from "node:fs";

import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { FlowArtifactCatalogStore, FlowVersionLocation } from "../../lib/flow-version.js";
import { buildCurrentFlowDefinition } from "../definition.js";
import { CanonicalFlowRuntime } from "./canonical-flow-runtime.js";
import { ProcessIdentitySource } from "../../lib/process-identity.js";
import { FileLock, FileLockWaitPolicy } from "../../lib/file-lock.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";

function requireAuthorityString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function issueLogError(status, message, { lockPath, owner = null, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "IssueLogStoreError";
  error.code = status === "timeout"
    ? "ISSUE_LOG_BUSY"
    : `ISSUE_LOG_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockStatus = status;
  error.lockPath = lockPath;
  error.owner = owner;
  return error;
}

function revisionOf(document) {
  return crypto.createHash("sha256").update(JSON.stringify(document.toJSON())).digest("hex");
}

export class IssueLogDocument {
  constructor(value = {}) {
    if (value == null || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.entries)) {
      throw new Error('Invalid issue-log.json: "entries" must be an array');
    }
    this.entries = structuredClone(value.entries);
  }

  append(entry, idempotencyKey) {
    const key = requireAuthorityString(idempotencyKey, "issue-log idempotencyKey");
    const existing = this.entries.find((item) => item?.issueLogId === key || item?.grantId === key);
    if (existing) return { appended: false, entry: structuredClone(existing) };
    const stored = { ...structuredClone(entry), issueLogId: key };
    this.entries.push(stored);
    return { appended: true, entry: structuredClone(stored) };
  }

  toJSON() {
    return { entries: structuredClone(this.entries) };
  }
}

export class IssueLogSnapshot {
  constructor(document) {
    if (!(document instanceof IssueLogDocument)) {
      throw new Error("IssueLogSnapshot requires an IssueLogDocument");
    }
    this.document = document;
    this.revision = revisionOf(document);
    Object.freeze(this);
  }

  toJSON() {
    return this.document.toJSON();
  }
}

/**
 * Canonical Version issue-log adapter.
 *
 * The issue log is a producer-owned catalog artifact.  This class accepts only
 * a typed Version location and delegates every publication to the same
 * journaled Activity Store as flow.json and activities.jsonl.
 */
export class IssueLogStore {
  static forVersion(options = {}) {
    return new IssueLogStore(options);
  }

  constructor({
    location,
    processIdentitySource = new ProcessIdentitySource(),
    faultInjector,
    maintenanceOwnerToken = null,
    operationOwnerToken = null,
  } = {}) {
    if (!(location instanceof FlowVersionLocation)) {
      throw new Error("FlowVersionLocation is required for Version issue-log storage");
    }
    location.requireScope("canonical");
    location.assertAuthority(null, { mustExist: true });
    this.location = location;
    this.mainRoot = location.repositoryRoot;
    this.maintenanceOwnerToken = maintenanceOwnerToken;
    this.operationOwnerToken = operationOwnerToken;
    this.processIdentitySource = processIdentitySource;
    this.filePath = location.issueLogFile;
    this.relativeFilePath = location.relativeArtifact("issue.log");
    this.file = new AtomicJsonFile(this.filePath, { faultInjector });
    this.catalogStore = new FlowArtifactCatalogStore({ location });

    const versionAuthority = new RealDirectoryAuthority(location.directory, {
      errorFactory: (status, message, data) => issueLogError(status, message, data),
    });
    versionAuthority.ensure();
    const runtimeDirectory = location.resolve(".runtime");
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o755 });
    const runtimeAuthority = new RealDirectoryAuthority(runtimeDirectory, {
      parentAuthority: versionAuthority,
      errorFactory: (status, message, data) => issueLogError(status, message, data),
    });
    runtimeAuthority.ensure();
    const lockDirectory = location.resolve(".runtime/locks");
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o755 });
    const lockAuthority = new RealDirectoryAuthority(lockDirectory, {
      parentAuthority: runtimeAuthority,
      errorFactory: (status, message, data) => issueLogError(status, message, data),
    });
    lockAuthority.ensure();
    this.lock = new FileLock({
      directoryAuthority: lockAuthority,
      fileName: "issue-log.lock",
      kind: "issue-log-writer",
      authority: {
        versionRoot: location.directory,
        filePath: this.filePath,
        runtimeDirectory,
      },
      processIdentitySource,
      errorFactory: (status, message, data) => issueLogError(status, message, data),
      waitPolicy: new FileLockWaitPolicy({ timeoutMs: 5_000, intervalMs: 10 }),
    });
  }

  read() {
    return this.catalogStore.read({
      read: (catalog) => {
        if (fs.existsSync(this.filePath)) catalog.resolve("issue-log.json");
        return new IssueLogSnapshot(new IssueLogDocument(this.file.read({ entries: [] })));
      },
    });
  }

  append(entry, idempotencyKey) {
    return this.#withLock(() => this.#appendEntries([{ entry, idempotencyKey }]));
  }

  appendMany(entries) {
    if (!Array.isArray(entries)) throw new Error("issue-log appendMany entries must be an array");
    return this.#withLock(() => this.#appendEntries(entries));
  }

  #appendEntries(entries) {
    const snapshot = this.read();
    const appended = [];
    for (const item of entries) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("issue-log appendMany entries must contain entry objects");
      }
      const result = snapshot.document.append(item.entry, item.idempotencyKey);
      if (result.appended) appended.push(result.entry);
    }
    if (appended.length === 0) {
      return { appended, total: snapshot.document.entries.length, revision: revisionOf(snapshot.document) };
    }
    const runtime = new CanonicalFlowRuntime({
      repositoryRoot: this.location.repositoryRoot,
      executionRoot: this.location.repositoryRoot,
      specRoot: this.location.specRoot,
      definition: buildCurrentFlowDefinition(),
    });
    const specId = this.location.specId.toString();
    const state = runtime.load(specId);
    const nodeId = state.current?.at(-1) ?? null;
    if (nodeId === null) throw new Error("canonical issue-log append requires an active Flow leaf");
    runtime.publishArtifacts({
      specId,
      activityId: `issue-log-${crypto.randomUUID()}`,
      nodeId,
      artifactWrites: [{
        logicalKey: "issue.log",
        mediaType: "application/json",
        bytes: `${JSON.stringify(snapshot.document.toJSON(), null, 2)}\n`,
      }],
    });
    return { appended, total: snapshot.document.entries.length, revision: revisionOf(snapshot.document) };
  }

  #withLock(operation) {
    const repositoryOperation = new RepositoryFlowOperationLock({
      mainRoot: this.mainRoot,
      maintenanceOwnerToken: this.maintenanceOwnerToken,
      operationOwnerToken: this.operationOwnerToken,
      processIdentitySource: this.processIdentitySource,
    });
    repositoryOperation.acquire();
    let result;
    let primaryError;
    try {
      result = this.lock.runExclusive(operation);
    } catch (error) {
      primaryError = error;
    }
    let releaseError;
    try {
      repositoryOperation.release();
    } catch (error) {
      releaseError = error;
    }
    if (primaryError && releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        "issue-log operation and repository barrier release both failed",
        { cause: primaryError },
      );
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    return result;
  }
}
