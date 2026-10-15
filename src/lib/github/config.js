/**
 * GitHub provider configuration and resolution.
 */

import { GitHubRepository } from "./values.js";

export const DEFAULT_GITHUB_TIMEOUT = 30_000;
export const MAX_GITHUB_TIMEOUT = 2_147_483_647;
export const MAX_GITHUB_BUFFER = Number.MAX_SAFE_INTEGER;
export const DEFAULT_GITHUB_MAX_BUFFER = 4_194_304;
export const DEFAULT_GITHUB_MAX_ATTEMPTS = 2;

/** Resolved GitHub provider settings used by both provider adapters. */
export class GitHubProviderConfig {
  constructor({ provider, command, args, timeout, maxBuffer, maxAttempts, repository }) {
    if (typeof provider !== "string" || provider.length === 0) throw new Error("GitHub provider is required");
    if (typeof command !== "string" || command.trim() === "") throw new Error("GitHub command must be a non-empty executable");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("GitHub args must be an array of strings");
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_GITHUB_TIMEOUT) throw new Error(`GitHub timeout must be a positive integer no greater than ${MAX_GITHUB_TIMEOUT} milliseconds`);
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) throw new Error("GitHub maxBuffer must be a positive safe integer");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("GitHub maxAttempts must be an integer from 1 through 5");
    if (repository != null && !(repository instanceof GitHubRepository)) throw new Error("GitHub repository must be a GitHubRepository");
    this.provider = provider;
    this.command = command;
    this.args = Object.freeze([...args]);
    this.timeout = timeout;
    this.maxBuffer = maxBuffer;
    this.maxAttempts = maxAttempts;
    this.repository = repository;
    Object.freeze(this);
  }
}

/** Resolve the selected provider and reject invalid direct-call configuration. */
export function resolveGitHubConfig(config = {}) {
  const errors = [];
  validateGitHubConfig(config, errors);
  if (errors.length > 0) throw new Error(`GitHub configuration validation failed:\n  - ${errors.join("\n  - ")}`);
  const github = config.github || {};
  const provider = github.provider ?? "gh";
  const named = provider === "gh" ? null : github.providers?.[provider];
  const settings = named ?? github;
  return new GitHubProviderConfig({
    provider,
    command: named?.command || "gh",
    args: named?.args || [],
    timeout: settings.timeout ?? DEFAULT_GITHUB_TIMEOUT,
    maxBuffer: settings.maxBuffer ?? DEFAULT_GITHUB_MAX_BUFFER,
    maxAttempts: settings.maxAttempts ?? DEFAULT_GITHUB_MAX_ATTEMPTS,
    repository: github.repository ? GitHubRepository.fromJSON(github.repository) : null,
  });
}

/** Append GitHub provider configuration errors without throwing. */
export function validateGitHubConfig(config, errors) {
  const github = config.github;
  if (github === undefined) return;
  if (!github || typeof github !== "object" || Array.isArray(github)) {
    errors.push("'github' must be an object");
    return;
  }

  const githubKeys = new Set(["provider", "providers", "timeout", "maxBuffer", "maxAttempts", "repository"]);
  for (const key of Object.keys(github)) if (!githubKeys.has(key)) errors.push(`'github.${key}': unknown field`);

  const provider = github.provider ?? "gh";
  if (provider !== "gh" && !Object.hasOwn(github.providers || {}, provider)) {
    errors.push("'github.provider': unknown provider");
  }
  if (github.provider !== undefined && (typeof github.provider !== "string" || github.provider.trim() === "")) errors.push("'github.provider' must be a non-empty name");
  if (github.providers !== undefined && (!github.providers || typeof github.providers !== "object" || Array.isArray(github.providers))) {
    errors.push("'github.providers' must be an object");
    return;
  }
  if (github.providers && Object.hasOwn(github.providers, "gh")) {
    errors.push("'github.providers.gh': reserved for the built-in provider");
  }
  for (const [name, entry] of Object.entries(github.providers || {})) {
    if (name === "gh") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`'github.providers.${name}' must be an object`);
      continue;
    }
    const providerKeys = new Set(["command", "args", "timeout", "maxBuffer", "maxAttempts"]);
    for (const key of Object.keys(entry)) if (!providerKeys.has(key)) errors.push(`'github.providers.${name}.${key}': unknown field`);
    if (typeof entry.command !== "string" || entry.command.trim() === "") errors.push(`'github.providers.${name}.command' must be a non-empty executable`);
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) errors.push(`'github.providers.${name}.args' must be an array of strings`);
  }

  for (const [key, source] of [["github", github], ...Object.entries(github.providers || {}).filter(([name]) => name !== "gh").map(([name, entry]) => [`github.providers.${name}`, entry])]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    if (source.timeout != null && (!Number.isSafeInteger(source.timeout) || source.timeout <= 0 || source.timeout > MAX_GITHUB_TIMEOUT)) errors.push(`'${key}.timeout' must be a positive integer no greater than ${MAX_GITHUB_TIMEOUT} milliseconds`);
    if (source.maxBuffer != null && (!Number.isSafeInteger(source.maxBuffer) || source.maxBuffer <= 0)) errors.push(`'${key}.maxBuffer' must be a positive safe integer`);
    if (source.maxAttempts != null && (!Number.isInteger(source.maxAttempts) || source.maxAttempts < 1 || source.maxAttempts > 5)) errors.push(`'${key}.maxAttempts' must be an integer from 1 through 5`);
  }

  if (github.repository && (typeof github.repository !== "object" || Array.isArray(github.repository))) {
    errors.push("'github.repository' must be an object");
    return;
  }
  if (github.repository) {
    if (Object.keys(github.repository).some((key) => key !== "host" && key !== "name")) errors.push("'github.repository' contains an unknown field");
    try { GitHubRepository.fromJSON(github.repository); }
    catch { errors.push("'github.repository' must contain a valid host and owner/repository name"); }
  }
}
