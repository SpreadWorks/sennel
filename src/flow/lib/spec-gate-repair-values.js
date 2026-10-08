import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { SpecJsonValidator } from "../../lib/spec-json-validator.js";
import { compareText } from "./text-order.js";
import { MAX_WORKER_ARTIFACT_INPUT_BYTES, workerArtifactStableStringify } from "./worker-artifact-input-format.js";
import { RangedTextPromptElement } from "../../lib/prompt-batching.js";
import { freezeSpecGateRepairValue } from "./spec-gate-repair-selection.js";

const sourceDigest = (content) => createHash("sha256").update(content, "utf8").digest("hex");

/** Read-only captured evidence. Availability never implies investigation of other paths. */
export class SpecGateRepairSource {
  constructor({ id, origin, revision, content, availability = "available", required = !id?.startsWith("source:"), appliesTo = [] }) {
    if (typeof id !== "string" || !id || typeof origin !== "string" || !origin
      || typeof revision !== "string" || !revision || typeof content !== "string"
      || !["available", "missing", "unavailable"].includes(availability)
      || typeof required !== "boolean" || !Array.isArray(appliesTo)
      || appliesTo.some((scope) => typeof scope !== "string")) {
      throw new TypeError("Repair source requires an identity, origin, revision and text");
    }
    if (availability !== "available" && content !== "") throw new TypeError("Unavailable repair source cannot contain captured text");
    // Captured text represents its exact UTF-8 bytes, including request strings.
    // Normalize ill-formed JS surrogate text once so restore and selection agree.
    content = Buffer.from(content, "utf8").toString("utf8");
    this.id = `evidence:${id}`;
    this.origin = origin;
    this.revision = revision;
    this.content = content;
    this.availability = availability;
    this.required = required;
    this.appliesTo = Object.freeze([...new Set(appliesTo)].sort());
    this.digest = sourceDigest(content);
    this.byteLength = Buffer.byteLength(content, "utf8");
    Object.freeze(this);
  }
  get isProjectRule() { return this.appliesTo.length > 0; }
  static referencedOrigins(value, origins) {
    // Match literal known paths in any language. A longer registered path owns
    // its complete occurrence, so its suffix cannot select a sibling source.
    if (origins.length === 0) return new Set();
    const paths = [...new Set(origins)];
    const referenced = new Set();
    const collect = (entry) => {
      if (typeof entry === "string") {
        const occurrences = new Map();
        for (const origin of paths) {
          for (let start = entry.indexOf(origin); start !== -1; start = entry.indexOf(origin, start + 1)) {
            if ((occurrences.get(start)?.length ?? 0) < origin.length) occurrences.set(start, origin);
          }
        }
        let end = 0;
        for (const start of [...occurrences.keys()].sort((left, right) => left - right)) {
          if (start < end) continue;
          const origin = occurrences.get(start);
          referenced.add(origin);
          end = start + origin.length;
        }
      } else if (entry !== null && typeof entry === "object") Object.values(entry).forEach(collect);
    };
    collect(value);
    return referenced;
  }
  appliesToOrigin(origin) {
    return this.appliesTo.some((scope) => scope === "." || origin.startsWith(`${scope}/`));
  }
  assertAvailable() {
    if (this.availability !== "available") {
      throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE",
        "Selected Spec Gate repair context is unavailable", { data: { failureKind: "step-admission",
          sourceId: this.id, origin: this.origin, availability: this.availability } });
    }
  }
  query(query, binding, previousResults = []) {
    if (!(query instanceof SpecGateRepairSourceQuery)) throw new TypeError("Repair source query requires a typed query");
    this.assertAvailable();
    return SpecGateRepairSourceQueryResult.fromSource(this, query, binding, previousResults);
  }
  descriptor() {
    return { id: this.id, origin: this.origin, revision: this.revision, digest: this.digest,
      byteLength: this.byteLength, availability: this.availability, required: this.required, appliesTo: this.appliesTo };
  }
  toJSON() {
    return { origin: this.origin, revision: this.revision, content: this.content,
      snapshotId: this.id, snapshotDigest: this.digest, snapshotByteLength: this.byteLength, byteStart: 0, byteEnd: this.byteLength,
      sliceDigest: this.digest, availability: this.availability, appliesTo: this.appliesTo };
  }
}

