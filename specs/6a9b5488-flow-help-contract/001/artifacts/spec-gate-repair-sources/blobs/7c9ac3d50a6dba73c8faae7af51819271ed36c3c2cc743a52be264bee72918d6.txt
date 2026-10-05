/**
 * Source code minifier.
 * Uses lang-factory to dispatch to language-specific handlers.
 * Generic utilities (blank line removal, trailing whitespace) are applied first.
 *
 * mode: "essential" dispatches to handler.extractEssential if available,
 * falling back to regular minify if the handler does not implement it.
 */

import { getLangHandler } from "./lang-factory.js";

function removeBlankLines(code) {
  return code
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function removeTrailingWhitespace(code) {
  return code
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

export function minify(code, filePath, opts) {
  if (!code) return code;

  const handler = getLangHandler(filePath);

  if (opts?.mode === "essential") {
    if (handler?.extractEssential) {
      return handler.extractEssential(code);
    }
    // Fall back to regular minify if handler has no extractEssential
  }

  const preserveBlanks = handler?.preserveBlankLines === true;

  let result = preserveBlanks ? code : removeBlankLines(code);
  result = removeTrailingWhitespace(result);

  if (handler?.minify) {
    result = handler.minify(result);
  }

  if (!preserveBlanks) {
    // Final cleanup: remove blank lines introduced by comment removal
    result = removeBlankLines(result);
  }

  return result;
}
