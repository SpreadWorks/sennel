import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionRuntime, ProcessExecutionCall, PROCESS_EXECUTION_SCOPE_ENV } from "./process-execution-runtime.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { DirectChildExecutor } from "./direct-child-executor.js";
import { ensureStandaloneExecutionGrant, releaseStandaloneExecutionGrant,
  acquireReadOnlyExecutionGrantSync, releaseReadOnlyExecutionGrantSync,
  acquireStandaloneExecutionGrantSync, releaseStandaloneExecutionGrantSync } from "./process-execution-sync.js";
import { assertManagedRecordIdentity, readManagedRecordSnapshot } from "./managed-process-record.js";
import { readManagedOutput } from "./managed-process-output.js";
import { InvocationControlWorkspace, ReadOnlyInvocationWorkspace } from "./readonly-invocation-workspace.js";
import { ProcessExecutionHistoryReference } from "./process-execution-history-reference.js";
import { completeManagedOperation, completeManagedOperationSync, retainExecutionCompletion } from "./process-execution-completion.js";

function inheritedExecutionGrant(executionRoot, environment) {
  const serialized = environment[PROCESS_EXECUTION_SCOPE_ENV];
  if (serialized === undefined) return undefined;
  let grant;
  try { grant = JSON.parse(serialized); }
  catch (cause) { throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context is malformed", { cause }); }
  if (executionRoot !== undefined && path.resolve(executionRoot) !== grant.executionRoot) {
    throw new ProcessExecutionControlFailure("delegation-refused", "Inherited execution context belongs to another checkout");
  }
  return grant;
}

/** One actual control workspace/runtime lifetime, including its joined coordinator. */
class OwnedInvocationProcessScope {
  static Workspace = InvocationControlWorkspace;
  #closure = null;
  constructor(runtime, workspace) {
    if (!(runtime instanceof ProcessExecutionRuntime) || !(workspace instanceof InvocationControlWorkspace)) {
      throw new TypeError("Control scope requires its actual runtime and minted workspace");
    }
    this.runtime = runtime;
    this.workspace = workspace;
  }
  static async acquire({ mainRoot, executionRoot = mainRoot, environment = process.env, temporaryParent }) {
    const workspace = this.Workspace.create({ temporaryParent, outsideRoots: [mainRoot, executionRoot] });
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot, workspace, environment, temporaryParent: path.dirname(workspace.path) });
    try { return new this(runtime, workspace); }
    catch (error) {
      return completeManagedOperation(() => { throw error; }, () => runtime.close());
    }
  }
  enter(callback) { return this.runtime.enter(() => callback(this.runtime, this.workspace)); }
  close({ successful }) {
    this.#closure ??= this.#closeOnce(successful);
    return this.#closure;
  }
  async #closeOnce(successful) {
    await this.runtime.close();
    this.completeWorkspace(successful);
  }
  completeWorkspace() { throw new TypeError("Control scope must own its retention policy"); }
}

/** Read-only application scratch is removable only after confirmed success. */
export class OwnedReadOnlyProcessScope extends OwnedInvocationProcessScope {
  static Workspace = ReadOnlyInvocationWorkspace;
  completeWorkspace(successful) {
    if (!successful) return;
    this.workspace.complete({ generation: this.workspace.generation, normalExit: true, resourcesReleased: true });
    this.workspace.cleanup({ generation: this.workspace.generation });
  }
}

/** Independent native writers retain their closed inventory outside the checkout. */
export class OwnedRetainedProcessScope extends OwnedInvocationProcessScope {
  constructor(runtime, workspace) {
    super(runtime, workspace);
    this.history = new ProcessExecutionHistoryReference({ storage: runtime.remoteGrant().storage,
      checkoutIdentity: runtime.checkoutIdentity.toJSON() });
  }
  completeWorkspace() {
    this.workspace.complete({ generation: this.workspace.generation, normalExit: true, resourcesReleased: true });
  }
}

