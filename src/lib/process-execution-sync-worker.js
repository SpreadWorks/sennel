import { workerData, parentPort } from "node:worker_threads";
import { CommandInvocation } from "./command-invocation.js";
import { managedRequest } from "./managed-process-protocol.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { completeManagedOperation } from "./process-execution-completion.js";

const port = workerData.port;
const scopes = new Map();
let pending = Promise.resolve();

async function standaloneScope(root, ProcessExecutionRuntime) {
  let lease = scopes.get(root);
  if (lease === undefined) {
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, binding: null, environment: {} });
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

async function execute({ operation, data }) {
  if (operation === "control") return managedRequest(data.grant, data.operation, { grant: data.grant, data: data.data });
  const { ProcessExecutionRuntime } = await import("./process-execution-runtime.js");
  if (operation === "scope") return (await standaloneScope(data.root, ProcessExecutionRuntime)).remoteGrant();
  if (operation === "release-scope") return releaseScope(data.root);
  if (operation === "close") {
    for (const lease of scopes.values()) await lease.runtime.close();
    scopes.clear();
    return null;
  }
  if (operation !== "execute") throw new TypeError("Unknown synchronous bridge operation");
  const { executeManagedProcess, withReadOnlyManagedProcessScope } = await import("./managed-process.js");
  const { invocation, inheritedEnvironment, options, grant } = data;
  const executeInvocation = (runtime) => executeManagedProcess(CommandInvocation.fromStored(invocation), [], {
    ...options, inheritedEnvironment, runtime, timeoutMs: options.timeout ?? options.timeoutMs ?? 300000,
    stdinContent: options.input ?? options.stdinContent,
  });
  if (grant === null && options.readOnly === true) {
    const root = options.repositoryRoot ?? invocation.cwd ?? process.cwd();
    return withReadOnlyManagedProcessScope({ mainRoot: root }, executeInvocation);
  }
  let runtime;
  if (grant !== null) runtime = await ProcessExecutionRuntime.fromRemoteGrant(grant);
  else runtime = await standaloneScope(options.repositoryRoot ?? invocation.cwd ?? process.cwd(), ProcessExecutionRuntime);
  return completeManagedOperation(() => runtime.enter(() => executeInvocation(runtime)), async () => {
    if (grant === null) await releaseScope(options.repositoryRoot ?? invocation.cwd ?? process.cwd());
  });
}

parentPort.on("message", (message) => {
  pending = pending.then(async () => {
    let response;
    try {
      const result = await execute(message);
      response = { requestId: message.requestId, result: result?.processExecutionStopReceipt === undefined ? result : {
        ...result, processExecutionStopReceipt: result.processExecutionStopReceipt.toJSON(),
        stopEvidence: result.stopEvidence.toJSON(),
      } };
    }
    catch (error) {
      response = { requestId: message.requestId, error: error instanceof ProcessExecutionControlFailure
        ? { control: error.toJSON(), ...(error.processExecutionStopReceipt === undefined ? {} : { completion: {
          stdout: error.stdout, stderr: error.stderr, signal: error.signal, killed: error.killed,
          timing: error.timing, providerStarted: error.providerStarted,
          processExecutionStopReceipt: error.processExecutionStopReceipt.toJSON(),
        } }) }
        : { message: error.message, fields: { code: error.code, stdout: error.stdout, stderr: error.stderr,
          killed: error.killed, signal: error.signal, stopEvidence: error.stopEvidence?.toJSON(),
          processExecutionStopReceipt: error.processExecutionStopReceipt?.toJSON() } } };
    }
    port.postMessage(response);
    const signal = new Int32Array(message.signal);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
});
