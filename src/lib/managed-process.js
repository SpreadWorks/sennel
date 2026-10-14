import path from "node:path";
import { readManagedOutput } from "./managed-process-output.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeChildExecution } from "./runtime-package.js";
import { TemporaryPaths } from "./temporary-paths.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessIdentity } from "./process-identity.js";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { AgentTimeoutError } from "./process-supervisor.js";
import { DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";
import { managedControlFailure, managedRequest, readManagedRecord, assertManagedLauncherIdentity, verifyManagedProcessStopped } from "./managed-process-protocol.js";

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
  try { await report(); }
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

export function readManagedSettlement(call) {
  const record = assertRecord(readManagedRecord(call.outcomePath) || readManagedRecord(call.helloPath), call);
  if (record.state === "control-failed" && record.controlFailure) throw managedControlFailure(record.controlFailure.code, record.controlFailure.message);
  if (!verifyManagedProcessStopped(record)) return null;
  if (record.state !== "finished" && !(record.state === "stopping" && record.outcome?.finalAction === "SIGKILL")) {
    throw managedControlFailure("PROCESS_EXECUTION_OUTCOME_UNSEALED", "Managed process ended without a durable final outcome");
  }
  if (record.controlFailure) throw managedControlFailure(record.controlFailure.code, record.controlFailure.message);
  return { outcome: record.outcome, ...readManagedOutput(call, record.outcome, { sealed: true }), members: record.members,
    stopEvidence: AgentProcessStopEvidence.confirmed(), record };
}

async function waitForStop(call, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const settlement = readManagedSettlement(call);
    if (settlement !== null) return settlement;
    await delay(20);
  } while (Date.now() < deadline);
  throw managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Managed group termination could not be proved within the stop deadline");
}

/** Reconnect only to an authenticated live anchor; never signal a saved PID. */
export async function requestManagedLauncherStop(call, { graceMs = DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } = {}) {
  const record = assertRecord(readManagedRecord(call.outcomePath) || readManagedRecord(call.helloPath), call);
  if (!verifyManagedProcessStopped(record)) {
    assertManagedLauncherIdentity(record);
    await managedRequest(call, "stop", { reason: "recovery" });
  }
  return waitForStop(call, graceMs * 2 + 2000);
}

/** One physical invocation, from durable reservation through durable stop receipt. */
export async function executeManagedProcess(command, args, options = {}) {
  const runtime = options.runtime || ProcessExecutionRuntime.current();
  if (!runtime) throw managedControlFailure("PROCESS_EXECUTION_SCOPE_REQUIRED", "A managed process requires an execution scope");
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw managedControlFailure("PROCESS_EXECUTION_INVALID_DEADLINE", "Managed process deadline must be positive and finite");
  const graceMs = options.graceMs || DEFAULT_AGENT_PROCESS_TREE_GRACE_MS;
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
  const abort = () => { abortRequested = true; };
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  let hello;
  let receiptSaved = false;
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
    if (abortRequested) await managedRequest(call, "stop", { reason: "abort" });
    else await managedRequest(call, "start", { permit, environment: call.executionEnvironment() });
    let stopped = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let providerSpawnObserved = false;
    const observe = (record) => {
      if (record.state === "control-failed" && record.controlFailure) throw managedControlFailure(record.controlFailure.code, record.controlFailure.message);
      if (record.outcome.providerStarted && !providerSpawnObserved) {
        providerSpawnObserved = true;
        notify("provider-spawn");
      }
      const output = readManagedOutput(call, record.outcome);
      for (const stream of ["stdout", "stderr"]) {
        const bytes = output[stream];
        const offset = stream === "stdout" ? stdoutBytes : stderrBytes;
        if (bytes.length > offset) {
          options.activityMonitor?.observeOutput();
          options[stream === "stdout" ? "onStdout" : "onStderr"]?.(bytes.subarray(offset).toString());
        }
        if (stream === "stdout") stdoutBytes = bytes.length; else stderrBytes = bytes.length;
      }
    };
    let dynamicTimeout = false;
    let dynamicTimeoutDiagnostic = null;
    options.activityMonitor?.start((diagnostic) => { dynamicTimeout = true; dynamicTimeoutDiagnostic = diagnostic; });
    const waitDeadline = deadline + graceMs * 2 + 3000;
    while (launcher.exitCode === null && launcher.signalCode === null) {
      if ((abortRequested || dynamicTimeout) && !stopped) {
        await managedRequest(call, "stop", { reason: abortRequested ? "abort" : "timeout" });
        stopped = true;
      }
      try { observe(await managedRequest(call, "status")); }
      catch (error) {
        const saved = readManagedRecord(call.outcomePath);
        if (saved?.state !== "finished" && saved?.state !== "stopping"
          && launcher.exitCode === null && launcher.signalCode === null) throw error;
      }
      if (Date.now() >= waitDeadline) throw managedControlFailure("PROCESS_EXECUTION_STOP_UNPROVEN", "Managed launcher exceeded its finite stop deadline");
      await delay(20);
    }
    const settlement = await waitForStop(call, graceMs + 1000);
    observe(settlement.record);
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
    if (error instanceof ProcessExecutionControlFailure || receiptSaved) return refuse(error);
    return refuse(managedControlFailure("PROCESS_EXECUTION_CONTROL_FAILED", "Managed process control failed before durable settlement", error));
  } finally {
    launcher.stdin.destroy();
    options.abortSignal?.removeEventListener("abort", abort);
    options.activityMonitor?.stop();
  }
}
