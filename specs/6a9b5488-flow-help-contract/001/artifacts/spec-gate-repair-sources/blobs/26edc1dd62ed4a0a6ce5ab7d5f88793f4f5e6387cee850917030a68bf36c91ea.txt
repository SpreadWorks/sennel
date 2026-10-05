/**
 * Python language handler.
 * Provides minify and extractEssential.
 */

import { hasHashPrefix } from "./comments.js";

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
  return removeHashComments(code);
}

export function extractEssential(code) {
  const lines = code.split("\n");
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(from\s+\S+\s+)?import\s/.test(t)) { kept.push(t); continue; }
    if (/^(async\s+)?def\s/.test(t)) { kept.push(t); continue; }
    if (/^class\s/.test(t)) { kept.push(t); continue; }
    if (/^\s*return\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*raise\s/.test(line)) { kept.push(t); continue; }
    if (/^\s*yield\s/.test(line)) { kept.push(t); continue; }
  }
  return kept.join("\n");
}
