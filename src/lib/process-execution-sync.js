import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { RuntimeChildExecution } from "./runtime-package.js";
import { immutableCommandEnvironment } from "./command-invocation.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { ReadOnlyInvocationWorkspace, ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { ProcessExecutionHistoryReference } from "./process-execution-history-reference.js";
import { completeManagedOperationSync, retainExecutionCompletion } from "./process-execution-completion.js";

let bridge = null;
let nextRequest = 0;

class SynchronousExecutionBridge {
  constructor(root, storage = null) {
    // This workspace owns only bootstrap payload delivery, never the worker's
    // managed runtime or its native lifetime. No storage grant is sent to workerData.
    this.deliveryWorkspace = storage === null ? ReadOnlyInvocationWorkspace.create({ outsideRoots: [root] }) : null;
    const storagePolicy = this.deliveryWorkspace === null
      ? ReadOnlyProcessRuntimeStorage.fromGrant(storage) : this.deliveryWorkspace.processRuntimeStorage();
    this.delivery = new RuntimeChildExecution({ root, storagePolicy });
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.worker = new Worker(fileURLToPath(new URL("./process-execution-sync-worker.js", import.meta.url)), {
      ...this.delivery.workerOptions(), workerData: { port: channel.port2 }, transferList: [channel.port2],
    });
    this.worker.unref(); this.port.unref();
    this.pending = new Map();
    this.port.on("message", (message) => {
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (this.pending.size === 0) { this.worker.unref(); this.port.unref(); }
      try { this.consumeDeliveryAcknowledgement(); pending.resolve(this.result(message)); } catch (error) { pending.reject(error); }
    });
    this.failure = null;
    this.worker.on("error", (cause) => { this.fail(cause); });
    this.worker.on("exit", (code) => {
      if (!this.closed) this.fail(new Error("Execution bridge ended without completing its calls; exit=" + code));
    });
    this.port.unref();
    this.closed = false;
  }
  consumeDeliveryAcknowledgement() {
    if (!this.delivery.consumeAcknowledgement()) return false;
    // Existing RuntimeChildExecution ACK means the immutable bytes and loader
    // were captured and its owned payload directory has already been closed.
    // The workspace has no beginExecution token, coordinator or worker handle.
    // normalExit/resourcesReleased confirm only this completed TRANSFER unit;
    // they never claim the native worker exited. Borrowed storage is never ours.
    if (this.deliveryWorkspace !== null) {
      this.deliveryWorkspace.complete({ generation: this.deliveryWorkspace.generation,
        normalExit: true, resourcesReleased: true });
      this.deliveryWorkspace.cleanup({ generation: this.deliveryWorkspace.generation });
      this.deliveryWorkspace = null;
    }
    return true;
  }
  fail(cause) {
    this.failure ??= cause;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ProcessExecutionControlFailure("bridge-unavailable", "Execution bridge ended with an unverified operation", { cause }));
    }
    this.pending.clear(); this.worker.unref(); this.port.unref();
  }
  request(operation, data, timeoutMs) {
    if (this.closed || this.failure !== null) throw new ProcessExecutionControlFailure("bridge-unavailable", "Synchronous execution bridge is unavailable", { cause: this.failure });
    const requestId = ++nextRequest;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.worker.postMessage({ requestId, signal: signal.buffer, operation, data });
    const wait = Atomics.wait(signal, 0, 0, timeoutMs);
    if (wait === "timed-out") {
      // A missing bridge result says nothing about the actual command's exit.
      throw new ProcessExecutionControlFailure("bridge-timeout", "Execution bridge did not return a verified result within its communication budget");
    }
    this.consumeDeliveryAcknowledgement();
    let message;
    for (;;) {
      const received = receiveMessageOnPort(this.port)?.message;
      if (received === undefined) break;
      if (received.requestId === requestId) { message = received; break; }
      const pending = this.pending.get(received.requestId);
      if (pending !== undefined) {
        this.pending.delete(received.requestId); clearTimeout(pending.timer);
        try { pending.resolve(this.result(received)); } catch (error) { pending.reject(error); }
      }
    }
    if (message === undefined) throw new ProcessExecutionControlFailure("bridge-response-invalid", "Synchronous execution bridge response identity differs");
    if (this.pending.size === 0) { this.worker.unref(); this.port.unref(); }
    return this.result(message);
  }
  result(message) {
    if (message.error !== undefined) {
      let error;
      if (message.error.control !== undefined) {
        error = ProcessExecutionControlFailure.fromStored(message.error.control);
        if (message.error.completion !== undefined) {
          const completion = message.error.completion;
          const receipt = new ProcessExecutionStopReceipt(completion.processExecutionStopReceipt);
          Object.assign(error, completion, { processExecutionStopReceipt: receipt, stopEvidence: receipt.stopEvidence });
        }
      } else {
        error = new Error(message.error.message);
        Object.assign(error, message.error.fields);
      }
      if (message.error.history !== undefined) error.processExecutionHistory = ProcessExecutionHistoryReference.fromStored(message.error.history);
      throw error;
    }
    if (message.result?.processExecutionHistory !== undefined) {
      return { ...message.result, processExecutionHistory: ProcessExecutionHistoryReference.fromStored(message.result.processExecutionHistory) };
    }
    return message.result;
  }
  requestAsync(operation, data, timeoutMs) {
    if (this.closed || this.failure !== null) return Promise.reject(new ProcessExecutionControlFailure("bridge-unavailable", "Execution bridge is unavailable", { cause: this.failure }));
    const requestId = ++nextRequest;
    const signal = new SharedArrayBuffer(4);
    this.worker.ref(); this.port.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (this.pending.size === 0) { this.worker.unref(); this.port.unref(); }
        reject(new ProcessExecutionControlFailure("bridge-timeout", "Execution bridge returned no verified response within its communication budget"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ requestId, signal, operation, data });
    });
  }
  close() {
    if (this.closed) return;
    this.request("close", {}, 14000);
    this.closed = true;
    this.port.close();
    this.delivery.close();
    // The worker has closed every owned scope before acknowledging close.
    this.worker.terminate();
  }
}

