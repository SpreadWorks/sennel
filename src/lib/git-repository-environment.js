import { immutableCommandEnvironment, NativeExecutableInvocation } from "./command-invocation.js";
import os from "node:os";
import path from "node:path";

/**
 * Remove inherited Git variables that can relocate a Git command away from
 * its explicit working directory. Callers that establish a repository
 * boundary use this for both their own Git commands and any child surface
 * they pass to an untrusted tool.
 */
export const GIT_REPOSITORY_LOCATION_ENVIRONMENT = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_TEMPLATE_DIR",
  "GIT_ATTR_NOSYSTEM",
  "GIT_ATTR_SOURCE",
]);

const GIT_CONFIG_INJECTION_PREFIXES = Object.freeze([
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
]);

function removeGitConfigInjections(environment, names) {
  const reserved = new Set(names);
  for (const name of Object.keys(environment)) {
    const canonical = name.toUpperCase();
    if (reserved.has(canonical) || GIT_CONFIG_INJECTION_PREFIXES.some((prefix) => canonical.startsWith(prefix))) delete environment[name];
  }
  return environment;
}

export function sanitizeGitRepositoryEnvironment(environment = process.env, { repositoryRoot = null, isolateConfiguration = true } = {}) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Git repository environment must be an object");
  }
  const sanitized = removeGitConfigInjections({ ...immutableCommandEnvironment(environment) }, GIT_REPOSITORY_LOCATION_ENVIRONMENT);
  // Do not fall back to inherited global/system config: either may set
  // core.worktree/core.gitDir and redirect an otherwise explicit `git -C`.
  // HOME remains available for normal provider credentials and other tools.
  if (isolateConfiguration) {
    sanitized.GIT_CONFIG_GLOBAL = os.devNull;
    sanitized.GIT_CONFIG_NOSYSTEM = "1";
  }
  if (repositoryRoot !== null) {
    // The selected project may be nested inside another repository. Discovery
    // must never substitute that ancestor for an explicit repository boundary.
    sanitized.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(repositoryRoot));
  }
  return sanitized;
}

/** A normal repository command cannot inherit alternate index/object/worktree authority. */
export class GitRepositoryPolicy {
  constructor({ repositoryRoot = null, readOnly = false, isolateConfiguration = false } = {}) {
    this.repositoryRoot = repositoryRoot;
    this.readOnly = readOnly;
    this.isolateConfiguration = isolateConfiguration;
    if (new.target === GitRepositoryPolicy) Object.freeze(this);
  }
  environment(environment = process.env) {
    const sanitized = sanitizeGitRepositoryEnvironment(environment, { repositoryRoot: this.repositoryRoot, isolateConfiguration: this.isolateConfiguration });
    if (this.readOnly) sanitized.GIT_OPTIONAL_LOCKS = '0';
    return Object.freeze(sanitized);
  }
  arguments(args) { return [...args]; }
  invocation(args, { cwd = null, env = process.env, stdio = "pipe" } = {}) {
    return new NativeExecutableInvocation({ executable: "git", args: this.arguments(args), cwd, env: this.environment(env), stdio });
  }
}

/** Explicit writer capability for scratch repositories, indexes and object stores. */
export class GitOwnedStagePolicy extends GitRepositoryPolicy {
  constructor({ repositoryRoot, gitDir = null, workTree = null, indexFile = null, objectDirectory = null, templateDirectory = null, attributesFile = null, restore = false }) {
    super({ repositoryRoot, isolateConfiguration: true });
    for (const [key, value] of Object.entries({ gitDir, workTree, indexFile, objectDirectory, templateDirectory, attributesFile })) {
      if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value))) throw new TypeError(`Git stage ${key} must be an absolute path`);
      this[key] = value;
    }
    this.restore = restore;
    if (restore && attributesFile === null) throw new TypeError('Git restore requires its owned attributes file');
    Object.freeze(this);
  }
  environment(environment = process.env) {
    const result = { ...super.environment(environment) };
    for (const [key, value] of [['GIT_DIR', this.gitDir], ['GIT_WORK_TREE', this.workTree], ['GIT_INDEX_FILE', this.indexFile], ['GIT_OBJECT_DIRECTORY', this.objectDirectory], ['GIT_TEMPLATE_DIR', this.templateDirectory]]) {
      if (value !== null) result[key] = value;
    }
    return Object.freeze(result);
  }
  arguments(args) {
    return [...(this.attributesFile === null ? [] : ['-c', `core.attributesFile=${this.attributesFile}`]),
      ...(this.restore ? ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'] : []), ...args];
  }
}
