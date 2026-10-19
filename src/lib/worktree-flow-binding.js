import { captureRegularFile } from "./regular-file-snapshot.js";
import { removeRegularFile } from "./regular-file-io.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority, sameFileIdentity as sameFile } from "./real-directory-authority.js";
import { PRODUCT } from "./product.js";

export const WORKTREE_FLOW_BINDING_FILE = PRODUCT.managedPath("flow-identity.json");
export const WORKTREE_FLOW_BINDING_PUBLICATION_RECEIPT_FILE = PRODUCT.managedPath(".flow-identity.publication.json");
export const WORKTREE_FLOW_BINDING_PUBLICATION_INTENT_FILE = PRODUCT.managedPath(".flow-identity.publication.intent");
export const WORKTREE_FLOW_BINDING_PUBLICATION_RECEIPT_TEMP_FILE = PRODUCT.managedPath(".flow-identity.publication.receipt.tmp");
export const WORKTREE_FLOW_BINDING_PUBLICATION_TEMP_FILE = PRODUCT.managedPath(".flow-identity.publication.binding.tmp");

const BINDING_VERSION = 2;
const BINDING_KEYS = Object.freeze(["version", "runId", "issue", "specId", "worktreePath"]);
const PUBLICATION_RECEIPT_VERSION = 1;
const PUBLICATION_RECEIPT_KEYS = Object.freeze([
  "version",
  "publicationId",
  "tempName",
  "size",
  "revision",
  "binding",
]);
const BINDING_LOCK_FILE = ".flow-identity.lock";
const MAX_BINDING_BYTES = 64 * 1024;
const MAX_RUN_ID_LENGTH = 200;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BINDING_PUBLICATION_TEMP_NAME = path.basename(WORKTREE_FLOW_BINDING_PUBLICATION_TEMP_FILE);

function canonicalDirectory(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error("worktree flow identity requires an absolute worktree path");
  }
  const resolved = path.resolve(input);
  if (resolved !== input) {
    throw new Error(`worktree flow identity path must be canonical: ${input}`);
  }
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(resolved);
    canonical = fs.realpathSync(resolved);
  } catch (cause) {
    throw new Error(`worktree flow identity path is unavailable: ${resolved}`, { cause });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolved) {
    throw new Error(`worktree flow identity path must be a real directory: ${resolved}`);
  }
  return canonical;
}

function normalizedSpecId(input) {
  try {
    return FlowSpecId.from(input).toString();
  } catch {
    throw new Error(`worktree flow identity specId is invalid: ${input}`);
  }
}

function normalizedIssue(input, source) {
  if (!Object.hasOwn(source, "issue")) {
    throw new Error("worktree flow identity issue field is required");
  }
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw new Error(`worktree flow identity issue must be a positive integer or null: ${input}`);
  }
  return input;
}

