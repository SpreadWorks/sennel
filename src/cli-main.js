/**
 * src/cli-main.js
 *
 * Semantic CLI dispatch, imported only after the builtin bootstrap acknowledges
 * the immutable runtime package.
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

import { publicCommandEntrypoint } from "./lib/command-entrypoint.js";

// The inherited wrapper authenticates again in its existing command handler.
// Bootstrap has already verified and pinned these bytes. Ordinary project/Flow
// services are loaded only for routes that use them, including shared help.
if (publicCommandEntrypoint.accepts(process.argv.slice(2))) {
  await publicCommandEntrypoint.execute(process.argv.slice(3));
} else {
  await dispatchOrdinaryCli();
}

async function dispatchOrdinaryCli() {
  const { coreCommandRegistry } = await import("./lib/command-registry.js");
  const { CliInvocationPolicy } = await import("./lib/cli-invocation-policy.js");
  const policy = new CliInvocationPolicy(coreCommandRegistry, process.argv.slice(2));
  if (policy.migration) {
    // The migration captures its source before configuration, logging or process
    // admission can create the canonical target. Its domain transaction owns
    // repository exclusion; pure planning needs no coordinator or workspace.
    await policy.definition.entrypoint.execute(process.argv.slice(3));
    return;
  }
  const { EXIT_ERROR } = await import("./lib/constants.js");
  const { initContainer } = await import("./lib/container.js");
  const { FinalizeCleanupRoute } = await import("./lib/finalize-cleanup-paths.js");
  const { flowCliFailure } = await import("./lib/flow-cli-failure.js");

  const { withManagedProcessScope, withReadOnlyManagedProcessScope } = await import("./lib/managed-process.js");
  const { repoRoot, getMainRepoPath, isInsideWorktree } = await import("./lib/cli.js");

  async function dispatchCli(workspace = null) {
    const rawArgs = process.argv.slice(2);
    const isFlowQuery = rawArgs[0] === "flow" && rawArgs[1] === "query";
    if (isFlowQuery) {
      // Query input is the only bootstrap boundary allowed before worktree
      // resolution. Query is read-only and executes against the caller-selected
      // root without resolving or re-executing another worktree's CLI source.
      const { bootstrapFlowQueryCli } = await import("./flow/query.js");
      return bootstrapFlowQueryCli(rawArgs.slice(2));
    }
    const [subCmd, ...rest] = rawArgs;
    const recoveryWithoutFlowAttribution = subCmd === "flow"
      && rest[0] === "run"
      && rest[1] === "abort";
    const flowAttribution = subCmd === "docs" || subCmd === "migrate" || subCmd === "command" || recoveryWithoutFlowAttribution ? "none" : "ambient";
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
      return 0;
    }

    // help (no args / -h / --help / help [topic])
    if (!subCmd || subCmd === "-h" || subCmd === "--help" || subCmd === "help") {
      initContainer({ entryCommand: rawArgs.join(" "), allowInvalidConfig: true, workspace });
      await coreCommandRegistry.find(["help"]).entrypoint.execute(subCmd === "help" ? rest : []);
      return 0;
    }

    function isHelpRequest(args) {
      return args.includes("-h") || args.includes("--help");
    }

    function helpTopic(head, args) {
      return [head, ...args.filter((arg) => arg !== "-h" && arg !== "--help")];
    }

    async function renderSharedHelp(argv) {
      initContainer({ entryCommand: rawArgs.join(" "), allowInvalidConfig: true, flowAttribution, workspace });
      const { renderHelp } = await import("./help.js");
      console.log(await renderHelp({ root: process.cwd(), argv }));
      return 0;
    }

    const definition = coreCommandRegistry.find([subCmd]);
    const sharedHelpTopic = helpTopic(subCmd, rest);
    if (definition && isHelpRequest(rest) && coreCommandRegistry.find(sharedHelpTopic)) {
      return renderSharedHelp([subCmd, ...rest]);
    }

    // Initialize the shared dependency container once; dispatchers and commands
    // below import `container` directly from ./lib/container.js.
    if (subCmd !== "command") {
    try {
      initContainer({
        entryCommand: rawArgs.join(" "),
        agentWorkDirOverride,
        flowAttribution,
        workspace,
        finalizeCleanupDurablePaths: enableFinalizeCleanupDurablePaths,
        allowInvalidConfig: definition?.allowInvalidConfig === true || !definition,
      });
    } catch (error) {
      if (subCmd !== "flow") throw error;
      flowCliFailure(error).output();
      process.exitCode = EXIT_ERROR;
    }

    }

    if (process.exitCode === EXIT_ERROR && subCmd === "flow") {
      // Initialization failed before dispatch; the sole public result is complete.
    } else if (definition) {
      try {
        await definition.entrypoint.execute(rest);
      } catch (err) {
        if (subCmd === "flow") {
          flowCliFailure(err, { type: rest[0] ?? "run", key: rest[1] ?? rest[0] ?? "initialize" }).output();
          process.exitCode = err?.exitCode ?? EXIT_ERROR;
        } else {
          console.error(err?.stack || String(err));
          return err?.exitCode ?? EXIT_ERROR;
        }
      }
    } else {
      try {
        const { dispatchPluginCommand, loadPluginRegistry } = await import("./lib/plugin-registry.js");
        const root = repoRoot();
        if (isHelpRequest(rest) && loadPluginRegistry(root).resolveCommand(subCmd)) {
          return renderSharedHelp([subCmd, ...rest]);
        }
        const handled = await dispatchPluginCommand(root, subCmd, rest);
        if (handled) {
          if (handled.ok != null) {
            if (handled.ok && handled.key === "help" && typeof handled.data?.help === "string") {
              console.log(handled.data.help);
              return 0;
            }
            console.log(JSON.stringify(handled, null, 2));
            return handled.ok ? 0 : (handled.exitCode || EXIT_ERROR);
          }
          return 0;
        }
        if (isHelpRequest(rest)) {
          return renderSharedHelp([subCmd, ...rest]);
        }
        console.error(`sennel: unknown command '${subCmd}' is unavailable. Enable a plugin that contributes this command, or run: sennel plugin list`);
      } catch (err) {
        console.error(`sennel: unknown command '${subCmd}' is unavailable. Plugin command resolution failed: ${err.message}`);
      }
      console.error("Run: sennel help");
      return EXIT_ERROR;
    }

    return process.exitCode ?? 0;
  }

  if (policy.readOnly) {
    const executionRoot = repoRoot();
    const mainRoot = isInsideWorktree(executionRoot) ? getMainRepoPath(executionRoot) : executionRoot;
    process.exitCode = await withReadOnlyManagedProcessScope({ mainRoot, executionRoot }, (_runtime, workspace) => dispatchCli(workspace));
  } else if (policy.inherited || policy.flow) {
    // The command wrapper authenticates its inherited grant; Flow's dispatcher
    // binds execution to the exact selected canonical attempt.
    process.exitCode = await dispatchCli();
  } else {
    process.exitCode = await withManagedProcessScope({ executionRoot: repoRoot() }, () => dispatchCli());
  }
}
