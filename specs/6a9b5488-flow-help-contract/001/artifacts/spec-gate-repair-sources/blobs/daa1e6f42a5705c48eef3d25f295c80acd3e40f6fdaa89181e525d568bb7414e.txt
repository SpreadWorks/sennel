import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function bindingRevision(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  let primary = null;
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    primary = error;
  }
  try {
    fs.closeSync(descriptor);
  } catch (cleanupError) {
    if (primary) {
      throw new AggregateError(
        [primary, cleanupError],
        `worktree flow binding directory sync and close both failed: ${directory}`,
        { cause: primary },
      );
    }
    throw cleanupError;
  }
  if (primary) throw primary;
}

function unlinkSameFile({
  filePath,
  expectedStat,
  expectedLinkCount = 1,
  faultInjector = () => {},
  phase,
}) {
  let descriptor = null;
  try {
    const visible = fs.lstatSync(filePath);
    if (
      !visible.isFile()
      || visible.isSymbolicLink()
      || visible.nlink !== expectedLinkCount
      || !sameFile(visible, expectedStat)
      || fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error(`publication cleanup authority changed before open: ${filePath}`);
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(visible, opened) || opened.nlink !== expectedLinkCount) {
      throw new Error(`publication cleanup authority changed while opening: ${filePath}`);
    }
    faultInjector({ phase, filePath });
    const current = fs.lstatSync(filePath);
    if (!sameFile(opened, current) || current.nlink !== expectedLinkCount) {
      throw new Error(`publication cleanup inode CAS failed: ${filePath}`);
    }
    fs.unlinkSync(filePath);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function readBoundedDescriptor(descriptor, filePath) {
  const chunks = [];
  let total = 0;
  while (total <= MAX_BINDING_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, MAX_BINDING_BYTES + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > MAX_BINDING_BYTES) {
    throw new Error(`worktree flow binding exceeds ${MAX_BINDING_BYTES} bytes: ${filePath}`);
  }
  return Buffer.concat(chunks, total);
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
    let descriptor = null;
    let mutated = false;
    let intentOwned = false;
    let receiptTempOwned = false;
    let receiptVisibleOwned = false;
    let receiptTempStat = null;
    let receiptVisibleStat = null;
    try {
      this.faultInjector({ phase: "before-binding-publication-receipt-intent-mkdir", filePath: this.intentPath });
      fs.mkdirSync(this.intentPath, { mode: 0o700 });
      intentOwned = true;
      mutated = true;
      this.faultInjector({ phase: "before-binding-publication-receipt-intent-directory-fsync", filePath: this.intentPath });
      fsyncDirectory(this.directory);
      this.faultInjector({
        phase: "before-binding-publication-receipt-temp-open",
        filePath: this.receiptPath,
        tempPath: this.receiptTempPath,
      });
      descriptor = fs.openSync(this.receiptTempPath, "wx", 0o600);
      receiptTempOwned = true;
      receiptTempStat = fs.fstatSync(descriptor);
      this.faultInjector({
        phase: "before-binding-publication-receipt-temp-write",
        filePath: this.receiptPath,
        tempPath: this.receiptTempPath,
      });
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, 0o600);
      this.faultInjector({
        phase: "before-binding-publication-receipt-fsync",
        filePath: this.receiptPath,
        tempPath: this.receiptTempPath,
      });
      fs.fsyncSync(descriptor);
      this.faultInjector({
        phase: "before-binding-publication-receipt-temp-close",
        filePath: this.receiptPath,
        tempPath: this.receiptTempPath,
      });
      fs.closeSync(descriptor);
      descriptor = null;
      this.directoryAuthority.assertStable();
      this.faultInjector({
        phase: "before-binding-publication-receipt-rename",
        filePath: this.receiptPath,
        tempPath: this.receiptTempPath,
      });
      fs.renameSync(this.receiptTempPath, this.receiptPath);
      receiptTempOwned = false;
      receiptVisibleOwned = true;
      receiptVisibleStat = fs.lstatSync(this.receiptPath);
      this.faultInjector({
        phase: "before-binding-publication-receipt-directory-fsync",
        filePath: this.receiptPath,
      });
      fsyncDirectory(this.directory);
      fs.rmdirSync(this.intentPath);
      intentOwned = false;
      fsyncDirectory(this.directory);
      return receiptVisibleStat;
    } catch (cause) {
      const cleanupErrors = [];
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      for (const [target, owned, expectedStat, phase] of [
        [
          this.receiptTempPath,
          receiptTempOwned,
          receiptTempStat,
          "before-binding-publication-receipt-temp-cleanup-cas",
        ],
        [
          this.receiptPath,
          receiptVisibleOwned,
          receiptVisibleStat,
          "before-binding-publication-receipt-cleanup-cas",
        ],
      ]) {
        if (!owned) continue;
        try {
          unlinkSameFile({
            filePath: target,
            expectedStat,
            faultInjector: this.faultInjector,
            phase,
          });
        } catch (error) {
          if (error.code !== "ENOENT") cleanupErrors.push(error);
        }
      }
      if (intentOwned) {
        try { fs.rmdirSync(this.intentPath); } catch (error) {
          if (error.code !== "ENOENT") cleanupErrors.push(error);
        }
      }
      if (mutated) {
        try { fsyncDirectory(this.directory); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupErrors],
          "worktree flow binding receipt publication and cleanup both failed",
          { cause },
        );
      }
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
      fsyncDirectory(this.directory);
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
    fs.rmdirSync(this.intentPath);
    fsyncDirectory(this.directory);
  }

  removeReceipt(expectedStat) {
    if (!expectedStat) throw new Error("publication receipt cleanup requires inode authority");
    unlinkSameFile({
      filePath: this.receiptPath,
      expectedStat,
      faultInjector: this.faultInjector,
      phase: "before-binding-publication-receipt-unlink",
    });
    fsyncDirectory(this.directory);
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
    if (this.journal == null) {
      throw new Error("worktree flow binding creation requires a publication receipt");
    }
    this.directoryAuthority.assertStable();
    const publicationId = crypto.randomUUID();
    const tempPath = this.journal.bindingTempPath;
    const receipt = WorktreeFlowBindingPublicationReceipt.create(bytes, publicationId);
    let descriptor = null;
    let published = false;
    let receiptPublished = false;
    let receiptStat = null;
    let tempOwned = false;
    let tempStat = null;
    try {
      receiptStat = this.journal.publish(receipt);
      receiptPublished = true;
      this.faultInjector({ phase: `before-${this.phaseNamespace}-temp-open`, filePath: this.filePath, tempPath });
      descriptor = fs.openSync(tempPath, "wx", 0o600);
      tempOwned = true;
      tempStat = fs.fstatSync(descriptor);
      this.faultInjector({ phase: `before-${this.phaseNamespace}-temp-write`, filePath: this.filePath, tempPath });
      const partialLength = Math.max(1, Math.floor(bytes.length / 2));
      fs.writeSync(descriptor, bytes, 0, partialLength, null);
      this.faultInjector({
        phase: `after-${this.phaseNamespace}-temp-partial-write`,
        filePath: this.filePath,
        tempPath,
      });
      fs.writeSync(descriptor, bytes, partialLength, bytes.length - partialLength, null);
      fs.fchmodSync(descriptor, 0o600);
      this.faultInjector({ phase: `before-${this.phaseNamespace}-fsync`, filePath: this.filePath, tempPath });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      this.directoryAuthority.assertStable();
      this.faultInjector({ phase: `before-${this.phaseNamespace}-publish`, filePath: this.filePath, tempPath });
      fs.linkSync(tempPath, this.filePath);
      published = true;
      unlinkSameFile({
        filePath: tempPath,
        expectedStat: tempStat,
        expectedLinkCount: 2,
        faultInjector: this.faultInjector,
        phase: `before-${this.phaseNamespace}-temp-unlink`,
      });
      tempOwned = false;
      this.faultInjector({ phase: `before-${this.phaseNamespace}-directory-fsync`, filePath: this.filePath });
      fsyncDirectory(this.directory);
      this.journal.removeReceipt(receiptStat);
      receiptPublished = false;
    } catch (cause) {
      const cleanupErrors = [];
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      let tempSettled = !tempOwned;
      if (tempOwned) {
        try {
          unlinkSameFile({
            filePath: tempPath,
            expectedStat: tempStat,
            expectedLinkCount: published ? 2 : 1,
            faultInjector: this.faultInjector,
            phase: "before-binding-publication-temp-cleanup-cas",
          });
          tempSettled = true;
        } catch (error) {
          if (error.code === "ENOENT") tempSettled = true;
          if (error.code !== "ENOENT") cleanupErrors.push(error);
        }
      }
      if (receiptPublished && tempSettled) {
        try {
          fsyncDirectory(this.directory);
          this.journal.removeReceipt(receiptStat);
          receiptPublished = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupErrors],
          `worktree flow binding publication and cleanup failed: ${this.filePath}`,
          { cause },
        );
      }
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
      fsyncDirectory(path.dirname(this.path));
      this.#readPublicationDocument(this.path, receipt);
    } else if (visible) {
      this.#readPublicationDocument(this.path, receipt);
      fsyncDirectory(path.dirname(this.path));
    } else if (temp) {
      const document = this.#readIncompletePublicationDocument(tempPath, receipt);
      unlinkSameFile({
        filePath: tempPath,
        expectedStat: document.stat,
        faultInjector: this.faultInjector,
        phase: "before-binding-publication-temp-cleanup-cas",
      });
      fsyncDirectory(path.dirname(this.path));
    } else {
      fsyncDirectory(path.dirname(this.path));
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
    if (expected.length !== receipt.size || bindingRevision(expected) !== receipt.revision) {
      throw new Error("worktree flow binding receipt byte authority is invalid");
    }
    this.directoryAuthority.assertStable();
    const visible = fs.lstatSync(filePath);
    if (
      !visible.isFile()
      || visible.isSymbolicLink()
      || visible.nlink !== 1
      || visible.size > receipt.size
      || fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error("worktree flow binding incomplete temp authority is invalid");
    }
    let descriptor = null;
    try {
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      if (!sameFile(visible, opened) || opened.nlink !== 1 || opened.size > receipt.size) {
        throw new Error("worktree flow binding incomplete temp changed while opening");
      }
      const bytes = readBoundedDescriptor(descriptor, filePath);
      const after = fs.fstatSync(descriptor);
      const current = fs.lstatSync(filePath);
      if (
        !sameFile(opened, after)
        || !sameFile(opened, current)
        || after.nlink !== 1
        || current.nlink !== 1
        || after.size !== bytes.length
        || !bytes.equals(expected.subarray(0, bytes.length))
      ) {
        throw new Error("worktree flow binding incomplete temp size/hash authority changed");
      }
      return { bytes, stat: opened };
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
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
    this.directoryAuthority.assertStable();
    let visible;
    try {
      visible = fs.lstatSync(filePath);
    } catch (cause) {
      if (cause.code === "ENOENT") throw new Error(`${label} not found: ${filePath}`, { cause });
      throw cause;
    }
    if (
      !visible.isFile()
      || visible.isSymbolicLink()
      || visible.nlink !== expectedLinkCount
      || visible.size > MAX_BINDING_BYTES
      || fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error(`${label} must be one bounded regular file with real non-hardlinked authority: ${filePath}`);
    }
    let descriptor = null;
    try {
      this.faultInjector({ phase: `before-${phaseNamespace}-read-open`, filePath });
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.nlink !== expectedLinkCount
        || opened.size > MAX_BINDING_BYTES
        || !sameFile(visible, opened)
      ) {
        throw new Error(`${label} changed while opening: ${filePath}`);
      }
      this.faultInjector({ phase: `before-${phaseNamespace}-read`, filePath });
      const bytes = readBoundedDescriptor(descriptor, filePath);
      const afterRead = fs.fstatSync(descriptor);
      if (!sameFile(opened, afterRead) || afterRead.nlink !== expectedLinkCount || afterRead.size !== bytes.length) {
        throw new Error(`${label} changed while reading: ${filePath}`);
      }
      const afterVisible = fs.lstatSync(filePath);
      if (!sameFile(opened, afterVisible) || afterVisible.nlink !== expectedLinkCount) {
        throw new Error(`${label} visible authority changed while reading: ${filePath}`);
      }
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch (cause) {
        throw new Error(`${label} is invalid JSON: ${filePath}: ${cause.message}`, { cause });
      }
      return { bytes, value, stat: opened };
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }
}
