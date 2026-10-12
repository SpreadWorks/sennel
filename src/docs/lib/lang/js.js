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

function findImportMembers(content, comment, padding, quotedString) {
  const tokens = new RegExp(
    String.raw`${comment}|${quotedString}|(\.${padding})(?=import\b)|[\p{ID_Continue}$]+|=>|\+\+|--|[^\s]`,
    "gu",
  );
  const regexLiteral = /\/(?:\\[^]|\[(?:\\[^]|[^\]\\\r\n\u2028\u2029])*\]|[^/\\[\r\n\u2028\u2029])+\/[\p{ID_Continue}$]*/uy;
  const templateText = /(?:\\[^]|[^\\`$]|\$(?!\{))*(?:`|\$\{|$)/y;
  const expressionKeywords = new Set(["return", "throw", "case", "yield", "await", "void", "typeof", "delete", "in", "instanceof"]);
  const controlKeywords = new Set(["if", "while", "for", "with", "switch", "catch"]);
  const members = new Set();
  const interpolations = [];
  const parentheses = [];
  const blocks = [];
  let inTemplate = false;
  let expressionStart = true;
  let previous = "";
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
        interpolations.push(0);
        expressionStart = true;
      } else {
        expressionStart = false;
      }
      previous = "literal";
      controlStart = false;
      continue;
    }
    token = tokens.exec(content);
    if (!token) break;
    const value = token[0];
    if (value.startsWith("//") || value.startsWith("/*")) continue;
    if (token[1]) {
      members.add(tokens.lastIndex);
      expressionStart = false;
      previous = ".";
      controlStart = false;
      continue;
    }
    if (value === "/" && expressionStart) {
      regexLiteral.lastIndex = token.index;
      if (regexLiteral.exec(content)) {
        tokens.lastIndex = regexLiteral.lastIndex;
        expressionStart = false;
        previous = "literal";
        controlStart = false;
        continue;
      }
    }
    if (value === "`") {
      inTemplate = true;
    } else if (value === "}" && interpolations.length && interpolations.at(-1) === 0) {
      interpolations.pop();
      inTemplate = true;
    } else {
      if (interpolations.length && value === "{") interpolations[interpolations.length - 1]++;
      if (interpolations.length && value === "}") interpolations[interpolations.length - 1]--;
      if (value === "(") {
        parentheses.push(controlStart);
        expressionStart = true;
      } else if (value === ")") {
        expressionStart = parentheses.pop() === true;
      } else if (value === "{") {
        blocks.push(!expressionStart || ["", ")", "=>", ";", "{", "}", "else", "do", "try", "finally"].includes(previous));
        expressionStart = true;
      } else if (value === "}") {
        expressionStart = blocks.pop() === true;
      } else {
        expressionStart = expressionKeywords.has(value) || !/^(?:[\p{ID_Continue}$]|["']|[.\]]|\+\+|--)/u.test(value);
      }
    }
    controlStart = controlKeywords.has(value) && previous !== ".";
    previous = value;
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
