/**
 * src/lib/formatter.js
 *
 * Shared text formatting helpers for CLI output.
 * Used by flow report, check commands, and other plain-text reporters.
 */

export const DIVIDER = "────────────────────────────────────────────────";

/**
 * Append a section header (blank line + indented title + indented divider) to lines.
 *
 * @param {string[]} lines - mutable lines array to push onto
 * @param {string} title - section title
 * @param {string} [divider] - override divider string (defaults to DIVIDER)
 */
export function pushSection(lines, title, divider = DIVIDER) {
  lines.push("");
  lines.push(`  ${title}`);
  lines.push(`  ${divider}`);
}

/**
 * Format a duration given in milliseconds as `x.ys` (seconds with one decimal).
 * Returns `"N/A"` when the value is not a finite number.
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatDurationSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "N/A";
  return `${(n / 1000).toFixed(1)}s`;
}
