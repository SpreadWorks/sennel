/**
 * src/lib/agent.js
 *
 * AI agent service. Built once at Container init time and accessed via
 * `container.get("agent")`. The class encapsulates:
 *   - profile resolution (SENNEL_PROFILE > config.agent.useProfile > default profile > default)
 *   - prompt building (system prompt, JSON output flag, workDir flag injection)
 *   - argv-size based stdin fallback (config-driven threshold)
 *   - spawn-based asynchronous invocation (no blocking on stdin EOF)
 *   - bounded retry (max 5 attempts)
 *   - Logger.agent start/end events
 *
 * Agent is consumed through the container. AgentProviderRetryPolicy and
 * AgentRuntimeDirectorySet are exported for protocol adapters that must own
 * an effect-observed retry loop; the registry and Provider classes live in
 * src/lib/provider.js.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { generateRequestId } from "./log.js";
import { ProviderRegistry } from "./provider.js";
import { formatPreview } from "./error-preview.js";
import { defaultAgentProfiles } from "./agent-defaults.js";
import {
  persistAgentInvocationMetric,
  persistPromptCacheHitMetric,
} from "./agent-invocation-metric.js";
import { AgentTimeout, AgentTimeoutDiagnostic, DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";
import { LinuxProcessStat } from "./process-identity.js";
import { PRODUCT } from "./product.js";
import { AtomicFile } from "./atomic-file.js";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { FlowAttributionPolicy } from "./flow-attribution.js";
import {
  AgentFailure,
  AgentPermissionConfigurationFailure,
  AgentTimeoutFailure,
  EmptyAgentResponseFailure,
} from "./agent-failure.js";
import { resolvePromptCharacterLimit } from "./config.js";
import { PromptInvocationProjectionOverflowFailure } from "./prompt-batching.js";

const DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS = 250;
const PROCESS_DEATH_POLL_MS = 10;
const DEFAULT_STDIN_FALLBACK_THRESHOLD = 100_000;
export const MAX_AGENT_ARGUMENT_BYTES = (128 * 1024) - 1;
export const MAX_AGENT_ARGV_BYTES = 256 * 1024;
const MAX_EXECUTION_ENVIRONMENT_VARIABLES = 64;
const MAX_EXECUTION_ENVIRONMENT_BYTES = 64 * 1024;
const MAX_RETRY = 5;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;
const RETRY_BACKOFF_FACTOR = 2;
const PROMPT_CACHE_LOCK_RETRY_MS = 10;
const PROMPT_CACHE_LOCK_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_PROVIDER_FAMILY_ALIASES = Object.freeze({
  codex: "codex/gpt-5.6-terra-medium",
  claude: "claude/sonnet",
});

function normalizedExecutionEnvironment(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent executionEnvironment must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_EXECUTION_ENVIRONMENT_VARIABLES) {
    throw new Error(`agent executionEnvironment must contain at most ${MAX_EXECUTION_ENVIRONMENT_VARIABLES} variables`);
  }
  const environment = {};
  let totalBytes = 0;
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid agent execution environment variable: ${name}`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`agent execution environment variable ${name} must be a NUL-free string`);
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(entry);
    if (totalBytes > MAX_EXECUTION_ENVIRONMENT_BYTES) {
      throw new Error(`agent executionEnvironment must not exceed ${MAX_EXECUTION_ENVIRONMENT_BYTES} bytes`);
    }
    environment[name] = entry;
  }
  return environment;
}

class AgentExecutionContext {
  constructor({ providerWorkDir, spawnCwd }) {
    if (!path.isAbsolute(providerWorkDir) || !path.isAbsolute(spawnCwd)) {
      throw new Error("agent execution directories must be absolute");
    }
    this.providerWorkDir = providerWorkDir;
    this.spawnCwd = spawnCwd;
    Object.freeze(this);
  }
}

/**
 * Side-effect-free description of the provider/profile-specific request which
 * Agent would send. Character accounting is deliberately independent from the
 * UTF-8 byte accounting used to select argv or stdin transport.
 */
export class ResolvedAgentInvocationProjection {
  constructor({
    providerKey,
    profileKey,
    command,
    promptCharacterCount,
    systemPromptCharacterCount,
    schemaCharacterCount,
    finalArgs,
    inlineArgvByteCount,
    schemaMode,
    usesStdin,
  }) {
    for (const [field, value] of Object.entries({
      promptCharacterCount,
      systemPromptCharacterCount,
      schemaCharacterCount,
      inlineArgvByteCount,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`agent invocation projection ${field} must be a non-negative integer`);
      }
    }
    if (!Array.isArray(finalArgs)) throw new Error("agent invocation projection finalArgs must be an array");
    if (!["none", "inline", "file", "fallback"].includes(schemaMode)) {
      throw new Error(`unsupported agent invocation projection schemaMode: ${schemaMode}`);
    }
    this.providerKey = providerKey;
    this.profileKey = profileKey;
    this.command = command;
    this.promptCharacterCount = promptCharacterCount;
    this.systemPromptCharacterCount = systemPromptCharacterCount;
    this.schemaCharacterCount = schemaCharacterCount;
    this.finalArgs = Object.freeze([...finalArgs]);
    this.inlineArgvByteCount = inlineArgvByteCount;
    this.argvByteCount = argvByteLength(this.finalArgs);
    this.maxArgumentByteCount = argvMaxElementByteLength(this.finalArgs);
    this.schemaMode = schemaMode;
    this.usesStdin = usesStdin === true;
    Object.freeze(this);
  }

  fits(limit) {
    return this.promptCharacterCount <= normalizeProjectionCharacterLimit(limit)
      && this.argvByteCount <= MAX_AGENT_ARGV_BYTES
      && this.maxArgumentByteCount <= MAX_AGENT_ARGUMENT_BYTES;
  }

  assertWithinLimit(limit) {
    const maximum = normalizeProjectionCharacterLimit(limit);
    if (this.promptCharacterCount > maximum) {
      throw new PromptInvocationProjectionOverflowFailure(
        `resolved agent invocation prompt has ${this.promptCharacterCount} characters; limit is ${maximum}`,
        {
          actualCharacters: this.promptCharacterCount,
          maximumCharacters: maximum,
          providerKey: this.providerKey,
          profileKey: this.profileKey,
          schemaMode: this.schemaMode,
          usesStdin: this.usesStdin,
        },
      );
    }
    if (this.argvByteCount > MAX_AGENT_ARGV_BYTES || this.maxArgumentByteCount > MAX_AGENT_ARGUMENT_BYTES) {
      throw new PromptInvocationProjectionOverflowFailure(
        `resolved agent invocation argv exceeds its safe byte limit; argv=${this.argvByteCount}, maxArgument=${this.maxArgumentByteCount}`,
        {
          actualArgvBytes: this.argvByteCount,
          maximumArgvBytes: MAX_AGENT_ARGV_BYTES,
          actualArgumentBytes: this.maxArgumentByteCount,
          maximumArgumentBytes: MAX_AGENT_ARGUMENT_BYTES,
          providerKey: this.providerKey,
          profileKey: this.profileKey,
          schemaMode: this.schemaMode,
          usesStdin: this.usesStdin,
        },
      );
    }
    return this;
  }
}

class ResolvedAgentInvocationBlueprint {
  constructor({
    projection,
    projectedSchemaPath,
    schemaContent,
    missingSchemaProfileFields,
    executionEnvironment,
    stdinContent,
  }) {
    if (!(projection instanceof ResolvedAgentInvocationProjection)) {
      throw new Error("resolved agent invocation blueprint requires a projection");
    }
    this.projection = projection;
    this.projectedSchemaPath = projectedSchemaPath;
    this.schemaContent = schemaContent;
    this.missingSchemaProfileFields = Object.freeze([...missingSchemaProfileFields]);
    this.executionEnvironment = Object.freeze({ ...executionEnvironment });
    this.stdinContent = stdinContent;
    Object.freeze(this);
  }

