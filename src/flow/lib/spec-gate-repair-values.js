import { createHash } from "node:crypto";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { SpecJsonValidator } from "../../lib/spec-json-validator.js";
import { compareText } from "./text-order.js";

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
  toJSON() { return { version: 1, sources: this.#sources.map((source) => ({ ...source.descriptor(), content: source.content })) }; }
  sources() { return [...this.#sources]; }
  static fromJSON(value) {
    if (!value || value.version !== 1 || Object.keys(value).sort().join(",") !== "sources,version"
      || !Array.isArray(value.sources)) throw new TypeError("Repair source snapshot format unavailable");
    return new SpecGateRepairSourceSnapshots(value.sources.map((entry) => {
      if (!entry.id?.startsWith("evidence:") || Object.keys(entry).sort().join(",")
        !== "appliesTo,availability,byteLength,content,digest,id,origin,required,revision") {
        throw new TypeError("Invalid repair source snapshot descriptor");
      }
      const source = new SpecGateRepairSource({ ...entry, id: entry.id.slice("evidence:".length) });
      if (source.digest !== entry.digest || source.byteLength !== entry.byteLength) throw new Error("Repair source snapshot digest mismatch");
      return source;
    }));
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
