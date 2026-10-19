import { AtomicFile } from "./atomic-file.js";
import { ProcessExecutionControlFailure, executionProcessIdentity } from "./process-execution-values.js";

/** Atomic saved observations only: no lock acquisition or live process assessment. */
export function readManagedBinarySnapshot(file, { maximum = 16 * 1024 * 1024 } = {}) {
  try {
    const transition = new AtomicFile(`${file}.transition`);
    const assertCommitted = () => {
      if (transition.read() !== null) throw new ProcessExecutionControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN",
        `Managed record has an incomplete durable write: ${file}`);
    };
    assertCommitted();
    const bytes = new AtomicFile(file, { maxBytes: maximum }).read();
    assertCommitted();
    return bytes;
  } catch (cause) {
    if (cause.reason === "limit") throw new ProcessExecutionControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed file exceeds its bounded size", { cause });
    if (cause instanceof ProcessExecutionControlFailure) throw cause;
    throw new ProcessExecutionControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed process record cannot be read: ${file}`, { cause });
  }
}

export function decodeManagedRecord(bytes, file) {
  try { return bytes === null ? null : JSON.parse(bytes); }
  catch (cause) { throw new ProcessExecutionControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed JSON cannot be read: ${file}`, { cause }); }
}

export function readManagedRecordSnapshot(file, options) {
  return decodeManagedRecord(readManagedBinarySnapshot(file, options), file);
}

/** Compare saved capabilities and, once registered, the saved launcher birth. */
export function assertManagedRecordIdentity(record, expected, { code = "PROCESS_EXECUTION_AUTHORITY_MISMATCH" } = {}) {
  if (!record || record.executionId !== expected.executionId || record.callId !== expected.callId
    || record.capability !== expected.capability || record.ownerToken !== expected.ownerToken
    || expected.launcherIdentity !== undefined && (record.pgid !== expected.pgid
      || !executionProcessIdentity(record.launcherIdentity).sameBirth(executionProcessIdentity(expected.launcherIdentity)))) {
    throw new ProcessExecutionControlFailure(code, "Managed record belongs to another physical call");
  }
  return record;
}