  materialize({ agentWorkDir, commandId }) {
    let finalArgs = [...this.projection.finalArgs];
    let pendingSchemaWrite = null;
    if (this.projectedSchemaPath) {
      const schemaPath = path.join(agentWorkDir, `schema-${crypto.randomUUID()}.json`);
      finalArgs = finalArgs.map((argument) => (
        argument === this.projectedSchemaPath ? schemaPath : argument
      ));
      pendingSchemaWrite = { path: schemaPath, content: this.schemaContent };
    }
    reportMissingJsonSchemaProfileFields({
      commandId,
      profileKey: this.projection.profileKey,
      missing: this.missingSchemaProfileFields,
    });
    const env = { ...process.env, ...this.executionEnvironment };
    delete env.CLAUDECODE;
    return {
      finalArgs,
      env,
      stdinContent: this.stdinContent,
      pendingSchemaWrite,
      projection: this.projection,
    };
  }
}

/**
 * Normalized, bounded provider retry configuration.  It is intentionally a
 * value object so a caller which needs to own the retry loop (for example an
 * effect-observing protocol) can reuse the configured policy without reaching
 * into Agent's test seams.
 */
export class AgentProviderRetryPolicy {
  constructor({ retryCount, retryDelayMs, backoffFactor = RETRY_BACKOFF_FACTOR } = {}) {
    if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > MAX_RETRY) {
      throw new Error("agent provider retryCount must be a bounded non-negative integer");
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
      throw new Error("agent provider retryDelayMs must be a positive integer");
    }
    if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new Error("agent provider retry backoffFactor must be at least one");
    }
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.backoffFactor = backoffFactor;
    Object.freeze(this);
  }

  static from({ agentSection = {}, options = {} } = {}) {
    const rawCount = Number(options.retryCount ?? agentSection.retryCount ?? DEFAULT_RETRY_COUNT);
    const rawDelay = Number(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    return new AgentProviderRetryPolicy({
      retryCount: Number.isFinite(rawCount) && rawCount > 0
        ? Math.min(Math.floor(rawCount), MAX_RETRY)
        : 0,
      retryDelayMs: Number.isFinite(rawDelay) && rawDelay > 0
        ? Math.floor(rawDelay)
        : DEFAULT_RETRY_DELAY_MS,
    });
  }

  delayBeforeRetry(completedAttempts) {
    if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 1 || completedAttempts > this.retryCount) {
      throw new Error("agent provider retry delay is outside its bounded policy");
    }
    return this.retryDelayMs * Math.pow(this.backoffFactor, completedAttempts - 1);
  }

  toJSON() {
    return { retryCount: this.retryCount, retryDelayMs: this.retryDelayMs };
  }
}

