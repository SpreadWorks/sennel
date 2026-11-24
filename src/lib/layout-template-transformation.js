import { isUtf8 } from "node:buffer";
import { TextDecoder } from "node:util";
import { PRODUCT } from "./product.js";

/** Retired names are interpreted only by the explicit layout migration. */
class TemplateTokenRule {
  constructor(source, replacement, boundary = "identifier") {
    if (typeof source !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(source)
      || typeof replacement !== "string" || !["anywhere", "identifier", "camel"].includes(boundary)) {
      throw new TypeError("Template token rule requires a literal token and supported boundary");
    }
    this.source = source;
    this.replacement = replacement;
    const left = boundary === "anywhere" ? "" : "(?<![A-Za-z0-9_])";
    const right = boundary === "anywhere" ? ""
      : boundary === "camel" ? "(?=$|[A-Z]|[^A-Za-z0-9_])" : "(?=$|[^A-Za-z0-9_])";
    this.pattern = `${left}${source}${right}`;
    Object.freeze(this);
  }
}

function completeCharacterBoundary(text, end) {
  if (end > 0 && end < text.length
    && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) return end - 1;
  return end;
}

/** One ordered replacement pass with bounded original left/right context. */
class TemplateTokenStream {
  #pending = "";
  #previous = "";
  #rule;
  #expression;

  constructor(rule) {
    this.#rule = rule;
    this.#expression = new RegExp(rule.pattern, "g");
  }

  write(text) {
    this.#pending += text;
    return this.#drain(false);
  }

  finish() { return this.#drain(true); }

  #drain(final) {
    let end = final ? this.#pending.length
      : completeCharacterBoundary(this.#pending,
        Math.max(0, this.#pending.length - this.#rule.source.length - 1));
    if (end === 0) return "";
    const input = this.#previous + this.#pending;
    const prefix = this.#previous.length;
    this.#expression.lastIndex = prefix;
    let consumed = 0;
    let output = "";
    for (let match = this.#expression.exec(input); match !== null; match = this.#expression.exec(input)) {
      const start = match.index - prefix;
      if (start >= end) break;
      output += this.#pending.slice(consumed, start) + this.#rule.replacement;
      consumed = start + match[0].length;
      end = Math.max(end, consumed);
    }
    output += this.#pending.slice(consumed, end);
    this.#previous = this.#pending.slice(end - 1, end);
    this.#pending = this.#pending.slice(end);
    return output;
  }
}

export class LayoutTemplateEncodingError extends TypeError {
  constructor(cause) {
    super("Managed template is not complete valid UTF-8", { cause });
    this.code = "MIGRATION_TEMPLATE_ENCODING_INVALID";
  }
}

/** Emits provisional transformed bytes; publication still requires source proof. */
class LayoutTemplateStream {
  #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #passes;
  #emit;
  #closed = false;

  constructor(rules, emit) {
    if (typeof emit !== "function") throw new TypeError("Template output requires a byte consumer");
    this.#passes = rules.map(rule => new TemplateTokenStream(rule));
    this.#emit = emit;
  }

  write(bytes) {
    if (this.#closed) throw new Error("Template stream is already closed");
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Template input must be Buffer bytes");
    this.#accept(0, this.#decode(bytes, true));
  }

  finish() {
    if (this.#closed) throw new Error("Template stream is already closed");
    this.#closed = true;
    this.#accept(0, this.#decode(undefined, false));
    for (let index = 0; index < this.#passes.length; index += 1) {
      this.#accept(index + 1, this.#passes[index].finish());
    }
  }

  #decode(bytes, stream) {
    try { return this.#decoder.decode(bytes, { stream }); }
    catch (cause) { throw new LayoutTemplateEncodingError(cause); }
  }

  #accept(index, text) {
    if (text === "") return;
    if (index === this.#passes.length) this.#emit(Buffer.from(text, "utf8"));
    else this.#accept(index + 1, this.#passes[index].write(text));
  }
}

/** Whole-byte and streaming forms share the same ordered token rules. */
export class LayoutTemplateTransformation {
  #rules = Object.freeze([
    new TemplateTokenRule("sentiDir", "managedDir", "anywhere"),
    new TemplateTokenRule("sdd-forge", PRODUCT.machineName),
    new TemplateTokenRule("sddForge", PRODUCT.machineName, "camel"),
    new TemplateTokenRule("senti", PRODUCT.machineName, "camel"),
    new TemplateTokenRule("senrail", PRODUCT.machineName, "camel"),
    new TemplateTokenRule("SddForge", PRODUCT.displayName, "camel"),
    new TemplateTokenRule("Senti", PRODUCT.displayName, "camel"),
    new TemplateTokenRule("Senrail", PRODUCT.displayName, "camel"),
    new TemplateTokenRule("SDD_FORGE", PRODUCT.machineName.toUpperCase()),
    new TemplateTokenRule("SENTI", PRODUCT.machineName.toUpperCase()),
    new TemplateTokenRule("SENRAIL", PRODUCT.machineName.toUpperCase()),
  ]);

  transformText(text) {
    for (const rule of this.#rules) text = text.replace(new RegExp(rule.pattern, "g"), () => rule.replacement);
    return text;
  }

  createStream(emit) { return new LayoutTemplateStream(this.#rules, emit); }

  transform(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Template input must be Buffer bytes");
    if (!isUtf8(bytes)) return bytes;
    return Buffer.from(this.transformText(bytes.toString("utf8")), "utf8");
  }
}