/** Parent-owned full source capture, separate from the selected worker input. */
export class SpecGateRepairSourceSnapshots {
  #sources;
  constructor(sources) {
    if (!Array.isArray(sources) || sources.some((source) => !(source instanceof SpecGateRepairSource))
      || new Set(sources.map((source) => source.id)).size !== sources.length) {
      throw new TypeError("Repair snapshots require unique typed sources");
    }
    this.#sources = Object.freeze([...sources].sort((a, b) => compareText(a.id, b.id)));
    Object.freeze(this);
  }
  sources() { return [...this.#sources]; }
  assertCurrentEvidence(current) {
    if (!(current instanceof SpecGateRepairSourceSnapshots)) {
      throw new TypeError("Repair evidence comparison requires typed current snapshots");
    }
    // Required canonical inputs and every declared rule remain live evidence.
    // Optional research bodies retain their immutable publication identity and
    // do not authorize another checkout read during restoration.
    const descriptors = (snapshots) => snapshots.sources()
      .filter((source) => source.required || source.isProjectRule)
      .map((source) => source.descriptor());
    if (!isDeepStrictEqual(descriptors(this), descriptors(current))) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
        "Saved Spec Gate repair canonical inputs or project rules changed",
        { retryable: false, recoveryPossible: false });
    }
  }
}

/** An exact content identity, never a caller-selected path or Activity. */
export class SpecGateRepairSourceSnapshotReference {
  constructor(value) {
    if (!value || Object.keys(value).sort().join(",") !== "byteLength,digest"
      || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      throw new TypeError("Repair source reference requires its exact digest and byte length");
    }
    this.digest = value.digest;
    this.byteLength = value.byteLength;
    Object.freeze(this);
  }
  toJSON() { return { digest: this.digest, byteLength: this.byteLength }; }
  assertBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== this.byteLength
      || sourceDigest(bytes) !== this.digest) throw new Error("Repair source snapshot digest mismatch");
  }
}

/** Metadata for a captured source; available bodies live in separate immutable blobs. */
class SpecGateRepairSourceDescriptor {
  constructor(value) {
    if (!value || Object.keys(value).sort().join(",") !== "appliesTo,availability,byteLength,digest,id,origin,required,revision"
      || typeof value.id !== "string" || !value.id.startsWith("evidence:") || value.id === "evidence:"
      || typeof value.origin !== "string" || !value.origin || typeof value.revision !== "string" || !value.revision
      || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0
      || !["available", "missing", "unavailable"].includes(value.availability)
      || typeof value.required !== "boolean" || !Array.isArray(value.appliesTo)
      || value.appliesTo.some((scope) => typeof scope !== "string")
      || value.appliesTo.some((scope, index) => index > 0 && compareText(value.appliesTo[index - 1], scope) >= 0)
      || value.availability !== "available" && (value.byteLength !== 0 || value.digest !== sourceDigest(""))) {
      throw new TypeError("Invalid repair source manifest descriptor");
    }
    Object.assign(this, value, { appliesTo: Object.freeze([...value.appliesTo]) });
    Object.freeze(this);
  }
  toJSON() { return { ...this, appliesTo: [...this.appliesTo] }; }
  restore(bytes) {
    new SpecGateRepairSourceSnapshotReference({ digest: this.digest, byteLength: this.byteLength }).assertBytes(bytes);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const source = new SpecGateRepairSource({ ...this, id: this.id.slice("evidence:".length), content });
    if (source.digest !== this.digest || source.byteLength !== this.byteLength) throw new Error("Repair source snapshot digest mismatch");
    return source;
  }
}

