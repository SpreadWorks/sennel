import { createHash } from "node:crypto";

import {
  LinearPromptBatchTopology,
  PartitionedPromptPayloadElement,
  PromptBatchPlan,
  PromptBatchingError,
  PromptInputBuilder,
  PromptLogicalFootprint,
  PromptRequestEnvelope,
  PromptRequestLimit,
} from "../../lib/prompt-batching.js";
import { WorkUnitToolingFailure } from "./work-unit.js";
import { renderCanonicalTaskSource } from "./run-gate.js";

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be non-empty text`);
  return value.trim();
}

function sourceRevision({ path, status, content }) {
  return createHash("sha256").update(JSON.stringify({ path, status, content })).digest("hex");
}

/** One canonical Task source whose character ranges may be planned independently. */
export class TaskReviewSourceElement extends PartitionedPromptPayloadElement {
  constructor(entry, range = {}) {
    const path = requiredText(entry?.path, "Task Review source path");
    const status = entry?.status;
    if (!new Set(["present", "deleted"]).has(status)) throw new Error(`Task Review source status is invalid: ${path}`);
    if (status === "present" && typeof entry.content !== "string") {
      throw new Error(`Task Review source content must be text: ${path}`);
    }
    const canonicalContent = status === "present" ? entry.content : "";
    const start = range.start ?? 0;
    const end = range.end ?? canonicalContent.length;
    const sequence = entry.sequence ?? 0;
    const originId = entry.originId || `task-source:${sequence}:${path}`;
    super({
      id: range.id || (start === 0 && end === canonicalContent.length ? originId : `${originId}@${start}:${end}`),
      originId,
      sourceRevision: entry.sourceRevision || sourceRevision({ path, status, content: canonicalContent }),
      sequence,
      text: canonicalContent.slice(start, end),
      start,
      end,
      sourceLength: canonicalContent.length,
      status,
    });
    this.path = path;
    this.content = this.text;
    this.canonicalContent = canonicalContent;
    if (new.target === TaskReviewSourceElement) Object.freeze(this);
  }

  createRange({ start, end } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < this.start || end > this.end || end < start) {
      throw new Error(`Task Review source segment range is invalid: ${this.path}`);
    }
    return new TaskReviewSourceSegment({
      element: this,
      start,
      end,
    });
  }

  toPromptText() {
    if (this.status === "deleted") return renderCanonicalTaskSource([this]);
    return [
      `## ${this.path}`,
      `[canonical source characters ${this.start}-${this.end} of ${this.sourceLength}]`,
      this.content,
    ].join("\n");
  }
}

/** A coverage-preserving range of one canonical Task source. */
export class TaskReviewSourceSegment extends TaskReviewSourceElement {
  constructor({ element, start, end } = {}) {
    if (!(element instanceof TaskReviewSourceElement)) throw new Error("Task Review source segment requires its typed element");
    super({
      path: element.path,
      status: element.status,
      content: element.canonicalContent,
      sequence: element.sequence,
      originId: element.originId,
      sourceRevision: element.sourceRevision,
    }, { start, end });
    Object.freeze(this);
  }
}

export class TaskReviewPromptChunkContext {
  constructor({ index, count = 1, segments } = {}) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Task Review prompt chunk index is invalid");
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Task Review prompt chunk count is invalid");
    if (!Array.isArray(segments) || segments.length === 0 || segments.some((entry) => !(entry instanceof TaskReviewSourceSegment))) {
      throw new Error("Task Review prompt chunk requires source segments");
    }
    this.index = index;
    this.count = count;
    this.segments = Object.freeze([...segments]);
    Object.freeze(this);
  }

  toPromptText() {
    return [
      `Bounded source chunk: ${this.index + 1} of ${this.count}`,
      "Review only defects evidenced by the source ranges supplied in this chunk.",
      "Do not infer that implementation is missing merely because another canonical source range is absent from this chunk.",
      "The canonical Task specification, requirements, mapping, touched-file set, context, and previous review memory are repeated in every chunk.",
      "The parent reviews every non-overlapping source range, combines accepted findings, and publishes only one complete Task Review.",
      ...this.segments.map((segment) => (
        segment.status === "deleted"
          ? `- ${segment.path}: deleted`
          : `- ${segment.path}: characters ${segment.start}-${segment.end} of ${segment.sourceLength}`
      )),
    ].join("\n");
  }
}

