/**
 * src/lib/include.js
 *
 * Resolve `<!-- include("path") -->` directives in template content.
 * Replaces each directive line with the referenced file's content.
 * Supports recursive resolution (includes within includes).
 */

import fs from "fs";
import path from "path";
import { resolvePresetChains } from "./presets.js";
import { PRODUCT } from "./product.js";

const INCLUDE_RE = /^<!--\s*include\("([^"]+)"\)\s*-->$/;

const MAX_INCLUDE_DEPTH = 8;
const MAX_INCLUDE_COUNT = 32;

/**
 * @returns {string|null} absolute path when prefix matches, otherwise null
 */
function resolveAliasedIncludePath(includePath, prefix, rootDir, optionName) {
  if (!includePath.startsWith(prefix)) return null;
  if (!rootDir) throw new Error(`Cannot resolve "${includePath}": ${optionName} not provided`);
  return path.join(rootDir, includePath.slice(prefix.length));
}

function resolveRegistryPresetIncludePath(includePath, opts) {
  if (!includePath.startsWith("@presets/")) return null;
  if (!opts.projectRoot || !opts.presetTypes) {
    throw new Error(`Cannot resolve "${includePath}": projectRoot and presetTypes required`);
  }
  const rel = includePath.slice("@presets/".length);
  const [presetKey, ...parts] = rel.split("/");
  if (!presetKey || parts.length === 0) throw new Error(`Invalid preset include: "${includePath}"`);
  const childPath = parts.join("/");

  let registered = false;
  const registryCandidates = [];
  for (const chain of resolvePresetChains(opts.presetTypes, opts.projectRoot, { maxDepth: 16 })) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const preset = chain[i];
      if (preset.key !== presetKey) continue;
      registered = true;
      registryCandidates.push(path.join(preset.dir, childPath));
    }
  }
  if (!registered) throw new Error(`Preset include not registered: "${presetKey}"`);

  const projectLocal = path.join(opts.projectRoot, PRODUCT.managedPath("templates", "presets", presetKey, childPath));
  if (fs.existsSync(projectLocal)) return projectLocal;
  for (const candidate of registryCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(opts.projectRoot, PRODUCT.managedPath("templates", "presets", presetKey, childPath));
}

/**
 * Resolve a single include path to an absolute file path.
 *
 * Resolution rules:
 * - `name`              → baseDir (same folder)
 * - `/path/to/name`     → pkgDir (src/) root
 * - `@skills/path`      → skillsDir
 * - `@presets/<p>/path` → enabled registry preset chain via projectRoot/presetTypes
 *
 * @param {string} includePath - path from the include directive
 * @param {Object} opts
 * @param {string} opts.baseDir - directory of the file containing the include
 * @param {string} [opts.pkgDir] - PKG_DIR (src/) for absolute paths
 * @param {string} [opts.skillsDir] - skills root for @skills/
 * @param {string} [opts.presetsDir] - legacy option, not used for @presets/
 * @returns {string} absolute file path
 */
function resolveIncludePath(includePath, opts) {
  if (includePath.includes("../")) {
    throw new Error(`Forbidden path: "${includePath}" contains "../"`);
  }
  if (includePath.includes("./")) {
    throw new Error(`Forbidden path: "${includePath}" contains "./"`);
  }

  const skillsPath = resolveAliasedIncludePath(includePath, "@skills/", opts.skillsDir, "skillsDir");
  if (skillsPath !== null) return skillsPath;

  const registryPresetPath = resolveRegistryPresetIncludePath(includePath, opts);
  if (registryPresetPath !== null) return registryPresetPath;

  if (includePath.startsWith("/")) {
    const rel = includePath.slice(1);
    return path.join(opts.pkgDir || opts.baseDir, rel);
  }

  return path.join(opts.baseDir, includePath);
}

/**
 * Resolve all include directives in content.
 *
 * @param {string} content - template content with include directives
 * @param {Object} opts
 * @param {string} opts.baseDir - directory of the source file
 * @param {string} [opts.pkgDir] - PKG_DIR for / paths
 * @param {string} [opts.skillsDir] - skills root for @skills/
 * @param {string} [opts.presetsDir] - legacy option, not used for @presets/
 * @param {string} [opts.sourceFile] - source file name (for error messages)
 * @param {Set<string>} [opts._seen] - internal: tracks visited files for circular detection
 * @returns {string} content with all includes resolved
 */
export function resolveIncludes(content, opts) {
  const seen = opts._seen || new Set();
  const counter = opts._counter || { count: 0 };
  const depth = opts._depth || 0;

  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion depth exceeded ${MAX_INCLUDE_DEPTH} levels`);
  }

  const lines = content.split("\n");
  const result = [];

  for (const line of lines) {
    const match = line.trim().match(INCLUDE_RE);
    if (!match) {
      result.push(line);
      continue;
    }

    counter.count += 1;
    if (counter.count > MAX_INCLUDE_COUNT) {
      throw new Error(`Total include count exceeded ${MAX_INCLUDE_COUNT}`);
    }

    const includePath = match[1];
    const resolved = resolveIncludePath(includePath, opts);

    if (!fs.existsSync(resolved)) {
      const src = opts.sourceFile || opts.baseDir;
      throw new Error(`Include not found: "${includePath}" (resolved to "${resolved}") in ${src}`);
    }

    if (seen.has(resolved)) {
      throw new Error(`Circular include detected: "${includePath}" (${resolved})`);
    }

    seen.add(resolved);
    const included = fs.readFileSync(resolved, "utf8");

    let expanded;
    try {
      // Recursively resolve includes in the included content
      expanded = resolveIncludes(included, {
        ...opts,
        baseDir: path.dirname(resolved),
        sourceFile: resolved,
        _seen: seen,
        _counter: counter,
        _depth: depth + 1,
      });
    } finally {
      // Remove on exit so `_seen` tracks only the current ancestry path.
      // This detects true circular includes (A → B → A) but permits
      // diamond-shaped includes (A includes B and C, both include X).
      seen.delete(resolved);
    }

    result.push(expanded.replace(/\n$/, ""));
  }

  return result.join("\n");
}
