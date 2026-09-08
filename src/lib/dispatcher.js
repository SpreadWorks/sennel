/**
 * src/lib/dispatcher.js
 *
 * Unified command dispatcher for all domains (flow / docs / check / metrics).
 * Replaces the per-domain ad-hoc runners with one path:
 *
 *   parseArgs(argv, entry.args)         — consistent CLI parsing
 *   → entry.pre?(ctx)                   — lifecycle pre
 *   → cmd.run(container, input)         — Command contract
 *   → entry.post?(ctx, result)          — lifecycle post (success only)
 *   → entry.onError?(ctx, err)          — lifecycle onError (failure only)
 *   → write envelope JSON | raw stdout  — per Command.outputMode
 *
 * Writes to stdout and setExitCode can be injected for testing.
 */

import { parseArgs as cliParseArgs } from "./cli.js";
import { Command } from "./command.js";
import { Envelope } from "./flow-envelope.js";
import { RuntimeLogBlockWriter } from "./runtime-log.js";
import { FlowTargetBinding, targetMismatchEnvelopeForInput } from "./flow-target-guard.js";
import { findActiveNode, taskIdForResolvedStep } from "../flow/definition.js";
import {
  AwaitingDecisionOutcome,
  ExternalBlockedOutcome,
  StepAttempt,
} from "../flow/lib/step-outcome.js";
import {
  attachFlowContinuation,
  attachUserActionPrompt,
  FlowContinuation,
} from "../flow/lib/user-action-prompt.js";
import { guardedCommand } from "../flow/lib/guarded-command.js";
import { FinalizeFlowStateOwner } from "../flow/lib/finalize-flow-state-owner.js";
import { FatalPostHookError } from "./post-hook-error.js";
import { AgentFailure } from "./agent-failure.js";
import { DefinitionLifecycleAttemptBinding } from "../flow/lib/definition-lifecycle-failure.js";

function attachNonblockingContinuation(envelope, ctx, reason) {
  const state = ctx?.flowState;
  if (!(envelope instanceof Envelope) || state?.policy?.nonblocking?.enabled !== true) return envelope;
  if (envelope.data?.actionPrompt || envelope.data?.continuation) return envelope;
  const binding = FlowTargetBinding.captureContext(ctx);
  return attachFlowContinuation(envelope, new FlowContinuation({
    actionId: "REFRESH_NONBLOCKING_FLOW",
    nextAction: guardedCommand("sennel flow get next-action", state, binding),
    instruction: "Refresh the guarded next action and continue the normal Flow route.",
    reason,
  }));
}

function throwUnexpected(extras) {
  const unknownOpt = extras.find((v) => typeof v === "string" && v.startsWith("-"));
  if (unknownOpt) throw new Error(`Unknown option: ${unknownOpt}`);
  throw new Error(`Unexpected argument: ${extras[0]}`);
}

function splitArgsBySpec(argv, flagSet, optionSet, optionalOptionSet) {
  const nonPositional = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      nonPositional.push(a);
      continue;
    }
    if (flagSet.has(a)) {
      nonPositional.push(a);
      continue;
    }
    if (optionSet.has(a)) {
      if (i + 1 >= argv.length || String(argv[i + 1]).trim() === "" || String(argv[i + 1]).startsWith("-")) {
        throw new Error(`Missing value for option: ${a}`);
      }
      nonPositional.push(a);
      nonPositional.push(argv[++i]);
      continue;
    }
    const equalsOption = [...optionSet].find((option) => a.startsWith(`${option}=`));
    if (equalsOption) {
      const value = a.slice(equalsOption.length + 1);
      if (!value) throw new Error(`Missing value for option: ${equalsOption}`);
      nonPositional.push(equalsOption, value);
      continue;
    }
    if (optionalOptionSet.has(a)) {
      nonPositional.push(a);
      const value = argv[i + 1];
      if (value != null && String(value).trim() !== "" && !String(value).startsWith("-")) {
        nonPositional.push(argv[++i]);
      }
      continue;
    }
    // Unrecognized `-`-prefixed token → unknown option; non-dash tokens fall
    // through as positional values.
    if (typeof a === "string" && a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }
    positional.push(a);
  }
  return { nonPositional, positional };
}

