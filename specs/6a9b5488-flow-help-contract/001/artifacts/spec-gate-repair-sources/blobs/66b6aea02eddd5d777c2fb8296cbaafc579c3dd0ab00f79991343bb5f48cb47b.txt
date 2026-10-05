/**
 * sennel/lib/presets.js
 *
 * Auto-discovers builtin presets and enabled plugin preset contributions.
 * All consumers derive their preset data from this single source.
 *
 * Preset hierarchy uses `parent` field for single-inheritance chains.
 * Multiple presets can be combined via type arrays in config.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { createLogger } from "./progress.js";
import { loadPluginRegistry, PluginManifest } from "./plugin-registry.js";
import { PRODUCT } from "./product.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger("presets");
export const CORE_PRESETS_DIR = path.resolve(__dirname, "..", "presets");
export const PRESETS_DIR = CORE_PRESETS_DIR;

/**
 * Discover all presets by scanning src/presets/{key}/preset.json.
 * Each preset gets: { key, dir, parent, label, aliases, scan, chapters }.
 */
function discoverPresetsInDir(presetsDir) {
  if (!fs.existsSync(presetsDir)) return [];

  return fs.readdirSync(presetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const manifestPath = path.join(presetsDir, d.name, "preset.json");
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      return {
        key: d.name,
        dir: path.join(presetsDir, d.name),
        parent: manifest.parent || null,
        label: manifest.label,
        aliases: manifest.aliases || [],
        scan: manifest.scan || {},
        chapters: manifest.chapters || [],
      };
    })
    .filter(Boolean);
}

export const CORE_PRESETS = discoverPresetsInDir(CORE_PRESETS_DIR);
export const PRESETS = CORE_PRESETS;

export class PresetCatalog {
  constructor(entries) {
    if (!Array.isArray(entries)) throw new Error("preset catalog entries must be an array");
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
  }

  list() {
    return [...this.entries.values()];
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    return this.entries.get(key) || null;
  }

  resolveChain(leafKey, { maxDepth = MAX_CHAIN_DEPTH } = {}) {
    const preset = this.get(leafKey);
    if (!preset) throw new Error(`Preset not found: ${leafKey}`);

    const chain = [preset];
    const visited = new Set([leafKey]);
    let current = preset;
    while (current.parent) {
      if (visited.has(current.parent)) {
        throw new Error(`Circular parent reference detected: ${current.key} → ${current.parent}`);
      }
      const parentPreset = this.get(current.parent);
      if (!parentPreset) {
        throw new Error(`Parent preset not found: ${current.parent} (referenced by ${current.key})`);
      }
      visited.add(current.parent);
      chain.unshift(parentPreset);
      if (chain.length > maxDepth) throw new Error(`preset parent chain exceeds depth ${maxDepth}`);
      current = parentPreset;
    }
    return chain;
  }
}

function registryPresets(projectRoot, {
  strict = false,
  maxEntries,
  existingPresetCount = 0,
  managedDirectory,
} = {}) {
  if (!projectRoot) return [];
  try {
    return [...loadPluginRegistry(projectRoot, {
      maxPresetEntries: maxEntries,
      existingPresetCount,
      managedDirectory,
    }).presets.values()];
  } catch (err) {
    if (err.message.includes("preset registry exceeds")) throw err;
    if (strict) throw err;
    logger.verbose(`plugin registry failed: ${err.message}`);
    return [];
  }
}

export function createPresetCatalog(projectRoot, { strict = false, maxEntries, managedDirectory } = {}) {
  const byKey = new Map(CORE_PRESETS.map((preset) => [preset.key, preset]));
  if (maxEntries !== undefined && byKey.size > maxEntries) {
    throw new Error(`preset registry exceeds ${maxEntries} entries`);
  }
  if (projectRoot) {
    for (const preset of registryPresets(projectRoot, {
      strict,
      maxEntries,
      existingPresetCount: byKey.size,
      managedDirectory,
    })) {
      byKey.set(preset.key, preset);
    }
  }
  if (maxEntries !== undefined && byKey.size > maxEntries) {
    throw new Error(`preset registry exceeds ${maxEntries} entries`);
  }
  return new PresetCatalog([...byKey.values()]);
}

