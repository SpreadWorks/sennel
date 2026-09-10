import { createHash } from "node:crypto";

import {
  LinearPromptBatchTopology,
  PartitionedPromptPayloadElement,
  PromptBatchPlan,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  normalizePromptRequest,
} from "../../lib/prompt-batching.js";

class ReviewTextPromptElement extends PartitionedPromptPayloadElement {
  constructor({ id, text, sequence = 0, originId = id, sourceRevision, start = 0, end, sourceLength } = {}) {
    if (typeof text !== "string") throw new TypeError("Review text prompt element requires text");
    super({
      id,
      originId,
      sourceRevision: sourceRevision || createHash("sha256").update(text).digest("hex"),
      sequence,
      text,
      start,
      end,
      sourceLength,
      status: text.length === 0 ? "empty" : "present",
    });
    Object.freeze(this);
  }

  rangeLabel() {
    return `canonical characters ${this.start}-${this.end} of ${this.sourceLength}`;
  }

  toPromptText() {
    if (this.start === 0 && this.end === this.sourceLength) return this.text;
    return `[${this.rangeLabel()}]\n${this.text}`;
  }
}

export class SpecSectionPromptElement extends ReviewTextPromptElement {
  createRange({ start, end } = {}) {
    return new SpecSectionPromptElement({
      id: `${this.originId}@${start}:${end}`,
      originId: this.originId,
      sourceRevision: this.sourceRevision,
      sequence: this.sequence,
      text: this.text.slice(start - this.start, end - this.start),
      start,
      end,
      sourceLength: this.sourceLength,
    });
  }

  rangeLabel() { return `canonical spec characters ${this.start}-${this.end} of ${this.sourceLength}`; }
}

export class DraftSectionPromptElement extends ReviewTextPromptElement {
  createRange({ start, end } = {}) {
    return new DraftSectionPromptElement({
      id: `${this.originId}@${start}:${end}`,
      originId: this.originId,
      sourceRevision: this.sourceRevision,
      sequence: this.sequence,
      text: this.text.slice(start - this.start, end - this.start),
      start,
      end,
      sourceLength: this.sourceLength,
    });
  }

  rangeLabel() { return `canonical draft review characters ${this.start}-${this.end} of ${this.sourceLength}`; }
}

class ReviewTextPromptEnvelope extends PromptRequestEnvelope {
  constructor(request, repeatedPrefix = "") {
    super({ revision: "review-text-v1" });
    this.request = normalizePromptRequest(request);
    this.repeatedPrefix = repeatedPrefix;
    Object.freeze(this);
  }

  build(elements) {
    return {
      ...this.request,
      userPrompt: [this.repeatedPrefix, ...elements.map((element) => element.toPromptText())]
        .filter((text) => text !== "")
        .join(""),
    };
  }
}

/** Shared range planning for review prompts whose canonical unit is one rendered document. */
export class ReviewTextPromptPlan {
  constructor(corePlan) {
    if (!(corePlan instanceof PromptBatchPlan)) throw new TypeError("Review text prompt plan requires a shared plan");
    this.corePlan = corePlan;
    this.batches = corePlan.batches;
    this.limit = corePlan.limit;
    Object.freeze(this);
  }

  static create({ request, maxChars, ElementClass = SpecSectionPromptElement, id = "review-document", sections = null, repeatedPrefix = "" } = {}) {
    const normalized = typeof request === "string" ? request : request?.userPrompt;
    if (typeof normalized !== "string") throw new TypeError("Review text prompt plan requires a prompt request");
    const limit = new PromptRequestLimit({ maxCharacters: maxChars });
    const sourceSections = sections ?? [normalized];
    if (!Array.isArray(sourceSections) || sourceSections.length === 0 || sourceSections.some((text) => typeof text !== "string")) {
      throw new TypeError("Review text prompt plan requires semantic sections");
    }
    const envelope = new ReviewTextPromptEnvelope(request, repeatedPrefix);
    const builder = new PromptInputBuilder({ envelope, limit });
    sourceSections.forEach((text, sequence) => builder.add(new ElementClass({
      id: `${id}:section:${sequence}`,
      text,
      sequence,
      sourceLength: text.length,
    })));
    const collection = builder.build();
    return new ReviewTextPromptPlan(PromptBatchPlan.create({
      collection,
      envelope,
      limit,
      topology: new LinearPromptBatchTopology(),
    }));
  }
}
