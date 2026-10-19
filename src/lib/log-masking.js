/**
 * sennel/lib/log-masking.js
 *
 * Sensitive information masking for Logger output (spec 192).
 *
 * Recursively walks a value tree and replaces matches of known sensitive
 * patterns with `***`. Used by Logger before writing JSONL entries and
 * prompt JSON files so no caller-side change is required.
 *
 * Design:
 *   - Dictionary-based pattern list (no generic high-entropy detector).
 *   - Non-string values (numbers, booleans, null) pass through untouched.
 *   - Traversal depth limit 10; beyond that the subtree is returned as-is.
 *   - Cycle detection via ancestor WeakSet (shared references on non-cycle
 *     DAG paths are re-walked, which is intended — only true cycles are
 *     pruned).
 *   - Patterns are anchored / bounded so regex cost is linear in input length.
 */

import { PRODUCT } from "./product.js";
import { isNativePathSpellingWithin } from "./portable-path.js";

const MAX_DEPTH = 10;
const MASK = "***";

/**
 * Pattern list. Each entry is a RegExp with the global flag. Replacement
 * semantics: full match → MASK. Patterns that should preserve surrounding
 * context (e.g. "Bearer <token>" → "Bearer ***") use capture groups and a
 * replacer function.
 */
const PATTERNS = [
  // GitHub Personal Access Tokens — ghp_, gho_, ghs_, ghr_ (classic / fine-grained short)
  { re: /\bgh[pors]_[A-Za-z0-9]{20,}\b/g, replace: () => MASK },
  // GitHub fine-grained PAT — github_pat_<22-char>_<59-char>
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => MASK },
  // HTTPS URL with embedded credentials
  { re: /(https?:\/\/)[^\s:@/]+:[^\s@/]+@/g, replace: (_, proto) => `${proto}${MASK}@` },
  // Bearer token
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, replace: (_, prefix) => `${prefix}${MASK}` },
  // AWS access key ID
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => MASK },
];

/**
 * Collect trusted path roots. Absolute paths starting with any trusted
 * root are left untouched; all other absolute paths are masked.
 *
 * Inputs:
 *   - `opts.trustedRoots` — explicit array from the caller (Logger passes
 *     its own logDir and cwd).
 *   - `opts.workRoot` — legacy alias for a single root.
 *   - `SENNEL_WORK_ROOT` environment variable.
 */
function resolveTrustedRoots(opts) {
  const roots = [];
  if (Array.isArray(opts.trustedRoots)) {
    for (const r of opts.trustedRoots) if (r) roots.push(r);
  }
  if (opts.workRoot) roots.push(opts.workRoot);
  if (process.env[PRODUCT.env("WORK_ROOT")]) roots.push(process.env[PRODUCT.env("WORK_ROOT")]);
  if (process.env[PRODUCT.env("SOURCE_ROOT")]) roots.push(process.env[PRODUCT.env("SOURCE_ROOT")]);
  roots.push(process.cwd());
  return roots.filter((root) => typeof root === "string" && isNativePathSpellingWithin(root, root));
}

/**
 * Match absolute paths (Unix `/...` or Windows `C:\...`). Uses a
 * lookbehind for start-of-string or non-path characters to avoid
 * matching slashes in the middle of relative paths or URLs.
 * Each match is evaluated against the list of trusted roots.
 */
const ABSOLUTE_START = "(?:[A-Za-z]:[\\\\/]|[\\\\/]{2}[?.][\\\\/]|[\\\\/]{2}|/)";
const WHOLE_PATH_START = new RegExp(`^${ABSOLUTE_START}`);
// A one-letter scheme is a native drive spelling here. URL contents otherwise
// remain URLs; their credentials have already passed through PATTERNS.
const URL_SOURCE = "(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]+://[^\\s\"'`<>]+";
const URL_START = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;
const PATH_BOUNDARY = "(?<![\\p{L}\\p{N}_./\\\\~%-])";
const REFERENCE_STARTS = new RegExp(`${URL_SOURCE}|${PATH_BOUNDARY}${ABSOLUTE_START}`, "giu");

