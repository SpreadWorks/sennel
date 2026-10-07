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

export function extractImports(content) {
  const imports = [];

  // ESM declarations. Keep every static occurrence, including duplicates.
  // Match comments as token separators without rewriting quoted source text.
  const comment = String.raw`(?:/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*)`;
  const trivia = String.raw`(?:\s|${comment})`;
  const gap = `${trivia}+`;
  const padding = `${trivia}*`;
  const identifier = String.raw`(?:[\p{ID_Continue}$]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\}))+`;
  const namespaceBinding = String.raw`\*${gap}as${gap}${identifier}`;
  const namedBindings = String.raw`\{(?:${comment}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^}])*\}`;
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

  // Add CommonJS, literal dynamic imports, and re-exports only once.
  const additionalPatterns = [
    /require\s*\(\s*(["'])([^"']+)\1\s*\)/gu,
    /(?<![\p{ID_Continue}$]|\.\s*)import\s*\(\s*(["'])([^"']+)\1(?=\s*(?:,|\)))/gu,
    /(?<![\p{ID_Continue}$])export\s+(?:type\s+)?(?:\*\s+(?:as\s+[\p{ID_Continue}$]+\s+)?|\{[^}]*\}\s+)from\s*(["'])([^"']+)\1/gu,
  ];
  for (const pattern of additionalPatterns) {
    while ((m = pattern.exec(content)) !== null) {
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
