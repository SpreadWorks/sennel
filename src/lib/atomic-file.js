import { closeFileDescriptor } from "./file-descriptor.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { captureRegularFile, FilePermissionHint, MAX_IN_MEMORY_FILE_BYTES, RegularFileReadReceipt, RegularFileSnapshot, RegularFileCaptureRequest, RegularFileSnapshotGroup, visitRegularFileChunks } from "./regular-file-snapshot.js";

const stages = new WeakMap();
const stageToken = Symbol("owned atomic stage");

export class AtomicFilePublication {
  #snapshot;
  #receipt;
  constructor({ committed, path: filePath, snapshot = null, receipt = null }) {
    if (typeof committed !== "boolean" || !path.isAbsolute(filePath)
      || (snapshot !== null && !(snapshot instanceof RegularFileSnapshot))
      || (receipt !== null && !(receipt instanceof RegularFileReadReceipt))
      || (snapshot !== null && receipt !== null)) {
      throw new TypeError("atomic file publication requires a commit flag, absolute path and optional captured snapshot");
    }
    this.committed = committed;
    this.path = filePath;
    this.#snapshot = snapshot;
    this.#receipt = receipt;
    Object.freeze(this);
  }
  get snapshot() { return this.#snapshot; }
  get receipt() { return this.#receipt; }
  toJSON() { return { committed: this.committed, path: this.path }; }
}

export class AtomicFileWriteError extends AggregateError {
  constructor(message, { cause, phase, committedToVisibleName = false, publicationUnknown = false, cleanupErrors = [], retainedOutput = null }) {
    super([cause, ...cleanupErrors], message, { cause });
    this.name = "AtomicFileWriteError";
    this.code = publicationUnknown ? "ATOMIC_FILE_PUBLICATION_UNCERTAIN" : "ATOMIC_FILE_WRITE_FAILED";
    this.phase = phase;
    this.committedToVisibleName = committedToVisibleName;
    this.publicationUnknown = publicationUnknown;
    this.cleanupFailed = cleanupErrors.length > 0 || cause?.cleanupFailed === true;
    this.cleanupErrors = cleanupErrors;
    if (retainedOutput !== null) this.retainedOutput = retainedOutput;
    this.committed = committedToVisibleName;
  }
}

/** A closed same-directory file whose ownership cannot be reconstructed from a path. */
export class OwnedAtomicFileStage {
  constructor(token, writer, stagePath, identity, baseline) {
    if (token !== stageToken) throw new Error("atomic stages must be created by AtomicFile");
    this.path = stagePath;
    stages.set(this, { writer, identity, baseline, snapshot: null, adopted: false, consumed: false });
    Object.freeze(this);
  }
  dispose() { return stages.get(this).writer.disposeStage(this); }
  get identity() { return stages.get(this).identity; }
  get active() { return !stages.get(this).consumed; }
}

/** Unpublished output still borrowed by a producer whose completion is unknown. */
export class RetainedAtomicFileOutput {
  #stage;
  #descriptor;
  constructor(token, stage, descriptor) {
    if (token !== stageToken || !(stage instanceof OwnedAtomicFileStage) || !Number.isInteger(descriptor)) {
      throw new TypeError("Retained output requires its minted stage and borrowed descriptor");
    }
    this.#stage = stage;
    this.#descriptor = descriptor;
    Object.freeze(this);
  }
  get path() { return this.#stage.path; }
  toJSON() { return { path: this.path, descriptorRetained: this.#descriptor !== null }; }
}

export class AtomicFile {
  constructor(filePath, {
    faultInjector = () => {}, phaseNamespace = "file", commitGuard = () => {},
    maxBytes = MAX_IN_MEMORY_FILE_BYTES, directoryAuthority = null, permissionHint = null,
  } = {}) {
    if (typeof phaseNamespace !== "string" || phaseNamespace.trim() === "") throw new Error("atomic file phase namespace must be a non-empty string");
    if (typeof commitGuard !== "function") throw new TypeError("atomic file commitGuard must be a function");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) throw new TypeError("atomic file maxBytes must be a non-negative safe integer");
    if (permissionHint !== null && !(permissionHint instanceof FilePermissionHint)) throw new TypeError("atomic file permissionHint must be native permission metadata");
    this.permissionHint = permissionHint;
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.directoryAuthority = directoryAuthority ?? new RealDirectoryAuthority(this.directory);
    if (!(this.directoryAuthority instanceof RealDirectoryAuthority) || this.directoryAuthority.directory !== this.directory) {
      throw new Error("atomic file authority must own its direct parent");
    }
    this.faultInjector = faultInjector;
    this.phaseNamespace = phaseNamespace;
    this.commitGuard = commitGuard;
    this.maxBytes = maxBytes;
  }

  #captureOptions(maxBytes, allowMissing) {
    return { label: "file authority", maxBytes,
      requireSingleLink: true, directoryAuthority: this.directoryAuthority, allowMissing };
  }

  #capture(filePath = this.filePath, maxBytes = this.maxBytes, allowMissing = false, streaming = false) {
    const options = { ...this.#captureOptions(maxBytes, allowMissing), allowMissingDirectory: allowMissing };
    return streaming ? visitRegularFileChunks(filePath, { ...options, visit() {} }) : captureRegularFile(filePath, options);
  }

  /** Read-only group; every direct parent must exist. No partial results escape. */
  static readSnapshots(files) {
    files = [...files];
    if (files.some(file => !(file instanceof AtomicFile))) throw new TypeError("Atomic snapshot group requires AtomicFiles");
    return RegularFileSnapshotGroup.capture(files.map(file =>
      new RegularFileCaptureRequest(file.filePath, file.#captureOptions(file.maxBytes, true))));
  }

  /** Compare every file in one fresh forest, retaining only prior snapshots. */
  static snapshotsMatch(files) {
    files = new Map(files);
    if ([...files.keys()].some(file => !(file instanceof AtomicFile))) throw new TypeError("Atomic snapshot comparison requires AtomicFiles");
    return RegularFileSnapshotGroup.matches([...files.keys()].map(file =>
      new RegularFileCaptureRequest(file.filePath, file.#captureOptions(file.maxBytes, true))),
    new Map([...files].map(([file, snapshot]) => [file.filePath, snapshot])));
  }

  #baseline(streaming = false) {
    return this.#capture(this.filePath, this.maxBytes, true, streaming);
  }

  #assertBaseline(expected, streaming = expected instanceof RegularFileReadReceipt) {
    const actual = this.#baseline(streaming);
    if ((expected === null) !== (actual === null)
      || (expected !== null && !expected.hasSameFileVersion(actual))) {
      throw new Error(`visible file changed before commit: ${this.filePath}`);
    }
  }

  #event(suffix, stage = null) {
    const event = { phase: `before-${this.phaseNamespace}-${suffix}`, filePath: this.filePath };
    if (stage !== null) event.tempPath = stage.path;
    this.faultInjector(event);
    return event;
  }

  read(fallback = null) {
    const snapshot = this.readSnapshot();
    return snapshot === null ? (Buffer.isBuffer(fallback) ? Buffer.from(fallback) : fallback) : snapshot.bytes;
  }

  readSnapshot() { return this.#baseline(); }

  createStage(content = Buffer.alloc(0), { stageName = null, exclusive = false } = {}) {
    const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : typeof content === "string" ? Buffer.from(content) : null;
    if (bytes === null) throw new TypeError("atomic file content must be a Buffer or string");
    if (bytes.length > this.maxBytes) throw new Error(`atomic file content exceeds ${this.maxBytes} bytes`);
    return this.#createStage({ bytes, stageName, exclusive });
  }

  /** A synchronous child producer borrows the owned descriptor until it returns. */
  createOutputStage(producer, { stageName = null, exclusive = false } = {}) {
    if (typeof producer !== "function") throw new TypeError("atomic output producer must be a synchronous function");
    return this.#createStage({ producer, stageName, exclusive });
  }

  #createStage({ bytes = null, producer = null, stageName, exclusive }) {
    const streaming = producer !== null;
    let producerPending = false;
    let descriptor = null;
    let stage = null;
    let phase = "inspect-visible-file";
    if (stageName !== null && (typeof stageName !== "string" || path.basename(stageName) !== stageName || stageName === "." || stageName === ".." || stageName === "" || stageName === path.basename(this.filePath))) throw new Error("atomic stage name must be a distinct basename");
    const tempPath = path.join(this.directory, stageName ?? `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      this.directoryAuthority.assertStable();
      const baseline = exclusive ? null : this.#baseline(streaming);
      if (exclusive && streaming) this.#assertAbsent();
      phase = `before-${this.phaseNamespace}-temp-open`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      this.directoryAuthority.assertStable();
      descriptor = fs.openSync(tempPath, "wx+", 0o600);
      stage = new OwnedAtomicFileStage(stageToken, this, tempPath, new FileIdentity(fs.fstatSync(descriptor, { bigint: true })), baseline);
      phase = `before-${this.phaseNamespace}-temp-write`;
      this.#event("temp-write", stage);
      if (this.permissionHint !== null) {
        phase = `before-${this.phaseNamespace}-permissions`;
        this.#event("permissions", stage);
        this.permissionHint.applyToDescriptor(descriptor);
      }
      phase = `before-${this.phaseNamespace}-temp-write`;
      if (streaming) {
        producerPending = true;
        const produced = producer(descriptor);
        if (produced?.then instanceof Function) throw new TypeError("atomic output producer must complete synchronously");
        producerPending = false;
      } else {
        let offset = 0;
        const partialLength = Math.max(1, Math.floor(bytes.length / 2));
        let partialReported = false;
        while (offset < bytes.length) {
          const length = partialReported ? bytes.length - offset : Math.min(bytes.length - offset, partialLength - offset);
          const written = fs.writeSync(descriptor, bytes, offset, length, offset);
          if (written === 0) throw new Error("atomic file stage write made no progress");
          offset += written;
          if (!partialReported && offset === partialLength) {
            partialReported = true;
            phase = `after-${this.phaseNamespace}-temp-partial-write`;
            this.faultInjector({ phase, filePath: this.filePath, tempPath });
          }
        }
      }
      phase = `before-${this.phaseNamespace}-fsync`;
      this.#event("fsync", stage);
      fs.fsyncSync(descriptor);
      phase = `before-${this.phaseNamespace}-temp-close`;
      this.#event("temp-close", stage);
      fs.closeSync(descriptor);
      descriptor = null;
      const snapshot = this.#capture(tempPath, this.maxBytes, false, streaming);
      if (!sameFileIdentity(stages.get(stage).identity, snapshot.identity) || (!streaming && !snapshot.bytes.equals(bytes))
        || (this.permissionHint !== null && !this.permissionHint.matchesAfterWrite(snapshot.permissionHint))) {
        throw new Error("atomic file stage changed while writing");
      }
      stages.get(stage).snapshot = snapshot;
      stages.get(stage).adopted = streaming;
      return stage;
    } catch (cause) {
      const cleanupErrors = [];
      const retainedOutput = producerPending && this.retainOutputOnFailure(cause)
        ? new RetainedAtomicFileOutput(stageToken, stage, descriptor) : null;
      if (retainedOutput === null) {
        if (descriptor !== null) {
          try { fs.closeSync(descriptor); descriptor = null; } catch (error) { cleanupErrors.push(error); }
        }
        if (stage !== null && descriptor === null && !cause.cleanupFailed) {
          try { this.disposeStage(stage); } catch (error) { cleanupErrors.push(error); }
        }
      }
      throw this.createWriteError(cause.message, { cause, phase, cleanupErrors, retainedOutput });
    }
  }

  #state(stage) {
    const state = stages.get(stage);
    if (!state || state.writer !== this || state.consumed) throw new Error("atomic file stage must be owned, unpublished and in the target directory");
    this.directoryAuthority.assertStable();
    return state;
  }

  #inspectStage(stage, state) {
    const expected = state.snapshot;
    const current = this.#capture(stage.path, this.maxBytes, false, expected instanceof RegularFileReadReceipt);
    if (!sameFileIdentity(state.identity, current.identity) || expected.byteLength !== current.byteLength || expected.digest !== current.digest
      || !expected.permissionHint.matches(current.permissionHint)) throw new Error("atomic file stage changed before publication");
    return current;
  }

  inspectStage(stage) { return this.#inspectStage(stage, this.#state(stage)); }

  adoptStage(stage, { maxBytes = this.maxBytes } = {}) {
    const state = this.#state(stage);
    if (state.adopted) throw new Error("atomic file stage output is already sealed");
    if (maxBytes > this.maxBytes) throw new Error("atomic stage adoption cannot exceed the target byte limit");
    const snapshot = this.#capture(stage.path, maxBytes);
    if (!sameFileIdentity(state.identity, snapshot.identity)) throw new Error("atomic file stage identity changed");
    let descriptor = null;
    let failure = null;
    try {
      descriptor = fs.openSync(stage.path, "r+");
      if (!sameFileIdentity(state.identity, fs.fstatSync(descriptor, { bigint: true }))) throw new Error("atomic file stage identity changed while opening");
      fs.fsyncSync(descriptor);
    } catch (cause) { failure = cause; throw cause; }
    finally { if (descriptor !== null) closeFileDescriptor(descriptor, failure); }
    const flushed = this.#capture(stage.path, maxBytes);
    if (!sameFileIdentity(snapshot.identity, flushed.identity) || snapshot.digest !== flushed.digest
      || (this.permissionHint !== null && !this.permissionHint.matchesAfterWrite(flushed.permissionHint))) throw new Error("atomic file stage changed while flushing");
    state.snapshot = flushed;
    state.adopted = true;
    return stage;
  }

  disposeStage(stage) {
    const state = this.#state(stage);
    let stat;
    try { stat = fs.lstatSync(stage.path, { bigint: true }); }
    catch (cause) { if (cause.code === "ENOENT") { state.consumed = true; return; } throw cause; }
    if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentity(stat, state.identity)) {
      throw new Error("atomic file stage cleanup refused a replacement");
    }
    fs.unlinkSync(stage.path);
    state.consumed = true;
  }

  // Exclusive publication uses a same-volume hard link and then removes the
  // owned stage. Unlike replacing rename, EEXIST never replaces another actor.
  #assertAbsent() {
    let exists = true;
    try { fs.lstatSync(this.filePath); }
    catch (cause) { if (cause.code !== "ENOENT") throw cause; exists = false; }
    this.directoryAuthority.assertStable();
    if (exists) throw Object.assign(new Error(`exclusive publication target already exists: ${this.filePath}`), { code: "EEXIST" });
  }

  publishStage(stage, { exclusive = false, retainOnFailure = false } = {}) {
    let phase = "inspect-stage";
    let committedToVisibleName = false;
    const cleanupErrors = [];
    try {
      const state = this.#state(stage);
      const expected = state.snapshot;
      const streaming = expected instanceof RegularFileReadReceipt;
      phase = `before-${this.phaseNamespace}-rename`;
      const event = this.#event("rename", stage);
      this.commitGuard(event);
      this.directoryAuthority.assertStable();
      if (exclusive) this.#assertAbsent();
      else this.#assertBaseline(state.baseline, streaming);
      this.#inspectStage(stage, state);
      if (exclusive) fs.linkSync(stage.path, this.filePath);
      else fs.renameSync(stage.path, this.filePath);
      committedToVisibleName = true;
      if (exclusive) {
        phase = `after-${this.phaseNamespace}-exclusive-publication-cleanup`;
        try { this.#event("temp-unlink", stage); this.disposeStage(stage); }
        catch (error) { cleanupErrors.push(error); throw error; }
      }
      state.consumed = true;
      phase = `before-${this.phaseNamespace}-readback`;
      this.#event("readback");
      const published = this.#capture(this.filePath, this.maxBytes, false, streaming);
      if (!sameFileIdentity(expected.identity, published.identity) || published.byteLength !== expected.byteLength || published.digest !== expected.digest
        || !expected.permissionHint.matches(published.permissionHint)) {
        throw new Error("atomic file publication readback does not match staged bytes");
      }
      return new AtomicFilePublication({ committed: true, path: this.filePath,
        ...(streaming ? { receipt: published } : { snapshot: published }) });
    } catch (cause) {
      if (!committedToVisibleName && !retainOnFailure && !cause.cleanupFailed && stages.get(stage)?.writer === this && !stages.get(stage).consumed) {
        try { this.disposeStage(stage); } catch (error) { cleanupErrors.push(error); }
      }
      throw this.createWriteError(cause.message, { cause, phase, committedToVisibleName,
        publicationUnknown: committedToVisibleName, cleanupErrors });
    }
  }

  write(content, options = {}) { return this.publishStage(this.createStage(content, { exclusive: options.exclusive === true }), options); }

  remove({ streaming = false } = {}) {
    let committedToVisibleName = false;
    let phase = "inspect-visible-file";
    try {
      const baseline = this.#baseline(streaming);
      if (baseline === null) return new AtomicFilePublication({ committed: false, path: this.filePath });
      phase = `before-${this.phaseNamespace}-unlink`;
      this.commitGuard(this.#event("unlink"));
      this.directoryAuthority.assertStable();
      this.#assertBaseline(baseline);
      fs.unlinkSync(this.filePath);
      committedToVisibleName = true;
      phase = `before-${this.phaseNamespace}-readback`;
      this.#event("readback");
      if (this.#baseline(streaming) !== null) throw new Error("atomic file removal readback found a visible replacement");
      return new AtomicFilePublication({ committed: true, path: this.filePath,
        ...(streaming ? { receipt: baseline } : { snapshot: baseline }) });
    } catch (cause) {
      throw this.createWriteError(cause.message, { cause, phase, committedToVisibleName, publicationUnknown: committedToVisibleName });
    }
  }

  /** Producer-specific completion policy; ordinary file failures release their output. */
  retainOutputOnFailure(_cause) { return false; }

  createWriteError(message, details) { return new AtomicFileWriteError(message, details); }
}
