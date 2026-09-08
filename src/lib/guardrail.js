/**
 * src/lib/guardrail.js
 *
 * Shared guardrail logic: load, filter, match, and merge guardrails from JSON.
 */

import fs from "fs";
import path from "path";
import { loadConfig, managedDir } from "./config.js";
import { resolveChainSafe } from "./presets.js";
import { patternToRegex } from "../docs/lib/scanner.js";
import {
  VALID_GUARDRAIL_CATEGORIES,
  VALID_GUARDRAIL_PHASES,
} from "./constants.js";

const GUARDRAIL_FILENAME = "guardrail.json";

const DEFAULT_PHASE = Object.freeze(["spec"]);
export const ACKNOWLEDGED_EXCEPTION_MARKER = "acknowledged-exception";
const ACKNOWLEDGED_EXCEPTION_TARGET_IDS = Object.freeze([
  "backward-compatible-cli-interface",
  "exit-code-contract",
  "bounded-resource-usage",
  "no-synchronous-io-in-hot-paths",
]);
const ACKNOWLEDGED_EXCEPTION_CLAUSE =
  "acknowledged-exception handling: when a `## Matched Spec Acknowledgment Rationale` section is present for this guardrail, an intentional exception MAY pass only if the matched rationale comes from spec.json constraints, clarifications, or alternatives_considered, includes this guardrail_id at least once, and contains at least 20 non-whitespace characters after removing the guardrail_id.";

/**
 * Parse a lint string (e.g. "/pattern/flags") into a RegExp.
 *
 * @param {string} lintStr - Lint pattern string
 * @returns {RegExp}
 */
function parseLintString(lintStr) {
  const lastSlash = lintStr.lastIndexOf("/");
  const pattern = lintStr.slice(1, lastSlash);
  const flags = lintStr.slice(lastSlash + 1);
  return new RegExp(pattern, flags);
}

/**
 * Hydrate a raw guardrail entry from JSON:
 * - Convert lint string to RegExp
 * - Apply default phase
 *
 * @param {Object} entry - Raw guardrail from JSON
 * @returns {Object} Hydrated guardrail
 */
function hydrate(entry, sourcePath) {
  const meta = { ...entry.meta };
  if (!meta.phase) {
    meta.phase = [...DEFAULT_PHASE];
  }
  for (const p of meta.phase) {
    if (!VALID_GUARDRAIL_PHASES.includes(p)) {
      throw new Error(
        `guardrail ${entry.id || "(unknown)"} in ${sourcePath}: invalid phase "${p}" ` +
          `(valid: ${VALID_GUARDRAIL_PHASES.join(", ")})`,
      );
    }
  }
  if (!meta.category) {
    throw new Error(
      `guardrail ${entry.id || "(unknown)"} in ${sourcePath}: missing required field meta.category ` +
        `(valid: ${VALID_GUARDRAIL_CATEGORIES.join(", ")})`,
    );
  }
  if (!VALID_GUARDRAIL_CATEGORIES.includes(meta.category)) {
    throw new Error(
      `guardrail ${entry.id || "(unknown)"} in ${sourcePath}: invalid category "${meta.category}" ` +
        `(valid: ${VALID_GUARDRAIL_CATEGORIES.join(", ")})`,
    );
  }
  if (typeof meta.lint === "string") {
    meta.lint = parseLintString(meta.lint);
  }
  return { ...entry, meta };
}

/**
 * Load guardrails from a JSON file.
 *
 * @param {string} filePath - Path to guardrail.json
 * @returns {Object[]} Array of guardrail objects
 */
export function loadGuardrailFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(content);
  return (data.guardrails || []).map((e) => hydrate(e, filePath));
}

/**
 * Filter guardrails by phase.
 *
 * @param {Object[]} guardrails
 * @param {string} phase - "spec" | "impl" | "lint" | "draft"
 * @returns {Object[]}
 */
export function filterByPhase(guardrails, phase) {
  return guardrails.filter((g) => {
    const phases = g.meta?.phase || DEFAULT_PHASE;
    return phases.includes(phase);
  });
}

/**
 * Match a file path against scope glob patterns.
 *
 * @param {string} filePath - File path to match
 * @param {string[]|undefined} scope - Glob patterns (undefined = match all)
 * @returns {boolean}
 */
