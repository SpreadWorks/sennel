import { WorkUnitToolingFailure } from "./work-unit.js";
import { ReviewPromptSize } from "./review-prompt-size.js";
import { renderCanonicalTaskSource } from "./run-gate.js";

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be non-empty text`);
  return value.trim();
}

export class TaskReviewSourceElement {
  constructor(entry) {
    this.path = requiredText(entry?.path, "Task Review source path");
    this.status = entry?.status;
    if (!new Set(["present", "deleted"]).has(this.status)) throw new Error(`Task Review source status is invalid: ${this.path}`);
    if (this.status === "present" && typeof entry.content !== "string") {
      throw new Error(`Task Review source content must be text: ${this.path}`);
    }
    this.content = this.status === "present" ? entry.content : "";
    Object.freeze(this);
  }
}

export class TaskReviewSourceSegment {
  constructor({ element, start, end } = {}) {
    if (!(element instanceof TaskReviewSourceElement)) throw new Error("Task Review source segment requires its typed element");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > element.content.length) {
      throw new Error(`Task Review source segment range is invalid: ${element.path}`);
    }
    if (element.status === "deleted" && (start !== 0 || end !== 0)) {
      throw new Error(`deleted Task Review source has an invalid segment: ${element.path}`);
    }
    this.path = element.path;
    this.status = element.status;
    this.start = start;
    this.end = end;
    this.sourceLength = element.content.length;
    this.content = element.content.slice(start, end);
    Object.freeze(this);
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

export class TaskReviewPromptChunkContext {
  constructor({ index, segments } = {}) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Task Review prompt chunk index is invalid");
    if (!Array.isArray(segments) || segments.length === 0 || segments.some((entry) => !(entry instanceof TaskReviewSourceSegment))) {
      throw new Error("Task Review prompt chunk requires source segments");
    }
    this.index = index;
    this.segments = Object.freeze([...segments]);
    Object.freeze(this);
  }

  toPromptText() {
    return [
      `Bounded source chunk: ${this.index + 1}`,
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

export class TaskReviewPromptChunk {
  constructor({ index, segments, prompt, maxChars, singleShot = false } = {}) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Task Review prompt chunk index is invalid");
    if (!Array.isArray(segments) || segments.some((segment) => !(segment instanceof TaskReviewSourceSegment))) {
      throw new Error("Task Review prompt chunk segments are invalid");
    }
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Task Review prompt chunk maxChars is invalid");
    this.index = index;
    this.segments = Object.freeze([...segments]);
    this.prompt = Object.freeze({ ...prompt });
    this.size = ReviewPromptSize.measure(prompt);
    if (this.size.total > maxChars) throw new Error("Task Review prompt chunk exceeds its plan limit");
    const userPrompt = String(prompt?.userPrompt || "");
    const sourceText = singleShot ? renderCanonicalTaskSource(segments) : renderSegments(segments);
    if (segments.length > 0 && !userPrompt.includes(sourceText)) {
      throw new Error("Task Review prompt chunk does not contain its claimed source coverage");
    }
    this.singleShot = singleShot;
    Object.freeze(this);
  }
}

export class TaskReviewPromptPlanningFailure extends WorkUnitToolingFailure {
  constructor({ elementName, size, maxChars } = {}) {
    const breakdown = size instanceof ReviewPromptSize ? size : ReviewPromptSize.measure(size);
    const namedElement = requiredText(elementName, "Task Review prompt element");
    super({
      failureKind: "invariant_violation",
      failureCode: "TASK_REVIEW_PROMPT_ELEMENT_TOO_LARGE",
      retryable: false,
      recoveryHint: "Reduce the named canonical non-source element; Task source is already split at the smallest supported boundary.",
      message: `TASK_REVIEW_PROMPT_ELEMENT_TOO_LARGE: ${namedElement} cannot fit within ${maxChars} chars; `
        + `systemPrompt=${breakdown.systemPrompt}, userPrompt=${breakdown.userPrompt}, `
        + `fmtFallback=${breakdown.fmtFallback}, total=${breakdown.total}`,
    });
    this.elementName = namedElement;
    this.size = breakdown;
    this.maxChars = maxChars;
  }
}

function renderSegments(segments) {
  return segments.map((segment) => segment.toPromptText()).join("\n\n");
}

function safeSliceEnd(content, start, requestedEnd) {
  let end = requestedEnd;
  if (end < content.length
    && end > start
    && /[\uD800-\uDBFF]/.test(content[end - 1])
    && /[\uDC00-\uDFFF]/.test(content[end])) end -= 1;
  return end;
}

/** Complete, deterministic plan for one Task Review provider input. */
export class TaskReviewPromptPlan {
  constructor({ chunks, elements, sourceLength, maxChars } = {}) {
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
    Object.freeze(this);
  }

  static create({ sourceEntries, buildPrompt, maxChars } = {}) {
    if (!Array.isArray(sourceEntries)) throw new Error("Task Review prompt plan sourceEntries must be an array");
    if (typeof buildPrompt !== "function") throw new Error("Task Review prompt plan requires buildPrompt");
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Task Review prompt plan maxChars is invalid");
    const elements = sourceEntries.map((entry) => new TaskReviewSourceElement(entry));
    const fullSource = renderCanonicalTaskSource(sourceEntries);
    const fullPrompt = buildPrompt({ sourceText: fullSource, chunkContext: null });
    const fullSize = ReviewPromptSize.measure(fullPrompt);
    if (fullSize.total <= maxChars) {
      const segments = elements.map((element) => new TaskReviewSourceSegment({ element, start: 0, end: element.content.length }));
      return new TaskReviewPromptPlan({
        chunks: [new TaskReviewPromptChunk({ index: 0, segments, prompt: fullPrompt, maxChars, singleShot: true })],
        elements,
        sourceLength: elements.reduce((total, element) => total + element.content.length, 0),
        maxChars,
      });
    }
    if (elements.length === 0) {
      throw new TaskReviewPromptPlanningFailure({ elementName: "fixed Task Review context", size: fullSize, maxChars });
    }
    const fixedPrompt = buildPrompt({ sourceText: "", chunkContext: null });
    const fixedSize = ReviewPromptSize.measure(fixedPrompt);
    if (fixedSize.total > maxChars) {
      throw new TaskReviewPromptPlanningFailure({ elementName: "fixed Task Review context", size: fixedSize, maxChars });
    }

    const chunks = [];
    let elementIndex = 0;
    let offset = 0;
    while (elementIndex < elements.length) {
      const index = chunks.length;
      const segments = [];
      while (elementIndex < elements.length) {
        const element = elements[elementIndex];
        const remaining = new TaskReviewSourceSegment({ element, start: offset, end: element.content.length });
        const candidateSegments = [...segments, remaining];
        const candidateContext = new TaskReviewPromptChunkContext({ index, segments: candidateSegments });
        const candidatePrompt = buildPrompt({ sourceText: renderSegments(candidateSegments), chunkContext: candidateContext });
        if (ReviewPromptSize.measure(candidatePrompt).total <= maxChars) {
          segments.push(remaining);
          elementIndex += 1;
          offset = 0;
          continue;
        }
        if (segments.length > 0) break;
        if (element.status === "deleted") {
          throw new TaskReviewPromptPlanningFailure({ elementName: `Task source header ${element.path}`, size: ReviewPromptSize.measure(candidatePrompt), maxChars });
        }

        let low = offset;
        let high = element.content.length;
        let accepted = null;
        while (low <= high) {
          const rawMidpoint = Math.floor((low + high) / 2);
          const midpoint = safeSliceEnd(element.content, offset, rawMidpoint);
          if (midpoint <= offset) {
            low = rawMidpoint + 1;
            continue;
          }
          const segment = new TaskReviewSourceSegment({ element, start: offset, end: midpoint });
          const context = new TaskReviewPromptChunkContext({ index, segments: [segment] });
          const prompt = buildPrompt({ sourceText: renderSegments([segment]), chunkContext: context });
          if (ReviewPromptSize.measure(prompt).total <= maxChars) {
            accepted = { segment, prompt };
            low = rawMidpoint + 1;
          } else {
            high = rawMidpoint - 1;
          }
        }
        if (accepted === null) {
          if (element.content.length === offset) {
            throw new TaskReviewPromptPlanningFailure({ elementName: `Task source header ${element.path}`, size: ReviewPromptSize.measure(candidatePrompt), maxChars });
          }
          const probeEnd = safeSliceEnd(element.content, offset, Math.min(element.content.length, offset + 2));
          const probe = new TaskReviewSourceSegment({ element, start: offset, end: probeEnd });
          const context = new TaskReviewPromptChunkContext({ index, segments: [probe] });
          const prompt = buildPrompt({ sourceText: renderSegments([probe]), chunkContext: context });
          throw new TaskReviewPromptPlanningFailure({ elementName: `Task source segment ${element.path}`, size: ReviewPromptSize.measure(prompt), maxChars });
        }
        if (accepted.segment.end < element.content.length) {
          const newline = element.content.lastIndexOf("\n", accepted.segment.end - 1);
          if (newline >= offset) {
            const lineEnd = newline + 1;
            if (lineEnd > offset) {
              const segment = new TaskReviewSourceSegment({ element, start: offset, end: lineEnd });
              const context = new TaskReviewPromptChunkContext({ index, segments: [segment] });
              accepted = { segment, prompt: buildPrompt({ sourceText: renderSegments([segment]), chunkContext: context }) };
            }
          }
        }
        segments.push(accepted.segment);
        offset = accepted.segment.end;
        if (offset === element.content.length) {
          elementIndex += 1;
          offset = 0;
        }
        break;
      }
      const context = new TaskReviewPromptChunkContext({ index, segments });
      const prompt = buildPrompt({ sourceText: renderSegments(segments), chunkContext: context });
      chunks.push(new TaskReviewPromptChunk({ index, segments, prompt, maxChars }));
    }
    return new TaskReviewPromptPlan({
      chunks,
      elements,
      sourceLength: elements.reduce((total, element) => total + element.content.length, 0),
      maxChars,
    });
  }
}
