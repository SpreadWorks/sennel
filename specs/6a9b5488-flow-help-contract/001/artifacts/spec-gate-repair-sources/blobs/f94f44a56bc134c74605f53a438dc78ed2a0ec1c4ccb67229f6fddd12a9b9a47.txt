/**
 * src/lib/container.js
 *
 * Dependency container for CLI-wide initialized services (config, logger, paths,
 * agent, i18n, flowManager, etc.). Built once in src/sennel.js and
 * referenced by all dispatchers and commands via the module-level `container`
 * export.
 */

import path from "path";
import { repoRoot, sourceRoot, isInsideWorktree, getMainRepoPath } from "./cli.js";
import { loadConfig, loadJsonFile, managedConfigPath, managedDir, managedOutputDir, resolveWorkDir } from "./config.js";
import { Logger } from "./log.js";
import { Agent } from "./agent.js";
import { ProviderRegistry } from "./provider.js";
import { translate } from "./i18n.js";
import { FlowManager } from "./flow-manager.js";
import { FINALIZE_CLEANUP_DURABLE_AGENT_WORK_DIR } from "./finalize-cleanup-paths.js";
import { DataSource } from "../docs/lib/data-source.js";
import { Scannable } from "../docs/lib/scan-source.js";
import {
  Renderable,
  Table,
  BulletList,
  OrderedList,
  Paragraph,
  CodeBlock,
  Blockquote,
  Heading,
  Fragment,
} from "../docs/lib/renderable.js";
import { AnalysisEntry, ANALYSIS_META_KEYS, iterateAnalysisCategories } from "../docs/lib/analysis-entry.js";
import { findFiles, collectFiles, patternToRegex, parseFile, parsePHPFile, parseJSFile, camelToSnake, pluralize, getFileStats } from "../docs/lib/scanner.js";
import { stripBlockComments, extractArrayBody, extractTopLevelKeys, extractQuotedStrings } from "../docs/lib/php-array-parser.js";
import { getLangHandler } from "../docs/lib/lang-factory.js";
import { hasPathPrefix, hasSegmentPath, hasAnyPathPrefix } from "./path-match.js";
import { parseTOML } from "../docs/lib/toml-parser.js";
import { flowSpecRootFromConfig } from "./flow-workspace.js";

export class Container {
  constructor() {
    this._map = new Map();
    this._presets = new Map();
  }

  register(name, value) {
    this._map.set(name, value);
  }

  set(name, value) {
    this._map.set(name, value);
  }

  get(name) {
    if (!this._map.has(name)) {
      throw new Error(`Container: dependency not registered: ${name}`);
    }
    return this._map.get(name);
  }

  has(name) {
    return this._map.has(name);
  }

  /**
   * Register a preset's public surface (DataSource classes, etc.).
   * Called by the preset loader after invoking the preset's register(container)
   * factory. Enables child presets to extend parent preset classes via
   * container.getPreset(parent).dataSources[name].
   *
   * @param {string} key - preset key (e.g. "sample-preset", "child-preset")
   * @param {{ dataSources: Object<string, Function> }} registration
   */
  registerPreset(key, registration) {
    this._presets.set(key, registration);
  }

  getPreset(key) {
    return this._presets.get(key) ?? null;
  }

  hasPreset(key) {
    return this._presets.has(key);
  }

  reset() {
    this._map.clear();
    this._presets.clear();
  }
}

export const container = new Container();

/**
 * Build path service object. All fields are absolute paths.
 *
 * Work-directory priority: opts.agentWorkDirOverride > config.agent.workDir > .tmp.
 * `logDir` is computed once here and reused by Logger.
 */
function buildPaths(root, config, opts = {}) {
  const durableRoot = opts.durableRoot ? path.resolve(opts.durableRoot) : null;
  const agentWorkDir = durableRoot
    ? path.join(durableRoot, FINALIZE_CLEANUP_DURABLE_AGENT_WORK_DIR)
    : resolveWorkDir(root, config, opts);
  const logDir = config?.logs?.dir
    ? path.resolve(durableRoot || root, config.logs.dir)
    : path.join(agentWorkDir, "logs");
  return Object.freeze({
    root,
    srcRoot: sourceRoot(),
    managedDir: managedDir(root),
    outputDir: managedOutputDir(root),
    agentWorkDir,
    logDir,
    configPath: managedConfigPath(root),
  });
}

/**
 * Initialize the module-level container. Called once from src/sennel.js.
 * Subsequent dispatchers and commands import `container` directly.
 *
 * Best-effort initialization: if config is absent (setup not run yet, help-only
 * invocation, etc.), `null` is registered for config so that commands which
 * require config can be rejected at the dispatch layer via `requiresConfig`,
 * while commands that do not require config (help, setup, etc.) can still
 * start. Logger init is skipped when config is absent.
 *
 * @param {Object} [opts]
 * @param {string} [opts.entryCommand] - Full argv string for Logger metadata
 * @param {string} [opts.agentWorkDirOverride] - Per-invocation agent work dir
 * @param {boolean} [opts.finalizeCleanupDurablePaths] - Keep cleanup logs under
 *   repository authority after the managed worktree is removed.
 * @param {boolean} [opts.allowInvalidConfig] - Initialize with null config so
 *   migration commands can repair config that strict validation rejects.
 * @param {"ambient"|"none"} [opts.flowAttribution] - Ambient Flow attribution
 *   policy for command-level diagnostic logging.
 */
