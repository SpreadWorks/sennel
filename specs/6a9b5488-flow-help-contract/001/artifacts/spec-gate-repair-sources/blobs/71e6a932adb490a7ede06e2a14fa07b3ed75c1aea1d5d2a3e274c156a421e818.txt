/**
 * analysis-filter.js — docs.exclude filtering for analysis entries.
 *
 * Shared by enrich.js and data.js to apply docs.exclude patterns
 * consistently across the pipeline.
 */

import { globToRegex } from "../../lib/glob.js";
import { ANALYSIS_META_KEYS, iterateAnalysisCategories } from "./analysis-entry.js";

/**
 * Filter entries by docs.exclude glob patterns.
 * Entries matching any pattern are excluded.
 *
 * @param {Array} entries - array of { file, ... } objects
 * @param {string[]|undefined} excludePatterns - glob patterns
 * @returns {Array} filtered entries
 */
export function filterByDocsExclude(entries, excludePatterns) {
  if (!excludePatterns?.length) return entries;
  return filterEntriesByExcludeMatchers(entries, compileExcludeMatchers(excludePatterns));
}

function compileExcludeMatchers(excludePatterns) {
  return excludePatterns.map((p) => globToRegex(p));
}

function filterEntriesByExcludeMatchers(entries, matchers) {
  return entries.filter((e) => {
    if (!e.file) return true;
    return !matchers.some((re) => re.test(e.file));
  });
}

/**
 * Filter an entire analysis object by docs.exclude patterns.
 * Returns a new analysis with excluded entries removed from each category's entries array.
 * Does not mutate the original.
 *
 * @param {Object} analysis - full analysis object
 * @param {string[]|undefined} excludePatterns - glob patterns
 * @returns {Object} filtered analysis (shallow copy with filtered entries)
 */
export function filterAnalysisByDocsExclude(analysis, excludePatterns) {
  if (!excludePatterns?.length) return analysis;

  const excludeMatchers = compileExcludeMatchers(excludePatterns);
  const filtered = {};
  for (const key of ANALYSIS_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(analysis, key)) filtered[key] = analysis[key];
  }
  for (const [key, val] of iterateAnalysisCategories(analysis)) {
    filtered[key] = {
      ...val,
      entries: filterEntriesByExcludeMatchers(val.entries, excludeMatchers),
    };
  }
  return filtered;
}