function allPresets(projectRoot) {
  return createPresetCatalog(projectRoot).list();
}

export function listPresets(projectRoot, { maxEntries } = {}) {
  return createPresetCatalog(projectRoot, { maxEntries }).list();
}

export function listSetupPresetCandidates(projectRoot, { includeOfficialPresets = false, officialPresetRoot } = {}) {
  const byKey = new Map(CORE_PRESETS.map((preset) => [preset.key, preset]));
  if (projectRoot) {
    for (const preset of registryPresets(projectRoot, { strict: true })) byKey.set(preset.key, preset);
  }
  if (includeOfficialPresets) {
    if (!officialPresetRoot) throw new Error("official preset source cannot be resolved");
    const manifest = PluginManifest.fromRoot(officialPresetRoot, "official-presets");
    if (manifest.name !== "official-presets") {
      throw new Error(`official package mismatch: expected official-presets, got ${manifest.name}`);
    }
    for (const preset of manifest.presetEntries()) byKey.set(preset.key, preset);
  }
  const candidates = [...byKey.values()];
  validatePresetCandidateChains(candidates, projectRoot);
  return candidates;
}

export function validatePresetCandidateChains(candidates, projectRoot) {
  for (const candidate of candidates) {
    resolvePresetCandidateChains(candidate.key, candidates, { maxDepth: MAX_CHAIN_DEPTH });
  }
}

/**
 * Resolve the full parent chain for a preset, from root (base) to the given leaf.
 *
 * @param {string} leafKey - Preset key (e.g. "sample-preset", "node-cli", "app-preset")
 * @param {string} [projectRoot] - Project root directory for plugin registry lookup
 * @param {object} [opts]
 * @param {number} [opts.maxDepth]
 * @returns {Object[]} Array of preset objects, ordered root to leaf (e.g. [base, parent-preset, child-preset])
 * @throws {Error} If preset not found or circular reference detected
 */
export function resolveChain(leafKey, projectRoot, opts = {}) {
  return createPresetCatalog(projectRoot).resolveChain(leafKey, {
    maxDepth: opts.maxDepth || MAX_CHAIN_DEPTH,
  });
}

/**
 * Resolve multiple type entries into independent chains.
 * Handles parent-child dedup: if both parent and child are in the list,
 * only the child's chain is kept (parent is already included).
 *
 * @param {string|string[]} types - Single preset name or array of preset names
 * @param {string} [projectRoot] - Project root directory for .sennel/presets/ lookup
 * @returns {Object[][]} Array of chains, each chain is root → leaf ordered
 */
export function resolveMultiChains(types, projectRoot, opts = {}) {
  const typeList = Array.isArray(types) ? types : [types];

  // Deduplicate identical entries first
  const unique = [...new Set(typeList)];

  // Resolve each type into its full chain
  const chains = unique.map((t) => resolveChain(t, projectRoot, opts));

  return dedupeParentChains(chains);
}

/**
 * Resolve every preset chain from the command-owned configuration without
 * applying the tolerant fallback used by presentation-oriented preset
 * consumers. Callers that already resolved command context must not trigger a
 * second configuration read from a different repository/worktree authority.
 *
 * @param {string} projectRoot
 * @param {object} config
 * @returns {object|null} the project config, or null when no config exists
 */
export function validateConfiguredPresetChains(projectRoot, config) {
  if (!config.type) return config;
  resolveMultiChains(config.type, projectRoot);
  return config;
}

