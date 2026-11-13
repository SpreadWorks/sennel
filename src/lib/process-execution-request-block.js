import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import { CURRENT_PROCESS_EXECUTION_EVIDENCE } from "./process-execution-evidence-codec.js";
import {
  ChildExitObservation, ProcessExecutionValueEncoding,
  executionUuid as uuid, executionValueSnapshot as json, executionValueDigest as digest,
  freezeExecutionValue,
} from "./process-execution-values.js";

// A packing target only. The owning runtime keeps its existing hard record cap
// and may put a larger single section in its own block.
export const RUNTIME_REQUEST_BLOCK_SOFT_BYTES = 256 * 1024;
const DEFAULT_PHYSICAL_RECORD_MAX_BYTES = 16 * 1024 * 1024;
const continuedBlockAuthority = Symbol("continued completion block");
const encodingPlanAuthority = Symbol("request block encoding plan");

function digestValue(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} requires SHA256`);
  return value;
}

function storageUuid(value) {
  const bytes = crypto.createHash("sha256").update(JSON.stringify(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The pre-existing ordinary block identity algorithm, unchanged. */
export function runtimeRequestBlockIdentity(section, kind) {
  return storageUuid({ version: 9, executionId: section.executionId, kind, firstRequestId: section.requestId });
}

function fields(value, names, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function storedJson(value, label) {
  const restored = json(value);
  if (!isDeepStrictEqual(value, restored)) throw new TypeError(`${label} is not an exact JSON value`);
  return freezeExecutionValue(restored);
}

/** One exact immutable response; its original JSON order belongs to the value. */
export class RuntimeRequestResponseValue {
  #value;
  #encoding;
  #byteLength;
  constructor(value) {
    this.#value = storedJson(value, "Request response");
    if (this.#value === null) throw new TypeError("Completed request has no response");
    this.#encoding = new ProcessExecutionValueEncoding(this.#value);
    this.#byteLength = Buffer.byteLength(this.#encoding.text());
    Object.freeze(this);
  }
  get value() { return this.#value; }
  get encoding() { return this.#encoding; }
  get digest() { return this.#encoding.digest; }
  get byteLength() { return this.#byteLength; }
  text() { return this.#encoding.text(); }
  toJSON() { return this.#value; }
}

/** A physical block locator and the digest of one immutable logical section. */
export class RuntimeRequestReference {
  constructor(value) {
    fields(value, ["blockId", "digest"], "Request reference");
    this.blockId = uuid(value.blockId, "request block ID");
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw new TypeError("Request reference digest is invalid");
    this.digest = value.digest;
    Object.freeze(this);
  }
  toJSON() { return [this.blockId, this.digest]; }
  matches(other) { return other instanceof RuntimeRequestReference && this.blockId === other.blockId && this.digest === other.digest; }
  static fromStored(value) {
    if (value === null || value instanceof RuntimeRequestReference) return value;
    if (!Array.isArray(value) || value.length !== 2 || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 0) || !Object.hasOwn(value, 1)) throw new TypeError("Request reference must be an exact two-element tuple");
    return new this({ blockId: value[0], digest: value[1] });
  }
}

/** Empty executions need no stored heads; nonempty heads have one exact form. */
export class RuntimeRequestHeads {
  constructor(value) {
    fields(value, ["history", "completion"], "Request heads");
    this.history = RuntimeRequestReference.fromStored(value.history);
    this.completion = RuntimeRequestReference.fromStored(value.completion);
    Object.freeze(this);
  }
  toJSON() { return this.history === null && this.completion === null ? {}
    : { requestHistoryHead: this.history, requestCompletionHead: this.completion }; }
  static fromExecution(value) {
    const history = Object.hasOwn(value, "requestHistoryHead"), completion = Object.hasOwn(value, "requestCompletionHead");
    if (history !== completion) throw new TypeError("Request heads must be stored together");
    if (!history) return new this({ history: null, completion: null });
    if (value.requestHistoryHead === null && value.requestCompletionHead === null) throw new TypeError("Empty request heads must be omitted");
    return new this({ history: value.requestHistoryHead, completion: value.requestCompletionHead });
  }
}

/** Original request identity, shared unchanged by acceptance and completion. */
export class RuntimeRequestAcceptance {
  constructor(value) {
    fields(value, ["requestId", "operation", "payloadDigest", "authorizationDigest"], "Request acceptance");
    this.requestId = uuid(value.requestId, "request ID");
    if (typeof value.operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(value.operation)
      || typeof value.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.payloadDigest)
      || typeof value.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.authorizationDigest)) throw new TypeError("Request acceptance is invalid");
    this.operation = value.operation;
    this.payloadDigest = value.payloadDigest;
    this.authorizationDigest = value.authorizationDigest;
    Object.freeze(this);
  }
  toJSON() { return { requestId: this.requestId, operation: this.operation,
    payloadDigest: this.payloadDigest, authorizationDigest: this.authorizationDigest }; }
  matches(other) { return other instanceof RuntimeRequestAcceptance && this.requestId === other.requestId && this.operation === other.operation
    && this.payloadDigest === other.payloadDigest && this.authorizationDigest === other.authorizationDigest; }
  static fromStored(value) { return value instanceof RuntimeRequestAcceptance ? value : new this(value); }
}

/** One cached envelope codec shared by blocks and namespace-bound ledgers. */
class RuntimeRequestRecordEncoding {
  #encoding;
  #record;
  constructor(encoding, checksum = null) {
    if (!(encoding instanceof ProcessExecutionValueEncoding)) throw new TypeError("Request record requires its captured value encoding");
    this.#encoding = encoding;
    this.checksum = checksum ?? this.#encoding.digest;
    this.#record = `{"payload":${this.#encoding.text()},"digest":"${this.checksum}"}`;
    this.byteLength = Buffer.byteLength(this.#record);
    Object.freeze(this);
  }
  text() { return this.#encoding.text(); }
  recordText() { return this.#record; }
}

/** Original logical request identity, distinct from its compact physical wire. */
class RuntimeStandaloneRequestRecord {
  constructor(acceptance, response) {
    Object.assign(this, acceptance.toJSON(), { response });
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

/** The request path supplies identity and also salts its durable checksum. */
export class RuntimeStandaloneRequestDocument {
  #wire;
  #encoding;
  #request;
  constructor(value) {
    fields(value, ["executionId", "requestId", "operation", "payloadDigest", "authorizationDigest", "response"], "Standalone request");
    this.executionId = uuid(value.executionId, "request execution ID");
    this.acceptance = new RuntimeRequestAcceptance({ requestId: value.requestId, operation: value.operation,
      payloadDigest: value.payloadDigest, authorizationDigest: value.authorizationDigest });
    this.response = storedJson(value.response, "Standalone request response");
    this.#wire = Object.freeze({ version: 9, operation: this.acceptance.operation, payloadDigest: this.acceptance.payloadDigest,
      authorizationDigest: this.acceptance.authorizationDigest, response: this.response });
    const checksum = digest({ kind: "standalone-request", executionId: this.executionId,
      requestId: this.acceptance.requestId, payload: this.#wire });
    this.#encoding = new RuntimeRequestRecordEncoding(new ProcessExecutionValueEncoding(this.#wire), checksum);
    this.#request = new RuntimeStandaloneRequestRecord(this.acceptance, this.response);
    Object.freeze(this);
  }
  requestRecord() { return this.#request; }
  toJSON() { return this.#wire; }
  encodedRecord() { return this.#encoding.recordText(); }
  encodedByteLength() { return this.#encoding.byteLength; }
  static fromEnvelope(executionId, requestId, envelope) {
    fields(envelope, ["payload", "digest"], "Standalone request envelope");
    const payload = envelope.payload;
    fields(payload, ["version", "operation", "payloadDigest", "authorizationDigest", "response"], "Standalone request wire");
    if (payload.version !== 9) throw new TypeError("Standalone request version is unsupported");
    const document = new this({ executionId, requestId, operation: payload.operation, payloadDigest: payload.payloadDigest,
      authorizationDigest: payload.authorizationDigest, response: payload.response });
    if (envelope.digest !== document.#encoding.checksum || JSON.stringify(payload) !== document.#encoding.text()) throw new TypeError("Standalone request differs from its exact namespace-bound canonical encoding");
    return document;
  }
}

/** One captured history value supplies its exact JSON, digest and UTF-8 length. */
class RuntimeRequestSectionEncoding {
  #valueEncoding;
  constructor(value) {
    const encoding = this.#valueEncoding = new ProcessExecutionValueEncoding(value);
    this.digest = encoding.digest;
    this.byteLength = Buffer.byteLength(encoding.text());
    Object.freeze(this);
  }
  get valueEncoding() { return this.#valueEncoding; }
}

/** Stream the unchanged full logical JSON without retaining its expanded text. */
class RuntimeRequestCompletionEncoding {
  #section;
  constructor(section) {
    this.#section = section;
    const parts = this.#parts();
    this.digest = ProcessExecutionValueEncoding.digestParts(parts);
    this.byteLength = Buffer.byteLength(parts[0]) + section.responseValue.byteLength + Buffer.byteLength(parts[2]);
    Object.freeze(this);
  }
  #parts() {
    const section = this.#section;
    const { response: _response, observation, settlement, ...metadata } = section.toJSON();
    const prefix = new ProcessExecutionValueEncoding(metadata).text();
    const suffix = new ProcessExecutionValueEncoding({ observation, settlement }).text();
    const beforeResponse = `${prefix.slice(0, -1)},"response":`;
    const afterResponse = `,${suffix.slice(1)}`;
    return [beforeResponse, section.responseValue.text(), afterResponse];
  }
  visitEncodedParts(visitor) {
    if (typeof visitor !== "function") throw new TypeError("Completion encoding visitor must be a function");
    for (const part of this.#parts()) visitor(part);
  }
  matchesEncodedBytes(bytes) {
    if (!Buffer.isBuffer(bytes)) return false;
    let offset = 0, matches = true;
    this.visitEncodedParts((part) => {
      const expected = Buffer.from(part, "utf8");
      if (!bytes.subarray(offset, offset + expected.length).equals(expected)) matches = false;
      offset += expected.length;
    });
    return matches && offset === bytes.length;
  }
}

/** Append-only logical acceptance; a pending response never reserves block space. */
export class RuntimeRequestHistorySection {
  #encoding;
  constructor(value) {
    fields(value, ["version", "executionId", "acceptance", "previous"], "Request history section");
    if (value.version !== 9) throw new TypeError("Request history section version is unsupported");
    this.version = value.version;
    this.executionId = uuid(value.executionId, "request execution ID");
    this.acceptance = RuntimeRequestAcceptance.fromStored(value.acceptance);
    this.previous = RuntimeRequestReference.fromStored(value.previous);
    this.#encoding = new RuntimeRequestSectionEncoding(this);
    Object.freeze(this);
  }
  get requestId() { return this.acceptance.requestId; }
  get digest() { return this.#encoding.digest; }
  get byteLength() { return this.#encoding.byteLength; }
  get valueEncoding() { return this.#encoding.valueEncoding; }
  reference(blockId) { return new RuntimeRequestReference({ blockId, digest: this.digest }); }
  toJSON() { return { version: this.version, executionId: this.executionId, acceptance: this.acceptance, previous: this.previous }; }
}

export class RuntimeRequestCallObservation {
  constructor(value) {
    fields(value, ["callId", "observation"], "Request observation");
    this.callId = uuid(value.callId, "request observation call ID");
    this.observation = value.observation instanceof ChildExitObservation ? value.observation : ChildExitObservation.fromStored(value.observation);
    if (!(value.observation instanceof ChildExitObservation) && !isDeepStrictEqual(value.observation, json(this.observation))) throw new TypeError("Request observation is not an exact child observation");
    Object.freeze(this);
  }
  toJSON() { return { callId: this.callId, observation: this.observation }; }
}

export class RuntimeRequestCallSettlement {
  constructor(value) {
    fields(value, ["callId", "outcome"], "Request settlement");
    this.callId = uuid(value.callId, "request settlement call ID");
    this.outcome = storedJson(value.outcome, "Request outcome");
    Object.freeze(this);
  }
  toJSON() { return { callId: this.callId, outcome: this.outcome }; }
}

/** Exact original result, independently appended when an accepted request ends. */
export class RuntimeRequestCompletionSection {
  #encoding;
  #valueEncoding = null;
  #responseValue;
  #settlementReceipt = null;
  #evidenceCodec;
  constructor(value, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    this.#evidenceCodec = evidenceCodec;
    fields(value, ["version", "executionId", "acceptance", "history", "previous", "response", "observation", "settlement"], "Request completion section");
    if (value.version !== 9) throw new TypeError("Request completion section version is unsupported");
    this.version = value.version;
    this.executionId = uuid(value.executionId, "request execution ID");
    this.acceptance = RuntimeRequestAcceptance.fromStored(value.acceptance);
    this.history = RuntimeRequestReference.fromStored(value.history);
    this.previous = RuntimeRequestReference.fromStored(value.previous);
    this.#responseValue = value.response instanceof RuntimeRequestResponseValue ? value.response : new RuntimeRequestResponseValue(value.response);
    this.response = this.#responseValue.value;
    this.observation = value.observation === null ? null : new RuntimeRequestCallObservation(value.observation);
    this.settlement = value.settlement === null ? null : new RuntimeRequestCallSettlement(value.settlement);
    if (this.observation !== null && (this.acceptance.operation !== "observe" || this.response.ok !== true)) throw new TypeError("Observation fact requires its successful accepted observation");
    if (this.settlement !== null) {
      const receipt = this.#evidenceCodec.receipt(this.response.value);
      if (this.acceptance.operation !== "finish" || this.response.ok !== true || this.observation !== null
        || receipt.executionId !== this.executionId || receipt.callId !== this.settlement.callId
        || receipt.outcomeDigest !== digest(this.settlement.outcome)) throw new TypeError("Settlement differs from its exact accepted finish response");
      if (!isDeepStrictEqual(this.response.value, json(receipt))) throw new TypeError("Finish response is not an exact typed receipt");
      this.#settlementReceipt = receipt;
    }
    this.#encoding = new RuntimeRequestCompletionEncoding(this);
    Object.freeze(this);
  }
  get requestId() { return this.acceptance.requestId; }
  get digest() { return this.#encoding.digest; }
  get byteLength() { return this.#encoding.byteLength; }
  get responseValue() { return this.#responseValue; }
  get valueEncoding() {
    this.#valueEncoding ??= ProcessExecutionValueEncoding.object(Object.entries(this.toJSON()).map(([name, value]) => [name,
      name === "response" ? this.#responseValue.encoding : new ProcessExecutionValueEncoding(value),
    ]));
    return this.#valueEncoding;
  }
  get settlementReceipt() { return this.#settlementReceipt; }
  get evidenceCodec() { return this.#evidenceCodec; }
  visitEncodedParts(visitor) { this.#encoding.visitEncodedParts(visitor); }
  matchesEncodedBytes(bytes) { return this.#encoding.matchesEncodedBytes(bytes); }
  reference(blockId) { return new RuntimeRequestReference({ blockId, digest: this.digest }); }
  toJSON() { return { version: this.version, executionId: this.executionId, acceptance: this.acceptance,
    history: this.history, previous: this.previous, response: this.response, observation: this.observation, settlement: this.settlement }; }
}

class RuntimeRequestResponsePoolEntry {
  #response;
  #encoding = null;
  constructor(response) { this.#response = response; this.digest = response.digest; this.value = response.value; Object.freeze(this); }
  get encoding() { return this.#encoding ??= ProcessExecutionValueEncoding.object([["digest", new ProcessExecutionValueEncoding(this.digest)], ["value", this.#response.encoding]]); }
  toJSON() { return { digest: this.digest, value: this.value }; }
}

class RuntimeRequestResponseGroup {
  constructor(response) { this.response = response; this.count = 1; }
  include() { this.count++; }
}

/** Physical indirection never changes the full logical section or its digest. */
class RuntimeRequestPooledCompletionSection {
  constructor(section) {
    Object.assign(this, section.toJSON(), { response: null, responseDigest: section.responseValue.digest });
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

/** A derived immutable wire plan, including its exact envelope byte length. */
class RuntimeRequestBlockEncoding {
  #value;
  #encoding = null;
  constructor(block, sections = block.sections, responses = null) {
    this.#value = Object.freeze({ version: block.version, executionId: block.executionId, blockId: block.blockId,
      kind: block.kind, sections: Object.freeze([...sections]), ...(responses === null ? {} : { responses: Object.freeze([...responses]) }) });
    if (responses === null && sections.length !== 0) {
      // Typed immutable section lengths already include their exact UTF8 JSON.
      // Size an ordinary candidate before rendering a block that may continue.
      this.byteLength = RuntimeRequestBlockEncoding.literalByteLength(this.#value);
    } else {
      this.#encoding = new RuntimeRequestRecordEncoding(this.#valueEncoding());
      this.byteLength = this.#encoding.byteLength;
    }
    Object.freeze(this);
  }
  #ensureEncoding() {
    this.#encoding ??= new RuntimeRequestRecordEncoding(this.#valueEncoding());
    return this.#encoding;
  }
  #valueEncoding() {
    return ProcessExecutionValueEncoding.object(Object.entries(this.#value).map(([name, value]) => [name,
      name === "sections" ? ProcessExecutionValueEncoding.array(value.map((section) =>
        section instanceof RuntimeRequestCompletionSection || section instanceof RuntimeRequestHistorySection
          ? section.valueEncoding : new ProcessExecutionValueEncoding(section)))
        : name === "responses" ? ProcessExecutionValueEncoding.array(value.map((entry) => entry.encoding))
          : new ProcessExecutionValueEncoding(value),
    ]));
  }
  text() { return this.#ensureEncoding().text(); }
  recordText() { return this.#ensureEncoding().recordText(); }
  toJSON() { return this.#value; }
  static literalByteLength(block) {
    const empty = new this(block, []);
    return empty.byteLength + block.sections.reduce((bytes, section) => bytes + section.byteLength, 0)
      + Math.max(0, block.sections.length - 1);
  }
}

function completionBlockEncoding(block) {
  const responses = new Map();
  for (const section of block.sections) {
    const response = section.responseValue, text = response.text();
    const group = responses.get(text);
    if (group === undefined) responses.set(text, new RuntimeRequestResponseGroup(response));
    else group.include();
  }
  const pooled = new Map([...responses].filter(([, group]) => group.count >= 2));
  if (pooled.size === 0) return new RuntimeRequestBlockEncoding(block);
  // Digest references must identify exactly one response text within the pool.
  if (new Set([...pooled.values()].map((group) => group.response.digest)).size !== pooled.size) return new RuntimeRequestBlockEncoding(block);
  const sections = block.sections.map((section) => pooled.has(section.responseValue.text()) ? new RuntimeRequestPooledCompletionSection(section) : section);
  const entries = [...pooled.values()].map((group) => new RuntimeRequestResponsePoolEntry(group.response));
  const compact = new RuntimeRequestBlockEncoding(block, sections, entries);
  return compact.byteLength < RuntimeRequestBlockEncoding.literalByteLength(block) ? compact : new RuntimeRequestBlockEncoding(block);
}

function storedCompletionBlock(value, evidenceCodec) {
  if (!Object.hasOwn(value, "responses")) return new RuntimeRequestCompletionBlock(value, null, null, evidenceCodec);
  fields(value, ["version", "executionId", "blockId", "kind", "sections", "responses"], "Pooled request block");
  if (!Array.isArray(value.responses) || value.responses.length === 0 || !Array.isArray(value.sections)) throw new TypeError("Request response pool is invalid");
  const responses = new Map(), uses = new Map();
  for (const entry of value.responses) {
    fields(entry, ["digest", "value"], "Request response pool entry");
    const response = new RuntimeRequestResponseValue(entry.value);
    if (entry.digest !== response.digest || responses.has(entry.digest)) throw new TypeError("Request response pool has an invalid or duplicate digest");
    responses.set(entry.digest, response); uses.set(entry.digest, 0);
  }
  const sections = value.sections.map((section) => {
    if (!Object.hasOwn(section, "responseDigest")) return new RuntimeRequestCompletionSection(section, evidenceCodec);
    fields(section, ["version", "executionId", "acceptance", "history", "previous", "response", "observation", "settlement", "responseDigest"], "Pooled request completion section");
    const response = responses.get(section.responseDigest);
    if (section.response !== null || response === undefined) throw new TypeError("Pooled completion requires its exact response reference and null sentinel");
    uses.set(section.responseDigest, uses.get(section.responseDigest) + 1);
    const { responseDigest, ...logical } = section;
    return new RuntimeRequestCompletionSection({ ...logical, response }, evidenceCodec);
  });
  if ([...uses.values()].some((count) => count < 2)) throw new TypeError("Request response pool has an unused or nonduplicate value");
  return new RuntimeRequestCompletionBlock({ version: value.version, executionId: value.executionId, blockId: value.blockId, kind: value.kind, sections }, null, null, evidenceCodec);
}

/** Storage identity never substitutes for the request's logical identity. */
export class RuntimeRequestBlock {
  #encoding;
  #sectionsByDigest = new Map();
  constructor(value, kind, Section, encode = (block) => new RuntimeRequestBlockEncoding(block), evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    if (new.target === RuntimeRequestBlock) throw new TypeError("Request blocks require their concrete section kind");
    fields(value, ["version", "executionId", "blockId", "kind", "sections"], "Request block");
    if (value.version !== 9 || value.kind !== kind || !Array.isArray(value.sections) || value.sections.length === 0) throw new TypeError("Request block revision, kind or sections are invalid");
    this.version = value.version;
    this.executionId = uuid(value.executionId, "request block execution ID");
    this.blockId = uuid(value.blockId, "request block ID");
    this.kind = kind;
    this.sections = Object.freeze(Array.from(value.sections, (section) => section instanceof Section ? section : new Section(section, evidenceCodec)));
    if (this.sections.some((section) => section.executionId !== this.executionId)
      || new Set(this.sections.map((section) => section.requestId)).size !== this.sections.length) throw new TypeError("Request block contains foreign or duplicate sections");
    for (const section of this.sections) {
      if (this.#sectionsByDigest.has(section.digest)) throw new TypeError("Request block contains ambiguous section digests");
      this.#sectionsByDigest.set(section.digest, section);
    }
    this.#encoding = encode(this);
  }
  section(digest) { return this.#sectionsByDigest.get(digest) ?? null; }
  append(section) { return new this.constructor({ version: this.version, executionId: this.executionId, blockId: this.blockId,
    kind: this.kind, sections: [...this.sections, section] }); }
  encodedByteLength() { return this.#encoding.byteLength; }
  encodedRecord() { return this.#encoding.recordText(); }
  toJSON() { return this.#encoding.toJSON(); }
  static fromStored(value, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    let block;
    if (value?.kind === "history") block = new RuntimeRequestHistoryBlock(value);
    else if (value?.kind === "completion") block = storedCompletionBlock(value, evidenceCodec);
    else throw new TypeError("Request block kind is unsupported");
    if (JSON.stringify(value) !== block.#encoding.text()) throw new TypeError("Request block is not its exact canonical physical encoding");
    return block;
  }
}

export class RuntimeRequestHistoryBlock extends RuntimeRequestBlock {
  constructor(value) { super(value, "history", RuntimeRequestHistorySection); Object.freeze(this); }
}

export class RuntimeRequestCompletionBlock extends RuntimeRequestBlock {
  constructor(value, authority = null, carrier = null, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    if (authority !== null && authority !== continuedBlockAuthority) throw new TypeError("Continued completion encoding requires codec authority");
    super(value, "completion", RuntimeRequestCompletionSection,
      authority === continuedBlockAuthority ? () => new RuntimeRequestContinuedBlockEncoding(carrier) : completionBlockEncoding, evidenceCodec);
    if (authority !== continuedBlockAuthority) Object.freeze(this);
  }
}

/** Physical links commit a complete canonical payload, including its next link. */
export class RuntimeRequestContinuationReference extends RuntimeRequestReference {
  matches(other) { return other instanceof RuntimeRequestContinuationReference && super.matches(other); }
  static fromStored(value) {
    if (value === null || value instanceof RuntimeRequestContinuationReference) return value;
    if (!Array.isArray(value)) throw new TypeError("Continuation reference must be its nominal value or exact tuple");
    const reference = RuntimeRequestReference.fromStored(value);
    return new this({ blockId: reference.blockId, digest: reference.digest });
  }
}

/** Common physical encoding; logical section validation remains with its codec. */
export class RuntimeRequestPhysicalRecord {
  #wire;
  #encoding;
  constructor(wire, kind) {
    if (new.target === RuntimeRequestPhysicalRecord) throw new TypeError("Physical request records require their concrete kind");
    if (wire.version !== 9 || wire.kind !== kind) throw new TypeError("Physical request record revision or kind is invalid");
    this.version = wire.version;
    this.executionId = uuid(wire.executionId, "physical request execution ID");
    this.blockId = uuid(wire.blockId, "physical request storage ID");
    this.kind = kind;
    this.#wire = Object.freeze(wire);
    this.#encoding = new RuntimeRequestRecordEncoding(new ProcessExecutionValueEncoding(this.#wire));
  }
  get digest() { return this.#encoding.checksum; }
  payloadText() { return this.#encoding.text(); }
  encodedRecord() { return this.#encoding.recordText(); }
  encodedByteLength() { return this.#encoding.byteLength; }
  reference() { return new RuntimeRequestContinuationReference({ blockId: this.blockId, digest: this.digest }); }
  toJSON() { return this.#wire; }
  static fromStored(value, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    if (value?.kind === "history" || value?.kind === "completion") return RuntimeRequestBlock.fromStored(value, evidenceCodec);
    let record;
    if (value?.kind === "completion-carrier") record = new RuntimeRequestCompletionCarrier(value);
    else if (value?.kind === "completion-continuation") record = new RuntimeRequestContinuationBlock(value);
    else throw new TypeError("Physical request record kind is unsupported");
    if (JSON.stringify(value) !== record.payloadText()) throw new TypeError("Physical request record is not its exact canonical encoding");
    return record;
  }
}

/** The old logical block location points to one exact original section stream. */
export class RuntimeRequestCompletionCarrier extends RuntimeRequestPhysicalRecord {
  constructor(value) {
    fields(value, ["version", "executionId", "blockId", "kind", "sectionDigest", "byteLength", "first"], "Completion carrier");
    const sectionDigest = digestValue(value.sectionDigest, "Continued completion section");
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) throw new TypeError("Continued completion byte length must be positive and safe");
    const first = RuntimeRequestContinuationReference.fromStored(value.first);
    if (first === null) throw new TypeError("Completion carrier requires its first physical continuation");
    super({ version: value.version, executionId: value.executionId, blockId: value.blockId, kind: value.kind,
      sectionDigest, byteLength: value.byteLength, first }, "completion-carrier");
    this.sectionDigest = sectionDigest; this.byteLength = value.byteLength; this.first = first;
    Object.freeze(this);
  }
}

function continuationBlockIdentity({ executionId, parentBlockId, sectionDigest, offset }) {
  return storageUuid({ version: 9, executionId, kind: "completion-continuation", parentBlockId, sectionDigest, offset });
}

/** One positive canonical base64 piece; no piece can confer logical ownership. */
export class RuntimeRequestContinuationBlock extends RuntimeRequestPhysicalRecord {
  #bytes;
  constructor(value) {
    fields(value, ["version", "executionId", "blockId", "kind", "parentBlockId", "sectionDigest", "offset", "next", "data"], "Completion continuation");
    const parentBlockId = uuid(value.parentBlockId, "continued completion parent storage ID");
    const sectionDigest = digestValue(value.sectionDigest, "Continued completion section");
    if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new TypeError("Continuation offset must be nonnegative and safe");
    if (typeof value.data !== "string" || value.data.length === 0 || value.data.length % 4 !== 0) throw new TypeError("Continuation data must be positive canonical base64");
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== value.data) throw new TypeError("Continuation data is not its canonical base64 encoding");
    const next = RuntimeRequestContinuationReference.fromStored(value.next);
    if (value.blockId !== continuationBlockIdentity({ executionId: value.executionId, parentBlockId, sectionDigest, offset: value.offset })) {
      throw new TypeError("Continuation storage identity differs from its exact scope and offset");
    }
    super({ version: value.version, executionId: value.executionId, blockId: value.blockId, kind: value.kind,
      parentBlockId, sectionDigest, offset: value.offset, next, data: value.data }, "completion-continuation");
    this.parentBlockId = parentBlockId; this.sectionDigest = sectionDigest; this.offset = value.offset;
    this.next = next; this.data = value.data; this.#bytes = bytes;
    Object.freeze(this);
  }
  get byteLength() { return this.#bytes.length; }
  get bytes() { return Buffer.from(this.#bytes); }
}

/** The physical carrier encoder is shared by the concrete logical subclass. */
class RuntimeRequestContinuedBlockEncoding {
  constructor(carrier) {
    if (!(carrier instanceof RuntimeRequestCompletionCarrier)) throw new TypeError("Continued encoding requires its typed carrier");
    this.carrier = carrier; this.byteLength = carrier.encodedByteLength(); Object.freeze(this);
  }
  text() { return this.carrier.payloadText(); }
  recordText() { return this.carrier.encodedRecord(); }
  toJSON() { return this.carrier.toJSON(); }
}

function physicalMaximum(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Physical request byte limit must be positive and safe");
  return value;
}

/** One scope owns deterministic IDs and the actual physical-envelope sizer. */
class RuntimeRequestContinuationScope {
  constructor(executionId, parentBlockId, sectionDigest) {
    this.executionId = uuid(executionId, "continued completion execution ID");
    this.parentBlockId = uuid(parentBlockId, "continued completion storage ID");
    this.sectionDigest = digestValue(sectionDigest, "Continued completion section");
    Object.freeze(this);
  }
  identity(offset) { return continuationBlockIdentity({ ...this, offset }); }
  record(offset, bytes, next) {
    return new RuntimeRequestContinuationBlock({ version: 9, executionId: this.executionId, blockId: this.identity(offset),
      kind: "completion-continuation", parentBlockId: this.parentBlockId, sectionDigest: this.sectionDigest,
      offset, next, data: bytes.toString("base64") });
  }
  capacity(offset, hasNext, maximumBytes) {
    // This size-only next reference has the same fixed tuple width as the real
    // next payload commitment. It never escapes as a planned or stored record.
    const next = hasNext ? new RuntimeRequestContinuationReference({ blockId: this.identity(offset + 1), digest: this.sectionDigest }) : null;
    const one = this.record(offset, Buffer.from([0]), next);
    // Canonical base64 is unescaped ASCII. Four encoded characters hold up to
    // three raw bytes; all other bytes come from this SAME physical encoder.
    const overhead = one.encodedByteLength() - 4;
    const capacity = 3 * Math.floor((maximumBytes - overhead) / 4);
    if (capacity <= 0) throw new RangeError("A continuation cannot fit its physical byte limit");
    return capacity;
  }
  pieceLength(offset, remaining, maximumBytes) {
    if (remaining <= this.capacity(offset, false, maximumBytes)) return remaining;
    return this.capacity(offset, true, maximumBytes);
  }
}

/** One trusted producer layout slice, without a full expanded section string. */
class RuntimeRequestContinuationSlice {
  constructor(offset, byteLength) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new TypeError("Continuation slice requires a safe offset and positive byte length");
    }
    this.offset = offset; this.byteLength = byteLength; Object.freeze(this);
  }
}

function completionHeader(executionId, blockId, section) {
  return { version: 9, executionId, blockId, kind: "completion", sections: [section] };
}

/** Existing logical section APIs with independently bounded physical records. */
export class RuntimeRequestContinuedCompletionBlock extends RuntimeRequestCompletionBlock {
  constructor(value, carrier, records, maximumBytes, authority) {
    if (authority !== continuedBlockAuthority) throw new TypeError("Continued completion requires its validated codec chain");
    super(value, continuedBlockAuthority, carrier);
    this.physicalDependencies = Object.freeze([...records]);
    this.physicalRecords = Object.freeze([...records].reverse().concat(carrier));
    this.maximumBytes = maximumBytes;
    Object.freeze(this);
  }
  append(section) {
    // Return a REGULAR candidate. Its full logical encoded size, never its
    // small carrier, participates in the existing ordinary packing decision.
    return new RuntimeRequestCompletionBlock({ version: this.version, executionId: this.executionId, blockId: this.blockId,
      kind: "completion", sections: [...this.sections, section] });
  }
}

/** Incremental pure physical resolver; callers retain all filesystem duties. */
export class RuntimeRequestContinuationChain {
  #carrier;
  #scope;
  #maximumBytes;
  #next;
  #offset = 0;
  #seen = new Set();
  #records = [];
  #restored = null;
  #evidenceCodec;
  constructor(carrier, { maximumBytes = DEFAULT_PHYSICAL_RECORD_MAX_BYTES, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE } = {}) {
    if (!(carrier instanceof RuntimeRequestCompletionCarrier)) throw new TypeError("Continuation chain requires its typed carrier");
    this.#carrier = carrier; this.#maximumBytes = physicalMaximum(maximumBytes);
    this.#evidenceCodec = evidenceCodec;
    if (carrier.encodedByteLength() > this.#maximumBytes) throw new RangeError("Completion carrier exceeds its physical byte limit");
    this.#scope = new RuntimeRequestContinuationScope(carrier.executionId, carrier.blockId, carrier.sectionDigest);
    if (carrier.first.blockId !== this.#scope.identity(0) || carrier.first.blockId === carrier.blockId) throw new TypeError("Carrier first continuation has another storage scope");
    this.#next = carrier.first;
  }
  get nextReference() { return this.#next; }
  append(record) {
    if (this.#next === null || this.#restored !== null) throw new TypeError("Continuation chain has an unused extra record");
    if (!(record instanceof RuntimeRequestContinuationBlock) || !this.#next.matches(record.reference())) throw new TypeError("Continuation differs from its complete physical payload commitment");
    if (record.executionId !== this.#carrier.executionId || record.parentBlockId !== this.#carrier.blockId
      || record.sectionDigest !== this.#carrier.sectionDigest || record.offset !== this.#offset
      || this.#seen.has(record.blockId) || record.blockId === this.#carrier.blockId) throw new TypeError("Continuation has a duplicate, cycle, gap or foreign scope");
    if (record.encodedByteLength() > this.#maximumBytes) throw new RangeError("Continuation exceeds its physical byte limit");
    const remaining = this.#carrier.byteLength - this.#offset;
    if (remaining <= 0 || record.byteLength !== this.#scope.pieceLength(this.#offset, remaining, this.#maximumBytes)) {
      throw new TypeError("Continuation is not its exact maximum-fit positive piece");
    }
    const finished = record.byteLength === remaining;
    if (finished !== (record.next === null)) throw new TypeError("Continuation tail does not match its exact remaining length");
    this.#seen.add(record.blockId);
    if (record.next !== null && (record.next.blockId === this.#carrier.blockId || this.#seen.has(record.next.blockId)
      || record.next.blockId !== this.#scope.identity(this.#offset + record.byteLength))) throw new TypeError("Continuation next link has a cycle or another offset identity");
    this.#records.push(record); this.#offset += record.byteLength; this.#next = record.next;
    return this;
  }
  restore() {
    if (this.#restored !== null) return this.#restored;
    if (this.#next !== null || this.#offset !== this.#carrier.byteLength) throw new TypeError("Continued completion is missing required physical pieces");
    // Declared total never allocates a buffer before actual positive pieces are
    // checked. A codepoint may cross any physical piece boundary.
    const bytes = Buffer.concat(this.#records.map((record) => record.bytes)), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || ProcessExecutionValueEncoding.digestParts([text]) !== this.#carrier.sectionDigest) {
      throw new TypeError("Continued completion differs from its exact UTF8 or original section SHA256");
    }
    const section = new RuntimeRequestCompletionSection(JSON.parse(text), this.#evidenceCodec);
    if (section.executionId !== this.#carrier.executionId || section.digest !== this.#carrier.sectionDigest
      || section.byteLength !== this.#carrier.byteLength || !section.matchesEncodedBytes(bytes)) throw new TypeError("Continued completion differs from its complete original typed canonical section");
    const value = completionHeader(this.#carrier.executionId, this.#carrier.blockId, section);
    if (RuntimeRequestBlockEncoding.literalByteLength(value) <= this.#maximumBytes) throw new TypeError("A fitting ordinary completion cannot use a carrier");
    this.#restored = new RuntimeRequestContinuedCompletionBlock(value, this.#carrier, this.#records, this.#maximumBytes, continuedBlockAuthority);
    return this.#restored;
  }
  static restore(carrier, records, options) {
    const chain = new this(carrier, options);
    for (const record of records) chain.append(record);
    return chain.restore();
  }
}

/** Ordinary records stay identical; only an oversized singleton is continued. */
export class RuntimeRequestBlockEncodingPlan {
  constructor(logicalBlock, physicalRecords, authority) {
    if (authority !== encodingPlanAuthority) throw new TypeError("Request encoding plans require the codec factory");
    this.logicalBlock = logicalBlock; this.physicalRecords = Object.freeze([...physicalRecords]); Object.freeze(this);
  }
  static create(block, { maximumBytes = DEFAULT_PHYSICAL_RECORD_MAX_BYTES } = {}) {
    maximumBytes = physicalMaximum(maximumBytes);
    if (!(block instanceof RuntimeRequestBlock)) throw new TypeError("Request encoding plan requires a logical request block");
    if (block instanceof RuntimeRequestContinuedCompletionBlock) {
      if (block.maximumBytes === maximumBytes) return new this(block, block.physicalRecords, encodingPlanAuthority);
      block = new RuntimeRequestCompletionBlock(completionHeader(block.executionId, block.blockId, block.sections[0]));
    }
    if (block.encodedByteLength() <= maximumBytes) return new this(block, [block], encodingPlanAuthority);
    if (!(block instanceof RuntimeRequestCompletionBlock) || block.sections.length !== 1) throw new RangeError("Only an oversized single completion can use continuations");
    const section = block.sections[0], scope = new RuntimeRequestContinuationScope(block.executionId, block.blockId, section.digest);
    const slices = [];
    for (let offset = 0; offset < section.byteLength;) {
      const length = scope.pieceLength(offset, section.byteLength - offset, maximumBytes);
      slices.push(new RuntimeRequestContinuationSlice(offset, length)); offset += length;
    }
    const chunks = []; let index = 0, used = 0, current = Buffer.alloc(slices[0].byteLength);
    section.visitEncodedParts((part) => {
      const bytes = Buffer.from(part, "utf8"); let consumed = 0;
      while (consumed < bytes.length) {
        const count = Math.min(current.length - used, bytes.length - consumed);
        bytes.copy(current, used, consumed, consumed + count); used += count; consumed += count;
        if (used === current.length) {
          chunks.push(current); index++; used = 0;
          current = index < slices.length ? Buffer.alloc(slices[index].byteLength) : null;
        }
      }
    });
    if (chunks.length !== slices.length || used !== 0) throw new TypeError("Completion producer bytes differ from their original encoded length");
    const physical = [], physicalIds = new Set([block.blockId]); let next = null;
    for (let i = slices.length - 1; i >= 0; i--) {
      const record = scope.record(slices[i].offset, chunks[i], next);
      if (physicalIds.has(record.blockId)) throw new TypeError("Continuation storage identities collide inside the physical plan");
      physicalIds.add(record.blockId);
      if (record.encodedByteLength() > maximumBytes) throw new RangeError("Continuation exceeds its physical byte limit");
      physical.push(record); next = record.reference();
    }
    const carrier = new RuntimeRequestCompletionCarrier({ version: 9, executionId: block.executionId, blockId: block.blockId,
      kind: "completion-carrier", sectionDigest: section.digest, byteLength: section.byteLength, first: next });
    if (carrier.encodedByteLength() > maximumBytes) throw new RangeError("Completion carrier exceeds its physical byte limit");
    const records = [...physical].reverse();
    const logical = new RuntimeRequestContinuedCompletionBlock(completionHeader(block.executionId, block.blockId, section), carrier, records, maximumBytes, continuedBlockAuthority);
    return new this(logical, [...physical, carrier], encodingPlanAuthority);
  }
}