export function initContainer(opts = {}) {
  // Idempotent: if already initialized (e.g. by sennel.js before a
  // dispatcher was imported), do not re-run initialization. This lets
  // each dispatcher safely call initContainer() at its top to support
  // standalone execution (direct `node src/flow.js` invocation in tests)
  // without violating R1's one-time-initialization invariant.
  if (container.has("config")) return;

  const root = repoRoot();
  let config = null;
  let configLoaded = false;
  try {
    config = loadConfig(root, { allowMissingType: true });
    configLoaded = true;
  } catch (err) {
    if (err?.code !== "ERR_MISSING_FILE") {
      if (opts.allowInvalidConfig === true) {
        config = null;
        configLoaded = false;
      } else {
      process.stderr.write(`[sennel] config load failed: ${err?.message}\n`);
      throw err;
      }
    }
  }

  const inWorktree = isInsideWorktree(root);
  const mainRoot = inWorktree ? getMainRepoPath(root) : root;
  let mainConfig = config;
  if (inWorktree) {
    try {
      mainConfig = loadConfig(mainRoot, { allowMissingType: true });
    } catch (err) {
      // A linked worktree can be a standalone project fixture. Its common
      // repository is not required to carry Sennel configuration; use the
      // worktree configuration unless a readable main configuration exists.
      if (err?.code !== "ERR_MISSING_FILE") throw err;
    }
  }
  const flowSpecRoot = flowSpecRootFromConfig(mainConfig);
  const durableFinalizeRoot = opts.finalizeCleanupDurablePaths === true && inWorktree
    ? mainRoot
    : null;
  const paths = buildPaths(root, config, {
    agentWorkDirOverride: opts.agentWorkDirOverride,
    durableRoot: durableFinalizeRoot,
  });

  container.register("root", root);
  container.register("config", config);
  container.register("paths", paths);
  container.register("inWorktree", inWorktree);
  container.register("mainRoot", mainRoot);
  container.register("flowSpecRoot", flowSpecRoot);
  const flowManager = new FlowManager({ root, mainRoot, inWorktree, specRoot: flowSpecRoot });
  container.register("flowManager", flowManager);
  const loggerFlowManager = durableFinalizeRoot
    ? flowManager.forRoot(durableFinalizeRoot)
    : flowManager;
  const logger = new Logger({
    logDir: paths.logDir,
    enabled: configLoaded && config?.logs?.enabled === true,
    entryCommand: opts.entryCommand ?? null,
    flowManager: loggerFlowManager,
    flowAttribution: opts.flowAttribution ?? "ambient",
    cwd: durableFinalizeRoot || root,
  });
  container.register("logger", logger);
  if (configLoaded) {
    logger.event("config-loaded", { path: paths.configPath, keys: Object.keys(config) });
  }

  const registry = new ProviderRegistry(config?.agent?.providers || {});
  const agent = new Agent({ config, paths, registry, logger, flowManager });
  container.register("agent", agent);
  globalThis.__sennelPluginAgent = agent;
  container.register("i18n", translate());
  container.register("lang", config?.lang);

  // Base classes and utilities exposed to presets. Presets access these via
  // container.get("base.DataSource") etc. so they never need to import from
  // sennel internal paths directly.
  container.register("base.DataSource", DataSource);
  container.register("base.Scannable", Scannable);
  container.register("base.AnalysisEntry", AnalysisEntry);
  container.register("base.ANALYSIS_META_KEYS", ANALYSIS_META_KEYS);
  container.register("base.iterateAnalysisCategories", iterateAnalysisCategories);
  container.register("base.Renderable", Renderable);
  container.register("base.Table", Table);
  container.register("base.BulletList", BulletList);
  container.register("base.OrderedList", OrderedList);
  container.register("base.Paragraph", Paragraph);
  container.register("base.CodeBlock", CodeBlock);
  container.register("base.Blockquote", Blockquote);
  container.register("base.Heading", Heading);
  container.register("base.Fragment", Fragment);
  container.register("scanner.findFiles", findFiles);
  container.register("scanner.collectFiles", collectFiles);
  container.register("scanner.patternToRegex", patternToRegex);
  container.register("scanner.parseFile", parseFile);
  container.register("scanner.parsePHPFile", parsePHPFile);
  container.register("scanner.parseJSFile", parseJSFile);
  container.register("scanner.camelToSnake", camelToSnake);
  container.register("scanner.pluralize", pluralize);
  container.register("scanner.getFileStats", getFileStats);
  container.register("phpParser.stripBlockComments", stripBlockComments);
  container.register("phpParser.extractArrayBody", extractArrayBody);
  container.register("phpParser.extractTopLevelKeys", extractTopLevelKeys);
  container.register("phpParser.extractQuotedStrings", extractQuotedStrings);
  container.register("lang.getHandler", getLangHandler);
  container.register("pathMatch.hasPathPrefix", hasPathPrefix);
  container.register("pathMatch.hasSegmentPath", hasSegmentPath);
  container.register("pathMatch.hasAnyPathPrefix", hasAnyPathPrefix);
  container.register("toml.parse", parseTOML);
  container.register("config.loadJsonFile", loadJsonFile);
}
