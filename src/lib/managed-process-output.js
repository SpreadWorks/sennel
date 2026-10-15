import crypto from "node:crypto";
import path from "node:path";
import { ProcessOutputBuffer } from "./process-supervisor.js";
import { managedControlFailure, readManagedBinary, writeManagedBinary } from "./managed-process-protocol.js";

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
  read(file, { sealed = false, deadline } = {}) {
    const bytes = readManagedBinary(file, { maximum: this.maximum, deadline });
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
    this.file = path.join(path.dirname(call.outcomePath), `${stream}.bin`);
    this.maximum = maximum;
    this.buffer = new ProcessOutputBuffer(maximum, "buffer");
    this.dirty = true;
    this.snapshot = null;
  }
  append(bytes) { this.dirty = true; return this.buffer.append(bytes); }
  persist({ deadline } = {}) {
    if (this.dirty) {
      const bytes = this.buffer.toBuffer();
      writeManagedBinary(this.file, bytes, this.call, { deadline });
      this.snapshot = ManagedOutputSnapshot.capture(bytes, this.maximum);
      this.dirty = false;
    }
    return this.snapshot.toJSON();
  }
}

export function readManagedOutput(call, outcome, { sealed = false, deadline } = {}) {
  const output = outcome?.output;
  if (!output) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed output references are missing");
  const result = {};
  for (const stream of ["stdout", "stderr"]) {
    result[stream] = new ManagedOutputSnapshot(output[stream], output.maximum)
      .read(path.join(path.dirname(call.outcomePath), `${stream}.bin`), { sealed, deadline });
  }
  return result;
}
