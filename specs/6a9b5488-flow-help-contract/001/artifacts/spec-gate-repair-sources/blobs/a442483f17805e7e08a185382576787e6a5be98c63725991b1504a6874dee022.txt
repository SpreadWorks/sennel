export const MARKDOWN_FORMAT_TABLE = "table";
export const MARKDOWN_FORMAT_LIST = "list";

export function assertMarkdownFormat(format) {
  if (format === MARKDOWN_FORMAT_TABLE || format === MARKDOWN_FORMAT_LIST) {
    return format;
  }
  throw new Error(
    `Unsupported Markdown format "${String(format)}"; expected "${MARKDOWN_FORMAT_TABLE}" or "${MARKDOWN_FORMAT_LIST}"`,
  );
}

/**
 * Renderable — value-type hierarchy for DataSource resolver return values.
 *
 * Base class + 8 concrete Markdown block types. DataSource methods return
 * `Renderable | null`; the directive expansion layer invokes `.toMarkdown()`
 * polymorphically, freeing it from type branching. Constructors enforce
 * invariants at construction time so shape errors surface where they are
 * introduced rather than at render time.
 *
 * Adding a new output format (e.g. HTML) means adding a new method to each
 * class; existing `toMarkdown()` implementations and callers stay untouched.
 */

export class Renderable {
  toMarkdown() {
    throw new Error("Renderable.toMarkdown() is abstract; subclass must override");
  }

  toMarkdownFormat(format) {
    const resolvedFormat = assertMarkdownFormat(format);
    if (resolvedFormat === MARKDOWN_FORMAT_TABLE) return this.toMarkdown();
    if (resolvedFormat === MARKDOWN_FORMAT_LIST) {
      throw new Error(`format "list" requires a Table renderable`);
    }
  }
}

function normalizeCell(v) {
  return String(v ?? "—");
}

function escapeCell(v) {
  return normalizeCell(v).replace(/\|/g, "\\|");
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function renderPart(part) {
  return part instanceof Renderable ? part.toMarkdown() : String(part);
}

export class Table extends Renderable {
  constructor(labels, rows) {
    super();
    if (!Array.isArray(labels) || labels.length === 0) {
      throw new Error("Table requires non-empty labels");
    }
    if (!Array.isArray(rows)) {
      throw new Error("Table rows must be an array");
    }
    for (const [i, r] of rows.entries()) {
      if (!Array.isArray(r) || r.length !== labels.length) {
        throw new Error(
          `Table row ${i} column count mismatch: expected ${labels.length}, got ${Array.isArray(r) ? r.length : "non-array"}`,
        );
      }
    }
    this.labels = labels;
    this.rows = rows;
  }

  toMarkdown() {
    const header = `| ${this.labels.map(escapeCell).join(" | ")} |`;
    const sep = `| ${this.labels.map(() => "---").join(" | ")} |`;
    const body = this.rows
      .map((r) => `| ${r.map(escapeCell).join(" | ")} |`)
      .join("\n");
    return [header, sep, body].join("\n");
  }

  toMarkdownList() {
    if (this.labels.length !== 2) {
      throw new Error(
        `format "list" requires a 2-column Table, got ${this.labels.length} columns`,
      );
    }
    // Preserve Table.toMarkdown() row-volume semantics; DataSources own row limits.
    return this.rows
      .map(([key, value]) => `- ${normalizeCell(key)}: ${normalizeCell(value)}`)
      .join("\n");
  }

  toMarkdownFormat(format) {
    if (format === MARKDOWN_FORMAT_LIST) return this.toMarkdownList();
    return super.toMarkdownFormat(format);
  }
}

export class BulletList extends Renderable {
  constructor(items) {
    super();
    if (!Array.isArray(items)) throw new Error("BulletList items must be an array");
    this.items = items;
  }

  toMarkdown() {
    if (this.items.length === 0) return "";
    return this.items
      .map((item) => {
        const body = renderPart(item);
        if (!body.includes("\n")) return `- ${body}`;
        const [first, ...rest] = body.split("\n");
        return [`- ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
      })
      .join("\n");
  }
}

export class OrderedList extends Renderable {
  constructor(items) {
    super();
    if (!Array.isArray(items)) throw new Error("OrderedList items must be an array");
    this.items = items;
  }

  toMarkdown() {
    if (this.items.length === 0) return "";
    return this.items
      .map((item, i) => {
        const marker = `${i + 1}. `;
        const pad = " ".repeat(marker.length);
        const body = renderPart(item);
        if (!body.includes("\n")) return `${marker}${body}`;
        const [first, ...rest] = body.split("\n");
        return [`${marker}${first}`, ...rest.map((l) => `${pad}${l}`)].join("\n");
      })
      .join("\n");
  }
}

export class Paragraph extends Renderable {
  constructor(text) {
    super();
    this.text = String(text ?? "");
  }

  toMarkdown() {
    return this.text;
  }
}

export class CodeBlock extends Renderable {
  constructor(code, lang = "") {
    super();
    this.code = String(code ?? "");
    this.lang = String(lang ?? "");
  }

  toMarkdown() {
    return `\`\`\`${this.lang}\n${this.code}\n\`\`\``;
  }
}

export class Blockquote extends Renderable {
  constructor(content) {
    super();
    this.content = content;
  }

  toMarkdown() {
    const body = renderPart(this.content);
    return indent(body, "> ");
  }
}

export class Heading extends Renderable {
  constructor(text, level) {
    super();
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new Error(`Heading level must be integer 1-6, got ${level}`);
    }
    this.text = String(text ?? "");
    this.level = level;
  }

  toMarkdown() {
    return `${"#".repeat(this.level)} ${this.text}`;
  }
}

export class Fragment extends Renderable {
  constructor(parts) {
    super();
    if (!Array.isArray(parts)) throw new Error("Fragment parts must be an array");
    this.parts = parts;
  }

  toMarkdown() {
    if (this.parts.length === 0) return "";
    return this.parts.map(renderPart).join("\n\n");
  }
}
