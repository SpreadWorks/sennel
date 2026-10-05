/**
 * src/flow/lib/issue-body-cache.js
 *
 * Shared helpers for the Issue-body cache lifecycle (spec 225).
 * Centralizes Issue body normalization for every path that consumes the
 * immutable Issue snapshot.
 */

import { fetchIssue } from "./fetch-issue.js";
import { minify as minifyMd, truncate as truncateMd } from "../../docs/lib/lang/md.js";

/**
 * Normalize an Issue body (minify + truncate),
 * returning null when it cannot be a non-empty immutable snapshot.
 */
export function normalizeIssueBody(body) {
  if (typeof body !== "string") return null;
  const normalized = truncateMd(minifyMd(body));
  return normalized.trim().length > 0 ? normalized : null;
}

/**
 * Fetch the Issue body via gh (lenient), normalize it,
 * and return the resulting string. Returns null when:
 *   - gh fails (fetch-issue already emits a warning to stderr)
 *   - body is missing or empty after normalization
 */
export function fetchNormalizedIssueBody(number, root) {
  const fetched = fetchIssue(number, root, { strict: false });
  return fetched ? normalizeIssueBody(fetched.body) : null;
}
