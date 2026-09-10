/**
 * sennel/lib/config.js
 *
 * JSON / package.json 読み込みユーティリティ + Spec-Driven Development 設定管理。
 */

import fs from "fs";
import path from "path";
import { ProviderRegistry } from "./provider.js";
import { validateSchema } from "./schema-validate.js";
import { defaultAgentProfiles } from "./agent-defaults.js";
import { flowSpecRootFromConfig } from "./flow-workspace.js";
import { PRODUCT } from "./product.js";
import { GLOBAL_PROMPT_ELEMENT_HARD_MAX } from "./prompt-batching.js";

/** Default concurrency for parallel file processing. */
export const DEFAULT_CONCURRENCY = 5;

/** Default fallback language when config is unavailable or lang is unset. */
export const DEFAULT_LANG = "en";

/** Default and global maximum for one provider-visible prompt invocation. */
export const DEFAULT_PROMPT_CHARACTER_LIMIT = GLOBAL_PROMPT_ELEMENT_HARD_MAX;

/**
 * Resolve concurrency from config, falling back to DEFAULT_CONCURRENCY.
 *
 * @param {Object} cfg - Spec-Driven Development config object
 * @returns {number}
 */
export function resolveConcurrency(cfg) {
  return Number(cfg.concurrency || 0) || DEFAULT_CONCURRENCY;
}

/**
 * Resolve the configured provider-visible prompt character limit.
 * Config validation owns the integer/range boundary; internal callers receive
 * the global hard maximum when the optional setting is absent.
 */
export function resolvePromptCharacterLimit(cfg) {
  return cfg?.agent?.promptCharacterLimit ?? DEFAULT_PROMPT_CHARACTER_LIMIT;
}

/**
 * JSON ファイルを読み込む。存在しなければ throw する。
 *
 * @param {string} filePath - 読み込む JSON ファイルの絶対パス
 * @returns {Object} パース済みオブジェクト
 */
export function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error(`Missing file: ${filePath}`);
    err.code = "ERR_MISSING_FILE";
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * package.json の任意フィールドを読み込む。
 * 存在しないかパースに失敗した場合は undefined を返す。
 *
 * @param {string} root  - リポジトリルート
 * @param {string} field - 取得するフィールド名
 * @returns {*} フィールドの値、または undefined
 */
export function loadPackageField(root, field) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg[field];
  } catch (_) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// .sennel パスヘルパー
// ---------------------------------------------------------------------------

const MANAGED_DIR_NAME = PRODUCT.managedDirName;

export function managedDir(root) {
  return path.join(root, MANAGED_DIR_NAME);
}

export function managedConfigPath(root) {
  return path.join(root, MANAGED_DIR_NAME, "config.json");
}

export function managedLocalConfigPath(root) {
  return path.join(root, MANAGED_DIR_NAME, "config.local.json");
}

export function managedOutputDir(root) {
  return path.join(root, MANAGED_DIR_NAME, "output");
}

/**
 * Resolve agent work directory.
 *
 * Priority:
 *   1) opts.agentWorkDirOverride
 *   2) config.agent.workDir
 *   3) ".tmp" (default)
 *
 * @param {string} root - Repository root
 * @param {Object} [cfg] - Spec-Driven Development config object
 * @param {Object} [opts]
 * @param {string} [opts.agentWorkDirOverride] - Per-invocation override
 * @returns {string} Absolute path to work directory
 */
export function resolveWorkDir(root, cfg, opts = {}) {
  const dir = opts.agentWorkDirOverride || cfg?.agent?.workDir || ".tmp";
  return path.resolve(root, dir);
}

/**
 * .sennel/config.json から lang を読み込む。
 * ファイルが存在しないかパースに失敗した場合は "en" を返す。
 * ヘルプ表示など、バリデーション前に言語が必要な場面で使用する。
 *
 * @param {string} root - リポジトリルート
 * @returns {string}
 */
