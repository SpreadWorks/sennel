/**
 * Shared helpers for comment handling in language-specific minify.
 *
 * Single-line comments that begin with one of PRESERVED_PREFIXES (e.g. `// WHY: ...`,
 * `# HACK: ...`) are kept through minify so that downstream text-generation AI
 * can see the author's intent. All other comments are stripped per existing
 * per-language rules. End-of-line comments are never preserved, even with a
 * prefix — the prefix must start a standalone comment line (optionally
 * preceded by whitespace).
 */

export const PRESERVED_PREFIXES = ["WHY", "HACK", "SECURITY"];

const PREFIX_ALT = PRESERVED_PREFIXES.join("|");

// WHY: 標準化された接頭辞コメントのみ保持することで、ドキュメント生成 AI が明示された意図だけを読み取れるようにする。
const SLASH_PREFIX_RE = new RegExp(`^\\s*\\/\\/\\s*(?:${PREFIX_ALT}):`);
const HASH_PREFIX_RE = new RegExp(`^\\s*#\\s*(?:${PREFIX_ALT}):`);

export function hasSlashPrefix(line) {
  return SLASH_PREFIX_RE.test(line);
}

export function hasHashPrefix(line) {
  return HASH_PREFIX_RE.test(line);
}
