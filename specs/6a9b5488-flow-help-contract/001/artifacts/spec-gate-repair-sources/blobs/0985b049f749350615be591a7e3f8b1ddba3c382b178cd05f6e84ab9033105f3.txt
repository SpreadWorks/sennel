/**
 * Scannable — mixin that adds scan capabilities to DataSource.
 *
 * Usage: class FooSource extends Scannable(DataSource) { ... }
 *
 * Subclasses implement:
 *   match(relPath)  → boolean    — whether this DataSource handles the file
 *   parse(absPath)  → AnalysisEntry subclass instance — parse one file
 *
 * The common scan pipeline (scan.js) handles:
 *   - Iterating over files and calling match/parse
 *   - Setting common fields (file, hash, lines, mtime)
 *   - Empty entry detection
 *   - Hash-based skip for unchanged files
 *   - Summary generation via AnalysisEntry.summary definitions
 *
 * @param {Function} Base - class to extend
 * @returns {Function} class with match() and parse() methods
 *
 * @example
 *   import { DataSource } from "./data-source.js";
 *   import { Scannable } from "./scan-source.js";
 *   import { AnalysisEntry } from "./analysis-entry.js";
 *
 *   class ControllerEntry extends AnalysisEntry {
 *     className = null;
 *     actions = null;
 *     static summary = {
 *       totalActions: { field: "actions", aggregate: "count" },
 *     };
 *   }
 *
 *   export default class ControllersSource extends Scannable(DataSource) {
 *     static Entry = ControllerEntry;
 *
 *     match(relPath) { return /Controller\.php$/.test(relPath); }
 *     parse(absPath) {
 *       const entry = new ControllerEntry();
 *       // ... fill fields from file ...
 *       return entry;
 *     }
 *     list(analysis, labels) { // resolve method }
 *   }
 */
export const Scannable = (Base) =>
  class extends Base {
    /**
     * Whether this DataSource handles a file.
     * Override in subclasses.
     *
     * @param {string} relPath - Path relative to the scan root (SENNEL_SOURCE_ROOT).
     *   Separator is always `/` (POSIX style); never converted to `\` on Windows.
     *   No leading `./` (e.g. `src/controllers/UserController.php`).
     * @returns {boolean} true if this DataSource should process the file.
     */
    match(relPath) {
      return false;
    }

    /**
     * Parse one file and return an entry instance.
     * Override in subclasses.
     *
     * @param {string} absPath - absolute file path
     * @returns {AnalysisEntry} entry instance (never null — return instance with null fields for empty)
     */
    parse(absPath) {
      return new (this.constructor.Entry)();
    }

    /**
     * Marker method for Scannable detection.
     * The scan pipeline calls match() + parse(); this method exists so that
     * external code can identify scannable DataSources via `typeof ds.scan === "function"`.
     */
    scan() {}
  };
