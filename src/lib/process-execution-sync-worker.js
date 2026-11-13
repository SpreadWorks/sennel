import { workerData, parentPort } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { CommandInvocation } from "./command-invocation.js";
import { managedRequest, ManagedRequestTransportCohort } from "./managed-process-protocol.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { completeManagedOperation } from "./process-execution-completion.js";

const port = workerData.port;
const scopes = new Map();
const readOnlyScopes = new Map();
let pending = Promise.resolve();

async function standaloneScope(root, ProcessExecutionRuntime, temporaryParent) {
  let lease = scopes.get(root);
  if (lease === undefined) {
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, binding: null, environment: {}, temporaryParent });
    lease = { runtime, references: 0 };
    scopes.set(root, lease);
  }
  lease.references++;
  return lease.runtime;
}

async function releaseScope(root) {
  const lease = scopes.get(root);
  if (lease === undefined || lease.references < 1) throw new TypeError("Standalone execution lease is unavailable");
  lease.references--;
  if (lease.references === 0) { await lease.runtime.close(); scopes.delete(root); }
}

async function executeCommandInvocation({ invocation, inheritedEnvironment, options }, runtime, executeManagedProcess) {
  return executeManagedProcess(CommandInvocation.fromStored(invocation), [], {
    ...options, inheritedEnvironment, runtime, timeoutMs: options.timeout ?? options.timeoutMs ?? 300000,
    stdinContent: options.input ?? options.stdinContent,
  });
}

function encodeCompletion(result) {
  return result?.processExecutionStopReceipt === undefined ? result : {
    ...result, processExecutionStopReceipt: result.processExecutionStopReceipt.toJSON(),
    stopEvidence: result.stopEvidence.toJSON(),
  };
}
function encodeFailure(error) {
  return error instanceof ProcessExecutionControlFailure
    ? { control: error.toJSON(), ...(error.processExecutionStopReceipt === undefined ? {} : { completion: {
      stdout: error.stdout, stderr: error.stderr, signal: error.signal, killed: error.killed,
      timing: error.timing, providerStarted: error.providerStarted,
      processExecutionStopReceipt: error.processExecutionStopReceipt.toJSON(),
    } }) }
    : { message: error.message, fields: { code: error.code, stdout: error.stdout, stderr: error.stderr,
      killed: error.killed, signal: error.signal, stopEvidence: error.stopEvidence?.toJSON(),
      processExecutionStopReceipt: error.processExecutionStopReceipt?.toJSON() } };
}
async function executeCommands({ commands, grant }, ProcessExecutionRuntime) {
  if (!Array.isArray(commands) || commands.length === 0) throw new TypeError("Command group requires its complete nonempty invocation list");
  if (grant === null) throw new ProcessExecutionControlFailure("delegation-refused", "Concurrent command group requires its shared scoped grant");
  const { executeManagedProcess } = await import("./managed-process.js");
  const runtime = await ProcessExecutionRuntime.fromRemoteGrant(grant, { requestTransport: new ManagedRequestTransportCohort() });
  // All invocations share already authenticated scoped authority. A rejected
  // sibling cannot acknowledge the bridge while other native work is pending.
  const settled = await runtime.enter(() => Promise.allSettled(commands.map((command) => executeCommandInvocation(command, runtime, executeManagedProcess))));
  return settled.map((entry) => entry.status === "fulfilled"
    ? { result: encodeCompletion(entry.value) } : { error: encodeFailure(entry.reason) });
}

async function execute({ operation, data }) {
  if (operation === "control") return managedRequest(data.grant, data.operation, { grant: data.grant, data: data.data });
  const { ProcessExecutionRuntime, ProcessExecutionGrant } = await import("./process-execution-runtime.js");
  if (operation === "scope") return (await standaloneScope(data.root, ProcessExecutionRuntime, data.temporaryParent)).remoteGrant();
  if (operation === "release-scope") return releaseScope(data.root);
  if (operation === "read-only-scope") {
    const { OwnedReadOnlyProcessScope } = await import("./managed-process.js");
    const scope = await OwnedReadOnlyProcessScope.acquire(data);
    readOnlyScopes.set(scope.runtime.executionId, scope);
    return scope.runtime.remoteGrant();
  }
  if (operation === "release-read-only-scope") {
    const grant = new ProcessExecutionGrant(data.grant).toJSON();
    const scope = readOnlyScopes.get(grant.executionId);
    if (scope === undefined || !isDeepStrictEqual(scope.runtime.remoteGrant(), grant)
      || typeof data.successful !== "boolean") {
      throw new ProcessExecutionControlFailure("delegation-refused", "Read-only scope lease does not match its owned generation");
    }
    await scope.close({ successful: data.successful });
    readOnlyScopes.delete(grant.executionId);
    return null;
  }
  if (operation === "close") {
    for (const lease of scopes.values()) await lease.runtime.close();
    scopes.clear();
    for (const scope of readOnlyScopes.values()) await scope.close({ successful: false });
    if (readOnlyScopes.size !== 0) {
      throw new ProcessExecutionControlFailure("bridge-unavailable", "Read-only scope release was not acknowledged; its diagnostics are retained");
    }
    return null;
  }
  if (operation === "execute-many") return executeCommands(data, ProcessExecutionRuntime);
  if (operation !== "execute") throw new TypeError("Unknown synchronous bridge operation");
  const { withReadOnlyManagedProcessScope, executeManagedProcess } = await import("./managed-process.js");
  const { invocation, options, grant, temporaryParent } = data;
  const executeInvocation = (runtime) => executeCommandInvocation(data, runtime, executeManagedProcess);
  if (grant === null && options.readOnly === true) {
    const root = options.repositoryRoot ?? invocation.cwd ?? process.cwd();
    return withReadOnlyManagedProcessScope({ mainRoot: root, temporaryParent }, executeInvocation);
  }
  let runtime;
  if (grant !== null) runtime = await ProcessExecutionRuntime.fromRemoteGrant(grant);
  else runtime = await standaloneScope(options.repositoryRoot ?? invocation.cwd ?? process.cwd(), ProcessExecutionRuntime, temporaryParent);
  return completeManagedOperation(() => runtime.enter(() => executeInvocation(runtime)), async () => {
    if (grant === null) await releaseScope(options.repositoryRoot ?? invocation.cwd ?? process.cwd());
  });
}

parentPort.on("message", (message) => {
  pending = pending.then(async () => {
    let response;
    try {
      const result = await execute(message);
      response = { requestId: message.requestId, result: encodeCompletion(result) };
    }
    catch (error) { response = { requestId: message.requestId, error: encodeFailure(error) }; }

    port.postMessage(response);
    const signal = new Int32Array(message.signal);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
});