/**
 * Parse argv into an input object according to entry.args.
 *   - flags / options use camelCase conversion via cli.parseArgs.
 *   - positional values are assigned by name: ctx[positional[i]] = values[i].
 *
 * When `entry.args` is absent (typical for legacy adapter entries that parse
 * their own argv internally), return an empty input so the raw args reach
 * the command unaltered via `_rawArgs` (set later in dispatch()).
 */
export function parseEntryInput(entry, argv) {
  if (!entry.args) {
    if (entry.passthroughArgs) {
      return { help: argv.includes("-h") || argv.includes("--help") };
    }
    // Strict no-arg entry: reject any extras besides help.
    const extras = argv.filter((a) => a !== "-h" && a !== "--help");
    if (extras.length > 0) throwUnexpected(extras);
    return { help: argv.includes("-h") || argv.includes("--help") };
  }
  const spec = entry.args || {};
  const positionalNames = spec.positional || [];
  const flags = spec.flags || [];
  const options = spec.options || [];
  const optionalOptions = spec.optionalOptions || [];

  const { nonPositional, positional } = splitArgsBySpec(
    argv,
    new Set(flags),
    new Set(options),
    new Set(optionalOptions),
  );

  const parsed = cliParseArgs(nonPositional, { flags, options, optionalOptions });

  for (let i = 0; i < positionalNames.length && i < positional.length; i++) {
    parsed[positionalNames[i]] = positional[i];
  }
  if (spec.rest) {
    parsed[spec.rest] = positional.slice(positionalNames.length);
  } else if (positional.length > positionalNames.length) {
    throwUnexpected(positional.slice(positionalNames.length));
  }
  return parsed;
}

const FINALIZE_CLEANUP_REPORT_HEADER = "Finalize Report";
const FINALIZE_CLEANUP_REPORT_MISSING_CODE = "REPORT_MISSING";
const FINALIZE_CLEANUP_WARNING_MESSAGE_LIMIT = 3;
const FINALIZE_CLEANUP_WARNING_TEXT_LIMIT = 600;

function runtimeLogRunId(hookCtx) {
  return hookCtx?.flowState?.runId || hookCtx?.runId || "no-flow";
}

function runtimeLogFlowId(hookCtx) {
  return hookCtx?.specId || "no-flow";
}

function runtimeLogAllowed(entry, hookCtx) {
  return !(
    entry.runtimeLog?.writeWhenNoFlow === false
    && hookCtx?.flowState == null
  );
}

function runtimeLogRoot({ entry, hookCtx, container }) {
  const fallbackRoot = hookCtx.root || container.get("paths").root;
  if (entry.runtimeLog?.authority !== "main-repository") return fallbackRoot;
  if (!hookCtx?.flowManager || !hookCtx?.flowState?.worktree) return fallbackRoot;
  const { mainRepoPath } = hookCtx.flowManager.resolveWorktreePaths(hookCtx.flowState);
  return mainRepoPath || fallbackRoot;
}

function attachRuntimeLog(envelope, metadata) {
  if (!(envelope instanceof Envelope) || !metadata) return envelope;
  const runtimeLog = {
    runId: metadata.runId,
    sequence: metadata.sequence,
  };
  envelope.data = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? { ...envelope.data, runtimeLog }
    : { runtimeLog };
  return envelope;
}

function runtimeLogStepId(entry, hookCtx, result) {
  const spec = entry.runtimeLog;
  if (!spec || spec.stepMetadata === false) return null;
  if (typeof spec.stepId === "function") return spec.stepId(hookCtx, result);
  if (typeof spec.stepId === "string") return spec.stepId;
  return null;
}

