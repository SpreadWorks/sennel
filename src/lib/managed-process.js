import path from "node:path";
import { readManagedOutput } from "./managed-process-output.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeChildExecution } from "./runtime-package.js";
import { TemporaryPaths } from "./temporary-paths.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessIdentity } from "./process-identity.js";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { AgentTimeoutError } from "./process-supervisor.js";
import { DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";
import { ManagedStopOperation, managedMonotonicNow } from "./managed-stop-operation.js";
import { ManagedStopOperationStore } from "./managed-stop-store.js";
import { ManagedProcessSnapshot, managedControlFailure, managedRequest, readManagedRecord, assertManagedLauncherIdentity, verifyManagedProcessStopped } from "./managed-process-protocol.js";

export { verifyManagedProcessStopped } from "./managed-process-protocol.js";

/** Delegation is authenticated by the registry and actual caller group, never by environment alone. */
export async function withManagedProcessScope({ executionRoot, environment = process.env }, callback) {
  const current = ProcessExecutionRuntime.current();
  if (current) return invokeManagedScope(current, callback, environment);
  const serialized = environment[PROCESS_EXECUTION_SCOPE_ENV];
  if (serialized === undefined) return callback(null);
  let grant;
  const actualRoot = path.resolve(executionRoot);
  try {
    try { grant = JSON.parse(serialized); }
    catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_DELEGATION_REFUSED", "Managed process delegation is invalid", cause); }
    if (grant === null || typeof grant !== "object" || grant.executionRoot !== actualRoot
      || typeof grant.mainRoot !== "string" || path.resolve(grant.mainRoot) !== grant.mainRoot) {
      throw managedControlFailure("PROCESS_EXECUTION_DELEGATION_REFUSED", "Managed process delegation does not match the caller checkout");
    }
  } catch (error) {
    await ProcessExecutionRuntime.reportDelegatedControlFailure({ environment, error });
    throw error;
  }
  const borrowed = await ProcessExecutionRuntime.acquire({ mainRoot: grant.mainRoot, executionRoot: actualRoot,
    runId: grant.runId, specId: grant.specId, environment });
  try { return await borrowed.enter(() => invokeManagedScope(borrowed, callback, environment)); }
  finally { await borrowed.close(); }
}

async function invokeManagedScope(runtime, callback, environment) {
  try { return await callback(runtime); }
  catch (error) {
    if (runtime.borrowed && error instanceof ProcessExecutionControlFailure) {
      return rejectManagedControlFailure(error, () => ProcessExecutionRuntime.reportDelegatedControlFailure({ environment, error }));
    }
    throw error;
  }
}

async function rejectManagedControlFailure(error, report) {
  try {
    const saved = await report();
    if (saved instanceof ProcessExecutionControlFailure) error = saved;
  }
  catch (cause) {
    if (!(cause instanceof ProcessExecutionControlFailure)) throw cause;
    error.cause = new AggregateError(error.cause === undefined ? [cause] : [error.cause, cause],
      "Recording the process control failure also failed");
  }
  throw error;
}

function assertRecord(record, call) {
  if (!record || record.executionId !== call.executionId || record.callId !== call.callId
    || record.capability !== call.capability || record.ownerToken !== call.ownerToken) {
    throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed record belongs to another physical call");
  }
  return record;
}

function assertNoControlFailure(record, call) {
  if (record.state === "control-failed" || record.controlFailure != null) {
    throw ProcessExecutionControlFailure.fromStored(record.controlFailure,
      { executionId: call.executionId, callId: call.callId });
  }
}

function readManagedRequestAcceptance(call, request, deadline) {
  const record = readManagedRecord(call.outcomePath, { deadline });
  if (record === null) return "unknown";
  assertRecord(record, call);
  const accepted = record[request.operation === "start" ? "startRequest" : request.operation === "stop" ? "stopRequest" : "statusRequest"];
  return accepted?.requestId === request.requestId && accepted?.payloadDigest === request.payloadDigest ? "accepted" : "unknown";
}

export function readManagedSettlement(call, { stopDeadlineMessage = null, deadline } = {}) {
  const record = assertRecord(readManagedRecord(call.outcomePath, { deadline }) || readManagedRecord(call.helloPath, { deadline }), call);
  assertNoControlFailure(record, call);
  const snapshot = new ManagedProcessSnapshot(record);
  if (stopDeadlineMessage !== null) {
    const failure = snapshot.stopFailure(stopDeadlineMessage);
    if (failure !== null) throw failure;
  } else if (!snapshot.isStopped()) return null;
  if (record.state !== "finished" && !(record.state === "stopping" && record.outcome?.finalAction === "SIGKILL")) {
    throw managedControlFailure("PROCESS_EXECUTION_OUTCOME_UNSEALED", "Managed process ended without a durable final outcome");
  }
  return { outcome: record.outcome, ...readManagedOutput(call, record.outcome, { sealed: true, deadline }), members: record.members,
    stopEvidence: AgentProcessStopEvidence.confirmed(), record };
}

async function waitForStop(call, operation, onWait = () => {}) {
  for (;;) {
    const settlement = readManagedSettlement(call, { deadline: operation.deadline, stopDeadlineMessage: operation.remainingMs() <= 0
      ? "Managed group termination could not be proved within the stop deadline" : null });
    if (settlement !== null) return settlement;
    onWait(operation.deadline);
    await delay(Math.min(20, operation.remainingMs()));
  }
}

/** Reconnect only to an authenticated live anchor; never signal a saved PID. */
export async function requestManagedLauncherStop(call, { graceMs = DEFAULT_AGENT_PROCESS_TREE_GRACE_MS, operation = null, onWait = () => {} } = {}) {
  operation ??= call.stopOperation ?? ManagedStopOperation.begin({ graceMs });
  operation = operation instanceof ManagedStopOperation ? operation : ManagedStopOperation.fromStored(operation);
  const stopStore = new ManagedStopOperationStore(call);
  operation = stopStore.read({ deadline: operation.deadline }) ?? operation;
  const record = assertRecord(readManagedRecord(call.outcomePath, { deadline: operation.deadline }) || readManagedRecord(call.helloPath, { deadline: operation.deadline }), call);
  operation = stopStore.claim(operation);
  if (!verifyManagedProcessStopped(record)) {
    assertManagedLauncherIdentity(record);
    await managedRequest(call, "stop", operation.toPayload(), { deadline: operation.deadline, requestId: operation.requestId,
      readSettlement: (deadline) => readManagedSettlement(call, { deadline })?.record ?? null, onWait,
      readAcceptance: (request, deadline) => readManagedRequestAcceptance(call, request, deadline) });
  }
  return waitForStop(call, operation, onWait);
}

/** One physical invocation, from durable reservation through durable stop receipt. */
export async function executeManagedProcess(command, args, options = {}) {
  const runtime = options.runtime || ProcessExecutionRuntime.current();
  if (!runtime) throw managedControlFailure("PROCESS_EXECUTION_SCOPE_REQUIRED", "A managed process requires an execution scope");
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw managedControlFailure("PROCESS_EXECUTION_INVALID_DEADLINE", "Managed process deadline must be positive and finite");
  const graceMs = options.graceMs || DEFAULT_AGENT_PROCESS_TREE_GRACE_MS;
  const executionDeadline = managedMonotonicNow() + timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const call = await runtime.reserveCall({ binding: options.processExecutionBinding ?? runtime.binding, kind: options.kind || "provider", commandId: options.commandId ?? null,
    providerAttemptId: options.providerAttemptId ?? null,
    logicalInvocationId: options.logicalInvocationId ?? null,
    providerAttemptContext: options.providerAttemptContext ?? null,
    promptProcessIdentity: options.promptProcessIdentity ?? null,
    timeoutMs, deadline });
  const notify = (type, pid = null) => options.onSupervisorEvent?.({ type, pid, callId: call.callId, executionId: call.executionId });
  const refuse = async (error) => {
    if (error instanceof ProcessExecutionControlFailure) {
      return rejectManagedControlFailure(error, () => runtime.recordCallControlFailure(call, error));
    }
    throw error;
  };
  notify("intent");
  let delivery;
  try {
    const paths = new TemporaryPaths(runtime.mainRoot);
    const temporaryRoot = runtime.specId !== null && runtime.runId !== null
      ? paths.flow(runtime.specId, runtime.runId) : paths.runtime("runtime-delivery");
    delivery = new RuntimeChildExecution({ root: runtime.mainRoot, temporaryRoot });
  }
  catch (cause) { return refuse(managedControlFailure("PROCESS_EXECUTION_RUNTIME_UNPROVEN", "Managed launcher requires the fixed parent runtime", cause)); }
  const extra = options.stdio?.slice(3) || [];
  const config = {
    call: { executionId: call.executionId, callId: call.callId, ownerToken: call.ownerToken, capability: call.capability,
      ownerEpoch: call.ownerEpoch, bindingDigest: call.binding.digest,
      endpoint: call.endpoint, helloPath: call.helloPath, outcomePath: call.outcomePath },
    command, args, cwd: options.cwd, env: options.env || process.env,
    deadline, graceMs, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    input: options.stdinContent == null ? null : Buffer.from(options.stdinContent).toString("base64"),
    extraDescriptors: extra.map((value, index) => typeof value === "number" ? index + 4 : value),
  };
  let launcher;
  let spawnError = null;
  try {
    const launchOptions = delivery.options({ detached: true });
    launcher = spawn(process.execPath, [fileURLToPath(new URL("./managed-process-launcher.js", import.meta.url))], {
      ...launchOptions, stdio: ["pipe", "ignore", "ignore", launchOptions.stdio[3], ...extra],
    });
    // The manager awaits explicit timers, proof and receipt persistence. A
    // refused control operation must not keep its CLI alive through this handle.
    launcher.unref();
    notify("launcher-created", launcher.pid);
    launcher.on("error", (error) => { spawnError = error; });
    launcher.stdin.on("error", (error) => { spawnError = error; });
    launcher.stdin.end(JSON.stringify(config));
  } catch (cause) {
    launcher?.stdin?.destroy();
    return refuse(managedControlFailure("PROCESS_EXECUTION_LAUNCHER_UNAVAILABLE", "Managed launcher could not be created", cause));
  } finally { delivery.close(); }
  let abortRequested = options.abortSignal?.aborted === true;
  const executionAbort = new AbortController();
  const abort = () => { abortRequested = true; executionAbort.abort(); };
  if (abortRequested) executionAbort.abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  let hello;
  let receiptSaved = false;
  let settlement;
  let observe = () => {};
  let dynamicTimeout = false;
  let dynamicTimeoutDiagnostic = null;
  const observeSaved = (deadline = executionDeadline) => {
    const record = readManagedRecord(call.outcomePath, { deadline });
    if (record !== null) observe(record, deadline);
  };
  const stop = async (reason, controlFailure = null) => {
    const operation = await runtime.beginCallStop(call, { reason, graceMs, controlFailure });
    settlement = await requestManagedLauncherStop(call, { operation, onWait: (deadline = operation.deadline) => observeSaved(deadline) });
    return settlement;
  };
  try {
    const readyDeadline = deadline;
    while (!hello) {
      if (spawnError) throw managedControlFailure("PROCESS_EXECUTION_LAUNCHER_UNAVAILABLE", "Managed launcher failed to start", spawnError);
      hello = readManagedRecord(call.helloPath);
      if (hello) break;
      if (Date.now() >= readyDeadline || launcher.exitCode !== null || launcher.signalCode !== null) {
        throw managedControlFailure("PROCESS_EXECUTION_LAUNCHER_UNAVAILABLE", "Managed launcher did not publish its birth identity");
      }
      await delay(10);
    }
    assertRecord(hello, call);
    assertManagedLauncherIdentity(hello);
    if (hello.launcherIdentity.pid !== launcher.pid) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Unexpected launcher birth identity");
    notify("launcher-hello", launcher.pid);
    const permit = await call.authorizeStart({ launcherIdentity: new ProcessIdentity(hello.launcherIdentity), endpoint: hello.endpoint,
      pgid: hello.pgid, members: hello.members, deadline });
    options.onSupervisorEvent?.({ type: "spawn", pid: launcher.pid, detached: true });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let providerSpawnObserved = false;
    observe = (record, deadline = executionDeadline, output = null) => {
      assertRecord(record, call);
      assertNoControlFailure(record, call);
      if (record.outcome.providerStarted && !providerSpawnObserved) {
        providerSpawnObserved = true;
        notify("provider-spawn");
      }
      output ??= readManagedOutput(call, record.outcome, { deadline });
      for (const stream of ["stdout", "stderr"]) {
        const bytes = output[stream];
        const offset = stream === "stdout" ? stdoutBytes : stderrBytes;
        if (bytes.length > offset) {
          options.activityMonitor?.observeOutput();
          options[stream === "stdout" ? "onStdout" : "onStderr"]?.(bytes.subarray(offset).toString());
          // A delayed reply may precede output already observed during its wait.
          if (stream === "stdout") stdoutBytes = bytes.length; else stderrBytes = bytes.length;
        }
      }
    };
    options.activityMonitor?.start((diagnostic) => {
      dynamicTimeout = true; dynamicTimeoutDiagnostic = diagnostic; executionAbort.abort();
    });
    const communicate = async (operation, payload = {}) => {
      try {
        return await managedRequest(call, operation, payload, { deadline: executionDeadline, abortSignal: executionAbort.signal,
          onWait: observeSaved,
          readSettlement: (deadline) => {
            settlement = readManagedSettlement(call, { deadline });
            return settlement?.record ?? null;
          },
          readAcceptance: (request, deadline) => readManagedRequestAcceptance(call, request, deadline) });
      } catch (error) {
        if (error instanceof ProcessExecutionControlFailure
          && ["operation-deadline", "aborted"].includes(error.communication?.cutoff)) {
          await stop(abortRequested ? "abort" : "timeout");
          return settlement.record;
        }
        throw error;
      }
    };
    if (abortRequested || managedMonotonicNow() >= executionDeadline) await stop(abortRequested ? "abort" : "timeout");
    else observe(await communicate("start", { permit, environment: call.executionEnvironment() }), executionDeadline, settlement);
    while (settlement === undefined || settlement === null) {
      settlement = readManagedSettlement(call, { deadline: executionDeadline });
      if (settlement !== null) break;
      if (abortRequested || dynamicTimeout || managedMonotonicNow() >= executionDeadline) {
        await stop(abortRequested ? "abort" : "timeout");
        break;
      }
      observe(await communicate("status"), executionDeadline, settlement);
      if (settlement == null) await delay(Math.min(20, Math.max(0, executionDeadline - managedMonotonicNow())));
    }
    observe(settlement.record, executionDeadline, settlement);
    notify("provider-settled", launcher.pid);
    const processExecutionStopReceipt = await runtime.finishCall(call, settlement);
    receiptSaved = true;
    try { await options.onProcessExecutionStop?.(processExecutionStopReceipt); }
    catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED", "Managed stop receipt could not be delivered", cause); }
    const outcome = settlement.outcome;
    const stdout = settlement.stdout.toString();
    const stderr = settlement.stderr.toString();
    if (outcome.timedOut) {
      const error = new AgentTimeoutError({ timeoutMs, graceMs, finalAction: outcome.finalAction,
        stopEvidence: settlement.stopEvidence, timeoutDiagnostic: dynamicTimeoutDiagnostic || options.timeoutDiagnostic || null });
      error.stdout = stdout; error.stderr = stderr; error.processExecutionStopReceipt = processExecutionStopReceipt;
      throw error;
    }
    if (outcome.aborted || abortRequested) {
      const error = options.abortSignal?.reason instanceof Error ? options.abortSignal.reason : new Error("The operation was aborted");
      error.stopEvidence = settlement.stopEvidence;
      error.stdout = stdout; error.stderr = stderr; error.processExecutionStopReceipt = processExecutionStopReceipt;
      throw error;
    }
    if (outcome.error) {
      const error = new Error(outcome.error.message); error.code = outcome.error.code;
      error.stdout = stdout; error.stderr = stderr; error.processExecutionStopReceipt = processExecutionStopReceipt; error.providerStarted = outcome.providerStarted;
      throw error;
    }
    return { providerStarted: outcome.providerStarted, code: outcome.code, signal: outcome.signal, stdout, stderr,
      processExecutionStopReceipt, stdinError: outcome.stdinError, processTreeQuiescence: "confirmed", stopEvidence: settlement.stopEvidence };
  } catch (error) {
    // Admission and durability failures retain their class. They cannot become
    // a provider retry or an ordinary exit status.
    if (error instanceof ProcessExecutionControlFailure && error.communication !== null && error.communication !== undefined && !receiptSaved) {
      // The original communication evidence remains the failure even if the
      // subsequent finite stop cannot establish proof.
      try {
        await stop("control-failure", error);
        try { await runtime.finishCall(call, settlement); }
        catch (cause) {
          const confirmed = error.withContext(call).withStopConfirmation("confirmed");
          if (cause instanceof ProcessExecutionControlFailure && isDeepStrictEqual(cause.toJSON(), confirmed.toJSON())) {
            // finishCall saves its receipt before refusing the original failure.
            error = cause;
            receiptSaved = true;
          } else throw cause;
        }
        receiptSaved = true;
        error = error.withStopConfirmation("confirmed");
      } catch (cause) {
        error.cause = new AggregateError([error.cause, cause].filter(Boolean), "Managed communication failure and subsequent stop");
      }
    }
    if (error instanceof ProcessExecutionControlFailure || receiptSaved) return refuse(error);
    return refuse(managedControlFailure("PROCESS_EXECUTION_CONTROL_FAILED", "Managed process control failed before durable settlement", error));
  } finally {
    launcher.stdin.destroy();
    options.abortSignal?.removeEventListener("abort", abort);
    options.activityMonitor?.stop();
  }
}