function asSegment(element) {
  if (element instanceof TaskReviewSourceSegment) return element;
  return new TaskReviewSourceSegment({ element, start: element.start, end: element.end });
}

function renderSegments(segments) {
  return segments.map((segment) => segment.toPromptText()).join("\n\n");
}

class TaskReviewPromptEnvelope extends PromptRequestEnvelope {
  constructor(buildPrompt) {
    super({ revision: "task-review-source-v2" });
    this._buildPrompt = buildPrompt;
    Object.freeze(this);
  }

  build(elements, batchContext) {
    const segments = elements.map(asSegment);
    const isCanonicalSingleShot = batchContext.singleShot
      && segments.every((segment) => segment.start === 0 && segment.end === segment.sourceLength);
    if (isCanonicalSingleShot) {
      return this._buildPrompt({ sourceText: renderCanonicalTaskSource(segments), chunkContext: null });
    }
    const chunkContext = new TaskReviewPromptChunkContext({
      index: batchContext.index,
      count: batchContext.count,
      segments,
    });
    return this._buildPrompt({ sourceText: renderSegments(segments), chunkContext });
  }
}

export class TaskReviewPromptChunk {
  constructor({ index, segments, prompt, maxChars, singleShot = false, batch = null } = {}) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Task Review prompt chunk index is invalid");
    if (!Array.isArray(segments) || segments.some((segment) => !(segment instanceof TaskReviewSourceSegment))) {
      throw new Error("Task Review prompt chunk segments are invalid");
    }
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Task Review prompt chunk maxChars is invalid");
    this.index = index;
    this.segments = Object.freeze([...segments]);
    this.prompt = Object.freeze({ ...prompt });
    this.size = PromptLogicalFootprint.measure(prompt);
    if (this.size.total > maxChars) throw new Error("Task Review prompt chunk exceeds its plan limit");
    const userPrompt = String(prompt?.userPrompt || "");
    const sourceText = singleShot ? renderCanonicalTaskSource(segments) : renderSegments(segments);
    if (segments.length > 0 && !userPrompt.includes(sourceText)) {
      throw new Error("Task Review prompt chunk does not contain its claimed source coverage");
    }
    this.singleShot = singleShot;
    this.batch = batch;
    Object.freeze(this);
  }
}

export class TaskReviewPromptPlanningFailure extends WorkUnitToolingFailure {
  constructor({ elementName, size, maxChars, cause } = {}) {
    const breakdown = size && Number.isSafeInteger(size.systemPrompt)
      && Number.isSafeInteger(size.userPrompt) && Number.isSafeInteger(size.fmtFallback)
      ? new PromptLogicalFootprint(size)
      : PromptLogicalFootprint.measure(size);
    const namedElement = requiredText(elementName, "Task Review prompt element");
    super({
      failureKind: "invariant_violation",
      failureCode: "TASK_REVIEW_PROMPT_ELEMENT_TOO_LARGE",
      retryable: false,
      recoveryHint: "Reduce the named canonical non-source element; Task source is already split at the smallest supported boundary.",
      message: `TASK_REVIEW_PROMPT_ELEMENT_TOO_LARGE: ${namedElement} cannot fit within ${maxChars} chars; `
        + `systemPrompt=${breakdown.systemPrompt}, userPrompt=${breakdown.userPrompt}, `
        + `fmtFallback=${breakdown.fmtFallback}, total=${breakdown.total}, jsonSchema=${breakdown.jsonSchema}`,
    });
    if (cause !== undefined) this.cause = cause;
    this.elementName = namedElement;
    this.size = breakdown;
    this.maxChars = maxChars;
  }
}

