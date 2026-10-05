/**
 * Markdown language handler (spec 225 R4).
 * Provides minify (shape-preserving) and truncate helpers for Issue body text.
 *
 * preserveBlankLines = true tells `src/docs/lib/minify.js` to skip its generic
 * blank-line removal so paragraph separators are retained for markdown.
 */

export const preserveBlankLines = true;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const HR_RE = /^[\t ]*(?:-{3,}|\*{3,}|_{3,})[\t ]*$/gm;
const TRAILING_WS_RE = /[\t ]+$/gm;

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}

export function minify(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  out = out.replace(HTML_COMMENT_RE, "");
  out = out.replace(IMAGE_RE, (_m, alt) => alt);
  out = out.replace(HR_RE, "");
  out = out.replace(TRAILING_WS_RE, "");
  out = collapseBlankLines(out);
  return out;
}

const DEFAULT_MAX_CHARS = 20_000;
const TRUNCATE_SUFFIX = "\n... (truncated)";

export function truncate(text, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof text !== "string") return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATE_SUFFIX;
}