async function persistFinalizeCleanupPostReturnMetadata({
  envelopeKey,
  hookCtx,
  metadata,
  commandModule,
  commitCompletion = false,
}) {
  if (envelopeKey !== "finalize-cleanup" || !hookCtx?.flowManager || !hookCtx?.specId) return;
  const state = hookCtx.flowState || hookCtx.flowManager.loadReadOnly(hookCtx.specId);
  let retainedMetadata = null;
  if (metadata && state) {
    const { mainRepoPath } = hookCtx.flowManager.resolveWorktreePaths(state);
    const repositoryRoot = mainRepoPath || hookCtx.flowManager.specLocation(hookCtx.specId).repositoryRoot;
    const recordFinalizeCleanupPostCommandMetadata = commandModule?.recordFinalizeCleanupPostCommandMetadata;
    if (typeof recordFinalizeCleanupPostCommandMetadata !== "function") {
      throw new Error("finalize-cleanup command module has no post-command metadata recorder");
    }
    const stateOwner = FinalizeFlowStateOwner.forMainContext({
      ...hookCtx,
      mainRoot: repositoryRoot,
    });
    retainedMetadata = recordFinalizeCleanupPostCommandMetadata({
      flowManager: stateOwner.flowManager,
      specId: hookCtx.specId,
      runtimeLog: metadata.toStepMetadata(),
    });
  }
  if (!commitCompletion) return;
  const commitFinalizeCleanupPostCommandMetadata = commandModule?.commitFinalizeCleanupPostCommandMetadata;
  if (typeof commitFinalizeCleanupPostCommandMetadata !== "function") {
    throw new Error("finalize-cleanup command module has no post-command completion committer");
  }
  commitFinalizeCleanupPostCommandMetadata({
    flowManager: hookCtx.flowManager,
    specId: hookCtx.specId,
    writtenPaths: retainedMetadata?.writtenPaths || [],
  });
}

function findWarning(envelope, code) {
  return (envelope.errors || []).find((entry) => entry?.level === "warn" && entry?.code === code) || null;
}

