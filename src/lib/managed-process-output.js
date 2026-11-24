import crypto from "node:crypto";
import path from "node:path";
import { ProcessExecutorIdentity } from "./process-execution-values.js";
import { ProcessOutputBuffer } from "./process-supervisor.js";
import { isDeepStrictEqual } from "node:util";
import { managedControlFailure, readManagedRecord, writeManagedRecord, writeManagedBinary } from "./managed-process-protocol.js";
import { readManagedBinarySnapshot, assertManagedRecordIdentity } from "./managed-process-record.js";

/** Content identity for one bounded output stream; its path is never supplied by a record. */
export class ManagedOutputSnapshot {
  constructor({ byteLength, sha256 }, maximum) {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(byteLength)
      || byteLength < 0 || byteLength > maximum || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed output snapshot is invalid");
    }
    this.maximum = maximum;
    this.byteLength = byteLength;
    this.sha256 = sha256;
    Object.freeze(this);
  }
  static capture(bytes, maximum) {
    return new this({ byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }, maximum);
  }
  toJSON() { return { byteLength: this.byteLength, sha256: this.sha256 }; }
  read(file, { sealed = false } = {}) {
    const bytes = readManagedBinarySnapshot(file, { maximum: this.maximum });
    if (bytes === null || bytes.length < this.byteLength || sealed && bytes.length !== this.byteLength) {
      throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed output spool has a different size");
    }
    const prefix = bytes.subarray(0, this.byteLength);
    if (crypto.createHash("sha256").update(prefix).digest("hex") !== this.sha256) {
      throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed output spool differs from its content identity");
    }
    return prefix;
  }
}

/** Persist only changed output, separately from the small process outcome record. */
export class ManagedOutputSpool {
  constructor(call, stream, maximum) {
    if (!["stdout", "stderr"].includes(stream) || !Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Managed output requires a bounded stream");
    this.call = call;
    this.stream = stream;
    this.file = path.join(path.dirname(call.outcomePath), `${stream}.bin`);
    this.maximum = maximum;
    this.buffer = new ProcessOutputBuffer(maximum, "buffer");
    this.dirty = true;
    this.snapshot = null;
  }
  persistCapturedChunk({ snapshot, offset, bytes }) {
    const target = new ManagedOutputSnapshot(snapshot, this.maximum);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024
      || offset + bytes.length > target.byteLength) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Captured output chunk exceeds its snapshot or transport bound");
    const file = `${this.file}.capture`;
    const saved = readManagedRecord(file, { lockAuthority: this.call.recordLocks });
    let progress;
    if (saved === null) {
      if (offset !== 0 || readManagedBinarySnapshot(this.file, { maximum: this.maximum }) !== null) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Output capture lacks its initial owned transfer");
      progress = new ManagedOutputCaptureRecord({ schemaVersion: 1, executionId: this.call.executionId, callId: this.call.callId,
        ownerToken: this.call.ownerToken, capability: this.call.capability, executor: this.call.executor.toJSON(), maximum: this.maximum,
        stream: this.stream, target: target.toJSON(), prefix: null });
      writeManagedRecord(file, progress.toJSON(), { lockAuthority: this.call.recordLocks });
    } else {
      assertManagedRecordIdentity(saved, this.call);
      progress = ManagedOutputCaptureRecord.fromStored(saved);
      if (progress.maximum !== this.maximum || progress.stream !== this.stream || !isDeepStrictEqual(progress.target.toJSON(), target.toJSON())) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "An output transfer cannot replace its original captured snapshot");
    }
    const prefix = progress.prefix === null ? Buffer.alloc(0) : progress.prefix.read(this.file, { sealed: true });
    if (progress.prefix === null && readManagedBinarySnapshot(this.file, { maximum: this.maximum }) !== null) throw managedControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN", "Output capture has bytes without confirmed progress");
    if (offset < prefix.length || progress.prefix !== null && prefix.length === target.byteLength) {
      if (offset + bytes.length > prefix.length || !prefix.subarray(offset, offset + bytes.length).equals(bytes)) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Repeated output chunk differs from its published prefix");
      const acknowledged = ManagedOutputSnapshot.capture(prefix.subarray(0, offset + bytes.length), this.maximum);
      return { snapshot: acknowledged.toJSON(), complete: acknowledged.byteLength === target.byteLength };
    }
    if (offset !== prefix.length) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Output chunks cannot skip unpublished bytes");
    this.append(prefix); this.append(bytes);
    const captured = ManagedOutputSnapshot.capture(this.buffer.toBuffer(), this.maximum);
    const complete = captured.byteLength === target.byteLength;
    if (complete && captured.sha256 !== target.sha256) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Completed output bytes differ from their captured snapshot");
    const published = this.persist();
    progress = new ManagedOutputCaptureRecord({ ...progress.toJSON(), prefix: published });
    writeManagedRecord(file, progress.toJSON(), { lockAuthority: this.call.recordLocks });
    return { snapshot: published, complete };
  }
  append(bytes) { this.dirty = true; return this.buffer.append(bytes); }
  persist({ deadline } = {}) {
    if (this.dirty) {
      const bytes = this.buffer.toBuffer();
      writeManagedBinary(this.file, bytes, this.call, { deadline, maximum: this.maximum });
      this.snapshot = ManagedOutputSnapshot.capture(bytes, this.maximum);
      this.dirty = false;
    }
    return this.snapshot.toJSON();
  }
}

export function readManagedOutput(call, outcome, { sealed = false } = {}) {
  const output = outcome?.output;
  if (!output) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed output references are missing");
  const result = {};
  for (const stream of ["stdout", "stderr"]) {
    result[stream] = new ManagedOutputSnapshot(output[stream], output.maximum)
      .read(path.join(path.dirname(call.outcomePath), `${stream}.bin`), { sealed });
  }
  return result;
}


/** Immutable whole-buffer identity and exact last published prefix. */
class ManagedOutputCaptureRecord {
  constructor({ schemaVersion, executionId, callId, ownerToken, capability, executor, maximum, stream, target, prefix }) {
    if (schemaVersion !== 1 || !["stdout", "stderr"].includes(stream)) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Output capture record is invalid");
    Object.assign(this, { schemaVersion, executionId, callId, ownerToken, capability, maximum, stream });
    this.executor = ProcessExecutorIdentity.fromStored(executor);
    this.target = new ManagedOutputSnapshot(target, maximum);
    this.prefix = prefix === null ? null : new ManagedOutputSnapshot(prefix, maximum);
    if (this.prefix !== null && (this.prefix.byteLength > this.target.byteLength
      || this.prefix.byteLength === this.target.byteLength && this.prefix.sha256 !== this.target.sha256)) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Output capture progress exceeds its immutable target");
    Object.freeze(this);
  }
  toJSON() { return { schemaVersion: this.schemaVersion, executionId: this.executionId, callId: this.callId,
    ownerToken: this.ownerToken, capability: this.capability, executor: this.executor.toJSON(), maximum: this.maximum, stream: this.stream,
    target: this.target.toJSON(), prefix: this.prefix?.toJSON() ?? null }; }
  static fromStored(value) {
    const restored = new this(value);
    if (!isDeepStrictEqual(value, restored.toJSON())) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Output capture has missing or unknown fields");
    return restored;
  }
}
