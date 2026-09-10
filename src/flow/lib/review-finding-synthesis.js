import { createHash } from "node:crypto";

import {
  LinearPromptBatchTopology,
  PromptBatchPlan,
  PromptInputBuilder,
  PromptInputElement,
  PartitionedPromptPayloadElement,
  PromptRequestEnvelope,
  PromptRequestLimit,
} from "../../lib/prompt-batching.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function coverageRefs(element) {
  if (element instanceof ReviewSynthesisEvidenceElement) return element.sourceRefs;
  return element.coverageEntries().map((entry) => JSON.stringify(entry.toJSON()));
}

/** One exact canonical review authority unit supplied to the global reducer. */
export class ReviewCanonicalAuthorityElement extends PartitionedPromptPayloadElement {
  constructor({ id, originId = id, text, sequence = 0, sourceRevision, start = 0, end, sourceLength } = {}) {
    if (typeof id !== "string" || id.trim() === "") throw new TypeError("Review authority id is required");
    if (typeof text !== "string" || text.trim() === "") throw new TypeError("Review authority text is required");
    super({
      id,
      originId,
      sourceRevision: sourceRevision || digest(text),
      sequence,
      text,
      start,
      end,
      sourceLength,
      status: "present",
    });
    Object.freeze(this);
  }

  createRange({ start, end } = {}) {
    return new ReviewCanonicalAuthorityElement({
      id: `${this.originId}@${start}:${end}`,
      originId: this.originId,
      text: this.text.slice(start - this.start, end - this.start),
      sequence: this.sequence,
      sourceRevision: this.sourceRevision,
      start,
      end,
      sourceLength: this.sourceLength,
    });
  }
}

/** Typed authority/finding evidence retained through every synthesis level. */
export class ReviewSynthesisEvidenceElement extends PartitionedPromptPayloadElement {
  constructor({ id, originId = id, text, sequence, sourceRefs, evidenceKind = "finding", sourceRevision, start = 0, end, sourceLength } = {}) {
    if (typeof text !== "string" || text.trim() === "") throw new TypeError("Review synthesis evidence requires non-empty text");
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0 || sourceRefs.some((ref) => typeof ref !== "string" || ref === "")) {
      throw new TypeError("Review synthesis evidence requires source references");
    }
    if (!new Set(["authority", "finding", "summary"]).has(evidenceKind)) {
      throw new TypeError("Review synthesis evidence kind is invalid");
    }
    const revision = sourceRevision || digest(JSON.stringify({ text, sourceRefs, evidenceKind }));
    const resolvedId = id || `review-${evidenceKind}:${sequence}:${revision}`;
    super({
      id: resolvedId,
      originId: originId || resolvedId,
      sourceRevision: revision,
      sequence,
      text,
      start,
      end,
      sourceLength,
      status: "present",
    });
    this.sourceRefs = Object.freeze([...new Set(sourceRefs)]);
    this.evidenceKind = evidenceKind;
    Object.freeze(this);
  }

  createRange({ start, end } = {}) {
    return new ReviewSynthesisEvidenceElement({
      id: `${this.originId}@${start}:${end}`,
      originId: this.originId,
      text: this.text.slice(start - this.start, end - this.start),
      sequence: this.sequence,
      sourceRefs: this.sourceRefs,
      evidenceKind: this.evidenceKind,
      sourceRevision: this.sourceRevision,
      start,
      end,
      sourceLength: this.sourceLength,
    });
  }

  static fromAuthority(element, sequence) {
    if (!(element instanceof PromptInputElement)) throw new TypeError("Review synthesis authority must be a typed prompt element");
    return new ReviewSynthesisEvidenceElement({
      id: `review-authority:${sequence}:${element.sourceRevision}`,
      text: element.toPromptText() || `(empty canonical authority: ${element.id})`,
      sequence,
      sourceRefs: coverageRefs(element),
      evidenceKind: "authority",
      sourceRevision: element.sourceRevision,
    });
  }

  static fromFinding(text, sequence) {
    return new ReviewSynthesisEvidenceElement({
      text,
      sequence,
      sourceRefs: [`finding:${digest(text)}`],
      evidenceKind: "finding",
    });
  }

  static fromSummary({ text, sequence, sourceRefs, coverageDigest }) {
    return new ReviewSynthesisEvidenceElement({
      id: `review-summary:${sequence}:${digest(text)}`,
      text,
      sequence,
      sourceRefs,
      evidenceKind: "summary",
      sourceRevision: coverageDigest,
    });
  }
}

export class ReviewFindingSynthesisEnvelope extends PromptRequestEnvelope {
  constructor(buildRequest, revision = "review-finding-synthesis-v2") {
    super({ revision });
    if (typeof buildRequest !== "function") throw new TypeError("Review finding synthesis requires buildRequest");
    this._buildRequest = buildRequest;
    Object.freeze(this);
  }

  build(elements, context) {
    return this._buildRequest(
      elements.map((element) => element.toPromptText()),
      context,
      [...new Set(elements.flatMap(coverageRefs))],
    );
  }
}

/** Shared typed plan for review evidence reduction and final cross-check. */
export class ReviewFindingSynthesisPlan {
  constructor(corePlan) {
    if (!(corePlan instanceof PromptBatchPlan)) throw new TypeError("Review finding synthesis requires a shared plan");
    this.corePlan = corePlan;
    this.batches = corePlan.batches;
    this.limit = corePlan.limit;
    Object.freeze(this);
  }

  static create({ elements, buildRequest, maxChars, revision } = {}) {
    if (!Array.isArray(elements) || elements.length === 0 || elements.some((element) => !(element instanceof ReviewSynthesisEvidenceElement))) {
      throw new TypeError("Review finding synthesis requires typed evidence elements");
    }
    const envelope = new ReviewFindingSynthesisEnvelope(buildRequest, revision);
    const limit = new PromptRequestLimit({ maxCharacters: maxChars });
    const builder = new PromptInputBuilder({ envelope, limit });
    elements.forEach((element) => builder.add(element));
    return new ReviewFindingSynthesisPlan(PromptBatchPlan.create({
      collection: builder.build(),
      envelope,
      limit,
      topology: new LinearPromptBatchTopology(),
    }));
  }
}