export function loadLang(root) {
  try {
    const raw = loadRawConfig(root);
    return raw.lang || DEFAULT_LANG;
  } catch (_) {
    return DEFAULT_LANG;
  }
}

// ---------------------------------------------------------------------------
// Config schema (JSON Schema subset — private, not exported)
// ---------------------------------------------------------------------------

const CONFIG_SCHEMA = {
  type: "object",
  required: ["lang", "type", "docs"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },

    // Deprecated fields (旧フォーマット)
    output: { deprecated: true },

    lang: { type: "string", minLength: 1 },

    type: {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      ],
    },

    concurrency: { type: "number", minimum: 1 },

    docs: {
      type: "object",
      required: ["languages", "defaultLanguage"],
      properties: {
        languages: { type: "array", items: { type: "string" }, minItems: 1 },
        defaultLanguage: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["translate", "generate"] },
        style: {
          type: "object",
          properties: {
            purpose: { type: "string", minLength: 1 },
            tone: { type: "string", enum: ["polite", "formal", "casual"] },
            customInstruction: { type: "string" },
          },
        },
        exclude: { type: "array", items: { type: "string" } },
      },
    },

    chapters: {
      type: "array",
      items: {
        type: "object",
        required: ["chapter"],
        properties: {
          chapter: { type: "string" },
          desc: { type: "string" },
          exclude: { type: "boolean" },
        },
      },
    },

    agent: {
      type: "object",
      properties: {
        workDir: { type: "string" },
        timeout: { type: "number", minimum: 1 },
        retryCount: { type: "number", minimum: 1 },
        promptCharacterLimit: {
          type: "integer",
          minimum: 1000,
          maximum: GLOBAL_PROMPT_ELEMENT_HARD_MAX,
        },
        stdinFallbackThreshold: { type: "number", minimum: 1 },
        providers: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["command", "args"],
            properties: {
              command: { type: "string", minLength: 1 },
              args: { type: "array" },
              systemPromptFlag: { type: "string" },
              jsonOutputFlag: { type: "string" },
              jsonSchemaFlag: { type: "string" },
              jsonSchemaMode: { type: "string", enum: ["file", "inline"] },
            },
          },
        },
        profiles: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        useProfile: { type: "string" },
      },
    },

    scan: {
      type: "object",
      required: ["include"],
      properties: {
        include: { type: "array", items: { type: "string" }, minItems: 1 },
        exclude: { type: "array", items: { type: "string" } },
      },
    },

    flow: {
      type: "object",
      properties: {
        specDir: { type: "string", minLength: 1 },
        merge: { type: "string", enum: ["squash", "ff-only", "merge"] },
        repairFingerprint: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxChangedPaths: { type: "integer", minimum: 1, maximum: 1000000 },
            include: { type: "array", items: { type: "string", minLength: 1 } },
          },
        },
        push: {
          type: "object",
          properties: {
            remote: { type: "string" },
          },
        },
        commands: {
          type: "object",
          properties: {
            context: {
              type: "object",
              properties: {
                search: {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["ngram", "ai"] },
                  },
                },
              },
            },
          },
        },
        hooks: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },

    plugin: {
      type: "object",
      properties: {
        config: {
          type: "object",
          additionalProperties: true,
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "type"],
            properties: {
              id: { type: "string", minLength: 1 },
              type: { type: "string", enum: ["git", "local", "npm"] },
              url: { type: "string", minLength: 1 },
              remote: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
              ref: { type: "string", minLength: 1 },
            },
          },
        },
        packages: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "source", "commit"],
            properties: {
              id: { type: "string", minLength: 1 },
              source: { type: "string", minLength: 1 },
              ref: { type: "string", minLength: 1 },
              commit: { type: "string", minLength: 40 },
              enabled: { type: "boolean" },
            },
          },
        },
      },
    },

    test: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        projectPaths: { type: "array", items: { type: "string", minLength: 1 } },
        timeout: { type: "number", minimum: 1 },
        finalRegressionTimeout: { type: "number", minimum: 1 },
        testExecuteRegression: { type: "string", enum: ["targeted", "full", "skip"] },
      },
    },

    commands: {
      type: "object",
      properties: {
        gh: { type: "string", enum: ["enable", "disable"] },
        test: {
          type: "object",
          required: ["task", "parent"],
          properties: {
            task: { type: "string", minLength: 1 },
            parent: { type: "string", minLength: 1 },
          },
        },
      },
    },

    logs: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        dir: { type: "string" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate a config object against the schema.
 * Throws on any validation failure.
 *
 * @param {*} raw - Parsed config object
 * @returns {import("./types.js").ProjectConfig} Validated config
 */
const MISSING_TYPE_ERROR = "type: required field is missing";

export function validate(raw, options = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("config must be a non-null object");
  }

  const errors = validateSchema(raw, options.schema || CONFIG_SCHEMA);
  if (options.allowMissingType === true) {
    const index = errors.indexOf(MISSING_TYPE_ERROR);
    if (index !== -1) errors.splice(index, 1);
  }

  // Cross-field validation: defaultLanguage must be in languages
  if (Array.isArray(raw.docs?.languages) && typeof raw.docs?.defaultLanguage === "string") {
    if (!raw.docs.languages.includes(raw.docs.defaultLanguage)) {
      errors.push("'docs.defaultLanguage' must be one of 'docs.languages'");
    }
  }

  // Cross-field validation: profile provider references must be valid
  const agentProfiles = raw.agent
    ? { ...defaultAgentProfiles(), ...(raw.agent.profiles || {}) }
    : {};
  const registry = raw.agent ? new ProviderRegistry(raw.agent?.providers || {}) : null;

  if (Object.hasOwn(raw.agent || {}, "batchTokenLimit")) {
    errors.push("'agent.batchTokenLimit': unknown field; use 'agent.promptCharacterLimit'");
  }

  if (raw.agent?.profiles) {
    for (const [profileName, profile] of Object.entries(raw.agent.profiles)) {
      if (typeof profile !== "object" || profile == null) continue;
      for (const [commandId, providerKey] of Object.entries(profile)) {
        if (typeof providerKey === "string" && !registry.hasProfile(providerKey)) {
          errors.push(`'agent.profiles.${profileName}.${commandId}': unknown provider "${providerKey}"`);
        }
      }
    }
  }

  // Cross-field validation: useProfile must reference a defined profile
  if (typeof raw.agent?.useProfile === "string") {
    if (!agentProfiles[raw.agent.useProfile]) {
      errors.push(`'agent.useProfile': profile "${raw.agent.useProfile}" is not defined in built-in profiles or agent.profiles`);
    }
  }

  if (raw.test) {
    if (typeof raw.test.command === "string") {
      validateTestCommand(raw.test.command, errors);
    }
    if (Array.isArray(raw.test.projectPaths)) {
      raw.test.projectPaths.forEach((entry, index) => validateProjectTestPath(entry, index, errors));
    }
    if (raw.test.timeout != null && !Number.isInteger(raw.test.timeout)) {
      errors.push("'test.timeout' must be a positive integer number of seconds");
    }
    if (raw.test.finalRegressionTimeout != null && !Number.isInteger(raw.test.finalRegressionTimeout)) {
      errors.push("'test.finalRegressionTimeout' must be a positive integer number of seconds");
    }
  }

  try {
    flowSpecRootFromConfig(raw);
  } catch (error) {
    errors.push(error.message);
  }

  if (raw.plugin) validatePluginConfig(raw.plugin, errors);
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join("\n  - ")}`);
  }

  return /** @type {import("./types.js").ProjectConfig} */ (raw);
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PLUGIN_COMMIT_RE = /^[0-9a-f]{40}$/;

function validatePluginConfig(plugin, errors) {
  if (Array.isArray(plugin.repos)) {
    errors.push("'plugin.repos': migrate to 'plugin.sources' and update packages[].repo to packages[].source");
  }
  const sourceIds = new Set();
  for (const [index, source] of (plugin.sources || []).entries()) {
    if (!PLUGIN_ID_RE.test(source.id)) errors.push(`'plugin.sources[${index}].id': invalid plugin source id`);
    if (sourceIds.has(source.id)) errors.push(`'plugin.sources[${index}].id': duplicate plugin source id "${source.id}"`);
    sourceIds.add(source.id);
    if (source.type === "local") {
      if (typeof source.path !== "string" || source.path.trim() === "") errors.push(`'plugin.sources[${index}].path': local source requires path`);
      if (typeof source.path === "string" && (path.isAbsolute(source.path) ? false : source.path.startsWith("../"))) errors.push(`'plugin.sources[${index}].path': unsafe local source path`);
    }
    if (source.type === "git" && typeof source.url !== "string" && typeof source.remote !== "string") errors.push(`'plugin.sources[${index}].remote': git source requires url or remote`);
    if (source.type === "npm") errors.push(`'plugin.sources[${index}]': npm sources are not supported yet`);
  }
  const packageIds = new Set();
  for (const [index, pkg] of (plugin.packages || []).entries()) {
    if (!PLUGIN_ID_RE.test(pkg.id)) errors.push(`'plugin.packages[${index}].id': invalid plugin package id`);
    if (packageIds.has(pkg.id)) errors.push(`'plugin.packages[${index}].id': duplicate plugin package id "${pkg.id}"`);
    packageIds.add(pkg.id);
    if (Object.prototype.hasOwnProperty.call(pkg, "repo")) errors.push(`'plugin.packages[${index}].repo': migrate to 'plugin.packages[${index}].source'`);
    if (!sourceIds.has(pkg.source)) errors.push(`'plugin.packages[${index}].source': unknown plugin source "${pkg.source}"`);
    if (!PLUGIN_COMMIT_RE.test(pkg.commit)) errors.push(`'plugin.packages[${index}].commit': must be a 40-character lowercase git commit`);
  }
}

const TEST_COMMAND_FORBIDDEN = /(\|\||&&|[|&;<>`$()]|\*|\?|\[|\]|\{|\})/;

