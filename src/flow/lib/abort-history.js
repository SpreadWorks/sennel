import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtomicFile } from "../../lib/atomic-file.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable abort observation; IDs, timestamps and summary facts belong to the caller. */
export class AbortHistoryRecord {
  #summary;

  constructor({ schemaVersion, event, operationId, runId, specId, recordedAt, reason, ...summary }) {
    if (schemaVersion !== 1) throw new TypeError("abort history schemaVersion must be 1");
    if (!["abort-requested", "abort-completed"].includes(event)) {
      throw new TypeError("abort history event is invalid");
    }
    if (typeof operationId !== "string" || !UUID.test(operationId)) {
      throw new TypeError("abort history operationId must be a UUID");
    }
    for (const [name, value] of [["runId", runId], ["specId", specId]]) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`abort history ${name} must be a non-empty string`);
      }
    }
    if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) {
      throw new TypeError("abort history recordedAt must be a timestamp");
    }
    if (reason !== null && typeof reason !== "string") {
      throw new TypeError("abort history reason must be null or a string");
    }
    Object.assign(this, { schemaVersion, event, operationId, runId, specId, recordedAt, reason });
    this.#summary = structuredClone(summary);
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...structuredClone(this.#summary),
      schemaVersion: this.schemaVersion,
      event: this.event,
      operationId: this.operationId,
      runId: this.runId,
      specId: this.specId,
      recordedAt: this.recordedAt,
      reason: this.reason,
    };
  }

  assertSame(record) {
    if (!isDeepStrictEqual(this.toJSON(), record.toJSON())) {
      throw new Error("abort history record conflicts with an existing record");
    }
  }
}

/** Specs-root JSONL history. The caller holds RepositoryFlowOperationLock for append. */
export class AbortHistoryStore {
  constructor({ directory }) {
    this.file = path.join(directory, "abort-log.jsonl");
    this.atomicFile = new AtomicFile(this.file);
  }

  read() {
    return this.#readSnapshot().records;
  }

  #readSnapshot() {
    const bytes = this.atomicFile.read(Buffer.alloc(0));
    if (bytes.length === 0) return { bytes, records: [] };
    if (bytes[bytes.length - 1] !== 10) {
      throw new Error("abort history must end with a complete LF-delimited line");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const records = text.slice(0, -1).split("\n").map((line, index) => {
      try {
        return new AbortHistoryRecord(JSON.parse(line));
      } catch (cause) {
        throw new Error(`abort history has an invalid record at line ${index + 1}`, { cause });
      }
    });
    const seen = new Map();
    for (const record of records) {
      const key = `${record.operationId}:${record.event}`;
      if (seen.has(key)) seen.get(key).assertSame(record);
      seen.set(key, record);
    }
    return { bytes, records };
  }

  append(record) {
    if (!(record instanceof AbortHistoryRecord)) throw new TypeError("abort history requires an AbortHistoryRecord");
    const { bytes, records } = this.#readSnapshot();
    const previous = records.find((entry) => entry.operationId === record.operationId && entry.event === record.event);
    if (previous) {
      previous.assertSame(record);
      return false;
    }
    this.atomicFile.write(Buffer.concat([bytes, Buffer.from(`${JSON.stringify(record)}\n`)]));
    return true;
  }
}
