import { createHash } from "node:crypto";

import {
  AtomicPromptElement,
  LinearPromptBatchTopology,
  PartitionedPromptPayloadElement,
  PromptBatchPlan,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptScopedBinding,
  ScopedCartesianPromptBatchTopology,
} from "../../lib/prompt-batching.js";

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty text`);
  return value;
}

/** Canonical spec-local test source with exact range identity. */
export class TestSourcePromptElement extends PartitionedPromptPayloadElement {
  constructor(file, range = {}) {
    const source = requiredText(file?.source, "Test source path");
    const canonicalContent = file?.canonicalContent ?? file?.content;
    if (typeof canonicalContent !== "string") throw new TypeError("Test source content must be text");
    const sequence = file.sequence ?? 0;
    const originId = file.originId || `test-source:${sequence}:${source}`;
    const start = range.start ?? 0;
    const end = range.end ?? canonicalContent.length;
    super({
      id: range.id || (start === 0 && end === canonicalContent.length ? originId : `${originId}@${start}:${end}`),
      originId,
      sourceRevision: file.sourceRevision || createHash("sha256").update(`${source}\0${canonicalContent}`).digest("hex"),
      sequence,
      text: canonicalContent.slice(start, end),
      start,
      end,
      sourceLength: canonicalContent.length,
      status: "present",
    });
    this.source = source;
    this.name = file.name || source;
    this.content = this.text;
    this.canonicalContent = canonicalContent;
    if (new.target === TestSourcePromptElement) Object.freeze(this);
  }

  createRange({ start, end } = {}) {
    return new TestSourcePromptRange({ element: this, start, end });
  }

  toPromptText() {
    return [
      `### ${this.source}`,
      `[canonical test characters ${this.start}-${this.end} of ${this.sourceLength}]`,
      "```",
      this.content,
      "```",
    ].join("\n");
  }

  toTestFile() {
    return {
      name: this.name,
      source: this.source,
      content: this.start === 0 && this.end === this.sourceLength
        ? this.content
        : `[canonical test characters ${this.start}-${this.end} of ${this.sourceLength}]\n${this.content}`,
    };
  }
}

export class TestSourcePromptRange extends TestSourcePromptElement {
  constructor({ element, start, end } = {}) {
    if (!(element instanceof TestSourcePromptElement)) throw new TypeError("Test source range requires its typed source");
    super({
      source: element.source,
      name: element.name,
      canonicalContent: element.canonicalContent,
      sequence: element.sequence,
      originId: element.originId,
      sourceRevision: element.sourceRevision,
    }, { start, end });
    Object.freeze(this);
  }
}

export class TestRequirementPromptElement extends AtomicPromptElement {
  constructor({ id, text, sequence } = {}) {
    const requirementId = requiredText(id, "Test Review requirement ID");
    const requirementText = requiredText(text, "Test Review requirement text");
    const sourceRevision = createHash("sha256").update(requirementText).digest("hex");
    super({ id: `test-requirement:${requirementId}`, sourceRevision, sequence, text: requirementText });
    this.requirementId = requirementId;
    Object.freeze(this);
  }
}

export class TestCoveragePromptElement extends AtomicPromptElement {
  constructor({ entry, fileEntries, summaryAuthority, sequence } = {}) {
    const requirementId = requiredText(entry?.id, "Test Review coverage requirement ID");
    const value = Object.freeze({
      ...summaryAuthority,
      requirements: [structuredClone(entry)],
      files: structuredClone(fileEntries),
    });
    const text = JSON.stringify(value, null, 2);
    const sourceRevision = createHash("sha256").update(text).digest("hex");
    super({ id: `test-coverage:${requirementId}`, sourceRevision, sequence, text });
    this.requirementId = requirementId;
    this.value = value;
    Object.freeze(this);
  }
}

function asRange(element) {
  if (element instanceof TestSourcePromptRange) return element;
  return new TestSourcePromptRange({ element, start: element.start, end: element.end });
}

/** Repeats requirement/coverage authority while varying only canonical test ranges. */
export class TestReviewPromptEnvelope extends PromptRequestEnvelope {
  constructor(buildPrompt, scoped = false) {
    super({ revision: "test-review-source-v1" });
    if (typeof buildPrompt !== "function") throw new TypeError("Test Review envelope requires buildPrompt");
    this._buildPrompt = buildPrompt;
    this.scoped = scoped;
    Object.freeze(this);
  }