export function resolvePresetCandidateChains(types, candidates, opts = {}) {
  const maxDepth = opts.maxDepth || MAX_CHAIN_DEPTH;
  const byKey = new Map(candidates.map((preset) => [preset.key, preset]));
  const typeList = Array.isArray(types) ? types : [types];
  const unique = [...new Set(typeList)];
  const chains = unique.map((leafKey) => {
    const preset = byKey.get(leafKey);
    if (!preset) throw new Error(`Preset not found: ${leafKey}`);
    const chain = [preset];
    const visited = new Set([leafKey]);
    let current = preset;

    while (current.parent) {
      if (visited.has(current.parent)) {
        throw new Error(`Circular parent reference detected: ${current.key} → ${current.parent}`);
      }
      const parentPreset = byKey.get(current.parent);
      if (!parentPreset) {
        throw new Error(`Parent preset not found: ${current.parent} (referenced by ${current.key})`);
      }
      visited.add(current.parent);
      chain.unshift(parentPreset);
      if (chain.length > maxDepth) {
        throw new Error(`preset parent chain exceeds depth ${maxDepth}`);
      }
      current = parentPreset;
    }

    return chain;
  });

  return dedupeParentChains(chains);
}

function dedupeParentChains(chains) {
  // Dedup: if one chain's leaf is an ancestor of another chain, keep only the longer one
  const result = [];
  for (let i = 0; i < chains.length; i++) {
    const leafKey = chains[i][chains[i].length - 1].key;
    let isSubset = false;

    for (let j = 0; j < chains.length; j++) {
      if (i === j) continue;
      if (chains[j].some((p) => p.key === leafKey) && chains[j].length > chains[i].length) {
        isSubset = true;
        break;
      }
    }

    if (!isSubset) {
      result.push(chains[i]);
    }
  }

  return result;
}

/**
 * Resolve the parent chain for a preset, with fallback for unknown presets.
 * Unlike resolveChain(), this never throws.
 *
 * @param {string} presetKey - Preset key (e.g. "sample-preset", "node-cli")
 * @param {string} [projectRoot] - Project root directory for .sennel/presets/ lookup
 * @returns {Object[]} Array of preset objects, ordered root → leaf
 */
export function resolveChainSafe(presetKey, projectRoot, opts = {}) {
  try {
    return resolveChain(presetKey, projectRoot, opts);
  } catch (err) {
    logger.verbose(`resolveChain failed for "${presetKey}": ${err.message}`);
    const preset = allPresets(projectRoot).find((p) => p.key === presetKey);
    if (preset) return [preset];
    const base = PRESETS.find((p) => p.key === "base");
    return base ? [base] : [];
  }
}

/**
 * Structural template files that are not listed in `chapters` by design —
 * layout scaffolding and agent/readme sources. Excluded from reverse-direction
 * warnings in validatePresetChain().
 */
const SPECIAL_TEMPLATES = new Set(["README.md", "flow-agent-instructions.md", "layout.md"]);

/**
 * Upper bounds for validatePresetChain iteration (bounded-resource-usage).
 * validatePresetChain runs once at CLI startup (upgrade / setup / docs build)
 * on a finite, user-declared set — it is not a request hot path. The
 * synchronous fs.existsSync / fs.readdirSync calls it performs are bounded by
 * (MAX_CHAPTERS × MAX_LANGUAGES × MAX_CHAIN_DEPTH) per type and rejected when
 * exceeded.
 */
const MAX_CHAPTERS_PER_PRESET = 200;
const MAX_LANGUAGES = 20;
const MAX_CHAIN_DEPTH = 16;

export function normalizePresetTypes(types) {
  return (Array.isArray(types) ? types : [types]).filter(Boolean);
}

export function resolvePresetChains(types, projectRoot, opts = {}) {
  return normalizePresetTypes(types).map((type) => resolveChain(type, projectRoot, opts));
}

export function resolvePresetEntriesForSearch(types, projectRoot, { chainOrder = "leaf-to-root", typeOrder = "config" } = {}) {
  const chains = resolvePresetChains(types, projectRoot, { maxDepth: MAX_CHAIN_DEPTH });
  const orderedChains = typeOrder === "reverse" ? [...chains].reverse() : chains;
  const entries = [];
  for (const chain of orderedChains) {
    const ordered = chainOrder === "root-to-leaf" ? chain : [...chain].reverse();
    entries.push(...ordered);
  }
  return entries;
}

