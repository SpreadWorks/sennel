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
import { isFlowFormatError } from "./flow-format-error.js";
import { Envelope } from "./flow-envelope.js";
import { RuntimeLogBlockWriter } from "./runtime-log.js";
import { targetMismatchEnvelopeForInput } from "./flow-target-guard.js";
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
import { FinalizeFlowStateOwner } from "../flow/lib/finalize-flow-state-owner.js";
import { FatalPostHookError } from "./post-hook-error.js";
import { AgentFailure } from "./agent-failure.js";
import { DefinitionLifecycleAttemptBinding, isStepPersistenceFailure } from "../flow/lib/definition-lifecycle-failure.js";
import { isStepAdmissionRefusal } from "../flow/lib/step-admission-refusal.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { flowProcessRuntimeRequired, withFlowProcessRuntime } from "../flow/lib/process-runtime-admission.js";
import { nonblockingFailureContinuation } from "../flow/lib/nonblocking-command-failure.js";
import { FlowStopFacts, publicFlowErrorMessage, selectedFlowStopDirective } from "./flow-stop-guidance.js";

function attachSelectedFailureContinuation(envelope, ctx, error = null) {
  if (!(envelope instanceof Envelope) || selectedFlowStopDirective(envelope.data) !== null
    || envelope.data?.continuation || envelope.data?.actionPrompt) return envelope;
  const continuation = nonblockingFailureContinuation({ state: ctx?.flowState, error,
    targetContext: ctx ?? null });
  if (continuation !== null) attachFlowContinuation(envelope, continuation);
  return envelope;
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

function recordDefinitionLifecycleToolingFailure(binding, error, fallbackCode, writeErr, commandResult = null, onFailure = null) {
  if (!(binding instanceof DefinitionLifecycleAttemptBinding)) return false;
  try {
    return binding.toolingFailure(error, fallbackCode, commandResult);
  } catch (recordingError) {
    onFailure?.(recordingError);
    writeErr(`[definition lifecycle failure] ${publicFlowErrorMessage(recordingError)}\n`);
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
async function executeDispatch({
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
  publication,
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
    recordedExitCode = Math.max(recordedExitCode, code);
    baseSetExit(recordedExitCode);
  };
  let closedRuntimeLogMetadata = null;
  let runtimeLogCloseAttempted = false;
  let restoreStreams = null;
  let canonicalMetadataError = null;
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
  };
  const captureProcessStreams = () => {
    if (restoreStreams) return;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = function(chunk, encoding, cb) {
      if (runtimeLog && processCaptureSuppressed.stdout === 0) runtimeLog.capture("stdout", chunk);
      if ((publication.mode === "envelope" || publication.flowBoundary) && processCaptureSuppressed.stdout === 0) {
        if (publication.mode === "raw") publication.captureRawOutput(chunk, encoding);
        const callback = typeof encoding === "function" ? encoding : cb;
        if (callback) callback();
        return true;
      }
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
  captureProcessStreams();

  const closeRuntimeLog = () => {
    if (!runtimeLog || runtimeLogCloseAttempted) return closedRuntimeLogMetadata;
    runtimeLogCloseAttempted = true;
    publication.stage = "RUNTIME_LOG_CLOSE_FAILED";
    closedRuntimeLogMetadata = runtimeLog.close(recordedExitCode);
    return closedRuntimeLogMetadata;
  };

  const queueEnvelope = (envelope) => {
    publication.accept(envelope);
    if (runtimeLog && !closedRuntimeLogMetadata) {
      // This is the candidate response, held until all durable finalizers settle.
      // A later finalizer failure is merged into the sole public response.
      runtimeLog.capture("stdout", JSON.stringify({
        publication: "pending", ok: envelope.ok, type: envelope.type,
        key: envelope.key, errors: envelope.errors,
      }) + "\n");
    }
  };
  publication.cleanup = () => {
    try { closeRuntimeLog(); }
    finally { if (restoreStreams) restoreStreams(); }
  };
  publication.stage = "ARGS_ERROR";
  const recordFailure = (binding, error, code, errorWriter, result = null) =>
    recordDefinitionLifecycleToolingFailure(binding, error, code, errorWriter, result,
      (recordingError) => {
        canonicalMetadataError = recordingError;
        publication.appendFailure(recordingError, "LIFECYCLE_FAILURE_RECORD_FAILED");
      });

  // 1. Parse argv → input. _rawArgs preserved for legacy adapters that
  //    need to reconstruct process.argv before calling into old main().
  let input;
  try {
    input = parseEntryInput(entry, argv);
    input._rawArgs = argv;
  } catch (err) {
    const helpHint = entry.helpPath
      ? `Run: ${entry.helpPath}`
      : `Run: sennel ${envelopeType || "flow"} ${envelopeKey || ""} --help`.trimEnd();
    const refusal = Envelope.fail(envelopeType || "run", envelopeKey || "?", "ARGS_ERROR", [String(err.message || err), helpHint]);
    if (publication.flowBoundary || entry.parseErrorsAsEnvelope === true) publication.accept(refusal);
    let parseHookCtx = {};
    try { parseHookCtx = buildRuntimeHookCtx({}); }
    catch (error) { publication.appendFailure(error, "FLOW_CONTEXT_FAILED"); }
    openRuntimeLog(parseHookCtx);
    const mode = publication.flowBoundary ? "envelope" : await resolveOutputMode(entry);
    publication.mode = mode;
    if (mode === "envelope" || entry.parseErrorsAsEnvelope === true) {
      const env = refusal;
      attachRuntimeLog(env, runtimeLog?.metadata);
      queueEnvelope(env);
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
  publication.stage = "FLOW_CONTEXT_FAILED";
  const hookCtx = buildRuntimeHookCtx(input);
  publication.flowContext = hookCtx;
  const emitTargetFailure = (failure) => {
    attachRuntimeLog(failure, enableRuntimeLog === true && container.has("paths")
      ? { runId: runtimeLogRunId(hookCtx) }
      : null);
    queueEnvelope(failure);
    setExit(1);
  };
  const recognizedTargetResolutionError = [
    "ACTIVE_FLOW_MISMATCH",
    "FLOW_TARGET_NOT_FOUND",
    "FLOW_TARGET_AMBIGUOUS",
    "FLOW_TARGET_RECOVERY_REQUIRED",
    "FLOW_TARGET_AUTHORITY_CORRUPT",
  ].includes(hookCtx.flowResolutionError?.code)
    || hookCtx.flowResolutionError?.code?.startsWith("FLOW_TARGET_AUTHORITY_")
    || isFlowFormatError(hookCtx.flowResolutionError);
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
  publication.stage = "COMMAND_LOAD_FAILED";
  const mod = await entry.command();
  const CommandClass = mod.default;
  if (!CommandClass || typeof CommandClass !== "function") {
    throw new Error("dispatcher: module has no default export (Command class)");
  }
  Command.validate(CommandClass);

  let mode = CommandClass.outputMode;
  publication.mode = mode;

  const runtimeLogActiveNode = hookCtx.flowState ? findActiveNode(hookCtx.flowState) : null;

  openRuntimeLog(hookCtx);

  const emitPreconditionFailure = (code, message) => {
    const env = Envelope.fail(envelopeType || "run", envelopeKey || "?", code, message);
    attachRuntimeLog(env, runtimeLog?.metadata);
    queueEnvelope(env);
    setExit(1);
  };
  const persistRuntimeLogMetadata = (result) => {
    if (isStepAdmissionRefusal(canonicalMetadataError) || isStepPersistenceFailure(canonicalMetadataError)
      || canonicalMetadataError instanceof ProcessExecutionControlFailure) return;
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
      publication.stage = "RUNTIME_LOG_METADATA_FAILED";
      hookCtx.flowManager.setStepRuntimeLog(stepId, metadata.toStepMetadata(), {
        ...(hookCtx.specId ? { specId: hookCtx.specId } : {}),
        taskId: taskIdForResolvedStep(runtimeLogActiveNode, stepId),
      });
      publication.persistence = "runtime_metadata_recorded";
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

  let lifecycleResult = null;
  let commitFinalizeCompletion = false;
  const executeLifecycle = async () => {
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
        if (err instanceof ProcessExecutionControlFailure) throw err;
        canonicalMetadataError = err;
        publication.accept(createFailureEnvelope({ err, envelopeType, envelopeKey,
          runtimeLogMetadata: runtimeLog?.metadata, flowContext: hookCtx }));
        publication.error = err;
        if (hookCtx.flowOutboxEntry && entry.onError) {
          try { await entry.onError(hookCtx, err); } catch (onErrorErr) {
            if (onErrorErr instanceof ProcessExecutionControlFailure) throw onErrorErr;
            publication.appendFailure(onErrorErr, "ON_ERROR_HOOK_FAILED");
            writeErr(`[onError hook] ${publicFlowErrorMessage(onErrorErr)}\n`);
          }
        }
        recordFailure(
          lifecycleAttemptBinding,
          err,
          "PRE_HOOK_FAILED",
          writeErr,
        );
        await emitFailure({
          err,
          mode,
          flowBoundary: publication.flowBoundary,
          envelopeType,
          envelopeKey,
          writeOut,
          writeErr,
          setExit,
          runtimeLogMetadata: runtimeLog?.metadata,
          flowContext: hookCtx,
          queueEnvelope,
        });
        return;
      }
    }

    // 7. execute via Command.run
    let result;
    let caught;
    if (hookCtx.flowOutboxEntry?.status === "done") {
      const storedResult = structuredClone(hookCtx.flowOutboxEntry.result);
      result = envelopeKey === "finalize-cleanup"
        ? await new CommandClass().execute(hookCtx)
        : storedResult;
      hookCtx.flowOutboxResumed = true;
    } else {
      try {
        const cmd = new CommandClass();
        publication.completion = "unconfirmed";
        input._envelopeType = envelopeType;
        input._envelopeKey = envelopeKey;
        const commandInput = hookCtx.flowOutboxEntry
          ? { ...input, flowOutboxEntry: hookCtx.flowOutboxEntry,
              ...(hookCtx.finalizationExecution == null ? {} : { finalizationExecution: hookCtx.finalizationExecution }),
              ...(hookCtx.finalizationEffectPreparation == null ? {} : {
                finalizationEffectPreparation: hookCtx.finalizationEffectPreparation,
              }),
              ...(hookCtx.repositoryOperationOwnerToken == null ? {} : {
                repositoryOperationOwnerToken: hookCtx.repositoryOperationOwnerToken,
              }) }
          : input;
        if (
          envelopeKey === "finalize-cleanup"
          && typeof mod.commitFinalizeCleanupPostCommandMetadata === "function"
        ) {
          commandInput._deferFinalizeCompletionCommit = true;
        }
        result = await cmd.run(container, commandInput);
        publication.completion = "command_returned";
      } catch (err) {
        caught = err;
        canonicalMetadataError = err;
      }
    }

    lifecycleResult = result;

    // 8a. Success path
    if (!caught) {
      // Keep the command result available to lifecycle settlement and runtime
      // metadata even when a post hook replaces only the public Envelope.
      let envelope;
      const useEnvelope = () => {
        if (mode !== "envelope" && !publication.flowBoundary) return false;
        mode = "envelope";
        publication.mode = mode;
        envelope ??= result instanceof Envelope ? result
          : Envelope.ok(envelopeType || "run", envelopeKey || "?", result || {});
        // Retention precedes fallible hooks and lifecycle recording. Queuing
        // diagnostics and public serialization still wait for settlement.
        publication.accept(envelope);
        return true;
      };
      if (mode === "envelope" || result instanceof Envelope) useEnvelope();
      let postFailed = false;
      // Skip post hooks when the command explicitly returned an ok:false envelope —
      // post hooks advance step status / counters assuming success, which would
      // fire incorrectly on a judgment-result rejection.
      const skipPost = result instanceof Envelope && result.ok === false;
      const deferFinalizeCompletion = !skipPost
        && envelopeKey === "finalize-cleanup"
        && typeof mod.commitFinalizeCleanupPostCommandMetadata === "function";
      commitFinalizeCompletion = deferFinalizeCompletion;
      if (skipPost) {
        const failure = ProcessExecutionControlFailure.fromEnvelope(result) ?? new Error(
          result.errors.flatMap((item) => item.messages || []).join("; ") || `${envelopeKey || "command"} failed`,
        );
        failure.code = result.errors.find((item) => item?.level === "fatal")?.code
          || result.errors[0]?.code
          || "COMMAND_ENVELOPE_FAILED";
        failure.data = result.data;
        canonicalMetadataError = failure;
        if (!(failure instanceof ProcessExecutionControlFailure) && hookCtx.flowOutboxEntry && entry.onError) {
          try {
            await entry.onError(hookCtx, failure);
          } catch (onErrorErr) {
            if (onErrorErr instanceof ProcessExecutionControlFailure) throw onErrorErr;
            postFailed = true;
            if (mode === "envelope") envelope.addWarning("ON_ERROR_HOOK_FAILED", publicFlowErrorMessage(onErrorErr));
            else writeErr(`[onError hook] ${publicFlowErrorMessage(onErrorErr)}\n`);
          }
        }
        recordFailure(
          lifecycleAttemptBinding,
          failure,
          "COMMAND_ENVELOPE_FAILED",
          writeErr,
        );
      }
      if (entry.post && !skipPost) {
        try {
          const postResult = await entry.post(hookCtx, result);
          if (postResult instanceof Envelope && useEnvelope()) {
            envelope = postResult;
            publication.accept(envelope, { replace: true });
          }
        } catch (postErr) {
          const hasEnvelope = useEnvelope();
          if (postErr instanceof ProcessExecutionControlFailure) throw postErr;
          canonicalMetadataError = postErr;
          postFailed = true;
          if (hasEnvelope) {
            if (postErr instanceof FatalPostHookError) {
              envelope.addFatal(postErr.code, publicFlowErrorMessage(postErr));
            } else {
              envelope.addWarning("POST_HOOK_FAILED", publicFlowErrorMessage(postErr));
            }
          } else {
            writeErr(`[post hook] ${publicFlowErrorMessage(postErr)}\n`);
          }
          recordFailure(
            lifecycleAttemptBinding,
            postErr,
            "POST_HOOK_FAILED",
            writeErr,
            result,
          );
        }
      }
      // Nonblocking evidence is an audit record, not a lifecycle transition.
      // Record it after the ordinary hook has durably recorded the check
      // attempt.  Failed Envelopes still reach this hook, but a stale artifact
      // alone is never accepted as a newly completed attempt.
      if (entry.nonblockingPost && !hookCtx.flowOutboxResumed
        && !(canonicalMetadataError instanceof ProcessExecutionControlFailure)) {
        try {
          await entry.nonblockingPost(hookCtx, result);
        } catch (nonblockingError) {
          const hasEnvelope = useEnvelope();
          if (nonblockingError instanceof ProcessExecutionControlFailure) throw nonblockingError;
          postFailed = true;
          if (hasEnvelope) {
            envelope.addWarning("NONBLOCKING_EVIDENCE_RECORD_FAILED", publicFlowErrorMessage(nonblockingError));
            envelope.ok = false;
            envelope.errors.push({
              level: "fatal",
              code: "NONBLOCKING_EVIDENCE_RECORD_FAILED",
              messages: [publicFlowErrorMessage(nonblockingError)],
            });
          } else {
            writeErr(`[nonblocking evidence] ${publicFlowErrorMessage(nonblockingError)}\n`);
          }
          recordFailure(
            lifecycleAttemptBinding,
            nonblockingError,
            "NONBLOCKING_POST_FAILED",
            writeErr,
          );
        }
      }
      if (mode === "envelope") {
        if (envelope.ok === false) attachSelectedFailureContinuation(envelope, hookCtx, canonicalMetadataError);
        publication.accept(envelope);
      }
      if (mode === "envelope") {
        settleTypedStepOutcome(envelope, result);
        if (envelope instanceof Envelope && envelope.ok === false) attachRuntimeLog(envelope, runtimeLog?.metadata);
        queueEnvelope(envelope);
        setExit(envelope.ok && !postFailed ? 0 : 1);
      } else if (postFailed) {
        setExit(1);
      }
      return;
    }

    // 8b. Failure path
    publication.accept(createFailureEnvelope({ err: caught, envelopeType, envelopeKey,
      runtimeLogMetadata: runtimeLog?.metadata, flowContext: hookCtx }));
    publication.error = caught;
    if (entry.onError && !(caught instanceof ProcessExecutionControlFailure)) {
      try {
        await entry.onError(hookCtx, caught);
      } catch (onErrorErr) {
        if (onErrorErr instanceof ProcessExecutionControlFailure) throw onErrorErr;
        publication.appendFailure(onErrorErr, "ON_ERROR_HOOK_FAILED");
        writeErr(`[onError hook] ${publicFlowErrorMessage(onErrorErr)}\n`);
      }
    }
    recordFailure(
      lifecycleAttemptBinding,
      caught,
      "COMMAND_FAILED",
      writeErr,
    );
    await emitFailure({
      err: caught,
      mode,
      flowBoundary: publication.flowBoundary,
      envelopeType,
      envelopeKey,
      writeOut,
      writeErr,
      setExit,
      runtimeLogMetadata: runtimeLog?.metadata,
      flowContext: hookCtx,
      queueEnvelope,
    });

  };

  publication.stage = "COMMAND_FAILED";
  const required = flowProcessRuntimeRequired({ ctx: hookCtx, envelopeType, envelopeKey, input });
  try {
    await withFlowProcessRuntime(hookCtx, async () => {
      try { await executeLifecycle(); }
      catch (error) {
        canonicalMetadataError = error;
        publication.appendFailure(error, publication.stage);
      } finally {
        if (entry.finally) {
          try { await entry.finally(hookCtx); }
          catch (error) {
            canonicalMetadataError = error;
            publication.appendFailure(error, "FINALLY_HOOK_FAILED");
          }
        }
        recordedExitCode = Math.max(recordedExitCode, publication.exitCode);
        try { closeRuntimeLog(); }
        catch (error) { publication.appendFailure(error, "RUNTIME_LOG_CLOSE_FAILED"); }
        try {
          await persistFinalizeCleanupPostReturnMetadata({ envelopeKey, hookCtx,
            metadata: closedRuntimeLogMetadata, commandModule: mod,
            commitCompletion: commitFinalizeCompletion });
        } catch (error) {
          publication.appendFailure(error, commitFinalizeCompletion
            ? "FINALIZE_COMPLETION_COMMIT_FAILED" : "FINALIZE_METADATA_FAILED");
        }
        try { persistRuntimeLogMetadata(lifecycleResult); }
        catch (error) {
          publication.persistence = "unconfirmed";
          publication.appendFailure(error, "RUNTIME_LOG_METADATA_FAILED");
        }
        publication.stage = "PROCESS_RUNTIME_CLOSE_FAILED";
      }
    }, { commandId: envelopeKey, required,
      physicalAuthority: entry.processExecutionAuthority ?? null });
    if (required) publication.stop = "confirmed";
  } catch (err) {
    // Runtime refusals never select a Step Result or consume semantic budgets.
    canonicalMetadataError = err;
    publication.appendFailure(err, publication.stage);
    closeRuntimeLog();
  } finally {
    if (restoreStreams) restoreStreams();
  }
}

async function resolveOutputMode(entry) {
  try {
    const mod = await entry.command();
    return mod.default?.outputMode || "raw";
  } catch {
    return "raw";
  }
}

function createFailureEnvelope({ err, envelopeType, envelopeKey, runtimeLogMetadata, flowContext }) {
  const code = err?.code || "ERROR";
  const env = Envelope.fail(envelopeType || "run", envelopeKey || "?", code, publicFlowErrorMessage(err));
  const errorData = err instanceof ProcessExecutionControlFailure
    ? { processExecutionControlFailure: err.toJSON() }
    : err?.data !== undefined ? err.data : err instanceof AgentFailure ? err.toJSON() : undefined;
  if (errorData !== undefined) env.data = errorData;
  if (err?.continuation) attachFlowContinuation(env, FlowContinuation.fromStored(err.continuation));
  else attachSelectedFailureContinuation(env, flowContext, err);
  attachRuntimeLog(env, runtimeLogMetadata);
  return env;
}

function emitFailure({ err, mode, flowBoundary, envelopeType, envelopeKey, writeErr, setExit,
  runtimeLogMetadata, queueEnvelope, flowContext }) {
  if (mode === "envelope" || flowBoundary) {
    queueEnvelope(createFailureEnvelope({ err, envelopeType, envelopeKey, runtimeLogMetadata, flowContext }));
    if (mode === "raw") writeErr(`Error: ${publicFlowErrorMessage(err)}\n`);
  } else {
    writeErr(`${err?.stack || err?.message || err}\n`);
    if (runtimeLogMetadata) writeErr(`runtimeLog.runId=${runtimeLogMetadata.runId} runtimeLog.sequence=${runtimeLogMetadata.sequence}\n`);
  }
  setExit(err?.exitCode ?? 1);
}

/** A command's one public response, retained through every fallible finalizer. */
class DispatchPublication {
  constructor({ envelopeType, envelopeKey, flowBoundary }) {
    this.envelopeType = envelopeType;
    this.envelopeKey = envelopeKey;
    this.flowBoundary = flowBoundary;
    this.mode = flowBoundary ? "envelope" : "raw";
    this.envelope = null;
    this.error = null;
    this.exitCode = 0;
    this.stage = "COMMAND_FAILED";
    this.flowContext = null;
    this.cleanup = null;
    this.completion = "not_started";
    this.persistence = "unconfirmed";
    this.stop = "unconfirmed";
    this.pendingRawOutput = [];
  }

  captureRawOutput(chunk, encoding) {
    this.pendingRawOutput.push(typeof chunk === "string"
      ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
  }

  accept(envelope, { replace = false } = {}) {
    if (replace && this.envelope !== null && this.envelope !== envelope) {
      // A replacement owns its public projection, including data and directive.
      // Earlier observed causes and failure status survive that replacement.
      const prior = this.envelope;
      this.envelope = envelope;
      envelope = prior;
    }
    if (this.envelope === null) this.envelope = envelope;
    else if (this.envelope !== envelope) {
      // Hooks may replace the public projection. Additional failures, however,
      // retain every earlier cause rather than replacing the first response.
      for (const entry of envelope.errors) {
        if (!this.envelope.errors.some((prior) => prior.code === entry.code
          && JSON.stringify(prior.messages) === JSON.stringify(entry.messages))) {
          this.envelope.errors.push(entry);
        }
      }
      if (!replace && this.envelope.data == null && envelope.data != null) this.envelope.data = envelope.data;
      if (!envelope.ok) this.envelope.ok = false;
    }
  }

  appendFailure(error, fallbackCode = "COMMAND_FAILED") {
    const env = createFailureEnvelope({ err: error, envelopeType: this.envelopeType,
      envelopeKey: this.envelopeKey });
    if (!error?.code) env.errors[0].code = fallbackCode;
    if (error instanceof ProcessExecutionControlFailure && this.envelope !== null) {
      // Typed physical refusals remain reconstructible by the existing owner.
      env.data = { ...this.envelope.data, ...env.data };
      this.accept(env, { replace: true });
      this.error = error;
    } else {
      this.accept(env);
      this.error ??= error;
    }
    this.exitCode = error?.exitCode || 1;
  }
}

export async function dispatch(options) {
  const { container, entry, envelopeType, envelopeKey, stdout, stderr, setExitCode } = options;
  const publication = new DispatchPublication({ envelopeType, envelopeKey,
    flowBoundary: Boolean(options.buildHookCtx) || ["get", "set", "run", "report"].includes(envelopeType) });
  const writeErr = stderr || ((text) => process.stderr.write(text));
  const setExit = setExitCode || ((code) => { process.exitCode = code; });
  try {
    await executeDispatch({ ...options, publication,
      setExitCode: (code) => { publication.exitCode = Math.max(publication.exitCode, code); } });
  } catch (error) {
    publication.appendFailure(error, publication.stage);
  } finally {
    try { publication.cleanup?.(); }
    catch (error) { publication.appendFailure(error, "RUNTIME_LOG_CLOSE_FAILED"); }
  }
  let serialized = null;
  if (publication.envelope !== null && (publication.mode === "envelope" || publication.flowBoundary)) {
    try {
      if (!publication.envelope.ok) attachSelectedFailureContinuation(
        publication.envelope, publication.flowContext, publication.error);
      publication.envelope.attachStopGuidance({ error: publication.error,
        operation: `flow ${envelopeType || "run"} ${envelopeKey || "?"}`,
        exitCode: publication.exitCode,
        facts: new FlowStopFacts({ completion: publication.completion,
          persistence: publication.persistence, stop: publication.stop }),
        t: container.has("i18n") ? container.get("i18n") : null });
      serialized = JSON.stringify(publication.envelope.toJSON(), null, 2) + "\n";
    } catch (error) {
      publication.appendFailure(error, "FLOW_RESPONSE_CONTRACT_FAILED");
      // Reuse the common contract for an invalid producer projection, without
      // accepting its potentially conflicting next-action authority.
      const failure = createFailureEnvelope({ err: error, envelopeType, envelopeKey });
      failure.errors = [...publication.envelope.errors];
      failure.attachStopGuidance({ error, operation: `flow ${envelopeType || "run"} ${envelopeKey || "?"}`, exitCode: 1 });
      serialized = JSON.stringify(failure.toJSON(), null, 2) + "\n";
      publication.envelope = failure;
    }
  } else if (!publication.error && publication.pendingRawOutput.length > 0) {
    serialized = Buffer.concat(publication.pendingRawOutput);
  }
  if (serialized !== null) {
    // No fallible semantic work follows this publication point. A broken
    // stdout transport gets only the minimal stderr/exit path, never new JSON.
    try {
      (stdout || ((text) => process.stdout.write(text)))(serialized);
      emitFinalizeCleanupReportDisplay({ envelopeKey, envelope: publication.envelope, writeErr });
    } catch {
      publication.exitCode = 1;
      try { writeErr("STDOUT_DELIVERY_FAILED: response delivery failed.\n"); } catch { /* The transport is unavailable. */ }
    }
  } else if (publication.error) {
    writeErr(`${publication.error?.message || publication.error}\n`);
  }
  setExit(publication.exitCode);
}