/** Explicit, repository-relative runtime write surface owned by Agent. */
export class AgentRuntimeDirectorySet {
  constructor({ root, directories = [] } = {}) {
    if (!path.isAbsolute(root)) throw new Error("agent runtime directory root must be absolute");
    const normalizedRoot = path.resolve(root);
    const normalized = directories.map((directory) => {
      if (typeof directory !== "string" || !path.isAbsolute(directory)) {
        throw new Error("agent runtime directory must be absolute");
      }
      return path.resolve(directory);
    }).filter((directory) => {
      const relative = path.relative(normalizedRoot, directory);
      return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    this.root = normalizedRoot;
    this.directories = Object.freeze([...new Set(normalized)]);
    Object.freeze(this);
  }

  toArray() {
    return [...this.directories];
  }
}

class Agent {
  /**
   * @param {Object} opts
   * @param {Object} opts.config       - ProjectConfig
   * @param {Object} opts.paths        - Container paths ({ root, agentWorkDir, ... })
   * @param {ProviderRegistry} opts.registry
   * @param {Object} opts.logger       - Logger instance
   * @param {Object} [opts.flowManager] - FlowManager, used for metric accumulation
   */
  constructor({ config, paths, registry, logger, flowManager, supervision }) {
    this._config = config || {};
    this._paths = paths || {};
    this._registry = registry || new ProviderRegistry(this._config.agent?.providers || {});
    this._logger = logger;
    this._flowManager = flowManager || null;
    this._supervision = supervision || {};
  }

  get promptCharacterLimit() {
    return resolvePromptCharacterLimit(this._config);
  }

  /**
   * Resolve a profile for the given commandId.
   * Priority: SENNEL_PROFILE env > config.agent.useProfile > default profile > default.
   * Returns null when no profile is configured.
   */
  resolve(commandId, options = {}) {
    try {
      return this._resolveAttempt(AgentResolutionAttempt.from({
        agentSection: this._config.agent || {},
        commandId,
        options,
        registry: this._registry,
      }));
    } catch (error) {
      throw AgentFailure.from(error).recordAttempts(1, 1);
    }
  }

  _resolveAttempt(attempt) {
    if (!attempt.lookupKey) return null;

    const resolved = this._registry.resolveProfile(attempt.lookupKey);
    if (!resolved) return null;

    return attempt.toResolved(resolved);
  }

  /**
   * Resolve and project an invocation without creating directories, schema
   * files, cache entries, logs, metrics, or provider processes.
   */
  projectInvocation(prompt, options = {}) {
    try {
      const attempt = AgentResolutionAttempt.from({
        agentSection: this._config.agent || {},
        commandId: options.commandId,
        options,
        registry: this._registry,
      });
      const resolved = this._resolveAttempt(attempt);
      if (!resolved) {
        throw new AgentPermissionConfigurationFailure({ message: attempt.formatFailure() });
      }
      return this._createInvocationBlueprint(resolved, prompt, options).projection;
    } catch (error) {
      throw AgentFailure.from(error).recordAttempts(1, 1);
    }
  }

  /**
   * Invoke the resolved AI agent.
   *
   * @param {string} prompt
   * @param {Object} [options]
   * @param {string} [options.commandId]
   * @param {string} [options.systemPrompt]
   * @param {Function} [options.onStdout]
   * @param {Function} [options.onStderr]
   * @param {number}  [options.retryCount=2]
   * @param {number}  [options.retryDelayMs=3000]
   * @param {string}  [options.executionWorkDir] - Per-call agent execution directory inside the repository
   * @param {boolean} [options.waitForProcessTree=false] - Wait for the provider process group to become idle
   * @param {"ambient"|"none"} [options.flowAttribution="ambient"]
   * @param {import("./agent-invocation-metric.js").DeferredAgentInvocationMetric} [options.deferredMetric]
   * @param {import("./prompt-batching.js").PromptProviderCallAdmission} [options.providerCallAdmission]
   * @param {boolean} [options._dryRun] - Test-only short-circuit
   * @returns {Promise<string>} response text (trimmed)
   */
  async call(prompt, options) {
    const opts = options || {};
    if (opts._dryRun) return "";
    const providerCallAdmission = opts.providerCallAdmission ?? null;
    providerCallAdmission?.claim();
    try {
    const flowAttribution = new FlowAttributionPolicy(opts.flowAttribution);

    let attempt;
    let resolved;
    try {
      attempt = AgentResolutionAttempt.from({
        agentSection: this._config.agent || {},
        commandId: opts.commandId,
        options: opts,
        registry: this._registry,
      });
      resolved = this._resolveAttempt(attempt);
    } catch (error) {
      throw AgentFailure.from(error).recordAttempts(1, 1);
    }
    if (!resolved) {
      throw new AgentPermissionConfigurationFailure({
        message: attempt.formatFailure(),
      });
    }
    let executionContext;
    try {
      ensureWorkDir(this._paths.agentWorkDir);
      executionContext = this._resolveExecutionContext(opts.executionWorkDir);
      ensureWorkDir(executionContext.providerWorkDir);
    } catch (error) {
      throw AgentFailure.from(error).recordAttempts(1, 1);
    }

    const retry = this.providerRetryPolicy(opts);
    const invocationOptions = {
      ...opts,
      executionWorkDir: executionContext.providerWorkDir,
      spawnCwd: executionContext.spawnCwd,
    };
    const invocationBlueprint = this._createInvocationBlueprint(resolved, prompt, invocationOptions);
    invocationBlueprint.projection.assertWithinLimit(this.promptCharacterLimit);
    const cachePolicy = new PromptCachePolicy(opts.cacheMode);
    const promptCache = flowAttribution.usesFlowState && (cachePolicy.readsCache || cachePolicy.writesCache)
      ? this._resolvePromptCache(resolved, prompt, opts)
      : null;
    const hit = cachePolicy.readsCache ? promptCache?.cache.get(promptCache.key) : null;
    const acceptedHit = hit != null && this._isCacheableResponse(hit, null, opts);
    if (acceptedHit) {
      opts.onCacheDecision?.({
        cacheOutcome: "hit",
        providerCalled: false,
        fresh: false,
      });
      await persistPromptCacheHitMetric({
        flowManager: this._flowManager,
        context: promptCache.context,
        provider: resolved.providerKey,
        profileKey: resolved.profileKey,
        responseChars: textStats(hit).chars,
      }, opts.deferredMetric ?? null);
      return hit;
    }
    if (hit != null) {
      // Do not let a known-invalid value survive a failed fresh call. The
      // conditional removal cannot erase a concurrent writer's replacement.
      await promptCache.cache.removeIfMatches(promptCache.key, hit);
    }
    let cacheCandidate = null;
    opts.onCacheDecision?.({
      cacheOutcome: hit != null
        ? "invalid_hit"
        : (cachePolicy.mode === "refresh" ? "refresh" : (cachePolicy.mode === "bypass" ? "bypass" : "miss")),
      providerCalled: true,
      fresh: hit != null || cachePolicy.mode !== "default",
    });
    const text = await runWithLogging({
      logger: this._logger,
      flowManager: this._flowManager,
      command: resolved.profile.command,
      systemPrompt: opts.systemPrompt ?? null,
      prompt,
      provider: resolved.providerKey,
      profileKey: resolved.profileKey,
      flowAttribution,
      deferredMetric: opts.deferredMetric ?? null,
      invoke: async () => {
        cacheCandidate = await this._callOnceWithRetry(
          resolved,
          prompt,
          invocationOptions,
          retry,
          invocationBlueprint,
        );
        return cacheCandidate;
      },
    });
    if (cachePolicy.writesCache && promptCache && text && this._isCacheableResponse(text, cacheCandidate, opts)) {
      await promptCache.cache.set(promptCache.key, text);
    }
    return text;
    } finally {
      providerCallAdmission?.settle();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers (also used by tests via _*ForTest seams)
  // -----------------------------------------------------------------------

  _buildInvocationForTest(prompt, options = {}) {
    const resolved = this.resolve(options.commandId, options);
    if (!resolved) throw new Error("No agent configured.");
    return this._buildInvocation(resolved, prompt, options);
  }

  _resolveExecutionWorkDir(override) {
    if (override == null) return this._paths.agentWorkDir;
    const root = path.resolve(this._paths.root || process.cwd());
    const resolved = path.resolve(root, String(override));
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AgentPermissionConfigurationFailure({
        message: "agent executionWorkDir must stay inside the repository root",
      });
    }
    return resolved;
  }

  _resolveExecutionContext(override) {
    const providerWorkDir = this._resolveExecutionWorkDir(override);
    const spawnCwd = override == null
      ? path.resolve(this._paths.root || process.cwd())
      : providerWorkDir;
    return new AgentExecutionContext({ providerWorkDir, spawnCwd });
  }

  _buildPromptCacheKeyMaterialForTest(resolved, prompt, options = {}) {
    return PromptCacheIdentity.from({ resolved, prompt, options }).toKeyMaterial();
  }

  _buildPromptCacheKeyForTest(resolved, prompt, options = {}) {
    return sha256(this._buildPromptCacheKeyMaterialForTest(resolved, prompt, options));
  }

  _normalizeRetryOptionsForTest(options = {}) {
    return this.providerRetryPolicy(options).toJSON();
  }

  providerRetryPolicy(options = {}) {
    return AgentProviderRetryPolicy.from({
      agentSection: this._config.agent || {},
      options,
    });
  }

  runtimeDirectories() {
    return new AgentRuntimeDirectorySet({
      root: path.resolve(this._paths.root || process.cwd()),
      directories: [
        this._paths.agentWorkDir,
        this._paths.logDir,
        ...(this._logger?.runtimeDirectories?.() ?? []),
      ].filter((directory) => typeof directory === "string"),
    });
  }

  _isCacheableResponse(text, cacheCandidate, options = {}) {
    if (cacheCandidate?.cacheable === false) return false;
    if (typeof options.validateResponseForCache !== "function") return true;
    try {
      const result = options.validateResponseForCache(text);
      return result !== false && result != null;
    } catch (_) {
      return false;
    }
  }

  _resolvePromptCache(resolved, prompt, options) {
    const context = resolvePromptCacheContext(this._flowManager);
    if (!context) return null;
    const cache = new AgentPromptCache({
      root: this._paths.root || process.cwd(),
      specId: context.specId,
    });
    const key = this._buildPromptCacheKeyForTest(resolved, prompt, options);
    return { cache, key, context };
  }

  _buildInvocation(resolved, prompt, options) {
    const blueprint = this._createInvocationBlueprint(resolved, prompt, options);
    blueprint.projection.assertWithinLimit(this.promptCharacterLimit);
    return blueprint.materialize({
      agentWorkDir: this._paths.agentWorkDir,
      commandId: options.commandId,
    });
  }

  _createInvocationBlueprint(resolved, prompt, options) {
    const { provider, profile } = resolved;
    const baseArgs = Array.isArray(profile.args) ? [...profile.args] : [];
    const systemFlag = provider.systemPromptFlag();
    const systemPrompt = options.systemPrompt ?? null;

    const prefix = systemFlag && systemPrompt ? [systemFlag, systemPrompt] : [];
    let effectivePrompt = !systemFlag && systemPrompt
      ? `${systemPrompt}\n\n${prompt}`
      : prompt;

    // jsonSchema handling: profile-property-based flag or fmtFallback
    const jsonSchema = options.jsonSchema
      ? provider.prepareJsonSchema(options.jsonSchema)
      : null;
    const schemaFlag = jsonSchema ? (profile.jsonSchemaFlag || null) : null;
    const schemaMode = jsonSchema ? (profile.jsonSchemaMode || null) : null;
    const schemaSuffix = [];
    const missingSchemaProfileFields = jsonSchema && (!schemaFlag || !schemaMode)
      ? [
        ...(!schemaFlag ? ["jsonSchemaFlag"] : []),
        ...(!schemaMode ? ["jsonSchemaMode"] : []),
      ]
      : [];
    const schemaCapable = jsonSchema
      && schemaFlag
      && ["inline", "file"].includes(schemaMode);
    let projectedSchemaPath = null;
    let schemaContent = null;
    let projectedSchemaMode = "none";
    if (jsonSchema && schemaCapable) {
      schemaContent = JSON.stringify(jsonSchema);
      projectedSchemaMode = schemaMode;
      if (schemaMode === "file") {
        projectedSchemaPath = path.join(
          this._paths.agentWorkDir,
          `schema-${"0".repeat(36)}.json`,
        );
        schemaSuffix.push(schemaFlag, projectedSchemaPath);
      } else {
        schemaSuffix.push(schemaFlag, schemaContent);
      }
    } else if (jsonSchema && options.fmtFallback) {
      effectivePrompt = `${options.fmtFallback}\n\n${effectivePrompt}`;
      projectedSchemaMode = "fallback";
    }

    const promptedArgs = substitutePromptToken(baseArgs, effectivePrompt);

    const workDirFlag = provider.workDirFlag();
    const executionWorkDir = this._resolveExecutionWorkDir(options.executionWorkDir);
    const workDirInjected = workDirFlag
      ? injectWorkDirFlag(workDirFlag, executionWorkDir, promptedArgs)
      : promptedArgs;

    const finalArgs = [...prefix, ...workDirInjected, ...schemaSuffix];
    const threshold = this._config.agent?.stdinFallbackThreshold ?? DEFAULT_STDIN_FALLBACK_THRESHOLD;
    const inlineArgvByteCount = argvByteLength(finalArgs);
    const usesStdin = inlineArgvByteCount > threshold
      || inlineArgvByteCount > MAX_AGENT_ARGV_BYTES
      || argvMaxElementByteLength(finalArgs) > MAX_AGENT_ARGUMENT_BYTES;
    let transportedArgs = finalArgs;
    let stdinContent = null;
    if (usesStdin) {
      // Stdin fallback routes only the effective user prompt away from argv.
      // Separate system/schema arguments remain exactly as the provider profile
      // declares them and are accounted independently in the projection.
      const strippedArgs = stripPromptArgs(baseArgs);
      const strippedFinal = workDirFlag
        ? injectWorkDirFlag(workDirFlag, executionWorkDir, strippedArgs)
        : strippedArgs;
      transportedArgs = [...prefix, ...strippedFinal, ...schemaSuffix];
      stdinContent = effectivePrompt;
    }
    const separatedSystemPromptCharacters = systemFlag && systemPrompt
      ? String(systemPrompt).length
      : 0;
    const transportedPromptCharacters = usesStdin
      ? String(effectivePrompt).length
      : substitutedPromptCharacterCount(baseArgs, effectivePrompt);
    const projection = new ResolvedAgentInvocationProjection({
      providerKey: resolved.providerKey,
      profileKey: resolved.profileKey,
      command: profile.command,
      promptCharacterCount: transportedPromptCharacters
        + separatedSystemPromptCharacters
        + (schemaContent?.length ?? 0),
      systemPromptCharacterCount: systemPrompt ? String(systemPrompt).length : 0,
      schemaCharacterCount: schemaContent?.length ?? 0,
      finalArgs: transportedArgs,
      inlineArgvByteCount,
      schemaMode: projectedSchemaMode,
      usesStdin,
    });
    return new ResolvedAgentInvocationBlueprint({
      projection,
      projectedSchemaPath,
      schemaContent,
      missingSchemaProfileFields,
      executionEnvironment: normalizedExecutionEnvironment(options.executionEnvironment),
      stdinContent,
    });
  }

  async _callOnceWithRetry(resolved, prompt, options, retry, blueprint) {
    const maxAttempts = retry.retryCount + 1;
    let lastFailure = null;
    for (let attempt = 0; attempt <= retry.retryCount; attempt++) {
      await options.providerCallAdmission?.beforeProviderAttempt({
        attempt: attempt + 1,
        index: attempt,
        maxAttempts,
        providerKey: resolved.providerKey,
        profileKey: resolved.profileKey,
      });
      try {
        const result = await this._callOnce(resolved, prompt, options, blueprint);
        if (result.text) return result;
        lastFailure = new EmptyAgentResponseFailure()
          .recordAttempts(attempt + 1, maxAttempts);
      } catch (err) {
        lastFailure = AgentFailure.from(err)
          .recordAttempts(attempt + 1, maxAttempts);
      }
      if (!lastFailure.retryable) throw lastFailure;
      if (attempt < retry.retryCount) {
        const delayMs = retry instanceof AgentProviderRetryPolicy
          ? retry.delayBeforeRetry(attempt + 1)
          : retry.retryDelayMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt);
        await sleep(delayMs);
      }
    }
    throw lastFailure;
  }

  async _callOnce(resolved, prompt, options, blueprint) {
    const { provider, profile, providerKey, profileKey, timeoutMs: configuredTimeoutMs } = resolved;
    const timeoutMs = options.timeoutMs ?? configuredTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("agent per-call timeoutMs must be a positive number");
    const { finalArgs, env, stdinContent, pendingSchemaWrite } = blueprint.materialize({
      agentWorkDir: this._paths.agentWorkDir,
      commandId: options.commandId,
    });
    // A provider work-directory flag is an optional provider optimization,
    // not the execution-boundary mechanism.  An explicit per-call directory
    // is always the child cwd too, so flagless providers cannot fall back to
    // the canonical checkout through process.cwd().
    const cwd = options.spawnCwd || path.resolve(this._paths.root || process.cwd());

    if (pendingSchemaWrite) {
      await fs.promises.writeFile(pendingSchemaWrite.path, pendingSchemaWrite.content);
    }

    try {
      return await new Promise((resolve, reject) => {
        const platform = this._supervision.platform || process.platform;
        const spawnChild = this._supervision.spawn || spawn;
        const child = spawnChild(profile.command, finalArgs, {
          stdio: [stdinContent != null ? "pipe" : "ignore", "pipe", "pipe"],
          cwd,
          env,
          detached: platform !== "win32",
        });

        let stdinError = null;
        if (stdinContent != null) {
          child.stdin.on("error", (err) => {
            stdinError = err;
          });
          child.stdin.write(stdinContent, () => {
            child.stdin.end();
          });
        }

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          options.activityMonitor?.observeOutput();
          if (options.onStdout) options.onStdout(String(chunk));
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          options.activityMonitor?.observeOutput();
          if (options.onStderr) options.onStderr(String(chunk));
        });

        const supervisor = new ChildProcessSupervisor({
          child,
          timeoutMs,
          graceMs: this._supervision.graceMs || DEFAULT_AGENT_PROCESS_TREE_GRACE_MS,
          exitDrainMs: this._supervision.exitDrainMs || DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS,
          platform,
          runTaskkill: this._supervision.runTaskkill,
          onEvent: options.onSupervisorEvent,
          waitForProcessTree: options.waitForProcessTree === true,
          timeoutDiagnostic: options.timeoutDiagnostic,
        });

        const completion = supervisor.wait();
        if (options.activityMonitor) {
          options.activityMonitor.start((timeoutDiagnostic) => supervisor.timeout(timeoutDiagnostic));
        }
        completion.then(({ code, signal }) => {
          if (code === 0 && !signal && !stdinError) {
            const trimmed = String(stdout).trim();
            if (profile.jsonOutputFlag) {
              const parsed = tryParseProvider(provider, trimmed);
              resolve({
                ...(parsed ?? { text: trimmed, usage: null, cacheable: false }),
                stdout,
                stderr,
              });
            } else {
              resolve({ text: filterStreamingEvents(trimmed), usage: null, stdout, stderr });
            }
            return;
          }
          const parts = [];
          parts.push(`provider=${providerKey}`);
          parts.push(`profile=${profileKey}`);
          if (signal) parts.push(signal === "SIGTERM" ? "timeout" : `signal=${signal}`);
          if (code != null && code !== 0) parts.push(`exit=${code}`);
          if (stdinError) parts.push(`stdin=${stdinError.code || stdinError.message}`);
          if (stderr) parts.push(String(stderr).trim());
          const stdoutPreview = formatPreview(stdout);
          if (stdoutPreview) parts.push(`stdoutPreview=${stdoutPreview}`);
          const error = new Error(parts.join(" | ") || "unknown error");
          error.code = code;
          error.signal = signal;
          error.killed = signal === "SIGTERM";
          error.stdinError = stdinError || null;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }, (err) => {
          // The supervisor owns timeout rejection after stdout/stderr listeners
          // have accumulated lexical process output. Preserve that evidence.
          if (err instanceof AgentTimeoutError) {
            err.stdout = stdout;
            err.stderr = stderr;
          }
          reject(formatSpawnError(err, {
            command: profile.command,
            env,
            providerKey,
            profileKey,
            commandId: options.commandId,
          }));
        }).finally(() => options.activityMonitor?.stop());
      });
    } finally {
      if (pendingSchemaWrite) {
        await fs.promises.rm(pendingSchemaWrite.path, { force: true });
      }
    }
  }
}