  build(elements) {
    const requirementElements = elements.filter((element) => element instanceof TestRequirementPromptElement);
    const coverageElements = elements.filter((element) => element instanceof TestCoveragePromptElement);
    const testElements = elements.filter((element) => element instanceof TestSourcePromptElement);
    if (!this.scoped && requirementElements.length === 0 && coverageElements.length === 0) {
      return this._buildPrompt(testElements.map(asRange).map((element) => element.toTestFile()));
    }
    const coverage = coverageElements.length === 1
      ? coverageElements[0].value
      : {
        requirements: coverageElements.flatMap((element) => element.value.requirements),
        files: coverageElements.flatMap((element) => element.value.files),
      };
    return this._buildPrompt(
      testElements.map(asRange).map((element) => element.toTestFile()),
      {
        requirements: requirementElements.map((element) => element.text).join("\n"),
        coverage,
      },
    );
  }
}

export class TestReviewPromptPlan {
  constructor(corePlan) {
    if (!(corePlan instanceof PromptBatchPlan)) throw new TypeError("Test Review prompt plan requires a shared plan");
    this.corePlan = corePlan;
    this.batches = corePlan.batches;
    this.limit = corePlan.limit;
    Object.freeze(this);
  }

  static create({ testFiles, buildPrompt, maxChars, requirementEntries = null, coverageSummary = null } = {}) {
    if (!Array.isArray(testFiles)) throw new TypeError("Test Review prompt plan requires test files");
    const scoped = Array.isArray(requirementEntries) && requirementEntries.length > 0 && coverageSummary !== null;
    const envelope = new TestReviewPromptEnvelope(buildPrompt, scoped);
    const limit = new PromptRequestLimit({ maxCharacters: maxChars });
    const builder = new PromptInputBuilder({ envelope, limit });
    const requirementElements = scoped
      ? requirementEntries.map((entry, sequence) => new TestRequirementPromptElement({ ...entry, sequence }))
      : [];
    const coverageElements = scoped
      ? requirementEntries.map((entry, index) => {
        const coverageEntry = coverageSummary.requirements.find((candidate) => candidate.id === entry.id)
          ?? { id: entry.id, status: "uncovered", files: [] };
        const relevant = new Set(coverageEntry.files || []);
        const fileEntries = (coverageSummary.files || []).filter((file) => relevant.has(file.file));
        return new TestCoveragePromptElement({
          entry: coverageEntry,
          fileEntries,
          summaryAuthority: Object.fromEntries(Object.entries(coverageSummary).filter(([key]) => !["requirements", "files"].includes(key))),
          sequence: requirementElements.length + index,
        });
      })
      : [];
    requirementElements.forEach((element) => builder.add(element));
    coverageElements.forEach((element) => builder.add(element));
    const sourceOffset = requirementElements.length + coverageElements.length;
    for (const [sequence, file] of testFiles.entries()) {
      builder.add(new TestSourcePromptElement({ ...file, sequence: sourceOffset + sequence }));
    }
    const collection = builder.build();
    let topology = new LinearPromptBatchTopology();
    if (scoped) {
      const sourceElements = collection.elements.filter((element) => element instanceof TestSourcePromptElement);
      const bindings = requirementElements.map((requirementElement, index) => {
        const coverageElement = coverageElements[index];
        const relevant = new Set(coverageElement.value.requirements[0].files || []);
        const payloadElements = sourceElements.filter((element) => (
          relevant.size === 0
          || [...relevant].some((file) => element.source === file || element.source.endsWith(`/${file}`))
        ));
        return new PromptScopedBinding({
          id: `test-requirement-scope:${requirementElement.requirementId}`,
          scopeElements: [requirementElement, coverageElement],
          payloadElements,
        });
      });
      const bound = new Set(bindings.flatMap((binding) => binding.payloadElements));
      const unbound = sourceElements.filter((element) => !bound.has(element));
      if (unbound.length > 0) {
        bindings.push(new PromptScopedBinding({ id: "test-unbound-source-scope", payloadElements: unbound }));
      }
      topology = new ScopedCartesianPromptBatchTopology({ bindings });
    }
    return new TestReviewPromptPlan(PromptBatchPlan.create({
      collection,
      envelope,
      limit,
      topology,
    }));
  }
}