/** Reuse authenticated execution authority, or own a standalone scope. */
export async function withManagedProcessScope({ executionRoot, standaloneRoot = executionRoot ?? process.cwd(), environment = process.env, readOnly = false, retainedControl = false }, callback) {
  const current = ProcessExecutionRuntime.current();
  if (current !== null) return callback(current);
  let runtime;
  let ownedRoot = null;
  const grant = inheritedExecutionGrant(executionRoot, environment);
  if (grant !== undefined) {
    runtime = await ProcessExecutionRuntime.fromRemoteGrant(grant);
  } else {
    const root = path.resolve(standaloneRoot);
    if (readOnly) {
      return withReadOnlyManagedProcessScope({ mainRoot: root, executionRoot: executionRoot ?? root, environment }, callback);
    }
    if (retainedControl) {
      return withRetainedManagedProcessScope({ mainRoot: root, executionRoot: executionRoot ?? root, environment }, callback);
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
export async function withReadOnlyManagedProcessScope({ mainRoot, executionRoot = mainRoot, environment = process.env, temporaryParent }, callback) {
  let scope;
  let successful = false;
  return completeManagedOperation(async () => {
    scope = await OwnedReadOnlyProcessScope.acquire({ mainRoot, executionRoot, environment, temporaryParent });
    const result = await scope.enter(callback);
    successful = true;
    return result;
  }, async () => {
    if (scope !== undefined) await scope.close({ successful });
  });
}

/** Retain locator provenance even when native work, publication or closure fails. */
async function withRetainedManagedProcessScope(options, callback) {
  let scope;
  let result;
  try {
    return await completeManagedOperation(async () => {
      scope = await OwnedRetainedProcessScope.acquire(options);
      result = await scope.enter(callback);
      result.processExecutionHistory = scope.history;
      return result;
    }, async () => {
      if (scope !== undefined) await scope.close({ successful: false });
    });
  } catch (error) {
    retainExecutionCompletion(error, result);
    if (scope !== undefined) error.processExecutionHistory = scope.history;
    throw error;
  }
}

/** One owned synchronous operation, using the same grant and completion APIs. */
export function withManagedProcessScopeSync({ executionRoot, standaloneRoot = executionRoot ?? process.cwd(),
  environment = process.env, readOnly = false }, callback) {
  return withSynchronousProcessScope({ mainRoot: standaloneRoot, executionRoot, environment, readOnly }, callback);
}

/** Group a known synchronous read-only unit without blocking its owner's loop. */
export function withReadOnlyManagedProcessScopeSync({ mainRoot, executionRoot, environment = process.env }, callback) {
  return withSynchronousProcessScope({ mainRoot, executionRoot, environment, readOnly: true }, callback);
}

function withSynchronousProcessScope({ mainRoot, executionRoot, environment, readOnly }, callback) {
  const current = ProcessExecutionRuntime.current();
  if (current !== null) return completeManagedOperationSync(() => current.enter(() => callback(current)), () => {});
  const inherited = inheritedExecutionGrant(executionRoot, environment);
  const root = inherited === undefined ? path.resolve(mainRoot) : null;
  let grant;
  let runtime;
  return completeManagedOperationSync(() => {
    if (inherited !== undefined) grant = inherited;
    else if (readOnly) grant = acquireReadOnlyExecutionGrantSync({ mainRoot: root,
      executionRoot: path.resolve(executionRoot ?? root), environment });
    else grant = acquireStandaloneExecutionGrantSync(root);
    runtime = ProcessExecutionRuntime.fromRemoteGrantSync(grant);
    return runtime.enter(() => callback(runtime));
  }, (successful) => completeManagedOperationSync(() => runtime?.closeClientViewSync(), (disposed) => {
    if (inherited === undefined && grant !== undefined) {
      if (readOnly) releaseReadOnlyExecutionGrantSync(grant, { successful: successful && disposed });
      else releaseStandaloneExecutionGrantSync(root);
    }
  }));
}

/** One common registered invocation for providers, wrappers and internal commands. */
export async function executeManagedProcess(command, args, options = {}) {
  const runtime = options.runtime ?? ProcessExecutionRuntime.current();
  if (runtime !== null) return DirectChildExecutor.execute(command, args, { ...options, runtime });
  return withManagedProcessScope({ standaloneRoot: options.repositoryRoot ?? command.cwd ?? options.cwd ?? process.cwd(), environment: options.env ?? process.env, readOnly: options.readOnly === true, retainedControl: options.retainedControl === true },
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