function nativeReferenceStarts(text, roots) {
  let rootEnd = -1;
  return Array.from(text.matchAll(REFERENCE_STARTS)).filter((match) => {
    if (URL_START.test(match[0]) || match.index <= rootEnd) return false;
    // Punctuation inside an explicitly known root, including the root's own
    // separator, belongs to that path rather than introducing another one.
    for (const root of roots) {
      const prefix = text.slice(match.index, match.index + root.length);
      if (isNativePathSpellingWithin(root, prefix) && isNativePathSpellingWithin(prefix, root)) {
        rootEnd = Math.max(rootEnd, match.index + root.length);
      }
    }
    return true;
  }).map((match) => match.index);
}

function trustedPath(candidate, roots) {
  return roots.some((root) => isNativePathSpellingWithin(root, candidate));
}

function maskPathSpans(candidate, roots) {
  const starts = nativeReferenceStarts(candidate, roots);
  // Compound text is ambiguous with a filename containing spaces.
  // Validate each native span independently; an untrusted span also masks its
  // ambiguous intervening text, retaining closing punctuation and whitespace.
  return starts.map((start, index) => {
    const span = candidate.slice(start, starts[index + 1] ?? candidate.length);
    const suffix = /[^\p{L}\p{N}_./\\~%-]*$/u.exec(span)[0];
    const value = span.slice(0, span.length - suffix.length);
    return trustedPath(value, roots) ? span : `${MASK}${suffix}`;
  }).join("");
}

function pathExpression(trustedRoots) {
  // Include spaces in known roots, while retaining token boundaries in free
  // text. Compare the resulting spelling below; matching alone grants no trust.
  const roots = trustedRoots.map((root) => {
    const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(root);
    const escaped = root.replace(/[\\/]+$/, "").split(windows ? /[\\/]/ : "/")
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(windows ? "[\\\\/]" : "/");
    if (escaped === "") return ABSOLUTE_START;
    return /^[A-Za-z]:$/.test(escaped) ? `${escaped}(?=[\\\\/])` : escaped;
  });
  const start = [...roots, ABSOLUTE_START].join("|");
  return new RegExp(URL_SOURCE + "|" + PATH_BOUNDARY + "(?:([\"'`])(" + ABSOLUTE_START
    + ")[^\"'`\\r\\n]*\\1|(?:" + start + ")[^\\s\"'`<>|?*(){}\\[\\],;:]*)", "giu");
}

/**
 * Apply masking to a single string. Runs all PATTERNS, then the absolute-
 * path rule. Returns the masked string.
 */
function maskString(s, trustedRoots) {
  if (!s || typeof s !== "string") return s;
  let out = s;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  // A path-valued field may contain spaces without surrounding quotes.
  // Punctuation can introduce another absolute reference as well as spaces.
  // A whole-field prefix must never grant trust to those later references.
  if (WHOLE_PATH_START.test(out) && !/[\r\n]/.test(out) && nativeReferenceStarts(out, trustedRoots).length === 1) {
    return trustedPath(out, trustedRoots) ? out : MASK;
  }
  out = out.replace(pathExpression(trustedRoots), (match, quote) => {
    if (URL_START.test(match)) return match;
    const candidate = quote ? match.slice(1, -1) : match;
    if (nativeReferenceStarts(candidate, trustedRoots).length > 1) {
      const masked = maskPathSpans(candidate, trustedRoots);
      return quote ? `${quote}${masked}${quote}` : masked;
    }
    if (trustedPath(candidate, trustedRoots)) return match;
    return quote ? `${quote}${MASK}${quote}` : MASK;
  });
  return out;
}

/**
 * Recursively walk a value and return a masked clone. Original input is
 * not mutated.
 *
 * @param {*} value
 * @param {{workRoot?: string|null}} [opts]
 * @returns {*}
 */
export function maskSensitive(value, opts = {}) {
  const trustedRoots = resolveTrustedRoots(opts);
  const ancestors = new WeakSet();

  function walk(v, depth) {
    if (depth > MAX_DEPTH) return v;
    if (v == null) return v;
    const t = typeof v;
    if (t === "string") return maskString(v, trustedRoots);
    if (t === "number" || t === "boolean" || t === "bigint") return v;
    if (t !== "object") return v;

    if (ancestors.has(v)) return "[Circular]";
    ancestors.add(v);

    let result;
    if (Array.isArray(v)) {
      result = v.map((item) => walk(item, depth + 1));
    } else {
      result = {};
      for (const key of Object.keys(v)) {
        result[key] = walk(v[key], depth + 1);
      }
    }

    ancestors.delete(v);
    return result;
  }

  return walk(value, 0);
}