/**
 * Resolve the effective chapter list (file names) for a set of preset types.
 * Mirrors the priority used by template-merger.resolveChaptersOrder():
 *   configChapters (when non-empty) > union of leaf chapters across type chains.
 */
function resolveEffectiveChapters(typeList, projectRoot, configChapters, resolveChainForType) {
  if (configChapters?.length) {
    return configChapters
      .filter((c) => typeof c === "string" || !c.exclude)
      .map((c) => (typeof c === "string" ? c : c.chapter));
  }
  const seen = new Set();
  const result = [];
  for (const key of typeList) {
    const chain = resolveChainForType(key);
    let chainChapters = [];
    for (const preset of chain) {
      if (preset.chapters?.length && (presetHasTemplates(preset) || preset.localManifest)) {
        chainChapters = preset.chapters;
      }
    }
    for (const ch of chainChapters) {
      const name = typeof ch === "string" ? ch : ch.chapter;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return result;
}

function presetHasTemplates(preset) {
  const templatesDir = path.join(preset.dir, "templates");
  return fs.existsSync(templatesDir);
}

/**
 * Return the list of template directories to search for the given (types, lang),
 * ordered by precedence (project-local first, then union of chain leaf → root
 * across all types) — matching template-merger.resolveTemplates(), which
 * searches across all type chains for each chapter. Validator PASS ≡ build
 * can resolve the chapter via some chain.
 */
function templateSearchDirs(typeList, projectRoot, lang, resolveChainForType, projectTemplatesDirectory) {
  const dirs = [];
  const seen = new Set();
  const push = (d) => {
    if (!seen.has(d)) {
      seen.add(d);
      dirs.push(d);
    }
  };
  if (projectRoot) {
    // init.js uses `<root>/.sennel/templates/<lang>/docs` as the project-local
    // dir — mirror that path so validator PASS implies build can resolve.
    push(projectTemplatesDirectory
      ? path.join(projectTemplatesDirectory, lang, "docs")
      : path.join(projectRoot, PRODUCT.managedPath("templates", lang, "docs")));
  }
  for (const typeKey of typeList) {
    const chain = resolveChainForType(typeKey);
    if (chain.length > MAX_CHAIN_DEPTH) {
      throw new Error(`validatePresetChain: chain depth exceeds MAX_CHAIN_DEPTH (${chain.length} > ${MAX_CHAIN_DEPTH}) for type=${typeKey}`);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      push(path.join(chain[i].dir, "templates", lang));
    }
  }
  return dirs;
}

/**
 * Validate that every chapter declared by the effective chapter list resolves
 * to a `.md` template file in the preset chain or the project-local templates
 * directory, for each configured language.
 *
 * Throws `Error` with a structured message (missing pairs + searched paths)
 * when any (chapter, language) pair cannot be resolved. Returns silently on
 * success.
 *
 * Reverse direction (template present but not in chapters) emits a warning to
 * stderr without failing — chapters may intentionally exclude a template.
 *
 * @param {string|string[]} types - Preset key(s) to validate.
 * @param {string|undefined} projectRoot - Project root for .sennel/ lookups.
 * @param {object} options
 * @param {string[]} options.languages - Languages to validate (from config.docs.languages).
 * @param {Array} [options.configChapters] - Override chapters (from config.chapters).
 */
function validatePresetChainWithResolver(types, projectRoot, {
  languages,
  configChapters,
  projectTemplatesDirectory,
  templateExists = fs.existsSync,
  reportUnlistedTemplates = true,
} = {}, resolveChainForType) {
  if (!languages?.length) return;
  if (languages.length > MAX_LANGUAGES) {
    throw new Error(`validatePresetChain: languages count exceeds MAX_LANGUAGES (${languages.length} > ${MAX_LANGUAGES})`);
  }

  const typeList = Array.isArray(types) ? types : [types];
  const effectiveChapters = resolveEffectiveChapters(typeList, projectRoot, configChapters, resolveChainForType);
  if (effectiveChapters.length > MAX_CHAPTERS_PER_PRESET) {
    throw new Error(`validatePresetChain: chapter count exceeds MAX_CHAPTERS_PER_PRESET (${effectiveChapters.length} > ${MAX_CHAPTERS_PER_PRESET})`);
  }

  // CLI startup path (not a request hot path): one-shot existsSync iteration
  // bounded by MAX_CHAPTERS × MAX_LANGUAGES × (types × MAX_CHAIN_DEPTH).
  const missing = [];
  const searchedPaths = new Set();

  for (const chapter of effectiveChapters) {
    for (const lang of languages) {
      const dirs = templateSearchDirs(
        typeList,
        projectRoot,
        lang,
        resolveChainForType,
        projectTemplatesDirectory,
      );
      dirs.forEach((d) => searchedPaths.add(d));
      const found = dirs.some((d) => templateExists(path.join(d, chapter)));
      if (!found) missing.push({ chapter, lang });
    }
  }

  if (missing.length > 0) {
    const lines = [
      `preset chapter-template validation failed (${missing.length} missing)`,
    ];
    for (const m of missing) {
      lines.push(`  - chapter=${m.chapter} lang=${m.lang}`);
    }
    lines.push("searched:");
    for (const p of searchedPaths) {
      lines.push(`  - ${p}`);
    }
    throw new Error(lines.join("\n"));
  }

  // Reverse direction: warn on project-local templates present but not in
  // effective chapters. Chain templates are intentionally shared and may be
  // excluded by a leaf preset's chapter override — those are not noise-worthy.
  if (!projectRoot || !reportUnlistedTemplates) return;
  const effectiveSet = new Set(effectiveChapters);
  const reported = new Set();
  for (const lang of languages) {
    const dir = projectTemplatesDirectory
      ? path.join(projectTemplatesDirectory, lang, "docs")
      : path.join(projectRoot, PRODUCT.managedPath("templates", lang, "docs"));
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      if (SPECIAL_TEMPLATES.has(file)) continue;
      if (effectiveSet.has(file)) continue;
      const k = `${lang}:${file}`;
      if (reported.has(k)) continue;
      reported.add(k);
      process.stderr.write(
        `[preset] WARN: project-local template ${path.join(dir, file)} not listed in chapters (lang=${lang}).\n`,
      );
    }
  }
}

export function validatePresetChain(types, projectRoot, opts = {}) {
  return validatePresetChainWithResolver(
    types,
    projectRoot,
    opts,
    (type) => resolveChain(type, projectRoot, { maxDepth: MAX_CHAIN_DEPTH }),
  );
}

/**
 * Validate the future normal-upgrade preset boundary while a managed directory
 * is still staged under an explicit non-canonical path. Normal runtime keeps
 * using validatePresetChain() and never discovers legacy directory names.
 */
export function validatePresetChainFromManagedDirectory(types, projectRoot, managedDirectory, opts = {}) {
  const catalog = createPresetCatalog(projectRoot, { managedDirectory });
  return validatePresetChainWithResolver(
    types,
    projectRoot,
    { ...opts, projectTemplatesDirectory: path.join(managedDirectory, "templates") },
    (type) => catalog.resolveChain(type, { maxDepth: MAX_CHAIN_DEPTH }),
  );
}

export function validatePresetCandidateChain(types, candidates, projectRoot, opts = {}) {
  return validatePresetChainWithResolver(
    types,
    projectRoot,
    opts,
    (type) => resolvePresetCandidateChains(type, candidates, { maxDepth: MAX_CHAIN_DEPTH })[0],
  );
}

/**
 * Look up a preset by its leaf key (e.g. "sample-preset").
 *
 * @param {string} leaf
 */
export function presetByLeaf(leaf, projectRoot) {
  return allPresets(projectRoot).find((p) => p.key === leaf);
}

/**
 * Return presets whose parent is the given key.
 *
 * @param {string} parentKey - Parent preset key (e.g. "app-preset", "cli")
 */
export function presetsForArch(parentKey, projectRoot) {
  return allPresets(projectRoot).filter((p) => p.parent === parentKey);
}
