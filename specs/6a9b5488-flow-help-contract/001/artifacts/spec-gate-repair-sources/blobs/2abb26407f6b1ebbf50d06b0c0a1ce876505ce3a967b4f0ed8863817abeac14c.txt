import os from "node:os";

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
]);

const GIT_CONFIG_INJECTION_PREFIXES = Object.freeze([
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
]);

function removeGitConfigInjections(environment, names) {
  for (const name of names) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (GIT_CONFIG_INJECTION_PREFIXES.some((prefix) => name.startsWith(prefix))) delete environment[name];
  }
  return environment;
}

export function sanitizeGitRepositoryEnvironment(environment = process.env) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Git repository environment must be an object");
  }
  const sanitized = removeGitConfigInjections({ ...environment }, GIT_REPOSITORY_LOCATION_ENVIRONMENT);
  // Do not fall back to inherited global/system config: either may set
  // core.worktree/core.gitDir and redirect an otherwise explicit `git -C`.
  // HOME remains available for normal provider credentials and other tools.
  sanitized.GIT_CONFIG_GLOBAL = os.devNull;
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  return sanitized;
}