class AgentTimeoutError extends AgentTimeoutFailure {
  constructor({ timeoutMs, graceMs, finalAction, timeoutDiagnostic = null, unterminatedMembers = [] }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("graceMs must be a positive number");
    if (!Array.isArray(unterminatedMembers) || !unterminatedMembers.every((member) => member instanceof UnterminatedProcessMember)) {
      throw new Error("unterminatedMembers must be process member diagnostics");
    }
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("timeout diagnostic is invalid");
    }
    const triggeringTimeoutMs = timeoutDiagnostic?.timeoutMs ?? timeoutMs;
    super({ message: timeoutDiagnostic === null
      ? `Agent timed out after ${timeoutMs}ms; final action=${finalAction}`
      : `Agent timed out after ${triggeringTimeoutMs}ms; reason=${timeoutDiagnostic.reason}; final action=${finalAction}` });
    this.name = "AgentTimeoutError";
    this.timeoutMs = triggeringTimeoutMs;
    this.graceMs = graceMs;
    this.finalAction = finalAction;
    if (timeoutDiagnostic !== null) this.timeoutReason = timeoutDiagnostic.reason;
    this.killed = true;
    this.unterminatedMembers = Object.freeze([...unterminatedMembers]);
  }
}

class PosixProcessMemberIdentity {
  constructor(stat) {
    if (!(stat instanceof LinuxProcessStat)) throw new Error("POSIX process member requires Linux process stat");
    this.pid = stat.pid;
    this.startFingerprint = stat.startFingerprint;
    Object.freeze(this);
  }

