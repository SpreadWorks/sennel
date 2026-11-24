import { FileLock, FileLockAcquisition, FileLockWaitPolicy, FileLockTimeoutError } from "./file-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { ManagedStopOperation } from "./managed-stop-operation.js";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { managedControlFailure, readManagedRecord, ManagedRecordWrite } from "./managed-process-protocol.js";

function rejectClaimFailure(cause) {
  if (cause instanceof FileLockTimeoutError || cause.cause instanceof FileLockTimeoutError) {
    throw managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Stop operation lock exceeded its remaining deadline", cause);
  }
  if (cause instanceof ProcessExecutionControlFailure) throw cause;
  throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", "Stop operation authority is unavailable", cause);
}

/** The exact live coordinator owns the first durable stop decision. */
export class ManagedStopOperationStore {
  constructor(call) {
    this.call = call;
    this.file = `${call.outcomePath}.stop`;
    if (!(call.recordLocks instanceof RepositoryLockAuthority)) throw new TypeError("Stop operation requires explicit repository lock authority");
    this.lockAuthority = call.recordLocks;
    this.location = this.lockAuthority.location({ namespace: "managed-stop-operation", identity: this.file,
      fileName: "authority.lock", legacyPaths: [`${this.file}.authority.lock`] });
  }
  read(options = {}) {
    try {
      const saved = readManagedRecord(this.file, { ...options, lockAuthority: this.lockAuthority });
      if (saved === null) return null;
      if (saved.executionId !== this.call.executionId || saved.callId !== this.call.callId
        || saved.ownerToken !== this.call.ownerToken || saved.capability !== (this.call.capability ?? null)) {
        throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Stop operation belongs to another physical call");
      }
      return ManagedStopOperation.fromStored(saved.operation);
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", "Stop operation authority is unavailable", cause);
    }
  }
  claim(options = {}) {
    return this.prepareClaim(options).runExclusive((operation, write) => { write?.publish(); return operation; }, { adoptExisting: true });
  }
  prepareClaim(options = {}) {
    const proposed = options instanceof ManagedStopOperationValue
      ? ManagedStopOperation.fromStored(options.toJSON()) : ManagedStopOperation.begin(options);
    try {
      return new ManagedStopOperationClaim(this, this.read({ deadline: proposed.deadline }) ?? proposed);
    } catch (cause) { rejectClaimFailure(cause); }
  }
  prepareClaimAcquisition(proposed, onAcquired, { adoptExisting = false, dataRecovery = false } = {}) {
    const remainingWait = () => new FileLockWaitPolicy({ timeoutMs: dataRecovery ? 0 : Math.floor(proposed.remainingMs()) });
    const deadline = dataRecovery ? undefined : proposed.deadline;
    return new FileLockAcquisition(() => new FileLock({ location: this.location, kind: "managed-stop-operation",
      authority: { executionId: this.call.executionId, callId: this.call.callId }, waitPolicy: remainingWait() }), () => {
      const saved = dataRecovery ? proposed : this.read({ waitPolicy: remainingWait(), deadline });
      if (saved !== null && !saved.matches(proposed) && !adoptExisting) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Prepared stop decision differs from its first durable authority");
      const write = saved !== null ? null : new ManagedRecordWrite(this.file, Buffer.from(JSON.stringify({ executionId: this.call.executionId, callId: this.call.callId,
        ownerToken: this.call.ownerToken, capability: this.call.capability ?? null, operation: proposed.toJSON() })), this.call,
      { waitPolicy: remainingWait(), deadline, lockAuthority: this.lockAuthority });
      onAcquired(saved ?? proposed, write);
    });
  }
  withPreparedClaim(proposed, body, options) {
    let operation, write;
    const acquisition = this.prepareClaimAcquisition(proposed, (selected, prepared) => { operation = selected; write = prepared; }, options);
    try { return FileLock.runExclusiveGroup([acquisition], () => body(operation, write)); }
    catch (cause) { rejectClaimFailure(cause); }
  }
}

/** First-decision exclusion remains owned by the stop store during publication. */
export class ManagedStopOperationClaim {
  #store;
  constructor(store, operation) { this.#store = store; this.operation = operation; Object.freeze(this); }
  get file() { return this.#store.file; }
  acquisition(onAcquired, options) { return this.#store.prepareClaimAcquisition(this.operation, onAcquired, options); }
  runExclusive(body, options) { return this.#store.withPreparedClaim(this.operation, body, options); }
}

export function withManagedStopOperationClaims(claims, body, options = {}) {
  const unique = new Map();
  for (const claim of claims) {
    if (!(claim instanceof ManagedStopOperationClaim)) throw new TypeError("Stop publication requires typed claims");
    const previous = unique.get(claim.file);
    if (previous !== undefined && !previous.operation.matches(claim.operation)) throw new TypeError("Stop publication contains conflicting first decisions");
    unique.set(claim.file, claim);
  }
  const ordered = [...unique.values()].sort((left, right) => left.file.localeCompare(right.file));
  const writes = [];
  const acquisitions = ordered.map((claim) => claim.acquisition((_operation, write) => {
    if (write !== null) writes.push(write);
  }, options));
  const execute = () => FileLock.runExclusiveGroup(acquisitions, () => body(writes));
  if (acquisitions.length === 0) return execute();
  try { return execute(); }
  catch (cause) { rejectClaimFailure(cause); }
}
