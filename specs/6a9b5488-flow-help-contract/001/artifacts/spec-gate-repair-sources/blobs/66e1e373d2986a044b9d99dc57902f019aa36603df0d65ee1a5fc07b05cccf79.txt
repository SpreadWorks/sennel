import { Table } from "./renderable.js";

/**
 * DataSource — base class for OOP-based {{data}} directive resolvers.
 *
 * Each preset category (e.g. controllers, models, tables) extends this class
 * and implements one or more named resolver methods. Resolvers should return
 * a Renderable (see ./renderable.js) or null; the expansion layer calls
 * `.toMarkdown()` polymorphically.
 *
 * Directive syntax:
 *   {{data: controllers.list("Name|File|Description")}}
 *   Calls controllersSource.list(analysis, ["Name", "File", "Description"])
 */
export class DataSource {
  /**
   * Inject project-specific helpers (called by resolver-factory).
   * @param {{ desc: function, loadOverrides: function }} ctx
   */
  init(ctx) {
    this._desc = ctx.desc;
    this._loadOverrides = ctx.loadOverrides;
  }

  /**
   * Look up a description string from overrides.json.
   *
   * For items that have a summary field (from enriched analysis),
   * use mergeDesc() to pre-merge overrides into items instead.
   *
   * @param {string} section - overrides.json section key
   * @param {string} key - item identifier
   * @returns {string}
   */
  desc(section, key) {
    if (this._desc) {
      return this._desc(section, key);
    }
    return "—";
  }

  /**
   * Merge override descriptions into items' summary fields.
   * Returns a new array — originals are not mutated.
   *
   * @param {Array} items - analysis items (objects with a summary field)
   * @param {string} section - overrides.json section key
   * @param {string} [keyField='className'] - field to use as lookup key
   * @returns {Array}
   */
  mergeDesc(items, section, keyField = "className") {
    const overrides = this._loadOverrides?.() ?? {};
    const sectionData = overrides[section];
    if (!sectionData) return items;
    return items.map((item) => {
      const key = item[keyField];
      const override = key ? sectionData[key] : undefined;
      return override !== undefined ? { ...item, summary: override } : item;
    });
  }

  /**
   * Load the full overrides.json object.
   * @returns {Object}
   */
  overrides() {
    return this._loadOverrides ? this._loadOverrides() : {};
  }

  /**
   * Convert items to row arrays using a mapper function.
   * @param {Array} items - source items
   * @param {Function} mapper - (item) => [col1, col2, ...]
   * @returns {Array<Array>} rows
   */
  toRows(items, mapper) {
    return items.map(mapper);
  }

  /**
   * Construct a Table renderable from rows and labels.
   *
   * Thin delegation to `new Table(labels, rows)`; preserved as a helper so
   * existing callers keep the `(rows, labels)` argument order.
   *
   * @param {Array<Array>} rows - [[col1, col2, ...], ...]
   * @param {string[]} labels - column headers
   * @returns {Table} renderable table
   */
  toMarkdownTable(rows, labels) {
    return new Table(labels, rows);
  }
}
