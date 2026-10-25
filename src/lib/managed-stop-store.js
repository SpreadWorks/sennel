import { FileLock, FileLockWaitPolicy, FileLockTimeoutError } from "./file-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { ManagedStopOperation } from "./managed-stop-operation.js";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { managedControlFailure, readManagedRecord, writeManagedRecord } from "./managed-process-protocol.js";

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
    let proposed = options instanceof ManagedStopOperationValue
      ? ManagedStopOperation.fromStored(options.toJSON()) : ManagedStopOperation.begin(options);
    const remainingWait = () => new FileLockWaitPolicy({ timeoutMs: Math.floor(proposed.remainingMs()) });
    try {
      // The first durable decision also clips waiting for claim authority.
      proposed = this.read({ deadline: proposed.deadline }) ?? proposed;
      const lock = new FileLock({ location: this.location, kind: "managed-stop-operation",
        authority: { executionId: this.call.executionId, callId: this.call.callId }, waitPolicy: remainingWait() });
      return lock.runExclusive(() => {
        const saved = this.read({ waitPolicy: remainingWait(), deadline: proposed.deadline });
        if (saved !== null) return saved;
        writeManagedRecord(this.file, { executionId: this.call.executionId, callId: this.call.callId,
          ownerToken: this.call.ownerToken, capability: this.call.capability ?? null, operation: proposed.toJSON() }, { waitPolicy: remainingWait(), deadline: proposed.deadline, lockAuthority: this.lockAuthority });
        return proposed;
      });
    } catch (cause) {
      if (cause instanceof FileLockTimeoutError || cause.cause instanceof FileLockTimeoutError) {
        throw managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Stop operation lock exceeded its remaining deadline", cause);
      }
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", "Stop operation authority is unavailable", cause);
    }
  }
}
