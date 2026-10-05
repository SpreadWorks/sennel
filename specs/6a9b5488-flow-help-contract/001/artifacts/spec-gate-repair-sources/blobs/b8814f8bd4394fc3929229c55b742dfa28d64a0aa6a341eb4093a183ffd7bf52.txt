/**
 * AnalysisEntry — base class for analysis.json entries.
 *
 * Common fields (file, hash, lines, mtime) are guaranteed by this class.
 * Preset-specific subclasses define additional fields initialized to null.
 *
 * Subclasses may define a `static summary` object to declare aggregation rules:
 *   static summary = {
 *     totalActions: { field: "actions", aggregate: "count" },  // array → length sum
 *     totalValue:   { field: "value",  aggregate: "sum" },     // numeric sum
 *   };
 */

const COMMON_KEYS = new Set(["file", "hash", "lines", "mtime"]);

/** analysis.json top-level metadata keys (not category names). */
export const ANALYSIS_META_KEYS = new Set(["analyzedAt", "enrichedAt", "generatedAt"]);

export class AnalysisEntry {
  file = null;
  hash = null;
  lines = null;
  mtime = null;

  /**
   * Restore a plain object (from JSON) into a class instance.
   * Works on any subclass — `this` refers to the subclass constructor.
   *
   * @param {Object} obj - plain object from analysis.json
   * @returns {AnalysisEntry} instance of the called class
   */
  static restore(obj) {
    return Object.assign(new this(), obj);
  }
}

/**
 * Determine whether an entry is empty (all non-common fields are null).
 *
 * @param {AnalysisEntry} entry
 * @returns {boolean}
 */
export function isEmptyEntry(entry) {
  return !Object.keys(entry).some(
    (k) => !COMMON_KEYS.has(k) && entry[k] != null,
  );
}

/**
 * Build a summary object from entries using the EntryClass's static summary definition.
 *
 * Always includes `total` (entry count).
 * For each key in `EntryClass.summary`, applies the declared aggregation.
 *
 * @param {typeof AnalysisEntry} EntryClass - entry class with optional static summary
 * @param {AnalysisEntry[]} entries
 * @returns {Object} summary plain object
 */
export function buildSummary(EntryClass, entries) {
  const defs = EntryClass.summary ?? {};
  const result = { total: entries.length };

  for (const [key, def] of Object.entries(defs)) {
    if (def.aggregate === "count") {
      result[key] = entries.reduce(
        (sum, e) => sum + (e[def.field]?.length ?? 0),
        0,
      );
    } else if (def.aggregate === "sum") {
      result[key] = entries.reduce(
        (sum, e) => sum + (e[def.field] ?? 0),
        0,
      );
    }
  }

  return result;
}

/**
 * Iterate top-level analysis categories while ignoring metadata keys.
 *
 * @param {Object} analysis
 * @param {{strict?: boolean}} [opts]
 * @returns {IterableIterator<[string, Object]>}
 */
export function* iterateAnalysisCategories(analysis, opts = {}) {
  if (!analysis || typeof analysis !== "object") {
    if (opts.strict) throw new Error("analysis must be an object");
    return;
  }
  for (const [key, value] of Object.entries(analysis)) {
    if (ANALYSIS_META_KEYS.has(key)) continue;
    const valid = value && typeof value === "object" && Array.isArray(value.entries);
    if (!valid) {
      if (opts.strict) throw new Error(`invalid analysis category '${key}': entries[] is required`);
      continue;
    }
    yield [key, value];
  }
}

function normalizeAnalysisPath(filePath) {
  return filePath.split(/[\\/]+/).join("/");
}

/**
 * Extract project file paths recorded by analysis.json entries.
 *
 * @param {Object} analysis
 * @param {{strict?: boolean}} [opts]
 * @returns {Set<string>}
 */
export function projectFilePathsFromAnalysis(analysis, opts = {}) {
  const files = new Set();
  for (const [, category] of iterateAnalysisCategories(analysis, opts)) {
    for (const entry of category.entries) {
      if (typeof entry?.file === "string") files.add(normalizeAnalysisPath(entry.file));
    }
  }
  return files;
}
