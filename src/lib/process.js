/** Unified registered execution boundaries; bootstrap probes live separately. */
import { AgentTimeout } from "./agent-timeout.js";
import { CommandInvocation, normalizeCommandInvocation } from "./command-invocation.js";
import { ProcessExecutionRuntime, ProcessExecutionGrant, ProcessExecutionControlFailure, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { runCommandInSynchronousBridge, runCommandsInSynchronousBridge } from "./process-execution-sync.js";
import { processExecutionPublicationFailure, retainExecutionCompletion, processExecutionControlFailureFromCause } from "./process-execution-completion.js";

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
    ...((completed.processExecutionHistory ?? error?.processExecutionHistory) && {
      processExecutionHistory: completed.processExecutionHistory ?? error.processExecutionHistory }),
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

function currentCommandGrant(runtime) {
  let grant = runtime?.remoteGrant() ?? null;
  if (grant === null && process.env[PROCESS_EXECUTION_SCOPE_ENV] !== undefined) {
    try { grant = new ProcessExecutionGrant(JSON.parse(process.env[PROCESS_EXECUTION_SCOPE_ENV])).toJSON(); }
    catch (cause) { throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context is malformed", { cause }); }
  }
  return grant;
}

class SynchronousCommandCompletion {
  constructor(value, failure, failed) {
    if (typeof failed !== "boolean" || !failed && failure !== undefined) throw new TypeError("Synchronous completion requires its exact operation outcome");
    this.value = value; this.failure = failure; this.failed = failed; Object.freeze(this);
  }
  static capture(operation) {
    try { return new SynchronousCommandCompletion(operation(), undefined, false); }
    catch (error) { return new SynchronousCommandCompletion(undefined, error, true); }
  }
  publicationFailure(error, runtime, normalizeCompletion = () => {}) {
    const completion = this.failed ? this.failure : this.value;
    normalizeCompletion(completion);
    return processExecutionPublicationFailure(error, completion, {
      executionId: runtime?.executionId ?? null, role: runtime?.parentCallId == null ? "executor" : "descendant",
    });
  }
  unwrap() { if (this.failed) throw this.failure; return this.value; }
  toResult(options) { return this.failed ? commandFailureResult(this.failure, options) : commandResult(this.value, options); }
}

function withSynchronousCommandPublication(runtime, invoke, normalizeCompletion = () => {}, grant = currentCommandGrant(runtime)) {
  const completion = SynchronousCommandCompletion.capture(() => invoke(grant));
  try { runtime?.drainEventsSync(); }
  catch (error) { throw completion.publicationFailure(error, runtime, normalizeCompletion); }
  return completion;
}

/** Defer one synchronous command-producing unit while retaining normal control failures. */
export function withDeferredSynchronousCommandPublication(operation) {
  const runtime = ProcessExecutionRuntime.current();
  if (runtime === null) return operation();
  let completion;
  try {
    return runtime.withDeferredEventPublicationSync(() => {
      completion = SynchronousCommandCompletion.capture(operation);
      return completion.unwrap();
    });
  } catch (error) {
    if (completion.failed && error === completion.failure) throw error;
    throw completion.publicationFailure(error, runtime);
  }
}

/** One normalized command, reusable by scoped execution groups. */
export class CommandExecution {
  constructor(command, args = [], opts = {}) {
    const { invocation, options } = invocationInput(command, args, opts);
    // Invocation owns captured cwd/environment/stdio. Reapplying mutable
    // producer options at run time would change that normalized provenance.
    const { cwd: _cwd, env: _env, stdio: _stdio, ...executionOptions } = options;
    this.invocation = invocation; this.options = Object.freeze(executionOptions); Object.freeze(this);
  }
  acceptResult(result) { return result; }
  run() { return this.acceptResult(runCmd(this.invocation, [], this.options)); }
  async runAsync() { return this.acceptResult(await runCmdAsync(this.invocation, [], this.options)); }
  static runTogether(executions) {
    executions = [...executions];
    return runCmdBatch(executions).map((result, index) => executions[index].acceptResult(result));
  }
}

/** Failure retains every settled member without inventing one group receipt. */
export class CommandExecutionBatchFailure extends AggregateError {
  constructor(errors, outcomes, results, indices = []) {
    if (errors.length === 0) throw new TypeError("Command group failure requires an actual failed operation");
    super(errors, "Independent command group could not complete every registered operation", { cause: errors[0] });
    this.name = "CommandExecutionBatchFailure";
    this.outcomes = Object.freeze([...outcomes]); this.results = Object.freeze([...results]);
    this.outcomeIndices = Object.freeze(indices.slice(0, outcomes.length));
  }
  /** Preserve the first exact control provenance and every sibling cause.
   * Its receipt, when present, belongs only to that named call, not the group.
   */
  controlFailure() {
    return processExecutionControlFailureFromCause(this);
  }
}

/** A persistent worker owns execution while this thread waits synchronously. */
export function runCmd(command, args, opts = {}) {
  const { invocation, options } = invocationInput(command, args, opts);
  const rejected = rejectedSignal(options.signal, options);
  if (rejected !== null) return rejected;
  const runtime = ProcessExecutionRuntime.current();
  const completed = withSynchronousCommandPublication(runtime, (grant) => runCommandInSynchronousBridge(invocation, { ...options,
    timeout: options.timeout || new AgentTimeout().toMilliseconds(), maxBuffer: options.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
  }, grant), (completion) => {
    if (completion?.processExecutionStopReceipt != null) {
      completion.stdout = output(completion.stdout, options.encoding);
      completion.stderr = output(completion.stderr, options.encoding);
    }
  });
  return completed.toResult(options);
}

/** Execute all independent members and retain each original result contract. */
export function runCmdBatch(executions) {
  executions = [...executions];
  if (executions.some((execution) => !(execution instanceof CommandExecution))) throw new TypeError("Command group requires normalized CommandExecution entries");
  const results = executions.map((execution) => rejectedSignal(execution.options.signal, execution.options));
  const indices = executions.flatMap((_execution, index) => results[index] === null ? [index] : []);
  if (indices.length === 0) return results;
  const runtime = ProcessExecutionRuntime.current();
  const grant = currentCommandGrant(runtime);
  if (grant === null) {
    // Without shared scoped authority, preserve each original owning lifetime
    // and communication deadline. A control refusal stops later unscheduled
    // members, exactly as ordinary sequential use of the existing API.
    for (const index of indices) {
      const execution = executions[index];
      try { results[index] = runCmd(execution.invocation, [], execution.options); }
      catch (error) { throw new CommandExecutionBatchFailure([error], [], results); }
    }
    return results;
  }
  const selected = indices.map((index) => new CommandExecution(executions[index].invocation, [], {
    ...executions[index].options, timeout: executions[index].options.timeout || new AgentTimeout().toMilliseconds(),
    maxBuffer: executions[index].options.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
  }));
  let outcomes = [];
  let completed;
  try {
    completed = withSynchronousCommandPublication(runtime, () => {
      outcomes = runCommandsInSynchronousBridge(selected, grant); return outcomes;
    }, undefined, grant);
  } catch (publication) {
    const errors = [publication];
    for (const outcome of outcomes) { try { outcome.unwrap(); } catch (error) { errors.push(error); } }
    throw new CommandExecutionBatchFailure(errors, outcomes, results, indices);
  }
  try { completed.unwrap(); }
  catch (error) { throw new CommandExecutionBatchFailure([error], outcomes, results, indices); }
  const errors = [];
  outcomes.forEach((outcome, offset) => {
    const index = indices[offset], options = executions[index].options;
    let value, bodyFailure;
    let failed = false;
    try { value = outcome.unwrap(); }
    catch (error) { failed = true; bodyFailure = error; }
    try { results[index] = failed ? commandFailureResult(bodyFailure, options) : commandResult(value, options); }
    catch (failure) { errors.push(failure); }
  });
  if (errors.length !== 0) throw new CommandExecutionBatchFailure(errors, outcomes, results, indices);
  return results;
}

export async function runCmdAsync(command, args, opts = {}) {
  const { invocation, options } = invocationInput(command, args, opts);
  const rejected = rejectedSignal(options.signal, options);
  if (rejected !== null) return rejected;
  const { executeManagedProcess } = await import("./managed-process.js");
  try {
    const completed = await executeManagedProcess(invocation, [], {
      runtime: ProcessExecutionRuntime.current(), repositoryRoot: options.repositoryRoot, readOnly: options.readOnly === true,
      retainedControl: options.retainedControl === true,
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