  matches(stat) {
    return stat instanceof LinuxProcessStat
      && stat.pid === this.pid
      && stat.startFingerprint === this.startFingerprint;
  }
}

class UnterminatedProcessMember {
  constructor(stat) {
    if (!(stat instanceof LinuxProcessStat)) throw new Error("unterminated process member requires Linux process stat");
    if (stat.state === "Z") throw new Error("unterminated process member cannot be a zombie");
    this.pid = stat.pid;
    this.state = stat.state;
    this.pgrp = stat.pgrp;
    this.startFingerprint = stat.startFingerprint;
    Object.freeze(this);
  }

  toJSON() {
    return {
      pid: this.pid,
      state: this.state,
      pgrp: this.pgrp,
      startFingerprint: this.startFingerprint,
    };
  }
}

class ChildProcessSupervisor {
  constructor({
    child,
    timeoutMs,
    graceMs,
    exitDrainMs = DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS,
    platform = process.platform,
    runTaskkill,
    onEvent,
    waitForProcessTree = false,
    timeoutDiagnostic = null,
  }) {
    if (!child || typeof child.on !== "function") throw new Error("child must be a ChildProcess");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("graceMs must be a positive number");
    if (!Number.isFinite(exitDrainMs) || exitDrainMs <= 0) throw new Error("exitDrainMs must be a positive number");
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;
    this.exitDrainMs = exitDrainMs;
    this.platform = platform;
    this.runTaskkill = runTaskkill || runWindowsTaskkill;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.waitForProcessTree = waitForProcessTree === true;
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("supervisor timeout diagnostic is invalid");
    }
    this.deadlineTimeoutDiagnostic = timeoutDiagnostic;
    this.deadlineTimer = null;
    this.graceTimer = null;
    this.treeDeathPollTimer = null;
    this.finalDeadlineTimer = null;
    this.exitDrainTimer = null;
    this.originalPosixMembers = null;
    this.timeoutOwned = false;
    this.directChildClosed = false;
    this.treeDeadObserved = false;
    this.settled = false;
    this.finalAction = null;
    this.timeoutDiagnostic = null;
    this._onClose = this._handleClose.bind(this);
    this._onExit = this._handleExit.bind(this);
    this._onError = this._handleError.bind(this);
  }

  wait() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.child.once("close", this._onClose);
      this.child.once("exit", this._onExit);
      this.child.once("error", this._onError);
      this._emit({ type: "spawn", pid: this.child.pid ?? null, detached: this.platform !== "win32" });
      this.deadlineTimer = setTimeout(() => this._handleTimeout(this.deadlineTimeoutDiagnostic), this.timeoutMs);
    });
  }

  _handleClose(code, signal) {
    if (this.settled) return;
    this.directChildClosed = true;
    this._emit({ type: "close", code, signal });
    if (!this.timeoutOwned) {
      if (this.waitForProcessTree && this.platform !== "win32") {
        this._waitForSuccessfulPosixTreeDeath(code, signal);
        return;
      }
      this._settleClose(code, signal);
      return;
    }
    this._trySettleTimedOutChild();
  }

  _handleExit(code, signal) {
    if (this.settled) return;
    this.directChildClosed = true;
    this._emit({ type: "exit", code, signal });
    if (this.timeoutOwned) {
      this._trySettleTimedOutChild();
      return;
    }
    if (this.waitForProcessTree) {
      if (this.platform !== "win32") {
        this._waitForSuccessfulPosixTreeDeath(code, signal);
      }
      // On Windows, `close` is the only built-in signal that inherited
      // provider handles are no longer keeping the process tree active.
      return;
    }
    // A descendant can inherit stdout/stderr and prevent ChildProcess's
    // `close` event after the direct provider process has exited. Give the
    // streams a brief chance to drain, then resolve from the direct exit so a
    // completed provider cannot strand the flow dispatcher indefinitely.
    this.exitDrainTimer = setTimeout(() => {
      if (!this.settled && this.directChildClosed && !this.timeoutOwned) {
        this._settleClose(code, signal);
      }
    }, this.exitDrainMs);
  }

  _handleError(error) {
    if (this.settled) return;
    this._emit({ type: "error", code: error?.code || null });
    if (!this.timeoutOwned) this._settleError(error);
  }

  timeout(timeoutDiagnostic) {
    if (!(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("supervisor timeout requires an agent timeout diagnostic");
    }
    this._handleTimeout(timeoutDiagnostic);
  }

  _handleTimeout(timeoutDiagnostic = null) {
    if (this.settled || this.timeoutOwned) return;
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) throw new Error("timeout diagnostic is invalid");
    this.timeoutOwned = true;
    this.timeoutDiagnostic = timeoutDiagnostic;
    if (this.treeDeathPollTimer) clearTimeout(this.treeDeathPollTimer);
    this.treeDeathPollTimer = null;
    this._emit({ type: "timeout", ...(timeoutDiagnostic === null ? {} : { reason: timeoutDiagnostic.reason }) });
    if (this.platform === "win32") {
      this._signalDirectChild("SIGTERM");
    } else {
      this._captureOriginalPosixMembers();
      this._signalProcessGroup("SIGTERM");
    }
    this.graceTimer = setTimeout(() => this._handleGraceExpiry(), this.graceMs);
  }

  _handleGraceExpiry() {
    if (this.settled || !this.timeoutOwned) return;
    this._emit({ type: "grace-expiry" });
    if (this.platform === "win32") {
      this._forceWindowsTree();
      return;
    }
    this.finalAction = "SIGKILL";
    this._signalProcessGroup("SIGKILL");
    this._waitForPosixTreeDeath();
  }

  _signalDirectChild(signal) {
    this.finalAction = signal;
    try { this.child.kill(signal); } catch (_) {}
    this._emit({ type: "signal", signal, target: "direct-child" });
  }

  _signalProcessGroup(signal) {
    this.finalAction = signal;
    try { process.kill(-this.child.pid, signal); } catch (_) {}
    this._emit({ type: "signal", signal, target: "process-group" });
  }

  async _forceWindowsTree() {
    const args = ["/PID", String(this.child.pid), "/T", "/F"];
    try {
      const result = await this.runTaskkill(args);
      if (this.settled) return;
      this.finalAction = "taskkill /T /F";
      this.treeDeadObserved = result?.completed === true;
      this._emit({ type: "taskkill", completed: this.treeDeadObserved });
      if (this.treeDeadObserved) this._emit({ type: "tree-dead", probe: "taskkill-complete" });
      this._trySettleTimedOutChild();
    } catch (error) {
      if (!this.settled) this._settleError(error);
    }
  }

  _trySettleTimedOutChild() {
    if (!this.timeoutOwned || !this.directChildClosed || this.settled) return;
    if (this.platform === "win32") {
      if (this.treeDeadObserved) this._settleTimeout();
      return;
    }
    if (this._isPosixTreeDead()) {
      this._markPosixTreeDead();
      this._settleTimeout();
    }
  }

  _isPosixTreeDead() {
    if (!this.child.pid) return true;
    try {
      process.kill(-this.child.pid, 0);
      return processGroupHasNoLiveMembers(
        this.child.pid,
        this.originalPosixMembers,
        this._reportTreeMembersUnavailable.bind(this),
      );
    } catch (error) {
      if (error?.code !== "ESRCH") {
        this._emit({ type: "tree-members-unavailable", code: error?.code || "UNKNOWN" });
      }
      return error?.code === "ESRCH";
    }
  }

  _captureOriginalPosixMembers() {
    const members = readLinuxProcessGroupMembers(this.child.pid, this._reportTreeMembersUnavailable.bind(this));
    this.originalPosixMembers = members == null
      ? null
      : new Map(members.map((stat) => [stat.pid, new PosixProcessMemberIdentity(stat)]));
  }

  _collectOriginalUnterminatedPosixMembers() {
    if (!(this.originalPosixMembers instanceof Map)) return [];
    const members = readLinuxProcessGroupMembers(
      this.child.pid,
      this._reportTreeMembersUnavailable.bind(this),
      this.originalPosixMembers,
    );
    if (members == null) return [];
    return members
      .filter((member) => this.originalPosixMembers.get(member.pid)?.matches(member) && member.state !== "Z")
      .map((member) => new UnterminatedProcessMember(member));
  }

  _reportTreeMembersUnavailable(error) {
    this._emit({ type: "tree-members-unavailable", code: error?.code || "UNKNOWN" });
  }

  _markPosixTreeDead() {
    if (this.treeDeadObserved) return;
    this.treeDeadObserved = true;
    this._emit({ type: "tree-dead", probe: "ESRCH" });
  }

  _waitForPosixTreeDeath() {
    this.finalDeadlineTimer = setTimeout(() => {
      if (!this.settled) this._settleTimeout();
    }, this.graceMs);
    const poll = () => {
      if (this.settled) return;
      if (this._isPosixTreeDead()) {
        this._markPosixTreeDead();
        this._trySettleTimedOutChild();
        return;
      }
      this.treeDeathPollTimer = setTimeout(poll, PROCESS_DEATH_POLL_MS);
    };
    poll();
  }

  _waitForSuccessfulPosixTreeDeath(code, signal) {
    if (this.settled || this.timeoutOwned || this.treeDeathPollTimer) return;
    const poll = () => {
      this.treeDeathPollTimer = null;
      if (this.settled || this.timeoutOwned) return;
      if (this._isPosixTreeDead()) {
        this._markPosixTreeDead();
        this._settleClose(code, signal);
        return;
      }
      this.treeDeathPollTimer = setTimeout(poll, PROCESS_DEATH_POLL_MS);
    };
    poll();
  }

  _settleClose(code, signal) {
    this._cleanup();
    this._emit({ type: "settled", outcome: "close" });
    this.resolve({ code, signal });
  }

  _settleError(error) {
    this._cleanup();
    this._emit({ type: "settled", outcome: "error" });
    this.reject(error);
  }

  _settleTimeout() {
    this._cleanup();
    this._emit({ type: "settled", outcome: "timeout" });
    this.reject(new AgentTimeoutError({
      timeoutMs: this.timeoutMs,
      graceMs: this.graceMs,
      finalAction: this.finalAction || "SIGTERM",
      timeoutDiagnostic: this.timeoutDiagnostic,
      unterminatedMembers: this._collectOriginalUnterminatedPosixMembers(),
    }));
  }

  _cleanup() {
    if (this.settled) return;
    this.settled = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.treeDeathPollTimer) clearTimeout(this.treeDeathPollTimer);
    if (this.finalDeadlineTimer) clearTimeout(this.finalDeadlineTimer);
    if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
    this.deadlineTimer = null;
    this.graceTimer = null;
    this.treeDeathPollTimer = null;
    this.finalDeadlineTimer = null;
    this.exitDrainTimer = null;
    this.child.removeListener("close", this._onClose);
    this.child.removeListener("exit", this._onExit);
    this.child.removeListener("error", this._onError);
    this._emit({
      type: "cleanup",
      closeListeners: this.child.listenerCount("close"),
      errorListeners: this.child.listenerCount("error"),
      activeTimers: this._activeTimerCount(),
    });
  }

  _activeTimerCount() {
    return [this.deadlineTimer, this.graceTimer, this.treeDeathPollTimer, this.finalDeadlineTimer, this.exitDrainTimer]
      .filter((timer) => timer !== null)
      .length;
  }

  _emit(event) {
    try { this.onEvent?.(event); } catch (_) {}
  }
}