function truncateText(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function formatWarningMessages(warning) {
  const messages = Array.isArray(warning?.messages) ? warning.messages : [];
  const shown = messages.slice(0, FINALIZE_CLEANUP_WARNING_MESSAGE_LIMIT);
  const suffix = messages.length > shown.length
    ? ` ... (${messages.length - shown.length} more message(s))`
    : "";
  return truncateText(`${shown.join(" ")}${suffix}`, FINALIZE_CLEANUP_WARNING_TEXT_LIMIT);
}

function formatFinalizeCleanupReportDisplay({ envelopeKey, envelope }) {
  if (envelopeKey !== "finalize-cleanup" || !(envelope instanceof Envelope) || envelope.ok !== true) return null;
  const report = envelope.data?.report;
  if (report && typeof report.text === "string") return `${FINALIZE_CLEANUP_REPORT_HEADER}\n${report.text}`;
  if (report !== null) return null;

  const warning = findWarning(envelope, FINALIZE_CLEANUP_REPORT_MISSING_CODE);
  if (!warning) return null;
  return `${FINALIZE_CLEANUP_REPORT_MISSING_CODE}: ${formatWarningMessages(warning)}\n`;
}

function emitFinalizeCleanupReportDisplay({ envelopeKey, envelope, writeErr }) {
  const text = formatFinalizeCleanupReportDisplay({ envelopeKey, envelope });
  if (text) writeErr(text);
}

function settleTypedStepOutcome(envelope, result) {
  if (!(envelope instanceof Envelope) || !result?.stepAttempt) return;
  const attempt = StepAttempt.fromStored(result.stepAttempt);
  if (!(attempt.outcome instanceof ExternalBlockedOutcome)
    && !(attempt.outcome instanceof AwaitingDecisionOutcome)) return;
  if (
    attempt.outcome instanceof ExternalBlockedOutcome
    && ["execute_command", "execute_step", "repair_evidence"].includes(result.directive?.kind)
    && result.directive?.terminal === false
    && result.directive?.requiresUserAction === false
  ) {
    // The typed attempt records why the prior action stopped. A newer
    // deterministic directive is the durable recovery route and must remain a
    // successful guarded next-action response.
    return;
  }
  envelope.ok = false;
  envelope.errors.push({
    level: "fatal",
    code: attempt.outcome instanceof AwaitingDecisionOutcome
      ? "STEP_DECISION_REQUIRED"
      : "STEP_EXTERNAL_BLOCKED",
    messages: [attempt.outcome.resumeInstruction],
  });
  if (attempt.outcome instanceof AwaitingDecisionOutcome) {
    attachUserActionPrompt(envelope, attempt.outcome.prompt);
  }
}

function recordDefinitionLifecycleToolingFailure(binding, error, fallbackCode, writeErr, commandResult = null) {
  if (!(binding instanceof DefinitionLifecycleAttemptBinding)) return false;
  try {
    return binding.toolingFailure(error, fallbackCode, commandResult);
  } catch (recordingError) {
    writeErr(`[definition lifecycle failure] ${recordingError.message || recordingError}\n`);
    return false;
  }
}

/**
 * Dispatch a single entry.
 *
 * @param {Object}   args
 * @param {import("./container.js").Container} args.container
 * @param {Object}   args.entry        registry entry
 * @param {string[]} args.argv         command-specific argv tail
 * @param {string}   [args.envelopeType]
 * @param {string}   [args.envelopeKey]
 * @param {(s: string) => void} [args.stdout]        override for tests
 * @param {(code: number) => void} [args.setExitCode] override for tests
 * @param {(s: string) => void} [args.stderr]        override for tests
 * @param {boolean} [args.runtimeLog]  enable flow-run human-readable runtime log
 */
export async function dispatch({
  container,
  entry,
  argv,
  envelopeType,
  envelopeKey,
  runtimeLog: enableRuntimeLog = false,
  stdout,
  stderr,
  setExitCode,
  buildHookCtx,
}) {
  const baseWriteOut = stdout || ((s) => process.stdout.write(s));
  let runtimeLog = null;
  const baseWriteErr = stderr || ((s) => process.stderr.write(s));
  const processCaptureSuppressed = { stdout: 0, stderr: 0 };
  const withProcessCaptureSuppressed = (stream, fn) => {
    processCaptureSuppressed[stream] += 1;
    try {
      return fn();
    } finally {
      processCaptureSuppressed[stream] -= 1;
    }
  };
  const writeOut = (s) => {
    if (runtimeLog) runtimeLog.capture("stdout", s);
    return withProcessCaptureSuppressed("stdout", () => baseWriteOut(s));
  };
  const writeErr = (s) => {
    if (runtimeLog) runtimeLog.capture("stderr", s);
    return withProcessCaptureSuppressed("stderr", () => baseWriteErr(s));
  };
  let recordedExitCode = 0;
  const baseSetExit = setExitCode || ((code) => { process.exitCode = code; });
  const setExit = (code) => {
    recordedExitCode = code;
    baseSetExit(code);
  };
  let closedRuntimeLogMetadata = null;
  let restoreStreams = null;
  const buildRuntimeHookCtx = (parsedInput) => {
    const skipAmbientFlowContext = entry.skipAmbientFlowContext === true;
    if (skipAmbientFlowContext || !buildHookCtx) return { container, ...parsedInput };
    return { ...buildHookCtx(container, parsedInput), ...parsedInput };
  };
  const openRuntimeLog = (hookCtx) => {
    if (
      runtimeLog
      || enableRuntimeLog !== true
      || !container.has("paths")
      || !runtimeLogAllowed(entry, hookCtx)
    ) return;
    runtimeLog = RuntimeLogBlockWriter.forDispatch({
      root: runtimeLogRoot({ entry, hookCtx, container }),
      flowId: runtimeLogFlowId(hookCtx),
      runId: runtimeLogRunId(hookCtx),
      envelopeType,
      envelopeKey,
    });
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = function(chunk, encoding, cb) {
      if (runtimeLog && processCaptureSuppressed.stdout === 0) runtimeLog.capture("stdout", chunk);
      return originalStdoutWrite.call(this, chunk, encoding, cb);
    };
    process.stderr.write = function(chunk, encoding, cb) {
      if (runtimeLog && processCaptureSuppressed.stderr === 0) runtimeLog.capture("stderr", chunk);
      return originalStderrWrite.call(this, chunk, encoding, cb);
    };
    restoreStreams = () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    };
  };
  const closeRuntimeLog = () => {
    if (!runtimeLog || closedRuntimeLogMetadata) return closedRuntimeLogMetadata;
    closedRuntimeLogMetadata = runtimeLog.close(recordedExitCode);
    return closedRuntimeLogMetadata;
  };

  // 1. Parse argv → input. _rawArgs preserved for legacy adapters that
  //    need to reconstruct process.argv before calling into old main().
  let input;
  try {
    input = parseEntryInput(entry, argv);
    input._rawArgs = argv;
  } catch (err) {
    const parseHookCtx = buildRuntimeHookCtx({});
    openRuntimeLog(parseHookCtx);
    const mode = await resolveOutputMode(entry);
    const helpHint = entry.helpPath
      ? `Run: ${entry.helpPath}`
      : `Run: sennel ${envelopeType || "flow"} ${envelopeKey || ""} --help`.trimEnd();
    if (mode === "envelope" || entry.parseErrorsAsEnvelope === true) {
      const env = Envelope.fail(envelopeType || "run", envelopeKey || "?", "ARGS_ERROR", [
        String(err.message || err),
        helpHint,
      ]);
      attachRuntimeLog(env, runtimeLog?.metadata);
      writeOut(JSON.stringify(env.toJSON(), null, 2) + "\n");
    } else {
      writeErr(`${err.message || err}\n${helpHint}\n`);
      if (runtimeLog?.metadata) {
        writeErr(`runtimeLog.runId=${runtimeLog.metadata.runId} runtimeLog.sequence=${runtimeLog.metadata.sequence}\n`);
      }
    }
    setExit(1);
    closeRuntimeLog();
    if (restoreStreams) restoreStreams();
    return;
  }

  // 2. help shortcut
  if (input.help && entry.help) {
    writeOut(`${entry.help}\n`);
    return;
  }

  // 3. Resolve and guard the flow target before loading or validating the
  // command module. A mismatch cannot reach command-owned validation,
  // lifecycle hooks, execution, or step metadata persistence.
  const hookCtx = buildRuntimeHookCtx(input);
  const emitTargetFailure = (failure) => {
    attachRuntimeLog(failure, enableRuntimeLog === true && container.has("paths")
      ? { runId: runtimeLogRunId(hookCtx) }
      : null);
    writeOut(JSON.stringify(failure.toJSON(), null, 2) + "\n");
    setExit(1);
  };
  const recognizedTargetResolutionError = [
    "ACTIVE_FLOW_MISMATCH",
    "FLOW_TARGET_NOT_FOUND",
    "FLOW_TARGET_AMBIGUOUS",
    "FLOW_TARGET_RECOVERY_REQUIRED",
    "FLOW_TARGET_AUTHORITY_CORRUPT",
  ].includes(hookCtx.flowResolutionError?.code)
    || hookCtx.flowResolutionError?.code?.startsWith("FLOW_TARGET_AUTHORITY_");
  const targetResolutionError = hookCtx.flowResolutionError && (
    entry.explicitTargetResolution === true || recognizedTargetResolutionError
  )
    ? hookCtx.flowResolutionError
    : null;
  if (
    targetResolutionError
    && !(
      entry.deferTargetNotFound === true
      && targetResolutionError.code === "FLOW_TARGET_NOT_FOUND"
    )
  ) {
    const failureCode = targetResolutionError.code === "FLOW_TARGET_NOT_FOUND"
      && entry.targetNotFoundAsMismatch === true
      ? "ACTIVE_FLOW_MISMATCH"
      : targetResolutionError.code || "FLOW_TARGET_RESOLUTION_FAILED";
    emitTargetFailure(Envelope.fail(
      envelopeType || "run",
      envelopeKey || "?",
      failureCode,
      targetResolutionError.message,
      targetResolutionError.data,
    ));
    return;
  }
  const targetMismatch = entry.targetGuard === false
    ? null
    : buildHookCtx
      ? targetMismatchEnvelopeForInput({
          type: envelopeType || "run",
          key: envelopeKey || "?",
          input,
          flowState: hookCtx.preparingFlowState ?? hookCtx.flowState,
          mainRoot: hookCtx.mainRoot || hookCtx.root,
          authorityRoot: hookCtx.root,
          worktreePath: hookCtx.flowState?.worktree === true ? hookCtx.root : undefined,
          context: hookCtx,
        })
      : null;
  if (targetMismatch) {
    emitTargetFailure(targetMismatch);
    return;
  }

  // 4. Load Command class
  const mod = await entry.command();
  const CommandClass = mod.default;
  if (!CommandClass || typeof CommandClass !== "function") {
    writeErr(`dispatcher: module has no default export (Command class)\n`);
    setExit(1);
    return;
  }
  Command.validate(CommandClass);

  const mode = CommandClass.outputMode;

  const runtimeLogActiveNode = hookCtx.flowState ? findActiveNode(hookCtx.flowState) : null;

  openRuntimeLog(hookCtx);

  const emitPreconditionFailure = (code, message) => {
    const env = Envelope.fail(envelopeType || "run", envelopeKey || "?", code, message);
    attachRuntimeLog(env, runtimeLog?.metadata);
    writeOut(JSON.stringify(env.toJSON(), null, 2) + "\n");
    setExit(1);
  };
  const persistRuntimeLogMetadata = (result) => {
    const metadata = closedRuntimeLogMetadata;
    const requestedStepId = runtimeLogStepId(entry, hookCtx, result);
    // Public task aliases name the current task leaf before it is confirmed.
    // Persist metadata under that immutable node id so a successful command
    // does not need a now-cleared current Attempt to resolve the alias again.
    const stepId = runtimeLogActiveNode?.scope === "task"
      && typeof requestedStepId === "string"
      && requestedStepId.startsWith("task-")
      ? runtimeLogActiveNode.stepId
      : requestedStepId;
    if (metadata && stepId && hookCtx.flowManager && hookCtx.flowState) {
      hookCtx.flowManager.setStepRuntimeLog(stepId, metadata.toStepMetadata(), {
        ...(hookCtx.specId ? { specId: hookCtx.specId } : {}),
        taskId: taskIdForResolvedStep(runtimeLogActiveNode, stepId),
      });
    }
  };

  // 5a. requiresConfig — reject early when the command declares config as a
  // precondition but the container has no config registered (setup not run).
  if (entry.requiresConfig && container.get("config") == null) {
    emitPreconditionFailure("NO_CONFIG", "config.json not found. Run sennel setup first.");
    closeRuntimeLog();
    persistRuntimeLogMetadata(null);
    if (restoreStreams) restoreStreams();
    return;
  }

  // 5b. requiresFlow (flow domain only — hooks expect flowState present).
  // Skipped for non-flow entries or when buildHookCtx is absent.
  if (entry.requiresFlow !== false && buildHookCtx && !hookCtx.flowState) {
    emitPreconditionFailure("NO_FLOW", "no active flow (flow.json not found)");
    closeRuntimeLog();
    persistRuntimeLogMetadata(null);
    if (restoreStreams) restoreStreams();
    return;
  }

  // Bind the exact active Attempt before any registry lifecycle hook can
  // confirm, fail, or replace it.  Error handling below can therefore record
  // a tooling failure only for this command's original Attempt.
  const lifecycleAttemptBinding = DefinitionLifecycleAttemptBinding.capture({
    hookCtx,
    envelopeType,
    envelopeKey,
    registryFailureOwnership: entry.failureOwnership ?? null,
  });

  // 6. pre
  if (entry.pre) {
    try {
      await entry.pre(hookCtx);
    } catch (err) {
      if (hookCtx.flowOutboxEntry && entry.onError) {
        try { await entry.onError(hookCtx, err); } catch (onErrorErr) {
          writeErr(`[onError hook] ${onErrorErr.message || onErrorErr}\n`);
        }
      }
      recordDefinitionLifecycleToolingFailure(
        lifecycleAttemptBinding,
        err,
        "PRE_HOOK_FAILED",
        writeErr,
      );
      await emitFailure({
        err,
        mode,
        envelopeType,
        envelopeKey,
        writeOut,
        writeErr,
        setExit,
        runtimeLogMetadata: runtimeLog?.metadata,
        flowContext: hookCtx,
      });
      closeRuntimeLog();
      persistRuntimeLogMetadata(null);
      if (restoreStreams) restoreStreams();
      return;
    }
  }

  // 7. execute via Command.run
  let result;
  let caught;
  if (hookCtx.flowOutboxEntry?.status === "done") {
    result = structuredClone(hookCtx.flowOutboxEntry.result);
    hookCtx.flowOutboxResumed = true;
  } else {
    try {
      const cmd = new CommandClass();
      input._envelopeType = envelopeType;
      input._envelopeKey = envelopeKey;
      const commandInput = hookCtx.flowOutboxEntry
        ? { ...input, flowOutboxEntry: hookCtx.flowOutboxEntry }
        : input;
      if (
        envelopeKey === "finalize-cleanup"
        && typeof mod.commitFinalizeCleanupPostCommandMetadata === "function"
      ) {
        commandInput._deferFinalizeCompletionCommit = true;
      }
      result = await cmd.run(container, commandInput);
    } catch (err) {
      caught = err;
    }
  }

  // 8a. Success path
  if (!caught) {
    // Keep the command result available to lifecycle settlement and runtime
    // metadata even when a post hook replaces only the public Envelope.
    let envelope;
    if (mode === "envelope") {
      // Commands may return an Envelope directly (e.g. Envelope.fail for
      // recoverable / user-avoidable outcomes). In that case honor it verbatim
      // rather than re-wrapping it in Envelope.ok.
      if (result instanceof Envelope) {
        envelope = result;
      } else {
        envelope = Envelope.ok(envelopeType || "run", envelopeKey || "?", result || {});
      }
    }
    let postFailed = false;
    // Skip post hooks when the command explicitly returned an ok:false envelope —
    // post hooks advance step status / counters assuming success, which would
    // fire incorrectly on a judgment-result rejection.
    const skipPost = result instanceof Envelope && result.ok === false;
    const deferFinalizeCompletion = !skipPost
      && envelopeKey === "finalize-cleanup"
      && typeof mod.commitFinalizeCleanupPostCommandMetadata === "function";
    if (skipPost) {
      const failure = new Error(
        result.errors.flatMap((item) => item.messages || []).join("; ") || `${envelopeKey || "command"} failed`,
      );
      failure.code = result.errors.find((item) => item?.level === "fatal")?.code
        || result.errors[0]?.code
        || "COMMAND_ENVELOPE_FAILED";
      if (hookCtx.flowOutboxEntry && entry.onError) {
        try {
          await entry.onError(hookCtx, failure);
        } catch (onErrorErr) {
          postFailed = true;
          if (mode === "envelope") envelope.addWarning("ON_ERROR_HOOK_FAILED", onErrorErr.message || String(onErrorErr));
          else writeErr(`[onError hook] ${onErrorErr.message || onErrorErr}\n`);
        }
      }
      recordDefinitionLifecycleToolingFailure(
        lifecycleAttemptBinding,
        failure,
        "COMMAND_ENVELOPE_FAILED",
        writeErr,
      );
    }
    if (entry.post && !skipPost) {
      try {
        const postResult = await entry.post(hookCtx, result);
        if (postResult instanceof Envelope && mode === "envelope") envelope = postResult;
      } catch (postErr) {
        postFailed = true;
        recordDefinitionLifecycleToolingFailure(
          lifecycleAttemptBinding,
          postErr,
          "POST_HOOK_FAILED",
          writeErr,
          result,
        );
        if (mode === "envelope") {
          if (postErr instanceof FatalPostHookError) {
            envelope.addFatal(postErr.code, postErr.message);
          } else {
            envelope.addWarning("POST_HOOK_FAILED", postErr.message || String(postErr));
          }
        } else {
          writeErr(`[post hook] ${postErr.message || postErr}\n`);
        }
      }
    }
    // Nonblocking evidence is an audit record, not a lifecycle transition.
    // Record it after the ordinary hook has durably recorded the check
    // attempt.  Failed Envelopes still reach this hook, but a stale artifact
    // alone is never accepted as a newly completed attempt.
    if (entry.nonblockingPost && !hookCtx.flowOutboxResumed) {
      try {
        await entry.nonblockingPost(hookCtx, result);
      } catch (nonblockingError) {
        postFailed = true;
        recordDefinitionLifecycleToolingFailure(
          lifecycleAttemptBinding,
          nonblockingError,
          "NONBLOCKING_POST_FAILED",
          writeErr,
        );
        if (mode === "envelope") {
          envelope.addWarning("NONBLOCKING_EVIDENCE_RECORD_FAILED", nonblockingError.message || String(nonblockingError));
          envelope.ok = false;
          envelope.errors.push({
            level: "fatal",
            code: "NONBLOCKING_EVIDENCE_RECORD_FAILED",
            messages: [nonblockingError.message || String(nonblockingError)],
          });
          attachNonblockingContinuation(envelope, hookCtx, "The nonblocking evidence record was not durably saved.");
        } else {
          writeErr(`[nonblocking evidence] ${nonblockingError.message || nonblockingError}\n`);
        }
      }
    }
    if (deferFinalizeCompletion) {
      closeRuntimeLog();
      try {
        await persistFinalizeCleanupPostReturnMetadata({
          envelopeKey,
          hookCtx,
          metadata: closedRuntimeLogMetadata,
          commandModule: mod,
          commitCompletion: true,
        });
      } catch (completionError) {
        postFailed = true;
        recordDefinitionLifecycleToolingFailure(
          lifecycleAttemptBinding,
          completionError,
          "FINALIZE_COMPLETION_COMMIT_FAILED",
          writeErr,
        );
        if (mode === "envelope") {
          envelope.addFatal(
            "FINALIZE_COMPLETION_COMMIT_FAILED",
            completionError.message || String(completionError),
          );
        } else {
          writeErr(`[finalize completion] ${completionError.message || completionError}\n`);
        }
      }
    }
    if (mode === "envelope") {
      settleTypedStepOutcome(envelope, result);
      if (envelope.ok === false) {
        attachNonblockingContinuation(envelope, hookCtx, "The normal Flow operation did not complete.");
      }
      if (envelope instanceof Envelope && envelope.ok === false) attachRuntimeLog(envelope, runtimeLog?.metadata);
      writeOut(JSON.stringify(envelope.toJSON(), null, 2) + "\n");
      emitFinalizeCleanupReportDisplay({ envelopeKey, envelope, writeErr });
      setExit(envelope.ok && !postFailed ? 0 : 1);
    } else if (postFailed) {
      setExit(1);
    }
    closeRuntimeLog();
    if (!deferFinalizeCompletion) {
      await persistFinalizeCleanupPostReturnMetadata({
        envelopeKey,
        hookCtx,
        metadata: closedRuntimeLogMetadata,
        commandModule: mod,
      });
    }
    persistRuntimeLogMetadata(result);
    if (restoreStreams) restoreStreams();
    return;
  }

  // 8b. Failure path
  if (entry.onError) {
    try {
      await entry.onError(hookCtx, caught);
    } catch (onErrorErr) {
      writeErr(`[onError hook] ${onErrorErr.message || onErrorErr}\n`);
    }
  }
  recordDefinitionLifecycleToolingFailure(
    lifecycleAttemptBinding,
    caught,
    "COMMAND_FAILED",
    writeErr,
  );
  await emitFailure({
    err: caught,
    mode,
    envelopeType,
    envelopeKey,
    writeOut,
    writeErr,
    setExit,
    runtimeLogMetadata: runtimeLog?.metadata,
    flowContext: hookCtx,
  });
  closeRuntimeLog();
  await persistFinalizeCleanupPostReturnMetadata({
    envelopeKey,
    hookCtx,
    metadata: closedRuntimeLogMetadata,
    commandModule: mod,
  });
  persistRuntimeLogMetadata(null);
  if (restoreStreams) restoreStreams();
}