/** Complete, deterministic plan for one Task Review provider input. */
export class TaskReviewPromptPlan {
  constructor({ chunks, elements, sourceLength, maxChars, corePlan = null } = {}) {
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((chunk) => !(chunk instanceof TaskReviewPromptChunk))) {
      throw new Error("Task Review prompt plan requires chunks");
    }
    if (!Array.isArray(elements) || elements.some((element) => !(element instanceof TaskReviewSourceElement))) {
      throw new Error("Task Review prompt plan requires typed source elements");
    }
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Task Review prompt plan maxChars is invalid");
    if (chunks.some((chunk, index) => chunk.index !== index || chunk.size.total > maxChars)) {
      throw new Error("Task Review prompt plan chunks violate their ordered size contract");
    }
    if (new Set(elements.map((element) => element.path)).size !== elements.length) {
      throw new Error("Task Review prompt plan source paths must be unique");
    }
    const flattened = chunks.flatMap((chunk) => chunk.segments);
    let segmentIndex = 0;
    for (const element of elements) {
      const elementSegments = [];
      while (segmentIndex < flattened.length && flattened[segmentIndex].path === element.path) {
        elementSegments.push(flattened[segmentIndex]);
        segmentIndex += 1;
      }
      if (elementSegments.length === 0) throw new Error(`Task Review prompt plan omits source element: ${element.path}`);
      let expectedStart = 0;
      let reconstructed = "";
      for (const segment of elementSegments) {
        if (segment.status !== element.status || segment.sourceLength !== element.content.length || segment.start !== expectedStart) {
          throw new Error(`Task Review prompt plan source coverage is discontinuous: ${element.path}`);
        }
        expectedStart = segment.end;
        reconstructed += segment.content;
      }
      if (expectedStart !== element.content.length || reconstructed !== element.content) {
        throw new Error(`Task Review prompt plan source coverage is incomplete: ${element.path}`);
      }
      if (element.status === "deleted" && elementSegments.length !== 1) {
        throw new Error(`Task Review prompt plan duplicates deleted source: ${element.path}`);
      }
    }
    if (segmentIndex !== flattened.length) throw new Error(`Task Review prompt plan contains foreign source segment: ${flattened[segmentIndex].path}`);
    const expectedSourceLength = elements.reduce((total, element) => total + element.content.length, 0);
    if (sourceLength !== expectedSourceLength) throw new Error("Task Review prompt plan sourceLength is inconsistent");
    this.chunks = Object.freeze([...chunks]);
    this.sourceLength = sourceLength;
    this.maxChars = maxChars;
    this.corePlan = corePlan;
    Object.freeze(this);
  }

  static create({ sourceEntries, buildPrompt, maxChars } = {}) {
    if (!Array.isArray(sourceEntries)) throw new Error("Task Review prompt plan sourceEntries must be an array");
    if (typeof buildPrompt !== "function") throw new Error("Task Review prompt plan requires buildPrompt");
    const limit = new PromptRequestLimit({ maxCharacters: maxChars });
    const elements = sourceEntries.map((entry, sequence) => new TaskReviewSourceElement({ ...entry, sequence }));
    const envelope = new TaskReviewPromptEnvelope(buildPrompt);
    try {
      const builder = new PromptInputBuilder({ envelope, limit });
      for (const element of elements) builder.add(element);
      const collection = builder.build();
      const corePlan = PromptBatchPlan.create({
        collection,
        envelope,
        limit,
        topology: new LinearPromptBatchTopology(),
      });
      const chunks = corePlan.batches.map((batch) => new TaskReviewPromptChunk({
        index: batch.index,
        segments: batch.payloadElements.map(asSegment),
        prompt: batch.request,
        maxChars,
        singleShot: batch.count === 1,
        batch,
      }));
      return new TaskReviewPromptPlan({
        chunks,
        elements,
        sourceLength: elements.reduce((total, element) => total + element.content.length, 0),
        maxChars,
        corePlan,
      });
    } catch (error) {
      if (!(error instanceof PromptBatchingError)) throw error;
      const fixed = error.code === "PROMPT_FIXED_CONTEXT_TOO_LARGE" || elements.length === 0;
      throw new TaskReviewPromptPlanningFailure({
        elementName: fixed ? "fixed Task Review context" : (error.details?.elementId || "Task source segment"),
        size: error.details?.footprint || buildPrompt({ sourceText: "", chunkContext: null }),
        maxChars,
        cause: error,
      });
    }
  }
}
