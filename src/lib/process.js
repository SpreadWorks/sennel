/** Unified registered execution boundaries; bootstrap probes live separately. */
import { AgentTimeout } from "./agent-timeout.js";
import { CommandInvocation, normalizeCommandInvocation } from "./command-invocation.js";
import { ProcessExecutionRuntime, ProcessExecutionGrant, ProcessExecutionControlFailure, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { runCommandInSynchronousBridge } from "./process-execution-sync.js";
import { processExecutionPublicationFailure } from "./process-execution-completion.js";

const DEFAULT_PROCESS_MAX_BUFFER = 1024 * 1024;

export function standaloneTestEnvironment(environment = process.env) {
  const { NODE_TEST_CONTEXT: _nodeTestContext, [PROCESS_EXECUTION_SCOPE_ENV]: _processScope, ...standalone } = environment;
  return standalone;
}

function invocationInput(command, args, options) {
  if (command instanceof CommandInvocation && args !== undefined && !Array.isArray(args)) {
    options = args; args = [];
  }
  return { invocation: normalizeCommandInvocation(command, args, options), options };
}

function output(value, encoding) {
  if (encoding === "buffer") return value == null ? Buffer.alloc(0) : Buffer.from(value);
  return typeof value === "string" ? value : value == null ? "" : Buffer.from(value).toString(encoding || "utf8");
}

function commandResult(completed, options, error = null) {
  const receipt = completed.processExecutionStopReceipt ?? error?.processExecutionStopReceipt;
  const code = typeof completed.code === "number" ? completed.code : typeof error?.code === "number" ? error.code : null;
  return { ok: error === null && code === 0 && !completed.signal, status: code ?? 1,
    stdout: output(completed.stdout, options.encoding),
    stderr: output(completed.stderr || error?.message || "", options.encoding),
    signal: completed.signal ?? error?.signal ?? null, killed: Boolean(error?.killed),
    errorCode: typeof error?.code === "string" ? error.code : null,
    ...(receipt && { processExecutionStopReceipt: receipt instanceof ProcessExecutionStopReceipt ? receipt : new ProcessExecutionStopReceipt(receipt),
      stopEvidence: receipt.stopEvidence ?? new ProcessExecutionStopReceipt(receipt).stopEvidence }),
  };
}

function commandFailureResult(error, options) {
  if (error instanceof ProcessExecutionControlFailure) {
    // The result-style API has always returned bounded-output failures. Only
    // an exact completion receipt permits this adapter; unknown control stays
    // exceptional. Managed execution itself retains its typed refusal.
    if (error.reason !== "output-limit" || !(error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt)) throw error;
    const resultError = Object.assign(new Error(error.message), error, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    return commandResult(resultError, options, resultError);
  }
  return commandResult(error, options, error);
}

function rejectedSignal(signal, options) {
  if (signal != null && !(signal instanceof AbortSignal)) {
    const error = new TypeError("Process signal must be an AbortSignal"); error.code = "ERR_INVALID_ARG_TYPE";
    return commandResult({}, options, error);
  }
  if (signal?.aborted) {
    const error = new Error("The operation was aborted"); error.code = "ABORT_ERR";
    return commandResult({}, options, error);
  }
  return null;
}

/** A persistent worker owns execution while this thread waits synchronously. */
export function runCmd(command, args, opts = {}) {
  const { invocation, options } = invocationInput(command, args, opts);
  const rejected = rejectedSignal(options.signal, options);
  if (rejected !== null) return rejected;
  const runtime = ProcessExecutionRuntime.current();
  let grant = runtime?.remoteGrant() ?? null;
  if (grant === null && process.env[PROCESS_EXECUTION_SCOPE_ENV] !== undefined) {
    try { grant = new ProcessExecutionGrant(JSON.parse(process.env[PROCESS_EXECUTION_SCOPE_ENV])).toJSON(); }
    catch (cause) { throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context is malformed", { cause }); }
  }
  let result, bodyFailure;
  let failed = false;
  try {
    result = runCommandInSynchronousBridge(invocation, { ...options,
      timeout: options.timeout || new AgentTimeout().toMilliseconds(), maxBuffer: options.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
    }, grant);
  } catch (error) { failed = true; bodyFailure = error; }
  try { runtime?.drainEventsSync(); }
  catch (error) {
    const completion = failed ? bodyFailure : result;
    if (completion?.processExecutionStopReceipt != null) {
      completion.stdout = output(completion.stdout, options.encoding);
      completion.stderr = output(completion.stderr, options.encoding);
    }
    throw processExecutionPublicationFailure(error, completion, {
      executionId: runtime?.executionId ?? null, role: runtime?.parentCallId == null ? "executor" : "descendant",
    });
  }
  return failed ? commandFailureResult(bodyFailure, options) : commandResult(result, options);
}

export async function runCmdAsync(command, args, opts = {}) {
  const { invocation, options } = invocationInput(command, args, opts);
  const rejected = rejectedSignal(options.signal, options);
  if (rejected !== null) return rejected;
  const { executeManagedProcess } = await import("./managed-process.js");
  try {
    const completed = await executeManagedProcess(invocation, [], {
      runtime: ProcessExecutionRuntime.current(), repositoryRoot: options.repositoryRoot, readOnly: options.readOnly === true,
      timeoutMs: options.timeout || new AgentTimeout().toMilliseconds(), maxBuffer: options.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
      encoding: options.encoding, stdinContent: options.input, abortSignal: options.signal,
      processExecutionBinding: options.processExecutionBinding, onProcessExecutionStop: options.onProcessExecutionStop,
    });
    return commandResult(completed, options);
  } catch (error) {
    return commandFailureResult(error, options);
  }
}

export const runManagedCmdAsync = runCmdAsync;

export function formatError(res) {
  const parts = [];
  if (res.signal) parts.push(`signal=${res.signal}${res.killed ? " (killed)" : ""}`);
  parts.push(`exit=${res.status}`);
  if (res.stderr) parts.push(res.stderr);
  return parts.join(" | ");
}

export function assertOk(res, context) {
  if (!res.ok) throw new Error(context + ": " + formatError(res));
}
