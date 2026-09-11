import { createHash } from "node:crypto";

export const GLOBAL_PROMPT_ELEMENT_HARD_MAX = 120_000;

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty text`);
  return value;
}

function safeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function asRequestLimit(limit) {
  if (limit instanceof PromptRequestLimit) return limit;
  if (Number.isSafeInteger(limit)) return new PromptRequestLimit({ maxCharacters: limit });
  throw new TypeError("Prompt request limit is invalid");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonText(value) {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function renderedLength(element) {
  return element.toPromptText().length;
}

function safeSliceEnd(text, start, requestedEnd) {
  let end = requestedEnd;
  if (end < text.length
    && end > start
    && /[\uD800-\uDBFF]/.test(text[end - 1])
    && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
  return end;
}

function cloneAndFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneAndFreeze(entry);
  return Object.freeze(copy);
}

export function normalizePromptRequest(request) {
  if (typeof request === "string") {
    return Object.freeze({ systemPrompt: null, userPrompt: request, jsonSchema: null, fmtFallback: null });
  }
  if (!request || typeof request !== "object" || typeof request.userPrompt !== "string") {
    throw new TypeError("Prompt envelope must build a PromptBuilder request or a string");
  }
  return Object.freeze({
    systemPrompt: request.systemPrompt ?? null,
    userPrompt: request.userPrompt,
    jsonSchema: cloneAndFreeze(request.jsonSchema ?? null),
    fmtFallback: request.fmtFallback ?? null,
  });
}

export class PromptBatchingError extends Error {
  constructor(codeOrOptions, message, details = {}) {
    const options = typeof codeOrOptions === "string"
      ? { code: codeOrOptions, message, details }
      : codeOrOptions;
    const code = requiredText(options?.code, "Prompt failure code");
    super(options?.message || code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.failureCode = code;
    this.details = cloneAndFreeze(options?.details || {});
  }
}

function failureClass(name, code) {
  return class extends PromptBatchingError {
    constructor(message = code, details = {}, cause) {
      super({ code, message, details, cause });
      this.name = name;
    }
  };
}

export const PromptElementTooLargeFailure = failureClass("PromptElementTooLargeFailure", "PROMPT_ELEMENT_TOO_LARGE");
export const PromptPartitionNoProgressFailure = failureClass("PromptPartitionNoProgressFailure", "PROMPT_PARTITION_NO_PROGRESS");
export const PromptFixedContextTooLargeFailure = failureClass("PromptFixedContextTooLargeFailure", "PROMPT_FIXED_CONTEXT_TOO_LARGE");
export const PromptCoverageInvalidFailure = failureClass("PromptCoverageInvalidFailure", "PROMPT_COVERAGE_INVALID");
export const PromptBatchOverflowFailure = failureClass("PromptBatchOverflowFailure", "PROMPT_BATCH_OVERFLOW");
export const PromptInvocationProjectionOverflowFailure = failureClass("PromptInvocationProjectionOverflowFailure", "PROMPT_INVOCATION_PROJECTION_OVERFLOW");
export const PromptBatchCountExceededFailure = failureClass("PromptBatchCountExceededFailure", "PROMPT_BATCH_COUNT_EXCEEDED");
export const PromptCallLimitExceededFailure = failureClass("PromptCallLimitExceededFailure", "PROMPT_CALL_LIMIT_EXCEEDED");
export const PromptResponseTooLargeFailure = failureClass("PromptResponseTooLargeFailure", "PROMPT_RESPONSE_TOO_LARGE");
export const PromptResponseInvalidFailure = failureClass("PromptResponseInvalidFailure", "PROMPT_RESPONSE_INVALID");
export const PromptResponseCoverageInvalidFailure = failureClass("PromptResponseCoverageInvalidFailure", "PROMPT_RESPONSE_COVERAGE_INVALID");
export const PromptBatchExecutionIncompleteFailure = failureClass("PromptBatchExecutionIncompleteFailure", "PROMPT_BATCH_EXECUTION_INCOMPLETE");
export const PromptReductionDidNotConvergeFailure = failureClass("PromptReductionDidNotConvergeFailure", "PROMPT_REDUCTION_DID_NOT_CONVERGE");

export class PromptRequestLimit {
  constructor({ maxCharacters = GLOBAL_PROMPT_ELEMENT_HARD_MAX } = {}) {
    safeInteger(maxCharacters, "Prompt request character limit", { minimum: 1 });
    if (maxCharacters > GLOBAL_PROMPT_ELEMENT_HARD_MAX) {
      throw new RangeError(`Prompt request character limit cannot exceed ${GLOBAL_PROMPT_ELEMENT_HARD_MAX}`);
    }
    this.maxCharacters = maxCharacters;
    Object.freeze(this);
  }

  allows(characterCount) {
    return Number.isSafeInteger(characterCount) && characterCount >= 0 && characterCount <= this.maxCharacters;
  }

  valueOf() {
    return this.maxCharacters;
  }
}

export class PromptCoverageEntry {
  constructor({ elementId, sourceRevision, start, end, sourceLength, status = "present" } = {}) {
    this.elementId = requiredText(elementId, "Prompt coverage element ID");
    this.sourceRevision = requiredText(sourceRevision, "Prompt coverage source revision");
    this.start = safeInteger(start, "Prompt coverage start");
    this.end = safeInteger(end, "Prompt coverage end");
    this.sourceLength = safeInteger(sourceLength, "Prompt coverage source length");
    if (this.end < this.start || this.end > this.sourceLength) throw new PromptCoverageInvalidFailure("Prompt coverage range is invalid", { elementId });
    if (!new Set(["present", "empty", "deleted", "reference", "atomic"]).has(status)) {
      throw new PromptCoverageInvalidFailure("Prompt coverage status is invalid", { elementId, status });
    }
    this.status = status;
    Object.freeze(this);
  }

  get width() {
    return this.end - this.start;
  }

  toJSON() {
    return {
      elementId: this.elementId,
      sourceRevision: this.sourceRevision,
      start: this.start,
      end: this.end,
      sourceLength: this.sourceLength,
      status: this.status,
    };
  }
}

export class PromptInputElement {
  constructor({ id, sourceRevision, sequence, originId = id } = {}) {
    this.id = requiredText(id, "Prompt element ID");
    this.originId = requiredText(originId, "Prompt element origin ID");
    this.sourceRevision = requiredText(sourceRevision, "Prompt element source revision");
    this.sequence = safeInteger(sequence, "Prompt element sequence");
  }

  toPromptText() {
    throw new Error(`${this.constructor.name}.toPromptText() is not implemented`);
  }

  isPartitionable() {
    return false;
  }

  isRepeatedContext() {
    return false;
  }

  partitionFor() {
    throw new PromptElementTooLargeFailure("Prompt element cannot be partitioned", {
      elementId: this.id,
      elementType: this.constructor.name,
    });
  }

  assertWithinHardLimit() {
    const characters = renderedLength(this);
    if (characters >= GLOBAL_PROMPT_ELEMENT_HARD_MAX) {
      throw new PromptElementTooLargeFailure("Prompt element reaches the global hard maximum", {
        elementId: this.id,
        elementType: this.constructor.name,
        renderedCharacters: characters,
        hardMaximum: GLOBAL_PROMPT_ELEMENT_HARD_MAX,
      });
    }
    return this;
  }

  coverageEntries() {
    const length = this.toPromptText().length;
    return Object.freeze([new PromptCoverageEntry({
      elementId: this.originId,
      sourceRevision: this.sourceRevision,
      start: 0,
      end: length,
      sourceLength: length,
      status: length === 0 ? "empty" : "atomic",
    })]);
  }
}

export class AtomicPromptElement extends PromptInputElement {
  constructor({ text, ...identity } = {}) {
    super(identity);
    if (typeof text !== "string") throw new TypeError("Atomic prompt element text must be a string");
    this.text = text;
    if (new.target === AtomicPromptElement) Object.freeze(this);
  }

  toPromptText() {
    return this.text;
  }
}

export class RepeatedPromptContextElement extends AtomicPromptElement {
  constructor(options) {
    super(options);
    if (new.target === RepeatedPromptContextElement) Object.freeze(this);
  }

  isRepeatedContext() {
    return true;
  }
}

export class RangedTextPromptElement extends PromptInputElement {
  constructor({ text, start = 0, end, sourceLength, status, ...identity } = {}) {
    super(identity);
    if (typeof text !== "string") throw new TypeError("Ranged prompt element text must be a string");
    const resolvedEnd = end ?? start + text.length;
    const resolvedLength = sourceLength ?? resolvedEnd;
    this.start = safeInteger(start, "Ranged prompt element start");
    this.end = safeInteger(resolvedEnd, "Ranged prompt element end");
    this.sourceLength = safeInteger(resolvedLength, "Ranged prompt element source length");
    if (this.end < this.start || this.end > this.sourceLength || this.end - this.start !== text.length) {
      throw new PromptCoverageInvalidFailure("Ranged prompt element text and range are inconsistent", { elementId: this.id });
    }
    this.status = status || (this.sourceLength === 0 ? "empty" : "present");
    if (!new Set(["present", "empty", "deleted"]).has(this.status)) throw new TypeError("Ranged prompt element status is invalid");
    if ((this.status === "empty" || this.status === "deleted") && (this.sourceLength !== 0 || text.length !== 0)) {
      throw new PromptCoverageInvalidFailure("Empty and deleted ranged elements must have a zero-width source", { elementId: this.id });
    }
    this.text = text;
    if (new.target === RangedTextPromptElement) Object.freeze(this);
  }

  toPromptText() {
    return this.text;
  }

  isPartitionable() {
    return this.end > this.start;
  }

  rangeId(start, end) {
    return `${this.originId}@${start}:${end}`;
  }

  createRange({ start, end } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < this.start || end > this.end || end < start) {
      throw new PromptCoverageInvalidFailure("Child prompt range lies outside its parent", { elementId: this.id, start, end });
    }
    return new RangedTextPromptElement({
      id: this.rangeId(start, end),
      originId: this.originId,
      sourceRevision: this.sourceRevision,
      sequence: this.sequence,
      text: this.text.slice(start - this.start, end - this.start),
      start,
      end,
      sourceLength: this.sourceLength,
      status: this.status,
    });
  }

  partitionFor(maxRenderedCharacters) {
    safeInteger(maxRenderedCharacters, "Prompt partition character budget", { minimum: 1 });
    if (!this.isPartitionable() || this.end - this.start <= 1) {
      throw new PromptElementTooLargeFailure("Prompt range cannot be made smaller", {
        elementId: this.id,
        elementType: this.constructor.name,
        renderedCharacters: renderedLength(this),
        maxRenderedCharacters,
      });
    }
    const children = [];
    let offset = this.start;
    while (offset < this.end) {
      let low = offset + 1;
      let high = this.end;
      let accepted = null;
      while (low <= high) {
        const rawMiddle = Math.floor((low + high) / 2);
        const localMiddle = safeSliceEnd(this.text, offset - this.start, rawMiddle - this.start);
        const middle = this.start + localMiddle;
        if (middle <= offset) {
          low = rawMiddle + 1;
          continue;
        }
        const child = this.createRange({ start: offset, end: middle });
        if (renderedLength(child) <= maxRenderedCharacters) {
          accepted = child;
          low = rawMiddle + 1;
        } else {
          high = rawMiddle - 1;
        }
      }
      if (accepted === null) {
        throw new PromptElementTooLargeFailure("The smallest prompt range exceeds its character budget", {
          elementId: this.id,
          elementType: this.constructor.name,
          maxRenderedCharacters,
        });
      }
      if (accepted.end < this.end) {
        const acceptedLocalEnd = accepted.end - this.start;
        const newline = this.text.lastIndexOf("\n", acceptedLocalEnd - 1);
        const lineEnd = newline + 1 + this.start;
        if (newline >= offset - this.start && lineEnd > offset) {
          const lineChild = this.createRange({ start: offset, end: lineEnd });
          if (renderedLength(lineChild) <= maxRenderedCharacters) accepted = lineChild;
        }
      }
      children.push(accepted);
      offset = accepted.end;
    }
    return new PromptElementPartition({ parent: this, children });
  }

  coverageEntries() {
    return Object.freeze([new PromptCoverageEntry({
      elementId: this.originId,
      sourceRevision: this.sourceRevision,
      start: this.start,
      end: this.end,
      sourceLength: this.sourceLength,
      status: this.status,
    })]);
  }
}

export class PartitionedPromptPayloadElement extends RangedTextPromptElement {
  constructor(options) {
    super(options);
    if (new.target === PartitionedPromptPayloadElement) Object.freeze(this);
  }
}

export class PromptReferenceElement extends PromptInputElement {
  constructor({ path, digest: referenceDigest, byteLength, authorization, renderReference, ...identity } = {}) {
    super(identity);
    this.path = requiredText(path, "Prompt reference path");
    this.digest = requiredText(referenceDigest, "Prompt reference digest");
    this.byteLength = safeInteger(byteLength, "Prompt reference byte length");
    this.authorization = requiredText(authorization, "Prompt reference authorization");
    if (renderReference !== undefined && typeof renderReference !== "function") throw new TypeError("Prompt reference renderer must be a function");
    this._renderReference = renderReference || null;
    if (new.target === PromptReferenceElement) Object.freeze(this);
  }

  toPromptText() {
    if (this._renderReference) return String(this._renderReference(this));
    return JSON.stringify({ path: this.path, digest: this.digest, byteLength: this.byteLength, authorization: this.authorization });
  }

  coverageEntries() {
    return Object.freeze([new PromptCoverageEntry({
      elementId: this.originId,
      sourceRevision: this.sourceRevision,
      start: 0,
      end: 0,
      sourceLength: 0,
      status: "reference",
    })]);
  }
}

export class PromptElementPartition {
  constructor({ parent, children } = {}) {
    if (!(parent instanceof PromptInputElement)) throw new TypeError("Prompt partition requires a typed parent element");
    if (!Array.isArray(children) || children.length === 0 || children.some((child) => !(child instanceof PromptInputElement))) {
      throw new PromptPartitionNoProgressFailure("Prompt partition requires typed children", { elementId: parent.id });
    }
    if (children.some((child) => child.originId !== parent.originId || child.sourceRevision !== parent.sourceRevision || child.sequence !== parent.sequence)) {
      throw new PromptCoverageInvalidFailure("Prompt partition contains a foreign child", { elementId: parent.id });
    }
    if (new Set(children.map((child) => child.id)).size !== children.length) {
      throw new PromptCoverageInvalidFailure("Prompt partition contains duplicate child IDs", { elementId: parent.id });
    }
    const parentCoverage = parent.coverageEntries();
    const childCoverage = children.flatMap((child) => child.coverageEntries());
    if (parentCoverage.length !== 1 || childCoverage.some((entry) => entry.elementId !== parent.originId)) {
      throw new PromptCoverageInvalidFailure("Prompt partition coverage identity is invalid", { elementId: parent.id });
    }
    const expected = parentCoverage[0];
    let nextStart = expected.start;
    for (const entry of childCoverage) {
      if (entry.start !== nextStart || entry.end < entry.start || entry.sourceLength !== expected.sourceLength || entry.status !== expected.status) {
        throw new PromptCoverageInvalidFailure("Prompt partition coverage is not complete and continuous", { elementId: parent.id });
      }
      nextStart = entry.end;
    }
    if (nextStart !== expected.end) throw new PromptCoverageInvalidFailure("Prompt partition coverage is incomplete", { elementId: parent.id });
    const parentWidth = expected.width;
    if (children.some((child) => {
      const coverage = child.coverageEntries()[0];
      return child.id === parent.id
        || (parent instanceof RangedTextPromptElement && coverage.width >= parentWidth)
        || (coverage.width >= parentWidth && renderedLength(child) >= renderedLength(parent));
    })) {
      throw new PromptPartitionNoProgressFailure("Prompt partition did not strictly reduce its parent", { elementId: parent.id });
    }
    if (parent instanceof RangedTextPromptElement) {
      const reconstructed = children.map((child) => child.text).join("");
      if (reconstructed !== parent.text) throw new PromptCoverageInvalidFailure("Prompt partition text does not reconstruct its parent", { elementId: parent.id });
    }
    this.parent = parent;
    this.children = Object.freeze([...children]);
    Object.freeze(this);
  }
}

export class PromptLogicalFootprint {
  constructor({ systemPrompt = 0, userPrompt = 0, jsonSchema = 0, fmtFallback = 0, separators = 0 } = {}) {
    this.systemPrompt = safeInteger(systemPrompt, "System prompt footprint");
    this.userPrompt = safeInteger(userPrompt, "User prompt footprint");
    this.jsonSchema = safeInteger(jsonSchema, "JSON schema footprint");
    this.fmtFallback = safeInteger(fmtFallback, "Format fallback footprint");
    this.separators = safeInteger(separators, "Prompt separator footprint");
    this.total = this.systemPrompt + this.userPrompt + this.jsonSchema + this.fmtFallback + this.separators;
    Object.freeze(this);
  }

  static measure(request) {
    if (request instanceof PromptLogicalFootprint) return request;
    if (typeof request === "string") return new PromptLogicalFootprint({ userPrompt: request.length });
    const systemPrompt = String(request?.systemPrompt || "");
    const userPrompt = String(request?.userPrompt || "");
    const fmtFallback = String(request?.fmtFallback || "");
    return new PromptLogicalFootprint({
      systemPrompt: systemPrompt.length,
      userPrompt: userPrompt.length,
      jsonSchema: jsonText(request?.jsonSchema).length,
      fmtFallback: fmtFallback.length,
      separators: (systemPrompt && userPrompt ? 2 : 0) + (fmtFallback && (systemPrompt || userPrompt) ? 2 : 0),
    });
  }

  fits(limit) {
    return asRequestLimit(limit).allows(this.total);
  }

  toJSON() {
    return {
      systemPrompt: this.systemPrompt,
      userPrompt: this.userPrompt,
      jsonSchema: this.jsonSchema,
      fmtFallback: this.fmtFallback,
      separators: this.separators,
      total: this.total,
    };
  }
}

export class PromptBatchContext {
  constructor({ index, count, singleShot = count === 1, groupId = "linear", coverage = [] } = {}) {
    this.index = safeInteger(index, "Prompt batch index");
    this.count = safeInteger(count, "Prompt batch count", { minimum: 1 });
    this.singleShot = Boolean(singleShot);
    this.groupId = requiredText(groupId, "Prompt batch group ID");
    if (!Array.isArray(coverage) || coverage.some((entry) => !(entry instanceof PromptCoverageEntry))) {
      throw new TypeError("Prompt batch context coverage must contain typed entries");
    }
    this.coverage = Object.freeze([...coverage]);
    Object.freeze(this);
  }
}

export class PromptRequestEnvelope {
  constructor({ revision = "1", build } = {}) {
    this.revision = requiredText(revision, "Prompt envelope revision");
    if (build !== undefined && typeof build !== "function") throw new TypeError("Prompt envelope builder must be a function");
    this._build = build || null;
  }

  build(elements, chunkContext) {
    if (this._build === null) throw new Error(`${this.constructor.name}.build() is not implemented`);
    return this._build(elements, chunkContext);
  }

  buildRequest(elements, chunkContext) {
    if (!Array.isArray(elements) || elements.some((element) => !(element instanceof PromptInputElement))) {
      throw new TypeError("Prompt envelope elements must be typed");
    }
    if (!(chunkContext instanceof PromptBatchContext)) throw new TypeError("Prompt envelope requires typed batch context");
    return normalizePromptRequest(this.build(Object.freeze([...elements]), chunkContext));
  }
}

function assertUniqueElements(elements) {
  const ids = new Set();
  const sequences = new Set();
  for (const element of elements) {
    if (ids.has(element.id)) throw new PromptCoverageInvalidFailure("Prompt element IDs must be unique", { elementId: element.id });
    if (sequences.has(element.sequence)) throw new PromptCoverageInvalidFailure("Prompt element sequences must be unique", { sequence: element.sequence });
    ids.add(element.id);
    sequences.add(element.sequence);
  }
}

function assertElementCoverage(originalElements, leafElements) {
  const originals = new Map(originalElements.map((element) => [element.id, element]));
  const byOrigin = new Map();
  for (const leaf of leafElements) {
    if (!originals.has(leaf.originId)) throw new PromptCoverageInvalidFailure("Prompt collection contains a foreign leaf", { elementId: leaf.id });
    const entries = byOrigin.get(leaf.originId) || [];
    entries.push(leaf);
    byOrigin.set(leaf.originId, entries);
  }
  for (const original of originalElements) {
    const leaves = byOrigin.get(original.id) || [];
    if (leaves.length === 0) throw new PromptCoverageInvalidFailure("Prompt collection omits an original element", { elementId: original.id });
    const expected = original.coverageEntries();
    const actual = leaves.flatMap((leaf) => leaf.coverageEntries());
    if (expected.length !== 1 || actual.length !== leaves.length) {
      throw new PromptCoverageInvalidFailure("Prompt collection coverage cardinality is invalid", { elementId: original.id });
    }
    let nextStart = expected[0].start;
    for (const entry of actual) {
      if (entry.elementId !== original.id
        || entry.sourceRevision !== expected[0].sourceRevision
        || entry.sourceLength !== expected[0].sourceLength
        || entry.status !== expected[0].status
        || entry.start !== nextStart) {
        throw new PromptCoverageInvalidFailure("Prompt collection coverage is discontinuous", { elementId: original.id });
      }
      nextStart = entry.end;
    }
    if (nextStart !== expected[0].end) throw new PromptCoverageInvalidFailure("Prompt collection coverage is incomplete", { elementId: original.id });
    if (original instanceof RangedTextPromptElement && leaves.map((leaf) => leaf.text).join("") !== original.text) {
      throw new PromptCoverageInvalidFailure("Prompt collection leaves do not reconstruct their source", { elementId: original.id });
    }
  }
}

function collectionDigest(originalElements, leafElements) {
  return digest(JSON.stringify({
    original: originalElements.map((element) => ({
      id: element.id,
      sourceRevision: element.sourceRevision,
      sequence: element.sequence,
      coverage: element.coverageEntries().map((entry) => entry.toJSON()),
      text: element.toPromptText(),
    })),
    leaves: leafElements.map((element) => ({
      id: element.id,
      originId: element.originId,
      coverage: element.coverageEntries().map((entry) => entry.toJSON()),
      text: element.toPromptText(),
    })),
  }));
}

export class PromptInputCollection {
  constructor({ originalElements, elements, limit } = {}) {
    if (!Array.isArray(originalElements) || originalElements.some((entry) => !(entry instanceof PromptInputElement))) {
      throw new TypeError("Prompt collection requires typed original elements");
    }
    if (!Array.isArray(elements) || elements.some((entry) => !(entry instanceof PromptInputElement))) {
      throw new TypeError("Prompt collection requires typed leaf elements");
    }
    assertUniqueElements(originalElements);
    if (new Set(elements.map((element) => element.id)).size !== elements.length) {
      throw new PromptCoverageInvalidFailure("Prompt collection leaf IDs must be unique");
    }
    assertElementCoverage(originalElements, elements);
    elements.forEach((element) => element.assertWithinHardLimit());
    this.originalElements = Object.freeze([...originalElements]);
    this.elements = Object.freeze([...elements]);
    this.limit = asRequestLimit(limit);
    this.digest = collectionDigest(this.originalElements, this.elements);
    Object.freeze(this);
  }

  get repeatedElements() {
    return Object.freeze(this.elements.filter((element) => element.isRepeatedContext()));
  }

  get payloadElements() {
    return Object.freeze(this.elements.filter((element) => !element.isRepeatedContext()));
  }

  toJSON() {
    return {
      digest: this.digest,
      elements: this.elements.map((element) => ({
        id: element.id,
        originId: element.originId,
        sourceRevision: element.sourceRevision,
        sequence: element.sequence,
        coverage: element.coverageEntries().map((entry) => entry.toJSON()),
      })),
    };
  }
}

function buildEnvelopeRequest(envelope, elements, { index = 0, count = 1, groupId = "linear" } = {}) {
  const coverage = elements.flatMap((element) => element.coverageEntries());
  const context = new PromptBatchContext({ index, count, groupId, coverage });
  const request = envelope.buildRequest(elements, context);
  return { request, footprint: PromptLogicalFootprint.measure(request), context };
}

function splitRangedElementToFit({ element, contexts, envelope, limit, index = 0, count = 1, groupId = "linear" }) {
  const children = [];
  let offset = element.start;
  while (offset < element.end) {
    let low = offset + 1;
    let high = element.end;
    let accepted = null;
    while (low <= high) {
      const rawMiddle = Math.floor((low + high) / 2);
      const localMiddle = safeSliceEnd(element.text, offset - element.start, rawMiddle - element.start);
      const middle = element.start + localMiddle;
      if (middle <= offset) {
        low = rawMiddle + 1;
        continue;
      }
      const child = element.createRange({ start: offset, end: middle });
      const selected = [...contexts, child].sort((left, right) => left.sequence - right.sequence);
      if (renderedLength(child) < GLOBAL_PROMPT_ELEMENT_HARD_MAX
        && buildEnvelopeRequest(envelope, selected, { index, count, groupId }).footprint.fits(limit)) {
        accepted = child;
        low = rawMiddle + 1;
      } else high = rawMiddle - 1;
    }
    if (accepted === null) {
      throw new PromptElementTooLargeFailure("The smallest prompt range cannot fit in its request envelope", {
        elementId: element.id,
        maxCharacters: limit.maxCharacters,
      });
    }
    if (accepted.end < element.end) {
      const acceptedLocalEnd = accepted.end - element.start;
      const newline = element.text.lastIndexOf("\n", acceptedLocalEnd - 1);
      const lineEnd = newline + 1 + element.start;
      if (newline >= offset - element.start && lineEnd > offset) {
        const lineChild = element.createRange({ start: offset, end: lineEnd });
        const selected = [...contexts, lineChild].sort((left, right) => left.sequence - right.sequence);
        if (renderedLength(lineChild) < GLOBAL_PROMPT_ELEMENT_HARD_MAX
          && buildEnvelopeRequest(envelope, selected, { index, count, groupId }).footprint.fits(limit)) accepted = lineChild;
      }
    }
    children.push(accepted);
    offset = accepted.end;
  }
  return new PromptElementPartition({ parent: element, children }).children;
}

export class PromptInputBuilder {
  constructor({ envelope, limit = new PromptRequestLimit() } = {}) {
    if (!(envelope instanceof PromptRequestEnvelope)) throw new TypeError("Prompt input builder requires a typed envelope");
    this.envelope = envelope;
    this.limit = asRequestLimit(limit);
    this._elements = [];
    this._built = false;
  }

  add(element) {
    if (this._built) throw new Error("Prompt input builder has already been built");
    if (!(element instanceof PromptInputElement)) throw new TypeError("Prompt input builder accepts only PromptInputElement values");
    if (this._elements.some((entry) => entry.id === element.id)) {
      throw new PromptCoverageInvalidFailure("Prompt element ID is duplicated", { elementId: element.id });
    }
    if (this._elements.some((entry) => entry.sequence === element.sequence)) {
      throw new PromptCoverageInvalidFailure("Prompt element sequence is duplicated", { sequence: element.sequence });
    }
    this._elements.push(element);
    return this;
  }

  _partitionToFit(element, repeatedElements) {
    const alone = [...repeatedElements, element].sort((left, right) => left.sequence - right.sequence);
    const { footprint } = buildEnvelopeRequest(this.envelope, alone);
    if (renderedLength(element) < GLOBAL_PROMPT_ELEMENT_HARD_MAX && footprint.fits(this.limit)) return [element];
    if (!element.isPartitionable()) {
      throw new PromptElementTooLargeFailure("An indivisible prompt element cannot fit its request", {
        elementId: element.id,
        elementType: element.constructor.name,
        renderedCharacters: renderedLength(element),
        footprint: footprint.toJSON(),
        maxCharacters: this.limit.maxCharacters,
      });
    }
    if (element instanceof RangedTextPromptElement) {
      return splitRangedElementToFit({
        element,
        contexts: repeatedElements,
        envelope: this.envelope,
        limit: this.limit,
      });
    }
    const fixed = buildEnvelopeRequest(this.envelope, repeatedElements).footprint;
    const available = Math.min(
      GLOBAL_PROMPT_ELEMENT_HARD_MAX - 1,
      Math.max(1, this.limit.maxCharacters - fixed.total),
      Math.max(1, renderedLength(element) - 1),
    );
    const partition = element.partitionFor(available);
    if (!(partition instanceof PromptElementPartition)) {
      throw new PromptPartitionNoProgressFailure("Prompt partitioner returned an untyped result", { elementId: element.id });
    }
    const pending = partition.children.map((child) => ({ child, depth: 1 }));
    const fitted = [];
    while (pending.length > 0) {
      const { child, depth } = pending.shift();
      const selected = [...repeatedElements, child].sort((left, right) => left.sequence - right.sequence);
      if (renderedLength(child) < GLOBAL_PROMPT_ELEMENT_HARD_MAX
        && buildEnvelopeRequest(this.envelope, selected).footprint.fits(this.limit)) {
        fitted.push(child);
        continue;
      }
      if (depth >= 64) {
        throw new PromptPartitionNoProgressFailure("Prompt partition exceeded its maximum refinement depth", {
          elementId: child.id,
          depth,
        });
      }
      const refined = child.partitionFor(Math.min(available, Math.max(1, renderedLength(child) - 1)));
      if (!(refined instanceof PromptElementPartition)) {
        throw new PromptPartitionNoProgressFailure("Prompt partitioner returned an untyped refinement", { elementId: child.id });
      }
      pending.unshift(...refined.children.map((entry) => ({ child: entry, depth: depth + 1 })));
    }
    return Object.freeze(fitted);
  }

  build() {
    if (this._built) throw new Error("Prompt input builder has already been built");
    this._built = true;
    const originals = [...this._elements].sort((left, right) => left.sequence - right.sequence);
    assertUniqueElements(originals);
    const repeated = originals.filter((element) => element.isRepeatedContext());
    repeated.forEach((element) => element.assertWithinHardLimit());
    const fixed = buildEnvelopeRequest(this.envelope, repeated).footprint;
    if (!fixed.fits(this.limit)) {
      throw new PromptFixedContextTooLargeFailure("The fixed prompt context exceeds its request limit", {
        footprint: fixed.toJSON(),
        maxCharacters: this.limit.maxCharacters,
        elementIds: repeated.map((element) => element.id),
      });
    }
    const leaves = [];
    for (const element of originals) {
      if (element.isRepeatedContext()) leaves.push(element);
      else leaves.push(...this._partitionToFit(element, repeated));
    }
    leaves.sort((left, right) => left.sequence - right.sequence || left.coverageEntries()[0].start - right.coverageEntries()[0].start);
    return new PromptInputCollection({ originalElements: originals, elements: leaves, limit: this.limit });
  }
}

export class PromptBatchGroup {
  constructor({ id, contextElements = [], payloadElements = [] } = {}) {
    this.id = requiredText(id, "Prompt batch group ID");
    if (!Array.isArray(contextElements) || contextElements.some((entry) => !(entry instanceof PromptInputElement))) {
      throw new TypeError("Prompt batch group context must contain typed elements");
    }
    if (!Array.isArray(payloadElements) || payloadElements.some((entry) => !(entry instanceof PromptInputElement))) {
      throw new TypeError("Prompt batch group payload must contain typed elements");
    }
    if (new Set([...contextElements, ...payloadElements].map((entry) => entry.id)).size !== contextElements.length + payloadElements.length) {
      throw new PromptCoverageInvalidFailure("Prompt batch group contains duplicate elements", { groupId: this.id });
    }
    this.contextElements = Object.freeze([...contextElements].sort((left, right) => left.sequence - right.sequence));
    this.payloadElements = Object.freeze([...payloadElements].sort((left, right) => left.sequence - right.sequence));
    if (new.target === PromptBatchGroup) Object.freeze(this);
  }
}

export class PromptScopedBinding extends PromptBatchGroup {
  constructor({ id, scopeElements = [], payloadElements = [] } = {}) {
    super({ id, contextElements: scopeElements, payloadElements });
    this.scopeElements = this.contextElements;
    Object.freeze(this);
  }
}

export class PromptBatchTopology {
  groupsFor() {
    throw new Error(`${this.constructor.name}.groupsFor() is not implemented`);
  }

  assertCoverage(collection, groups) {
    const expected = collection.payloadElements.map((element) => element.id);
    const actual = groups.flatMap((group) => group.payloadElements.map((element) => element.id));
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new PromptCoverageInvalidFailure("Prompt topology does not cover collection payload exactly once");
    }
  }
}

export class LinearPromptBatchTopology extends PromptBatchTopology {
  groupsFor(collection) {
    if (!(collection instanceof PromptInputCollection)) throw new TypeError("Linear prompt topology requires a typed collection");
    return Object.freeze([new PromptBatchGroup({
      id: "linear",
      contextElements: collection.repeatedElements,
      payloadElements: collection.payloadElements,
    })]);
  }
}

export class GroupedPromptBatchTopology extends PromptBatchTopology {
  constructor({ groups } = {}) {
    super();
    if (!Array.isArray(groups) || groups.length === 0 || groups.some((group) => !(group instanceof PromptBatchGroup))) {
      throw new TypeError("Grouped prompt topology requires typed groups");
    }
    if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new PromptCoverageInvalidFailure("Prompt group IDs must be unique");
    this.groups = Object.freeze([...groups]);
    if (new.target === GroupedPromptBatchTopology) Object.freeze(this);
  }

  groupsFor(collection) {
    const known = new Set(collection.elements);
    if (this.groups.some((group) => [...group.contextElements, ...group.payloadElements].some((element) => !known.has(element)))) {
      throw new PromptCoverageInvalidFailure("Grouped prompt topology contains a foreign element");
    }
    const repeated = collection.repeatedElements;
    return Object.freeze(this.groups.map((group) => new PromptBatchGroup({
      id: group.id,
      contextElements: [...repeated, ...group.contextElements.filter((element) => !repeated.includes(element))],
      payloadElements: group.payloadElements,
    })));
  }

  assertCoverage(collection, groups) {
    const globalContext = new Set(collection.repeatedElements);
    const expected = collection.payloadElements.map((element) => element.id);
    const actual = groups.flatMap((group) => [
      ...group.contextElements.filter((element) => !globalContext.has(element)),
      ...group.payloadElements,
    ]).map((element) => element.id);
    if (actual.length !== expected.length
      || new Set(actual).size !== actual.length
      || expected.some((id) => !actual.includes(id))) {
      throw new PromptCoverageInvalidFailure("Grouped prompt topology must bind every collection payload exactly once");
    }
  }
}

export class ScopedCartesianPromptBatchTopology extends GroupedPromptBatchTopology {
  constructor({ bindings } = {}) {
    if (!Array.isArray(bindings) || bindings.some((binding) => !(binding instanceof PromptScopedBinding))) {
      throw new TypeError("Scoped Cartesian prompt topology requires typed bindings");
    }
    super({ groups: bindings });
    this.bindings = this.groups;
    Object.freeze(this);
  }

  assertCoverage(collection, groups) {
    const globalContext = new Set(collection.repeatedElements);
    const known = new Set(collection.payloadElements);
    const boundElements = groups.flatMap((group) => [
      ...group.contextElements.filter((element) => !globalContext.has(element)),
      ...group.payloadElements,
    ]);
    if (boundElements.some((element) => !known.has(element))) {
      throw new PromptCoverageInvalidFailure("Scoped Cartesian prompt topology contains a foreign scoped element");
    }
    const keys = groups.flatMap((group) => [
      ...group.contextElements.filter((element) => !globalContext.has(element)),
      ...group.payloadElements,
    ].map((element) => `${group.id}\0${element.id}`));
    if (new Set(keys).size !== keys.length) throw new PromptCoverageInvalidFailure("Scoped Cartesian binding is duplicated");
    const used = new Set(boundElements);
    if (collection.payloadElements.some((element) => !used.has(element))) {
      throw new PromptCoverageInvalidFailure("Scoped Cartesian topology omits a payload element");
    }
  }
}

function requestDigest(request) {
  return digest(JSON.stringify(request));
}

export class PromptBatch {
  constructor({ index, count, collectionDigest: inputDigest, groupId, contextElements, payloadElements, request, limit } = {}) {
    this.index = safeInteger(index, "Prompt batch index");
    this.count = safeInteger(count, "Prompt batch count", { minimum: 1 });
    if (this.index >= this.count) throw new TypeError("Prompt batch index must be lower than count");
    this.collectionDigest = requiredText(inputDigest, "Prompt batch collection digest");
    this.groupId = requiredText(groupId, "Prompt batch group ID");
    if (!Array.isArray(contextElements) || !Array.isArray(payloadElements)
      || [...contextElements, ...payloadElements].some((entry) => !(entry instanceof PromptInputElement))) {
      throw new TypeError("Prompt batch requires typed elements");
    }
    this.contextElements = Object.freeze([...contextElements]);
    this.payloadElements = Object.freeze([...payloadElements]);
    this.elements = Object.freeze([...contextElements, ...payloadElements].sort((left, right) => left.sequence - right.sequence));
    this.request = normalizePromptRequest(request);
    this.footprint = PromptLogicalFootprint.measure(this.request);
    const requestLimit = asRequestLimit(limit);
    if (!this.footprint.fits(requestLimit)) {
      throw new PromptBatchOverflowFailure("A planned prompt batch exceeds its request limit", {
        index: this.index,
        footprint: this.footprint.toJSON(),
        maxCharacters: requestLimit.maxCharacters,
      });
    }
    this.coverage = Object.freeze(this.payloadElements.flatMap((element) => element.coverageEntries()));
    this.digest = digest(JSON.stringify({
      collectionDigest: this.collectionDigest,
      groupId: this.groupId,
      index: this.index,
      count: this.count,
      elementIds: this.elements.map((element) => element.id),
      coverage: this.coverage.map((entry) => entry.toJSON()),
      requestDigest: requestDigest(this.request),
    }));
    Object.freeze(this);
  }
}

function replaceWithFittingRanges({ element, contexts, envelope, limit, index, count, groupId }) {
  if (!(element instanceof RangedTextPromptElement) || !element.isPartitionable()) {
    const result = buildEnvelopeRequest(envelope, [...contexts, element].sort((a, b) => a.sequence - b.sequence), { index, count, groupId });
    throw new PromptElementTooLargeFailure("An indivisible prompt element cannot fit in its planned batch", {
      elementId: element.id,
      elementType: element.constructor.name,
      footprint: result.footprint.toJSON(),
      maxCharacters: limit.maxCharacters,
    });
  }
  return splitRangedElementToFit({ element, contexts, envelope, limit, index, count, groupId });
}

function packGroups({ collection, groups, envelope, limit, countHint }) {
  const packed = [];
  for (const group of groups) {
    const queue = [...group.payloadElements];
    if (queue.length === 0) {
      const selected = [...group.contextElements].sort((left, right) => left.sequence - right.sequence);
      const built = buildEnvelopeRequest(envelope, selected, { index: packed.length, count: countHint, groupId: group.id });
      if (!built.footprint.fits(limit)) {
        throw new PromptFixedContextTooLargeFailure("A prompt group fixed context exceeds its request limit", {
          groupId: group.id,
          footprint: built.footprint.toJSON(),
          maxCharacters: limit.maxCharacters,
        });
      }
      packed.push({ group, payloadElements: [], request: built.request });
      continue;
    }
    while (queue.length > 0) {
      const payload = [];
      while (queue.length > 0) {
        const candidate = [...payload, queue[0]];
        const selected = [...group.contextElements, ...candidate].sort((left, right) => left.sequence - right.sequence);
        const built = buildEnvelopeRequest(envelope, selected, { index: packed.length, count: countHint, groupId: group.id });
        if (built.footprint.fits(limit)) {
          payload.push(queue.shift());
          continue;
        }
        if (payload.length > 0) break;
        const replacements = replaceWithFittingRanges({
          element: queue.shift(),
          contexts: group.contextElements,
          envelope,
          limit,
          index: packed.length,
          count: countHint,
          groupId: group.id,
        });
        queue.unshift(...replacements);
      }
      const selected = [...group.contextElements, ...payload].sort((left, right) => left.sequence - right.sequence);
      const built = buildEnvelopeRequest(envelope, selected, { index: packed.length, count: countHint, groupId: group.id });
      packed.push({ group, payloadElements: payload, request: built.request });
    }
  }
  return packed;
}

function assertPlanPayloadCoverage(groups, packed) {
  for (const group of groups) {
    const expected = group.payloadElements.flatMap((element) => element.coverageEntries());
    const actual = packed.filter((entry) => entry.group.id === group.id)
      .flatMap((entry) => entry.payloadElements)
      .flatMap((element) => element.coverageEntries());
    if (expected.length === 0 && actual.length === 0) continue;
    let expectedIndex = 0;
    for (const entry of actual) {
      const target = expected[expectedIndex];
      if (!target) throw new PromptCoverageInvalidFailure("Prompt plan contains foreign payload coverage", { groupId: group.id });
      if (entry.elementId !== target.elementId
        || entry.sourceRevision !== target.sourceRevision
        || entry.sourceLength !== target.sourceLength
        || entry.status !== target.status
        || entry.start < target.start
        || entry.start > target.end) {
        throw new PromptCoverageInvalidFailure("Prompt plan payload coverage is foreign or out of order", { groupId: group.id });
      }
      if (entry.start !== target.start) throw new PromptCoverageInvalidFailure("Prompt plan payload coverage has a gap or overlap", { groupId: group.id });
      if (entry.end === target.end) expectedIndex += 1;
      else expected[expectedIndex] = new PromptCoverageEntry({ ...target.toJSON(), start: entry.end });
    }
    if (expectedIndex !== expected.length) throw new PromptCoverageInvalidFailure("Prompt plan payload coverage is incomplete", { groupId: group.id });
  }
}

export class PromptBatchPlan {
  constructor({ collection, envelope, limit, topology, batches } = {}) {
    if (!(collection instanceof PromptInputCollection)) throw new TypeError("Prompt batch plan requires a typed collection");
    if (!(envelope instanceof PromptRequestEnvelope)) throw new TypeError("Prompt batch plan requires a typed envelope");
    if (!(topology instanceof PromptBatchTopology)) throw new TypeError("Prompt batch plan requires a typed topology");
    if (!Array.isArray(batches) || batches.length === 0 || batches.some((batch) => !(batch instanceof PromptBatch))) {
      throw new TypeError("Prompt batch plan requires typed batches");
    }
    if (batches.some((batch, index) => batch.index !== index || batch.count !== batches.length || batch.collectionDigest !== collection.digest)) {
      throw new PromptCoverageInvalidFailure("Prompt batch indexes or collection identities are inconsistent");
    }
    this.collection = collection;
    this.envelope = envelope;
    Object.freeze(this.envelope);
    this.limit = asRequestLimit(limit);
    this.topology = topology;
    this.batches = Object.freeze([...batches]);
    this.digest = digest(JSON.stringify({
      collectionDigest: collection.digest,
      envelopeRevision: envelope.revision,
      limit: this.limit.maxCharacters,
      batches: batches.map((batch) => batch.digest),
    }));
    Object.freeze(this);
  }

  static create({ collection, envelope, limit = collection?.limit, topology = new LinearPromptBatchTopology(), executionLimit } = {}) {
    if (!(collection instanceof PromptInputCollection)) throw new TypeError("Prompt batch plan requires a typed collection");
    if (!(envelope instanceof PromptRequestEnvelope)) throw new TypeError("Prompt batch plan requires a typed envelope");
    if (!(topology instanceof PromptBatchTopology)) throw new TypeError("Prompt batch plan requires a typed topology");
    const requestLimit = asRequestLimit(limit);
    const groups = topology.groupsFor(collection);
    topology.assertCoverage(collection, groups);
    let countHint = 1;
    const seenCounts = new Set();
    let packed;
    for (;;) {
      if (seenCounts.has(countHint)) {
        throw new PromptPartitionNoProgressFailure("Prompt batch count metadata did not reach a fixed point", { countHint });
      }
      seenCounts.add(countHint);
      packed = packGroups({ collection, groups, envelope, limit: requestLimit, countHint });
      if (packed.length === countHint) break;
      countHint = packed.length;
    }
    assertPlanPayloadCoverage(groups, packed);
    if (executionLimit !== undefined) {
      const limits = executionLimit instanceof PromptExecutionLimit ? executionLimit : new PromptExecutionLimit(executionLimit);
      if (packed.length > limits.maxBatchCount) {
        throw new PromptBatchCountExceededFailure("Prompt plan exceeds its batch count limit", {
          batchCount: packed.length,
          maxBatchCount: limits.maxBatchCount,
        });
      }
    }
    const batches = packed.map((entry, index) => new PromptBatch({
      index,
      count: packed.length,
      collectionDigest: collection.digest,
      groupId: entry.group.id,
      contextElements: entry.group.contextElements,
      payloadElements: entry.payloadElements,
      request: entry.request,
      limit: requestLimit,
    }));
    return new PromptBatchPlan({ collection, envelope, limit: requestLimit, topology, batches });
  }

  static fromRequest({ request, limit = new PromptRequestLimit(), id = "request", sourceRevision } = {}) {
    const normalized = normalizePromptRequest(request);
    const envelope = new PromptRequestEnvelope({
      revision: "atomic-request-v1",
      build: (elements) => ({ ...normalized, userPrompt: elements[0]?.toPromptText() ?? "" }),
    });
    const element = new AtomicPromptElement({
      id,
      sourceRevision: sourceRevision || digest(JSON.stringify(normalized)),
      sequence: 0,
      text: normalized.userPrompt,
    });
    const collection = new PromptInputBuilder({ envelope, limit }).add(element).build();
    return PromptBatchPlan.create({ collection, envelope, limit });
  }

  assertCompletions(completions) {
    if (!Array.isArray(completions) || completions.some((entry) => !(entry instanceof PromptBatchCompletion))) {
      throw new PromptResponseCoverageInvalidFailure("Prompt completions must be typed");
    }
    if (completions.length !== this.batches.length) {
      throw new PromptBatchExecutionIncompleteFailure("Prompt batch execution is incomplete", {
        completed: completions.length,
        expected: this.batches.length,
      });
    }
    const byDigest = new Map(completions.map((completion) => [completion.batchDigest, completion]));
    if (byDigest.size !== completions.length || this.batches.some((batch) => !byDigest.has(batch.digest))) {
      throw new PromptResponseCoverageInvalidFailure("Prompt completion coverage is missing, duplicate, or foreign");
    }
    return Object.freeze(this.batches.map((batch) => byDigest.get(batch.digest)));
  }
}

export class PromptExecutionLimit {
  constructor({
    maxRequestCharacters = GLOBAL_PROMPT_ELEMENT_HARD_MAX,
    maxResponseCharacters = GLOBAL_PROMPT_ELEMENT_HARD_MAX,
    maxBatchCount = 1_000,
    maxProviderCallCount = 1_000,
    maxProtocolRetryCount = 0,
    maxSynthesisCallCount = 100,
    maxAggregateItemCount = 100_000,
    maxAggregateCharacters = 1_000_000,
    maxReductionDepth = 8,
    concurrency = 1,
  } = {}) {
    this.maxRequestCharacters = safeInteger(maxRequestCharacters, "Execution request character limit", { minimum: 1 });
    if (this.maxRequestCharacters > GLOBAL_PROMPT_ELEMENT_HARD_MAX) throw new RangeError("Execution request character limit exceeds the global hard maximum");
    this.maxResponseCharacters = safeInteger(maxResponseCharacters, "Execution response character limit", { minimum: 1 });
    this.maxBatchCount = safeInteger(maxBatchCount, "Execution batch count limit", { minimum: 1 });
    this.maxProviderCallCount = safeInteger(maxProviderCallCount, "Execution provider call limit", { minimum: 1 });
    this.maxProtocolRetryCount = safeInteger(maxProtocolRetryCount, "Execution protocol retry limit");
    this.maxSynthesisCallCount = safeInteger(maxSynthesisCallCount, "Execution synthesis call limit", { minimum: 1 });
    this.maxAggregateItemCount = safeInteger(maxAggregateItemCount, "Execution aggregate item limit", { minimum: 1 });
    this.maxAggregateCharacters = safeInteger(maxAggregateCharacters, "Execution aggregate character limit", { minimum: 1 });
    this.maxReductionDepth = safeInteger(maxReductionDepth, "Execution reduction depth limit", { minimum: 1 });
    this.concurrency = safeInteger(concurrency, "Execution concurrency", { minimum: 1 });
    Object.freeze(this);
  }

  requestLimit() {
    return new PromptRequestLimit({ maxCharacters: this.maxRequestCharacters });
  }
}

/** Shared mutable accounting for a bounded command spanning multiple plans. */
export class PromptExecutionBudget {
  constructor(executionLimit = new PromptExecutionLimit()) {
    this.limit = executionLimit instanceof PromptExecutionLimit
      ? executionLimit
      : new PromptExecutionLimit(executionLimit);
    this.providerCallCount = 0;
    this.synthesisCallCount = 0;
    this.aggregateItemCount = 0;
    this.aggregateCharacters = 0;
  }

  assertCanExecute(batchCount) {
    safeInteger(batchCount, "Prompt execution planned batch count");
    if (batchCount > this.limit.maxBatchCount) {
      throw new PromptBatchCountExceededFailure("Prompt plan exceeds its shared execution batch limit", {
        batchCount,
        maxBatchCount: this.limit.maxBatchCount,
      });
    }
    if (this.providerCallCount + batchCount > this.limit.maxProviderCallCount) {
      throw new PromptCallLimitExceededFailure("Prompt plans cannot complete within their shared provider call limit", {
        providerCallCount: this.providerCallCount,
        requiredCalls: batchCount,
        maxProviderCallCount: this.limit.maxProviderCallCount,
      });
    }
  }

  consumeProviderCall() {
    if (this.providerCallCount >= this.limit.maxProviderCallCount) {
      throw new PromptCallLimitExceededFailure("Prompt provider call limit is exhausted", {
        providerCallCount: this.providerCallCount,
        maxProviderCallCount: this.limit.maxProviderCallCount,
      });
    }
    this.providerCallCount += 1;
    return this.providerCallCount;
  }

  releaseProviderCall() {
    if (this.providerCallCount < 1) throw new Error("Prompt provider call budget has no reservation to release");
    this.providerCallCount -= 1;
  }

  consumeSynthesisCalls(count) {
    safeInteger(count, "Prompt synthesis call count", { minimum: 1 });
    if (this.synthesisCallCount + count > this.limit.maxSynthesisCallCount) {
      throw new PromptCallLimitExceededFailure("Prompt synthesis call limit is exhausted", {
        synthesisCallCount: this.synthesisCallCount,
        requiredCalls: count,
        maxSynthesisCallCount: this.limit.maxSynthesisCallCount,
      });
    }
    this.synthesisCallCount += count;
  }

  consumeAggregate({ characters, items }) {
    safeInteger(characters, "Prompt aggregate characters");
    safeInteger(items, "Prompt aggregate items");
    if (this.aggregateCharacters + characters > this.limit.maxAggregateCharacters
      || this.aggregateItemCount + items > this.limit.maxAggregateItemCount) {
      throw new PromptResponseTooLargeFailure("Prompt aggregate exceeds its shared execution limit", {
        aggregateCharacters: this.aggregateCharacters,
        aggregateItemCount: this.aggregateItemCount,
        additionalCharacters: characters,
        additionalItems: items,
        maxAggregateCharacters: this.limit.maxAggregateCharacters,
        maxAggregateItemCount: this.limit.maxAggregateItemCount,
      });
    }
    this.aggregateCharacters += characters;
    this.aggregateItemCount += items;
  }

  snapshot() {
    return Object.freeze({
      providerCallCount: this.providerCallCount,
      synthesisCallCount: this.synthesisCallCount,
      aggregateCharacters: this.aggregateCharacters,
      aggregateItemCount: this.aggregateItemCount,
    });
  }
}

/**
 * Cache-aware admission spanning Executor and Agent. One slot is reserved
 * before the injected adapter runs; Agent claims ownership before cache lookup.
 */
export class PromptProviderCallAdmission {
  #budget;
  #claimed = false;
  #attemptCount = 0;
  #settled = false;

  constructor(executionBudget) {
    if (!(executionBudget instanceof PromptExecutionBudget)) throw new TypeError("Provider call admission requires a shared execution budget");
    this.#budget = executionBudget;
    this.#budget.consumeProviderCall();
  }

  claim() {
    if (this.#settled) throw new Error("Provider call admission is already settled");
    if (this.#claimed) throw new Error("Provider call admission is already claimed");
    this.#claimed = true;
    return this;
  }

  beforeProviderAttempt() {
    if (!this.#claimed) throw new Error("Provider call admission must be claimed before a transport attempt");
    if (this.#settled) throw new Error("Provider call admission is already settled");
    if (this.#attemptCount > 0) this.#budget.consumeProviderCall();
    this.#attemptCount += 1;
    return this.#attemptCount;
  }

  settle() {
    if (this.#settled) throw new Error("Provider call admission is already settled");
    if (this.#claimed && this.#attemptCount === 0) this.#budget.releaseProviderCall();
    this.#settled = true;
  }

  get claimed() { return this.#claimed; }
  get attemptCount() { return this.#attemptCount; }
  get settled() { return this.#settled; }
}

export class PromptBatchCompletion {
  constructor({ batch, response, responseCharacters, responseItemCount } = {}) {
    if (!(batch instanceof PromptBatch)) throw new TypeError("Prompt completion requires its typed batch");
    if (response === undefined) throw new PromptResponseInvalidFailure("Prompt completion response is undefined", { batchDigest: batch.digest });
    this.batch = batch;
    this.batchDigest = batch.digest;
    this.collectionDigest = batch.collectionDigest;
    this.response = response;
    this.responseCharacters = safeInteger(responseCharacters, "Prompt completion response characters");
    this.responseItemCount = safeInteger(responseItemCount, "Prompt completion response item count");
    Object.freeze(this);
  }
}

export class PromptBatchReducer {
  reduce() {
    throw new Error(`${this.constructor.name}.reduce() is not implemented`);
  }
}

export class PromptCompletionReducer extends PromptBatchReducer {
  reduce(completions) {
    return Object.freeze([...completions]);
  }
}

function responseCharacterCount(response) {
  if (typeof response === "string") return response.length;
  try {
    return JSON.stringify(response).length;
  } catch (error) {
    throw new PromptResponseInvalidFailure("Prompt response cannot be serialized for bounded accounting", {}, error);
  }
}

function responseItemCount(response, responseContract) {
  if (typeof responseContract.itemCount === "function") {
    const count = responseContract.itemCount(response);
    return safeInteger(count, "Prompt response item count");
  }
  return Array.isArray(response) ? response.length : 1;
}

function assertProjection(projection, requestLimit, batch) {
  if (!projection || typeof projection.assertWithinLimit !== "function") {
    throw new TypeError("Prompt invocation projection must implement assertWithinLimit(limit)");
  }
  try {
    projection.assertWithinLimit(requestLimit);
  } catch (error) {
    if (error?.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW" || error?.failureCode === "PROMPT_INVOCATION_PROJECTION_OVERFLOW") throw error;
    throw new PromptInvocationProjectionOverflowFailure("Resolved prompt invocation exceeds its request limit", {
      batchDigest: batch.digest,
      maxCharacters: requestLimit.maxCharacters,
    }, error);
  }
}

class DefaultPromptProtocolPolicy {
  async execute({ request, call }) {
    return call(request);
  }
}

/**
 * Read-only execution engine. A protocol policy may call its injected `call`
 * more than once, but every actual provider call is counted by the executor.
 */
export class PromptBatchExecutor {
  constructor({ executionLimit = new PromptExecutionLimit(), executionBudget } = {}) {
    const normalizedLimit = executionLimit instanceof PromptExecutionLimit
      ? executionLimit
      : new PromptExecutionLimit(executionLimit);
    if (executionBudget !== undefined && !(executionBudget instanceof PromptExecutionBudget)) {
      throw new TypeError("Prompt executor shared budget must be a PromptExecutionBudget");
    }
    this.executionBudget = executionBudget || new PromptExecutionBudget(normalizedLimit);
    this.executionLimit = this.executionBudget.limit;
    Object.freeze(this);
  }

  async executeCompletions({
    plan,
    callAgent,
    responseContract,
    projectInvocation,
    protocolPolicy = new DefaultPromptProtocolPolicy(),
  } = {}) {
    if (!(plan instanceof PromptBatchPlan)) throw new TypeError("Prompt executor requires a typed plan");
    if (typeof callAgent !== "function") throw new TypeError("Prompt executor requires callAgent");
    if (!responseContract || typeof responseContract.parse !== "function") throw new TypeError("Prompt executor requires a response contract parser");
    if (projectInvocation !== undefined && typeof projectInvocation !== "function") throw new TypeError("Prompt invocation projector must be a function");
    if (!protocolPolicy || typeof protocolPolicy.execute !== "function") throw new TypeError("Prompt protocol policy must implement execute()");
    this.executionBudget.assertCanExecute(plan.batches.length);
    const requestLimit = new PromptRequestLimit({
      maxCharacters: Math.min(plan.limit.maxCharacters, this.executionLimit.maxRequestCharacters),
    });
    for (const batch of plan.batches) {
      if (!batch.footprint.fits(requestLimit)) {
        throw new PromptBatchOverflowFailure("Prompt batch exceeds the executor request limit", {
          batchDigest: batch.digest,
          footprint: batch.footprint.toJSON(),
          maxCharacters: requestLimit.maxCharacters,
        });
      }
      if (projectInvocation) assertProjection(await projectInvocation(batch.request, batch), requestLimit, batch);
    }

    const completions = new Array(plan.batches.length);
    let cursor = 0;
    let firstFailure = null;
    const executeBatch = async (batch) => {
      let batchCalls = 0;
      const call = async (request = batch.request, attemptContext) => {
        const usesPreflightedRequest = request === batch.request;
        batchCalls += 1;
        if (batchCalls > this.executionLimit.maxProtocolRetryCount + 1) {
          throw new PromptCallLimitExceededFailure("Prompt provider call limit is exhausted", {
            batchDigest: batch.digest,
            batchCalls,
            maxProtocolRetryCount: this.executionLimit.maxProtocolRetryCount,
          });
        }
        const actualRequest = normalizePromptRequest(request);
        const actualFootprint = PromptLogicalFootprint.measure(actualRequest);
        if (!actualFootprint.fits(requestLimit)) {
          throw new PromptBatchOverflowFailure("Prompt protocol request exceeds the executor request limit", {
            batchDigest: batch.digest,
            footprint: actualFootprint.toJSON(),
            maxCharacters: requestLimit.maxCharacters,
          });
        }
        if (projectInvocation && !usesPreflightedRequest) {
          assertProjection(
            await projectInvocation(actualRequest, batch, attemptContext),
            requestLimit,
            batch,
          );
        }
        const providerCallAdmission = new PromptProviderCallAdmission(this.executionBudget);
        let rawCallResponse;
        try {
          rawCallResponse = await callAgent(
            actualRequest,
            batch,
            batchCalls - 1,
            attemptContext,
            providerCallAdmission,
          );
        } finally {
          if (!providerCallAdmission.settled) providerCallAdmission.settle();
        }
        const rawCallCharacters = responseCharacterCount(rawCallResponse);
        if (rawCallCharacters > this.executionLimit.maxResponseCharacters) {
          throw new PromptResponseTooLargeFailure("Prompt provider response exceeds its character limit", {
            batchDigest: batch.digest,
            responseCharacters: rawCallCharacters,
            maxResponseCharacters: this.executionLimit.maxResponseCharacters,
          });
        }
        return rawCallResponse;
      };
      const raw = await protocolPolicy.execute({ batch, request: batch.request, call });
      const rawCharacters = responseCharacterCount(raw);
      if (rawCharacters > this.executionLimit.maxResponseCharacters) {
        throw new PromptResponseTooLargeFailure("Prompt response exceeds its character limit", {
          batchDigest: batch.digest,
          responseCharacters: rawCharacters,
          maxResponseCharacters: this.executionLimit.maxResponseCharacters,
        });
      }
      let parsed;
      try {
        parsed = responseContract.parse(raw, batch);
        if (parsed && typeof parsed.then === "function") parsed = await parsed;
      } catch (error) {
        if (error instanceof PromptBatchingError) throw error;
        throw new PromptResponseInvalidFailure("Prompt response does not satisfy its typed contract", { batchDigest: batch.digest }, error);
      }
      if (parsed === undefined) throw new PromptResponseInvalidFailure("Prompt response parser returned undefined", { batchDigest: batch.digest });
      const parsedCharacters = responseCharacterCount(parsed);
      const parsedItems = responseItemCount(parsed, responseContract);
      if (parsedCharacters > this.executionLimit.maxAggregateCharacters || parsedItems > this.executionLimit.maxAggregateItemCount) {
        throw new PromptResponseTooLargeFailure("Parsed prompt response exceeds an aggregate limit", {
          batchDigest: batch.digest,
          parsedCharacters,
          parsedItems,
        });
      }
      this.executionBudget.consumeAggregate({ characters: parsedCharacters, items: parsedItems });
      return new PromptBatchCompletion({
        batch,
        response: parsed,
        responseCharacters: parsedCharacters,
        responseItemCount: parsedItems,
      });
    };
    const worker = async () => {
      while (firstFailure === null) {
        const index = cursor;
        cursor += 1;
        if (index >= plan.batches.length) return;
        try {
          completions[index] = await executeBatch(plan.batches[index]);
        } catch (error) {
          firstFailure = error;
        }
      }
    };
    const workerCount = Math.min(this.executionLimit.concurrency, plan.batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstFailure !== null) {
      const completed = completions.filter(Boolean);
      const causeCode = firstFailure.code || firstFailure.failureCode || null;
      throw new PromptBatchExecutionIncompleteFailure(`Prompt batch execution did not complete; no reduced result was produced: ${causeCode || "ERROR"}: ${firstFailure.message}`, {
        completedBatchDigests: completed.map((entry) => entry.batchDigest),
        expectedBatchDigests: plan.batches.map((batch) => batch.digest),
        causeCode,
      }, firstFailure);
    }
    const ordered = plan.assertCompletions(completions);
    return ordered;
  }

  async execute({ reducer, ...options } = {}) {
    if (!(reducer instanceof PromptBatchReducer)) throw new TypeError("Prompt executor requires a typed reducer");
    const completions = await this.executeCompletions(options);
    return reducer.reduce(completions);
  }
}

export class PromptReductionLevel {
  constructor({ elements, coverageDigest } = {}) {
    if (!Array.isArray(elements) || elements.length === 0 || elements.some((element) => !(element instanceof PromptInputElement))) {
      throw new TypeError("Prompt reduction level requires typed elements");
    }
    this.elements = Object.freeze([...elements]);
    this.coverageDigest = requiredText(coverageDigest, "Prompt reduction coverage digest");
    this.characterCount = elements.reduce((total, element) => total + renderedLength(element), 0);
    Object.freeze(this);
  }
}

/** Bounded, coverage-preserving staged semantic reduction. */
export class PromptReductionPlan {
  constructor({ initialElements, coverageDigest, executionLimit = new PromptExecutionLimit(), executionBudget } = {}) {
    this.initialLevel = new PromptReductionLevel({ elements: initialElements, coverageDigest });
    const normalizedLimit = executionLimit instanceof PromptExecutionLimit
      ? executionLimit
      : new PromptExecutionLimit(executionLimit);
    if (executionBudget !== undefined && !(executionBudget instanceof PromptExecutionBudget)) {
      throw new TypeError("Prompt reduction shared budget must be a PromptExecutionBudget");
    }
    this.executionBudget = executionBudget || new PromptExecutionBudget(normalizedLimit);
    this.executionLimit = this.executionBudget.limit;
    Object.freeze(this);
  }

  async execute({ isComplete, buildRound, executeRound, toNextLevel, finalize } = {}) {
    for (const [value, name] of [[isComplete, "isComplete"], [buildRound, "buildRound"], [executeRound, "executeRound"], [toNextLevel, "toNextLevel"], [finalize, "finalize"]]) {
      if (typeof value !== "function") throw new TypeError(`Prompt reduction requires ${name}()`);
    }
    let level = this.initialLevel;
    for (let depth = 0; depth <= this.executionLimit.maxReductionDepth; depth += 1) {
      if (isComplete(level.elements, depth)) return finalize(level.elements, level.coverageDigest);
      if (depth === this.executionLimit.maxReductionDepth) {
        throw new PromptReductionDidNotConvergeFailure("Prompt reduction reached its depth limit", {
          depth,
          characterCount: level.characterCount,
          itemCount: level.elements.length,
        });
      }
      const plan = buildRound(level.elements, depth);
      if (!(plan instanceof PromptBatchPlan)) throw new TypeError("Prompt reduction buildRound() must return a PromptBatchPlan");
      this.executionBudget.consumeSynthesisCalls(plan.batches.length);
      const completions = await executeRound(plan, depth);
      plan.assertCompletions(completions);
      const next = toNextLevel(completions, depth);
      if (!(next instanceof PromptReductionLevel)) throw new TypeError("Prompt reduction toNextLevel() must return a PromptReductionLevel");
      if (next.coverageDigest !== this.initialLevel.coverageDigest) {
        throw new PromptResponseCoverageInvalidFailure("Prompt reduction did not inherit its input coverage digest", {
          expected: this.initialLevel.coverageDigest,
          actual: next.coverageDigest,
        });
      }
      const shrank = next.characterCount < level.characterCount
        || (next.characterCount === level.characterCount && next.elements.length < level.elements.length);
      if (!shrank) {
        throw new PromptReductionDidNotConvergeFailure("Prompt reduction did not strictly shrink", {
          depth,
          previousCharacters: level.characterCount,
          nextCharacters: next.characterCount,
          previousItems: level.elements.length,
          nextItems: next.elements.length,
        });
      }
      if (next.characterCount > this.executionLimit.maxAggregateCharacters
        || next.elements.length > this.executionLimit.maxAggregateItemCount) {
        throw new PromptResponseTooLargeFailure("Prompt reduction aggregate exceeds its execution limit", {
          characterCount: next.characterCount,
          itemCount: next.elements.length,
        });
      }
      level = next;
    }
    throw new PromptReductionDidNotConvergeFailure();
  }
}
