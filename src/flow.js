#!/usr/bin/env node
/**
 * src/flow.js
 *
 * Flow dispatcher. Top-level command routing (query / prepare / resume / get /
 * set / run) feeds the shared dispatcher (src/lib/dispatcher.js), which handles
 * argument parsing, lifecycle hooks, and envelope output uniformly across
 * every domain.
 */

import { EXIT_ERROR } from "./lib/constants.js";
import { container, initContainer } from "./lib/container.js";
import { buildFlowCommandHookContext } from "./flow/lib/flow-context.js";
import { coreCommandRegistry } from "./lib/command-registry.js";
import { dispatch } from "./lib/dispatcher.js";

const args = process.argv.slice(2);
if (args[0] === "query") {
  const { bootstrapFlowQueryCli } = await import("./flow/query.js");
  process.exit(await bootstrapFlowQueryCli(args.slice(1)));
}
initContainer({
  flowAttribution: args[0] === "run" && args[1] === "abort" ? "none" : "ambient",
});

const group = args[0];
const rest = args.slice(1);
const flowDefinition = coreCommandRegistry.find(["flow"]);
const flowCommandSuggestionByGroup = {
  status: "sennel flow get status",
};

function isolatedArtifactHookContext(container, flowResolutionError = null) {
  const paths = container.get("paths");
  const mainRoot = container.get("mainRoot");
  return {
    root: mainRoot,
    mainRoot,
    config: container.get("config"),
    paths,
    flowManager: container.get("flowManager"),
    flowState: null,
    preparingFlowState: null,
    specId: null,
    specLocation: null,
    executionRoot: paths.root,
    flowResolutionError,
  };
}

function artifactContextReadFailure(cause) {
  const error = new Error(cause?.message || String(cause), { cause });
  error.code = "ARTIFACT_VIEW_READ_FAILED";
  return error;
}

if (!group || group === "-h" || group === "--help") {
  console.log(flowDefinition.renderHelp());
  if (!group) process.exit(EXIT_ERROR);
  process.exit(0);
}

async function run(entry, argv, envelopeType, envelopeKey, helpPathOverride) {
  const resolvedEntry = entry?.helpPath
    ? entry
    : { ...entry, helpPath: helpPathOverride || `sennel flow ${envelopeType} ${envelopeKey} --help` };
  // Artifact views are read-only apart from their Version-local view cache.
  // A dispatcher runtime log would create an unrelated activity artifact and
  // violate that boundary, so this command deliberately has no runtime log.
  const runtimeLog = !(group === "get" && (envelopeKey === "runtime-log" || envelopeKey === "artifact"));
  await dispatch({
    container,
    entry: resolvedEntry,
    argv,
    envelopeType,
    envelopeKey,
    runtimeLog,
    buildHookCtx: (c, input = {}) => {
      // A command may own an exact, non-active target selector. In that case
      // the dispatcher must not discover or guard an ambient Flow before the
      // command has validated the selector. This generic escape hatch keeps
      // completed Version reads isolated from unrelated active authority.
      if (typeof resolvedEntry.skipAmbientFlowContext === "function" && resolvedEntry.skipAmbientFlowContext(input) === true) {
        return isolatedArtifactHookContext(c);
      }
      try {
        return buildFlowCommandHookContext(c, resolvedEntry, input);
      } catch (error) {
        if (group === "get" && envelopeKey === "artifact") {
          return isolatedArtifactHookContext(c, artifactContextReadFailure(error));
        }
        throw error;
      }
    },
  });
}

async function dispatchFlow() {
  // Top-level: resume
  if (group === "resume") {
    await run(flowDefinition.find(["resume"]), rest, "run", "resume");
    return;
  }

  // Top-level: prepare
  if (group === "prepare") {
    await run(flowDefinition.find(["prepare"]), rest, "run", "prepare-spec");
    return;
  }

  // Group commands: get / set / run
  const commands = flowDefinition.find([group]);
  if (!commands || commands.command || commands.subcommands.size === 0) {
    console.error(`sennel flow: unknown command '${group}'`);
    const suggestion = flowCommandSuggestionByGroup[group];
    if (suggestion) {
      console.error(`Did you mean: ${suggestion}`);
    }
    console.error("Run: sennel flow --help");
    process.exit(EXIT_ERROR);
  }

  const cmd = rest[0];
  const cmdArgs = rest.slice(1);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(commands.renderHelp());
    if (!cmd) process.exit(EXIT_ERROR);
    process.exit(0);
  }

  const entry = commands.find([cmd]);
  if (!entry?.command) {
    console.error(`sennel flow ${group}: unknown key '${cmd}'`);
    console.error(`Run: sennel flow ${group} --help`);
    process.exit(EXIT_ERROR);
  }

  await run(entry, cmdArgs, group, cmd);
}

await dispatchFlow();
