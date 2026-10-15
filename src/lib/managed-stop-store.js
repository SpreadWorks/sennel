import path from "node:path";
import { FileLock, FileLockWaitPolicy, FileLockTimeoutError } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { ManagedStopOperation } from "./managed-stop-operation.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { managedControlFailure, readManagedRecord, writeManagedRecord } from "./managed-process-protocol.js";

/** Coordinator, launcher and recovery share the first durable stop decision. */
export class ManagedStopOperationStore {
  constructor(call) {
    this.call = call;
    this.file = `${call.outcomePath}.stop`;
    this.directoryAuthority = new RealDirectoryAuthority(path.dirname(this.file));
  }
  read(options = {}) {
    try {
      const saved = readManagedRecord(this.file, options);
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
    let proposed = options instanceof ManagedStopOperation ? options : ManagedStopOperation.begin(options);
    const remainingWait = () => new FileLockWaitPolicy({ timeoutMs: Math.floor(proposed.remainingMs()) });
    try {
      // An earlier launcher-owned stop also clips waiting for claim authority.
      proposed = this.read({ deadline: proposed.deadline }) ?? proposed;
      const lock = new FileLock({ directoryAuthority: this.directoryAuthority,
        fileName: `${path.basename(this.file)}.authority.lock`, kind: "managed-stop-operation",
        authority: { executionId: this.call.executionId, callId: this.call.callId }, waitPolicy: remainingWait() });
      return lock.runExclusive(() => {
        const saved = this.read({ waitPolicy: remainingWait(), deadline: proposed.deadline });
        if (saved !== null) return saved;
        writeManagedRecord(this.file, { executionId: this.call.executionId, callId: this.call.callId,
          ownerToken: this.call.ownerToken, capability: this.call.capability ?? null, operation: proposed.toJSON() }, { waitPolicy: remainingWait(), deadline: proposed.deadline });
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
