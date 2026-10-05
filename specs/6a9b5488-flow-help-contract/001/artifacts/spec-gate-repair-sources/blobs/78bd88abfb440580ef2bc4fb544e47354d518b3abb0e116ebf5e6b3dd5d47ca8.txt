/**
 * PHP language handler.
 * Provides parse, minify, extractImports, extractExports, extractEssential.
 */

import path from "node:path";
import { hasSlashPrefix, hasHashPrefix } from "./comments.js";

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

function removeHashComments(code) {
  return code
    .split("\n")
    .map((line) => {
      if (line.match(/^#!/)) return line;
      if (hasHashPrefix(line)) return line;
      return line.replace(/(?:^|\s)#.*$/, "").trimEnd();
    })
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function minify(code) {
  let result = removeBlockComments(code);
  result = removeLineComments(result, LINE_COMMENT_PATTERN);
  result = removeHashComments(result);
  return result;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parse(content, filePath) {
  const classMatch = content.match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);
  const className = classMatch ? classMatch[1] : path.basename(filePath, ".php");
  const parentClass = classMatch ? classMatch[2] || "" : "";

  const methodRegex = /public\s+function\s+(\w+)\s*\(/g;
  const methods = [];
  let m;
  while ((m = methodRegex.exec(content)) !== null) {
    methods.push(m[1]);
  }

  const properties = {};
  const propRegex =
    /(?:public|protected|private|var)\s+\$(\w+)\s*=\s*(?:(?:'([^']*)'|"([^"]*)")|array\(([^)]*)\)|\[([^\]]*)\])/g;
  let pm;
  while ((pm = propRegex.exec(content)) !== null) {
    const propName = pm[1];
    const strValue = pm[2] || pm[3];
    const arrayContent = pm[4] || pm[5];
    if (strValue !== undefined) {
      properties[propName] = strValue;
    } else if (arrayContent !== undefined) {
      const items = [];
      const itemRegex = /['"]([^'"]+)['"]/g;
      let im;
      while ((im = itemRegex.exec(arrayContent)) !== null) {
        items.push(im[1]);
      }
      properties[propName] = items;
    }
  }

  const relations = {};
  for (const relType of ["belongsTo", "hasMany", "hasOne", "hasAndBelongsToMany"]) {
    const relRegex = new RegExp(
      `\\$${relType}\\s*=\\s*(?:array\\(([\\s\\S]*?)\\)|\\[([\\s\\S]*?)\\])`,
    );
    const relMatch = content.match(relRegex);
    if (relMatch) {
      const body = relMatch[1] || relMatch[2] || "";
      const keys = [];
      const keyRegex = /['"](\w+)['"]\s*(?:=>|,|\)|\])/g;
      let km;
      while ((km = keyRegex.exec(body)) !== null) {
        keys.push(km[1]);
      }
      if (keys.length > 0) {
        relations[relType] = keys;
      }
    }
  }

  return { className, parentClass, methods, properties, relations, content };
}

// ---------------------------------------------------------------------------
// Extract imports
// ---------------------------------------------------------------------------

export function extractImports(content) {
  const imports = [];

  // use Namespace\ClassName;
  const useRegex = /^use\s+([^;]+);/gm;
  let m;
  while ((m = useRegex.exec(content)) !== null) {
    imports.push(m[1].trim());
  }

  // require_once / include_once / require / include
  const requireRegex = /(?:require_once|include_once|require|include)\s*\(?['"]([^'"]+)['"]\)?/g;
  while ((m = requireRegex.exec(content)) !== null) {
    imports.push(m[1]);
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Extract exports
// ---------------------------------------------------------------------------

export function extractExports(content) {
  const exports = [];

  // Class name
  const classMatch = content.match(/class\s+(\w+)/);
  if (classMatch) {
    exports.push(classMatch[1]);
  }

  // Public functions
  const methodRegex = /public\s+(?:static\s+)?function\s+(\w+)/g;
  let m;
  while ((m = methodRegex.exec(content)) !== null) {
    exports.push(m[1]);
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
    if (/^(require|require_once|include|include_once)\s/.test(t)) { kept.push(t); continue; }
    if (/^use\s/.test(t)) { kept.push(t); continue; }
    if (/^namespace\s/.test(t)) { kept.push(t); continue; }
    if (/^(public|protected|private|static|abstract)\s/.test(t) && /function\s/.test(t)) { kept.push(t); continue; }
    if (/^\s*function\s/.test(line)) { kept.push(t); continue; }
    if (/^(abstract\s+)?class\s/.test(t)) { kept.push(t); continue; }
    if (/^interface\s/.test(t)) { kept.push(t); continue; }
    if (/^trait\s/.test(t)) { kept.push(t); continue; }
    if (/^\s*return\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*throw\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*new\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*\$this->/.test(line) && /=\s*new\s/.test(line)) { kept.push(t); continue; }
  }
  return kept.join("\n");
}