function validateTestCommand(command, errors) {
  if (TEST_COMMAND_FORBIDDEN.test(command)) {
    errors.push("'test.command' contains unsupported shell control or expansion syntax");
  }
}

function validateProjectTestPath(entry, index, errors) {
  const prefix = `'test.projectPaths[${index}]'`;
  if (typeof entry !== "string" || entry.length === 0) {
    errors.push(`${prefix} must be a non-empty string`);
    return;
  }
  if (path.isAbsolute(entry)) errors.push(`${prefix} must be root-relative`);
  const hasParentTraversal = entry === ".." || entry.startsWith("../") || entry.endsWith("/..") || entry.includes("/../");
  if (entry.includes("\\") || hasParentTraversal) errors.push(`${prefix} must be a root-relative POSIX path without parent traversal`);
  if (/[*?[\\\]{};$|&<>`$()]/.test(entry)) errors.push(`${prefix} must not contain globs or shell metacharacters`);
}

// ---------------------------------------------------------------------------
// Spec-Driven Development 設定管理
// ---------------------------------------------------------------------------

/**
 * .sennel/config.json を読み込みバリデーションする。
 *
 * @param {string} root - リポジトリルート
 * @returns {import("./types.js").ProjectConfig}
 */
export function loadConfig(root, options = {}) {
  return loadConfigFromManagedDirectory(managedDir(root), options);
}

/**
 * Validate a config boundary at an explicitly supplied managed directory.
 * Migration uses this to inspect a staged legacy directory without teaching
 * normal runtime about legacy names.
 */
export function loadConfigFromManagedDirectory(directory, options = {}) {
  const raw = loadRawConfigFromManagedDirectory(directory);
  const pluginConfig = loadEnabledPluginConfig(directory, raw);
  const merged = mergeDefaults(raw, pluginConfig.defaults);
  return validate(merged, { ...options, schema: mergeConfigSchemas(CONFIG_SCHEMA, pluginConfig.schemas) });
}

export function loadRawConfig(root) {
  return loadRawConfigFromManagedDirectory(managedDir(root));
}

export function loadRawConfigFromManagedDirectory(directory) {
  const raw = loadJsonFile(path.join(directory, "config.json"));
  const localPath = path.join(directory, "config.local.json");
  if (!fs.existsSync(localPath)) return raw;
  const local = loadJsonFile(localPath);
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    throw new Error("config.local.json must be a non-null object");
  }
  return mergeConfigOverlay(raw, local);
}

export function mergeConfigOverlay(base, overlay, segments = []) {
  if (Array.isArray(overlay)) {
    if (segments.join(".") === "plugin.sources" || segments.join(".") === "plugin.packages") {
      return mergeEntriesById(base, overlay);
    }
    return structuredClone(overlay);
  }
  if (!overlay || typeof overlay !== "object") return overlay;
  const out = base && typeof base === "object" && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = mergeConfigOverlay(out[key], value, [...segments, key]);
  }
  return out;
}

function mergeEntriesById(base, overlay) {
  const out = Array.isArray(base) ? structuredClone(base) : [];
  const indexById = new Map(out.map((entry, index) => [entry?.id, index]).filter(([id]) => typeof id === "string"));
  for (const entry of overlay) {
    const next = structuredClone(entry);
    const index = indexById.get(next?.id);
    if (index == null) {
      indexById.set(next?.id, out.length);
      out.push(next);
    } else {
      out[index] = mergeConfigOverlay(out[index], next);
    }
  }
  return out;
}

function loadEnabledPluginConfig(managedDirectory, raw) {
  const schemas = [];
  const defaults = [];
  for (const pkg of raw?.plugin?.packages || []) {
    if (pkg.enabled === false) continue;
    const pluginRoot = path.join(managedDirectory, "plugins", pkg.id);
    const manifestPath = path.join(pluginRoot, "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const config = manifest.contributions?.config;
      if (config?.schema) schemas.push(loadJsonFile(path.join(pluginRoot, config.schema)));
      if (config?.defaults) defaults.push(migratePluginDefaultNamespaces(loadJsonFile(path.join(pluginRoot, config.defaults))));
    } catch (_) {
      continue;
    }
  }
  return { schemas, defaults };
}

function migratePluginDefaultNamespaces(raw) {
  return structuredClone(raw || {});
}

function mergeConfigSchemas(base, schemas) {
  if (!schemas.length) return base;
  const merged = {
    ...base,
    properties: { ...base.properties },
  };
  for (const schema of schemas) {
    for (const [key, value] of Object.entries(schema.properties || {})) {
      merged.properties[key] = mergeSchemaNode(merged.properties[key], value);
    }
  }
  return merged;
}

function mergeSchemaNode(base, extension) {
  if (!base || !extension || base.type !== "object" || extension.type !== "object") return extension || base;
  const merged = {
    ...base,
    ...extension,
    properties: { ...(base.properties || {}) },
  };
  for (const [key, value] of Object.entries(extension.properties || {})) {
    merged.properties[key] = mergeSchemaNode(merged.properties[key], value);
  }
  return merged;
}

function mergeDefaults(raw, defaults) {
  if (!defaults.length) return raw;
  let merged = structuredClone(raw);
  for (const defaultsObject of defaults) merged = mergeMissing(merged, defaultsObject);
  return merged;
}

function mergeMissing(target, defaults) {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return target;
  const out = { ...target };
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] == null) {
      out[key] = value;
    } else if (
      typeof out[key] === "object" && out[key] !== null && !Array.isArray(out[key])
      && typeof value === "object" && value !== null && !Array.isArray(value)
    ) {
      out[key] = mergeMissing(out[key], value);
    }
  }
  return out;
}