function assertCurrentBindingShape(value) {
  assertExactObjectKeys(value, BINDING_KEYS, "worktree flow binding");
  if (value.version !== BINDING_VERSION) {
    throw new Error(`unsupported worktree flow binding version: ${value.version}`);
  }
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields must be exactly: ${expectedKeys.join(", ")}`);
  }
}


function bindingRevision(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function unlinkSameFile({ filePath, expectedStat, expectedLinkCount = 1, faultInjector = () => {}, phase }) {
  return removeRegularFile(filePath, { expectedIdentity: expectedStat, expectedLinkCount, maxBytes: MAX_BINDING_BYTES,
    commitGuard: () => faultInjector({ phase, filePath }) });
}

export class WorktreeFlowIdentity {
  constructor(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("worktree flow identity input is required");
    }
    if (
      typeof input.runId !== "string"
      || input.runId.length > MAX_RUN_ID_LENGTH
      || !SAFE_RUN_ID.test(input.runId)
      || input.runId === "."
      || input.runId === ".."
    ) {
      throw new Error("worktree flow identity runId must be a safe non-empty identifier");
    }
    this.runId = input.runId;
    this.issue = normalizedIssue(input.issue, input);
    this.specId = normalizedSpecId(input.specId);
    this.worktreePath = canonicalDirectory(input.worktreePath);
    Object.freeze(this);
  }

  withIssue(issue) {
    return new WorktreeFlowIdentity({ ...this.toJSON(), issue });
  }

  equals(other) {
    return other instanceof WorktreeFlowIdentity
      && this.runId === other.runId
      && this.issue === other.issue
      && this.specId === other.specId
      && this.worktreePath === other.worktreePath;
  }

  assertFlowState(state) {
    if (!state || typeof state !== "object") {
      throw new Error("worktree flow binding did not resolve flow state");
    }
    // `issue.md` holds the immutable body, while the nullable Issue number is
    // part of the Flow identity needed to bind a worktree after restart.
    const stateIssue = state.issue ?? null;
    if (
      state.runId !== this.runId
      || stateIssue !== this.issue
      || state.specId !== this.specId
      || state.execution?.mode !== "worktree"
    ) {
      throw new Error(
        `worktree flow binding does not match flow state: expected ${this.runId}/${this.issue}/${this.specId}`,
      );
    }
    return state;
  }

  toJSON() {
    return {
      runId: this.runId,
      issue: this.issue,
      specId: this.specId,
      worktreePath: this.worktreePath,
    };
  }
}

export class WorktreeFlowProvenance {
  constructor(identity, stateAuthorityRoot) {
    if (!(identity instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree flow provenance identity is required");
    }
    this.identity = identity;
    this.stateAuthorityRoot = canonicalDirectory(stateAuthorityRoot);
    Object.freeze(this);
  }

  get stateUsesBindingAuthority() {
    return this.stateAuthorityRoot === this.identity.worktreePath;
  }

  assertState(state) {
    return this.identity.assertFlowState(state);
  }
}

export class WorktreeFlowBinding {
  constructor(identity) {
    if (!(identity instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree flow binding identity is required");
    }
    this.version = BINDING_VERSION;
    this.identity = identity;
    Object.freeze(this);
  }

  static fromJSON(value) {
    assertCurrentBindingShape(value);
    return new WorktreeFlowBinding(new WorktreeFlowIdentity(value));
  }

  toJSON() {
    return { version: this.version, ...this.identity.toJSON() };
  }
}

class WorktreeFlowBindingPublicationReceipt {
  constructor({ publicationId, tempName, size, revision, binding }) {
    if (typeof publicationId !== "string" || !SAFE_UUID.test(publicationId)) {
      throw new Error("worktree flow binding publication ID must be a UUID");
    }
    const expectedTempName = BINDING_PUBLICATION_TEMP_NAME;
    if (tempName !== expectedTempName || path.basename(tempName) !== tempName) {
      throw new Error("worktree flow binding publication temp name is invalid");
    }
    if (typeof revision !== "string" || !SHA256.test(revision)) {
      throw new Error("worktree flow binding publication revision must be SHA-256");
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BINDING_BYTES) {
      throw new Error("worktree flow binding publication size is invalid");
    }
    if (!(binding instanceof WorktreeFlowBinding)) {
      throw new Error("worktree flow binding publication identity is required");
    }
    this.version = PUBLICATION_RECEIPT_VERSION;
    this.publicationId = publicationId;
    this.tempName = tempName;
    this.size = size;
    this.revision = revision;
    this.binding = binding;
    Object.freeze(this);
  }

  static create(bytes, publicationId) {
    const binding = WorktreeFlowBinding.fromJSON(JSON.parse(bytes.toString("utf8")));
    return new WorktreeFlowBindingPublicationReceipt({
      publicationId,
      tempName: BINDING_PUBLICATION_TEMP_NAME,
      size: bytes.length,
      revision: bindingRevision(bytes),
      binding,
    });
  }

  static fromJSON(value) {
    assertExactObjectKeys(value, PUBLICATION_RECEIPT_KEYS, "worktree flow binding publication receipt");
    if (value.version !== PUBLICATION_RECEIPT_VERSION) {
      throw new Error(`unsupported worktree flow binding publication receipt version: ${value.version}`);
    }
    return new WorktreeFlowBindingPublicationReceipt({
      publicationId: value.publicationId,
      tempName: value.tempName,
      size: value.size,
      revision: value.revision,
      binding: WorktreeFlowBinding.fromJSON(value.binding),
    });
  }

  assertDocument(bytes, identity) {
    if (
      bytes.length !== this.size
      || bindingRevision(bytes) !== this.revision
      || !this.binding.identity.equals(identity)
    ) {
      throw new Error("worktree flow binding publication receipt does not match the published document");
    }
  }

  toJSON() {
    return {
      version: this.version,
      publicationId: this.publicationId,
      tempName: this.tempName,
      size: this.size,
      revision: this.revision,
      binding: this.binding.toJSON(),
    };
  }
}

class WorktreeFlowBindingSnapshot {
  constructor(identity, revision) {
    if (!(identity instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree flow binding snapshot identity is required");
    }
    if (typeof revision !== "string" || revision.length === 0) {
      throw new Error("worktree flow binding snapshot revision is required");
    }
    this.identity = identity;
    this.revision = revision;
    Object.freeze(this);
  }
}

class WorktreeFlowBindingPublicationJournal {
  constructor({ directoryAuthority, faultInjector }) {
    this.directoryAuthority = directoryAuthority;
    this.directory = directoryAuthority.directory;
    this.faultInjector = faultInjector;
    this.receiptPath = path.join(this.directory, path.basename(WORKTREE_FLOW_BINDING_PUBLICATION_RECEIPT_FILE));
    this.intentPath = path.join(this.directory, path.basename(WORKTREE_FLOW_BINDING_PUBLICATION_INTENT_FILE));
    this.receiptTempPath = path.join(
      this.directory,
      path.basename(WORKTREE_FLOW_BINDING_PUBLICATION_RECEIPT_TEMP_FILE),
    );
    this.bindingTempPath = path.join(this.directory, BINDING_PUBLICATION_TEMP_NAME);
  }

  publish(receipt) {
    const bytes = Buffer.from(`${JSON.stringify(receipt.toJSON(), null, 2)}\n`);
    this.directoryAuthority.assertStable();
    let intent = null;
    let stage = null;
    let receiptVisibleStat = null;
    const writer = new AtomicFile(this.receiptPath, { directoryAuthority: this.directoryAuthority,
      maxBytes: MAX_BINDING_BYTES, phaseNamespace: "binding-publication-receipt", faultInjector: this.faultInjector });
    try {
      this.faultInjector({ phase: "before-binding-publication-receipt-intent-mkdir", filePath: this.intentPath });
      intent = this.directoryAuthority.createExclusiveChild(path.basename(this.intentPath), { creationMode: 0o700 });
      this.faultInjector({ phase: "before-binding-publication-receipt-intent-readback", filePath: this.intentPath });
      intent.assertStable();
      stage = writer.createStage(bytes, { stageName: path.basename(this.receiptTempPath) });
      writer.publishStage(stage);
      receiptVisibleStat = stage.identity;
      intent.removeEmpty();
      return receiptVisibleStat;
    } catch (cause) {
      const cleanupErrors = [];
      if (stage !== null && stage.active && !cause.committedToVisibleName) {
        try { stage.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      if (receiptVisibleStat !== null) {
        try { unlinkSameFile({ filePath: this.receiptPath, expectedStat: receiptVisibleStat,
          faultInjector: this.faultInjector, phase: "before-binding-publication-receipt-cleanup-cas" }); }
        catch (error) { cleanupErrors.push(error); }
      }
      if (intent !== null && !cause.publicationUnknown) {
        try { intent.removeEmpty(); } catch (error) { if (error.cause?.code !== "ENOENT") cleanupErrors.push(error); }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([cause, ...cleanupErrors], "worktree flow binding receipt publication and cleanup both failed", { cause });
      throw cause;
    }
  }

  recoverIntent(validateReceipt) {
    const intent = this.#lstat(this.intentPath);
    const receiptTemp = this.#lstat(this.receiptTempPath);
    const receipt = this.#lstat(this.receiptPath);
    if (!intent) {
      if (receiptTemp) {
        throw new Error(`worktree flow binding has an unauthenticated receipt temp: ${this.receiptTempPath}`);
      }
      return;
    }
    if (
      !intent.isDirectory()
      || intent.isSymbolicLink()
      || fs.realpathSync(this.intentPath) !== this.intentPath
      || fs.readdirSync(this.intentPath).length !== 0
    ) {
      throw new Error(`worktree flow binding publication intent is invalid: ${this.intentPath}`);
    }
    if (receipt) {
      if (receiptTemp) {
        throw new Error("worktree flow binding receipt has both temp and visible authority");
      }
      validateReceipt();
      this.directoryAuthority.assertStable();
    } else if (receiptTemp) {
      if (
        !receiptTemp.isFile()
        || receiptTemp.isSymbolicLink()
        || receiptTemp.nlink !== 1
        || fs.realpathSync(this.receiptTempPath) !== this.receiptTempPath
      ) {
        throw new Error(`worktree flow binding receipt temp authority is invalid: ${this.receiptTempPath}`);
      }
      unlinkSameFile({
        filePath: this.receiptTempPath,
        expectedStat: receiptTemp,
        faultInjector: this.faultInjector,
        phase: "before-binding-publication-receipt-temp-cleanup-cas",
      });
    }
    if (!receipt && this.#lstat(this.bindingTempPath)) {
      throw new Error("binding temp exists before durable publication receipt");
    }
    new RealDirectoryAuthority(this.intentPath, { parentAuthority: this.directoryAuthority }).removeEmpty();
    this.directoryAuthority.assertStable();
  }

  removeReceipt(expectedStat) {
    if (!expectedStat) throw new Error("publication receipt cleanup requires inode authority");
    unlinkSameFile({
      filePath: this.receiptPath,
      expectedStat,
      faultInjector: this.faultInjector,
      phase: "before-binding-publication-receipt-unlink",
    });
    this.directoryAuthority.assertStable();
  }

  #lstat(target) {
    try {
      return fs.lstatSync(target);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
}

class WorktreeFlowBindingPublisher {
  constructor(filePath, directoryAuthority, faultInjector, phaseNamespace = "binding", journal = null) {
    this.filePath = filePath;
    this.directory = path.dirname(filePath);
    this.directoryAuthority = directoryAuthority;
    this.faultInjector = faultInjector;
    this.phaseNamespace = phaseNamespace;
    this.journal = journal;
  }

  create(bytes) {
    if (this.journal === null) throw new Error("worktree flow binding creation requires a publication receipt");
    const publicationId = crypto.randomUUID();
    const receipt = WorktreeFlowBindingPublicationReceipt.create(bytes, publicationId);
    const writer = new AtomicFile(this.filePath, { directoryAuthority: this.directoryAuthority,
      maxBytes: MAX_BINDING_BYTES, phaseNamespace: this.phaseNamespace,
      faultInjector: (event) => this.faultInjector(event.phase === `before-${this.phaseNamespace}-rename`
        ? { ...event, phase: `before-${this.phaseNamespace}-publish` } : event) });
    let receiptStat = null;
    let stage = null;
    let published = false;
    try {
      receiptStat = this.journal.publish(receipt);
      stage = writer.createStage(bytes, { stageName: path.basename(this.journal.bindingTempPath), exclusive: true });
      writer.publishStage(stage, { exclusive: true });
      published = true;
      this.journal.removeReceipt(receiptStat);
    } catch (cause) {
      published ||= stage !== null && cause.committedToVisibleName === true;
      const cleanupErrors = [];
      const tempRemains = fs.existsSync(this.journal.bindingTempPath);
      // A receipt survives unconfirmed publication and any incomplete stage
      // cleanup so restart can classify the exact saved generation.
      if (receiptStat !== null && !tempRemains && !cause.publicationUnknown) {
        try { this.journal.removeReceipt(receiptStat); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([cause, ...cleanupErrors], `worktree flow binding publication and cleanup failed: ${this.filePath}`, { cause });
      cause.committed = published;
      throw cause;
    }
  }

  replace(bytes) {
    return new AtomicFile(this.filePath, {
      faultInjector: this.faultInjector,
      phaseNamespace: this.phaseNamespace,
    }).write(bytes);
  }

  remove() {
    return new AtomicFile(this.filePath, {
      faultInjector: this.faultInjector,
      phaseNamespace: this.phaseNamespace,
    }).remove();
  }
}

export class WorktreeFlowBindingStore {
  constructor({ worktreePath, faultInjector = () => {}, processIdentitySource } = {}) {
    this.worktreePath = canonicalDirectory(worktreePath);
    this.path = path.join(this.worktreePath, WORKTREE_FLOW_BINDING_FILE);
    this.publicationReceiptPath = path.join(
      this.worktreePath,
      WORKTREE_FLOW_BINDING_PUBLICATION_RECEIPT_FILE,
    );
    this.faultInjector = faultInjector;
    const rootAuthority = new RealDirectoryAuthority(this.worktreePath);
    this.directoryAuthority = new RealDirectoryAuthority(path.dirname(this.path), {
      create: true,
      parentAuthority: rootAuthority,
    });
    this.directoryAuthority.ensure();
    this.publicationJournal = new WorktreeFlowBindingPublicationJournal({
      directoryAuthority: this.directoryAuthority,
      faultInjector: this.faultInjector,
    });
    this.publisher = new WorktreeFlowBindingPublisher(
      this.path,
      this.directoryAuthority,
      this.faultInjector,
      "binding",
      this.publicationJournal,
    );
    this.lock = new FileLock({
      directoryAuthority: this.directoryAuthority,
      fileName: BINDING_LOCK_FILE,
      kind: "worktree-flow-binding",
      authority: { worktreePath: this.worktreePath, bindingPath: this.path },
      ...(processIdentitySource && { processIdentitySource }),
    });
  }

  get exists() {
    try {
      fs.lstatSync(this.path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  withLock(body) {
    return this.lock.runExclusive(() => {
      this.publicationJournal.recoverIntent(() => this.#readPublicationReceipt());
      this.#recoverInitialPublication();
      return body(this.lock.processIdentity.ownerToken);
    });
  }

  load() {
    return this.withLock(() => this.loadOwned().identity);
  }

  loadOwned() {
    return this.#readSnapshot();
  }

  save(identity) {
    if (!(identity instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree flow binding identity is required");
    }
    return this.withLock(() => {
      this.#assertPath(identity);
      if (this.exists) {
        const existing = this.loadOwned().identity;
        if (existing.equals(identity)) return existing;
        throw new Error(`conflicting worktree flow binding already exists: ${this.path}`);
      }
      this.publisher.create(this.#serialize(identity));
      const published = this.loadOwned().identity;
      if (!published.equals(identity)) {
        throw new Error(`worktree flow binding readback mismatch: ${this.path}`);
      }
      return published;
    });
  }

  replace(expected, next, ownerToken) {
    if (!(expected instanceof WorktreeFlowIdentity) || !(next instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree flow binding replacement identities are required");
    }
    this.#assertOwner(ownerToken, "replacement");
    this.#assertPath(expected);
    this.#assertPath(next);
    const current = this.loadOwned();
    if (!current.identity.equals(expected)) {
      const error = new Error("worktree flow binding changed concurrently");
      error.code = "WORKTREE_FLOW_BINDING_REVISION_CONFLICT";
      throw error;
    }
    this.publisher.replace(this.#serialize(next));
    const published = this.loadOwned().identity;
    if (!published.equals(next)) {
      throw new Error(`worktree flow binding replacement readback mismatch: ${this.path}`);
    }
    return published;
  }

  remove() {
    return this.withLock(() => {
      if (!this.exists) return;
      this.loadOwned();
      this.publisher.remove();
    });
  }

  #assertPath(identity) {
    if (identity.worktreePath !== this.worktreePath) {
      throw new Error(
        `worktree flow binding path mismatch: ${identity.worktreePath} != ${this.worktreePath}`,
      );
    }
  }

  #assertOwner(ownerToken, operation) {
    if (ownerToken !== this.lock.processIdentity?.ownerToken) {
      throw new Error(`worktree flow binding ${operation} requires transaction ownership`);
    }
  }

  #serialize(identity) {
    return Buffer.from(`${JSON.stringify(new WorktreeFlowBinding(identity).toJSON(), null, 2)}\n`);
  }

  #readSnapshot() {
    const { bytes, value } = this.#readDocument(
      this.path,
      "worktree flow binding",
      "binding",
    );
    const identity = WorktreeFlowBinding.fromJSON(value).identity;
    this.#assertPath(identity);
    return new WorktreeFlowBindingSnapshot(identity, bindingRevision(bytes));
  }

  #recoverInitialPublication() {
    let receiptStat;
    try {
      receiptStat = fs.lstatSync(this.publicationReceiptPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!receiptStat.isFile()) {
      throw new Error(`worktree flow binding publication receipt must be a regular file: ${this.publicationReceiptPath}`);
    }
    const receiptSnapshot = this.#readPublicationReceiptSnapshot();
    const { receipt } = receiptSnapshot;
    const tempPath = path.join(path.dirname(this.path), receipt.tempName);
    const visible = this.#lstatOptional(this.path);
    const temp = this.#lstatOptional(tempPath);

    if (visible && temp) {
      if (!sameFile(visible, temp) || visible.nlink !== 2 || temp.nlink !== 2) {
        throw new Error("worktree flow binding publication names do not have exact two-link authority");
      }
      const document = this.#readPublicationDocument(this.path, receipt, 2);
      const currentTemp = fs.lstatSync(tempPath);
      if (!sameFile(document.stat, currentTemp) || currentTemp.nlink !== 2) {
        throw new Error("worktree flow binding publication temp changed before adoption");
      }
      unlinkSameFile({
        filePath: tempPath,
        expectedStat: document.stat,
        expectedLinkCount: 2,
        faultInjector: this.faultInjector,
        phase: "before-binding-publication-temp-cleanup-cas",
      });
      this.directoryAuthority.assertStable();
      this.#readPublicationDocument(this.path, receipt);
    } else if (visible) {
      this.#readPublicationDocument(this.path, receipt);
      this.directoryAuthority.assertStable();
    } else if (temp) {
      const document = this.#readIncompletePublicationDocument(tempPath, receipt);
      unlinkSameFile({
        filePath: tempPath,
        expectedStat: document.stat,
        faultInjector: this.faultInjector,
        phase: "before-binding-publication-temp-cleanup-cas",
      });
      this.directoryAuthority.assertStable();
    } else {
      this.directoryAuthority.assertStable();
    }
    this.publicationJournal.removeReceipt(receiptSnapshot.stat);
  }

  #readPublicationReceipt() {
    return this.#readPublicationReceiptSnapshot().receipt;
  }

  #readPublicationReceiptSnapshot() {
    const { value, stat } = this.#readDocument(
      this.publicationReceiptPath,
      "worktree flow binding publication receipt",
      "binding-publication-receipt",
    );
    const receipt = WorktreeFlowBindingPublicationReceipt.fromJSON(value);
    this.#assertPath(receipt.binding.identity);
    return { receipt, stat };
  }

  #readIncompletePublicationDocument(filePath, receipt) {
    const expected = this.#serialize(receipt.binding.identity);
    if (expected.length !== receipt.size || bindingRevision(expected) !== receipt.revision) throw new Error("worktree flow binding receipt byte authority is invalid");
    const snapshot = captureRegularFile(filePath, { label: "worktree flow binding incomplete temp", maxBytes: receipt.size,
      requireSingleLink: true, directoryAuthority: this.directoryAuthority });
    if (!snapshot.bytes.equals(expected.subarray(0, snapshot.byteLength))) throw new Error("worktree flow binding incomplete temp size/hash authority changed");
    return { bytes: snapshot.bytes, stat: snapshot.identity };
  }

  #readPublicationDocument(filePath, receipt, expectedLinkCount = 1) {
    const document = this.#readDocument(
      filePath,
      "worktree flow binding publication document",
      "binding-publication",
      expectedLinkCount,
    );
    const identity = WorktreeFlowBinding.fromJSON(document.value).identity;
    this.#assertPath(identity);
    receipt.assertDocument(document.bytes, identity);
    return document;
  }

  #lstatOptional(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #readDocument(filePath, label, phaseNamespace, expectedLinkCount = 1) {
    let value;
    let snapshot;
    try {
      snapshot = captureRegularFile(filePath, { label, maxBytes: MAX_BINDING_BYTES, expectedLinkCount,
        directoryAuthority: this.directoryAuthority, faultInjector: this.faultInjector, phaseNamespace,
        validateSnapshot(candidate) {
          try { value = JSON.parse(candidate.text()); }
          catch (cause) { throw new Error(`${label} is invalid JSON: ${filePath}: ${cause.message}`, { cause }); }
        } });
    } catch (cause) {
      if (cause.code === "ENOENT") throw new Error(`${label} not found: ${filePath}`, { cause });
      throw cause;
    }
    return { bytes: snapshot.bytes, value, stat: snapshot.identity };
  }

}
