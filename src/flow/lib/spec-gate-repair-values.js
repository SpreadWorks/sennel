import { createHash } from "node:crypto";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { SpecJsonValidator } from "../../lib/spec-json-validator.js";
import { compareText } from "./text-order.js";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";

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
  constructor({ source, element }) {
    if (!(source instanceof SpecGateRepairSource)) throw new TypeError("Repair source range requires a captured source");
    const byteStart = Buffer.byteLength(source.content.slice(0, element.start), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(element.text, "utf8");
    this.value = Object.freeze({ ...source.toJSON(), content: element.text, byteStart, byteEnd,
      sliceDigest: sourceDigest(element.text) });
    this.id = `${source.id}@bytes:${byteStart}:${byteEnd}:${source.digest}`;
    this.digest = this.value.sliceDigest;
    Object.freeze(this);
  }
  static sameSnapshot(left, right) {
    return left?.snapshotId !== undefined && right?.snapshotId === left.snapshotId
      && right.snapshotDigest === left.snapshotDigest;
  }
  static covers(available, requested) {
    return this.sameSnapshot(available, requested)
      && available.byteStart <= requested.byteStart && available.byteEnd >= requested.byteEnd;
  }
  static uncoveredBytes(requested, available) {
    // Selections normalize full/fragment overlap; registered fragments are otherwise disjoint.
    const overlap = available.filter((value) => this.sameSnapshot(value, requested)).reduce((bytes, value) =>
      bytes + Math.max(0, Math.min(requested.byteEnd, value.byteEnd) - Math.max(requested.byteStart, value.byteStart)), 0);
    return Math.max(0, requested.byteEnd - requested.byteStart - overlap);
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
}
