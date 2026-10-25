import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionRuntime, ProcessExecutionCall, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { DirectChildExecutor } from "./direct-child-executor.js";
import { ensureStandaloneExecutionGrant, releaseStandaloneExecutionGrant } from "./process-execution-sync.js";
import { assertManagedRecordIdentity, readManagedRecordSnapshot } from "./managed-process-record.js";
import { readManagedOutput } from "./managed-process-output.js";
import { ReadOnlyInvocationWorkspace } from "./readonly-invocation-workspace.js";
import { completeManagedOperation } from "./process-execution-completion.js";

/** Reuse authenticated execution authority, or own a standalone scope. */
export async function withManagedProcessScope({ executionRoot, standaloneRoot = executionRoot ?? process.cwd(), environment = process.env, readOnly = false }, callback) {
  const current = ProcessExecutionRuntime.current();
  if (current !== null) return callback(current);
  let runtime;
  let ownedRoot = null;
  const serialized = environment[PROCESS_EXECUTION_SCOPE_ENV];
  if (serialized !== undefined) {
    let grant;
    try { grant = JSON.parse(serialized); }
    catch (cause) { throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context is malformed", { cause }); }
    if (executionRoot !== undefined && path.resolve(executionRoot) !== grant.executionRoot) throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context belongs to another checkout");
    runtime = await ProcessExecutionRuntime.fromRemoteGrant(grant);
  } else {
    const root = path.resolve(standaloneRoot);
    if (readOnly) {
      return withReadOnlyManagedProcessScope({ mainRoot: root, executionRoot: executionRoot ?? root, environment }, callback);
    }
    ownedRoot = root;
    runtime = await ProcessExecutionRuntime.fromRemoteGrant(await ensureStandaloneExecutionGrant(root));
  }
  return completeManagedOperation(() => runtime.enter(() => callback(runtime)), async () => {
    await runtime.close();
    if (ownedRoot !== null) await releaseStandaloneExecutionGrant(ownedRoot);
  });
}

/** One shared lifecycle for standalone read-only command invocations. */
export async function withReadOnlyManagedProcessScope({ mainRoot, executionRoot = mainRoot, environment = process.env }, callback) {
  const workspace = ReadOnlyInvocationWorkspace.create();
  let runtime;
  const result = await completeManagedOperation(async () => {
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot, workspace, environment });
    return runtime.enter(() => callback(runtime, workspace));
  }, async () => {
    if (runtime !== undefined) await runtime.close();
  });

  workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
  workspace.cleanup({ generation: workspace.generation });
  return result;
}

/** One common registered invocation for providers, wrappers and internal commands. */
export async function executeManagedProcess(command, args, options = {}) {
  const runtime = options.runtime ?? ProcessExecutionRuntime.current();
  if (runtime !== null) return DirectChildExecutor.execute(command, args, { ...options, runtime });
  return withManagedProcessScope({ standaloneRoot: options.repositoryRoot ?? command.cwd ?? options.cwd ?? process.cwd(), environment: options.env ?? process.env, readOnly: options.readOnly === true },
    (scope) => DirectChildExecutor.execute(command, args, { ...options, runtime: scope }));
}

export function readManagedSettlement(call, { deadline } = {}) {
  const record = readManagedRecordSnapshot(call.outcomePath);
  if (record === null) return null;
  assertManagedRecordIdentity(record, call);
  if (record.schemaVersion !== 3 || record.scope !== "registered-executions") {
    throw new ProcessExecutionControlFailure("legacy-receipt-format", "Managed settlement requires schema 3 registered-execution evidence; historical process-group records remain unchanged", {
      executionId: call.executionId, callId: call.callId,
    });
  }
  if (!(call instanceof ProcessExecutionCall)) throw new ProcessExecutionControlFailure("binding-mismatch", "Current settlement requires its typed registered execution call");
  const inventory = call.runtime.inspect();
  const execution = inventory?.executions.find((entry) => entry.executionId === call.executionId && entry.ownerEpoch === call.ownerEpoch);
  const committed = execution?.calls.find((entry) => entry.callId === call.callId);
  if (record.receipt === null || record.receipt === undefined) return null;
  const receipt = new ProcessExecutionStopReceipt(record.receipt);
  if (receipt.callId !== call.callId || receipt.executionId !== call.executionId) throw new ProcessExecutionControlFailure("binding-mismatch", "Saved settlement belongs to another call");
  if (committed?.receipt == null) throw new ProcessExecutionControlFailure("stop-unconfirmed", "Physical result has no committed coordinator receipt", { executionId: call.executionId, callId: call.callId });
  if (!isDeepStrictEqual(committed.receipt, receipt.toJSON()) || !isDeepStrictEqual(committed.outcome, record.outcome)) {
    throw new ProcessExecutionControlFailure("receipt-mismatch", "Physical result differs from its committed coordinator receipt and outcome", { executionId: call.executionId, callId: call.callId });
  }
  return { outcome: record.outcome, ...readManagedOutput(call, record.outcome, { sealed: true, deadline }),
    stopEvidence: receipt.stopEvidence, processExecutionStopReceipt: receipt, record };
}

export function verifyManagedProcessStopped(record) {
  if (record.receipt == null) return false;
  new ProcessExecutionStopReceipt(record.receipt);
  return true;
}
