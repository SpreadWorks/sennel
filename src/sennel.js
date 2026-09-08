#!/usr/bin/env node
/**
 * src/sennel.js
 *
 * sennel CLI entry point.
 * Routes top-level subcommands to dedicated dispatchers:
 *   docs    → src/docs.js
 *   flow    → src/flow.js
 *   check   → src/check.js
 *   metrics → src/metrics.js
 *   spec    → src/spec.js
 *   hook    → src/hook.js
 *   setup   → src/setup.js
 *   upgrade → src/upgrade.js
 *   migrate → src/migrate.js
 *   help    → src/help.js
 */

import { EXIT_ERROR } from "./lib/constants.js";
import { initContainer } from "./lib/container.js";
import { FinalizeCleanupRoute } from "./lib/finalize-cleanup-paths.js";
import { executeWorktreeLocalCli } from "./lib/worktree-cli-execution.js";

const rawArgs = process.argv.slice(2);
const isFlowQuery = rawArgs[0] === "flow" && rawArgs[1] === "query";
function queryArgsForStdin(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--request-file") {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
}
if (isFlowQuery) {
  // Query input is the only bootstrap boundary allowed before worktree
  // resolution. A valid request is handed to a worktree-local re-exec via
  // stdin; invalid input is rendered without touching the ambient container.
  const { prepareFlowQueryInput, runFlowQueryCli } = await import("./flow/query.js");
  const prepared = await prepareFlowQueryInput(rawArgs.slice(2));
  if (prepared.error === null) {
    const worktreeCliExitCode = executeWorktreeLocalCli({
      argv: rawArgs.includes("--request-file") ? queryArgsForStdin(rawArgs) : rawArgs,
      queryInput: prepared.bytes,
    });
    if (worktreeCliExitCode != null) process.exit(worktreeCliExitCode);
  }
  process.exit(await runFlowQueryCli(rawArgs.slice(2), { prepared }));
}
const worktreeCliExitCode = executeWorktreeLocalCli({ argv: rawArgs });
if (worktreeCliExitCode != null) process.exit(worktreeCliExitCode);
const [subCmd, ...rest] = rawArgs;
const recoveryWithoutFlowAttribution = subCmd === "flow"
  && rest[0] === "run"
  && rest[1] === "abort";
let agentWorkDirOverride = null;
const enableFinalizeCleanupDurablePaths = FinalizeCleanupRoute
  .fromCliArgs(rawArgs)
  .removesManagedWorktree;
if (subCmd === "flow" && rest[0] === "run") {
  for (let i = 2; i < rest.length; i += 1) {
    if (rest[i] === "--agent-work-dir") {
      const value = rest[i + 1];
      const normalized = value == null ? "" : String(value).trim();
      if (normalized !== "" && !normalized.startsWith("-")) agentWorkDirOverride = normalized;
      break;
    }
  }
}

// version (-v / --version / -V)
if (subCmd === "-v" || subCmd === "--version" || subCmd === "-V") {
  const { getPackageVersion } = await import("./lib/cli.js");
  console.log(getPackageVersion());
  process.exit(0);
}

// help (no args / -h / --help / help [topic])
if (!subCmd || subCmd === "-h" || subCmd === "--help" || subCmd === "help") {
  initContainer({ entryCommand: rawArgs.join(" "), allowInvalidConfig: true });
  const { coreCommandRegistry } = await import("./lib/command-registry.js");
  await coreCommandRegistry.find(["help"]).entrypoint.execute(subCmd === "help" ? rest : []);
  process.exit(0);
}

function isHelpRequest(args) {
  return args.includes("-h") || args.includes("--help");
}

function helpTopic(head, args) {
  return [head, ...args.filter((arg) => arg !== "-h" && arg !== "--help")];
}

async function renderSharedHelp(argv) {
  initContainer({ entryCommand: rawArgs.join(" "), allowInvalidConfig: true });
  const { renderHelp } = await import("./help.js");
  console.log(await renderHelp({ root: process.cwd(), argv }));
  process.exit(0);
}

const { coreCommandRegistry } = await import("./lib/command-registry.js");
const definition = coreCommandRegistry.find([subCmd]);
const sharedHelpTopic = helpTopic(subCmd, rest);
if (definition && isHelpRequest(rest) && coreCommandRegistry.find(sharedHelpTopic)) {
  await renderSharedHelp([subCmd, ...rest]);
}

// Initialize the shared dependency container once; dispatchers and commands
// below import `container` directly from ./lib/container.js.
initContainer({
  entryCommand: rawArgs.join(" "),
  agentWorkDirOverride,
  flowAttribution: subCmd === "docs" || recoveryWithoutFlowAttribution ? "none" : "ambient",
  finalizeCleanupDurablePaths: enableFinalizeCleanupDurablePaths,
  allowInvalidConfig: definition?.allowInvalidConfig === true || !definition,
});

if (definition) {
  try {
    await definition.entrypoint.execute(rest);
  } catch (err) {
    console.error(err?.stack || String(err));
    process.exit(EXIT_ERROR);
  }
} else {
  try {
    const { repoRoot } = await import("./lib/cli.js");
    const { dispatchPluginCommand, loadPluginRegistry } = await import("./lib/plugin-registry.js");
    const root = repoRoot();
    if (isHelpRequest(rest) && loadPluginRegistry(root).resolveCommand(subCmd)) {
      await renderSharedHelp([subCmd, ...rest]);
    }
    const handled = await dispatchPluginCommand(root, subCmd, rest);
    if (handled) {
      if (handled.ok != null) {
        if (handled.ok && handled.key === "help" && typeof handled.data?.help === "string") {
          console.log(handled.data.help);
          process.exit(0);
        }
        console.log(JSON.stringify(handled, null, 2));
        process.exit(handled.ok ? 0 : (handled.exitCode || EXIT_ERROR));
      }
      process.exit(0);
    }
    if (isHelpRequest(rest)) {
      await renderSharedHelp([subCmd, ...rest]);
    }
    console.error(`sennel: unknown command '${subCmd}' is unavailable. Enable a plugin that contributes this command, or run: sennel plugin list`);
  } catch (err) {
    console.error(`sennel: unknown command '${subCmd}' is unavailable. Plugin command resolution failed: ${err.message}`);
  }
  console.error("Run: sennel help");
  process.exit(EXIT_ERROR);
}
