/**
 * Language handler factory.
 * Returns a handler object based on file extension.
 *
 * Each handler may provide: parse, minify, extractImports, extractExports.
 * Not all methods are required — e.g., Python provides only minify.
 */

import path from "node:path";
import * as js from "./lang/js.js";
import * as php from "./lang/php.js";
import * as py from "./lang/py.js";
import * as yaml from "./lang/yaml.js";
import * as md from "./lang/md.js";

const EXT_MAP = {
  ".js": js,
  ".mjs": js,
  ".cjs": js,
  ".jsx": js,
  ".tsx": js,
  ".ts": js,
  ".php": php,
  ".py": py,
  ".yaml": yaml,
  ".yml": yaml,
  ".md": md,
};

/**
 * Get the language handler for a file path.
 *
 * @param {string} filePath - file path (only extension matters)
 * @returns {Object|null} handler with available methods, or null
 */
export function getLangHandler(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] || null;
}