/** Deterministically ordered bodyless manifest shared by all equal source captures. */
export class SpecGateRepairSourceSnapshotManifest {
  #descriptors;
  constructor(value) {
    if (!value || Object.keys(value).sort().join(",") !== "sources,version"
      || value.version !== 1 || !Array.isArray(value.sources)) throw new TypeError("Invalid repair source manifest format");
    this.#descriptors = Object.freeze(value.sources.map((entry) => new SpecGateRepairSourceDescriptor(entry)));
    if (this.#descriptors.some((entry, index) => index > 0 && compareText(this.#descriptors[index - 1].id, entry.id) >= 0)) {
      throw new TypeError("Repair source manifest identities must be unique and sorted");
    }
    Object.freeze(this);
  }
  static fromSnapshots(snapshots) {
    if (!(snapshots instanceof SpecGateRepairSourceSnapshots)) throw new TypeError("Repair source manifest requires typed snapshots");
    return new this({ version: 1, sources: snapshots.sources().map((source) => source.descriptor()) });
  }
  static fromJSON(value) { return new this(value); }
  toJSON() { return { version: 1, sources: this.#descriptors.map((entry) => entry.toJSON()) }; }
  bytes() { return Buffer.from(workerArtifactStableStringify(this.toJSON()), "utf8"); }
  reference() { const bytes = this.bytes(); return new SpecGateRepairSourceSnapshotReference({ digest: sourceDigest(bytes), byteLength: bytes.length }); }
  restore(readBlob) {
    return new SpecGateRepairSourceSnapshots(this.#descriptors.map((entry) => entry.restore(
      entry.availability === "available" ? readBlob(entry.digest, entry.byteLength) : Buffer.alloc(0))));
  }
}

/** Exact UTF-8 coverage bound to one captured source. */
export class SpecGateRepairSourceRange {
  constructor({ source, element, index }) {
    if (!(source instanceof SpecGateRepairSource)) throw new TypeError("Repair source range requires a captured source");
    if (index !== undefined) index.assertSource(source);
    if (!(element instanceof RangedTextPromptElement) || element.originId !== source.id
      || element.sourceRevision !== source.revision || element.sourceLength !== source.content.length
      || source.content.slice(element.start, element.end) !== element.text) {
      throw new TypeError("Repair source range belongs to a different captured source");
    }
    const byteStart = index ? index.byteOffset(element.start) : Buffer.byteLength(source.content.slice(0, element.start), "utf8");
    const byteEnd = index ? index.byteOffset(element.end) : byteStart + Buffer.byteLength(element.text, "utf8");
    if (Buffer.from(element.text, "utf8").toString("utf8") !== element.text) {
      throw new TypeError("Repair source range must preserve exact UTF-8 boundaries");
    }
    this.value = Object.freeze({ ...source.toJSON(), content: element.text, byteStart, byteEnd,
      sliceDigest: sourceDigest(element.text) });
    this.id = `${source.id}@bytes:${byteStart}:${byteEnd}:${source.digest}`;
    this.digest = this.value.sliceDigest;
    Object.freeze(this);
  }
  static sameSnapshot(left, right) {
    return left?.snapshotId !== undefined && right?.snapshotId === left.snapshotId
      && right.snapshotDigest === left.snapshotDigest && right.revision === left.revision
      && right.origin === left.origin && right.snapshotByteLength === left.snapshotByteLength;
  }
  static covers(available, requested) {
    return this.sameSnapshot(available, requested)
      && available.byteStart <= requested.byteStart && available.byteEnd >= requested.byteEnd;
  }
  static uncoveredBytes(requested, available) {
    return this.uncoveredRangeBytes([requested], available);
  }
  static uncoveredRangeBytes(requested, available) {
    const groups = new Map();
    for (const value of requested) {
      const key = workerArtifactStableStringify([value.snapshotId, value.snapshotDigest, value.revision, value.origin, value.snapshotByteLength]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    }
    let bytes = 0;
    for (const values of groups.values()) {
      const covered = unionIntervals(available.filter((value) => this.sameSnapshot(value, values[0])));
      for (const [start, end] of unionIntervals(values)) {
        const overlap = covered.reduce((total, [left, right]) => total + Math.max(0, Math.min(end, right) - Math.max(start, left)), 0);
        bytes += end - start - overlap;
      }
    }
    return bytes;
  }
  static validate(value, digest) {
    if (!value || Object.keys(value).sort().join(",") !== "appliesTo,availability,byteEnd,byteStart,content,origin,revision,sliceDigest,snapshotByteLength,snapshotDigest,snapshotId"
      || typeof value.origin !== "string" || !value.origin || typeof value.revision !== "string" || !value.revision
      || !value.snapshotId?.startsWith("evidence:") || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)
      || !Number.isSafeInteger(value.byteStart) || !Number.isSafeInteger(value.byteEnd)
      || value.byteStart < 0 || value.byteEnd < value.byteStart || typeof value.content !== "string"
      || !Number.isSafeInteger(value.snapshotByteLength) || value.byteEnd > value.snapshotByteLength
      || !["available", "missing", "unavailable"].includes(value.availability)
      || !Array.isArray(value.appliesTo) || value.appliesTo.some((scope) => typeof scope !== "string")
      || (value.availability !== "available" && value.content !== "")
      || Buffer.byteLength(value.content, "utf8") !== value.byteEnd - value.byteStart
      || sourceDigest(value.content) !== value.sliceDigest || digest !== value.sliceDigest) {
      throw new Error("Conflicting repair bundle source digest or byte range");
    }
  }
}