async function resolveOutputMode(entry) {
  try {
    const mod = await entry.command();
    return mod.default?.outputMode || "raw";
  } catch {
    return "raw";
  }
}

function emitFailure({
  err,
  mode,
  envelopeType,
  envelopeKey,
  writeOut,
  writeErr,
  setExit,
  runtimeLogMetadata,
  flowContext,
}) {
  if (mode === "envelope") {
    const code = err?.code || "ERROR";
    const env = Envelope.fail(envelopeType || "run", envelopeKey || "?", code, String(err?.message || err));
    const errorData = err?.data !== undefined
      ? err.data
      : err instanceof AgentFailure
        ? err.toJSON()
        : undefined;
    if (errorData !== undefined) env.data = errorData;
    if (err?.continuation) {
      try {
        attachFlowContinuation(env, FlowContinuation.fromStored(err.continuation));
      } catch {
        attachNonblockingContinuation(env, flowContext, "The normal Flow operation did not complete.");
      }
    } else {
      attachNonblockingContinuation(env, flowContext, "The normal Flow operation did not complete.");
    }
    attachRuntimeLog(env, runtimeLogMetadata);
    writeOut(JSON.stringify(env.toJSON(), null, 2) + "\n");
  } else {
    writeErr(`${err?.stack || err?.message || err}\n`);
    if (runtimeLogMetadata) {
      writeErr(`runtimeLog.runId=${runtimeLogMetadata.runId} runtimeLog.sequence=${runtimeLogMetadata.sequence}\n`);
    }
  }
  setExit(err?.exitCode ?? 1);
}
