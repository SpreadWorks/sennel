import { repairJson } from "../../lib/json-parse.js";
import {
  GLOBAL_PROMPT_ELEMENT_HARD_MAX,
  LinearPromptBatchTopology,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptResponseCoverageInvalidFailure,
  PromptResponseInvalidFailure,
} from "../../lib/prompt-batching.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { DocumentationAgent } from "./documentation-agent.js";
import { extractCommentBlock } from "./directive-parser.js";
import { MarkdownBlockPromptElement, documentationSourceRevision } from "./prompt-elements.js";

const DIRECTIVE_RE = /^(?:\{\{|\{%)/;
const HEADING_RE = /^(\s{0,3}#{1,6})(?:\s+|$)/;
const SETEXT_HEADING_RE = /^\s{0,3}(?:=+|-+)[ \t]*$/;
const SETEXT_HEADING_TEXT_RE = /^ {0,3}\S.*$/;
const QUOTE_PREFIX_RE = /^\s{0,3}>[ \t]?/;
const LIST_PREFIX_RE = /^\s{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

function translationToneInstruction(tone, toLang) {
  if (toLang !== "ja") return tone;
  return {
    polite: "Use です/ます style (敬体).",
    formal: "Use である style (常体).",
    casual: "Use casual, conversational tone (口語的).",
  }[tone] || tone;
}

function linesWithEndings(text) {
  if (text === "") return [];
  return text.match(/[^\n]*(?:\n|$)/g).filter((line) => line !== "");
}

function lineWithoutEnding(line) {
  return line.replace(/\r?\n$/, "");
}

function isTableStart(lines, index) {
  return index + 1 < lines.length
    && lines[index].includes("|")
    && TABLE_SEPARATOR_RE.test(lineWithoutEnding(lines[index + 1]));
}

function setextHeadingEnd(lines, index, listContext) {
  if (index + 1 >= lines.length) return null;
  const firstLine = lineWithoutEnding(lines[index]);
  if (!SETEXT_HEADING_TEXT_RE.test(firstLine)
    || SETEXT_HEADING_RE.test(firstLine)
    || QUOTE_PREFIX_RE.test(firstLine)
    || LIST_PREFIX_RE.test(firstLine)) return null;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lineWithoutEnding(lines[cursor]);
    if (SETEXT_HEADING_RE.test(line)) return cursor + 1;
    if (!SETEXT_HEADING_TEXT_RE.test(line)
      || QUOTE_PREFIX_RE.test(line)
      || LIST_PREFIX_RE.test(line)
      || MarkdownFence.opening(line, listContext)
      || HEADING_RE.test(line)
      || isTableStart(lines, cursor)) return null;
    const comment = extractCommentBlock(line, lines, cursor);
    if (comment && DIRECTIVE_RE.test(comment.content)) return null;
  }
  return null;
}

function isSetextHeadingBodyLine(lines, index, listContext) {
  const line = lineWithoutEnding(lines[index]);
  return SETEXT_HEADING_TEXT_RE.test(line)
    && !SETEXT_HEADING_RE.test(line)
    && !QUOTE_PREFIX_RE.test(line)
    && !LIST_PREFIX_RE.test(line)
    && !MarkdownFence.opening(line, listContext)
    && !HEADING_RE.test(line)
    && !isTableStart(lines, index);
}

class MarkdownQuoteFencePrefix {
  consume(consumption) {
    const match = consumption.text.match(QUOTE_PREFIX_RE);
    return match
      ? new MarkdownFencePrefixConsumption({
        text: consumption.text.slice(match[0].length),
        column: advanceIndentColumn(consumption.column, match[0]),
      })
      : null;
  }
}

class MarkdownListFencePrefix {
  constructor(continuationColumn) {
    if (!Number.isSafeInteger(continuationColumn) || continuationColumn < 1) throw new TypeError("Markdown list continuation column is invalid");
    this.continuationColumn = continuationColumn;
    Object.freeze(this);
  }

  consume(consumption) {
    let text = consumption.text;
    let column = consumption.column;
    while (column < this.continuationColumn && /^[ \t]/.test(text)) {
      const char = text[0];
      const nextColumn = advanceIndentColumn(column, char);
      if (nextColumn > this.continuationColumn) {
        return new MarkdownFencePrefixConsumption({
          text: " ".repeat(nextColumn - this.continuationColumn) + text.slice(1),
          column: this.continuationColumn,
        });
      }
      column = nextColumn;
      text = text.slice(1);
    }
    return column === this.continuationColumn
      ? new MarkdownFencePrefixConsumption({ text, column })
      : null;
  }
}

function advanceIndentColumn(column, text) {
  let next = column;
  for (const char of text) next = char === "\t" ? next + (4 - (next % 4)) : next + 1;
  return next;
}

function matchFence(text, column) {
  let offset = 0;
  let currentColumn = column;
  while (offset < text.length && /^[ \t]$/.test(text[offset])) {
    const nextColumn = advanceIndentColumn(currentColumn, text[offset]);
    if (nextColumn - column > 3) return null;
    currentColumn = nextColumn;
    offset += 1;
  }
  return text.slice(offset).match(/^(`{3,}|~{3,})(.*)$/);
}

class MarkdownFencePrefixConsumption {
  constructor({ text, column } = {}) {
    if (typeof text !== "string") throw new TypeError("Markdown fence prefix text is required");
    if (!Number.isSafeInteger(column) || column < 0) throw new TypeError("Markdown fence prefix column is invalid");
    this.text = text;
    this.column = column;
    Object.freeze(this);
  }
}

class MarkdownFenceContainer {
  constructor({ text, column, prefixes = [] } = {}) {
    if (typeof text !== "string") throw new TypeError("Markdown fence container text is required");
    if (!Number.isSafeInteger(column) || column < 0) throw new TypeError("Markdown fence container column is invalid");
    if (!Array.isArray(prefixes) || prefixes.some((prefix) => !(prefix instanceof MarkdownQuoteFencePrefix) && !(prefix instanceof MarkdownListFencePrefix))) {
      throw new TypeError("Markdown fence container prefixes are invalid");
    }
    this.text = text;
    this.column = column;
    this.prefixes = Object.freeze([...prefixes]);
    Object.freeze(this);
  }

  static parse(line) {
    let consumption = new MarkdownFencePrefixConsumption({ text: line.replace(/\r$/, ""), column: 0 });
    const prefixes = [];
    while (true) {
      const quote = consumption.text.match(QUOTE_PREFIX_RE);
      if (quote) {
        prefixes.push(new MarkdownQuoteFencePrefix());
        consumption = new MarkdownFencePrefixConsumption({
          text: consumption.text.slice(quote[0].length),
          column: advanceIndentColumn(consumption.column, quote[0]),
        });
        continue;
      }
      const list = consumption.text.match(LIST_PREFIX_RE);
      if (list) {
        const column = advanceIndentColumn(consumption.column, list[0]);
        prefixes.push(new MarkdownListFencePrefix(column));
        consumption = new MarkdownFencePrefixConsumption({ text: consumption.text.slice(list[0].length), column });
        continue;
      }
      return new MarkdownFenceContainer({ text: consumption.text, column: consumption.column, prefixes });
    }
  }

  hasList() {
    return this.prefixes.some((prefix) => prefix instanceof MarkdownListFencePrefix);
  }

  consumePrefix(line) {
    let consumption = new MarkdownFencePrefixConsumption({ text: line.replace(/\r$/, ""), column: 0 });
    for (let index = 0; index < this.prefixes.length; index += 1) {
      if (consumption.text.trim() === "") {
        return this.prefixes.slice(index).every((prefix) => prefix instanceof MarkdownListFencePrefix) ? consumption : null;
      }
      const prefix = this.prefixes[index];
      consumption = prefix.consume(consumption);
      if (consumption === null) return null;
    }
    return consumption;
  }

  consume(line) {
    return this.consumePrefix(line)?.text ?? null;
  }

  contains(line) {
    return this.consume(line) !== null;
  }

  withText(text, column = this.column) {
    return new MarkdownFenceContainer({ text, column, prefixes: this.prefixes });
  }
}

class MarkdownListFenceContext {
  constructor(container) {
    if (!(container instanceof MarkdownFenceContainer) || !container.hasList()) throw new TypeError("Markdown list fence container is required");
    this.container = container.withText("");
    Object.freeze(this);
  }

  static advance(context, lines) {
    let next = context;
    for (const line of lines) {
      const normalized = line.replace(/\n$/, "");
      const parsed = MarkdownFenceContainer.parse(normalized);
      if (parsed.hasList()) next = new MarkdownListFenceContext(parsed);
      else if (next && !next.container.contains(normalized)) next = null;
    }
    return next;
  }
}

class MarkdownFence {
  constructor({ marker, info, container } = {}) {
    if (typeof marker !== "string" || !/^(?:`{3,}|~{3,})$/.test(marker)) throw new TypeError("Markdown fence marker is invalid");
    if (typeof info !== "string") throw new TypeError("Markdown fence info is required");
    if (!(container instanceof MarkdownFenceContainer)) throw new TypeError("Markdown fence container is required");
    this.marker = marker;
    this.info = info;
    this.container = container;
    Object.freeze(this);
  }

  static opening(line, listContext) {
    const container = MarkdownFenceContainer.parse(line);
    const match = matchFence(container.text, container.column);
    if (listContext instanceof MarkdownListFenceContext && !container.hasList()) {
      const inherited = listContext.container.consumePrefix(line);
      const inheritedMatch = inherited && matchFence(inherited.text, inherited.column);
      if (inheritedMatch) {
        return new MarkdownFence({
          marker: inheritedMatch[1],
          info: inheritedMatch[2].trim(),
          container: listContext.container.withText(inherited.text, inherited.column),
        });
      }
    }
    return match ? new MarkdownFence({ marker: match[1], info: match[2].trim(), container }) : null;
  }

  isMermaid() {
    return /^mermaid$/i.test(this.info);
  }

  matchesClosing(line) {
    const consumption = this.container.consumePrefix(line);
    if (consumption === null) return false;
    const match = matchFence(consumption.text, consumption.column);
    return match !== null && match[1][0] === this.marker[0] && match[1].length >= this.marker.length
      && /^[ \t]*$/.test(match[2]);
  }

  continues(line) {
    return this.container.contains(line);
  }
}

function classify(lines, index, listContext) {
  const line = lineWithoutEnding(lines[index]);
  const opening = MarkdownFence.opening(line, listContext);
  if (opening) return opening.isMermaid() ? "mermaid-fence" : "code-fence";
  const comment = extractCommentBlock(line, lines, index);
  if (comment && DIRECTIVE_RE.test(comment.content)) return "directive";
  if (HEADING_RE.test(line) || setextHeadingEnd(lines, index, listContext) !== null) return "heading";
  if (isTableStart(lines, index)) return "table";
  if (line.trim() === "") return "blank";
  return "paragraph";
}

function consumeBlock(lines, index, kind, listContext) {
  if (kind === "code-fence" || kind === "mermaid-fence") {
    const opening = MarkdownFence.opening(lineWithoutEnding(lines[index]), listContext);
    let end = index + 1;
    while (end < lines.length) {
      if (opening.matchesClosing(lineWithoutEnding(lines[end]))) return end + 1;
      if (!opening.continues(lineWithoutEnding(lines[end]))) return end;
      end += 1;
    }
    return lines.length;
  }
  if (kind === "directive") return extractCommentBlock(lines[index], lines, index).endIndex + 1;
  if (kind === "table") {
    let end = index + 2;
    while (end < lines.length && lines[end].includes("|") && lines[end].trim() !== "") end += 1;
    return end;
  }
  if (kind === "blank") {
    let end = index + 1;
    while (end < lines.length && lines[end].trim() === "") end += 1;
    return end;
  }
  if (kind === "heading") return setextHeadingEnd(lines, index, listContext) ?? index + 1;
  if (kind !== "paragraph") return index + 1;
  let paragraphContext = MarkdownListFenceContext.advance(listContext, [lines[index]]);
  let end = index + 1;
  while (end < lines.length && classify(lines, end, paragraphContext) === "paragraph") {
    paragraphContext = MarkdownListFenceContext.advance(paragraphContext, [lines[end]]);
    end += 1;
  }
  return end;
}

export class MarkdownPromptDocument {
  constructor({ id, content, template = false } = {}) {
    if (typeof id !== "string" || id === "") throw new TypeError("Markdown document ID is required");
    if (typeof content !== "string") throw new TypeError("Markdown document content must be text");
    this.id = id;
    this.content = content;
    this.template = template === true;
    this.sourceRevision = documentationSourceRevision(content);
    this.elements = Object.freeze(this.#parse());
    if (this.elements.map((element) => element.text).join("") !== content) {
      throw new Error(`Markdown block coverage did not reconstruct ${id}`);
    }
    Object.freeze(this);
  }

  #parse() {
    const lines = linesWithEndings(this.content);
    const elements = [];
    let index = 0;
    let sequence = 0;
    let listContext = null;
    while (index < lines.length) {
      const kind = classify(lines, index, listContext);
      const end = consumeBlock(lines, index, kind, listContext);
      const text = lines.slice(index, end).join("");
      const blockKind = this.template && kind === "directive" ? "template-directive" : kind;
      const protectedBlock = kind === "code-fence" || (kind === "directive" && !this.template) || kind === "blank";
      // A paragraph containing an inline directive cannot be split safely:
      // a range cut through its HTML comment would turn a protected token
      // into two ordinary prose fragments.
      const partitionable = kind === "paragraph" && directiveComments(text).length === 0;
      elements.push(new MarkdownBlockPromptElement({
        id: `${this.id}:block:${sequence}`,
        originId: `${this.id}:block:${sequence}`,
        sourceRevision: this.sourceRevision,
        sequence,
        text,
        start: 0,
        end: text.length,
        sourceLength: text.length,
        blockKind,
        protectedBlock,
        partitionable,
      }));
      if (kind === "paragraph" || kind === "blank") {
        listContext = MarkdownListFenceContext.advance(listContext, lines.slice(index, end));
      } else if (kind === "code-fence" || kind === "mermaid-fence") {
        listContext = MarkdownListFenceContext.advance(listContext, [lines[index]]);
      } else if (!listContext || !listContext.container.contains(lines[index])) {
        listContext = null;
      }
      sequence += 1;
      index = end;
    }
    return elements;
  }
}

function directiveComments(text) {
  return (text.match(/<!--[\s\S]*?-->/g) || []).filter((comment) => /(?:\{\{|\{%)/.test(comment));
}

function maskDirectiveField(text, field) {
  const pattern = new RegExp(`(${field}\\s*:\\s*")(?:\\\\.|[^"\\\\])*(")`, "s");
  return pattern.test(text) ? text.replace(pattern, "$1<translated>$2") : null;
}

function validateTemplateDirective(before, after, elementId) {
  if (before.split("\n").length !== after.split("\n").length) {
    throw new PromptResponseInvalidFailure(`Template directive line boundary changed: ${elementId}`, { elementId });
  }
  if (/\{\{text\s*\(/s.test(before)) {
    const maskedBefore = maskDirectiveField(before, "prompt");
    const maskedAfter = maskDirectiveField(after, "prompt");
    if (!maskedBefore || maskedBefore !== maskedAfter) {
      throw new PromptResponseInvalidFailure(`Template text directive syntax changed: ${elementId}`, { elementId });
    }
    return;
  }
  if (/\{\{data\s*\(/s.test(before)) {
    const maskedBefore = maskDirectiveField(before, "labels");
    const maskedAfter = maskDirectiveField(after, "labels");
    if (maskedBefore ? maskedBefore !== maskedAfter : before !== after) {
      throw new PromptResponseInvalidFailure(`Template data directive syntax changed: ${elementId}`, { elementId });
    }
    return;
  }
  if (before !== after) throw new PromptResponseInvalidFailure(`Template control directive changed: ${elementId}`, { elementId });
}

function maskMermaidLabels(line) {
  return line
    .replace(/\[[^\]]*\]/g, "[<label>]")
    .replace(/\|[^|]*\|/g, "|<label>|")
    .replace(/"(?:\\.|[^"\\])*"/g, '"<label>"');
}

function validateMermaidFence(before, after, elementId) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length !== afterLines.length
    || beforeLines.some((line, index) => maskMermaidLabels(line) !== maskMermaidLabels(afterLines[index] ?? ""))) {
    throw new PromptResponseInvalidFailure(`Mermaid structure changed: ${elementId}`, { elementId });
  }
}

function validateHeadingBoundary(before, after, elementId) {
  const beforeLines = linesWithEndings(before);
  const afterLines = linesWithEndings(after);
  if (beforeLines.length !== afterLines.length) {
    throw new PromptResponseInvalidFailure(`Markdown heading line boundary changed: ${elementId}`, { elementId });
  }

  const beforeAtx = lineWithoutEnding(beforeLines[0]).match(HEADING_RE);
  const afterAtx = lineWithoutEnding(afterLines[0]).match(HEADING_RE);
  if (beforeAtx || afterAtx) {
    if (!beforeAtx || !afterAtx || beforeAtx[1] !== afterAtx[1]) {
      throw new PromptResponseInvalidFailure(`Markdown heading boundary changed: ${elementId}`, { elementId });
    }
    return;
  }

  const beforeUnderline = lineWithoutEnding(beforeLines.at(-1));
  const afterUnderline = lineWithoutEnding(afterLines.at(-1));
  if (!SETEXT_HEADING_RE.test(beforeUnderline)
    || beforeUnderline !== afterUnderline
    || !SETEXT_HEADING_RE.test(afterUnderline)) {
    throw new PromptResponseInvalidFailure(`Markdown heading boundary changed: ${elementId}`, { elementId });
  }
  for (let index = 0; index < afterLines.length - 1; index += 1) {
    if (!isSetextHeadingBodyLine(afterLines, index, null)) {
      throw new PromptResponseInvalidFailure(`Markdown setext heading structure changed: ${elementId}`, { elementId });
    }
    const comment = extractCommentBlock(afterLines[index], afterLines, index);
    if (comment && DIRECTIVE_RE.test(comment.content)) {
      throw new PromptResponseInvalidFailure(`Markdown heading directive boundary changed: ${elementId}`, { elementId });
    }
  }
}

export class MarkdownBlockTranslationResult {
  constructor({ element, text } = {}) {
    if (!(element instanceof MarkdownBlockPromptElement)) throw new TypeError("Markdown translation result requires its source element");
    if (typeof text !== "string") throw new TypeError("Markdown translation result text is required");
    if (!element.protectedBlock && element.text.trim() !== "" && text.trim() === "") {
      throw new PromptResponseInvalidFailure(`Translated Markdown block must not be blank: ${element.id}`, { elementId: element.id });
    }
    if (element.protectedBlock && text !== element.text) {
      throw new PromptResponseInvalidFailure(`Protected Markdown block changed: ${element.id}`, { elementId: element.id });
    }
    if (element.blockKind === "template-directive") validateTemplateDirective(element.text, text, element.id);
    if (element.blockKind === "mermaid-fence") validateMermaidFence(element.text, text, element.id);
    if (element.blockKind !== "template-directive") {
      const beforeDirectives = directiveComments(element.text);
      const afterDirectives = directiveComments(text);
      if (beforeDirectives.length !== afterDirectives.length
        || beforeDirectives.some((directive, index) => directive !== afterDirectives[index])) {
        throw new PromptResponseInvalidFailure(`Inline Markdown directive changed: ${element.id}`, { elementId: element.id });
      }
    }
    if (element.blockKind === "heading") validateHeadingBoundary(element.text, text, element.id);
    if (element.blockKind === "table") {
      const before = element.text.split("\n");
      const after = text.split("\n");
      if (before.length !== after.length || after.some((line, index) => (line.match(/\|/g) || []).length !== (before[index].match(/\|/g) || []).length)) {
        throw new PromptResponseInvalidFailure(`Markdown table structure changed: ${element.id}`, { elementId: element.id });
      }
      if (before.some((line, index) => TABLE_SEPARATOR_RE.test(lineWithoutEnding(line))
        && lineWithoutEnding(line) !== lineWithoutEnding(after[index]))) {
        throw new PromptResponseInvalidFailure(`Markdown table separator changed: ${element.id}`, { elementId: element.id });
      }
    }
    this.element = element;
    this.text = text;
    Object.freeze(this);
  }
}

export class MarkdownTranslationResponseContract {
  parse(raw, batch) {
    let parsed;
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch (cause) {
      throw new PromptResponseInvalidFailure("Markdown translation response is not valid JSON", { batchId: batch.digest }, cause);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PromptResponseInvalidFailure("Markdown translation response must be an object", { batchId: batch.digest });
    }
    const expected = batch.elements.map((element) => element.id);
    const actual = Object.keys(parsed);
    if (actual.length !== expected.length || expected.some((id) => typeof parsed[id] !== "string") || actual.some((id) => !expected.includes(id))) {
      throw new PromptResponseCoverageInvalidFailure("Markdown translation response does not exactly cover its block IDs", { expected, actual });
    }
    return Object.freeze(batch.elements.map((element) => new MarkdownBlockTranslationResult({
      element,
      text: parsed[element.id],
    })));
  }
}

export class MarkdownTranslationPromptEnvelope extends PromptRequestEnvelope {
  constructor({ fromLang, toLang, documentStyle, template = false } = {}) {
    super({ revision: template ? "docs-template-translation-v2" : "docs-translation-v2" });
    this.fromLang = fromLang;
    this.toLang = toLang;
    this.documentStyle = documentStyle || null;
    this.template = template;
    Object.freeze(this);
  }

  build(elements, chunkContext) {
    const pb = new PromptBuilder();
    pb.setRole(`Translate Markdown blocks from ${this.fromLang} to ${this.toLang}.`);
    const rules = [
      "- Return exactly one JSON string for every block ID and no foreign IDs.",
      "- Preserve block order and Markdown structure.",
      "- Return blocks marked protected=true byte-for-byte unchanged.",
      "- Preserve heading markers, table row counts, table pipe counts, inline code, paths, commands, links, identifiers, and variables.",
      "- Translate prose, heading text, table cell text, and descriptive labels inside mermaid diagrams naturally.",
      "- Do not translate word-by-word. Restructure sentences according to natural target-language grammar and conventions.",
      "- Prefer natural equivalents over unnecessary loanwords, and avoid verbose nominalization or passive constructions.",
      "- Follow the target language's cultural and technical-writing conventions so the result reads as originally written in that language.",
      "- Do not add commentary.",
    ];
    if (this.template) rules.push("- In template-directive blocks, translate only text prompt values and data labels; preserve every other syntax byte and line boundary.");
    if (this.documentStyle?.tone) rules.push(`- Writing tone: ${translationToneInstruction(this.documentStyle.tone, this.toLang)}`);
    if (this.documentStyle?.customInstruction) rules.push(`- ${this.documentStyle.customInstruction}`);
    pb.setRules(rules.join("\n"));
    pb.addUserPrompt(
      `## Markdown blocks (batch ${chunkContext.index + 1}/${chunkContext.count})`,
      elements.map((element) => element.toPromptText()).join("\n\n--- block boundary ---\n\n"),
    );
    const properties = Object.fromEntries(elements.map((element) => [element.id, { type: "string" }]));
    pb.setJsonSchema({
      type: "object",
      properties,
      required: elements.map((element) => element.id),
      additionalProperties: false,
    });
    pb.setFmtFallback("Return only a JSON object mapping every supplied blockId to its translated block text.");
    return pb.build();
  }
}

export class MarkdownTranslationReducer extends PromptBatchReducer {
  constructor(document) {
    super();
    if (!(document instanceof MarkdownPromptDocument)) throw new TypeError("Markdown reducer requires a document");
    this.document = document;
  }

  reduce(completions) {
    const results = completions.flatMap((completion) => completion.response);
    const byId = new Map();
    for (const result of results) {
      if (byId.has(result.element.id)) throw new PromptResponseCoverageInvalidFailure(`Duplicate Markdown block result: ${result.element.id}`);
      byId.set(result.element.id, result);
    }
    const grouped = new Map();
    for (const result of results) {
      const list = grouped.get(result.element.originId) || [];
      list.push(result);
      grouped.set(result.element.originId, list);
    }
    const parts = [];
    for (const original of this.document.elements) {
      const fragments = grouped.get(original.originId);
      if (!fragments || fragments.length === 0) throw new PromptResponseCoverageInvalidFailure(`Missing Markdown block result: ${original.originId}`);
      fragments.sort((a, b) => a.element.start - b.element.start);
      let offset = 0;
      for (const fragment of fragments) {
        if (fragment.element.start !== offset) throw new PromptResponseCoverageInvalidFailure(`Markdown block range gap: ${original.originId}`);
        offset = fragment.element.end;
      }
      if (offset !== original.sourceLength) throw new PromptResponseCoverageInvalidFailure(`Markdown block range incomplete: ${original.originId}`);
      parts.push(fragments.map((fragment) => fragment.text).join(""));
    }
    return parts.join("");
  }
}

export async function translateMarkdownWithBatches({
  content,
  documentId,
  fromLang,
  toLang,
  agent,
  commandId,
  documentStyle,
  template = false,
  maxCharacters,
  concurrency = 1,
} = {}) {
  const document = new MarkdownPromptDocument({ id: documentId, content, template });
  if (document.elements.length === 0) return content;
  const docsAgent = DocumentationAgent.from(agent);
  const resolvedLimit = maxCharacters ?? docsAgent.promptCharacterLimit ?? GLOBAL_PROMPT_ELEMENT_HARD_MAX;
  const limit = new PromptRequestLimit({ maxCharacters: resolvedLimit });
  const envelope = new MarkdownTranslationPromptEnvelope({ fromLang, toLang, documentStyle, template });
  const builder = new PromptInputBuilder({ envelope, limit });
  for (const element of document.elements) builder.add(element);
  const collection = builder.build();
  const executionLimit = new PromptExecutionLimit({ maxRequestCharacters: resolvedLimit, concurrency });
  const plan = PromptBatchPlan.create({
    collection,
    envelope,
    limit,
    topology: new LinearPromptBatchTopology(),
    executionLimit,
  });
  return new PromptBatchExecutor({ executionLimit }).execute({
    plan,
    responseContract: new MarkdownTranslationResponseContract(),
    reducer: new MarkdownTranslationReducer(document),
    callAgent: (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
      commandId,
      systemPrompt: request.systemPrompt,
      jsonSchema: request.jsonSchema,
      fmtFallback: request.fmtFallback,
      providerCallAdmission,
    }),
    projectInvocation: typeof agent.projectInvocation === "function"
      ? (request) => docsAgent.projectInvocation(request.userPrompt, {
        commandId,
        systemPrompt: request.systemPrompt,
        jsonSchema: request.jsonSchema,
        fmtFallback: request.fmtFallback,
      })
      : undefined,
  });
}
