import { ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionBinding, executionUuid, executionValueDigest, executionValueSnapshot } from "./process-execution-values.js";

function fields(value, names, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length
    || names.some((name) => !Object.hasOwn(value, name))) throw new TypeError(`${label} has missing or unknown fields`);
}
function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} requires SHA256`);
  return value;
}

/** The process layer compares this opaque subset; its keys carry no Flow logic. */
export class ProcessExecutionBindingSelection {
  constructor(value) {
    const binding = new ProcessExecutionBinding(value);
    if (binding.value === null || Object.keys(binding.value).length === 0) throw new TypeError("Finalization selection requires an explicit nonempty binding subset");
    this.binding = new ProcessExecutionBinding(Object.fromEntries(Object.entries(binding.value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    Object.freeze(this);
  }
  matches(binding) { return binding instanceof ProcessExecutionBinding && binding.value !== null && binding.includes(this.binding); }
  get value() { return this.binding.value; }
  get digest() { return this.binding.digest; }
  toJSON() { return this.binding.toJSON(); }
  static fromStored(value) { return new this(value); }
}

class FinalizationEventReference {
  constructor(entry, cutoffSequence) {
    fields(entry, ["eventId", "sequence", "eventDigest"], "Finalization event");
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > cutoffSequence) throw new TypeError("Finalization event sequence is outside its cutoff");
    this.eventId = executionUuid(entry.eventId, "Finalization event");
    this.sequence = entry.sequence;
    this.eventDigest = digest(entry.eventDigest, "Finalization event");
    Object.freeze(this);
  }
  toJSON() { return { eventId: this.eventId, sequence: this.sequence, eventDigest: this.eventDigest }; }
}

/** Immutable inventory saved after admission closes and before publication drains. */
export class ProcessExecutionFinalizationCutoff {
  constructor({ schemaVersion, executionId, ownerEpoch, fenceId, selection, cutoffSequence, callClosures, events, evidenceDigest }) {
    if (schemaVersion !== 2 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1
      || !Number.isSafeInteger(cutoffSequence) || cutoffSequence < 0) throw new TypeError("Finalization cutoff revision or sequence is invalid");
    Object.assign(this, { schemaVersion, executionId: executionUuid(executionId, "Finalization execution"), ownerEpoch,
      fenceId: executionUuid(fenceId, "Finalization fence"), selection: new ProcessExecutionBindingSelection(selection), cutoffSequence });
    this.callClosures = Object.freeze(callClosures.map((entry) => ProcessExecutionCallClosure.fromStored(entry)));
    this.events = Object.freeze(events.map((entry) => new FinalizationEventReference(entry, cutoffSequence)));
    if (new Set(this.callClosures.map((entry) => entry.callId)).size !== this.callClosures.length
      || new Set(this.events.map((entry) => entry.eventId)).size !== this.events.length
      || this.events.some((entry, index) => index > 0 && entry.sequence <= this.events[index - 1].sequence)) throw new TypeError("Finalization inventory is duplicated or unordered");
    this.evidenceDigest = digest(evidenceDigest, "Finalization evidence");
    if (executionValueDigest(this.inventory()) !== evidenceDigest) throw new TypeError("Finalization evidence digest differs from its exact inventory");
    if (new.target === ProcessExecutionFinalizationCutoff) Object.freeze(this);
  }
  inventory() { return { schemaVersion: this.schemaVersion, executionId: this.executionId, ownerEpoch: this.ownerEpoch,
    fenceId: this.fenceId, selection: this.selection.toJSON(), cutoffSequence: this.cutoffSequence,
    callClosures: this.callClosures.map((entry) => entry.toJSON()), events: this.events.map((entry) => entry.toJSON()) }; }
  toJSON() { return executionValueSnapshot({ ...this.inventory(), evidenceDigest: this.evidenceDigest }); }
  static fromStored(value) {
    fields(value, ["schemaVersion", "executionId", "ownerEpoch", "fenceId", "selection", "cutoffSequence", "callClosures", "events", "evidenceDigest"], "Finalization cutoff");
    return new this(value);
  }
}

/** Publication acknowledgement for every event in the already sealed inventory. */
export class ProcessExecutionFinalizationBarrier extends ProcessExecutionFinalizationCutoff {
  constructor(value) {
    super(value);
    this.acknowledgementDigest = digest(value.acknowledgementDigest, "Finalization acknowledgement");
    if (this.acknowledgementDigest !== executionValueDigest(this.events.map((entry) => entry.eventId))) throw new TypeError("Finalization acknowledgement differs from its selected events");
    Object.freeze(this);
  }
  toJSON() { return { ...super.toJSON(), acknowledgementDigest: this.acknowledgementDigest }; }
  static fromStored(value) {
    fields(value, ["schemaVersion", "executionId", "ownerEpoch", "fenceId", "selection", "cutoffSequence", "callClosures", "events", "evidenceDigest", "acknowledgementDigest"], "Finalization barrier");
    return new this(value);
  }
  matches(other) { return other instanceof ProcessExecutionFinalizationBarrier && isDeepStrictEqual(this.toJSON(), other.toJSON()); }
}