function readLinuxProcessGroupMembers(groupId, reportUnavailable, originalMembers = null) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch (error) {
    reportUnavailable(error);
    return null;
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const member = LinuxProcessStat.parse(fs.readFileSync(path.join("/proc", entry, "stat"), "utf8"));
      if (member.pgrp === groupId) members.push(member);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      reportUnavailable(error);
      if (!(originalMembers instanceof Map) || originalMembers.has(Number(entry))) return null;
    }
  }
  return members;
}

function processGroupHasNoLiveMembers(groupId, originalMembers, reportUnavailable) {
  const members = readLinuxProcessGroupMembers(groupId, reportUnavailable, originalMembers);
  if (members == null) return false;
  return members.length > 0 && members.every((member) => {
    const original = originalMembers?.get(member.pid);
    return member.state === "Z" || (original && !original.matches(member));
  });
}

function runWindowsTaskkill(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("taskkill", args, { windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ completed: true });
      else reject(new Error(`taskkill failed with exit=${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

class PromptCachePolicy {
  constructor(mode = "default") {
    const normalized = mode ?? "default";
    if (!new Set(["default", "bypass", "refresh"]).has(normalized)) {
      throw new Error(`invalid cacheMode: ${normalized}`);
    }
    this.mode = normalized;
    this.readsCache = normalized === "default";
    this.writesCache = normalized === "default" || normalized === "refresh";
    Object.freeze(this);
  }
}

class PromptCacheIdentity {
  constructor(input = {}) {
    this.commandId = input.commandId ?? null;
    this.provider = input.provider ?? null;
    this.profileKey = input.profileKey ?? null;
    this.invocation = input.invocation instanceof PromptCacheInvocation
      ? input.invocation
      : new PromptCacheInvocation(input.invocation || {});
    this.systemPrompt = input.systemPrompt ?? null;
    this.userPrompt = input.userPrompt ?? null;
    this.jsonSchema = input.jsonSchema ?? null;
    this.fmtFallback = input.fmtFallback ?? null;
  }

  static from({ resolved, prompt, options = {} }) {
    return new PromptCacheIdentity({
      commandId: options.commandId ?? null,
      provider: resolved.providerKey,
      profileKey: resolved.profileKey,
      invocation: PromptCacheInvocation.fromProfile(resolved.profile),
      systemPrompt: options.systemPrompt ?? null,
      userPrompt: prompt,
      jsonSchema: options.jsonSchema ?? null,
      fmtFallback: options.fmtFallback ?? null,
    });
  }

  toJSON() {
    return {
      commandId: this.commandId,
      provider: this.provider,
      profileKey: this.profileKey,
      invocation: this.invocation.toJSON(),
      systemPrompt: this.systemPrompt,
      userPrompt: this.userPrompt,
      jsonSchema: this.jsonSchema,
      fmtFallback: this.fmtFallback,
    };
  }

  toKeyMaterial() {
    return stableStringify(this.toJSON());
  }
}

class PromptCacheInvocation {
  constructor(input = {}) {
    this.command = input.command ?? null;
    this.args = Array.isArray(input.args) ? [...input.args] : [];
    this.jsonOutputFlag = input.jsonOutputFlag ?? null;
    this.jsonSchemaFlag = input.jsonSchemaFlag ?? null;
    this.jsonSchemaMode = input.jsonSchemaMode ?? null;
  }

  static fromProfile(profile = {}) {
    return new PromptCacheInvocation({
      command: profile.command,
      args: profile.args,
      jsonOutputFlag: profile.jsonOutputFlag,
      jsonSchemaFlag: profile.jsonSchemaFlag,
      jsonSchemaMode: profile.jsonSchemaMode,
    });
  }

  toJSON() {
    return {
      command: this.command,
      args: this.args,
      jsonOutputFlag: this.jsonOutputFlag,
      jsonSchemaFlag: this.jsonSchemaFlag,
      jsonSchemaMode: this.jsonSchemaMode,
    };
  }
}

class AgentPromptCache {
  constructor({ root, specId }) {
    this.root = path.resolve(root);
    this.specId = String(specId);
    const rootAuthority = new RealDirectoryAuthority(this.root);
    this.managedDirectory = new RealDirectoryAuthority(path.join(this.root, PRODUCT.managedDirName), {
      create: true,
      parentAuthority: rootAuthority,
    });
    this.directory = new RealDirectoryAuthority(path.join(this.managedDirectory.directory, "agent-cache"), {
      create: true,
      parentAuthority: this.managedDirectory,
    });
    const fileName = `${cacheFileName(specId)}.json`;
    this.filePath = path.join(this.directory.directory, fileName);
    this.lock = new FileLock({
      directoryAuthority: this.directory,
      fileName: `.${fileName}.lock`,
      kind: "agent-prompt-cache",
      authority: { specId: this.specId },
      waitPolicy: new FileLockWaitPolicy({
        timeoutMs: PROMPT_CACHE_LOCK_WAIT_TIMEOUT_MS,
        intervalMs: PROMPT_CACHE_LOCK_RETRY_MS,
      }),
    });
    Object.freeze(this);
  }

  get(key) {
    const store = this.read();
    const entry = store.entries[key] || null;
    if (!entry || typeof entry.text !== "string") return null;
    return entry.text;
  }

  async set(key, text) {
    await this.mutate((store) => {
      store.entries[key] = {
        text: String(text),
        storedAt: new Date().toISOString(),
      };
      return true;
    });
  }

  async removeIfMatches(key, text) {
    await this.mutate((store) => {
      const entry = store.entries[key];
      if (!entry || entry.text !== text) return false;
      delete store.entries[key];
      return true;
    });
  }

  async mutate(change) {
    if (typeof change !== "function") throw new Error("agent prompt cache mutation requires a function");
    this.managedDirectory.ensure();
    this.directory.ensure();
    await this.lock.runExclusiveAsync(async () => {
      // Read after exclusive admission: two provider processes can complete
      // concurrently without one plain read-modify-write discarding the
      // other's response for the same spec cache.
      const store = this.read();
      if (change(store) === true) this.write(store);
    });
  }

  read() {
    if (!fs.existsSync(this.filePath)) return this.emptyStore();
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!data || typeof data !== "object" || data.version !== 1 || !data.entries || typeof data.entries !== "object") {
        return this.emptyStore();
      }
      return data;
    } catch (_) {
      return this.emptyStore();
    }
  }

  write(store) {
    this.directory.ensure();
    new AtomicFile(this.filePath, { phaseNamespace: "agent-prompt-cache" })
      .write(Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8"));
  }

  emptyStore() {
    return { version: 1, entries: {} };
  }
}

function resolvePromptCacheContext(flowManager) {
  if (!flowManager) return null;
  try {
    const context = flowManager.resolveCurrentContext();
    if (!context?.specId) return null;
    const activeFlows = typeof flowManager.loadActiveFlows === "function"
      ? flowManager.loadActiveFlows()
      : [];
    if (!activeFlows.some((entry) => entry.specId === context.specId)) return null;
    return context;
  } catch (_) {
    return null;
  }
}

function formatSpawnError(err, { command, env, providerKey, profileKey, commandId }) {
  if (err?.code !== "ENOENT") return err;

  const diagnostic = new Error([
    "agent command not found",
    `command=${command || "unknown"}`,
    `PATH=${env?.PATH ?? ""}`,
    `candidates=${formatCommandCandidates(command, env?.PATH)}`,
    `provider=${providerKey || "unknown"}`,
    `profile=${profileKey || "unknown"}`,
    `commandId=${commandId || "unknown"}`,
    "guidance=add the target CLI to the PATH of the environment that starts sennel, or configure the provider command as an absolute path",
  ].join(" | "));

  diagnostic.name = err.name || "Error";
  diagnostic.cause = err;
  for (const key of ["code", "errno", "syscall", "path", "spawnargs"]) {
    if (err[key] != null) diagnostic[key] = err[key];
  }
  return diagnostic;
}

function formatCommandCandidates(command, pathValue) {
  const commandText = String(command || "");
  if (!commandText) return "none";
  if (path.isAbsolute(commandText) || commandText.includes("/") || commandText.includes("\\")) {
    return commandText;
  }

  const entries = String(pathValue || "").split(path.delimiter).filter(Boolean);
  if (entries.length === 0) return commandText;

  const maxCandidates = 8;
  const candidates = entries.slice(0, maxCandidates).map((entry) => path.join(entry, commandText));
  const omitted = entries.length - candidates.length;
  if (omitted > 0) candidates.push(`...(+${omitted} more)`);
  return candidates.join(",");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cacheFileName(specId) {
  return String(specId || "no-spec").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function argvByteLength(args) {
  return args.reduce((sum, argument) => sum + Buffer.byteLength(String(argument)), 0);
}

function argvMaxElementByteLength(args) {
  return args.reduce((maximum, argument) => Math.max(maximum, Buffer.byteLength(String(argument))), 0);
}

function normalizeProjectionCharacterLimit(limit) {
  const normalized = Number(limit);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error("agent invocation projection limit must be a positive integer");
  }
  return normalized;
}

class AgentResolutionAttempt {
  constructor({
    agentSection,
    commandId,
    providerOverride,
    profileSource,
    profileName,
    selectedProfileKey,
    selectedProfileSource,
    lookupKey,
  }) {
    this.agentSection = agentSection || {};
    this.commandId = commandId || "unknown";
    this.providerOverride = providerOverride || null;
    this.profileSource = profileSource || "none";
    this.profileName = profileName || null;
    this.selectedProfileKey = selectedProfileKey || null;
    this.selectedProfileSource = selectedProfileSource || "none";
    this.lookupKey = lookupKey || null;
  }

  static from({ agentSection, commandId, options = {} }) {
    const section = agentSection || {};
    const profileSelection = resolveProfileSelection(section, commandId, {
      profileName: options.profile,
    });
    const selectedProfileKey = normalizeSelectedProfileKey(profileSelection);
    const lookupKey = resolveProviderOverrideKey(options.provider, selectedProfileKey);
    return new AgentResolutionAttempt({
      agentSection: section,
      commandId,
      providerOverride: options.provider || null,
      profileSource: profileSelection.profileSource,
      profileName: profileSelection.profileName,
      selectedProfileKey,
      selectedProfileSource: profileSelection.keySource,
      lookupKey,
    });
  }

  toResolved(resolved) {
    const timeoutMs = AgentTimeout.fromConfig(this.agentSection).toMilliseconds();
    return {
      provider: resolved.provider,
      profile: resolved.profile,
      providerKey: resolved.providerKey,
      profileKey: this.lookupKey,
      timeoutMs,
    };
  }

  formatFailure() {
    return [
      "No agent configured.",
      `commandId=${this.commandId}`,
      `providerOverride=${this.providerOverride || "none"}`,
      `profileSource=${this.profileSource}`,
      `activeProfile=${this.profileName || "none"}`,
      `default=${this.agentSection.default || "none"}`,
      `selected=${this.selectedProfileKey || "none"}`,
      `lookup=${this.lookupKey || "none"}`,
      "reason=no provider resolved",
      "Set 'agent.default' in config.json or run 'sennel setup'.",
    ].join(" ");
  }
}

class ProfileSelection {
  constructor({ profileSource, profileName, keySource, key }) {
    this.profileSource = profileSource || "none";
    this.profileName = profileName || null;
    this.keySource = keySource || "none";
    this.key = key || null;
  }
}

function matchProfilePrefix(profile, commandId) {
  if (!commandId) return null;
  let bestKey = null;
  let bestLen = -1;
  for (const [prefix, providerKey] of Object.entries(profile)) {
    if (commandId === prefix || commandId.startsWith(prefix + ".")) {
      if (prefix.length > bestLen) {
        bestLen = prefix.length;
        bestKey = providerKey;
      }
    }
  }
  return bestKey;
}

function resolveProfileSelection(agentSection, commandId, options = {}) {
  const defaultKey = agentSection.default;
  const profileSource = options.profileName
    ? "explicitProfile"
    : process.env[PRODUCT.env("PROFILE")]
      ? PRODUCT.env("PROFILE")
      : agentSection.useProfile
        ? "useProfile"
        : "none";
  const profileName = options.profileName || process.env[PRODUCT.env("PROFILE")] || agentSection.useProfile || null;
  if (!profileName) {
    return new ProfileSelection({ profileSource, profileName, keySource: "default", key: defaultKey });
  }

  const profiles = resolveAgentProfiles(agentSection);
  if (!profiles || !profiles[profileName]) {
    throw new Error(`Profile "${profileName}" is not defined in built-in profiles or agent.profiles.`);
  }

  const activeMatch = matchProfilePrefix(profiles[profileName], commandId);
  if (activeMatch) {
    return new ProfileSelection({ profileSource, profileName, keySource: "activeProfile", key: activeMatch });
  }

  const defaultProfileMatch = matchDefaultProfileFallback(profiles, profileName, commandId);
  if (defaultProfileMatch) {
    return new ProfileSelection({ profileSource, profileName, keySource: "defaultProfile", key: defaultProfileMatch });
  }

  return new ProfileSelection({ profileSource, profileName, keySource: "default", key: defaultKey });
}

function resolveAgentProfiles(agentSection) {
  return {
    ...defaultAgentProfiles(),
    ...(agentSection.profiles || {}),
  };
}

function resolveProfileKey(agentSection, commandId, options = {}) {
  return normalizeSelectedProfileKey(resolveProfileSelection(agentSection, commandId, options));
}

function normalizeSelectedProfileKey(selection) {
  if (!selection?.key) return null;
  if (selection.keySource !== "default") return selection.key;
  return DEFAULT_PROVIDER_FAMILY_ALIASES[selection.key] || selection.key;
}

function resolveProviderOverrideKey(providerKey, selectedProfileKey) {
  if (!providerKey) return selectedProfileKey;
  if (selectedProfileKey && selectedProfileKey.startsWith(`${providerKey}/`)) return selectedProfileKey;
  return providerKey;
}

function matchDefaultProfileFallback(profiles, profileName, commandId) {
  if (profileName === "default" || !profiles.default) return null;
  return matchProfilePrefix(profiles.default, commandId);
}

function substitutePromptToken(args, prompt) {
  const hasToken = args.some((a) => typeof a === "string" && a.includes("{{PROMPT}}"));
  if (hasToken) {
    // A replacement function preserves `$&`, `$1`, and other replacement
    // syntax as literal prompt content.
    return args.map((a) => (
      typeof a === "string" ? a.replaceAll("{{PROMPT}}", () => prompt) : a
    ));
  }
  return [...args, prompt];
}

function substitutedPromptCharacterCount(args, prompt) {
  const templates = args.filter((argument) => typeof argument === "string" && argument.includes("{{PROMPT}}"));
  if (templates.length === 0) return String(prompt).length;
  return templates.reduce(
    (total, template) => total + template.replaceAll("{{PROMPT}}", () => prompt).length,
    0,
  );
}

function stripPromptArgs(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === "string" && args[i].includes("{{PROMPT}}")) {
      if (result.length > 0 && ["-p", "--print"].includes(result[result.length - 1])) {
        result.pop();
      }
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

function injectWorkDirFlag(flag, workDir, args) {
  if (!flag || !workDir) return args;
  const existing = args.indexOf(flag);
  if (existing !== -1) {
    const next = [...args];
    next[existing + 1] = workDir;
    return next;
  }
  if (args.length > 0 && !args[0].startsWith("-")) {
    return [args[0], flag, workDir, ...args.slice(1)];
  }
  return [flag, workDir, ...args];
}

function ensureWorkDir(workDir) {
  if (!workDir) return;
  fs.mkdirSync(workDir, { recursive: true });
}

const STREAMING_EVENT_PATTERN = /^\s*\{[^}]*"type"\s*:\s*"(message_start|message_delta|message_stop|content_block_start|content_block_delta|content_block_stop)"/;

function filterStreamingEvents(text) {
  const lines = text.split("\n");
  const result = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inCodeBlock = !inCodeBlock;
    if (inCodeBlock) { result.push(line); continue; }
    if (STREAMING_EVENT_PATTERN.test(line)) continue;
    result.push(line);
  }
  return result.join("\n");
}

function tryParseProvider(provider, stdout) {
  try {
    return provider.parse(stdout);
  } catch (err) {
    process.stderr.write(`[sennel] agent output parse failed (${provider.constructor.name}): ${err.message}\n`);
    return null;
  }
}

function reportMissingJsonSchemaProfileFields({ commandId, profileKey, missing }) {
  if (!missing || missing.length === 0) return;
  process.stderr.write(
    `[sennel] agent: jsonSchema requested but resolved profile is missing ${missing.join(", ")} ` +
    `(commandId=${commandId || "unknown"}, profile=${profileKey || "unknown"})\n`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithLogging({
  logger,
  flowManager,
  command,
  systemPrompt,
  prompt,
  provider,
  profileKey,
  flowAttribution,
  deferredMetric,
  invoke,
}) {
  const requestId = generateRequestId();
  const startedAt = Date.now();
  const logAttribution = flowAttribution.usesFlowState
    ? {}
    : { flowContext: flowAttribution.logContext };
  await logger.agent({ phase: "start", requestId, ...logAttribution });

  let result = null;
  let err = null;
  try {
    result = await invoke();
    return result.text;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    const text = result?.text ?? null;
    const usage = result?.usage ?? null;
    const responseStats = textStats(text);
    const payload = {
      agentKey: command ?? null,
      model: null,
      prompt: { system: systemPrompt, user: prompt },
      response: {
        text,
        stdout: result?.stdout ?? err?.stdout ?? null,
        stderr: result?.stderr ?? err?.stderr ?? null,
        exitCode: err ? (err.code ?? 1) : 0,
        error: err ? err.message : null,
      },
      usage,
      durationSec: (Date.now() - startedAt) / 1000,
    };
    const diagnosticLog = await logger.agent({ phase: "end", requestId, ...payload, ...logAttribution });
    if (err && diagnosticLog) {
      err.diagnosticLog = diagnosticLog;
      err.message += ` | diagnosticLog=${diagnosticLog}`;
    }

    // Metric accumulation is the Agent's responsibility: it runs independently
    // of cfg.logs.enabled so the typed Activity projection stays current (R3).
    if (flowAttribution.usesFlowState && flowManager) {
      await persistAgentInvocationMetric({
        flowManager,
        provider,
        profileKey,
        usage,
        responseChars: responseStats.chars,
        model: null,
        durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
      }, deferredMetric);
    }
  }
}

function textStats(s) {
  if (s == null) return { chars: 0, lines: 0 };
  const str = String(s);
  return { chars: str.length, lines: str.length === 0 ? 0 : str.split("\n").length };
}

class PluginAgentApi {
  constructor({ pluginId, pluginConfig = {}, agent, flowAttribution = "ambient" }) {
    if (!pluginId) throw new Error("pluginId is required");
    if (!agent || typeof agent.call !== "function") throw new Error("agent.call is required");
    this.pluginId = pluginId;
    this.pluginConfig = pluginConfig;
    this.agent = agent;
    this.flowAttribution = new FlowAttributionPolicy(flowAttribution);
    Object.freeze(this);
  }

  resolve(commandId, options = {}) {
    if (typeof this.agent.resolve !== "function") return null;
    const resolvedOptions = this.#options(commandId, options);
    return this.agent.resolve(resolvedOptions.commandId, resolvedOptions);
  }

  call(prompt, options = {}) {
    const resolvedOptions = this.#options(options.commandId, options);
    return this.agent.call(prompt, resolvedOptions);
  }

  projectInvocation(prompt, options = {}) {
    if (typeof this.agent.projectInvocation !== "function") {
      throw new Error("agent.projectInvocation is required");
    }
    const resolvedOptions = this.#options(options.commandId, options);
    return this.agent.projectInvocation(prompt, resolvedOptions);
  }

  #options(commandId, options) {
    const namespacedCommandId = commandId?.includes(".")
      ? commandId
      : `${this.pluginId}.${commandId || "default"}`;
    const boundAttribution = this.flowAttribution.usesFlowState
      && !Object.hasOwn(options, "flowAttribution")
      ? {}
      : { flowAttribution: this.flowAttribution.mode };
    return {
      ...options,
      commandId: namespacedCommandId,
      ...(this.pluginConfig.provider ? { provider: this.pluginConfig.provider } : {}),
      ...(options.profile || this.pluginConfig.agentProfile
        ? { profile: options.profile || this.pluginConfig.agentProfile }
        : {}),
      ...boundAttribution,
    };
  }
}

export function createPluginAgentApi(options) {
  return new PluginAgentApi(options);
}

export { Agent, AgentTimeoutError, ChildProcessSupervisor, filterStreamingEvents };