function currentBridge(root = process.cwd(), storage = null) {
  bridge ??= new SynchronousExecutionBridge(root, storage);
  return bridge;
}

/** Same async protocol, running on an independent event loop while caller waits. */
export function runManagedControlSync(grant, operation, data) {
  return currentBridge(grant.mainRoot, grant.storage ?? null).request("control", { grant, operation, data }, 15000);
}

function synchronousCommandData(invocation, options) {
  const { cwd: _cwd, env: _env, stdio: _stdio, signal: _signal, ...executionOptions } = options;
  // Capture caller inheritance separately for each invocation before hopping.
  const inheritedEnvironment = invocation.env === null ? immutableCommandEnvironment(process.env) : null;
  return { invocation: invocation.toJSON(), inheritedEnvironment, options: executionOptions };
}

export class SynchronousCommandOutcome {
  #value;
  #failure;
  #failed = false;
  constructor(frame, bridge) {
    if (frame === null || typeof frame !== "object" || Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) {
      throw new ProcessExecutionControlFailure("bridge-response-invalid", "Command group has an incomplete result frame");
    }
    try { this.#value = bridge.result(frame); }
    catch (error) { this.#failed = true; this.#failure = error; }
    Object.freeze(this);
  }
  unwrap() { if (this.#failed) throw this.#failure; return this.#value; }
}

export function runCommandInSynchronousBridge(invocation, options, grant = null) {
  const timeoutMs = (options.timeout ?? 300000) + 30000;
  const root = grant?.mainRoot ?? options.repositoryRoot ?? invocation.cwd ?? process.cwd();
  const bridge = currentBridge(root, grant?.storage ?? null);
  const data = { ...synchronousCommandData(invocation, options), grant,
    temporaryParent: grant === null ? path.resolve(os.tmpdir()) : null };
  if (grant !== null || options.retainedControl !== true) return bridge.request("execute", data, timeoutMs);
  // Resolve and retain the exact storage location before requesting native work.
  const acquired = bridge.request("retained-scope", { mainRoot: root, executionRoot: root,
    environment: {}, temporaryParent: data.temporaryParent }, 30000);
  let history;
  let result;
  try {
    return completeManagedOperationSync(() => {
      history = ProcessExecutionHistoryReference.fromStored(acquired.history);
      result = bridge.request("execute", { ...data, grant: acquired.grant }, timeoutMs);
      result.processExecutionHistory = history;
      return result;
    }, (successful) => bridge.request("release-retained-scope", { grant: acquired.grant, successful }, 30000));
  } catch (error) {
    retainExecutionCompletion(error, result);
    if (history !== undefined) error.processExecutionHistory = history;
    throw error;
  }
}

/** Independent invocations; every result or refusal is settled before return. */
export function runCommandsInSynchronousBridge(executions, grant) {
  if (grant === null || grant === undefined) throw new TypeError("Concurrent bridge commands require shared scoped authority");
  const first = executions[0];
  const bridge = currentBridge(grant?.mainRoot ?? first.options.repositoryRoot ?? first.invocation.cwd ?? process.cwd(), grant?.storage ?? null);
  const commands = executions.map((execution) => synchronousCommandData(execution.invocation, execution.options));
  // No member's original execution timeout is increased. Keep the original
  // communication allowance after the maximum concurrent execution timeout.
  const timeouts = executions.map((execution) => execution.options.timeout ?? 300000);
  const timeoutMs = Math.max(...timeouts) + 30000;
  const frames = bridge.request("execute-many", { commands, grant }, timeoutMs);
  if (!Array.isArray(frames) || frames.length !== executions.length) {
    throw new ProcessExecutionControlFailure("bridge-response-invalid", "Command group did not return every original invocation result");
  }
  return frames.map((frame) => new SynchronousCommandOutcome(frame, bridge));
}

export function acquireStandaloneExecutionGrantSync(root) {
  return currentBridge(root).request("scope", { root, temporaryParent: path.resolve(os.tmpdir()) }, 30000);
}

export function releaseStandaloneExecutionGrantSync(root) {
  return currentBridge(root).request("release-scope", { root }, 30000);
}

export function ensureStandaloneExecutionGrant(root = process.cwd()) {
  return currentBridge(root).requestAsync("scope", { root, temporaryParent: path.resolve(os.tmpdir()) }, 30000);
}

export function releaseStandaloneExecutionGrant(root) {
  return currentBridge(root).requestAsync("release-scope", { root }, 30000);
}

export function acquireReadOnlyExecutionGrantSync(options) {
  return currentBridge(options.mainRoot).request("read-only-scope", { ...options, temporaryParent: path.resolve(os.tmpdir()) }, 30000);
}

export function releaseReadOnlyExecutionGrantSync(grant, { successful }) {
  return currentBridge(grant.mainRoot, grant.storage ?? null)
    .request("release-read-only-scope", { grant, successful }, 30000);
}

export function closeSynchronousExecutionBridge() {
  if (bridge !== null) { bridge.close(); bridge = null; }
}

process.once("beforeExit", closeSynchronousExecutionBridge);
