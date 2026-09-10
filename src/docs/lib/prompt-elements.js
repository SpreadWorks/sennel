import { createHash } from "node:crypto";
import {
  AtomicPromptElement,
  PromptReferenceElement,
  RangedTextPromptElement,
  RepeatedPromptContextElement,
} from "../../lib/prompt-batching.js";

export function documentationSourceRevision(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export class DocumentationAnalysisPromptElement extends RangedTextPromptElement {
  constructor({ category, index, file, ...options } = {}) {
    super(options);
    if (typeof category !== "string" || category === "") throw new TypeError("analysis category is required");
    if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("analysis index is invalid");
    if (typeof file !== "string" || file === "") throw new TypeError("analysis file is required");
    this.category = category;
    this.index = index;
    this.file = file;
    Object.freeze(this);
  }

  toPromptText() {
    return [
      `### [${this.id}] entry=${this.category}:${this.index} file=${this.file} range=${this.start}:${this.end}/${this.sourceLength}`,
      "```",
      this.text,
      "```",
    ].join("\n");
  }

  createRange({ start, end } = {}) {
    return new DocumentationAnalysisPromptElement({
      category: this.category,
      index: this.index,
      file: this.file,
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
}

export class DocumentationDirectivePromptElement extends AtomicPromptElement {
  constructor({ directiveId, file, prompt, params = {}, ...options } = {}) {
    const text = [
      `directiveId: ${directiveId}`,
      `file: ${file}`,
      `prompt: ${prompt}`,
      `constraints: ${JSON.stringify(params)}`,
    ].join("\n");
    super({ ...options, text });
    if (typeof directiveId !== "string" || directiveId === "") throw new TypeError("directive ID is required");
    this.directiveId = directiveId;
    this.file = file;
    this.prompt = prompt;
    this.params = Object.freeze({ ...params });
    Object.freeze(this);
  }
}

export class DocumentationContextPromptElement extends RangedTextPromptElement {
  constructor({ label, ...options } = {}) {
    super(options);
    if (typeof label !== "string" || label === "") throw new TypeError("documentation context label is required");
    this.label = label;
    Object.freeze(this);
  }

  toPromptText() {
    return `### ${this.label} [${this.id}] range=${this.start}:${this.end}/${this.sourceLength}\n${this.text}`;
  }

  createRange({ start, end } = {}) {
    return new DocumentationContextPromptElement({
      label: this.label,
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
}

export class DocumentationChapterPromptElement extends RepeatedPromptContextElement {
  constructor({ fileName, title, ...options } = {}) {
    super({ ...options, text: `- ${fileName}: ${title}` });
    this.fileName = fileName;
    this.title = title;
    Object.freeze(this);
  }
}

export class MarkdownBlockPromptElement extends RangedTextPromptElement {
  constructor({ blockKind, protectedBlock = false, partitionable = true, ...options } = {}) {
    super(options);
    this.blockKind = blockKind;
    this.protectedBlock = protectedBlock === true;
    this.partitionable = partitionable === true;
    Object.freeze(this);
  }

  createRange({ start, end } = {}) {
    return new MarkdownBlockPromptElement({
      blockKind: this.blockKind,
      protectedBlock: this.protectedBlock,
      partitionable: this.partitionable,
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

  isPartitionable() {
    return this.partitionable && super.isPartitionable();
  }

  toPromptText() {
    return [
      `blockId: ${this.id}`,
      `kind: ${this.blockKind}`,
      `protected: ${this.protectedBlock}`,
      `range: ${this.start}:${this.end}/${this.sourceLength}`,
      this.text,
    ].join("\n");
  }
}

export class ProjectInstructionPromptElement extends DocumentationContextPromptElement {}

export class DocumentationRepeatedContextElement extends RepeatedPromptContextElement {
  constructor(options) {
    super(options);
    if (new.target === DocumentationRepeatedContextElement) Object.freeze(this);
  }
}

export class DocumentationFileReferencePromptElement extends PromptReferenceElement {}

export class ForgeInputReferencePromptElement extends PromptReferenceElement {
  constructor(options) {
    super(options);
    if (new.target === ForgeInputReferencePromptElement) Object.freeze(this);
  }
}
