import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createPluginAgentApi } from "./agent.js";
import { repoRoot } from "./cli.js";
import {
  loadConfig,
  loadRawConfig,
  loadRawConfigFromManagedDirectory,
  managedConfigPath,
  managedDir,
  managedLocalConfigPath,
} from "./config.js";
import { PRODUCT } from "./product.js";
import { Envelope } from "./flow-envelope.js";
import { EsmModule } from "./esm-module.js";
import { officialPresetPluginRoot } from "./official-plugins.js";
import {
  PluginConfigTransaction,
  PluginInstallation,
  PluginInstaller,
} from "./plugin-installer.js";
import { runCmd, assertOk } from "./process.js";
import { DEFAULT_FLOW_SPEC_DIR, FlowSpecLocation } from "./flow-workspace.js";

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const KNOWN_PLUGIN_PACKAGE_PATHS = Object.freeze([
  "plugin.json",
  "commands/",
  "skills/",
  "presets/",
  "hooks/",
  "lib/",
  "config.schema.json",
  "config.defaults.json",
]);
const MAX_ENABLED_PLUGIN_PACKAGES = 100;
const MAX_PLUGIN_SOURCES = 100;
const MAX_PLUGIN_HOOK_FILES = 200;
const MAX_PLUGIN_COPY_FILES = 2000;
const MAX_PLUGIN_PATH_DEPTH = 20;
const MAX_PLUGIN_JSON_BYTES = 1024 * 1024;
const MAX_PLUGIN_RELATIVE_PATH_BYTES = 300;
const FLOW_COMMANDS = new Set(["prepare", "gate", "review", "test-execute", "test-result-review", "retro", "acceptance-review", "final-regression", "report", "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]);
const FLOW_COMMAND_HOOKS = new Set(["pre", "post", "onError", "finally"]);
const CORE_COMMANDS = new Set(["docs", "flow", "check", "metrics", "spec", "hook", "setup", "upgrade", "presets", "plugin", "help"]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPluginJson(file, root) {
  const lstat = fs.lstatSync(file);
  if (lstat.isSymbolicLink()) throw new Error(`unsafe package metadata: symlink not allowed: ${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`unsafe package metadata: not a file: ${file}`);
  if (stat.size > MAX_PLUGIN_JSON_BYTES) {
    throw new Error(`unsafe package metadata: JSON file exceeds ${MAX_PLUGIN_JSON_BYTES} bytes: ${file}`);
  }
  if (root) {
    const rootRealPath = fs.realpathSync(root);
    const fileRealPath = fs.realpathSync(file);
    if (!isUnderPath(fileRealPath, rootRealPath)) {
      throw new Error(`unsafe package metadata: path escapes plugin root: ${file}`);
    }
  }
  return readJson(file);
}

function pluginMetadataPath(root, rel, label = "plugin metadata") {
  const normalized = normalizeRel(rel, label);
  const resolved = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (!isUnderPath(resolved, rootPath)) throw new Error(`unsafe ${label}: path escapes plugin root`);
  return resolved;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function ensurePluginConfig(config) {
  if (!config.plugin || typeof config.plugin !== "object") config.plugin = {};
  if (!Array.isArray(config.plugin.sources)) config.plugin.sources = [];
  if (!Array.isArray(config.plugin.packages)) config.plugin.packages = [];
  if (!config.plugin.config || typeof config.plugin.config !== "object") config.plugin.config = {};
  return config.plugin;
}

export function readProjectConfig(root = repoRoot()) {
  const config = loadRawConfig(root);
  ensurePluginConfig(config);
  return config;
}

function readStoredProjectConfig(root = repoRoot(), { missingAsEmpty = false } = {}) {
  if (missingAsEmpty && !fs.existsSync(managedConfigPath(root))) {
    const config = {};
    ensurePluginConfig(config);
    return config;
  }
  const config = readJson(managedConfigPath(root));
  ensurePluginConfig(config);
  return config;
}

function readStoredLocalProjectConfig(root = repoRoot(), { missingAsEmpty = false } = {}) {
  const localPath = managedLocalConfigPath(root);
  if (missingAsEmpty && !fs.existsSync(localPath)) {
    const config = {};
    ensurePluginConfig(config);
    return config;
  }
  const config = readJson(localPath);
  ensurePluginConfig(config);
  return config;
}

class PluginConfigSet {
  constructor(root, { publicConfig, localConfig } = {}) {
    this.publicConfig = structuredClone(
      publicConfig || readStoredProjectConfig(root, { missingAsEmpty: true }),
    );
    this.localConfig = structuredClone(
      localConfig || readStoredLocalProjectConfig(root, { missingAsEmpty: true }),
    );
    this.publicPlugin = ensurePluginConfig(this.publicConfig);
    this.localPlugin = ensurePluginConfig(this.localConfig);
  }

  get sources() {
    return mergePluginEntriesById(this.publicPlugin.sources, this.localPlugin.sources);
  }

  findSource(predicate) {
    return this.sources.find(predicate);
  }

  findPackage(id) {
    return this.localPlugin.packages.find((pkg) => pkg.id === id)
      || this.publicPlugin.packages.find((pkg) => pkg.id === id)
      || null;
  }
}

function mergePluginEntriesById(base, overlay) {
  const out = Array.isArray(base) ? structuredClone(base) : [];
  const indexById = new Map(out.map((entry, index) => [entry?.id, index]).filter(([id]) => typeof id === "string"));
  for (const entry of overlay || []) {
    const next = structuredClone(entry);
    const index = indexById.get(next?.id);
    if (index == null) {
      indexById.set(next?.id, out.length);
      out.push(next);
    } else {
      out[index] = { ...out[index], ...next };
    }
  }
  return out;
}

function readPluginOperationConfig(root = repoRoot()) {
  const config = readProjectConfig(root);
  const publicConfig = readStoredProjectConfig(root, { missingAsEmpty: true });
  const localConfig = readStoredLocalProjectConfig(root, { missingAsEmpty: true });
  const plugin = ensurePluginConfig(config);
  const publicPlugin = ensurePluginConfig(publicConfig);
  const localPlugin = ensurePluginConfig(localConfig);
  plugin.sources = mergePluginEntriesById(publicPlugin.sources, localPlugin.sources);
  plugin.packages = mergePluginEntriesById(publicPlugin.packages, localPlugin.packages);
  return config;
}

export function writeProjectConfig(root, config) {
  writeJson(managedConfigPath(root), config);
}

export function maskPluginSource(source) {
  return String(source).replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+(@)/g, "$1***$2");
}

function sourceLocation(source) {
  return source.path || source.url || source.remote || source.source;
}

function normalizeRel(rel, label = "path") {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw new Error(`unsafe ${label}: must be a non-empty string`);
  }
  const value = rel.replace(/\\/g, "/");
  if (path.isAbsolute(value) || value === "." || value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) {
    throw new Error(`unsafe ${label}: parent traversal or absolute path is not allowed`);
  }
  const parts = value.split("/");
  if (parts.includes(".git")) throw new Error(`unsafe ${label}: .git content is not allowed`);
  if (parts.includes("node_modules")) throw new Error(`unsafe ${label}: node_modules content is not allowed`);
  if (parts.length > MAX_PLUGIN_PATH_DEPTH) throw new Error(`unsafe ${label}: path depth exceeds ${MAX_PLUGIN_PATH_DEPTH}`);
  if (Buffer.byteLength(value) > MAX_PLUGIN_RELATIVE_PATH_BYTES) throw new Error(`unsafe ${label}: relative path exceeds ${MAX_PLUGIN_RELATIVE_PATH_BYTES} bytes`);
  return value;
}

function isUnderPath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function importSpecifiers(source) {
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const out = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) out.push(match[1]);
  }
  return out;
}

function resolveImportPath(specifier, moduleDir) {
  if (specifier.startsWith("node:")) return null;
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(specifier)) {
    if (!specifier.startsWith("file:")) return null;
    return fileURLToPath(specifier);
  }
  if (path.isAbsolute(specifier)) return specifier;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.resolve(moduleDir, specifier);
  }
  return null;
}

function assertNoCoreInternalImports(root, pluginId, pluginRoot, rel, label = "plugin hook") {
  const modulePath = path.join(pluginRoot, normalizeRel(rel, label));
  const source = fs.readFileSync(modulePath, "utf8");
  const moduleDir = path.dirname(modulePath);
  const coreRoots = [
    path.resolve(root, "src"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  ];
  for (const specifier of importSpecifiers(source)) {
    const resolved = resolveImportPath(specifier, moduleDir);
    if (!resolved) continue;
    const absolute = path.resolve(resolved);
    if (coreRoots.some((coreRoot) => isUnderPath(absolute, coreRoot)) && !isUnderPath(absolute, pluginRoot)) {
      throw new Error(`${label} ${pluginId}/${rel} imports core internal path: ${specifier}`);
    }
  }
}

function assertId(id, label = "id") {
  if (!ID_RE.test(String(id || ""))) throw new Error(`unsafe ${label}: invalid id "${id}"`);
}

function isUnderFileAllowlist(rel, files) {
  const normalized = normalizeRel(rel, "contribution path");
  return files.some((entry) => {
    const file = normalizeRel(entry, "files entry");
    if (file.endsWith("/")) return normalized === file.slice(0, -1) || normalized.startsWith(file);
    return normalized === file || normalized.startsWith(`${file}/`);
  });
}

function walkFiles(root, rel = "") {
  const current = path.join(root, rel);
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`unsafe package: symlink not allowed: ${rel || "."}`);
  if (stat.isDirectory()) {
    const out = [];
    for (const entry of fs.readdirSync(current)) {
      const childRel = rel ? `${rel}/${entry}` : entry;
      normalizeRel(childRel, "package path");
      out.push(...walkFiles(root, childRel));
    }
    return out;
  }
  if (!stat.isFile()) return [];
  normalizeRel(rel, "package path");
  if (/\.json$/i.test(rel) && stat.size > MAX_PLUGIN_JSON_BYTES) {
    throw new Error(`unsafe package metadata: JSON file exceeds ${MAX_PLUGIN_JSON_BYTES} bytes: ${rel}`);
  }
  return [rel];
}

function validatePackageJson(root) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) return;
  const pkg = readJson(packagePath);
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (pkg[key] && Object.keys(pkg[key]).length > 0) throw new Error(`unsafe package.json: ${key} are not allowed`);
  }
  if (pkg.scripts && Object.keys(pkg.scripts).length > 0) throw new Error("unsafe package.json: scripts are not allowed");
}

export class PluginManifest {
  constructor(root, raw, providerId = raw?.name) {
    this.root = root;
    this.providerId = providerId;
    this.name = raw?.name;
    this.type = raw?.type || "mixed";
    this.files = Array.isArray(raw?.files) && raw.files.length > 0 ? raw.files : KNOWN_PLUGIN_PACKAGE_PATHS;
    this.contributions = raw?.contributions || {};
    this.raw = raw;
    this.validate();
  }

  validate() {
    assertId(this.name, "plugin name");
    for (const file of this.files) {
      normalizeRel(file, "files entry");
      if (file === ".") throw new Error("unsafe files entry: copying repository root would include .git content");
    }
    const commands = this.contributions.commands || [];
    if (!Array.isArray(commands)) throw new Error("plugin commands contribution must be an array");
    for (const command of commands) {
      assertId(command.name, "command name");
      if (CORE_COMMANDS.has(command.name)) throw new Error(`plugin command override rejected: ${command.name} is a core command`);
      if (!isUnderFileAllowlist(command.path, this.files)) throw new Error(`contribution path outside files allowlist: ${command.path}`);
    }
    const presets = this.contributions.presets || [];
    if (!Array.isArray(presets)) throw new Error("plugin presets contribution must be an array");
    for (const preset of presets) {
      assertId(preset.key, "preset key");
      if (!isUnderFileAllowlist(preset.path, this.files)) throw new Error(`contribution path outside files allowlist: ${preset.path}`);
    }
    const dataSources = this.contributions.dataSources || [];
    if (!Array.isArray(dataSources)) throw new Error("plugin dataSources contribution must be an array");
    for (const dataSource of dataSources) {
      if (typeof dataSource.name !== "string" || !dataSource.name.includes("/")) throw new Error(`invalid dataSource name: ${dataSource.name}`);
      if (!isUnderFileAllowlist(dataSource.path, this.files)) throw new Error(`contribution path outside files allowlist: ${dataSource.path}`);
    }
    const skills = this.contributions.skills || [];
    if (!Array.isArray(skills)) throw new Error("plugin skills contribution must be an array");
    for (const skill of skills) {
      assertId(String(skill.name).replace(/^sennel\./, ""), "skill name");
      if (!isUnderFileAllowlist(skill.path, this.files)) throw new Error(`contribution path outside files allowlist: ${skill.path}`);
    }
    const config = this.contributions.config;
    if (config) {
      if (config.schema && !isUnderFileAllowlist(config.schema, this.files)) throw new Error(`contribution path outside files allowlist: ${config.schema}`);
      if (config.defaults && !isUnderFileAllowlist(config.defaults, this.files)) throw new Error(`contribution path outside files allowlist: ${config.defaults}`);
    }
  }

  static fromRoot(root, providerId) {
    return new PluginManifest(root, readPluginJson(path.join(root, "plugin.json"), root), providerId);
  }

  presetEntries({ maxEntries, limitLabel } = {}) {
    const entries = [];
    for (const entry of this.contributions.presets || []) {
      if (maxEntries !== undefined && entries.length >= maxEntries) {
        throw new Error(`preset registry exceeds ${limitLabel || maxEntries} entries`);
      }
      const manifestPath = pluginMetadataPath(this.root, `${entry.path}/preset.json`, "preset metadata");
      const presetManifest = fs.existsSync(manifestPath) ? readPluginJson(manifestPath, this.root) : {};
      entries.push({
        key: entry.key,
        dir: path.join(this.root, entry.path),
        parent: entry.parent || presetManifest.parent || null,
        label: presetManifest.label || entry.key,
        aliases: presetManifest.aliases || [],
        scan: presetManifest.scan || {},
        chapters: presetManifest.chapters || [],
        providerId: this.providerId,
      });
    }
    return entries;
  }

  dataSourceEntries() {
    const entries = [];
    for (const entry of this.contributions.dataSources || []) {
      const [presetKey, sourceName] = entry.name.split("/", 2);
      entries.push({ ...entry, presetKey, sourceName, providerId: this.providerId, absolutePath: path.join(this.root, entry.path) });
    }
    for (const preset of this.presetEntries()) {
      const dataDir = path.join(preset.dir, "data");
      if (!fs.existsSync(dataDir)) continue;
      for (const file of fs.readdirSync(dataDir)) {
        if (!file.endsWith(".js")) continue;
        const sourceName = path.basename(file, ".js");
        const name = `${preset.key}/${sourceName}`;
        if (entries.some((entry) => entry.name === name)) continue;
        entries.push({
          name,
          presetKey: preset.key,
          sourceName,
          path: path.relative(this.root, path.join(dataDir, file)).split(path.sep).join("/"),
          category: sourceName,
          methods: null,
          providerId: this.providerId,
          absolutePath: path.join(dataDir, file),
        });
      }
    }
    return entries;
  }

  commandEntries() {
    return (this.contributions.commands || []).map((entry) => ({
      ...entry,
      providerId: this.providerId,
      absolutePath: path.join(this.root, entry.path),
    }));
  }
}

export class PluginCatalog {
  constructor(root, manifests, options = {}) {
    this.root = root;
    this.manifests = manifests;
    this.presets = new Map();
    this.dataSources = new Map();
    this.commands = new Map();
    const maxPresetEntries = options.maxPresetEntries;
    let remainingPresetEntries = maxPresetEntries === undefined
      ? undefined
      : maxPresetEntries - (options.existingPresetCount || 0);
    if (remainingPresetEntries !== undefined && remainingPresetEntries < 0) {
      throw new Error(`preset registry exceeds ${maxPresetEntries} entries`);
    }
    for (const manifest of manifests) {
      const presets = manifest.presetEntries({
        maxEntries: remainingPresetEntries,
        limitLabel: maxPresetEntries,
      });
      for (const preset of presets) this.presets.set(preset.key, preset);
      if (remainingPresetEntries !== undefined) remainingPresetEntries -= presets.length;
      for (const dataSource of manifest.dataSourceEntries()) {
        assertNoCoreInternalImports(root, manifest.providerId, manifest.root, dataSource.path, "plugin dataSource");
        this.dataSources.set(dataSource.name, dataSource);
      }
      for (const command of manifest.commandEntries()) {
        if (this.commands.has(command.name)) {
          throw new Error(`duplicate plugin command: ${command.name}`);
        }
        this.commands.set(command.name, command);
      }
    }
  }

  resolvePreset(key) {
    return this.presets.get(key) || null;
  }

  resolveDataSource(name) {
    return this.dataSources.get(name) || null;
  }

  resolveCommand(name) {
    return this.commands.get(name) || null;
  }

  validatePresetChain(key, opts = {}) {
    const maxDepth = opts.maxDepth || 20;
    const visited = new Set();
    let current = this.resolvePreset(key);
    let depth = 0;
    while (current) {
      if (visited.has(current.key)) throw new Error(`preset parent cycle detected: ${current.key}`);
      visited.add(current.key);
      depth += 1;
      if (depth > maxDepth) throw new Error(`preset parent chain exceeds depth ${maxDepth}`);
      current = current.parent ? this.resolvePreset(current.parent) : null;
    }
  }

  validateDataDirective(name, method) {
    const entry = this.resolveDataSource(name);
    if (!entry) throw new Error(`unknown data source: ${name}`);
    if (entry.methods && !entry.methods.includes(method)) throw new Error(`unknown data source method: ${name}.${method}`);
  }

  prevalidateTemplateDirective(text) {
    const match = String(text).match(/\{\{data\("([^".]+\/[^".]+)\.([^"]+)"\)\}\}/);
    if (!match) return { ok: true };
    try {
      this.validateDataDirective(match[1], match[2]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export class PluginRuntime {
  constructor(root = repoRoot(), options = {}) {
    this.root = path.resolve(root);
    this.options = Object.freeze({ ...options });
    this.managedDirectory = options.managedDirectory
      ? path.resolve(options.managedDirectory)
      : managedDir(this.root);
  }

  loadCatalog() {
    let config;
    try {
      config = this.options.managedDirectory
        ? loadRawConfigFromManagedDirectory(this.managedDirectory)
        : readProjectConfig(this.root);
      ensurePluginConfig(config);
    } catch (_) {
      return new PluginCatalog(this.root, []);
    }
    if (config.plugin.sources.length > MAX_PLUGIN_SOURCES) {
      throw new Error(`plugin source search exceeds ${MAX_PLUGIN_SOURCES} sources`);
    }
    const enabledPackages = config.plugin.packages.filter((pkg) => pkg.enabled !== false);
    if (enabledPackages.length > MAX_ENABLED_PLUGIN_PACKAGES) {
      throw new Error(`enabled plugin packages exceed ${MAX_ENABLED_PLUGIN_PACKAGES}`);
    }
    const manifests = [];
    for (const pkg of enabledPackages) {
      const pluginRoot = path.join(this.managedDirectory, "plugins", pkg.id);
      const manifestPath = path.join(pluginRoot, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      manifests.push(PluginManifest.fromRoot(pluginRoot, pkg.id));
    }
    return new PluginCatalog(this.root, manifests, this.options);
  }
}

export function loadPluginRegistry(root = repoRoot(), options = {}) {
  return new PluginRuntime(root, options).loadCatalog();
}

export function enabledPluginSkillSourceDirs(root = repoRoot(), options = {}) {
  try {
    const registry = loadPluginRegistry(root, options);
    const dirs = new Set();
    for (const manifest of registry.manifests) {
      for (const skill of manifest.contributions.skills || []) {
        const declared = skill.path.endsWith("/SKILL.md")
          ? path.dirname(path.dirname(skill.path))
          : path.dirname(skill.path);
        dirs.add(path.join(manifest.root, declared));
      }
    }
    return [...dirs];
  } catch (_) {
    return [];
  }
}

export function loadPluginConfigDefaults(root = repoRoot()) {
  const registry = loadPluginRegistry(root);
  const schemas = [];
  const defaults = [];
  for (const manifest of registry.manifests) {
    const config = manifest.contributions.config;
    if (!config) continue;
    if (config.schema) schemas.push(readPluginJson(pluginMetadataPath(manifest.root, config.schema, "config schema"), manifest.root));
    if (config.defaults) defaults.push(readPluginJson(pluginMetadataPath(manifest.root, config.defaults, "config defaults"), manifest.root));
  }
  return { schemas, defaults };
}

export function discoverCorePresets() {
  const { PRESETS_DIR } = globalThis.__sennelPresetModule || {};
  if (!PRESETS_DIR) return [];
  return [];
}

function pluginSourcesDir(root) {
  return path.join(managedDir(root), "plugin-sources");
}

function installedPluginsDir(root) {
  return path.join(managedDir(root), "plugins");
}

export function isGitUrl(source) {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(source);
}

function runGit(cwd, args, context) {
  const result = runCmd("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  assertOk(result, context);
  return result.stdout.trim();
}

function localRepoHead(source) {
  const root = path.resolve(source);
  if (!fs.existsSync(root)) throw new Error(`plugin source not found: ${source}`);
  if (!fs.existsSync(path.join(root, ".git"))) {
    PluginManifest.fromRoot(root);
    validateSourceTree(root);
    return { root, commit: hashPackageTree(root), materialized: true };
  }
  runGit(root, ["rev-parse", "--is-inside-work-tree"], "plugin source must be a Git worktree");
  const status = runGit(root, ["status", "--porcelain"], "failed to inspect plugin source status");
  if (status.trim() !== "") throw new Error("dirty local plugin source rejected: commit or clean uncommitted changes first");
  const commit = runGit(root, ["rev-parse", "HEAD"], "plugin source must have HEAD");
  return { root, commit, materialized: false };
}

function checkedOutSourceRoot(root, source) {
  const location = sourceLocation(source);
  if (!isGitUrl(location)) return path.resolve(root, location);
  return path.join(pluginSourcesDir(root), source.id);
}

function assertManagedGitCachePath(root, dest, source) {
  assertId(source.id, "plugin source id");
  const rootPath = path.resolve(root);
  const stateDir = path.resolve(managedDir(root));
  const base = path.resolve(pluginSourcesDir(root));
  const resolved = path.resolve(dest);
  if (resolved === base || !isUnderPath(resolved, base)) {
    throw new Error(`unsafe plugin source cache path: ${dest}`);
  }
  if (fs.existsSync(stateDir)) {
    if (fs.lstatSync(stateDir).isSymbolicLink()) {
      throw new Error(`unsafe plugin source cache path: .sennel is a symlink`);
    }
    const realRoot = fs.realpathSync(rootPath);
    const realStateDir = fs.realpathSync(stateDir);
    if (!isUnderPath(realStateDir, realRoot)) {
      throw new Error(`unsafe plugin source cache path: .sennel escapes project root`);
    }
  }
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) {
    throw new Error(`unsafe plugin source cache path: plugin-sources is a symlink`);
  }
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) {
      throw new Error(`unsafe plugin source cache path: symlink not allowed: ${dest}`);
    }
    const realBase = fs.realpathSync(base);
    const realDest = fs.realpathSync(dest);
    if (!isUnderPath(realDest, realBase)) {
      throw new Error(`unsafe plugin source cache path: ${dest}`);
    }
  }
}

function hasConfinedGitMetadata(dest) {
  const gitPath = path.join(dest, ".git");
  if (!fs.existsSync(gitPath)) return false;
  const gitStat = fs.lstatSync(gitPath);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error(`unsafe plugin source cache path: .git must be a directory under ${dest}`);
  }
  const realDest = fs.realpathSync(dest);
  const realGit = fs.realpathSync(gitPath);
  if (!isUnderPath(realGit, realDest)) {
    throw new Error(`unsafe plugin source cache path: .git escapes cache root: ${dest}`);
  }
  const result = runCmd("git", ["rev-parse", "--show-toplevel"], { cwd: dest, maxBuffer: 10 * 1024 * 1024 });
  if (!result.ok) return false;
  let realTopLevel;
  try {
    realTopLevel = fs.realpathSync(result.stdout.trim());
  } catch (_) {
    return false;
  }
  if (!isUnderPath(realTopLevel, realDest)) {
    throw new Error(`unsafe plugin source cache path: Git worktree escapes cache root: ${dest}`);
  }
  if (realTopLevel !== realDest) return false;
  return true;
}

function cloneGitUrlSource(dest, source) {
  fs.rmSync(dest, { recursive: true, force: true });
  const result = runCmd("git", ["clone", sourceLocation(source), dest], { maxBuffer: 10 * 1024 * 1024 });
  if (!result.ok) throw new Error(`failed to clone ${maskPluginSource(sourceLocation(source))}: ${maskPluginSource(result.stderr || result.stdout)}`);
}

function fetchGitUrlSource(dest, source) {
  const result = runCmd("git", ["fetch", "--all", "--tags", "--force", "--prune"], { cwd: dest, maxBuffer: 10 * 1024 * 1024 });
  if (!result.ok) throw new Error(`failed to update ${maskPluginSource(sourceLocation(source))}: ${maskPluginSource(result.stderr || result.stdout)}`);
}

function hasGitUrlSourceRemote(dest, source) {
  const result = runCmd("git", ["remote", "get-url", "origin"], { cwd: dest, maxBuffer: 10 * 1024 * 1024 });
  return result.ok && result.stdout.trim() === sourceLocation(source);
}

function resolveGitCommit(cwd, ref, context) {
  return runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], context);
}

function resolveRemoteDefaultCommit(dest) {
  runGit(dest, ["remote", "set-head", "origin", "--auto"], "failed to resolve plugin remote default branch");
  const remoteHead = runGit(dest, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], "failed to read plugin remote default branch");
  return resolveGitCommit(dest, remoteHead, "failed to resolve plugin remote default branch commit");
}

function assertSafeGitRef(ref) {
  if (typeof ref !== "string" || ref.trim() === "" || ref.includes("\0") || ref.startsWith("-")) {
    throw new Error(`unsafe plugin source ref: ${ref}`);
  }
}

function tryResolveGitCommit(cwd, ref) {
  const result = runCmd("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, maxBuffer: 10 * 1024 * 1024 });
  return result.ok ? result.stdout.trim() : null;
}

function resolveGitRefCommit(dest, ref) {
  assertSafeGitRef(ref);
  if (SHA_RE.test(ref)) return resolveGitCommit(dest, ref, "failed to resolve plugin source SHA ref");
  const candidates = [
    `refs/remotes/origin/${ref}`,
    `refs/tags/${ref}`,
    ref,
  ];
  for (const candidate of candidates) {
    const commit = tryResolveGitCommit(dest, candidate);
    if (commit) return commit;
  }
  throw new Error(`failed to resolve plugin source ref: ${ref}`);
}

function resolveGitUrlSourceCommit(dest, source) {
  return source.ref ? resolveGitRefCommit(dest, source.ref) : resolveRemoteDefaultCommit(dest);
}

function cleanGitUrlSourceTree(dest, commit) {
  runGit(dest, ["reset", "--hard"], "failed to reset plugin source cache");
  runGit(dest, ["clean", "-fdx"], "failed to clean plugin source cache");
  runGit(dest, ["checkout", "--detach", commit], "failed to checkout plugin source commit");
  runGit(dest, ["reset", "--hard", commit], "failed to reset plugin source commit");
  runGit(dest, ["clean", "-fdx"], "failed to clean plugin source cache");
}

function syncGitUrlSource(root, source) {
  const dest = checkedOutSourceRoot(root, source);
  assertManagedGitCachePath(root, dest, source);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  assertManagedGitCachePath(root, dest, source);
  if (!hasConfinedGitMetadata(dest)) {
    cloneGitUrlSource(dest, source);
  } else if (!hasGitUrlSourceRemote(dest, source)) {
    cloneGitUrlSource(dest, source);
  }
  fetchGitUrlSource(dest, source);
  const commit = resolveGitUrlSourceCommit(dest, source);
  try {
    cleanGitUrlSourceTree(dest, commit);
    return { root: dest, commit, materialized: false };
  } catch (_) {
    cloneGitUrlSource(dest, source);
    fetchGitUrlSource(dest, source);
    const reclonedCommit = resolveGitUrlSourceCommit(dest, source);
    cleanGitUrlSourceTree(dest, reclonedCommit);
    return { root: dest, commit: reclonedCommit, materialized: false };
  }
}

export class PluginSourceStore {
  constructor(root) {
    if (typeof root !== "string" || root.trim() === "") throw new Error("plugin source store root is required");
    this.root = path.resolve(root);
  }

  resolve(source) {
    if (source.type === "npm") throw new Error(`unsupported plugin source type: npm (${source.id})`);
    const location = sourceLocation(source);
    if (!location) throw new Error(`plugin source ${source.id} has no location`);
    return isGitUrl(location)
      ? syncGitUrlSource(this.root, source)
      : localRepoHead(path.resolve(this.root, location));
  }
}

function resolveSource(root, source) {
  return new PluginSourceStore(root).resolve(source);
}

function nextSourceId(config, source) {
  const base = path.basename(String(source).replace(/\.git$/, "")) || "plugin-source";
  const safeBase = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin-source";
  const existing = new Set(config.plugin.sources.map((entry) => entry.id));
  let id = safeBase;
  let n = 2;
  while (existing.has(id)) id = `${safeBase}-${n++}`;
  return id;
}

export function addPluginRepo(root, source, ref) {
  const config = readProjectConfig(root);
  const id = nextSourceId(config, source);
  const entry = isGitUrl(source) ? { id, type: "git", url: source } : { id, type: "local", path: source };
  if (ref) entry.ref = ref;
  const resolved = resolveSource(root, entry);
  readPluginJson(path.join(resolved.root, "plugin.json"), resolved.root);
  config.plugin.sources.push(entry);
  writeProjectConfig(root, config);
  return { id, source: maskPluginSource(source), commit: resolved.commit };
}

export function updatePluginRepos(root) {
  const config = readProjectConfig(root);
  const results = [];
  for (const source of config.plugin.sources) {
    const resolved = resolveSource(root, source);
    results.push({ id: source.id, source: maskPluginSource(sourceLocation(source)), commit: resolved.commit });
  }
  return results;
}

export function findPluginCandidates(root) {
  const config = readProjectConfig(root);
  const results = [];
  for (const source of config.plugin.sources) {
    const resolved = resolveSource(root, source);
    const manifest = PluginManifest.fromRoot(resolved.root);
    results.push({ id: manifest.name, type: manifest.type, source: source.id, sourceLocation: maskPluginSource(sourceLocation(source)), commit: resolved.commit });
  }
  return results;
}

function materializeCommit(sourceRoot, commit, root) {
  const tmp = fs.mkdtempSync(path.join(managedDir(root), "tmp-plugin-"));
  const archivePath = path.join(tmp, "package.tar");
  const archive = runCmd("git", ["archive", "--format=tar", "-o", archivePath, commit], { cwd: sourceRoot, maxBuffer: 50 * 1024 * 1024 });
  if (!archive.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`failed to archive plugin package: ${archive.stderr || archive.stdout}`);
  }
  const packageRoot = path.join(tmp, "package");
  fs.mkdirSync(packageRoot, { recursive: true });
  const tar = runCmd("tar", ["-xf", archivePath, "-C", packageRoot], { maxBuffer: 50 * 1024 * 1024 });
  if (!tar.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`failed to extract plugin package: ${tar.stderr || tar.stdout}`);
  }
  return { tmp, packageRoot };
}

function hashPackageTree(sourceRoot) {
  const hash = crypto.createHash("sha1");
  for (const entry of existingKnownPluginPaths(sourceRoot).sort()) {
    for (const file of walkFiles(sourceRoot, normalizeRel(entry, "files entry")).sort()) {
      hash.update(file);
      hash.update("\0");
      hash.update(fs.readFileSync(path.join(sourceRoot, file)));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function existingKnownPluginPaths(sourceRoot) {
  return KNOWN_PLUGIN_PACKAGE_PATHS.filter((entry) => fs.existsSync(path.join(sourceRoot, entry.replace(/\/$/, ""))));
}

function copyAllowlistedFiles(sourceRoot, destRoot, files) {
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  let copied = 0;
  for (const entry of files) {
    const rel = normalizeRel(entry, "files entry");
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) throw new Error(`unsafe files entry missing: ${rel}`);
    for (const file of walkFiles(sourceRoot, rel)) {
      copied += 1;
      if (copied > MAX_PLUGIN_COPY_FILES) throw new Error(`unsafe package: copied file count exceeds ${MAX_PLUGIN_COPY_FILES}`);
      const dest = path.join(destRoot, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, file), dest);
    }
  }
}

function validateSourceTree(sourceRoot) {
  validatePackageJson(sourceRoot);
  for (const entry of existingKnownPluginPaths(sourceRoot)) walkFiles(sourceRoot, normalizeRel(entry, "files entry"));
}

function preparePluginConfigTransaction(root, source, pluginId, commit, {
  updateExisting,
  publicConfig: proposedPublicConfig,
  localConfig: proposedLocalConfig,
} = {}) {
  const configs = new PluginConfigSet(root, {
    publicConfig: proposedPublicConfig,
    localConfig: proposedLocalConfig,
  });
  const {
    publicConfig,
    localConfig,
    publicPlugin,
    localPlugin,
  } = configs;
  const publicExisting = publicPlugin.packages.find((pkg) => pkg.id === pluginId);
  const localExisting = localPlugin.packages.find((pkg) => pkg.id === pluginId);
  const publicHasSource = publicPlugin.sources.some((entry) => entry.id === source.id);
  const localHasSource = localPlugin.sources.some((entry) => entry.id === source.id);
  const target = publicExisting || (!localExisting && publicHasSource)
    ? { config: publicConfig, plugin: publicPlugin, existing: publicExisting, path: managedConfigPath(root) }
    : localExisting || localHasSource
      ? { config: localConfig, plugin: localPlugin, existing: localExisting, path: managedLocalConfigPath(root) }
      : null;
  if (!target) throw new Error(`plugin source is not registered in public or local config: ${source.id}`);

  const entry = { id: pluginId, source: source.id, commit };
  if (source.ref) entry.ref = source.ref;
  if (target.existing) {
    if (!updateExisting && target.existing.enabled === false) entry.enabled = false;
    Object.assign(target.existing, entry);
  } else {
    target.plugin.packages.push(entry);
  }
  const updates = [{ filePath: target.path, value: target.config }];
  if (proposedPublicConfig && target.path !== managedConfigPath(root)) {
    updates.push({ filePath: managedConfigPath(root), value: publicConfig });
  }
  if (proposedLocalConfig && target.path !== managedLocalConfigPath(root)) {
    updates.push({ filePath: managedLocalConfigPath(root), value: localConfig });
  }
  return new PluginConfigTransaction(updates);
}

function installFromSource(root, source, sourceRoot, commit, {
  updateExisting = false,
  sourceMaterialized = false,
  publicConfig,
  localConfig,
  faultInjector = () => {},
} = {}) {
  validateSourceTree(sourceRoot);
  const materialized = sourceMaterialized ? null : materializeCommit(sourceRoot, commit, root);
  try {
    const packageRoot = materialized?.packageRoot || sourceRoot;
    const manifest = PluginManifest.fromRoot(packageRoot);
    validateSourceTree(packageRoot);
    const configTransaction = preparePluginConfigTransaction(
      root,
      source,
      manifest.name,
      commit,
      { updateExisting, publicConfig, localConfig },
    );
    return new PluginInstaller().install(new PluginInstallation({
      root,
      pluginId: manifest.name,
      stagePackage(staging) {
        copyAllowlistedFiles(packageRoot, staging, existingKnownPluginPaths(packageRoot));
      },
      validateStaging(staging) {
        validateSourceTree(staging);
        const stagedManifest = PluginManifest.fromRoot(staging, manifest.name);
        if (stagedManifest.name !== manifest.name) {
          throw new Error(`staged plugin mismatch: expected ${manifest.name}, got ${stagedManifest.name}`);
        }
      },
      readInstalled(destination) {
        return PluginManifest.fromRoot(destination, manifest.name);
      },
      configTransaction,
      faultInjector,
    }));
  } finally {
    if (materialized) fs.rmSync(materialized.tmp, { recursive: true, force: true });
  }
}

export function installPlugin(root, id, { faultInjector = () => {} } = {}) {
  const config = readPluginOperationConfig(root);
  for (const source of config.plugin.sources) {
    const resolved = resolveSource(root, source);
    const manifest = PluginManifest.fromRoot(resolved.root);
    if (manifest.name === id) {
      installFromSource(root, source, resolved.root, resolved.commit, {
        sourceMaterialized: resolved.materialized,
        faultInjector,
      });
      return { id, source: source.id, commit: resolved.commit };
    }
  }
  throw new Error(`plugin not found: ${id}`);
}

class InstalledPluginUpdateEntry {
  constructor(pkg, source, resolved) {
    this.id = pkg.id;
    this.sourceId = source.id;
    this.source = source;
    this.sourceRoot = resolved.root;
    this.sourceMaterialized = resolved.materialized;
    this.previousCommit = pkg.commit;
    this.commit = resolved.commit;
    if (!SHA_RE.test(this.commit)) throw new Error(`plugin package ${pkg.id} must have a pinned commit`);
  }

  get updated() {
    return this.previousCommit !== this.commit;
  }

  toResult() {
    return {
      id: this.id,
      source: this.sourceId,
      commit: this.commit,
      previousCommit: this.previousCommit,
      updated: this.updated,
    };
  }

  apply(root, { faultInjector = () => {} } = {}) {
    installFromSource(root, this.source, this.sourceRoot, this.commit, {
      updateExisting: true,
      sourceMaterialized: this.sourceMaterialized,
      faultInjector,
    });
  }
}

class InstalledPluginUpdatePlan {
  constructor(entries) {
    this.entries = entries;
  }

  get hasUpdates() {
    return this.entries.some((entry) => entry.updated);
  }

  toResults() {
    return this.entries.map((entry) => entry.toResult());
  }

  apply(root, options = {}) {
    for (const entry of this.entries) entry.apply(root, options);
    return this.toResults();
  }
}

function enabledInstalledPackages(config) {
  const packages = config.plugin.packages.filter((pkg) => pkg.enabled !== false);
  if (packages.length > MAX_ENABLED_PLUGIN_PACKAGES) throw new Error(`enabled plugin packages exceed ${MAX_ENABLED_PLUGIN_PACKAGES}`);
  return packages;
}

function resolveInstalledPluginUpdate(root, sources, pkg) {
  const source = sources.get(pkg.source);
  if (!source) throw new Error(`plugin source not found for package ${pkg.id}: ${pkg.source}`);
  const resolved = resolveSource(root, source);
  const manifest = PluginManifest.fromRoot(resolved.root);
  if (manifest.name !== pkg.id) throw new Error(`plugin source ${source.id} resolved ${manifest.name}, expected ${pkg.id}`);
  return new InstalledPluginUpdateEntry(pkg, source, resolved);
}

export function planInstalledPluginUpdates(root) {
  const config = readPluginOperationConfig(root);
  const sources = new Map(config.plugin.sources.map((source) => [source.id, source]));
  return new InstalledPluginUpdatePlan(
    enabledInstalledPackages(config).map((pkg) => resolveInstalledPluginUpdate(root, sources, pkg)),
  );
}

export function updateInstalledPlugin(root, id, { faultInjector = () => {} } = {}) {
  const config = readPluginOperationConfig(root);
  const pkg = config.plugin.packages.find((entry) => entry.id === id);
  if (!pkg) throw new Error(`installed plugin not found: ${id}`);
  const sources = new Map(config.plugin.sources.map((source) => [source.id, source]));
  const entry = resolveInstalledPluginUpdate(root, sources, pkg);
  entry.apply(root, { faultInjector });
  return entry.toResult();
}

export function syncInstalledPlugins(root, { update = false, faultInjector = () => {} } = {}) {
  const config = readPluginOperationConfig(root);
  const sources = new Map(config.plugin.sources.map((source) => [source.id, source]));
  const results = [];
  for (const pkg of enabledInstalledPackages(config)) {
    const source = sources.get(pkg.source);
    if (!source) throw new Error(`plugin source not found for package ${pkg.id}: ${pkg.source}`);
    const resolved = update || source.type === "local"
      ? resolveSource(root, source)
      : { root: checkedOutSourceRoot(root, source), commit: pkg.commit, materialized: false };
    if (!fs.existsSync(path.join(resolved.root, "plugin.json"))) Object.assign(resolved, resolveSource(root, source));
    const previousCommit = pkg.commit;
    const commit = update ? resolved.commit : pkg.commit;
    if (!SHA_RE.test(commit)) throw new Error(`plugin package ${pkg.id} must have a pinned commit`);
    installFromSource(root, source, resolved.root, commit, {
      updateExisting: update,
      sourceMaterialized: resolved.materialized,
      faultInjector,
    });
    const result = { id: pkg.id, source: source.id, commit };
    if (update) {
      result.previousCommit = previousCommit;
      result.updated = previousCommit !== commit;
    }
    results.push(result);
  }
  return results;
}

export function listInstalledPlugins(root) {
  const config = readProjectConfig(root);
  const registry = loadPluginRegistry(root);
  return config.plugin.packages.map((pkg) => ({
    id: pkg.id,
    source: pkg.source,
    commit: pkg.commit,
    status: pkg.enabled === false ? "disabled" : "enabled",
    valid: Boolean(registry.manifests.find((manifest) => manifest.providerId === pkg.id)),
  }));
}

export function setPluginEnabled(root, id, enabled) {
  const config = readStoredProjectConfig(root);
  const entry = config.plugin.packages.find((pkg) => pkg.id === id);
  if (!entry) {
    const merged = readProjectConfig(root);
    if (merged.plugin.packages.find((pkg) => pkg.id === id)) {
      throw new Error(`plugin package ${id} is provided by .sennel/config.local.json; edit the local overlay to enable or disable it`);
    }
    throw new Error(`plugin not installed: ${id}`);
  }
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  writeProjectConfig(root, config);
  return entry;
}

export async function resolvePluginPackageSources(root = repoRoot()) {
  const config = readProjectConfig(root);
  const sources = new Map(config.plugin.sources.map((source) => [source.id, source]));
  return config.plugin.packages.map((pkg) => {
    const source = sources.get(pkg.source);
    if (!source) throw new Error(`plugin package ${pkg.id} references unknown source ${pkg.source}`);
    return { ...pkg, source, sourceLocation: sourceLocation(source) };
  });
}

export class FlowCommandHook {}

const FLOW_COMMAND_HOOK_FAILURE_POLICIES = new Set(["required", "advisory"]);

export class FlowCommandHookFailurePolicy {
  constructor(value, label = "plugin hook failure policy") {
    if (!FLOW_COMMAND_HOOK_FAILURE_POLICIES.has(value)) {
      throw new Error(`${label} must be required or advisory: ${value ?? "missing"}`);
    }
    this.value = value;
    Object.freeze(this);
  }

  get isRequired() { return this.value === "required"; }
}

export class FlowCommandHookExecutionOutcome {
  constructor({ kind, policy = null, failure = null } = {}) {
    if (!["success", "business-failure", "integrity-failure"].includes(kind)) throw new Error(`unknown flow command hook outcome: ${kind}`);
    if (kind === "business-failure") this.policy = new FlowCommandHookFailurePolicy(policy).value;
    else if (policy != null) throw new Error("successful flow command hook outcome cannot carry a failure policy");
    else this.policy = null;
    this.kind = kind;
    this.failure = failure;
    Object.freeze(this);
  }

  get isRequiredFailure() { return this.kind === "business-failure" && this.policy === "required"; }
}

export class FlowCommandHookIntegrityError extends Error {
  constructor(error) {
    super(error.message, { cause: error });
    this.name = "FlowCommandHookIntegrityError";
    this.outcome = new FlowCommandHookExecutionOutcome({ kind: "integrity-failure", failure: { message: error.message } });
  }
}

function buildPluginApi() {
  return {
    Envelope: {
      ok: (type = "plugin", key = "plugin", data = {}) => Envelope.ok(type, key, data).toJSON(),
      fail: (type = "plugin", key = "plugin", code = "PLUGIN_FAILED", messages = "plugin failed", data = null) => Envelope.fail(type, key, code, messages, data).toJSON(),
    },
    FlowCommandHook,
  };
}

function validateHookClass(HookClass, label) {
  if (typeof HookClass !== "function" || !HookClass.name) throw new Error(`plugin hook ${label} must return a named hook class`);
  if (!(HookClass.prototype instanceof FlowCommandHook)) throw new Error(`plugin hook ${label} must extend FlowCommandHook`);
  if (!FLOW_COMMANDS.has(HookClass.command)) throw new Error(`plugin hook ${label} has unknown command: ${HookClass.command}`);
  if (!FLOW_COMMAND_HOOKS.has(HookClass.hook)) throw new Error(`plugin hook ${label} has unknown hook: ${HookClass.hook}`);
  if (!Number.isInteger(Number(HookClass.priority || 0))) throw new Error(`plugin hook ${label} priority must be an integer`);
  return new FlowCommandHookFailurePolicy(
    HookClass.failurePolicy,
    `plugin hook ${label} failure policy`,
  );
}

function hookModuleCacheKey(modulePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex");
}

export async function discoverFlowCommandHooks(root = repoRoot()) {
  // Hooks are project configuration, never a hidden requirement of the
  // Version Store.  A config-less in-memory/runtime fixture therefore has no
  // installed plugins to discover; configured projects still re-resolve on
  // every command so enable/disable changes take effect immediately.
  if (!fs.existsSync(path.join(managedDir(root), "config.json"))) return [];
  const config = readProjectConfig(root);
  const enabledPackages = config.plugin.packages.filter((pkg) => pkg.enabled !== false);
  if (enabledPackages.length > MAX_ENABLED_PLUGIN_PACKAGES) throw new Error(`enabled plugin packages exceed ${MAX_ENABLED_PLUGIN_PACKAGES}`);
  const plans = [];
  for (const pkg of enabledPackages) {
    const pluginRoot = path.join(managedDir(root), "plugins", pkg.id);
    const hooksDir = path.join(pluginRoot, "hooks");
    if (!fs.existsSync(hooksDir)) continue;
    const files = fs.readdirSync(hooksDir).filter((file) => file.endsWith(".js")).sort();
    if (files.length > MAX_PLUGIN_HOOK_FILES) throw new Error(`plugin ${pkg.id} hook files exceed ${MAX_PLUGIN_HOOK_FILES}`);
    for (const file of files) {
      const rel = normalizeRel(`hooks/${file}`, "hook module");
      assertNoCoreInternalImports(root, pkg.id, pluginRoot, rel);
      const modulePath = path.join(pluginRoot, rel);
      const mod = await new EsmModule(modulePath, { cacheKey: hookModuleCacheKey(modulePath) }).import();
      if (typeof mod.default !== "function" || mod.default.name !== "register") throw new Error(`plugin hook ${pkg.id}/${rel} must export named default function register(api)`);
      const HookClass = mod.default(buildPluginApi());
      if (Array.isArray(HookClass)) throw new Error(`plugin hook ${pkg.id}/${rel} must return one hook class per file`);
      const failurePolicy = validateHookClass(HookClass, `${pkg.id}/${rel}`);
      plans.push({
        apiVersion: 1,
        pluginId: pkg.id,
        module: rel,
        className: HookClass.name,
        command: HookClass.command,
        hook: HookClass.hook,
        priority: Number(HookClass.priority || 0),
        failurePolicy: failurePolicy.value,
      });
    }
  }
  return plans.sort((a, b) => a.priority - b.priority || a.pluginId.localeCompare(b.pluginId) || a.module.localeCompare(b.module));
}

function pluginConfigFor(root, pluginId) {
  try {
    return loadConfig(root).plugin?.config?.[pluginId] || {};
  } catch (_) {
    try {
      return readProjectConfig(root).plugin.config?.[pluginId] || {};
    } catch (_) {
      return {};
    }
  }
}

function artifactRoot(root, pluginId, flow = {}, {
  requireSpec = false,
  artifactRepositoryRoot = root,
} = {}) {
  if (flow?.specId) {
    const specId = normalizeRel(String(flow.specId), "flow spec id");
    if (specId.includes("/") || specId.includes("\\")) {
      throw new Error(`flow spec id must be a single directory name: ${flow.specId}`);
    }
    const specRoot = normalizeRel(String(flow.specRoot || DEFAULT_FLOW_SPEC_DIR), "flow spec root");
    return new FlowSpecLocation({
      repositoryRoot: path.resolve(artifactRepositoryRoot),
      specRoot,
      specId,
    }).artifact("plugin-artifacts", pluginId);
  }
  if (requireSpec) {
    throw new Error(`plugin hook artifact context requires flow.specId for ${pluginId}`);
  }
  return path.join(managedDir(artifactRepositoryRoot), "plugin-artifacts", pluginId);
}

export class FlowPluginArtifactCollection {
  constructor(pluginId, { reader = null } = {}) {
    this.pluginId = normalizeRel(pluginId, "plugin id");
    if (this.pluginId.includes("/")) throw new Error("plugin id must be a single path segment");
    if (reader !== null && typeof reader !== "function") throw new TypeError("plugin artifact reader must be a function");
    this.reader = reader;
    this.entries = new Map();
  }
  #key(relativePath) {
    return `${this.pluginId}/${normalizeRel(relativePath, "plugin artifact path")}`;
  }
  async readJson(relativePath, fallback = null) {
    const key = this.#key(relativePath);
    const buffered = this.entries.get(key);
    if (buffered !== undefined) return JSON.parse(buffered.bytes.toString("utf8"));
    if (this.reader === null) return fallback;
    const artifact = await this.reader({
      logicalKey: "plugin.lifecycle.artifact",
      parameters: { pluginArtifactPath: key },
      optional: true,
    });
    if (artifact === null) return fallback;
    const bytes = Buffer.isBuffer(artifact) ? artifact : artifact.bytes;
    return JSON.parse(bytes.toString("utf8"));
  }
  writeJson(relativePath, value) {
    this.#write(relativePath, "application/json", Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
  }
  writeText(relativePath, value) {
    this.#write(relativePath, "text/plain", Buffer.from(String(value), "utf8"));
  }
  #write(relativePath, mediaType, bytes) {
    const key = this.#key(relativePath);
    this.entries.set(key, Object.freeze({
      logicalKey: "plugin.lifecycle.artifact",
      parameters: Object.freeze({ pluginArtifactPath: key }),
      mediaType,
      bytes: Buffer.from(bytes),
    }));
  }
  writes() {
    return Object.freeze([...this.entries.values()]);
  }
}

function artifactHelpers(root, pluginId, flow = {}, options = {}) {
  if (options.collection instanceof FlowPluginArtifactCollection) {
    return {
      readJson: (relativePath, fallback = null) => options.collection.readJson(relativePath, fallback),
      writeJson: async (relativePath, value) => options.collection.writeJson(relativePath, value),
      writeText: async (relativePath, value) => options.collection.writeText(relativePath, value),
    };
  }
  const dir = artifactRoot(root, pluginId, flow, options);
  return {
    async readJson(rel, fallback = null) {
      const file = path.join(dir, normalizeRel(rel, "artifact path"));
      if (!fs.existsSync(file)) return fallback;
      return readJson(file);
    },
    async writeJson(rel, value) {
      writeJson(path.join(dir, normalizeRel(rel, "artifact path")), value);
    },
    async writeText(rel, value) {
      const file = path.join(dir, normalizeRel(rel, "artifact path"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(value), "utf8");
    },
  };
}

function buildPluginContext({
  root,
  artifactRepositoryRoot = root,
  pluginId,
  pluginRoot,
  commandPath,
  flow = {},
  result = {},
  requireSpecArtifacts = false,
  flowAttribution = "ambient",
  artifactCollection = null,
}) {
  const rootConfig = readProjectConfig(root);
  const pluginConfig = pluginConfigFor(root, pluginId);
  const coreAgent = globalThis.__sennelPluginAgent || {
    resolve() {
      return false;
    },
    async call() {
      throw new Error("plugin agent context is not configured for this invocation");
    },
  };
  const agent = createPluginAgentApi({
    pluginId,
    pluginConfig,
    agent: coreAgent,
    flowAttribution,
  });
  return {
    project: { root },
    plugin: { id: pluginId, root: pluginRoot, commandPath },
    config: pluginConfig,
    rootConfig: { lang: rootConfig.lang || "en" },
    agent,
    flow,
    result,
    artifacts: artifactHelpers(root, pluginId, flow, {
      requireSpec: requireSpecArtifacts,
      artifactRepositoryRoot,
      collection: artifactCollection,
    }),
    envelope: buildPluginApi().Envelope,
  };
}

export async function dispatchPluginCommand(root, commandName, args) {
  const registry = loadPluginRegistry(root);
  const command = registry.resolveCommand(commandName);
  if (!command) return false;
  try {
    const mod = await new EsmModule(command.absolutePath).import();
    if (typeof mod.default !== "function") throw new Error(`plugin command ${commandName} must export default register(api)`);
    const registered = mod.default(buildPluginApi());
    if (!registered || typeof registered.main !== "function") throw new Error(`plugin command ${commandName} register(api) must return { main }`);
    const pluginRoot = path.dirname(path.dirname(command.absolutePath));
    const result = await registered.main(args, buildPluginContext({
      root,
      pluginId: command.providerId,
      pluginRoot,
      commandPath: command.absolutePath,
      flowAttribution: "none",
    }));
    if (!isEnvelopeLike(result)) throw new Error(`plugin command ${commandName} must return an Envelope-compatible object`);
    return { ...result, exitCode: result.ok ? 0 : (result.exitCode || 1) };
  } catch (err) {
    return { ok: false, type: "plugin", key: commandName, data: null, exitCode: 1, errors: [{ level: "fatal", code: err.code || "PLUGIN_COMMAND_FAILED", messages: [err.message] }] };
  }
}

function configuredPluginRoot(root, plan) {
  const config = readProjectConfig(root);
  const pkg = config.plugin.packages.find((entry) => entry.id === plan.pluginId);
  if (!pkg) throw new Error(`configured plugin missing: ${plan.pluginId}`);
  if (pkg.enabled === false) throw new Error(`configured plugin disabled: ${plan.pluginId}`);
  const pluginRoot = path.join(managedDir(root), "plugins", plan.pluginId);
  if (!fs.existsSync(pluginRoot)) throw new Error(`configured plugin package is absent: ${plan.pluginId}`);
  return pluginRoot;
}

function assertCurrentHookMetadata(plan, HookClass) {
  const comparisons = [
    ["className", plan.className, HookClass.name],
    ["command", plan.command, HookClass.command],
    ["hook", plan.hook, HookClass.hook],
    ["priority", Number(plan.priority || 0), Number(HookClass.priority || 0)],
  ];
  for (const [field, expected, actual] of comparisons) {
    if (expected !== actual) {
      throw new Error(`plugin hook changed between discovery and execution for ${plan.pluginId}/${plan.module}: expected ${field} ${expected}, got ${actual}`);
    }
  }
}

async function loadHookClass(root, plan) {
  const pluginRoot = configuredPluginRoot(root, plan);
  const rel = normalizeRel(plan.module, "hook module");
  const modulePath = path.join(pluginRoot, rel);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`configured hook module is absent: ${plan.pluginId}/${rel}`);
  }
  assertNoCoreInternalImports(root, plan.pluginId, pluginRoot, rel);
  const mod = await new EsmModule(modulePath, { cacheKey: hookModuleCacheKey(modulePath) }).import();
  if (typeof mod.default !== "function" || mod.default.name !== "register") {
    throw new Error(`plugin hook ${plan.pluginId}/${rel} must export named default function register(api)`);
  }
  const HookClass = mod.default(buildPluginApi());
  validateHookClass(HookClass, `${plan.pluginId}/${plan.module}`);
  assertCurrentHookMetadata({ ...plan, module: rel }, HookClass);
  return { HookClass, pluginRoot };
}

function isEnvelopeLike(value) {
  return value && typeof value === "object" && typeof value.ok === "boolean" && Array.isArray(value.errors);
}

export async function runFlowCommandHooks(root, plans, {
  command,
  hook,
  flow = {},
  result = {},
  artifactRepositoryRoot = root,
  artifactReader = null,
} = {}) {
  const warnings = [];
  const issueLogEntries = [];
  const hookData = [];
  const followUps = [];
  const artifactCollections = new Map();
  let outcome = new FlowCommandHookExecutionOutcome({ kind: "success" });
  for (const plan of plans.filter((entry) => entry.command === command && entry.hook === hook).sort((a, b) => a.priority - b.priority)) {
    let loaded;
    try {
      loaded = await loadHookClass(root, plan);
    } catch (error) {
      throw new FlowCommandHookIntegrityError(error);
    }
    const { HookClass, pluginRoot } = loaded;
    let artifactCollection = artifactCollections.get(plan.pluginId);
    if (artifactCollection === undefined) {
      artifactCollection = new FlowPluginArtifactCollection(plan.pluginId, { reader: artifactReader });
      artifactCollections.set(plan.pluginId, artifactCollection);
    }
    const context = buildPluginContext({
      root,
      artifactRepositoryRoot,
      pluginId: plan.pluginId,
      pluginRoot,
      flow,
      result,
      requireSpecArtifacts: true,
      artifactCollection,
    });
    try {
      const instance = new HookClass();
      const hookResult = await instance.run(context);
      if (!isEnvelopeLike(hookResult)) throw new Error("plugin hook must return an Envelope-compatible result");
      if (hookResult?.data) {
        hookData.push({ pluginId: plan.pluginId, command, hook, data: hookResult.data });
        if (Array.isArray(hookResult.data.warnings)) {
          warnings.push(...hookResult.data.warnings.map((warning) => ({ pluginId: plan.pluginId, command, hook, ...warning })));
        }
        if (Array.isArray(hookResult.data.followUps)) {
          followUps.push(...hookResult.data.followUps.map((text) => ({ pluginId: plan.pluginId, command, hook, text })));
        }
      }
      if (hookResult.ok === false) throw new Error(hookResult.errors?.[0]?.messages?.join(" ") || "plugin hook returned ok:false");
    } catch (err) {
      const warning = { code: "PLUGIN_HOOK_FAILED", pluginId: plan.pluginId, command, hook, message: err.message };
      const failure = new FlowCommandHookExecutionOutcome({ kind: "business-failure", policy: plan.failurePolicy, failure: warning });
      if (failure.isRequiredFailure) {
        return { ok: false, outcome: failure, warnings, issueLogEntries, hookData, followUps };
      }
      outcome = failure;
      warnings.push(warning);
      issueLogEntries.push({ pluginId: plan.pluginId, reason: `plugin hook ${command}.${hook} failed: ${err.message}`, payload: warning });
    }
  }
  return {
    ok: true,
    outcome,
    warnings,
    issueLogEntries,
    hookData,
    followUps,
    artifactWrites: Object.freeze([...artifactCollections.values()].flatMap((collection) => collection.writes())),
  };
}

export async function runFlowCommandWithPluginLifecycle(root, plans, {
  command,
  main,
  flow = {},
  artifactRepositoryRoot = root,
  artifactReader = null,
} = {}) {
  const pre = await runFlowCommandHooks(root, plans, {
    command,
    hook: "pre",
    flow,
    result: {},
    artifactRepositoryRoot,
    artifactReader,
  });
  if (!pre.ok) return pluginLifecycleFailure(pre, null);
  const result = await main();
  const post = await runFlowCommandHooks(root, plans, {
    command,
    hook: "post",
    flow,
    result,
    artifactRepositoryRoot,
    artifactReader,
  });
  if (!post.ok) return pluginLifecycleFailure(post, result, pre);
  return composePluginLifecycleResult(result, pre, post, result?.ok !== false);
}

function pluginLifecycleFailure(failure, result, pre = null) {
  return composePluginLifecycleResult(result, pre, failure, false);
}

function composePluginLifecycleResult(result, pre, terminal, ok) {
  return {
    ok,
    outcome: terminal.outcome.kind === "business-failure" ? terminal.outcome : pre?.outcome || terminal.outcome,
    data: {
      ...(result?.data || {}),
      pluginHooks: [...(pre?.hookData || []), ...terminal.hookData],
      followUps: [...(pre?.followUps || []), ...terminal.followUps],
      pluginArtifactWrites: [...(pre?.artifactWrites || []), ...(terminal.artifactWrites || [])],
    },
    warnings: [...(pre?.warnings || []), ...terminal.warnings],
    issueLogEntries: [...(pre?.issueLogEntries || []), ...terminal.issueLogEntries],
  };
}

const DEFAULT_OFFICIAL_PRESET_SOURCE = Object.freeze({
  id: "official-presets",
  type: "git",
  remote: `git@github.com:${PRODUCT.officialPresetsRepository}.git`,
});

function cloneOfficialPresetSource(source = DEFAULT_OFFICIAL_PRESET_SOURCE) {
  const value = source || DEFAULT_OFFICIAL_PRESET_SOURCE;
  return { ...value, id: value.id || DEFAULT_OFFICIAL_PRESET_SOURCE.id };
}

function officialPresetSourceFromRoot(sourceRoot) {
  if (!sourceRoot) return null;
  const source = {
    id: DEFAULT_OFFICIAL_PRESET_SOURCE.id,
    type: isGitUrl(sourceRoot) ? "git" : "local",
  };
  if (source.type === "git") source.url = sourceRoot;
  else source.path = sourceRoot;
  return source;
}

function assertOfficialPresetManifest(sourceRoot) {
  const manifest = PluginManifest.fromRoot(sourceRoot, DEFAULT_OFFICIAL_PRESET_SOURCE.id);
  if (manifest.name !== DEFAULT_OFFICIAL_PRESET_SOURCE.id) {
    throw new Error(`official package mismatch: expected ${DEFAULT_OFFICIAL_PRESET_SOURCE.id}, got ${manifest.name}`);
  }
  return manifest;
}

export function resolveSetupOfficialPresetSource(root, { defaultOfficialPresetSource } = {}) {
  const overrideRoot = officialPresetPluginRoot();
  const source = overrideRoot
    ? officialPresetSourceFromRoot(overrideRoot)
    : cloneOfficialPresetSource(defaultOfficialPresetSource);
  try {
    const resolved = resolveSource(root, source);
    assertOfficialPresetManifest(resolved.root);
    return { source, root: resolved.root, commit: resolved.commit, materialized: resolved.materialized };
  } catch (cause) {
    const location = sourceLocation(source) || source.id;
    throw new Error(`official preset source cannot be resolved: ${maskPluginSource(location)}`, { cause });
  }
}

export function officialPresetContributionKeys(sourceRoot) {
  if (!sourceRoot) throw new Error("official preset source cannot be resolved");
  if (!fs.existsSync(sourceRoot)) throw new Error(`official preset source not found: ${sourceRoot}`);
  const manifest = assertOfficialPresetManifest(sourceRoot);
  return new Set(manifest.presetEntries().map((preset) => preset.key));
}

function materializationSource(source, sourceRoot) {
  if (!sourceRoot) return source;
  if (!fs.existsSync(sourceRoot)) throw new Error(`plugin source not found: ${sourceRoot}`);
  const locationKey = isGitUrl(sourceRoot) ? "url" : "path";
  const next = { ...source, type: isGitUrl(sourceRoot) ? "git" : "local" };
  delete next.path;
  delete next.url;
  delete next.remote;
  next[locationKey] = sourceRoot;
  return next;
}

export function ensureOfficialPackage(root, { id, sourceRoot, ref, faultInjector = () => {} } = {}) {
  const configs = new PluginConfigSet(root);
  if (configs.sources.length > MAX_PLUGIN_SOURCES) {
    throw new Error(`plugin source search exceeds ${MAX_PLUGIN_SOURCES} sources`);
  }
  let source = configs.findSource((entry) => (
    sourceLocation(entry) === sourceRoot || entry.id === id || entry.id === `official-${id}`
  ));
  if (!source) {
    if (configs.sources.length >= MAX_PLUGIN_SOURCES) {
      throw new Error(`plugin source search exceeds ${MAX_PLUGIN_SOURCES} sources`);
    }
    source = id === DEFAULT_OFFICIAL_PRESET_SOURCE.id
      ? { ...DEFAULT_OFFICIAL_PRESET_SOURCE }
      : { id: `official-${id}`, type: "local", path: sourceRoot };
    if (ref) source.ref = ref;
    configs.publicPlugin.sources.push(source);
  }
  const materializedSource = materializationSource(source, sourceRoot);
  const resolved = resolveSource(root, materializedSource);
  const sourceManifest = PluginManifest.fromRoot(resolved.root);
  if (sourceManifest.name !== id) throw new Error(`official package mismatch: expected ${id}, got ${sourceManifest.name}`);
  installFromSource(root, source, resolved.root, resolved.commit, {
    updateExisting: true,
    sourceMaterialized: resolved.materialized,
    publicConfig: configs.publicConfig,
    localConfig: configs.localConfig,
    faultInjector,
  });
}

export function ensureSetupOfficialPresetState(root, {
  selectedTypes = [],
  officialPresetRoot,
  officialPresetSource,
  faultInjector = () => {},
} = {}) {
  const typeList = (Array.isArray(selectedTypes) ? selectedTypes : [selectedTypes]).filter(Boolean);
  const nonBaseTypes = typeList.filter((type) => type !== "base");
  if (nonBaseTypes.length === 0) return { changed: false, installed: false };

  let resolvedOfficial = null;
  let sourceForOfficial = officialPresetSource ? cloneOfficialPresetSource(officialPresetSource) : null;
  if (!officialPresetRoot) {
    resolvedOfficial = resolveSetupOfficialPresetSource(root, { defaultOfficialPresetSource: sourceForOfficial || undefined });
    officialPresetRoot = resolvedOfficial.root;
    sourceForOfficial = resolvedOfficial.source;
  }

  const officialKeys = officialPresetContributionKeys(officialPresetRoot);
  const selectedOfficialTypes = nonBaseTypes.filter((type) => officialKeys.has(type));
  if (selectedOfficialTypes.length === 0) return { changed: false, installed: false };

  const configs = new PluginConfigSet(root);
  if (configs.sources.length > MAX_PLUGIN_SOURCES) {
    throw new Error(`plugin source search exceeds ${MAX_PLUGIN_SOURCES} sources`);
  }

  let source = configs.findSource((entry) => (
    sourceLocation(entry) === officialPresetRoot || entry.id === DEFAULT_OFFICIAL_PRESET_SOURCE.id
  ));
  let addedSource = false;
  if (!source) {
    if (configs.sources.length >= MAX_PLUGIN_SOURCES) {
      throw new Error(`plugin source search exceeds ${MAX_PLUGIN_SOURCES} sources`);
    }
    source = sourceForOfficial || officialPresetSourceFromRoot(officialPresetRoot);
    configs.publicPlugin.sources.push(source);
    addedSource = true;
  }

  const sourceLocationValue = sourceLocation(source);
  const resolved = resolvedOfficial && sourceLocationValue === sourceLocation(sourceForOfficial)
    ? resolvedOfficial
    : resolveSource(root, materializationSource(source, officialPresetRoot));
  assertOfficialPresetManifest(resolved.root);

  const existing = configs.findPackage(DEFAULT_OFFICIAL_PRESET_SOURCE.id);
  let reenabled = false;
  if (existing?.enabled === false) {
    delete existing.enabled;
    reenabled = true;
  }

  const installedManifest = path.join(installedPluginsDir(root), DEFAULT_OFFICIAL_PRESET_SOURCE.id, "plugin.json");
  const needsInstall = !existing || existing.commit !== resolved.commit || !fs.existsSync(installedManifest);
  if (addedSource || reenabled || needsInstall) {
    installFromSource(root, source, resolved.root, resolved.commit, {
      updateExisting: true,
      sourceMaterialized: resolved.materialized,
      publicConfig: configs.publicConfig,
      localConfig: configs.localConfig,
      faultInjector,
    });
  }
  return { changed: addedSource || reenabled || needsInstall, installed: true, selectedTypes: selectedOfficialTypes };
}
