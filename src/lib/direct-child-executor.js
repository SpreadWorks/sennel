import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CommandInvocation, CommandLaunchDescriptor, normalizeCommandInvocation } from "./command-invocation.js";
import { PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { resolveExecutableInvocation } from "./executable-resolution.js";
import { ManagedOutputSpool } from "./managed-process-output.js";
import { ChildExitObservation, ProcessExecutorIdentity, ProcessOutputState,
  ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic, ProcessExecutionStopReceipt, ProcessExecutionCommandDescriptor } from "./process-execution-values.js";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "./agent-timeout.js";
import { AgentTimeoutError, DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS } from "./process-supervisor.js";
import { processExecutionPublicationFailure, retainExecutionCompletion } from "./process-execution-completion.js";

const executorSession = randomUUID();
const executions = new Map();

export class DirectChildExecutionResult {
  constructor({ call, outcome, receipt, stdout, stderr }) {
    this.providerStarted = outcome.providerStarted;
    this.code = outcome.code; this.signal = outcome.signal;
    this.stdout = stdout; this.stderr = stderr;
    this.timing = outcome.timing;
    this.stdinError = outcome.stdinError;
    this.processExecutionStopReceipt = receipt instanceof ProcessExecutionStopReceipt ? receipt : new ProcessExecutionStopReceipt(receipt);
    this.stopEvidence = this.processExecutionStopReceipt.stopEvidence;
    this.registeredExecutionQuiescence = "confirmed";
    this.outputState = this.processExecutionStopReceipt.output;
    this.executionId = call.executionId; this.callId = call.callId;
  }
}

/** One actual ChildProcess stays in the caller's process and sandbox. */
export class DirectChildExecutor {
  constructor(runtime, call) {
    this.runtime = runtime; this.call = call;
    this.identity = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession, launchClaim: randomUUID() });
    this.child = null;
    this.spawned = false;
    this.observation = null;
    this.controlFailure = null;
    this.events = Promise.resolve();
  }
  static async execute(command, args, options) {
    const runtime = options.runtime;
    const requested = normalizeCommandInvocation(command, args, options);
    const selectedEnvironment = requested.env ?? options.inheritedEnvironment ?? process.env;
    const invocation = resolveExecutableInvocation(requested, { environment: selectedEnvironment });
    if (!(invocation instanceof CommandInvocation)) throw new TypeError("Process resolver must return a typed invocation");
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Managed execution requires a positive finite timeout");
    const maximum = options.maxBuffer ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Managed output requires a finite non-negative byte limit");
    if (options.graceMs !== undefined && (!Number.isFinite(options.graceMs) || options.graceMs <= 0)) {
      throw new TypeError("Managed stop grace must be positive and finite");
    }
    if (options.abortSignal != null && !(options.abortSignal instanceof AbortSignal)) {
      const error = new TypeError("Process signal must be an AbortSignal"); error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (options.abortSignal?.aborted) {
      const error = new Error(options.abortSignal.reason?.message ?? "The operation was aborted", { cause: options.abortSignal.reason });
      error.code = "ABORT_ERR";
      throw error;
    }
    if (options.encoding != null && options.encoding !== "buffer" && !Buffer.isEncoding(options.encoding)) {
      const error = new TypeError("Process encoding must be buffer or a supported Buffer encoding");
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    const exitDrainMs = options.exitDrainMs ?? DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS;
    if (!Number.isFinite(exitDrainMs) || exitDrainMs <= 0) throw new TypeError("Exit output drain requires a positive finite budget");
    let stdinContent = options.stdinContent;
    if (stdinContent != null && typeof stdinContent !== "string") {
      if (!ArrayBuffer.isView(stdinContent)) {
        const error = new TypeError("Process stdin must be a string or a byte view");
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
      }
      // Snapshot the view's exact bytes before asynchronous admission. A caller
      // may keep and mutate its buffer while this invocation awaits a permit.
      stdinContent = Buffer.from(new Uint8Array(stdinContent.buffer, stdinContent.byteOffset, stdinContent.byteLength));
    }
    const resolved = invocation.resolvedLaunch();
    const environment = { ...(resolved.env ?? selectedEnvironment) };
    for (const key of Object.keys(environment)) if (key.toUpperCase() === PROCESS_EXECUTION_SCOPE_ENV) delete environment[key];
    const launch = new CommandLaunchDescriptor({ ...resolved.toJSON(), cwd: path.resolve(resolved.cwd ?? process.cwd()), env: environment,
      stdio: resolved.stdio === "pipe" ? [options.stdinContent == null ? "ignore" : "pipe", "pipe", "pipe"] : resolved.stdio });
    let call = null, executor = null, completion = null;
    try {
      return await runtime.withDeferredEventPublication(async () => {
        call = await runtime.reserveCall({ binding: options.processExecutionBinding ?? runtime.binding,
          kind: options.kind ?? "command", commandId: options.commandId ?? null,
          providerAttemptId: options.providerAttemptId ?? null, logicalInvocationId: options.logicalInvocationId ?? null,
          providerAttemptContext: options.providerAttemptContext ?? null, observationBinding: options.observationBinding ?? null,
          measurementId: options.measurementId ?? null, promptProcessIdentity: options.promptProcessIdentity ?? null,
          command: new ProcessExecutionCommandDescriptor(invocation.executable, invocation.args,
            { cwd: invocation.cwd ?? undefined, executionRoot: runtime.executionRoot }),
          actualCommand: invocation.toJSON(), launch: launch.toJSON(), timeoutMs, graceMs: options.graceMs });
        if (executions.has(call.callId)) return executions.get(call.callId);
        executor = new DirectChildExecutor(runtime, call);
        const result = executor.run(launch, { ...options, stdinContent, exitDrainMs, maxBuffer: maximum });
        executions.set(call.callId, result);
        try { completion = await result; return completion; }
        catch (error) { completion = error; throw error; }
      });
    }
    catch (error) {
      if (call !== null && executor !== null && completion !== null && error !== completion) {
        error = processExecutionPublicationFailure(error, completion, {
          executionId: call.executionId, callId: call.callId, role: call.parentCallId === null ? "executor" : "descendant",
        });
      }
      if (error instanceof Error) retainExecutionCompletion(error, completion);
      if (call === null || executor === null || !(error instanceof ProcessExecutionControlFailure)) throw error;
      const ownCause = (error.primaryCause.executionId === null || error.primaryCause.executionId === call.executionId)
        && (error.primaryCause.callId === null || error.primaryCause.callId === call.callId);
      const failure = error.diagnostic === null && ownCause ? new ProcessExecutionControlFailure(error.reason, error.message, {
        cause: error, executionId: call.executionId, callId: call.callId,
        diagnostic: new ProcessExecutionFailureDiagnostic({ executionId: call.executionId, callId: call.callId,
          operation: "execute", role: call.parentCallId === null ? "executor" : "descendant",
          executor: { executorId: executor.identity.executorId, executorSession: executor.identity.executorSession },
          phase: error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt ? "stopped"
            : executor.observation?.kind ?? (executor.spawned ? "running" : "claimed"),
          primaryCause: { code: error.primaryCause.code, message: error.primaryCause.message } }),
      }) : error;
      let recorded;
      try { recorded = await runtime.recordCallControlFailure(call, failure); }
      catch (reportingError) {
        const contextual = failure.withContext(call);
        contextual.cause = new AggregateError([failure, reportingError], "Process control and durable failure reporting both failed");
        retainExecutionCompletion(contextual, error);
        throw contextual;
      }
      // The durable diagnostic is intentionally small. Keep the executor's
      // verified completion and bounded bytes on the local error as well.
      const contextual = recorded.withCause(error);
      retainExecutionCompletion(contextual, error);
      throw contextual;
    }
    finally { if (executor !== null) executions.delete(call.callId); }
  }
  enqueue(event, onCommitted = null) {
    this.events = this.events.then(async () => {
      await this.runtime.observeCall(this.call, event);
      onCommitted?.();
    });
    this.events.catch((error) => { this.controlFailure ??= error; });
  }
  async run(launch, options) {
    await this.runtime.claimLaunch(this.call, { executor: this.identity });
    const maximum = options.maxBuffer ?? 8 * 1024 * 1024;
    const stdout = new ManagedOutputSpool(this.call, "stdout", maximum);
    const stderr = new ManagedOutputSpool(this.call, "stderr", maximum);
    const startAcceptedAt = new Date().toISOString();
    let startedAt = null; let finishedAt = null; let measuredStart = null; let measuredFinish = null;
    let closed = false; let drainTimer; let resolveExit;
    let timedOut = false; let aborted = options.abortSignal?.aborted === true;
    let stdinError = null; let outputFailure = null;
    let requestedStop = false; let finalAction = null;
    let outputReady = false;
    let dynamicDiagnostic = null;
    let stopRequestedAt = null;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const stop = async (reason) => {
      if (requestedStop) return;
      requestedStop = true;
      stopRequestedAt = new Date().toISOString();
      await this.runtime.beginCallStop(this.call, { reason, graceMs: options.graceMs });
    };
    const abortedListener = () => { aborted = true; stop("abort").catch((error) => { this.controlFailure ??= error; }); };
    const observeOutput = (operation) => {
      try { operation(); }
      catch (cause) {
        this.controlFailure ??= new ProcessExecutionControlFailure("output-observer-failed", "Output observer failed while the registered child was active", { cause });
        stop("control-failure").catch((failure) => { this.controlFailure ??= failure; });
      }
    };
    const observeExit = (kind, code, signal, errorCode) => {
      if (this.observation !== null) return;
      finishedAt = new Date().toISOString();
      measuredFinish = performance.now();
      this.observation = new ChildExitObservation({ executor: this.identity, kind, code, signal, errorCode, observedAt: finishedAt });
      // Parent admission closes in the coordinator before waiting for inherited pipes.
      this.enqueue({ type: "exit", observation: this.observation.toJSON() });
      if (closed) resolveExit();
      else drainTimer = setTimeout(resolveExit, options.exitDrainMs);
    };
    const notify = (type, pid = null, detail = {}) => options.onSupervisorEvent?.({ type, pid, callId: this.call.callId, executionId: this.call.executionId, ...detail });
    const observeTimeout = (diagnostic) => {
      if (timedOut) return;
      timedOut = true; dynamicDiagnostic = diagnostic;
      try { notify("timeout", this.child?.pid ?? null, diagnostic === null ? {} : { reason: diagnostic.reason }); }
      catch (cause) {
        this.controlFailure ??= new ProcessExecutionControlFailure("stop-observer-failed", "Timeout observer failed while stopping the registered child", { cause });
      }
    };
    try { notify("intent"); }
    catch (cause) { throw new ProcessExecutionControlFailure("intent-observer-failed", "Execution observer failed after the launch claim", { cause }); }
    try {
      const environment = { ...launch.env };
      const inheritedEnvironment = this.call.executionEnvironment();
      const reservedKeys = new Set(Object.keys(inheritedEnvironment).map((key) => key.toUpperCase()));
      for (const key of Object.keys(environment)) if (reservedKeys.has(key.toUpperCase())) delete environment[key];
      Object.assign(environment, inheritedEnvironment);
      const stdio = Array.isArray(launch.stdio) ? [...launch.stdio] : launch.stdio;
      this.child = spawn(launch.executable, launch.args, {
        shell: false, cwd: launch.cwd, env: environment, stdio,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      this.child.once("spawn", () => {
        this.spawned = true; startedAt = new Date().toISOString(); measuredStart = performance.now();
        this.enqueue({ type: "started", executor: this.identity.toJSON(), startedAt }, () => {
          outputReady = true;
          // Reuse bounded capture while start publication is pending; do not
          // queue raw chunks or delay physical byte/activity observations.
          for (const [spool, callback] of [[stdout, options.onStdout], [stderr, options.onStderr]]) {
            if (callback == null) continue;
            const captured = spool.buffer.toBuffer();
            if (captured.length !== 0) observeOutput(() => callback(captured.toString()));
          }
        });
        try { options.onSpawn?.(this.child); notify("spawn", this.child.pid); notify("provider-spawn", this.child.pid); }
        catch (cause) {
          this.controlFailure ??= new ProcessExecutionControlFailure("spawn-observer-failed", "Child spawn observer failed after the handle was registered", { cause });
          stop("control-failure").catch((error) => { this.controlFailure ??= error; });
        }
      });
      this.child.on("error", (error) => {
        if (!this.spawned) observeExit("spawn-failed", null, null, String(error.code ?? "SPAWN_FAILED"));
        else {
          this.controlFailure ??= new ProcessExecutionControlFailure("child-control-failed", "A running child reported a control error without exit proof", { cause: error });
          stop("control-failure").catch((failure) => { this.controlFailure = failure; });
        }
      });
      this.child.once("exit", (code, signal) => observeExit("exited", code, signal, null));
      this.child.once("close", () => { closed = true; if (this.observation !== null) { clearTimeout(drainTimer); resolveExit(); } });
      for (const [stream, spool, callback] of [["stdout", stdout, options.onStdout], ["stderr", stderr, options.onStderr]]) {
        this.child[stream]?.on("data", (bytes) => {
          if (!spool.append(bytes) && outputFailure === null) {
            outputFailure = new ProcessExecutionControlFailure("output-limit", "Registered " + stream + " exceeded its capture limit");
            stop("output-limit").catch((failure) => { this.controlFailure ??= failure; });
          }
          observeOutput(() => {
            options[stream === "stdout" ? "onStdoutBytes" : "onStderrBytes"]?.(bytes);
            options.activityMonitor?.observeOutput();
            if (outputReady) callback?.(bytes.toString());
          });
        });
      }
      if (this.child.stdin !== null) {
        this.child.stdin.on("error", (error) => {
          stdinError = error.message;
          if (options.stopOnStdinError) stop("stdin-error").catch((failure) => { this.controlFailure ??= failure; });
        });
        this.child.stdin.end(options.stdinContent ?? undefined);
      }
    } catch (error) {
      if (this.child === null) observeExit("spawn-failed", null, null, String(error.code ?? "SPAWN_FAILED"));
      else throw error;
    }
    let done = false;
    exit.then(() => { done = true; });
    const interpretControl = (control) => {
      if (control.controlFailure !== null && control.controlFailure !== undefined) {
        const failure = ProcessExecutionControlFailure.fromStored(control.controlFailure);
        if (this.observation === null) throw failure;
        this.controlFailure ??= failure;
      }
      if (control.timedOut === true) observeTimeout(null);
      aborted ||= control.aborted === true;
      if (control.stopSignal !== null && control.stopSignal !== finalAction && this.observation === null) {
        finalAction = control.stopSignal;
        // The coordinator owns leaf ordering and the original grace deadline.
        // Both signals terminate the registered handle on supported Windows Node.
        // Only exit/spawn-failed below proves completion, never kill's return.
        try { this.child.kill(finalAction); }
        catch (cause) { throw new ProcessExecutionControlFailure("stop-unconfirmed", "The registered handle rejected authorized termination without exit proof", { cause }); }
      }
      if (control.stopRequested && control.stopRemainingMs <= 0 && this.observation === null) {
        throw new ProcessExecutionControlFailure("stop-unconfirmed", "Registered child has no exit observation at the coordinator's stop cutoff");
      }
    };
    try {
      options.abortSignal?.addEventListener("abort", abortedListener, { once: true });
      // Abort events are not replayed for a listener installed after intent or
      // launch setup. Register first, then reconcile the signal's live state.
      aborted ||= options.abortSignal?.aborted === true;
      if (aborted) await stop("abort");
      options.activityMonitor?.start((diagnostic) => {
        if (requestedStop || timedOut || this.observation !== null) return;
        observeTimeout(diagnostic);
        stop("timeout").catch((error) => { this.controlFailure ??= error; });
      });
      while (!done) {
        await Promise.race([exit, delay(10)]);
        if (done) break;
        const control = await this.runtime.readCallControl(this.call, { executor: this.identity });
        interpretControl(control);
      }
      await this.events;
      const cutoffAt = new Date().toISOString();
      this.child?.stdout?.destroy(); this.child?.stderr?.destroy(); this.child?.stdin?.destroy();
      const output = new ProcessOutputState({ stdoutBytes: stdout.buffer.toBuffer().length, stderrBytes: stderr.buffer.toBuffer().length,
        completion: outputFailure !== null ? "truncated" : closed ? "complete" : "incomplete", cutoffAt });
      const outputReferences = { maximum,
        stdout: await this.runtime.persistCallOutput(this.call, { executor: this.identity, stream: "stdout", maximum, bytes: stdout.buffer.toBuffer() }),
        stderr: await this.runtime.persistCallOutput(this.call, { executor: this.identity, stream: "stderr", maximum, bytes: stderr.buffer.toBuffer() }) };
      let closure = await this.runtime.readCallControl(this.call, { executor: this.identity });
      interpretControl(closure);
      if (!closure.descendantsSettled) {
        await this.runtime.beginCallStop(this.call, { reason: "descendant-drain", graceMs: options.graceMs });
        while (!closure.descendantsSettled) {
          closure = await this.runtime.readCallControl(this.call, { executor: this.identity });
          interpretControl(closure);
          if (closure.stopRemainingMs <= 0 && !closure.descendantsSettled) {
            throw new ProcessExecutionControlFailure("stop-unconfirmed", "Registered descendants have no complete receipts at the coordinator cutoff");
          }
          if (!closure.descendantsSettled) await delay(10);
        }
      }
      const outcome = { providerStarted: this.spawned, code: this.observation.code, signal: this.observation.signal,
        timedOut, aborted, finalAction, stdinError,
        error: this.observation.kind === "spawn-failed" ? { code: this.observation.errorCode, message: "Command could not be spawned" } : null,
        timing: { startAcceptedAt, startedAt, stopRequestedAt, finishedAt,
          durationMs: measuredStart === null ? null : Math.max(0, measuredFinish - measuredStart) }, output: outputReferences };
      const receipt = await this.runtime.finishCall(this.call, { outcome, observation: this.observation, output });
      try { await options.onProcessExecutionStop?.(receipt); }
      catch (cause) {
        const receiptFailure = new ProcessExecutionControlFailure("receipt-delivery-failed", "Registered stop receipt could not be delivered to its consumer", { cause });
        const first = this.controlFailure;
        if (first === null) this.controlFailure = receiptFailure;
        else if (first instanceof ProcessExecutionControlFailure) {
          this.controlFailure = first.withCause(new AggregateError([first, receiptFailure],
            "Process control and stop receipt delivery both failed", { cause: first }));
        }
      }
      const bytes = options.encoding === "buffer";
      const result = new DirectChildExecutionResult({ call: this.call, outcome, receipt,
        stdout: bytes ? stdout.buffer.toBuffer() : stdout.buffer.toBuffer().toString(options.encoding ?? "utf8"),
        stderr: bytes ? stderr.buffer.toBuffer() : stderr.buffer.toBuffer().toString(options.encoding ?? "utf8") });
      let failure = this.controlFailure ?? outputFailure;
      if (failure === null && timedOut) failure = new AgentTimeoutError({ timeoutMs: options.timeoutMs,
        graceMs: receipt.stopOperation?.graceMs ?? options.graceMs ?? DEFAULT_REGISTERED_CHILD_GRACE_MS,
        finalAction: outcome.finalAction, stopEvidence: result.stopEvidence, timeoutDiagnostic: dynamicDiagnostic });
      else if (failure === null && aborted) {
        const reason = options.abortSignal?.reason;
        // Preserve the caller's error after the actual stop receipt is saved.
        // The default DOMException keeps the process API's ABORT_ERR wrapper.
        failure = reason instanceof Error && !(reason instanceof DOMException) ? reason
          : new Error(reason?.message ?? "The operation was aborted", { cause: reason });
        if (failure.code == null) failure.code = "ABORT_ERR";
      }
      else if (failure === null && outcome.error !== null) { failure = new Error(outcome.error.message); failure.code = outcome.error.code; }
      if (failure !== null) {
        Object.assign(failure, { stdout: result.stdout, stderr: result.stderr, providerStarted: result.providerStarted,
          signal: result.signal, killed: finalAction !== null,
          timing: result.timing, stopEvidence: result.stopEvidence, processExecutionStopReceipt: result.processExecutionStopReceipt });
        throw failure;
      }
      return result;
    } finally {
      clearTimeout(drainTimer);
      options.abortSignal?.removeEventListener("abort", abortedListener);
      options.activityMonitor?.stop();
      // Releasing caller wait handles is not termination proof. An unknown
      // child remains in the durable registry; keep its exit listener while
      // allowing the caller to report the finite control failure.
      for (const stream of this.child?.stdio ?? []) stream?.destroy?.();
      this.child?.unref();
      this.child?.channel?.unref();
    }
  }
}