function unionIntervals(values) {
  const result = [];
  for (const value of [...values].sort((a, b) => a.byteStart - b.byteStart || a.byteEnd - b.byteEnd)) {
    const previous = result.at(-1);
    if (previous && value.byteStart <= previous[1]) previous[1] = Math.max(previous[1], value.byteEnd);
    else result.push([value.byteStart, value.byteEnd]);
  }
  return result;
}

/** A literal query of already captured evidence, without path discovery authority. */
export class SpecGateRepairSourceQuery {
  constructor(value) {
    if (!value || Object.keys(value).sort().join(",") !== "afterLines,beforeLines,cursor,literal,maxMatches,origin"
      || typeof value.origin !== "string" || !value.origin || typeof value.literal !== "string" || !value.literal
      || Buffer.from(value.literal, "utf8").toString("utf8") !== value.literal
      || ![value.beforeLines, value.afterLines].every((number) => Number.isSafeInteger(number) && number >= 0)
      || !Number.isSafeInteger(value.maxMatches) || value.maxMatches < 1
      || value.cursor !== null && (typeof value.cursor !== "string" || !/^source-query:[a-f0-9]{64}$/.test(value.cursor))) {
      throw new TypeError("Invalid captured source query");
    }
    Object.assign(this, value);
    Object.freeze(this);
  }
  static fromJSON(value) { return new this(value); }
  toJSON() { return { origin: this.origin, literal: this.literal, beforeLines: this.beforeLines,
    afterLines: this.afterLines, maxMatches: this.maxMatches, cursor: this.cursor }; }
  parameters() { const { cursor, ...parameters } = this.toJSON(); return parameters; }
}