export function matchScope(filePath, scope) {
  if (!scope || scope.length === 0) return true;
  const fileName = path.basename(filePath);
  for (const pattern of scope) {
    const re = patternToRegex(pattern);
    if (re.test(fileName) || re.test(filePath)) return true;
  }
  return false;
}

/**
 * Resolve guardrail context (presetKey) from config.
 *
 * @param {string} root - project root
 * @returns {{ presetKey: string }}
 */
function resolveGuardrailContext(root) {
  let presetKey = "base";
  try {
    const config = loadConfig(root);
    if (config.type) presetKey = Array.isArray(config.type) ? config.type[0] : config.type;
  } catch (err) {
    if (err.code !== "ERR_MISSING_FILE") throw err;
    // No config file — use defaults
  }
  return { presetKey };
}

/**
 * Read a guardrail JSON file from the preset root directory.
 *
 * @param {string} dir - Preset directory
 * @returns {Object[]|null} Array of guardrails or null
 */
function readGuardrailFile(dir) {
  const filePath = path.join(dir, GUARDRAIL_FILENAME);
  if (fs.existsSync(filePath)) return loadGuardrailFile(filePath);
  return null;
}

/**
 * Merge guardrails by id: child overrides parent completely.
 *
 * @param {Object[]} base - Existing guardrails
 * @param {Object[]} additions - New guardrails to merge
 * @returns {Object[]} Merged guardrails
 */
function mergeById(base, additions) {
  const idIndex = new Map();
  const result = [...base];
  for (let i = 0; i < result.length; i++) {
    if (result[i].id) idIndex.set(result[i].id, i);
  }
  for (const g of additions) {
    if (g.id && idIndex.has(g.id)) {
      result[idIndex.get(g.id)] = g;
    } else {
      if (g.id) idIndex.set(g.id, result.length);
      result.push(g);
    }
  }
  return result;
}

/**
 * Load all guardrails from preset chain.
 *
 * @param {string} presetKey - Preset name
 * @param {string} projectRoot - Project/execution root used for enabled plugin discovery
 * @returns {Object[]}
 */
function loadPresetGuardrails(presetKey, projectRoot) {
  // Presets contributed by enabled plugins are project-scoped.  Guardrails are
  // loaded for a concrete execution root, so keep that root attached while
  // resolving the chain; otherwise only the package's builtin `base` preset is
  // visible and every plugin preset falls back with a misleading warning.
  const chain = resolveChainSafe(presetKey, projectRoot);
  let guardrails = [];
  for (const preset of chain) {
    const loaded = readGuardrailFile(preset.dir);
    if (!loaded) continue;
    guardrails = mergeById(guardrails, loaded);
  }
  return guardrails;
}

function preserveAcknowledgedExceptionClauses(guardrails) {
  return guardrails.map((guardrail) => {
    if (!ACKNOWLEDGED_EXCEPTION_TARGET_IDS.includes(guardrail.id)) return guardrail;
    if (guardrailAllowsAcknowledgedException(guardrail)) {
      return guardrail;
    }
    return {
      ...guardrail,
      body: `${String(guardrail.body || "").trim()}\n\n${ACKNOWLEDGED_EXCEPTION_CLAUSE}`,
    };
  });
}

/** Whether canonical guardrail policy permits a spec-acknowledged exception. */
export function guardrailAllowsAcknowledgedException(guardrail) {
  return String(guardrail?.body || "").toLowerCase().includes(ACKNOWLEDGED_EXCEPTION_MARKER);
}

/**
 * Load and merge all guardrails from preset chain + project guardrail.
 *
 * @param {string} root - project root
 * @returns {Object[]} merged guardrails
 */
export function loadMergedGuardrails(root) {
  const { presetKey } = resolveGuardrailContext(root);

  // 1. Collect guardrails from preset chain
  let guardrails = loadPresetGuardrails(presetKey, root);

  // 2. Merge guardrails from project (.sennel/guardrail.json)
  const projectPath = path.join(managedDir(root), GUARDRAIL_FILENAME);
  if (fs.existsSync(projectPath)) {
    const projectGuardrails = loadGuardrailFile(projectPath);
    guardrails = mergeById(guardrails, projectGuardrails);
  }

  return preserveAcknowledgedExceptionClauses(guardrails);
}
