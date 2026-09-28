/**
 * tests/runner/test-runner-search-dirs.js
 *
 * Spec 212: pure helpers used by tests/run.js to build the set of search
 * directories and validate flag combinations.
 *
 * Selector resolution order (highest first):
 *   --agent : [tests/agent] only
 *   --all   : default dirs + [tests/agent]
 *   --preset: selected preset-local deterministic acceptance root only
 *   --scope : [tests/<scope>]
 *   none    : deterministic suites (unit, integration, e2e, acceptance)
 *
 * The tests/agent directory is included only via --agent or --all.
 */

import { join } from "node:path";
import { DEFAULT_TEST_SUITES } from "./suite-definitions.js";

export function buildSearchDirs({ root, presetsSubdir = "tests/presets" }, opts = {}) {
  const {
    preset,
    scope,
    agent,
    all,
    presetDirName,
  } = opts;
  const PRESETS_DIR = join(root, presetsSubdir);
  const AGENT_DIR = join(root, "tests", "agent");

  if (agent) return [AGENT_DIR];

  const defaults = () => [
    ...DEFAULT_TEST_SUITES.map(({ directory }) => join(root, "tests", directory)),
    join(root, "src", "presets"),
  ];

  if (all) return [...defaults(), AGENT_DIR];

  if (preset) {
    const name = presetDirName || preset;
    return [join(root, "src", "presets", name, "tests", "acceptance")];
  }

  if (scope === "acceptance") {
    return [join(root, "tests", "acceptance"), join(root, "src", "presets")];
  }

  if (scope) {
    return [join(root, "tests", scope)];
  }

  return defaults();
}

export function validateFlags(opts = {}) {
  const { agent, all, preset, scope, hasFile, hasPattern, hasPositional } = opts;
  if (agent && (all || preset || scope)) {
    return {
      error:
        "--agent cannot be combined with --all / --preset / --scope (exclusive selector)",
    };
  }
  const fileSpec = hasFile || hasPattern || hasPositional;
  const dirSearch = agent || all || preset || scope;
  if (fileSpec && dirSearch) {
    return {
      error:
        "--file / --pattern / positional args cannot be combined with --agent / --all / --preset / --scope (exclusive selector)",
    };
  }
  return { error: null };
}