/** UTF-16 lookup and line windows mapped to the exact UTF-8 snapshot. */
export class SpecGateRepairSourceTextIndex {
  #source;
  #offsets;
  #lines;
  constructor(source) {
    if (!(source instanceof SpecGateRepairSource)) throw new TypeError("Repair text index requires a captured source");
    this.#source = source;
    this.#offsets = new Uint32Array(source.content.length + 1);
    this.#lines = [0];
    let character = 0; let bytes = 0;
    // Node's string length limit keeps UTF-8 offsets below this uint32 sentinel.
    // Surrogate interiors must remain invalid, rather than aliasing a boundary.
    while (character < source.content.length) {
      const point = source.content.codePointAt(character);
      const width = point > 0xffff ? 2 : 1;
      if (width === 2) this.#offsets[character + 1] = 0xffffffff;
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      character += width;
      this.#offsets[character] = bytes;
      if (point === 10) this.#lines.push(character);
    }
    Object.freeze(this);
  }
  assertSource(source) {
    if (!isDeepStrictEqual(source.descriptor(), this.#source.descriptor())) {
      throw new TypeError("Repair text index belongs to a different captured source");
    }
  }
  byteOffset(character) {
    const offset = this.#offsets[character];
    if (!Number.isSafeInteger(character) || offset === undefined || offset === 0xffffffff) {
      throw new TypeError("Repair source query requires exact Unicode boundaries");
    }
    return offset;
  }
  lineWindow(start, end, beforeLines, afterLines) {
    const lineAt = (position) => {
      let left = 0; let right = this.#lines.length;
      while (left + 1 < right) {
        const middle = Math.floor((left + right) / 2);
        if (this.#lines[middle] <= position) left = middle; else right = middle;
      }
      return left;
    };
    return { start: this.#lines[Math.max(0, lineAt(start) - beforeLines)],
      end: this.#lines[Math.min(this.#lines.length, lineAt(Math.max(start, end - 1)) + afterLines + 1)] ?? this.#source.content.length };
  }
}

/** Exact serialized receipt capacity, admitting each range and match before retention. */
class SpecGateRepairSourceQueryOutput {
  #body;
  #fixedBytes;
  #arrayBytes = 0;
  #identity = `source-query:${"0".repeat(64)}`;
  constructor(body) {
    this.#body = body;
    // Digest characters have fixed ASCII width. Empty arrays include their brackets;
    // each admitted entry adds only its own bytes and the necessary comma.
    this.#fixedBytes = Buffer.byteLength(workerArtifactStableStringify({ ...body, id: this.#identity, nextCursor: null }))
      - Buffer.byteLength(workerArtifactStableStringify(body.searchedInterval)) - JSON.stringify(body.complete).length - 4;
  }
  static #assertSize(actualBytes) {
    if (actualBytes > MAX_WORKER_ARTIFACT_INPUT_BYTES) {
      throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE", "Captured source query exceeds the worker input bound",
        { data: { failureKind: "step-admission", actualBytes, maximumBytes: MAX_WORKER_ARTIFACT_INPUT_BYTES } });
    }
  }
  #assertCapacity(arrayBytes, interval, complete) {
    SpecGateRepairSourceQueryOutput.#assertSize(this.#fixedBytes + arrayBytes
      + Buffer.byteLength(workerArtifactStableStringify(interval)) + (complete ? 4 : 5)
      + (complete ? 4 : JSON.stringify(this.#identity).length));
  }
  admit(match, range, interval, complete) {
    let addedBytes = Buffer.byteLength(workerArtifactStableStringify(match)) + (this.#body.matches.length > 0 ? 1 : 0);
    if (range !== undefined) {
      addedBytes += Buffer.byteLength(workerArtifactStableStringify(range)) + (this.#body.ranges.length > 0 ? 1 : 0);
    }
    this.#assertCapacity(this.#arrayBytes + addedBytes, interval, complete);
    this.#arrayBytes += addedBytes;
    if (range !== undefined) this.#body.ranges.push(range);
    this.#body.matches.push(match);
  }
  finish(interval, complete) {
    this.#assertCapacity(this.#arrayBytes, interval, complete);
    Object.assign(this.#body, { searchedInterval: interval, complete });
    const id = `source-query:${sourceDigest(workerArtifactStableStringify(this.#body))}`;
    const value = { ...this.#body, id, nextCursor: complete ? null : id };
    SpecGateRepairSourceQueryOutput.#assertSize(Buffer.byteLength(workerArtifactStableStringify(value)));
    return value;
  }
}

/** Immutable inspection receipt; its cursor authenticates source, binding and parameters. */
export class SpecGateRepairSourceQueryResult {
  constructor(value) {
    const fields = "baseRevision,complete,id,matches,nextCursor,query,ranges,searchedInterval,sourceByteLength,sourceDigest,sourceId,sourceRevision,unitId,version";
    if (!value || Object.keys(value).sort().join(",") !== fields || value.version !== 1
      || typeof value.unitId !== "string" || !value.unitId || !/^sha256:[a-f0-9]{64}$/.test(value.baseRevision)
      || typeof value.sourceId !== "string" || !value.sourceId.startsWith("evidence:")
      || typeof value.sourceRevision !== "string" || !value.sourceRevision || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
      || !Number.isSafeInteger(value.sourceByteLength) || value.sourceByteLength < 0
      || typeof value.complete !== "boolean" || !Array.isArray(value.matches) || !Array.isArray(value.ranges)) {
      throw new TypeError("Invalid captured source query result identity");
    }
    const query = new SpecGateRepairSourceQuery(value.query);
    const { id, nextCursor, ...body } = value;
    if (id !== `source-query:${sourceDigest(workerArtifactStableStringify(body))}`
      || nextCursor !== (value.complete ? null : id)) throw new TypeError("Conflicting captured source query result identity");
    const interval = value.searchedInterval;
    if (!interval || Object.keys(interval).sort().join(",") !== "byteEnd,byteStart,characterEnd,characterStart"
      || !Object.values(interval).every((number) => Number.isSafeInteger(number) && number >= 0)
      || interval.byteStart > interval.byteEnd || interval.byteEnd > value.sourceByteLength
      || interval.characterStart > interval.characterEnd) throw new TypeError("Invalid captured source query interval");
    const ranges = new Map();
    for (const range of value.ranges) {
      if (!range || Object.keys(range).sort().join(",") !== "digest,id,value") throw new TypeError("Invalid source query range");
      SpecGateRepairSourceRange.validate(range.value, range.digest);
      if (range.value.snapshotId !== value.sourceId || range.value.snapshotDigest !== value.sourceDigest
        || range.value.snapshotByteLength !== value.sourceByteLength || range.value.revision !== value.sourceRevision
        || range.value.origin !== query.origin || range.value.availability !== "available"
        || range.id !== `${value.sourceId}@bytes:${range.value.byteStart}:${range.value.byteEnd}:${value.sourceDigest}`
        || ranges.has(range.id)) throw new TypeError("Conflicting captured source query range identity");
      ranges.set(range.id, range);
    }
    for (const match of value.matches) {
      const range = ranges.get(match?.rangeId)?.value;
      if (!match || Object.keys(match).sort().join(",") !== "byteEnd,byteStart,rangeId"
        || !Number.isSafeInteger(match.byteStart) || !Number.isSafeInteger(match.byteEnd)
        || !range || match.byteStart < range.byteStart || match.byteEnd > range.byteEnd
        || match.byteEnd - match.byteStart !== Buffer.byteLength(query.literal)
        || Buffer.from(range.content).subarray(match.byteStart - range.byteStart, match.byteEnd - range.byteStart).toString("utf8") !== query.literal) {
        throw new TypeError("Invalid captured source query match identity");
      }
    }
    Object.assign(this, structuredClone(value));
    for (const entry of [this.query, this.searchedInterval, ...this.matches, ...this.ranges]) freezeSpecGateRepairValue(entry);
    Object.freeze(this.matches); Object.freeze(this.ranges); Object.freeze(this);
  }
  static fromJSON(value) { return new this(value); }
  toJSON() { return structuredClone({ ...this }); }
  static fromSource(source, query, binding, previousResults = []) {
    if (!binding || typeof binding.unitId !== "string" || !binding.unitId || !/^sha256:[a-f0-9]{64}$/.test(binding.baseRevision)
      || source.origin !== query.origin) throw new TypeError("Invalid captured source query binding");
    const index = new SpecGateRepairSourceTextIndex(source);
    const element = new RangedTextPromptElement({ id: source.id, sourceRevision: source.revision, sequence: 0, text: source.content });
    const receipts = new Map();
    for (const result of previousResults) {
      if (result instanceof this && !receipts.has(result.id)) receipts.set(result.id, result);
    }
    const chain = []; const seen = new Set();
    let inspection = query;
    while (inspection.cursor !== null) {
      const previous = receipts.get(inspection.cursor);
      if (!previous || previous.complete || previous.unitId !== binding.unitId || previous.baseRevision !== binding.baseRevision
        || seen.has(previous.id)
        || !isDeepStrictEqual(new SpecGateRepairSourceQuery(previous.query).parameters(), inspection.parameters())) {
        throw new TypeError("Invalid captured source query cursor binding");
      }
      if (previous.sourceId !== source.id || previous.sourceDigest !== source.digest
        || previous.sourceRevision !== source.revision || previous.sourceByteLength !== source.byteLength) {
        throw new TypeError("Stale captured source query cursor identity");
      }
      chain.push(previous); seen.add(previous.id);
      inspection = new SpecGateRepairSourceQuery(previous.query);
    }
    // Reproduce every linked receipt against captured bytes, using one source-bound
    // index and element for the entire query instead of retaining recursive indexes.
    let start = 0;
    for (const previous of chain.reverse()) {
      const reproduced = SpecGateRepairSourceQueryResult.#capture(source, new SpecGateRepairSourceQuery(previous.query), binding, index, element, start);
      if (!isDeepStrictEqual(reproduced, previous.toJSON())) throw new TypeError("Invalid captured source query cursor receipt");
      start = previous.searchedInterval.characterEnd;
    }
    return new this(SpecGateRepairSourceQueryResult.#capture(source, query, binding, index, element, start));
  }
  static #capture(source, query, binding, index, element, start) {
    const matches = []; const ranges = []; const windows = new Map();
    const intervalAt = (end) => ({ characterStart: start, characterEnd: end,
      byteStart: index.byteOffset(start), byteEnd: index.byteOffset(end) });
    const output = new SpecGateRepairSourceQueryOutput({ version: 1, sourceId: source.id, sourceRevision: source.revision, sourceDigest: source.digest,
      sourceByteLength: source.byteLength, unitId: binding.unitId, baseRevision: binding.baseRevision,
      query: query.toJSON(), searchedInterval: intervalAt(start), matches, ranges, complete: false });
    let cursor = start;
    let position = source.content.indexOf(query.literal, cursor);
    while (position !== -1 && matches.length < query.maxMatches) {
      const end = position + query.literal.length;
      const window = index.lineWindow(position, end, query.beforeLines, query.afterLines);
      const windowKey = `${window.start}:${window.end}`;
      let range = windows.get(windowKey);
      const unique = range === undefined;
      if (unique) range = new SpecGateRepairSourceRange({ source, element: element.createRange(window), index });
      const match = { byteStart: index.byteOffset(position), byteEnd: index.byteOffset(end), rangeId: range.id };
      cursor = position + String.fromCodePoint(source.content.codePointAt(position)).length;
      position = source.content.indexOf(query.literal, cursor);
      const complete = position === -1;
      // This is the exact receipt size if enumeration stops at this candidate.
      // Further matches add more bytes than completing can save in nextCursor,
      // so refusing an oversized prefix cannot reject a fitting final receipt.
      output.admit(match, unique ? { id: range.id, digest: range.digest, value: range.value } : undefined,
        intervalAt(complete ? source.content.length : cursor), complete);
      if (unique) windows.set(windowKey, range);
    }
    const complete = position === -1;
    const characterEnd = complete ? source.content.length : cursor;
    return output.finish(intervalAt(characterEnd), complete);
  }
}

/** One version-bound, permission-limited parent input for Gate repair. */
export class SpecGateRepairInput {
  constructor({ repair, spec, baseRevision, specByteLength, context, sourceDescriptor, review, attempt,
    observationIdentities, validator }) {
    if (!(validator instanceof SpecJsonValidator)) throw new TypeError("Gate repair input requires its canonical Spec validator");
    this.repair = repair;
    this.spec = Object.freeze(structuredClone(spec));
    this.baseRevision = baseRevision;
    this.specByteLength = specByteLength;
    this.context = context;
    this.sourceDescriptor = Object.freeze(structuredClone(sourceDescriptor));
    this.review = review;
    this.attempt = Object.freeze({ id: attempt.id, sequence: attempt.sequence });
    this.observationIdentities = Object.freeze(observationIdentities.map((identity) => Object.freeze(identity)));
    this.validator = validator;
    Object.freeze(this);
  }
  withLocations(locations) {
    return new SpecGateRepairInput({ ...this,
      context: this.context.resolveLocations({ baseRevision: this.baseRevision, locations }) });
  }
}
