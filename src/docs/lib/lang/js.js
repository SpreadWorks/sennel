/**
 * JS/TS language handler.
 * Provides parse, minify, extractImports, extractExports, extractEssential.
 */

import path from "node:path";
import { hasSlashPrefix } from "./comments.js";

// ---------------------------------------------------------------------------
// Minify
// ---------------------------------------------------------------------------

const LINE_COMMENT_PATTERN = /(?<!:)\/\/.*/;

function removeBlockComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "");
}

function removeLineComments(code, pattern) {
  return code
    .split("\n")
    .map((line) => {
      if (hasSlashPrefix(line)) return line;
      return line.replace(pattern, "").trimEnd();
    })
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function normalizeIndent(code, from, to) {
  return code
    .split("\n")
    .map((line) => {
      const match = line.match(/^( +)/);
      if (!match) return line;
      const spaces = match[1].length;
      const level = Math.floor(spaces / from);
      const remainder = spaces % from;
      return " ".repeat(level * to + remainder) + line.slice(spaces);
    })
    .join("\n");
}

export function minify(code) {
  let result = removeBlockComments(code);
  result = removeLineComments(result, LINE_COMMENT_PATTERN);
  result = normalizeIndent(result, 4, 2);
  return result;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parse(content, filePath) {
  const className = path.basename(filePath).replace(/\.[^.]+$/, "");

  // export function / export class
  const funcRegex = /export\s+(?:async\s+)?(?:function|class)\s+(\w+)/g;
  const methods = [];
  let m;
  while ((m = funcRegex.exec(content)) !== null) {
    methods.push(m[1]);
  }

  // function xxx (non-export)
  const localFuncRegex = /^(?:async\s+)?function\s+(\w+)/gm;
  while ((m = localFuncRegex.exec(content)) !== null) {
    if (!methods.includes(m[1])) {
      methods.push(m[1]);
    }
  }

  // extends
  const extendsMatch = content.match(/class\s+\w+\s+extends\s+(\w+)/);
  const parentClass = extendsMatch ? extendsMatch[1] : "";

  return { className, parentClass, methods, properties: {}, relations: {}, content };
}

// ---------------------------------------------------------------------------
// Extract imports
// ---------------------------------------------------------------------------

class ImportExpressionContext {
  constructor(closing) {
    this.closing = closing;
    this.conditionals = 0;
    this.functionParameters = null;
    this.functionBody = null;
    this.classBody = null;
    this.classNamePending = false;
  }

  get statementScope() { return false; }
  get expressionAfterClose() { return false; }
  get bodyAfterClose() { return null; }
  get resumesTemplate() { return false; }

  beginConditional() { this.conditionals++; }

  endConditional() {
    if (this.conditionals === 0) return false;
    this.conditionals--;
    return true;
  }

  openParameters(control) {
    if (this.classNamePending) this.classBody = null;
    const parameters = this.functionParameters || (control ? new ImportControlContext() : new ImportExpressionContext(")"));
    this.functionParameters = null;
    return parameters;
  }

  openBody(statementStart, expressionStart, previous) {
    const body = this.functionBody || this.classBody || (previous === "=>"
      ? new ImportExpressionBodyContext("}")
      : statementStart || !expressionStart || previous === ")"
        ? new ImportStatementContext("}")
        : new ImportExpressionContext("}"));
    if (body === this.classBody) this.classBody = null;
    this.functionBody = null;
    return body;
  }
}

class ImportStatementContext extends ImportExpressionContext {
  get statementScope() { return true; }
  get expressionAfterClose() { return true; }
}

// A function/arrow expression contains statements but completes an operand.
class ImportExpressionBodyContext extends ImportStatementContext {
  get expressionAfterClose() { return false; }
}

class ImportControlContext extends ImportExpressionContext {
  constructor() { super(")"); }
  get expressionAfterClose() { return true; }
}

class ImportFunctionParameters extends ImportExpressionContext {
  constructor(declaration) {
    super(")");
    this.body = declaration
      ? new ImportStatementContext("}")
      : new ImportExpressionBodyContext("}");
  }

  get bodyAfterClose() { return this.body; }
}

class ImportClassContext extends ImportExpressionContext {
  constructor(declaration) {
    super("}");
    this.declaration = declaration;
  }

  get expressionAfterClose() { return this.declaration; }
}

class ImportTemplateInterpolation extends ImportExpressionContext {
  constructor() { super("}"); }
  get resumesTemplate() { return true; }
}

function findImportMembers(content, comment, padding, quotedString) {
  const tokens = new RegExp(
    String.raw`${comment}|${quotedString}|(\.${padding})(?=import\b)|[\p{ID_Continue}$]+|=>|\+\+|--|[^\s]`,
    "gu",
  );
  const regexLiteral = /\/(?:\\[^]|\[(?:\\[^]|[^\]\\\r\n\u2028\u2029])*\]|[^/\\[\r\n\u2028\u2029])+\/[\p{ID_Continue}$]*/uy;
  const templateText = /(?:\\[^]|[^\\`$]|\$(?!\{))*(?:`|\$\{|$)/y;
  const expressionKeywords = new Set(["return", "throw", "case", "yield", "await", "void", "typeof", "delete", "in", "instanceof"]);
  const statementKeywords = new Set(["else", "do", "try", "finally"]);
  const declarationModifiers = new Set(["export", "default", "async"]);
  const controlKeywords = new Set(["if", "while", "for", "with", "switch", "catch"]);
  const members = new Set();
  const contexts = [new ImportStatementContext("")];
  let inTemplate = false;
  let expressionStart = true;
  let statementStart = true;
  let previous = "";
  let previousEnd = 0;
  let controlStart = false;
  let token;
  while (tokens.lastIndex < content.length) {
    if (inTemplate) {
      templateText.lastIndex = tokens.lastIndex;
      const text = templateText.exec(content);
      if (!text) break;
      tokens.lastIndex = templateText.lastIndex;
      inTemplate = false;
      if (text[0].endsWith("${")) {
        contexts.push(new ImportTemplateInterpolation());
        expressionStart = true;
      } else {
        expressionStart = false;
      }
      statementStart = false;
      previous = "literal";
      previousEnd = tokens.lastIndex;
      controlStart = false;
      continue;
    }
    token = tokens.exec(content);
    if (!token) break;
    const value = token[0];
    if (value.startsWith("//") || value.startsWith("/*")) continue;
    const context = contexts.at(-1);
    const lineBreak = /[\r\n\u2028\u2029]/.test(content.slice(previousEnd, token.index));
    if (context.statementScope && previous !== "." && lineBreak && (
      ["return", "break", "continue", "yield"].includes(previous)
      || (!expressionStart && ["function", "class", "async", "export"].includes(value))
    )) {
      statementStart = true;
      expressionStart = true;
    }
    if (token[1]) {
      members.add(tokens.lastIndex);
      expressionStart = false;
      statementStart = false;
      previous = ".";
      previousEnd = tokens.lastIndex;
      controlStart = false;
      continue;
    }
    if (value === "/" && expressionStart) {
      regexLiteral.lastIndex = token.index;
      if (regexLiteral.exec(content)) {
        tokens.lastIndex = regexLiteral.lastIndex;
        expressionStart = false;
        statementStart = false;
        previous = "literal";
        previousEnd = tokens.lastIndex;
        controlStart = false;
        continue;
      }
    }
    if (value === "`") {
      inTemplate = true;
    } else if (value === "function" && previous !== ".") {
      context.functionParameters = new ImportFunctionParameters(statementStart);
      statementStart = false;
      expressionStart = false;
    } else if (value === "class" && previous !== ".") {
      context.classBody = new ImportClassContext(statementStart);
      context.classNamePending = true;
      statementStart = false;
      expressionStart = false;
    } else if (value === "(") {
      contexts.push(context.openParameters(controlStart));
      expressionStart = true;
      statementStart = false;
    } else if (value === "[") {
      contexts.push(new ImportExpressionContext("]"));
      expressionStart = true;
      statementStart = false;
    } else if (value === "{") {
      // The owner of a body determines what its closing brace completes.
      const body = context.openBody(statementStart, expressionStart, previous);
      contexts.push(body);
      expressionStart = true;
      statementStart = body.statementScope;
    } else if (contexts.length > 1 && value === context.closing) {
      contexts.pop();
      contexts.at(-1).functionBody = context.bodyAfterClose;
      inTemplate = context.resumesTemplate;
      expressionStart = context.expressionAfterClose;
      statementStart = context.expressionAfterClose;
    } else if (value === ";") {
      expressionStart = true;
      statementStart = context.statementScope;
    } else if (value === ":") {
      context.functionParameters = null;
      if (context.classNamePending) context.classBody = null;
      statementStart = !context.endConditional() && context.statementScope;
      expressionStart = true;
    } else if (value === "?") {
      if (content[tokens.lastIndex] !== ".") context.beginConditional();
      expressionStart = true;
      statementStart = false;
    } else {
      const keyword = previous !== ".";
      if (keyword && statementKeywords.has(value)) {
        expressionStart = true;
        statementStart = true;
      } else if (keyword && declarationModifiers.has(value)) {
        expressionStart = false;
      } else {
        expressionStart = (keyword && expressionKeywords.has(value)) || !/^(?:[\p{ID_Continue}$]|["']|[.\]]|\+\+|--)/u.test(value);
        statementStart = false;
      }
    }
    if (value !== "class") context.classNamePending = false;
    controlStart = controlKeywords.has(value) && previous !== ".";
    previous = value;
    previousEnd = tokens.lastIndex;
  }
  return members;
}

export function extractImports(content) {
  const imports = [];

  // ESM declarations. Keep every static occurrence, including duplicates.
  // Match comments as token separators without rewriting quoted source text.
  // A block comment must end at its first terminator, even when matching backtracks.
  const comment = String.raw`(?:/\*(?:[^*]|\*(?!/))*\*/|//[^\r\n\u2028\u2029]*)`;
  const trivia = String.raw`(?:\s|${comment})`;
  const gap = `${trivia}+`;
  const padding = `${trivia}*`;
  const identifier = String.raw`(?:[\p{ID_Continue}$]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\}))+`;
  const namespaceBinding = String.raw`\*${gap}as${gap}${identifier}`;
  const quotedString = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')`;
  const namedBindings = String.raw`\{(?:${comment}|${quotedString}|[^}])*\}`;
  const defaultBinding = `${identifier}(?:${padding},${padding}(?:${namespaceBinding}|${namedBindings}))?`;
  const binding = `(?:type${gap})?(?:${defaultBinding}|${namespaceBinding}|${namedBindings})`;
  const esmRegex = new RegExp(
    String.raw`(?<![\p{ID_Continue}$.])import${gap}(?:${binding}${gap}from${padding})?(["'])([^"']+)\1`,
    "gu",
  );
  let m;
  while ((m = esmRegex.exec(content)) !== null) {
    imports.push(m[2]);
  }

  // Consume comments and strings from their starts before considering code dots.
  // Backward trivia matching could otherwise start at a dot inside a comment.
  const memberImports = findImportMembers(content, comment, padding, quotedString);

  // Add CommonJS, literal dynamic imports, and re-exports only once.
  const dynamicImportRegex = new RegExp(
    String.raw`(?<![\p{ID_Continue}$])import${padding}\(${padding}(["'])([^"']+)\1(?=${padding}(?:,|\)))`,
    "gu",
  );
  const additionalPatterns = [
    /require\s*\(\s*(["'])([^"']+)\1\s*\)/gu,
    dynamicImportRegex,
    new RegExp(
      String.raw`(?<![\p{ID_Continue}$])export${gap}(?:type${gap})?(?:\*${gap}(?:as${gap}${identifier}${gap})?|${namedBindings}${gap})from${padding}(["'])([^"']+)\1`,
      "gu",
    ),
  ];
  for (const pattern of additionalPatterns) {
    while ((m = pattern.exec(content)) !== null) {
      if (pattern === dynamicImportRegex && memberImports.has(m.index)) continue;
      const specifier = m[2];
      if (!imports.includes(specifier)) imports.push(specifier);
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Extract exports
// ---------------------------------------------------------------------------

export function extractExports(content) {
  const exports = [];

  // export function / export async function / export class
  const namedRegex = /export\s+(?:async\s+)?(?:function|class)\s+(\w+)/g;
  let m;
  while ((m = namedRegex.exec(content)) !== null) {
    exports.push(m[1]);
  }

  // export default
  if (/export\s+default\b/.test(content)) {
    exports.push("default");
  }

  // export { foo, bar }
  const reExportRegex = /export\s*\{([^}]+)\}/g;
  while ((m = reExportRegex.exec(content)) !== null) {
    const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    for (const name of names) {
      if (!exports.includes(name)) {
        exports.push(name);
      }
    }
  }

  // export const / export let / export var
  const constRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((m = constRegex.exec(content)) !== null) {
    if (!exports.includes(m[1])) {
      exports.push(m[1]);
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Essential extraction
// ---------------------------------------------------------------------------

export function extractEssential(code) {
  const lines = code.split("\n");
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^import\s/.test(t)) { kept.push(t); continue; }
    if (/^export\s/.test(t)) { kept.push(t); continue; }
    if (/^(const|let|var)\s+[A-Z_]+\s*=/.test(t)) { kept.push(t); continue; }
    if (/^(async\s+)?function\s/.test(t)) { kept.push(t); continue; }
    if (/^class\s/.test(t)) { kept.push(t); continue; }
    if (/^\s*return\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*throw\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*(await\s|new\s)/.test(line)) { kept.push(t); continue; }
    if (/\b(fs\.|path\.|JSON\.|process\.|child_process)/.test(t) && !/^\/\//.test(t)) { kept.push(t); continue; }
  }
  return kept.join("\n");
}
