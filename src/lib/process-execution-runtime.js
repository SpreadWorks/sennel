import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtomicFile } from "./atomic-file.js";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { ProcessLock, LockOwnerSession } from "./process-lock.js";
import { RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { ReadOnlyInvocationWorkspace, ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { ProcessExecutionControlEndpoint } from "./process-execution-endpoint.js";
import { ManagedStopOperation, managedMonotonicNow } from "./managed-stop-operation.js";
import { ManagedControlPolicy } from "./managed-control-policy.js";
import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "./agent-timeout.js";
import { ManagedStopOperationStore } from "./managed-stop-store.js";
import { ManagedOutputSpool, ManagedOutputSnapshot, readManagedOutput } from "./managed-process-output.js";
import { writeManagedRecord, ManagedProcessMessage } from "./managed-process-protocol.js";
import { CommandInvocation, CommandLaunchDescriptor } from "./command-invocation.js";
import { currentRuntimeWireDelivery, currentRuntimePackage } from "./runtime-package.js";
import { runManagedControlSync } from "./process-execution-sync.js";
import { combineProcessExecutionFailures } from "./process-execution-completion.js";
import { ProcessExecutionReservationRevocation, ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";
export { ProcessExecutionReservationRevocation } from "./process-execution-reservation-revocation.js";
import { ProcessExecutionBindingSelection, ProcessExecutionFinalizationCutoff, ProcessExecutionFinalizationBarrier } from "./process-execution-finalization.js";
export { ProcessExecutionBindingSelection, ProcessExecutionFinalizationBarrier } from "./process-execution-finalization.js";
import {
  ProcessExecutionControlFailure, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionInvocationDisclosure, ProcessExecutionStopReceipt, ProcessExecutionStartPermit, ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryCall,
  ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionEvent,
  ProcessExecutionCanonicalAcknowledgement, ProcessExecutionRuntimeOnlyDisposition, ProcessExecutionEventBatchWriter, ProcessExecutionValueEncoding,
  executionUuid as uuid, executionValueSnapshot as json, executionValueDigest as digest, freezeExecutionValue,
} from "./process-execution-values.js";
export {
  ProcessExecutionControlFailure, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionInvocationDisclosure, ProcessExecutionStopReceipt, ProcessExecutionStartPermit, ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryCall,
} from "./process-execution-values.js";

function captureCheckoutAuthorities(main, checkout) {
  main.assertStable(); checkout.assertStable();
  return new ProcessExecutionCheckoutIdentity({ mainRoot: main.directory, executionRoot: checkout.directory,
    mainDevice: Number(main.identity.dev), mainInode: Number(main.identity.ino),
    checkoutDevice: Number(checkout.identity.dev), checkoutInode: Number(checkout.identity.ino) });
}
export function captureProcessExecutionCheckoutIdentity({ mainRoot, executionRoot = mainRoot }) {
  return captureCheckoutAuthorities(new RealDirectoryAuthority(mainRoot), new RealDirectoryAuthority(executionRoot));
}
export const PROCESS_EXECUTION_SCOPE_ENV = "SENNEL_PROCESS_EXECUTION_SCOPE";
const scopes = new AsyncLocalStorage();
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const RUNTIME_RECORD_VERSION = 8;
const recoveryEvidenceAuthority = Symbol("process-runtime-recovery-evidence");
function fail(reason, message, details) { throw new ProcessExecutionControlFailure(reason, message, details); }
function exact(value, restored) {
  if (!isDeepStrictEqual(value, json(restored))) throw new TypeError("Runtime record has missing or unknown fields");
  return restored;
}
function readJson(file, required = true) {
  return decodeRuntimeJson(file.read(), file.filePath, required);
}
function decodeRuntimeJson(bytes, filePath, required = true) {
  if (bytes === null) {
    if (required) fail("record-missing", `Required runtime record is missing: ${filePath}`);
    return null;
  }
  if (bytes.length > MAX_REGISTRY_BYTES) fail("record-corrupt", "Runtime record exceeds its size limit");
  return JSON.parse(bytes.toString("utf8"));
}

/** Serialized capability for one exact coordinator owner and semantic scope. */
export class ProcessExecutionGrant {
  constructor({ version, mainRoot, executionRoot, runId, specId, executionId, callId, ownerEpoch,
    ownerToken, ownerSession, capability, bindingDigest, runtimeRevision, endpoint, controlResponseDeadlinesMs, scopeBinding = null, transport, executor = null, storage = null }) {
    if (version !== 3 || !path.isAbsolute(mainRoot) || path.resolve(mainRoot) !== mainRoot
      || !path.isAbsolute(executionRoot) || path.resolve(executionRoot) !== executionRoot
      || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Coordinator grant authority is invalid");
    for (const value of [runId, specId]) if (value !== null && (typeof value !== "string" || !value)) throw new TypeError("Coordinator grant run/spec is invalid");
    for (const value of [bindingDigest, runtimeRevision]) if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Coordinator grant digest is invalid");
    Object.assign(this, { version, mainRoot, executionRoot, runId, specId, ownerEpoch, bindingDigest, runtimeRevision });
    this.executionId = uuid(executionId, "grant execution ID"); this.callId = uuid(callId, "grant call ID");
    this.ownerToken = uuid(ownerToken, "grant owner token"); this.ownerSession = uuid(ownerSession, "grant owner session");
    this.capability = uuid(capability, "grant capability");
    this.storage = storage === null ? null : ReadOnlyProcessRuntimeStorage.fromGrant(storage).toJSON();
    const controlEndpoint = new ProcessExecutionControlEndpoint(endpoint).assertCheckout(executionRoot);
    controlEndpoint.assertStorage();
    if (!isDeepStrictEqual(controlResponseDeadlinesMs, new ManagedControlPolicy().responseDeadlinesMs)) throw new TypeError("Coordinator grant control policy differs from its fixed runtime");
    this.controlResponseDeadlinesMs = Object.freeze([...controlResponseDeadlinesMs]);
    this.endpoint = controlEndpoint.toJSON();
    this.scopeBinding = new ProcessExecutionBinding(scopeBinding);
    this.executor = executor === null ? null : executor instanceof ProcessExecutorIdentity ? executor : ProcessExecutorIdentity.fromStored(executor);
    if (transport !== undefined && transport !== "mailbox") throw new TypeError("Coordinator grant transport is invalid");
    if (transport !== undefined) this.transport = transport;
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, mainRoot: this.mainRoot, executionRoot: this.executionRoot,
    runId: this.runId, specId: this.specId, executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    ownerToken: this.ownerToken, ownerSession: this.ownerSession, capability: this.capability, bindingDigest: this.bindingDigest,
    runtimeRevision: this.runtimeRevision, endpoint: json(this.endpoint), controlResponseDeadlinesMs: this.controlResponseDeadlinesMs, storage: json(this.storage), scopeBinding: this.scopeBinding.toJSON(), executor: this.executor?.toJSON() ?? null,
    ...(this.transport === undefined ? {} : { transport: this.transport }) }; }
}

/** One durable registered child; no operating-system process identifiers confer authority. */
function callCompletion(call) { return call.receipt ?? call.revocation; }

class PhysicalCallRecord {
  constructor({ callId, parentCallId, binding, invocation, capability, status, executor, permit,
    observation, output, receipt, revocation, outcome, controlFailure, stopOperation, accepting, timeoutMs, graceMs,
    startedAt, startedMonotonic, aborted }, { executionId } = {}) {
    this.callId = uuid(callId, "callId");
    this.parentCallId = parentCallId === null ? null : uuid(parentCallId, "parentCallId");
    this.binding = new ProcessExecutionBinding(binding);
    this.invocation = json(invocation);
    if (this.invocation?.actualCommand !== undefined) {
      CommandInvocation.fromStored(this.invocation.actualCommand);
      CommandLaunchDescriptor.fromStored(this.invocation.launch);
    }
    this.capability = uuid(capability, "call capability");
    if (!["intent", "claimed", "running", "exited", "stopped", "revoked"].includes(status)) throw new TypeError("Call status is invalid");
    this.status = status;
    this.executor = executor === null ? null : ProcessExecutorIdentity.fromStored(executor);
    this.permit = permit === null ? null : new ProcessExecutionStartPermit(permit);
    this.observation = observation === null ? null : ChildExitObservation.fromStored(observation);
    this.output = output === null ? null : ProcessOutputState.fromStored(output);
    this.receipt = receipt === null ? null : new ProcessExecutionStopReceipt(receipt);
    this.revocation = revocation === null ? null : ProcessExecutionReservationRevocation.fromStored(revocation);
    this.outcome = json(outcome);
    this.controlFailure = controlFailure === null ? null : ProcessExecutionControlFailure.fromStored(controlFailure, { executionId, callId: this.callId });
    this.stopOperation = stopOperation === null ? null : ManagedStopOperation.fromStored(stopOperation);
    if (typeof accepting !== "boolean" || typeof aborted !== "boolean"
      || timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      || !Number.isFinite(graceMs) || graceMs <= 0
      || startedAt !== null && (typeof startedAt !== "string" || new Date(startedAt).toISOString() !== startedAt)
      || startedMonotonic !== null && (!Number.isFinite(startedMonotonic) || startedMonotonic < 0)) throw new TypeError("Call execution control state is invalid");
    Object.assign(this, { accepting, timeoutMs, graceMs, startedAt, startedMonotonic, aborted });
    if ((["intent", "revoked"].includes(status)) !== (this.executor === null) || (this.executor === null) !== (this.permit === null)
      || (status === "stopped") !== (this.receipt !== null)
      || (status === "revoked") !== (this.revocation !== null)
      || (status === "revoked" && (this.accepting || this.outcome !== null || this.startedAt !== null || this.startedMonotonic !== null))
      || (["exited", "stopped"].includes(status)) !== (this.observation !== null)
      || (this.observation !== null && !this.observation.executor.matches(this.executor))
      || (this.observation !== null && this.accepting)) throw new TypeError("Call phase disagrees with its ownership and observations");
    if ((this.receipt !== null) !== (this.output !== null)) throw new TypeError("Call receipt requires its output observation");
  }
  mutableCopy(authority) { return mutableRuntimeRecordShell(this, authority); }
  get completion() { return callCompletion(this); }
  toJSON() { return { callId: this.callId, parentCallId: this.parentCallId, binding: this.binding.toJSON(),
    invocation: this.invocation, capability: this.capability, status: this.status, executor: this.executor,
    permit: this.permit, observation: this.observation, output: this.output, receipt: this.receipt, revocation: this.revocation, outcome: this.outcome,
    controlFailure: this.controlFailure, stopOperation: this.stopOperation, accepting: this.accepting,
    timeoutMs: this.timeoutMs, graceMs: this.graceMs, startedAt: this.startedAt, startedMonotonic: this.startedMonotonic, aborted: this.aborted }; }
}

class RuntimeRequestRecord {
  constructor({ requestId, operation, payloadDigest, authorizationDigest, response }) {
    this.requestId = uuid(requestId, "request ID");
    if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)
      || !/^[a-f0-9]{64}$/.test(payloadDigest) || !/^[a-f0-9]{64}$/.test(authorizationDigest)) throw new TypeError("Request acceptance is invalid");
    Object.assign(this, { operation, payloadDigest, authorizationDigest, response: json(response) });
  }
  mutableCopy(authority) { return mutableRuntimeRecordShell(this, authority); }
  toJSON() { return { ...this }; }
}

function readRuntimeRequest(file) {
  const saved = readJson(file, false);
  if (saved === null) return null;
  if (saved.digest !== digest(saved.payload)) fail("record-corrupt", "Coordinator request replay checksum differs");
  return new RuntimeRequestRecord(saved.payload);
}

class ProcessExecutionFinalizationFence {
  constructor({ fenceId, selection, cutoff, barrier }) {
    this.fenceId = uuid(fenceId, "finalization fence");
    this.selection = new ProcessExecutionBindingSelection(selection);
    this.cutoff = cutoff === null ? null : ProcessExecutionFinalizationCutoff.fromStored(cutoff);
    this.barrier = barrier === null ? null : ProcessExecutionFinalizationBarrier.fromStored(barrier);
    if (this.cutoff !== null && (this.cutoff.fenceId !== fenceId || this.cutoff.selection.digest !== this.selection.digest)
      || this.barrier !== null && (this.cutoff === null || !isDeepStrictEqual(this.barrier.inventory(), this.cutoff.inventory()))) throw new TypeError("Finalization fence disagrees with its cutoff or barrier");
  }
  mutableCopy(authority) { return mutableRuntimeRecordShell(this, authority); }
  toJSON() { return { fenceId: this.fenceId, selection: this.selection.toJSON(), cutoff: this.cutoff, barrier: this.barrier }; }
}
function finalizationInventory(root, fence) {
  return { schemaVersion: 2, executionId: root.executionId, ownerEpoch: root.ownerEpoch,
    fenceId: fence.fenceId, selection: fence.selection.toJSON(), cutoffSequence: root.events.length,
    callClosures: root.calls.filter((call) => fence.selection.matches(call.binding)).map((call) => ProcessExecutionCallClosure.fromFact(callCompletion(call)).toJSON()),
    events: root.events.filter((event) => fence.selection.matches(event.binding)).map((event) => ({ eventId: event.eventId, sequence: event.sequence, eventDigest: digest(event) })) };
}
class RootExecutionRecord {
  constructor({ executionId, ownerEpoch, coordinatorIdentity, rootCapability, endpoint, runId, specId, binding,
    accepting, status, calls, closure, requests, events, eventAcknowledgements, runtimeOnlyDispositions, recoveryFence, hostConnected, finalizationFences }) {
    this.executionId = uuid(executionId, "executionId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Execution owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.coordinatorIdentity = new LockOwnerSession(coordinatorIdentity);
    this.rootCapability = uuid(rootCapability, "root capability");
    // Closed history retains the endpoint's structure without reopening its
    // live filesystem authority. Only live grants/admission require that proof.
    this.endpoint = new ProcessExecutionControlEndpoint(endpoint).toJSON();
    for (const value of [runId, specId]) if (value !== null && (typeof value !== "string" || value === "")) throw new TypeError("Runtime run/spec identity is invalid");
    Object.assign(this, { runId, specId });
    this.binding = new ProcessExecutionBinding(binding);
    if (typeof accepting !== "boolean" || typeof hostConnected !== "boolean" || !["active", "stopping", "closed"].includes(status)) throw new TypeError("Execution admission state is invalid");
    Object.assign(this, { accepting, status, hostConnected });
    this.calls = calls.map((call) => new PhysicalCallRecord(call, { executionId }));
    this.requests = requests.map((request) => new RuntimeRequestRecord(request));
    this.events = events.map((event) => ProcessExecutionEvent.fromStored(event));
    this.eventAcknowledgements = eventAcknowledgements.map((value) => ProcessExecutionCanonicalAcknowledgement.fromStored(value));
    this.runtimeOnlyDispositions = runtimeOnlyDispositions.map((value) => ProcessExecutionRuntimeOnlyDisposition.fromStored(value));
    this.recoveryFence = recoveryFence === null ? null : uuid(recoveryFence, "recovery fence");
    this.finalizationFences = finalizationFences.map((fence) => exact(fence, new ProcessExecutionFinalizationFence(fence)));
    this.closure = json(closure);
    if (new Set(this.calls.map((call) => call.callId)).size !== this.calls.length
      || new Set(this.requests.map((request) => request.requestId)).size !== this.requests.length
      || new Set(this.events.map((event) => event.eventId)).size !== this.events.length
      || new Set(this.finalizationFences.map((fence) => fence.selection.digest)).size !== this.finalizationFences.length
      || new Set(this.eventAcknowledgements.map((fact) => fact.eventId)).size !== this.eventAcknowledgements.length
      || new Set(this.runtimeOnlyDispositions.map((fact) => fact.eventId)).size !== this.runtimeOnlyDispositions.length) throw new TypeError("Runtime inventory contains duplicate identities");
    if (this.events.some((event, index) => event.sequence !== index + 1 || event.executionId !== executionId
      || !this.calls.some((call) => call.callId === event.callId))
      || [...this.eventAcknowledgements, ...this.runtimeOnlyDispositions].some((fact) => !this.events.some((event) => fact.matches(event)))
      || this.runtimeOnlyDispositions.some((fact) => this.hasCanonicalAcknowledgement(fact.eventId))) throw new TypeError("Runtime event outbox is invalid");
    for (const fence of this.finalizationFences) {
      if (fence.cutoff === null) continue;
      const expected = finalizationInventory(this, fence);
      // Unrelated unbound cleanup can advance the execution-global sequence.
      expected.cutoffSequence = fence.cutoff.cutoffSequence;
      if (fence.cutoff.cutoffSequence > this.events.length
        || this.calls.some((call) => fence.selection.matches(call.binding) && callCompletion(call) === null)
        || !isDeepStrictEqual(expected, fence.cutoff.inventory())
        || fence.barrier !== null && fence.barrier.events.some((event) => !this.hasCanonicalAcknowledgement(event.eventId))) throw new TypeError("Finalization cutoff differs from the sealed selected receipts or acknowledged events");
    }
    if ((status !== "active" || recoveryFence !== null || !hostConnected) && accepting) throw new TypeError("Fenced execution accepts new calls");
    if (status === "closed") {
      if (closure === null || this.calls.some((call) => callCompletion(call) === null)
        || !isDeepStrictEqual(closure, { executionId, ownerEpoch,
          callClosures: this.calls.map((call) => ProcessExecutionCallClosure.fromFact(callCompletion(call)).toJSON()), recovery: closure.recovery })
        || typeof closure.recovery !== "boolean") throw new TypeError("Closed execution lacks exact termination receipts");
    } else if (closure !== null) throw new TypeError("Unfinished execution has a closure receipt");
    for (const call of this.calls) {
      let parentId = call.parentCallId;
      const seen = new Set([call.callId]);
      while (parentId !== null) {
        if (seen.has(parentId)) throw new TypeError("Nested call lineage is cyclic");
        seen.add(parentId);
        const parent = this.calls.find((entry) => entry.callId === parentId);
        if (!parent) throw new TypeError("Nested call lineage is missing");
        parentId = parent.parentCallId;
      }
      if (call.permit && (call.permit.executionId !== executionId || call.permit.callId !== call.callId
        || call.permit.ownerEpoch !== ownerEpoch || call.permit.ownerToken !== this.coordinatorIdentity.ownerToken
        || call.permit.capability !== call.capability || call.permit.bindingDigest !== call.binding.digest)) throw new TypeError("Start permit binding is invalid");
      if (call.revocation) {
        if (call.revocation.executionId !== executionId || call.revocation.callId !== call.callId || call.revocation.ownerEpoch !== ownerEpoch
          || !call.revocation.binding.matches(call.binding) || !new ProcessExecutionInvocationDisclosure({ invocation: call.revocation.invocation, invocationDigest: call.revocation.invocationDigest }).matchesPrivate(call.invocation)
          || !isDeepStrictEqual(json(call.revocation.stopOperation), json(call.stopOperation)) || descendantsOf(this, call).length !== 0) throw new TypeError("Revocation disagrees with its unclaimed reservation");
      }
      if (callCompletion(call) !== null) {
        const event = this.events[callCompletion(call).closureRevision - 1];
        const closure = ProcessExecutionCallClosure.fromFact(callCompletion(call));
        if (event?.type !== "result-finalized" || event.callId !== call.callId || event.payload.closureKind !== closure.closureKind
          || event.payload.closureDigest !== closure.closureDigest) throw new TypeError("Call closure differs from its exact durable result event");
      }
      if (call.receipt) {
        const descendants = descendantsOf(this, call).map((entry) => ProcessExecutionCallClosure.fromFact(callCompletion(entry)).toJSON());
        if (call.receipt.executionId !== executionId || call.receipt.callId !== call.callId || call.receipt.ownerEpoch !== ownerEpoch
          || !call.receipt.binding.matches(call.binding) || !new ProcessExecutionInvocationDisclosure({ invocation: call.receipt.invocation, invocationDigest: call.receipt.invocationDigest }).matchesPrivate(call.invocation)
          || !isDeepStrictEqual(json(call.receipt.observation), json(call.observation)) || !isDeepStrictEqual(json(call.receipt.output), json(call.output))
          || !call.receipt.executor.matches(call.executor) || !isDeepStrictEqual(json(call.receipt.stopOperation), json(call.stopOperation))
          || descendantsOf(this, call).some((entry) => callCompletion(entry) === null)
          || !isDeepStrictEqual(json(call.receipt.descendants), descendants) || call.receipt.outcomeDigest !== digest(call.outcome)) throw new TypeError("Stop receipt disagrees with durable call facts");
      }
      if (call.controlFailure !== null && (call.controlFailure.executionId !== executionId || call.controlFailure.callId !== call.callId)) throw new TypeError("Call failure belongs to another execution");
    }
  }
  mutableCopy(authority) {
    const copy = mutableRuntimeRecordShell(this, authority);
    copy.calls = this.calls.map((call) => call.mutableCopy(authority));
    copy.requests = this.requests.map((request) => request.mutableCopy(authority));
    copy.events = [...this.events];
    copy.eventAcknowledgements = [...this.eventAcknowledgements];
    copy.runtimeOnlyDispositions = [...this.runtimeOnlyDispositions];
    copy.finalizationFences = this.finalizationFences.map((fence) => fence.mutableCopy(authority));
    return copy;
  }
  hasCanonicalAcknowledgement(eventId) { return this.eventAcknowledgements.some((fact) => fact.eventId === eventId); }
  hasRuntimeOnlyDisposition(eventId) { return this.runtimeOnlyDispositions.some((fact) => fact.eventId === eventId); }
  toJSON() { return { executionId: this.executionId, ownerEpoch: this.ownerEpoch, coordinatorIdentity: this.coordinatorIdentity,
    rootCapability: this.rootCapability, endpoint: this.endpoint, runId: this.runId, specId: this.specId, binding: this.binding.toJSON(),
    accepting: this.accepting, status: this.status, hostConnected: this.hostConnected, calls: this.calls, closure: this.closure,
    requests: this.requests, events: this.events, eventAcknowledgements: this.eventAcknowledgements, runtimeOnlyDispositions: this.runtimeOnlyDispositions, recoveryFence: this.recoveryFence,
    finalizationFences: this.finalizationFences }; }
}
function assertPriorCanonicalPublication(inventory, root, selection) {
  const older = inventory.filter((execution) => execution.ownerEpoch < root.ownerEpoch);
  if (older.some((execution) => execution.calls.some((call) => selection.matches(call.binding)
    && (execution.status !== "closed" || callCompletion(call) === null)))) fail("finalization-pending", "Older selected execution lacks exact closed call inventory");
  if (older.some((execution) => execution.events.some((event) => selection.matches(event.binding)
    && !execution.hasCanonicalAcknowledgement(event.eventId)))) fail("activity-pending", "Older selected process events still lack durable canonical acknowledgement");
}
function hasPendingBoundEvents(root) {
  return root.events.some((event) => event.binding.value !== null && !root.hasCanonicalAcknowledgement(event.eventId)
    && !root.hasRuntimeOnlyDisposition(event.eventId));
}
function descendantsOf(root, call) {
  const result = []; const pending = [call.callId];
  while (pending.length) {
    const parent = pending.shift();
    for (const child of root.calls.filter((entry) => entry.parentCallId === parent)) { result.push(child); pending.push(child.callId); }
  }
  return result;
}
class RuntimeRegistry {
  constructor({ version, checkout, ownerEpoch, slot, executions }) {
    if (version !== RUNTIME_RECORD_VERSION) fail("record-unsupported", "Legacy process ownership evidence cannot authorize registered-child execution; explicit investigation is required");
    this.version = version;
    this.checkout = new ProcessExecutionCheckoutIdentity(checkout);
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) throw new TypeError("Runtime owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.slot = slot === null ? null : uuid(slot, "checkout slot");
    this.executions = executions.map((execution) => new RootExecutionRecord(execution));
    if (new Set(this.executions.map((entry) => entry.executionId)).size !== this.executions.length
      || new Set(this.executions.map((entry) => entry.ownerEpoch)).size !== this.executions.length
      || this.executions.some((entry) => entry.ownerEpoch > ownerEpoch)) throw new TypeError("Runtime owner epochs disagree");
    const unfinished = this.executions.filter((entry) => entry.status !== "closed");
    if (unfinished.length > 1 || (slot === null ? unfinished.length !== 0 : unfinished.length !== 1 || unfinished[0].executionId !== slot)) throw new TypeError("Checkout slot disagrees with unfinished inventory");
    for (const call of this.executions.flatMap((entry) => entry.calls)) if (callCompletion(call) && !callCompletion(call).checkoutIdentity.matches(this.checkout)) throw new TypeError("Receipt belongs to another checkout");
  }
  mutableCopy(authority) {
    const copy = mutableRuntimeRecordShell(this, authority);
    copy.executions = this.executions.map((execution) => execution.mutableCopy(authority));
    return copy;
  }
  eventPublicationCount() {
    return this.executions.reduce((count, execution) => count
      + execution.eventAcknowledgements.length + execution.runtimeOnlyDispositions.length, 0);
  }
  toJSON() { return { version: this.version, checkout: this.checkout, ownerEpoch: this.ownerEpoch, slot: this.slot, executions: this.executions }; }
}
class ClosedProcessExecutionArchive {
  constructor({ version, checkout, execution }) {
    if (version !== RUNTIME_RECORD_VERSION) fail("record-unsupported", "Legacy process archive cannot authorize registered-child execution");
    this.version = version;
    this.checkout = new ProcessExecutionCheckoutIdentity(checkout);
    this.execution = new RootExecutionRecord(execution);
    if (this.execution.status !== "closed" || hasPendingBoundEvents(this.execution) || this.execution.calls.some((call) => !callCompletion(call).checkoutIdentity.matches(this.checkout))) throw new TypeError("Archive lacks exact closed checkout receipts");
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, checkout: this.checkout, execution: this.execution }; }
}
function sameRuntimeRecordSnapshot(expected, actual) {
  return sameFileIdentity(expected.identity, actual.identity)
    && expected.digest === actual.digest && expected.bytes.equals(actual.bytes);
}

const runtimeRegistryObservationAuthority = Symbol("runtime registry observation");

// Only an existing observation may detach its fully validated, deeply frozen
// graph. Record classes above own every mutable container; nested facts are
// shared immutable values and updates replace them rather than changing them.
function mutableRuntimeRecordShell(record, authority) {
  if (authority !== runtimeRegistryObservationAuthority || !Object.isFrozen(record)
    || ![RuntimeRegistry, RootExecutionRecord, PhysicalCallRecord, RuntimeRequestRecord, ProcessExecutionFinalizationFence]
      .some((Record) => Object.getPrototypeOf(record) === Record.prototype)) {
    throw new TypeError("Mutable runtime records require a validated immutable observation");
  }
  return Object.assign(Object.create(Object.getPrototypeOf(record)), record);
}


/** Normalize and encode privately before any durable transition begins. */
class PreparedRuntimeRegistryPublication {
  #registry;
  #content;
  constructor(registry) {
    this.#registry = new RuntimeRegistry(json(registry));
    this.#content = encodeRuntimeRecord(this.#registry);
    Object.freeze(this);
  }
  transitionJSON() { return JSON.stringify({ executionId: this.#registry.slot, ownerEpoch: this.#registry.ownerEpoch }); }
  publish(file) {
    const publication = file.write(this.#content);
    return new ValidatedRuntimeRegistryObservation(runtimeRegistryObservationAuthority, this.#registry, publication.snapshot);
  }
}

/** Exact registry data bound to one validated physical snapshot.
 * A prepared publication or a fully checked immutable read can mint the proof. */
class ValidatedRuntimeRegistryObservation {
  #registry;
  #snapshot;
  constructor(authority, registry, snapshot) {
    if (authority !== runtimeRegistryObservationAuthority) throw new TypeError("Registry observations require their validated source");
    this.#registry = registry;
    this.#snapshot = snapshot;
    Object.freeze(this);
  }
  static fromValidatedRead(registry, snapshot) {
    return new ValidatedRuntimeRegistryObservation(runtimeRegistryObservationAuthority, freezeExecutionValue(registry), snapshot);
  }
  read(snapshot) {
    return snapshot !== null && sameRuntimeRecordSnapshot(this.#snapshot, snapshot) ? this.#registry : null;
  }
  mutableCopy() { return this.#registry.mutableCopy(runtimeRegistryObservationAuthority); }
  assertMatches(registry) {
    if (registry !== this.#registry && !isDeepStrictEqual(json(registry), json(this.#registry))) {
      fail("record-corrupt", "Runtime durable readback differs from the committed inventory");
    }
  }
}

/** Strict archive decoding bound to one captured physical file. */
class ValidatedRuntimeArchiveObservation {
  #snapshot;
  #archive;
  constructor(snapshot, filePath, checkout, name) {
    const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, filePath);
    if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime archive checksum is invalid");
    const archive = exact(envelope.payload, new ClosedProcessExecutionArchive(envelope.payload));
    this.#archive = archive;
    if (!this.#matchesCheckout(checkout, name)) fail("authority-mismatch", "Runtime archive belongs to another checkout or execution");
    this.#snapshot = snapshot;
    // Closed history is shared only as an immutable validated value. Its
    // physical snapshot remains fresh on every use, including cache hits.
    this.#archive = freezeExecutionValue(archive);
    Object.freeze(this);
  }
  #matchesCheckout(checkout, name) {
    return this.#archive.checkout.matches(checkout) && name === `${this.#archive.execution.executionId}.json`;
  }
  matches(snapshot, checkout, name) {
    return this.#matchesCheckout(checkout, name) && sameRuntimeRecordSnapshot(this.#snapshot, snapshot);
  }
  get execution() { return this.#archive.execution; }
}

/** Strong decoding reuse for one inventory observation or exclusive RPC. */
class RuntimeRecordObservation {
  #observations = new Map();

  read(file, checkout, name, retainedObservations) {
    // Every observation still captures and validates the actual physical file.
    const snapshot = file.readSnapshot();
    const previous = this.#observations.get(file.filePath) ?? retainedObservations.get(file.filePath)?.deref();
    if (snapshot !== null && previous?.matches(snapshot, checkout, name)) {
      this.#observations.set(file.filePath, previous);
      return previous.execution;
    }
    this.#observations.delete(file.filePath);
    retainedObservations.delete(file.filePath);
    const observation = new ValidatedRuntimeArchiveObservation(snapshot, file.filePath, checkout, name);
    this.#observations.set(file.filePath, observation);
    retainedObservations.set(file.filePath, new WeakRef(observation));
    return observation.execution;
  }
}
function encodeRuntimeRecord(record) {
  const payload = new ProcessExecutionValueEncoding(record);
  const content = `{"payload":${payload.text()},"digest":"${payload.digest}"}`;
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime metadata exceeds the durable size limit before publication");
  return content;
}

class CoordinatorCallRecordContext {
  constructor(store, root, call) {
    this.executionId = root.executionId; this.callId = call.callId;
    this.ownerToken = root.coordinatorIdentity.ownerToken; this.capability = call.capability;
    this.executor = call.executor; this.recordLocks = store.lockAuthority;
    this.outcomePath = path.join(store.callDirectory(call.callId), "outcome.json");
    Object.freeze(this);
  }
}

class ProcessRuntimeStore {
  // Data reuse only: every read still revalidates physical authority/inventory.
  #readonlyObservation = null;
  // Expanded closed history is never kept alive between requests by the Store.
  // GC misses take the same full validation path; current requests hold their
  // own strong observations until all inventory and publication checks finish.
  #archiveObservations = new Map();
  constructor({ mainRoot, executionRoot, faultInjector = () => {}, create = true, retainedClosed = false, historical = false, storagePolicy = null }) {
    if ((retainedClosed || historical) && create) throw new TypeError("Historical checkout inspection cannot create runtime authority");
    if (storagePolicy !== null && !(storagePolicy instanceof ReadOnlyProcessRuntimeStorage)) throw new TypeError("Process runtime storage must be a minted workspace policy");
    this.storagePolicy = storagePolicy;
    this.storagePolicy?.assertStable();
    this.mainAuthority = new RealDirectoryAuthority(mainRoot);
    this.historical = historical;
    this.retainedExecutionRoot = null;
    if (historical) this.retainedExecutionRoot = path.resolve(executionRoot);
    else if (retainedClosed) {
      try { fs.lstatSync(path.resolve(executionRoot)); }
      catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        this.retainedExecutionRoot = path.resolve(executionRoot);
      }
    }
    this.checkoutAuthority = this.retainedExecutionRoot === null ? new RealDirectoryAuthority(executionRoot) : null;
    this.checkout = this.checkoutAuthority === null ? null : captureCheckoutAuthorities(this.mainAuthority, this.checkoutAuthority);
    this.faultInjector = faultInjector;
    let prefix;
    if (storagePolicy !== null) prefix = storagePolicy.authority;
    else {
      const state = new RealDirectoryAuthority(path.join(this.mainAuthority.directory, ".sennel"), { create, parentAuthority: this.mainAuthority });
      if (create) state.ensure();
      prefix = new RealDirectoryAuthority(path.join(state.directory, "process-runtime"), { create, parentAuthority: state, creationMode: 0o700 });
      if (create) prefix.ensure();
    }
    this.authority = new RealDirectoryAuthority(path.join(prefix.directory, digest(this.checkout?.executionRoot ?? this.retainedExecutionRoot)), { create, parentAuthority: prefix, creationMode: 0o700 });
    if (create) this.authority.ensure();
    this.callsAuthority = new RealDirectoryAuthority(path.join(this.authority.directory, "calls"), { create, parentAuthority: this.authority });
    if (create) this.callsAuthority.ensure();
    this.archivesAuthority = new RealDirectoryAuthority(path.join(this.authority.directory, "archives"), { create, parentAuthority: this.authority });
    if (create) this.archivesAuthority.ensure();
    if (create) { this.callsAuthority.assertStable(); this.archivesAuthority.assertStable(); }
    this.file = new AtomicFile(path.join(this.authority.directory, "registry.json"), { directoryAuthority: this.authority, maxBytes: MAX_REGISTRY_BYTES, faultInjector, phaseNamespace: "runtime", commitGuard: () => this.assertStable() });
    this.anchor = new AtomicFile(path.join(this.authority.directory, "authority.json"), { directoryAuthority: this.authority });
    if (this.checkout === null) {
      const anchor = readJson(this.anchor);
      this.checkout = exact(anchor, new ProcessExecutionCheckoutIdentity(anchor));
      if (this.checkout.executionRoot !== this.retainedExecutionRoot
        || this.checkout.mainRoot !== this.mainAuthority.directory
        || this.checkout.mainDevice !== Number(this.mainAuthority.identity.dev)
        || this.checkout.mainInode !== Number(this.mainAuthority.identity.ino)) {
        fail("authority-mismatch", "Retained checkout anchor disagrees with its original namespace or actual main authority");
      }
    }
    this.transition = new AtomicFile(path.join(this.authority.directory, "transition.json"), { directoryAuthority: this.authority });
    this.lockAuthority = new RepositoryLockAuthority(this.mainAuthority.directory, { rootAuthority: this.mainAuthority, storagePolicy,
      errorFactory: (_status, message, { cause } = {}) => new ProcessExecutionControlFailure("ownership-unknown", message, { cause }) });
    const location = (fileName) => this.lockAuthority.location({ namespace: "process-runtime", identity: this.checkout.executionRoot,
      fileName, legacyPaths: [path.join(this.authority.directory, fileName)] });
    this.ownerLock = new ProcessLock({ location: location("owner.lock"), authority: json(this.checkout), kind: "checkout-process-runtime" });
    this.admissionOptions = { location: location("admission.lock"), authority: json(this.checkout), kind: "process-runtime-admission" };
    this.admission = new FileLock(this.admissionOptions);
    this.tail = Promise.resolve();
  }
  assertStable() {
    this.storagePolicy?.assertStable();
    this.mainAuthority.assertStable();
    if (this.checkoutAuthority !== null) this.checkoutAuthority.assertStable();
    else if (!this.historical) {
      try {
        fs.lstatSync(this.retainedExecutionRoot);
        fail("authority-mismatch", "Retained checkout path reappeared during inspection");
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
    this.authority.assertStable(); this.callsAuthority.assertStable(); this.archivesAuthority.assertStable();
  }
  assertCommitted() {
    this.assertStable();
    if (this.transition.read() !== null) fail("durability-uncertain", "An incomplete durable runtime transition requires refusal");
  }
  #rejectRegistryFailure(cause) {
    if (cause instanceof ProcessExecutionControlFailure) throw cause;
    fail(cause.publicationUnknown ? "durability-uncertain" : "registry-failed", `Process runtime registry operation failed: ${cause.message}`, { cause });
  }
  async exclusive(body, { deadline = Infinity, deadlineFailure = () => new ProcessExecutionControlFailure("stop-unproven", "Runtime admission exceeded the remaining stop deadline"), retainedClosed = false } = {}) {
    const previous = this.tail;
    let settle;
    this.tail = new Promise((resolve) => { settle = resolve; });
    let admitted = false;
    let timer;
    try {
      if (Number.isFinite(deadline)) {
        await Promise.race([previous, new Promise((resolve, reject) => {
          const expire = () => {
            const remaining = deadline - managedMonotonicNow();
            if (remaining <= 0) reject(deadlineFailure());
            else timer = setTimeout(expire, Math.ceil(remaining));
          };
          expire();
        })]);
      } else await previous;
      admitted = true;
      clearTimeout(timer);
      const admission = Number.isFinite(deadline) ? new FileLock({ ...this.admissionOptions,
        waitPolicy: new FileLockWaitPolicy({ timeoutMs: Math.floor(Math.max(0, deadline - managedMonotonicNow())) }) }) : this.admission;
      return await admission.runExclusiveAsync(() => {
        const view = retainedClosed ? new ProcessRuntimeStore({ mainRoot: this.checkout.mainRoot,
          executionRoot: this.checkout.executionRoot, create: false, retainedClosed: true,
          storagePolicy: this.storagePolicy, faultInjector: this.faultInjector }) : this;
        if (!view.checkout.matches(this.checkout)) fail("authority-mismatch", "Retained release belongs to a different checkout identity");
        view.assertCommitted();
        return body(view, new RuntimeRecordObservation());
      });
    } catch (cause) {
      this.#rejectRegistryFailure(cause);
    } finally {
      clearTimeout(timer);
      // A timed-out queued operation never runs, but must not let its successor
      // enter before the original holder has left the registry transaction.
      // Publish the committed result before the next admitted body can block IO.
      if (admitted) setImmediate(settle); else previous.then(settle);
    }
  }
  initialize() {
    const anchor = readJson(this.anchor, false);
    const existing = this.file.read();
    if (anchor === null && existing === null) {
      if (fs.readdirSync(this.callsAuthority.directory).length !== 0 || fs.readdirSync(this.archivesAuthority.directory).length !== 0) fail("record-missing", "Runtime inventory is missing while call artifacts remain");
      const empty = new RuntimeRegistry({ version: RUNTIME_RECORD_VERSION, checkout: json(this.checkout), ownerEpoch: 0, slot: null, executions: [] });
      this.file.write(encodeRuntimeRecord(empty));
      this.anchor.write(JSON.stringify(this.checkout));
      return this.read();
    }
    if (anchor === null || existing === null) fail("record-missing", "Runtime authority or inventory was removed");
    return this.read();
  }
  read({ required = true, archiveObservation = new RuntimeRecordObservation(), immutable = false } = {}) {
    try {
      this.assertCommitted();
      const snapshot = !required && this.file.read() === null ? null : this.#read(archiveObservation, null, immutable);
      this.assertCommitted();
      return snapshot;
    } catch (cause) {
      this.#readonlyObservation = null;
      this.#rejectRegistryFailure(cause);
    }
  }
  #read(archiveObservation = new RuntimeRecordObservation(), publication = null, immutable = false) {
    this.assertStable();
    if (!isDeepStrictEqual(readJson(this.anchor), json(this.checkout))) fail("authority-mismatch", "Persisted checkout identity does not match runtime authority");
    const snapshot = this.file.readSnapshot();
    const observed = this.#readonlyObservation?.read(snapshot) ?? null;
    if (observed === null) this.#readonlyObservation = null;
    let registry = publication?.read(snapshot) ?? observed;
    if (registry === null) {
      const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, this.file.filePath);
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime registry checksum is invalid");
      registry = exact(envelope.payload, new RuntimeRegistry(envelope.payload));
    }
    if (!isDeepStrictEqual(json(registry.checkout), json(this.checkout))) fail("authority-mismatch", "Runtime registry belongs to a different checkout");
    this.#assertInventory(registry, archiveObservation);
    // Reuse only an immutable graph of these exact physical bytes. Every
    // request freshly checks archive files and the complete inventory.
    // Publication readback keeps the original exact-identity/full-comparison
    // check before retaining any graph. save() invalidates it on later failure
    // and returns a detached working graph only after the transition completes.
    publication?.assertMatches(registry);
    if (registry !== observed) {
      this.#readonlyObservation = ValidatedRuntimeRegistryObservation.fromValidatedRead(registry, snapshot);
    }
    if (publication !== null || immutable) return registry;
    return this.#readonlyObservation.mutableCopy();
  }
  readArchives(archiveObservation = new RuntimeRecordObservation()) {
    this.archivesAuthority.assertStable();
    const names = fs.readdirSync(this.archivesAuthority.directory);
    const paths = new Set(names.map((name) => path.join(this.archivesAuthority.directory, name)));
    for (const [filePath, observation] of this.#archiveObservations) {
      if (!paths.has(filePath) || observation.deref() === undefined) this.#archiveObservations.delete(filePath);
    }
    return names.map((name) => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) fail("record-corrupt", "Unexpected runtime archive inventory entry");
      const file = new AtomicFile(path.join(this.archivesAuthority.directory, name), { directoryAuthority: this.archivesAuthority });
      return archiveObservation.read(file, this.checkout, name, this.#archiveObservations);
    }).sort((left, right) => left.ownerEpoch - right.ownerEpoch);
  }
  readInventory() {
    const archiveObservation = new RuntimeRecordObservation();
    const registry = this.read({ archiveObservation });
    return json({ ...registry.toJSON(), executions: [...this.readArchives(archiveObservation), ...registry.executions]
      .sort((left, right) => left.ownerEpoch - right.ownerEpoch) });
  }
  readConsistentInventory() {
    const deadline = managedMonotonicNow() + 1000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let failure;
    do {
      try {
        const before = this.file.readSnapshot();
        const result = this.readInventory();
        const after = this.file.readSnapshot();
        if (before !== null && after !== null && before.digest === after.digest
          && before.identity.dev === after.identity.dev && before.identity.ino === after.identity.ino) return result;
        failure = new ProcessExecutionControlFailure("durability-uncertain", "Runtime changed during read-only inventory observation");
      } catch (cause) {
        failure = cause;
        if (!(cause instanceof ProcessExecutionControlFailure)
          || !["durability-uncertain", "registry-failed", "record-missing"].includes(cause.reason)) throw cause;
      }
      if (managedMonotonicNow() >= deadline) break;
      Atomics.wait(pause, 0, 0, 10);
    } while (true);
    throw failure;
  }
  #assertInventory(registry, archiveObservation) {
    const inventory = [...this.readArchives(archiveObservation), ...registry.executions].sort((left, right) => left.ownerEpoch - right.ownerEpoch);
    if (inventory.length !== registry.ownerEpoch || inventory.some((record, index) => record.ownerEpoch !== index + 1)
      || new Set(inventory.map((record) => record.executionId)).size !== inventory.length) fail("record-missing", "Runtime execution epoch inventory is missing or duplicated");
    for (const execution of inventory) for (const fence of execution.finalizationFences) {
      if (fence.barrier === null) continue;
      try { assertPriorCanonicalPublication(inventory, execution, fence.selection); }
      catch (cause) { fail("record-corrupt", "Saved finalization barrier lacks its exact prior canonical publication inventory", { cause }); }
    }
    const events = inventory.flatMap((execution) => execution.events);
    if (new Set(events.map((event) => event.eventId)).size !== events.length) fail("record-corrupt", "Runtime inventory contains duplicate event identities");
    const calls = inventory.flatMap((execution) => execution.calls);
    const callIds = new Set(calls.map((call) => call.callId));
    if (callIds.size !== calls.length) fail("record-corrupt", "Runtime inventory contains duplicate physical calls");
    for (const name of fs.readdirSync(this.callsAuthority.directory)) {
      if (!callIds.has(name)) fail("record-missing", "A physical call artifact is outside the durable runtime inventory");
      new RealDirectoryAuthority(path.join(this.callsAuthority.directory, name), { parentAuthority: this.callsAuthority }).assertStable();
    }
  }
  archiveClosed() {
    const registry = this.read();
    for (const execution of registry.executions.filter((record) => record.status === "closed" && !hasPendingBoundEvents(record))) {
      const archive = new ClosedProcessExecutionArchive({ version: RUNTIME_RECORD_VERSION, checkout: json(this.checkout), execution: json(execution) });
      const content = encodeRuntimeRecord(archive);
      const file = new AtomicFile(path.join(this.archivesAuthority.directory, `${execution.executionId}.json`), {
        directoryAuthority: this.archivesAuthority, faultInjector: this.faultInjector, phaseNamespace: "runtime-archive", commitGuard: () => this.assertStable(),
      });
      if (file.read() !== null) fail("record-corrupt", "Closed execution archive already exists before transfer");
      this.transition.write(JSON.stringify({ phase: "archive", executionId: execution.executionId, ownerEpoch: execution.ownerEpoch }));
      file.write(content);
      if (file.read()?.toString() !== content) fail("record-corrupt", "Closed execution archive readback differs");
      registry.executions = registry.executions.filter((record) => record.executionId !== execution.executionId);
      this.file.write(encodeRuntimeRecord(new RuntimeRegistry(json(registry))));
      const saved = this.#read();
      if (!isDeepStrictEqual(json(saved), json(registry))) fail("record-corrupt", "Runtime archive transfer readback differs");
      this.transition.remove();
      this.faultInjector({ phase: "after-runtime-archive-readback", filePath: file.filePath });
    }
  }
  save(registry, { archiveObservation = new RuntimeRecordObservation() } = {}) {
    this.#readonlyObservation = null;
    try {
      const prepared = new PreparedRuntimeRegistryPublication(registry);
      this.transition.write(prepared.transitionJSON());
      const publication = prepared.publish(this.file);
      this.#read(archiveObservation, publication);
      this.transition.remove();
      this.faultInjector({ phase: "after-runtime-readback", filePath: this.file.filePath });
      return this.#readonlyObservation.mutableCopy();
    } catch (cause) {
      this.#readonlyObservation = null;
      throw cause;
    }
  }
  requestFile(executionId, requestId) {
    const directory = this.authority.descendant(path.join(this.authority.directory, "requests", uuid(executionId, "request execution ID")), { create: true });
    return new AtomicFile(path.join(directory.directory, `${uuid(requestId, "request ID")}.json`), {
      directoryAuthority: directory, maxBytes: 32 * 1024 * 1024,
    });
  }
  callContext(root, call) { return new CoordinatorCallRecordContext(this, root, call); }
  callDirectory(callId) {
    const directory = new RealDirectoryAuthority(path.join(this.callsAuthority.directory, uuid(callId, "callId")), { create: true, parentAuthority: this.callsAuthority });
    directory.ensure(); this.callsAuthority.assertStable();
    return directory.directory;
  }
}


/** A fresh physical observation usable only while its checkout exclusion is held. */
export class ProcessExecutionRecoveryEvidence {
  #readCurrent;
  #active = true;
  #binding;
  #invocation;
  #inventory;
  #revocations;
  #snapshotDigest;
  #summary;
  constructor({ checkoutIdentity, binding, invocation = null, inventory, revocations, readCurrent, authority }) {
    if (authority !== recoveryEvidenceAuthority || !(checkoutIdentity instanceof ProcessExecutionCheckoutIdentity) || !(binding instanceof ProcessExecutionBinding)
      || typeof readCurrent !== "function") throw new TypeError("Recovery evidence requires its held runtime authority");
    this.#binding = new ProcessExecutionBinding(binding);
    this.#invocation = new ProcessExecutionBinding(invocation);
    new ProcessExecutionInvocationDisclosure({ invocation: this.#invocation.toJSON(), invocationDigest: digest(this.#invocation.toJSON()) });
    this.#inventory = inventory;
    this.#revocations = revocations;
    this.#readCurrent = readCurrent;
    this.#snapshotDigest = digest(inventory);
    this.checkoutIdentity = checkoutIdentity;
    this.calls = Object.freeze(inventory.executions.flatMap((execution) => execution.calls
      .filter((call) => new ProcessExecutionBinding(call.binding).includes(this.#binding)
        && (this.#invocation.value === null || new ProcessExecutionBinding(call.invocation).includes(this.#invocation)))
      .map((call) => new ProcessExecutionRecoveryCall({ executionId: execution.executionId, ownerEpoch: execution.ownerEpoch,
        callId: call.callId, binding: call.binding, ...ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON(), startPermitted: call.permit !== null, receipt: call.receipt, revocation: call.revocation }))));
    this.receipts = Object.freeze(this.calls.flatMap((call) => call.receipt === null ? [] : [call.receipt]));
    this.reservationRevocations = Object.freeze(this.calls.flatMap((call) => call.revocation === null ? [] : [call.revocation]));
    this.nonExecution = this.calls.length === 0 ? new ProcessExecutionNonExecutionEvidence({
      checkoutIdentity, binding, invocation, inventoryDigest: this.#snapshotDigest,
      ownerEpoch: inventory.ownerEpoch, executions: revocations,
    }) : null;
    this.#summary = { schemaVersion: 3, checkoutIdentity: checkoutIdentity.toJSON(), binding: binding.toJSON(), invocation: this.#invocation.toJSON(),
      inventoryDigest: this.#snapshotDigest, ownerEpoch: inventory.ownerEpoch,
      calls: this.calls.map((call) => call.toJSON()), nonExecution: this.nonExecution?.toJSON() ?? null };
    this.digest = digest(this.#summary);
    this.id = this.digest;
    Object.freeze(this);
  }
  assertCurrent() {
    if (!this.#active) fail("recovery-authority-expired", "Physical recovery evidence is outside its checkout exclusion");
    if (digest(this.#readCurrent()) !== this.#snapshotDigest) fail("recovery-evidence-changed", "Physical runtime inventory changed before recovery authorization");
    return this;
  }
  assertBinding(binding) {
    this.assertCurrent();
    if (!this.#binding.matches(new ProcessExecutionBinding(binding))) fail("recovery-binding-mismatch", "Physical recovery evidence belongs to another semantic execution");
    return this;
  }
  forBinding(binding) {
    this.assertCurrent();
    const expected = new ProcessExecutionBinding(binding);
    if (!expected.includes(this.#binding)) fail("recovery-binding-mismatch", "Physical recovery evidence cannot expand its observed semantic execution");
    return new ProcessExecutionRecoveryEvidence({ checkoutIdentity: this.checkoutIdentity, binding: expected,
      invocation: this.#invocation,
      inventory: this.#inventory, revocations: this.#revocations, authority: recoveryEvidenceAuthority,
      readCurrent: () => { this.assertCurrent(); return this.#inventory; } });
  }
  forInvocation(invocation) {
    this.assertCurrent();
    const expected = new ProcessExecutionBinding(invocation);
    if (expected.value === null || Object.keys(expected.value).length === 0
      || this.#invocation.value !== null && !expected.includes(this.#invocation)) {
      fail("recovery-binding-mismatch", "Physical recovery evidence requires a bounded invocation within its observed execution");
    }
    return new ProcessExecutionRecoveryEvidence({ checkoutIdentity: this.checkoutIdentity, binding: this.#binding,
      invocation: expected, inventory: this.#inventory, revocations: this.#revocations, authority: recoveryEvidenceAuthority,
      readCurrent: () => { this.assertCurrent(); return this.#inventory; } });
  }
  toJSON() { return { ...json(this.#summary), id: this.id, digest: this.digest }; }
  invalidate() { this.#active = false; }
}

export class ProcessExecutionHistoricalInventory {
  #inventory;
  #executions;
  constructor(inventory, { runId, specId } = {}) {
    this.#inventory = json(inventory);
    this.checkoutIdentity = new ProcessExecutionCheckoutIdentity(inventory.checkout);
    this.#executions = this.#inventory.executions.filter((execution) => (runId === undefined || execution.runId === runId)
      && (specId === undefined || execution.specId === specId));
    this.digest = digest({ inventory: this.#inventory, executions: this.#executions });
    Object.freeze(this);
  }
  get inventory() { return json(this.#inventory); }
  get executions() { return json(this.#executions); }
  toJSON() { return { checkoutIdentity: this.checkoutIdentity.toJSON(), inventory: this.inventory,
    executions: this.executions, digest: this.digest }; }
}

/** A producer must publish its required evidence before a call becomes durable. */
export class ProcessExecutionCallAdmission {
  #admit;
  constructor({ admit }) {
    if (typeof admit !== "function") throw new TypeError("Process call admission requires a synchronous producer");
    this.#admit = admit;
    Object.freeze(this);
  }
  admit({ runtime, binding }) {
    try {
      const result = this.#admit({ runtime, binding });
      if (result?.then !== undefined) throw new TypeError("Process call admission must complete synchronously");
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("admission-failed", "Managed execution producer admission was refused", {
        cause, executionId: runtime.executionId });
    }
  }
}


/** The bounded public view needed to construct one authenticated client. */
class ProcessExecutionClientView {
  constructor({ executionId, ownerEpoch, coordinatorIdentity, runId, specId, binding, parentBinding }) {
    this.executionId = uuid(executionId, "Client execution ID");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Client owner epoch is invalid");
    for (const value of [runId, specId]) if (value !== null && (typeof value !== "string" || value === "")) throw new TypeError("Client semantic identity is invalid");
    this.ownerEpoch = ownerEpoch;
    this.coordinatorIdentity = new LockOwnerSession(coordinatorIdentity);
    this.runId = runId; this.specId = specId;
    this.binding = new ProcessExecutionBinding(binding);
    this.parentBinding = new ProcessExecutionBinding(parentBinding);
    Object.freeze(this);
  }
  static fromRoot(root, parent) {
    return new ProcessExecutionClientView({ executionId: root.executionId, ownerEpoch: root.ownerEpoch,
      coordinatorIdentity: root.coordinatorIdentity, runId: root.runId, specId: root.specId,
      binding: root.binding, parentBinding: parent?.binding ?? null });
  }
  toJSON() { return { executionId: this.executionId, ownerEpoch: this.ownerEpoch, coordinatorIdentity: this.coordinatorIdentity.toJSON(),
    runId: this.runId, specId: this.specId, binding: this.binding.toJSON(), parentBinding: this.parentBinding.toJSON() }; }
  static fromStored(value) { return exact(value, new ProcessExecutionClientView(value)); }
}

function requestAuthorizationDigest(message) {
  return digest({ executionId: message.executionId, callId: message.callId,
    ownerToken: message.ownerToken, capability: message.capability });
}

/** One executing request; its acceptance identity never grants new authority. */
class PendingCoordinatorRequest {
  constructor(message) {
    this.acceptance = new RuntimeRequestRecord({ requestId: message.requestId, operation: message.operation,
      payloadDigest: message.payloadDigest, authorizationDigest: requestAuthorizationDigest(message), response: null });
  }
  assertMatches(message) {
    if (this.acceptance.operation !== message.operation || this.acceptance.payloadDigest !== message.payloadDigest
      || this.acceptance.authorizationDigest !== requestAuthorizationDigest(message)) {
      fail("request-mismatch", "Pending request ID was reused with different content or authority");
    }
  }
}

/** An unaccepted authentication awaiting its actual parent's durable start. */
class ParentStartPublication extends PendingCoordinatorRequest {
  #listeners = new Set();
  #disposed = false;
  constructor(message) {
    super(message);
    this.executionId = message.executionId;
    this.callId = message.callId;
    this.deadline = managedMonotonicNow() + new ManagedControlPolicy().budgetMs;
    this.#armDeadline();
  }
  #armDeadline() {
    if (this.#disposed) return;
    const remaining = this.deadline - managedMonotonicNow();
    if (remaining <= 0) { this.wake(); return; }
    this.timer = setTimeout(() => this.#armDeadline(), Math.max(1, Math.ceil(remaining)));
  }
  get expired() { return managedMonotonicNow() >= this.deadline; }
  failure() { return new ProcessExecutionControlFailure("endpoint-unavailable", "Parent start publication exceeded its communication budget",
    { executionId: this.executionId, callId: this.callId }); }
  assertLive() {
    if (this.expired) throw this.failure();
  }
  subscribe(listener) { this.#listeners.add(listener); }
  unsubscribe(listener) { this.#listeners.delete(listener); }
  wake() { for (const listener of this.#listeners) listener(); }
  dispose() { this.#disposed = true; clearTimeout(this.timer); this.#listeners.clear(); }
}

/** Sole mutable registry owner, running in the independently scheduled control child. */
export class ProcessExecutionCoordinator {
  #pendingRequests = new Map();
  constructor({ mainRoot, executionRoot = mainRoot, runId = null, specId = null, binding = null, endpoint, mode = "execution", storage = null, publishResponse }) {
    if (typeof publishResponse !== "function") throw new TypeError("Coordinator requires its owned response publication port");
    new ProcessExecutionControlEndpoint(endpoint).assertCheckout(executionRoot).assertStorage();
    this.publishResponse = publishResponse;
    this.store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: mode !== "recovery", storagePolicy: storage === null ? null : ReadOnlyProcessRuntimeStorage.fromGrant(storage) });
    try { this.store.ownerLock.acquire(); }
    catch (cause) { fail(cause.lockStatus === "busy" ? "busy" : "ownership-unknown", "Checkout ownership has no transferable registered-child authority", { cause }); }
    this.closed = false;
    this.handoff = false;
    this.released = false;
    this.nextTickAt = Infinity;
    let admitted = false;
    try {
      this.store.admission.acquire(); admitted = true;
      if (mode === "recovery") {
        const inventory = this.store.readInventory();
        if (inventory.ownerEpoch === 0) fail("record-missing", "Physical recovery has no prior execution authority");
        if (inventory.slot !== null || inventory.executions.some((record) => record.calls.some((call) => callCompletion(call) === null))) fail("stop-unconfirmed", "Recovery cannot invent receipts for unfinished registered children");
        this.recoveryRoot = { executionId: crypto.randomUUID(), ownerEpoch: inventory.ownerEpoch,
          coordinatorIdentity: new LockOwnerSession({ ownerToken: this.store.ownerLock.ownerToken, ownerSession: this.store.ownerLock.ownerSession }),
          rootCapability: crypto.randomUUID(), endpoint, runId, specId, binding: new ProcessExecutionBinding(binding), calls: [] };
        this.executionId = this.recoveryRoot.executionId;
        this.grant = this.#grant(this.recoveryRoot);
        return;
      }
      this.store.initialize();
      this.store.archiveClosed();
      const registry = this.store.read();
      if (registry.slot !== null) fail("ownership-unknown", "An unfinished coordinator has no transferable ChildProcess exit proof; retain its evidence");
      const root = new RootExecutionRecord({ executionId: crypto.randomUUID(), ownerEpoch: registry.ownerEpoch + 1,
        coordinatorIdentity: { ownerToken: this.store.ownerLock.ownerToken, ownerSession: this.store.ownerLock.ownerSession },
        rootCapability: crypto.randomUUID(), endpoint, runId, specId, binding: json(new ProcessExecutionBinding(binding)),
        accepting: true, status: "active", hostConnected: true, calls: [], closure: null,
        requests: [], events: [], eventAcknowledgements: [], runtimeOnlyDispositions: [], recoveryFence: null, finalizationFences: [] });
      registry.ownerEpoch = root.ownerEpoch; registry.slot = root.executionId; registry.executions.push(root);
      this.store.save(registry);
      this.executionId = root.executionId;
      this.grant = this.#grant(root);
    } catch (cause) {
      try { this.store.ownerLock.release(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "Coordinator admission and ownership cleanup failed", { cause }); }
      throw cause;
    } finally { if (admitted) this.store.admission.release(); }
  }
  #grant(root, parent = null) {
    return new ProcessExecutionGrant({ version: 3, mainRoot: this.store.checkout.mainRoot, executionRoot: this.store.checkout.executionRoot,
      executionId: root.executionId, callId: parent?.callId ?? root.executionId,
      ownerEpoch: root.ownerEpoch, ownerToken: root.coordinatorIdentity.ownerToken, ownerSession: root.coordinatorIdentity.ownerSession,
      runId: root.runId, specId: root.specId, capability: parent?.capability ?? root.rootCapability,
      bindingDigest: (parent?.binding ?? root.binding).digest, executor: parent?.executor ?? null, runtimeRevision: currentRuntimePackage().revision, controlResponseDeadlinesMs: new ManagedControlPolicy().responseDeadlinesMs,
      storage: this.store.storagePolicy?.toJSON() ?? null, endpoint: root.endpoint }).toJSON();
  }
  #root(registry) {
    const root = registry.executions.find((entry) => entry.executionId === this.executionId);
    if (!root || !this.store.ownerLock.isOwnerCurrent(root.coordinatorIdentity)) fail("ownership-changed", "Coordinator token/session no longer owns the checkout exclusion");
    return root;
  }
  #assertRetainedClosure(registry, root) {
    if (registry.slot !== null || root.status !== "closed" || root.ownerEpoch !== this.grant.ownerEpoch
      || root.calls.some((call) => callCompletion(call) === null)) {
      fail("stop-unconfirmed", "Retained owner release requires its exact complete sealed execution");
    }
  }
  #authenticate(root, message) {
    const grant = new ProcessExecutionGrant(message.payload.grant);
    if (!grant || grant.version !== 3 || grant.runtimeRevision !== currentRuntimePackage().revision || grant.mainRoot !== this.store.checkout.mainRoot || grant.executionRoot !== this.store.checkout.executionRoot
      || grant.executionId !== root.executionId || message.executionId !== root.executionId
      || grant.ownerEpoch !== root.ownerEpoch || grant.ownerToken !== root.coordinatorIdentity.ownerToken || message.ownerToken !== grant.ownerToken
      || grant.ownerSession !== root.coordinatorIdentity.ownerSession || grant.callId !== message.callId || grant.capability !== message.capability
      || !isDeepStrictEqual(grant.endpoint, root.endpoint) || !isDeepStrictEqual(grant.controlResponseDeadlinesMs, new ManagedControlPolicy().responseDeadlinesMs) || !isDeepStrictEqual(grant.storage, this.store.storagePolicy?.toJSON() ?? null)) fail("delegation-refused", "Coordinator grant does not match its checkout, epoch and owner session");
    let parent = null;
    if (grant.callId === root.executionId) {
      if (grant.capability !== root.rootCapability) fail("delegation-refused", "Root client capability is invalid");
      // The immutable root binding may be refined only in child scope payloads.
      if (grant.bindingDigest !== root.binding.digest) fail("binding-mismatch", "Root client binding digest is invalid");
    } else {
      parent = root.calls.find((entry) => entry.callId === grant.callId);
      if (!parent || grant.capability !== parent.capability || grant.bindingDigest !== parent.binding.digest
        || grant.runId !== root.runId || grant.specId !== root.specId
        || grant.executor === null || parent.executor === null || !grant.executor.matches(parent.executor)) fail("delegation-refused", "Borrowed grant does not match its registered parent and semantic binding");
    }
    return parent;
  }
  #admit(root, parent, { waitForStart = false } = {}) {
    if (!root.accepting || root.status !== "active" || root.recoveryFence !== null || !root.hostConnected) fail("registration-closed", "Coordinator admission is fenced");
    if (parent && (!parent.accepting || parent.status !== "running")) {
      if (waitForStart && parent.accepting && parent.status === "claimed" && parent.permit !== null
        && parent.observation === null && parent.stopOperation === null) return false;
      fail("delegation-refused", "Parent child exit or stop closed nested admission");
    }
    return true;
  }
  #call(root, target, parent) {
    const call = root.calls.find((entry) => entry.callId === target?.callId);
    if (!call || target.capability !== call.capability || target.bindingDigest !== call.binding.digest) fail("binding-mismatch", "Target call capability or binding differs from its reservation");
    if (parent !== null && call.parentCallId !== parent.callId) fail("delegation-refused", "Borrowed client does not own this physical call");
    return call;
  }
  #executor(call, value) {
    const executor = value instanceof ProcessExecutorIdentity ? value : ProcessExecutorIdentity.fromStored(value);
    if (call.executor === null || !call.executor.matches(executor)) fail("executor-mismatch", "Only the exact ChildProcess handle owner may report or control this call");
    return executor;
  }
  #event(root, call, type, payload = {}) {
    let ancestor = call;
    while (ancestor.parentCallId !== null) ancestor = root.calls.find((entry) => entry.callId === ancestor.parentCallId);
    root.events.push(new ProcessExecutionEvent({ eventId: crypto.randomUUID(), executionId: root.executionId,
      callId: call.callId, parentCallId: call.parentCallId, rootCallId: ancestor.callId, sequence: root.events.length + 1,
      type, binding: call.binding, occurredAt: new Date().toISOString(), payload }));
  }
  #beginStop(root, call, { reason = "abort", graceMs } = {}) {
    const ordered = [...descendantsOf(root, call).reverse(), call];
    for (const entry of ordered) {
      entry.accepting = false;
      if (callCompletion(entry) !== null) continue;
      const stopStore = new ManagedStopOperationStore(this.store.callContext(root, entry));
      const proposed = entry.stopOperation ?? ManagedStopOperation.begin({ reason, graceMs: graceMs ?? entry.graceMs });
      const operation = stopStore.claim(proposed);
      operation.remainingMs(); // The durable first decision must belong to this clock session.
      if (entry.stopOperation !== null) {
        if (!isDeepStrictEqual(entry.stopOperation.toJSON(), operation.toJSON())) fail("authority-mismatch", "Registry stop decision differs from its durable stop authority");
        continue;
      }
      entry.stopOperation = operation;
      if (["abort", "aborted", "host-disconnected"].includes(reason)) entry.aborted = true;
      this.#event(root, entry, "stop-requested", { reason, graceMs: entry.stopOperation.graceMs });
    }
    return call.stopOperation;
  }
  #refreshTimeout(root, call, prepareStopRoot = null) {
    if (callCompletion(call) === null && call.observation === null && call.timeoutMs !== null && call.startedMonotonic !== null
      && managedMonotonicNow() >= call.startedMonotonic + call.timeoutMs) {
      const stopRoot = prepareStopRoot === null ? root : prepareStopRoot();
      const stopCall = stopRoot === root ? call : stopRoot.calls.find((entry) => entry.callId === call.callId);
      this.#beginStop(stopRoot, stopCall, { reason: "timeout" });
      return stopRoot;
    }
    return root;
  }
  #scheduleTick(root) {
    // This process is the sole writer. Its committed root determines the next
    // timer transition; idle timers need neither a disk scan nor a writer lock.
    let next = Infinity;
    const unconfirmed = new Set(root.events.filter((event) => event.type === "stop-unconfirmed").map((event) => event.callId));
    for (const call of root.calls) {
      if (callCompletion(call) !== null) continue;
      if (call.stopOperation !== null) {
        call.stopOperation.remainingMs(); // Validate this coordinator's clock session.
        if (!unconfirmed.has(call.callId)) next = Math.min(next, call.stopOperation.deadline);
      } else if (call.observation === null && call.timeoutMs !== null && call.startedMonotonic !== null) {
        next = Math.min(next, call.startedMonotonic + call.timeoutMs);
      }
    }
    this.nextTickAt = next;
  }
  #finishRelease(response, store = null) {
    this.released = false;
    // TCP may lose its final acknowledgement. The same authenticated response
    // must remain readable by mailbox fallback after this actual owner exits.
    this.publishResponse(response);
    store?.archiveClosed();
    this.store.ownerLock.release();
    this.released = true;
  }
  #notifyStartPublication(root) {
    for (const pending of this.#pendingRequests.values()) {
      if (!(pending instanceof ParentStartPublication)) continue;
      const parent = root.calls.find((call) => call.callId === pending.callId);
      try { if (parent === undefined || this.#admit(root, parent, { waitForStart: true })) pending.wake(); }
      catch { pending.wake(); } // Wakeup conveys no permission; handle rechecks.
    }
  }
  #wakePendingStarts() {
    for (const pending of this.#pendingRequests.values()) if (pending instanceof ParentStartPublication) pending.wake();
  }
  /** TCP and mailbox share this one durable acceptance and mutation boundary. */
  async handle(message) {
    message = ManagedProcessMessage.from(json(message));
    message.assertPayload();
    const existing = this.#pendingRequests.get(message.requestId);
    if (existing !== undefined) { existing.assertMatches(message); return existing.response; }
    const waitsForParent = message.operation === "authenticate" && message.callId !== message.executionId && !this.recoveryRoot;
    const pending = waitsForParent ? new ParentStartPublication(message) : new PendingCoordinatorRequest(message);
    this.#pendingRequests.set(message.requestId, pending);
    const response = waitsForParent ? this.#authenticateAfterStart(message, pending) : this.#handleOnce(message);
    pending.response = response.finally(() => {
      if (pending instanceof ParentStartPublication) pending.dispose();
      // Only an expired parent-start operation retains its original deadline tombstone.
      // Ordinary responses never survive settlement in this in-flight registry.
      if (!(pending instanceof ParentStartPublication) || !pending.expired) this.#pendingRequests.delete(message.requestId);
    });
    return pending.response;
  }
  async #authenticateAfterStart(message, pending) {
    while (true) {
      let wake;
      const changed = new Promise((resolve) => { wake = resolve; pending.subscribe(wake); });
      try {
        pending.assertLive();
        const response = await this.#handleOnce(message, pending);
        pending.assertLive();
        if (response !== pending) return response;
        await changed;
      } finally { pending.unsubscribe(wake); }
    }
  }
  async #handleOnce(message, pending = null) {
    const authorizationDigest = requestAuthorizationDigest(message);
    if (this.recoveryRoot) {
      if (!this.store.ownerLock.isOwnerCurrent(this.recoveryRoot.coordinatorIdentity)) fail("ownership-changed", "Recovery owner capability changed");
      this.#authenticate(this.recoveryRoot, message);
      if (message.operation !== "release-recovery") fail("delegation-refused", "Read-only recovery authority grants no execution or registry mutation");
      const file = this.store.requestFile(this.executionId, message.requestId);
      const saved = readRuntimeRequest(file);
      if (saved !== null && (saved.operation !== message.operation || saved.payloadDigest !== message.payloadDigest || saved.authorizationDigest !== authorizationDigest)) fail("request-mismatch", "A durable recovery request ID was reused with different content or authority");
      if (saved?.response === null) fail("request-unconfirmed", "Recovery release has no confirmed durable response");
      const result = saved?.response ?? { ok: true, value: null };
      if (saved === null) file.write(encodeRuntimeRecord(new RuntimeRequestRecord({ requestId: message.requestId,
        operation: message.operation, payloadDigest: message.payloadDigest, authorizationDigest, response: result })), { exclusive: true });
      const response = message.respond(result);
      this.#finishRelease(response); this.closed = true;
      return response;
    }
    const retainedClosed = this.closed && this.handoff && message.operation === "release-reservation";
    return this.store.exclusive((store, archiveObservation) => {
      pending?.assertLive();
      const pureRequest = ["authenticate", "events", "runtime-snapshot"].includes(message.operation);
      const readControlRequest = message.operation === "read-control";
      const outputTransferRequest = message.operation === "persist-call-output";
      const observationRequest = message.operation === "observe";
      const eventPublicationRequest = ["ack-events", "dispose-runtime-events"].includes(message.operation);
      const immutableRequest = pureRequest || readControlRequest || outputTransferRequest || observationRequest || eventPublicationRequest;
      let registry = store.read({ archiveObservation, immutable: immutableRequest });
      const root = this.#root(registry);
      if (retainedClosed) this.#assertRetainedClosure(registry, root);
      const parent = this.#authenticate(root, message);
      // Query branches project this freshly validated immutable registry.
      // Observation and publication effects detach below; read-control detaches
      // only when its timeout refresh needs to commit stop facts.
      const usesRequestLedger = pureRequest || readControlRequest || outputTransferRequest || observationRequest || eventPublicationRequest;
      const ledger = store.requestFile(root.executionId, message.requestId);
      const prior = root.requests.find((entry) => entry.requestId === message.requestId) ?? readRuntimeRequest(ledger);
      if (prior) {
        if (prior.operation !== message.operation || prior.payloadDigest !== message.payloadDigest || prior.authorizationDigest !== authorizationDigest) fail("request-mismatch", "A durable request ID was reused with different operation, content or authority");
        if (prior.response === null) fail("request-unconfirmed", "Request acceptance survived without confirmed completion; the effect cannot be replayed");
        const response = message.respond(prior.response);
        if (prior.response.ok && ["release-root", "release-reservation"].includes(message.operation)) this.#finishRelease(response, store);
        return response;
      }
      // New requests authenticate their target before durable acceptance. Exact
      // completed replays above retain their original request identity and result.
      // Dispatch resolves the same target in its detached working registry.
      if (["revoke-reservation", "claim-launch", "observe", "read-control", "begin-stop",
        "persist-call-output", "finish", "failure"].includes(message.operation)) this.#call(root, message.payload.data?.call, parent);
      // A claimed launch is not running authority. Await the actual executor's
      // committed start without recording a permanent refusal or holding a lock.
      if (message.operation === "authenticate" && message.payload.data?.binding !== undefined && parent !== null
        && !new ProcessExecutionBinding(message.payload.data.binding).matches(parent.binding)) fail("binding-mismatch", "Borrowed scope differs from its exact parent binding");
      if (pending !== null && !this.#admit(root, parent, { waitForStart: true })) return pending;
      pending?.assertLive();
      const request = new RuntimeRequestRecord({ requestId: message.requestId, operation: message.operation,
        payloadDigest: message.payloadDigest, authorizationDigest, response: null });
      const requestEffectRegistry = outputTransferRequest || observationRequest ? registry : null;
      const requestEffectBaseline = requestEffectRegistry === null ? null : new ProcessExecutionValueEncoding(requestEffectRegistry);
      const assertRequestEffectRegistry = requestEffectRegistry === null ? null : () => {
        const freshRegistry = store.read({ archiveObservation, immutable: true });
        const freshRoot = this.#root(freshRegistry);
        const freshParent = this.#authenticate(freshRoot, message);
        this.#call(freshRoot, message.payload.data?.call, freshParent);
        // Identity here proves an immutable graph recaptured from the exact
        // same physical bytes, after all fresh authority/inventory checks.
        if (freshRegistry === requestEffectRegistry) return;
        const fresh = new ProcessExecutionValueEncoding(freshRegistry);
        if (fresh.text() !== requestEffectBaseline.text()
          && !isDeepStrictEqual(JSON.parse(requestEffectBaseline.text()), JSON.parse(fresh.text()))) {
          fail("authority-mismatch", outputTransferRequest ? "Runtime registry changed during output transfer"
            : "Runtime registry changed during observation", { executionId: root.executionId });
        }
      };
      let workingRegistry = registry;
      if (usesRequestLedger) ledger.write(encodeRuntimeRecord(request), { exclusive: true });
      else {
        root.requests.push(request);
        // save returns a detached validated graph; retain the pending original for rollback.
        workingRegistry = store.save(registry, { archiveObservation });
      }
      // Preserve fresh authority and inventory checks around accepted effects.
      // Observation completion remains inline with its facts in the final full save.
      assertRequestEffectRegistry?.();
      if (observationRequest) workingRegistry = registry.mutableCopy(runtimeRegistryObservationAuthority);
      // Acceptance is durable before effects. Queries, control, output-transfer,
      // observation and event-publication requests use the ledger. Observation
      // leaves that pending record as evidence; its completed inline record wins
      // exact replay only after the effect and response are published together.
      const beforeEventPublications = eventPublicationRequest ? registry.eventPublicationCount() : null;
      const beforeControlEvents = readControlRequest ? root.events.length : null;
      const beforeControlAccepting = readControlRequest
        ? root.calls.reduce((count, call) => count + Number(call.accepting), 0) : null;
      let result;
      let working = this.#root(workingRegistry);
      const state = { closed: this.closed, handoff: this.handoff, released: this.released };
      let registryPreparationFailed = false;
      const prepareWorkingRegistry = readControlRequest || eventPublicationRequest ? () => {
        try {
          workingRegistry = registry.mutableCopy(runtimeRegistryObservationAuthority);
          working = this.#root(workingRegistry);
          return working;
        } catch (cause) {
          registryPreparationFailed = true;
          throw cause;
        }
      } : null;
      // Publication changes only staged metadata; preparation failure leaves its
      // accepted request pending, outside the durable dispatch-refusal boundary.
      if (eventPublicationRequest) prepareWorkingRegistry();
      let committedRoot = root;
      try {
        result = { ok: true, value: json(this.#dispatch(working,
          parent === null ? null : working.calls.find((entry) => entry.callId === parent.callId), message.operation, message.payload.data ?? {}, workingRegistry, archiveObservation, prepareWorkingRegistry)) };
        committedRoot = working;
        registry = workingRegistry;
      }
      catch (cause) {
        // Preparation previously happened outside this effect/failure boundary.
        if (registryPreparationFailed) throw cause;
        Object.assign(this, state);
        const failure = cause instanceof ProcessExecutionControlFailure ? cause
          : new ProcessExecutionControlFailure("control-failed", cause.message, { cause, executionId: root.executionId });
        result = { ok: false, error: failure.toJSON() };
      }
      assertRequestEffectRegistry?.();
      request.response = result;
      if (observationRequest) {
        // A rejected dispatch retained the immutable baseline, not its staged
        // mutations. Detach that baseline before publishing the exact refusal.
        if (registry === requestEffectRegistry) registry = registry.mutableCopy(runtimeRegistryObservationAuthority);
        committedRoot = this.#root(registry);
        committedRoot.requests.push(request);
      } else if (!usesRequestLedger) committedRoot.requests.find((entry) => entry.requestId === request.requestId).response = result;
      if (message.operation === "reserve" && result.ok) {
        try { encodeRuntimeRecord(registry); }
        catch (cause) {
          if (!(cause instanceof ProcessExecutionControlFailure) || cause.reason !== "record-capacity") throw cause;
          // Reservation has only staged memory. Preserve its accepted identity
          // and complete the refusal before any call artifact or launch exists.
          registry = store.read({ archiveObservation });
          committedRoot = this.#root(registry);
          Object.assign(this, state);
          result = { ok: false, error: cause.toJSON() };
          request.response = result;
          committedRoot.requests.find((entry) => entry.requestId === request.requestId).response = result;
        }
      }
      if (committedRoot.status === "closed" && registry.slot !== null) registry.slot = null;
      if (!usesRequestLedger || observationRequest || readControlRequest && (committedRoot.events.length !== beforeControlEvents
        || committedRoot.calls.reduce((count, call) => count + Number(call.accepting), 0) !== beforeControlAccepting)
        || eventPublicationRequest && registry.eventPublicationCount() !== beforeEventPublications) {
        store.save(registry, { archiveObservation });
      }
      if (usesRequestLedger && !observationRequest) ledger.write(encodeRuntimeRecord(request));
      this.#scheduleTick(committedRoot);
      const response = message.respond(result);
      if (this.released) this.#finishRelease(response, store);
      this.#notifyStartPublication(committedRoot);
      return response;
    }, { deadline: pending?.deadline ?? Infinity, deadlineFailure: pending === null ? undefined : () => pending.failure(), retainedClosed })
      .catch((cause) => { this.#wakePendingStarts(); throw cause; });
  }
  #dispatch(root, parent, operation, data, registry, archiveObservation, prepareControlRegistry = null) {
    switch (operation) {
      case "runtime-snapshot":
        if (!root.accepting || root.status !== "active" || !root.hostConnected || root.recoveryFence !== null
          || parent !== null && (!parent.accepting || !["claimed", "running"].includes(parent.status) || parent.permit === null || parent.observation !== null)) fail("registration-closed", "Runtime code proof is outside its permitted child launch");
        return currentRuntimeWireDelivery();
      case "authenticate":
        this.#admit(root, parent);
        return { grant: this.#grant(root, parent), record: ProcessExecutionClientView.fromRoot(root, parent).toJSON(), checkout: this.store.checkout.toJSON() };
      case "bind": {
        this.#admit(root, parent);
        const binding = new ProcessExecutionBinding(data.binding);
        if (parent !== null && !binding.matches(parent.binding)) fail("delegation-refused", "Borrowed scope cannot replace its execution binding");
        const runId = binding.value?.runId ?? root.runId, specId = binding.value?.specId ?? root.specId;
        if ((root.runId !== null && runId !== root.runId) || (root.specId !== null && specId !== root.specId)) fail("binding-mismatch", "Fresh binding belongs to another run or specification");
        root.runId = runId; root.specId = specId;
        return { runId, specId, grant: this.#grant(root, parent) };
      }
      case "reserve": {
        this.#admit(root, parent);
        const binding = new ProcessExecutionBinding(data.binding);
        if (parent !== null && !binding.matches(parent.binding)) fail("delegation-refused", "Nested call cannot replace its delegated binding");
        if ([...this.store.readArchives(archiveObservation), ...registry.executions].some((execution) => execution.finalizationFences.some((fence) => fence.selection.matches(binding)))) fail("registration-closed", "Finalized binding admission is permanently fenced");
        const call = new PhysicalCallRecord({ callId: crypto.randomUUID(), parentCallId: parent?.callId ?? null,
          binding: binding.toJSON(), invocation: data.invocation ?? null, capability: crypto.randomUUID(), status: "intent",
          executor: null, permit: null, observation: null, output: null, receipt: null, revocation: null, outcome: null, controlFailure: null,
          stopOperation: null, accepting: true, timeoutMs: data.timeoutMs ?? null, graceMs: data.graceMs, startedAt: null, startedMonotonic: null, aborted: false });
        root.calls.push(call);
        this.#event(root, call, "reserved", ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON());
        return json(call);
      }
      case "revoke-reservation": {
        const call = this.#call(root, data.call, parent);
        const reason = data.reason ?? "cancelled-before-launch";
        if (call.revocation !== null) {
          if (call.revocation.reason !== reason) fail("revocation-mismatch", "A revoked reservation cannot change its original reason");
          return call.revocation;
        }
        if (call.status !== "intent" || call.executor !== null || call.permit !== null) fail("revocation-refused", "Only an unclaimed reservation can be revoked without a child exit observation");
        call.revocation = new ProcessExecutionReservationRevocation({ schemaVersion: 2, scope: "unlaunched-reservation",
          executionId: root.executionId, callId: call.callId, ownerEpoch: root.ownerEpoch, checkoutIdentity: this.store.checkout,
          binding: call.binding, ...ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON(), closureRevision: root.events.length + 1, reason, stopOperation: call.stopOperation });
        call.status = "revoked"; call.accepting = false;
        this.#event(root, call, "result-finalized", { ...ProcessExecutionCallClosure.fromFact(call.revocation).toJSON(), completion: "revoked-before-launch" });
        return call.revocation;
      }
      case "claim-launch": {
        this.#admit(root, parent);
        const call = this.#call(root, data.call, parent);
        if (call.status !== "intent" || call.executor !== null || call.stopOperation !== null || !call.accepting) fail("start-refused", "A reserved call permits one launch claim only");
        call.executor = ProcessExecutorIdentity.fromStored(data.executor);
        call.permit = new ProcessExecutionStartPermit({ executionId: root.executionId, callId: call.callId,
          ownerEpoch: root.ownerEpoch, ownerToken: root.coordinatorIdentity.ownerToken, capability: call.capability, bindingDigest: call.binding.digest });
        call.status = "claimed";
        return call.permit;
      }
      case "observe": {
        const call = this.#call(root, data.call, parent);
        if (data.type === "started") {
          this.#executor(call, data.executor);
          if (call.status !== "claimed") fail("observation-mismatch", "Start observation requires its claimed launch");
          if (typeof data.startedAt !== "string" || new Date(data.startedAt).toISOString() !== data.startedAt) throw new TypeError("Started observation requires ISO time");
          call.status = "running"; call.startedAt = data.startedAt; call.startedMonotonic = managedMonotonicNow();
          this.#event(root, call, "started", { startedAt: data.startedAt });
        } else if (data.type === "exit") {
          const observation = ChildExitObservation.fromStored(data.observation);
          this.#executor(call, observation.executor);
          if (call.observation !== null && !isDeepStrictEqual(json(call.observation), json(observation))) fail("observation-mismatch", "A recorded child exit cannot be replaced");
          if (call.observation === null) {
            if (!["claimed", "running"].includes(call.status)) fail("observation-mismatch", "Child exit requires its launch claim");
            call.observation = observation; call.status = "exited"; call.accepting = false;
            this.#event(root, call, observation.kind === "spawn-failed" ? "spawn-failed" : "exited", observation.toJSON());
            for (const descendant of descendantsOf(root, call).filter((entry) => entry.parentCallId === call.callId)) this.#beginStop(root, descendant, { reason: "parent-exit" });
          }
        } else throw new TypeError("Unknown child observation type");
        return { status: call.status };
      }
      case "read-control": {
        let call = this.#call(root, data.call, parent);
        this.#executor(call, data.executor);
        const refreshedRoot = this.#refreshTimeout(root, call, prepareControlRegistry);
        if (refreshedRoot !== root) {
          root = refreshedRoot;
          call = root.calls.find((entry) => entry.callId === call.callId);
        }
        const descendantsSettled = descendantsOf(root, call).every((entry) => callCompletion(entry) !== null);
        const now = managedMonotonicNow();
        const stopRemainingMs = call.stopOperation?.remainingMs(now) ?? null;
        const stopSignal = call.stopOperation === null || !descendantsSettled || call.observation !== null || callCompletion(call) !== null
          ? null : now < call.stopOperation.startedAt + call.stopOperation.graceMs ? "SIGTERM" : "SIGKILL";
        return { stopSignal,
          stopRequested: call.stopOperation !== null, stopRemainingMs,
          timedOut: call.stopOperation?.reason === "timeout", aborted: call.aborted,
          descendantsSettled, status: call.status, controlFailure: call.controlFailure?.toJSON() ?? null };
      }
      case "begin-stop": {
        const call = this.#call(root, data.call, parent);
        return this.#beginStop(root, call, data);
      }
      case "persist-call-output": {
        const call = this.#call(root, data.call, parent);
        this.#executor(call, data.executor);
        if (!["running", "exited"].includes(call.status) || callCompletion(call) !== null) fail("output-closed", "Output persistence is outside its exact active child execution");
        if (typeof data.bytes !== "string" || data.bytes.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) fail("output-corrupt", "Captured output chunk exceeds its transport bound");
        const bytes = Buffer.from(data.bytes, "base64");
        if (bytes.toString("base64") !== data.bytes) fail("output-corrupt", "Captured output chunk is not canonical base64");
        try {
          return new ManagedOutputSpool(this.store.callContext(root, call), data.stream, data.maximum)
            .persistCapturedChunk({ snapshot: data.snapshot, offset: data.offset, bytes });
        } catch (cause) {
          if (cause instanceof ProcessExecutionControlFailure) throw cause.withContext({ executionId: root.executionId, callId: call.callId });
          throw cause;
        }
      }
      case "finish": {
        const call = this.#call(root, data.call, parent);
        const observation = data.observation instanceof ChildExitObservation ? data.observation : ChildExitObservation.fromStored(data.observation);
        const output = data.output instanceof ProcessOutputState ? data.output : ProcessOutputState.fromStored(data.output);
        this.#executor(call, observation.executor);
        if (call.observation === null || !isDeepStrictEqual(json(call.observation), json(observation))) fail("stop-unconfirmed", "Call finalization requires its prior exact child-exit observation");
        const descendants = descendantsOf(root, call);
        if (descendants.some((entry) => callCompletion(entry) === null)) fail("descendants-pending", "Registered descendants must have exit receipts before parent finalization");
        if (call.receipt !== null) {
          if (!isDeepStrictEqual(json(call.output), json(output)) || digest(call.outcome) !== digest(data.outcome ?? null)) fail("receipt-mismatch", "Finalized result cannot be replaced");
          return call.receipt;
        }
        call.outcome = json(data.outcome ?? null); call.output = output;
        const context = this.store.callContext(root, call);
        const captured = readManagedOutput(context, call.outcome, { sealed: true });
        if (captured.stdout.length !== output.stdoutBytes || captured.stderr.length !== output.stderrBytes) fail("output-mismatch", "Output counters differ from exact captured stream bytes");
        call.receipt = new ProcessExecutionStopReceipt({ schemaVersion: 3, scope: "registered-executions", executionId: root.executionId, callId: call.callId,
          ownerEpoch: root.ownerEpoch, checkoutIdentity: this.store.checkout, binding: call.binding, ...ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON(),
          executor: call.executor, observation, output, closureRevision: root.events.length + 1,
          descendants: descendants.map((entry) => ProcessExecutionCallClosure.fromFact(callCompletion(entry)).toJSON()),
          stopOperation: call.stopOperation, outcomeDigest: digest(call.outcome) });
        writeManagedRecord(context.outcomePath, { schemaVersion: 3, scope: "registered-executions", executionId: root.executionId,
          callId: call.callId, ownerToken: context.ownerToken, capability: call.capability, executor: call.executor.toJSON(),
          observation: observation.toJSON(), state: "finished", outcome: call.outcome, receipt: call.receipt.toJSON() }, { lockAuthority: context.recordLocks });
        call.status = "stopped"; call.accepting = false;
        this.#event(root, call, "result-finalized", { ...ProcessExecutionCallClosure.fromFact(call.receipt).toJSON(), output: output.toJSON(), outcome: call.outcome });
        if (call.controlFailure?.communication) call.controlFailure = call.controlFailure.withStopConfirmation("confirmed");
        return call.receipt;
      }
      case "failure": {
        const call = this.#call(root, data.call, parent);
        const failure = ProcessExecutionControlFailure.fromStored(data.error);
        if (failure.executionId !== null && failure.executionId !== root.executionId
          || failure.callId !== null && failure.callId !== call.callId) fail("binding-mismatch", "Control failure belongs to another physical call");
        call.controlFailure ??= failure.withContext({ executionId: root.executionId, callId: call.callId });
        return call.controlFailure;
      }
      case "delegated-failure": {
        if (parent === null) fail("delegation-refused", "A delegated failure requires its borrowed parent grant");
        parent.controlFailure ??= ProcessExecutionControlFailure.fromStored(data.error).withContext({ executionId: root.executionId, callId: parent.callId });
        return parent.controlFailure;
      }
      case "events": return registry.executions.flatMap((execution) => execution.events.filter((event) =>
        !execution.hasCanonicalAcknowledgement(event.eventId) && !execution.hasRuntimeOnlyDisposition(event.eventId)));
      case "ack-events":
      case "dispose-runtime-events": {
        if (parent !== null) fail("delegation-refused", "Borrowed execution grants carry no canonical publication authority");
        const canonical = operation === "ack-events";
        const publications = data.publications.map((value) => canonical
          ? ProcessExecutionCanonicalAcknowledgement.fromStored(value) : ProcessExecutionRuntimeOnlyDisposition.fromStored(value));
        const targets = publications.map((publication) => {
          const execution = registry.executions.find((entry) => entry.events.some((event) => publication.matches(event)));
          if (execution === undefined) fail("event-mismatch", "Cannot dispose an unknown process event or changed event digest");
          const opposite = canonical ? execution.runtimeOnlyDispositions : execution.eventAcknowledgements;
          if (opposite.some((fact) => fact.eventId === publication.eventId)) fail("event-mismatch", "Process event already has a different publication disposition");
          return { execution, publication };
        });
        for (const { execution, publication } of targets) {
          const facts = canonical ? execution.eventAcknowledgements : execution.runtimeOnlyDispositions;
          if (!facts.some((fact) => fact.eventId === publication.eventId)) facts.push(publication);
        }
        return null;
      }
      case "recovery-begin":
        if (parent !== null || root.calls.some((entry) => callCompletion(entry) === null)) fail("stop-unconfirmed", "Recovery requires held root exclusion and exact receipts for every registered child");
        if (root.recoveryFence !== null) fail("busy", "A recovery evidence consumer already holds its fence");
        root.recoveryFence = crypto.randomUUID(); root.accepting = false;
        return { fence: root.recoveryFence };
      case "recovery-end":
        if (parent !== null || root.recoveryFence !== data.fence) fail("recovery-authority-expired", "Recovery fence belongs to another observer");
        root.recoveryFence = null; root.accepting = root.status === "active" && root.hostConnected;
        return null;
      case "finalization-fence": {
        if (parent !== null) fail("delegation-refused", "Borrowed clients cannot finalize another root's binding inventory");
        const selection = new ProcessExecutionBindingSelection(data.selection);
        let fence = root.finalizationFences.find((entry) => entry.selection.digest === selection.digest);
        if (fence === undefined) {
          fence = new ProcessExecutionFinalizationFence({ fenceId: crypto.randomUUID(), selection: selection.toJSON(), cutoff: null, barrier: null });
          root.finalizationFences.push(fence);
        }
        if (fence.cutoff === null && !root.calls.some((call) => selection.matches(call.binding) && callCompletion(call) === null)) {
          const inventory = finalizationInventory(root, fence);
          fence.cutoff = new ProcessExecutionFinalizationCutoff({ ...inventory, evidenceDigest: digest(inventory) });
        }
        return { ready: fence.cutoff !== null, fenceId: fence.fenceId, cutoff: fence.cutoff };
      }
      case "finalization-confirm": {
        if (parent !== null) fail("delegation-refused", "Borrowed clients cannot confirm root publication");
        const selection = new ProcessExecutionBindingSelection(data.selection);
        const fence = root.finalizationFences.find((entry) => entry.selection.digest === selection.digest);
        if (!fence || fence.fenceId !== data.fenceId || fence.cutoff === null) fail("finalization-pending", "No complete durable selected cutoff belongs to this finalization");
        assertPriorCanonicalPublication([...this.store.readArchives(archiveObservation), ...registry.executions], root, selection);
        if (fence.cutoff.events.some((event) => !root.hasCanonicalAcknowledgement(event.eventId))) fail("activity-pending", "Selected process events still lack durable canonical acknowledgement");
        fence.barrier ??= new ProcessExecutionFinalizationBarrier({ ...fence.cutoff.toJSON(),
          acknowledgementDigest: digest(fence.cutoff.events.map((event) => event.eventId)) });
        return fence.barrier;
      }
      case "close":
      case "seal": {
        if (parent !== null) fail("delegation-refused", "Borrowed clients cannot close root checkout ownership");
        root.accepting = false; root.status = "stopping";
        for (const call of root.calls.filter((entry) => entry.parentCallId === null)) this.#beginStop(root, call, { reason: "root-close" });
        if (root.calls.some((entry) => callCompletion(entry) === null)) return { closed: false,
          controlFailure: root.calls.find((entry) => entry.controlFailure !== null)?.controlFailure.toJSON() ?? null };
        root.status = "closed";
        root.closure = { executionId: root.executionId, ownerEpoch: root.ownerEpoch,
          callClosures: root.calls.map((call) => ProcessExecutionCallClosure.fromFact(callCompletion(call)).toJSON()), recovery: false };
        this.closed = true; this.handoff = operation === "seal";
        return { closed: true };
      }
      case "release-root":
        if (parent !== null || this.handoff || root.status !== "closed") fail("closure-failed", "Root exclusion cannot release before validated closure and drain");
        this.released = true;
        return null;
      case "release-reservation":
        if (parent !== null || !this.handoff || root.status !== "closed") fail("reservation-release-failed", "No sealed root reservation belongs to this grant");
        this.handoff = false; this.closed = true; this.released = true;
        return null;
      default: fail("request-mismatch", `Unknown coordinator operation: ${operation}`);
    }
  }
  async tick() {
    const now = managedMonotonicNow();
    if (this.recoveryRoot || this.closed || this.released || now < this.nextTickAt) return;
    return this.store.exclusive(() => {
      const registry = this.store.read(); const root = this.#root(registry);
      const before = digest(registry);
      for (const call of root.calls) this.#refreshTimeout(root, call);
      for (const call of root.calls.filter((entry) => callCompletion(entry) === null && entry.stopOperation !== null)) {
        if (call.stopOperation.remainingMs() > 0 || root.events.some((event) => event.callId === call.callId && event.type === "stop-unconfirmed")) continue;
        call.accepting = false;
        call.controlFailure ??= new ProcessExecutionControlFailure("stop-unconfirmed", "Registered child has no exact exit receipt at the coordinator stop cutoff", { executionId: root.executionId, callId: call.callId });
        this.#event(root, call, "stop-unconfirmed", { reason: call.stopOperation.reason });
      }
      if (digest(registry) !== before) this.store.save(registry);
      this.#scheduleTick(root);
      this.#notifyStartPublication(root);
    }).catch((cause) => { this.#wakePendingStarts(); throw cause; });
  }
  async hostDisconnected() {
    try {
    if (this.released) return;
    if (this.recoveryRoot) {
      this.store.ownerLock.release(); this.closed = true; this.released = true;
      return;
    }
    const retainedClosed = this.closed && this.handoff;
    await this.store.exclusive((store) => {
      const registry = store.read(); const root = this.#root(registry);
      if (retainedClosed) this.#assertRetainedClosure(registry, root);
      root.hostConnected = false; root.accepting = false;
      if (root.calls.every((call) => callCompletion(call) !== null)) {
        root.status = "closed";
        root.closure = { executionId: root.executionId, ownerEpoch: root.ownerEpoch,
          callClosures: root.calls.map((call) => ProcessExecutionCallClosure.fromFact(callCompletion(call)).toJSON()), recovery: true };
        registry.slot = null;
        store.save(registry);
        this.store.ownerLock.release();
        this.closed = true; this.released = true; this.handoff = false;
        return;
      }
      root.status = "stopping";
      for (const call of root.calls.filter((entry) => entry.parentCallId === null)) this.#beginStop(root, call, { reason: "host-disconnected" });
      store.save(registry);
      this.#scheduleTick(root);
      // Host loss alone is no exit observation. Any incomplete call retains exclusion.

    }, { retainedClosed });
    } finally { this.#wakePendingStarts(); }
  }
}

/** Actual control-child handle retained by the root client until closure. */
class CoordinatorChildControl {
  static async launch(configuration, environment, { workspace = null, execution = null, storagePolicy = null } = {}) {
    const control = new CoordinatorChildControl();
    control.diagnostics = [];
    control.workspace = workspace; control.workspaceExecution = execution;
    // Mailbox replies outlive coordinator exit: a lost terminating TCP reply
    // must still replay from this separately owned control scratch. Keep its
    // authority in the root endpoint; do not clean it on exit or impose a TTL.
    // This is retained protocol evidence, not a pending workspace execution.
    // Retained control directories therefore grow until explicitly cleaned.
    control.endpointWorkspace = ReadOnlyInvocationWorkspace.create();
    const endpointStorage = control.endpointWorkspace.processRuntimeStorage();
    configuration = { ...configuration, endpointStorage: endpointStorage.toJSON() };
    const receivedFailure = (value) => {
      try { return ProcessExecutionControlFailure.fromStored(value); }
      catch (cause) { return new ProcessExecutionControlFailure("response-invalid", "Coordinator returned invalid typed failure evidence", { cause }); }
    };
    const { RuntimeChildExecution } = await import("./runtime-package.js");
    let acceptReady, rejectReady;
    const ready = new Promise((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    let started = false;
    const timeout = setTimeout(() => rejectReady(new ProcessExecutionControlFailure("admission-failed", "Coordinator did not acknowledge its finite startup window")), 30000);
    const ownedEnvironment = { ...environment };
    delete ownedEnvironment[PROCESS_EXECUTION_SCOPE_ENV];
    control.completion = RuntimeChildExecution.runAsync(fileURLToPath(new URL("./execution-coordinator.js", import.meta.url)), [],
      { repositoryRoot: configuration.mainRoot, cwd: configuration.executionRoot, env: ownedEnvironment,
        stdio: ["ignore", "ignore", "ignore", "ipc"], storagePolicy },
      (_command, args, options, delivery) => new Promise((resolve, reject) => {
        const child = delivery.spawnNode(args[0], args.slice(1), options);
        control.child = child;
        child.once("spawn", () => child.send({ configuration }));
        child.on("message", (message) => {
          if (message?.type === "ready" && !started) {
            started = true; clearTimeout(timeout);
            control.grant = message.grant;
            child.unref(); child.channel?.unref();
            acceptReady({ control, record: message.record, checkout: message.checkout });
          } else if (message?.type === "failed") {
            const error = receivedFailure(message.error);
            rejectReady(error);
          } else if (message?.type === "diagnostic") {
            control.diagnostics.push(receivedFailure(message.error));
            if (control.diagnostics.length > 8) control.diagnostics.shift();
          }
        });
        child.once("error", (cause) => { rejectReady(cause); reject(cause); });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          if (!started) rejectReady(new ProcessExecutionControlFailure("admission-failed", `Coordinator exited before admission (${code ?? signal})`));
          try {
            if (code === 0 && workspace !== null && execution !== null) workspace.settleExecution(execution, { generation: workspace.generation, resourcesReleased: true, normalExit: true });
            resolve({ code, signal });
          } catch (cause) { reject(cause); }
        });
      }));
    control.completion.then((outcome) => { control.exitOutcome = outcome; }, (cause) => { rejectReady(cause); control.failure = cause; });
    try { return await ready; }
    catch (cause) {
      clearTimeout(timeout);
      if (control.child && !started) {
        control.child.ref();
        let terminationFailure = null;
        try { control.child.kill(); } catch (failure) { terminationFailure = failure; }
        try { await control.waitForExit(); }
        catch (failure) {
          if (control.exitOutcome === undefined) terminationFailure ??= failure;
        }
        if (terminationFailure !== null && control.exitOutcome === undefined) {
          cause = new ProcessExecutionControlFailure("admission-failed", cause.message, {
            cause: new AggregateError([cause, terminationFailure], "Coordinator admission failed and actual resource release remains unconfirmed"),
            primaryCause: cause instanceof ProcessExecutionControlFailure ? cause.primaryCause : null,
            diagnostic: cause instanceof ProcessExecutionControlFailure ? cause.diagnostic : null,
            communication: cause instanceof ProcessExecutionControlFailure ? cause.communication : null,
          });
        }
      }
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("admission-failed", `Coordinator startup failed: ${cause.message}`, { cause });
    }
  }
  async waitForExit() {
    if (this.exitOutcome !== undefined) {
      if (this.exitOutcome.code !== 0) fail("closure-failed", "Owned coordinator exited without normal closure", { cause: this.failure });
      return;
    }
    if (this.exitWait !== undefined) return this.exitWait;
    this.child.ref();
    let timeout;
    const budgetMs = new ManagedControlPolicy().budgetMs;
    this.exitWait = Promise.race([this.completion, new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ProcessExecutionControlFailure("closure-failed",
        "Owned coordinator has no actual exit observation at its control cutoff", { cause: this.diagnostics.at(-1) ?? this.failure })), budgetMs);
    })]).then((outcome) => {
      if (outcome.code !== 0) fail("closure-failed", "Owned coordinator exited without normal closure", { cause: this.failure });
    }).catch((cause) => {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("closure-failed", "Owned coordinator closure or resource release could not be confirmed", { cause, executionId: this.grant?.executionId ?? null });
    }).finally(() => {
      clearTimeout(timeout);
      this.child.unref(); this.child.channel?.unref();
    });
    return this.exitWait;
  }
}

export class ProcessExecutionCall {
  constructor(runtime, record) {
    this.runtime = runtime;
    this.executionId = runtime.executionId; this.callId = uuid(record.callId, "callId");
    this.parentCallId = record.parentCallId === null ? null : uuid(record.parentCallId, "parentCallId");
    this.ownerToken = runtime.ownerToken; this.ownerEpoch = runtime.ownerEpoch;
    this.capability = uuid(record.capability, "call capability");
    this.endpoint = runtime.remoteGrant().endpoint;
    this.binding = new ProcessExecutionBinding(record.binding); this.invocation = json(record.invocation);
    this.recordLocks = runtime.store.lockAuthority;
    this.directory = path.join(runtime.store.callsAuthority.directory, this.callId);
    this.outcomePath = path.join(this.directory, "outcome.json");
  }
  authorizeStart(details) { return this.runtime.claimLaunch(this, details); }
  executionEnvironment() {
    return { [PROCESS_EXECUTION_SCOPE_ENV]: JSON.stringify({ ...this.runtime.remoteGrant(),
      callId: this.callId, capability: this.capability, bindingDigest: this.binding.digest, executor: this.executor?.toJSON() ?? null,
      scopeBinding: this.binding.toJSON(),
      runId: this.runtime.runId, specId: this.runtime.specId }) };
  }
  controlTarget() { return { callId: this.callId, capability: this.capability, bindingDigest: this.binding.digest }; }
}

/** Remote handoff exclusion remains owned by its independently scheduled coordinator. */
export class ProcessExecutionOwnershipReservation {
  #runtime;
  #released = false;
  constructor(runtime) {
    if (!(runtime instanceof ProcessExecutionRuntime) || !runtime.closed || runtime.borrowed) throw new TypeError("Checkout handoff requires a sealed owning runtime");
    this.#runtime = runtime;
    this.executionId = runtime.executionId; this.ownerEpoch = runtime.ownerEpoch; this.checkoutIdentity = runtime.checkoutIdentity;
    Object.freeze(this);
  }
  get released() { return this.#released; }
  release() {
    if (this.#released) return;
    const response = runManagedControlSync(this.#runtime.remoteGrant(), "release-reservation", {});
    this.#runtime.decodeResponse(response);
    this.#released = true;
  }
}

/** Shared local publication boundary; durable coordinator events remain pending. */
class ProcessEventPublicationScope {
  #depth = 0;
  #draining = false;
  #drainCompletion = null;
  #completeDrain = null;
  #flushRequested = false;
  beginDrain() {
    if (this.#depth !== 0) { this.#flushRequested = true; return false; }
    if (this.#draining) return false;
    this.#draining = true;
    this.#drainCompletion = new Promise((resolve) => { this.#completeDrain = resolve; });
    return true;
  }
  endDrain() {
    this.#draining = false;
    this.#completeDrain();
    this.#drainCompletion = null;
    this.#completeDrain = null;
  }
  async runDrain(operation, { required = false, executionId = null } = {}) {
    if (!this.beginDrain()) {
      if (required) fail("activity-pending", "Runtime closure requires its in-flight process event publication to settle", { executionId });
      return [];
    }
    try { return await operation(); }
    finally { this.endDrain(); }
  }
  #takeFlushRequest() {
    if (this.#depth !== 0 || this.#draining || !this.#flushRequested) return false;
    this.#flushRequested = false;
    return true;
  }
  #publicationFailure(failure, failed, cause) {
    return failed ? new AggregateError([failure, cause], "Deferred operation and process event publication both failed", { cause: failure }) : cause;
  }
  deferSync(operation, flush) {
    this.#depth++;
    let value, failure, failed = false;
    try { value = operation(); }
    catch (cause) { failed = true; failure = cause; }
    finally { this.#depth--; }
    try { while (this.#takeFlushRequest()) flush(); }
    catch (cause) { throw this.#publicationFailure(failure, failed, cause); }
    if (failed) throw failure;
    return value;
  }
  async defer(operation, flush) {
    const pendingDrain = this.#drainCompletion;
    this.#depth++;
    let value, failure, failed = false;
    try {
      // A writer already awaiting its query or acknowledgement must finish
      // before a new physical body can begin using the same host event loop.
      if (pendingDrain !== null) await pendingDrain;
      value = await operation();
    } catch (cause) { failed = true; failure = cause; }
    finally { this.#depth--; }
    try { while (this.#takeFlushRequest()) await flush(); }
    catch (cause) { throw this.#publicationFailure(failure, failed, cause); }
    if (failed) throw failure;
    return value;
  }
}

/** One drain's ordered, independently durable publications awaiting coordinator ACK. */
class ProcessEventPublicationBatch {
  #publications = [];
  #acknowledged = [];
  operation = null;
  static accepts(writer) { return typeof writer === "function" || writer instanceof ProcessExecutionEventBatchWriter; }
  static deferred(writer) { return writer instanceof ProcessExecutionEventBatchWriter; }
  static write(writer, event) { return this.deferred(writer) ? writer.write(event) : writer(event); }
  beforeWriter(writer) { return this.#publications.length !== 0 && !ProcessEventPublicationBatch.deferred(writer); }
  beforePublication(publication) { return this.operation !== null && this.operation !== this.#operation(publication); }
  afterWriter(writer) { return !ProcessEventPublicationBatch.deferred(writer); }
  #operation(publication) { return publication instanceof ProcessExecutionCanonicalAcknowledgement ? "ack-events" : "dispose-runtime-events"; }
  add(publication) {
    this.operation = this.#operation(publication);
    this.#publications.push(publication);
  }
  flush(request) {
    if (this.#publications.length === 0) return;
    const complete = () => {
      if (this.operation === "ack-events") this.#acknowledged.push(...this.#publications.map((entry) => entry.eventId));
      this.#publications = [];
      this.operation = null;
    };
    const response = request(this.operation, { publications: this.#publications.map((entry) => entry.toJSON()) });
    if (response?.then !== undefined) return response.then(complete);
    complete();
  }
  failAfterFlush(error, request) {
    let completion;
    try { completion = this.flush(request); }
    catch (failure) { throw combineProcessExecutionFailures(error, failure); }
    if (completion?.then !== undefined) return completion.then(
      () => { throw error; },
      (failure) => { throw combineProcessExecutionFailures(error, failure); },
    );
    throw error;
  }
  acknowledged() { return [...this.#acknowledged]; }
}

/** Public clients authenticate capabilities; only the coordinator mutates inventory. */
export class ProcessExecutionRuntime {
  #recoveryTail = Promise.resolve();
  #ownershipReservation = null;
  #closureInProgress = false;
  constructor(store, record, { grant, borrowed = false, binding = record.binding, root = null,
    callAdmission = null, eventWriter = null, control = null, faultInjector = null, nonOwning = false } = {}) {
    if (callAdmission !== null && !(callAdmission instanceof ProcessExecutionCallAdmission)) throw new TypeError("Typed process call admission is required");
    if (eventWriter !== null && !ProcessEventPublicationBatch.accepts(eventWriter)) throw new TypeError("Process event writer requires a function or typed batch writer");
    this.store = store;
    this.mainRoot = store.checkout.mainRoot; this.executionRoot = store.checkout.executionRoot;
    this.executionId = record.executionId; this.ownerEpoch = record.ownerEpoch;
    this.ownerToken = record.coordinatorIdentity.ownerToken; this.ownerSession = record.coordinatorIdentity.ownerSession;
    this.runId = record.runId; this.specId = record.specId;
    this.binding = new ProcessExecutionBinding(binding);
    this.callAdmission = callAdmission; this.eventWriter = eventWriter; this.faultInjector = faultInjector;
    this.borrowed = borrowed; this.nonOwning = nonOwning; this.parentCallId = borrowed ? grant.callId : null;
    this.root = root ?? this; this.control = control ?? this.root.control;
    this.grant = new ProcessExecutionGrant(grant); this.closed = false;
    this.eventWriters = root?.eventWriters ?? new Map();
    this.eventPublicationScope = root?.eventPublicationScope ?? new ProcessEventPublicationScope();
    if (eventWriter !== null) this.eventWriters.set(this.binding.digest, eventWriter);
  }
  static current() { return scopes.getStore() ?? null; }
  get checkoutIdentity() { return this.store.checkout; }
  get sourceId() { return digest(this.checkoutIdentity); }
  remoteGrant() { return new ProcessExecutionGrant({ ...this.grant.toJSON(), scopeBinding: this.binding.toJSON() }).toJSON(); }
  static async acquire({ mainRoot, executionRoot = mainRoot, runId = null, specId = null, binding = null,
    environment = process.env, callAdmission = null, eventWriter = null, faultInjector = null, workspace = null } = {}) {
    if (workspace === null && environment[PROCESS_EXECUTION_SCOPE_ENV]) {
      let grant;
      try { grant = JSON.parse(environment[PROCESS_EXECUTION_SCOPE_ENV]); }
      catch (cause) { fail("delegation-refused", "Borrowed execution grant is not valid JSON", { cause }); }
      if (path.resolve(mainRoot) !== grant.mainRoot || path.resolve(executionRoot) !== grant.executionRoot
        || runId !== grant.runId || specId !== grant.specId) fail("delegation-refused", "Borrowed execution belongs to another checkout, run or specification");
      return this.fromRemoteGrant(grant, { binding, callAdmission, eventWriter, faultInjector });
    }
    if (workspace !== null && !(workspace instanceof ReadOnlyInvocationWorkspace)) throw new TypeError("Read-only execution requires a minted invocation workspace");
    const storagePolicy = workspace?.processRuntimeStorage() ?? null;
    const configuration = { mainRoot: fs.realpathSync(path.resolve(mainRoot)), executionRoot: fs.realpathSync(path.resolve(executionRoot)),
      runId, specId, binding: json(new ProcessExecutionBinding(binding)), storage: storagePolicy?.toJSON() ?? null };
    const execution = workspace?.beginExecution() ?? null;
    const { control, record } = await CoordinatorChildControl.launch(configuration, environment, { workspace, execution, storagePolicy });
    const store = new ProcessRuntimeStore({ mainRoot: configuration.mainRoot, executionRoot: configuration.executionRoot, create: false, storagePolicy });
    return new this(store, record, { grant: control.grant, control, callAdmission, eventWriter, faultInjector });
  }
  static async fromRemoteGrant(grant, { binding, callAdmission = null, eventWriter = null, faultInjector = null } = {}) {
    try { grant = new ProcessExecutionGrant(grant).toJSON(); }
    catch (cause) { fail("delegation-refused", "Coordinator grant is malformed or unsupported", { cause }); }
    binding ??= grant.scopeBinding;
    const { managedRequest } = await import("./managed-process-protocol.js");
    const response = await managedRequest(grant, "authenticate", { grant, data: binding === undefined || binding === null ? {} : { binding: json(new ProcessExecutionBinding(binding)) } });
    const result = this.prototype.decodeResponse(response);
    const store = new ProcessRuntimeStore({ mainRoot: grant.mainRoot, executionRoot: grant.executionRoot, create: false, storagePolicy: grant.storage === null ? null : ReadOnlyProcessRuntimeStorage.fromGrant(grant.storage) });
    if (!store.checkout.matches(new ProcessExecutionCheckoutIdentity(result.checkout))) fail("authority-mismatch", "Coordinator response belongs to another physical checkout");
    const borrowed = grant.callId !== grant.executionId;
    const view = ProcessExecutionClientView.fromStored(result.record);
    return new this(store, view, { grant: result.grant, borrowed,
      binding: borrowed ? view.parentBinding : binding, callAdmission, eventWriter, faultInjector, nonOwning: true });
  }
  decodeResponse(response) {
    const payload = response?.payload ?? response;
    if (payload?.ok === false) throw ProcessExecutionControlFailure.fromStored(payload.error);
    if (payload?.ok !== true || !Object.hasOwn(payload, "value")) fail("response-invalid", "Coordinator returned an invalid authenticated response");
    return payload.value;
  }
  async #request(operation, data = {}) {
    const { managedRequest } = await import("./managed-process-protocol.js");
    const grant = this.remoteGrant();
    try { return this.decodeResponse(await managedRequest(grant, operation, { grant, data: json(data) })); }
    catch (cause) { throw this.#requestFailure(cause); }
  }
  #requestSync(operation, data = {}) {
    try { return this.decodeResponse(runManagedControlSync(this.remoteGrant(), operation, json(data))); }
    catch (cause) { throw this.#requestFailure(cause); }
  }
  #requestFailure(cause) {
    const diagnostic = this.root.control?.diagnostics.at(-1);
    if (!(cause instanceof ProcessExecutionControlFailure) || cause.code !== "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE"
      || cause.diagnostic !== null || diagnostic === undefined) return cause;
    return new ProcessExecutionControlFailure(cause.reason, cause.message, {
      cause: new AggregateError([cause, diagnostic], "Communication failed after a coordinator diagnostic"),
      executionId: cause.executionId ?? this.executionId, callId: cause.callId,
      primaryCause: diagnostic.primaryCause, communication: cause.communication,
    });
  }
  #assertOpen() { if (this.closed || this.root.closed) fail("registration-closed", "Runtime scope is closed"); }
  #assertCall(call) {
    this.#assertOpen();
    if (!(call instanceof ProcessExecutionCall) || call.executionId !== this.executionId || call.ownerEpoch !== this.ownerEpoch || call.ownerToken !== this.ownerToken) fail("binding-mismatch", "Physical call belongs to another runtime scope");
  }
  enter(callback) { this.#assertOpen(); return scopes.run(this, callback); }
  async withBinding(binding, callback, { callAdmission = this.callAdmission, eventWriter = this.eventWriter } = {}) {
    this.#assertOpen();
    const snapshot = new ProcessExecutionBinding(binding);
    if (this.borrowed && !snapshot.matches(this.binding)) fail("delegation-refused", "Borrowed scope cannot replace its immutable binding");
    const result = await this.#request("bind", { binding: snapshot.toJSON() });
    this.runId = result.runId; this.specId = result.specId; this.grant = new ProcessExecutionGrant(result.grant);
    this.root.runId = result.runId; this.root.specId = result.specId; this.root.grant = new ProcessExecutionGrant({ ...this.root.grant.toJSON(), runId: result.runId, specId: result.specId });
    const record = { executionId: this.executionId, ownerEpoch: this.ownerEpoch,
      coordinatorIdentity: { ownerToken: this.ownerToken, ownerSession: this.ownerSession }, runId: this.runId, specId: this.specId, binding: snapshot };
    const scope = new ProcessExecutionRuntime(this.store, record, { grant: this.remoteGrant(), borrowed: this.borrowed, binding: snapshot,
      root: this.root, control: this.control, callAdmission, eventWriter, faultInjector: this.faultInjector, nonOwning: this.nonOwning });
    return scopes.run(scope, callback);
  }
  async reserveCall({ binding = this.binding, invocation = null, timeoutMs = null, graceMs = DEFAULT_REGISTERED_CHILD_GRACE_MS, ...options } = {}) {
    this.#assertOpen();
    const requested = new ProcessExecutionBinding(binding);
    if (this.borrowed && !requested.matches(this.binding)) fail("delegation-refused", "Nested call cannot replace its delegated binding");
    this.callAdmission?.admit({ runtime: this, binding: requested });
    const record = await this.#request("reserve", { binding: requested.toJSON(),
      invocation: json(invocation ?? { ...options, reservedAt: new Date().toISOString() }), timeoutMs, graceMs });
    if (this.eventWriter !== null) this.eventWriters.set(requested.digest, this.eventWriter);
    this.faultInjector?.({ phase: "after-runtime-readback", filePath: this.store.file.filePath });
    await this.drainEvents();
    return new ProcessExecutionCall(this, record);
  }
  async claimLaunch(call, { executor }) {
    this.#assertCall(call);
    const permit = await this.#request("claim-launch", { call: call.controlTarget(), executor: json(executor) });
    call.executor = executor instanceof ProcessExecutorIdentity ? executor : ProcessExecutorIdentity.fromStored(executor);
    await this.drainEvents();
    return new ProcessExecutionStartPermit(permit);
  }
  authorizeStart(call, details) { return this.claimLaunch(call, details); }
  async observeCall(call, observation) {
    this.#assertCall(call);
    const result = await this.#request("observe", { call: call.controlTarget(), ...json(observation) });
    await this.drainEvents();
    return result;
  }
  async readCallControl(call, { executor }) {
    this.#assertCall(call);
    return this.#request("read-control", { call: call.controlTarget(), executor: json(executor) });
  }
  async beginCallStop(call, options = {}) {
    this.#assertCall(call);
    if (options.controlFailure) await this.recordCallControlFailure(call, options.controlFailure);
    const stored = await this.#request("begin-stop", { call: call.controlTarget(), reason: options.reason ?? "abort", ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }) });
    await this.drainEvents();
    return stored === null ? null : ManagedStopOperation.fromStored(stored);
  }
  async persistCallOutput(call, { executor, stream, maximum, bytes }) {
    this.#assertCall(call);
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Captured output requires a Buffer");
    const captured = Buffer.from(bytes);
    const snapshot = ManagedOutputSnapshot.capture(captured, maximum);
    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    do {
      const chunk = captured.subarray(offset, Math.min(captured.length, offset + chunkSize));
      const result = await this.#request("persist-call-output", { call: call.controlTarget(), executor: executor.toJSON(),
        stream, maximum, snapshot: snapshot.toJSON(), offset, bytes: chunk.toString("base64") });
      offset += chunk.length;
      const prefix = new ManagedOutputSnapshot(result.snapshot, maximum);
      const expected = ManagedOutputSnapshot.capture(captured.subarray(0, offset), maximum);
      if (!isDeepStrictEqual(prefix.toJSON(), expected.toJSON()) || result.complete !== (offset === captured.length)) fail("output-mismatch", "Coordinator output acknowledgement differs from the exact captured prefix");
    } while (offset < captured.length);
    return snapshot.toJSON();
  }
  async revokeCall(call, { reason = "cancelled-before-launch" } = {}) {
    this.#assertCall(call);
    const revocation = ProcessExecutionReservationRevocation.fromStored(await this.#request("revoke-reservation", { call: call.controlTarget(), reason }));
    await this.drainEvents();
    return revocation;
  }
  async finishCall(call, { outcome = null, observation, output } = {}) {
    this.#assertCall(call);
    const receipt = await this.#request("finish", { call: call.controlTarget(), outcome: json(outcome), observation: json(observation), output: json(output) });
    await this.drainEvents();
    return new ProcessExecutionStopReceipt(receipt);
  }
  async recordCallControlFailure(call, error) {
    this.#assertCall(call);
    if (!(error instanceof ProcessExecutionControlFailure)) throw new TypeError("Physical failure recording requires typed evidence");
    return ProcessExecutionControlFailure.fromStored(await this.#request("failure", { call: call.controlTarget(), error: error.toJSON() }));
  }
  static async reportDelegatedControlFailure({ environment = process.env, error } = {}) {
    if (!(error instanceof ProcessExecutionControlFailure)) throw new TypeError("Delegated failure requires typed evidence");
    const grant = JSON.parse(environment[PROCESS_EXECUTION_SCOPE_ENV]);
    const runtime = await this.fromRemoteGrant(grant);
    return ProcessExecutionControlFailure.fromStored(await runtime.#request("delegated-failure", { error: error.toJSON() }));
  }
  #eventPublication(event, publication) {
    if (!(publication instanceof ProcessExecutionCanonicalAcknowledgement) && !(publication instanceof ProcessExecutionRuntimeOnlyDisposition)
      || !publication.matches(event)) fail("event-mismatch", "Event writer did not return the exact typed durable publication or runtime-only disposition",
        { executionId: event.executionId, callId: event.callId });
    return publication;
  }
  withDeferredEventPublicationSync(operation) {
    return this.eventPublicationScope.deferSync(operation, () => this.drainEventsSync());
  }
  withDeferredEventPublication(operation) {
    return this.eventPublicationScope.defer(operation, () => this.drainEvents());
  }
  async drainEvents(writer = null, selection = null) {
    if (writer === null && this.eventWriters.size === 0) return [];
    return this.eventPublicationScope.runDrain(() => this.#publishEvents(writer, selection));
  }
  async #publishEvents(writer = null, selection = null) {
    if (writer === null && this.eventWriters.size === 0) return [];
    const pending = await this.#request("events");
    const batch = new ProcessEventPublicationBatch();
    const request = (operation, data) => this.#request(operation, data);
    for (const stored of pending) {
      const event = ProcessExecutionEvent.fromStored(stored);
      if (selection !== null && !selection.matches(event.binding)) continue;
      const selected = writer ?? this.eventWriters.get(event.binding.digest);
      if (selected === undefined) continue; // No caller has supplied canonical authority for this binding.
      if (batch.beforeWriter(selected)) await batch.flush(request);
      let publication;
      try { publication = this.#eventPublication(event, await ProcessEventPublicationBatch.write(selected, event)); }
      catch (error) { return batch.failAfterFlush(error, request); }
      if (batch.beforePublication(publication)) await batch.flush(request);
      batch.add(publication);
      if (batch.afterWriter(selected)) await batch.flush(request);
    }
    await batch.flush(request);
    return batch.acknowledged();
  }
  drainEventsSync(writer = null, selection = null) {
    if ((writer === null && this.eventWriters.size === 0) || !this.eventPublicationScope.beginDrain()) return [];
    try {
      const pending = this.#requestSync("events");
      const batch = new ProcessEventPublicationBatch();
      const request = (operation, data) => this.#requestSync(operation, data);
      for (const stored of pending) {
        const event = ProcessExecutionEvent.fromStored(stored);
        if (selection !== null && !selection.matches(event.binding)) continue;
        const selected = writer ?? this.eventWriters.get(event.binding.digest);
        if (selected === undefined) continue;
        if (batch.beforeWriter(selected)) batch.flush(request);
        let publication;
        try {
          const result = ProcessEventPublicationBatch.write(selected, event);
          if (result?.then !== undefined) throw new TypeError("Synchronous event drain requires a synchronous canonical writer");
          publication = this.#eventPublication(event, result);
        } catch (error) { return batch.failAfterFlush(error, request); }
        if (batch.beforePublication(publication)) batch.flush(request);
        batch.add(publication);
        if (batch.afterWriter(selected)) batch.flush(request);
      }
      batch.flush(request);
      return batch.acknowledged();
    } finally { this.eventPublicationScope.endDrain(); }
  }
  async finalizeBinding(selection, writer = null) {
    if (!(selection instanceof ProcessExecutionBindingSelection)) throw new TypeError("Finalization requires a typed binding selection");
    const fence = await this.#request("finalization-fence", { selection: selection.toJSON() });
    if (!fence.ready) fail("finalization-pending", "Selected execution has unfinished registered children; its admission fence is retained", { executionId: this.executionId });
    await this.drainEvents(writer, selection);
    return ProcessExecutionFinalizationBarrier.fromStored(await this.#request("finalization-confirm", { selection: selection.toJSON(), fenceId: fence.fenceId }));
  }
  finalizeBindingSync(selection, writer = null) {
    if (!(selection instanceof ProcessExecutionBindingSelection)) throw new TypeError("Finalization requires a typed binding selection");
    const fence = this.#requestSync("finalization-fence", { selection: selection.toJSON() });
    if (!fence.ready) fail("finalization-pending", "Selected execution has unfinished registered children; its admission fence is retained", { executionId: this.executionId });
    this.drainEventsSync(writer, selection);
    return ProcessExecutionFinalizationBarrier.fromStored(this.#requestSync("finalization-confirm", { selection: selection.toJSON(), fenceId: fence.fenceId }));
  }
  inspect() { return ProcessExecutionRuntime.inspect({ mainRoot: this.mainRoot, executionRoot: this.executionRoot, storagePolicy: this.store.storagePolicy }); }
  stopReceipts(binding = null) {
    const inventory = this.inspect();
    if (inventory === null) fail("record-missing", "Runtime inventory disappeared before receipt readback");
    const expected = binding === null ? null : new ProcessExecutionBinding(binding);
    return inventory.executions.flatMap((execution) => execution.calls.filter((call) => call.receipt !== null)
      .map((call) => new ProcessExecutionStopReceipt(call.receipt))).filter((receipt) => expected === null || receipt.binding.matches(expected));
  }
  async #closeRoot(operation) {
    if (this.#closureInProgress) fail("activity-pending", "Root closure is already in progress", { executionId: this.executionId });
    this.#closureInProgress = true;
    try {
      const deadline = managedMonotonicNow() + 20000;
      const { setTimeout: wait } = await import("node:timers/promises");
      let result;
      do {
        result = await this.#request(operation);
        if (result.closed) break;
        if (managedMonotonicNow() >= deadline) {
          const firstFailure = result.controlFailure === null || result.controlFailure === undefined ? null
            : ProcessExecutionControlFailure.fromStored(result.controlFailure);
          fail("stop-unconfirmed", "Root closure has registered children without exact exit receipts", {
            executionId: this.executionId, cause: firstFailure ?? undefined });
        }
        await wait(20);
      } while (true);
      // Keep the existing publication claim until closure has its terminal result.
      await this.eventPublicationScope.runDrain(async () => {
        await this.#publishEvents();
        if (operation === "close") await this.#request("release-root");
        this.closed = true;
        if (operation === "seal") this.#ownershipReservation = new ProcessExecutionOwnershipReservation(this);
      }, { required: true, executionId: this.executionId });
    } finally { this.#closureInProgress = false; }
  }
  async sealForCheckoutHandoff() {
    if (this.borrowed || this.nonOwning) fail("delegation-refused", "A non-owning scope cannot hand off checkout ownership");
    if (this.root !== this) return this.root.sealForCheckoutHandoff();
    this.#assertOpen();
    await this.#closeRoot("seal");
    return this.#ownershipReservation;
  }
  async close() {
    if (this.closed) {
      if (this.#ownershipReservation !== null && !this.#ownershipReservation.released) return;
      if (!this.borrowed && !this.nonOwning && this.root === this) await this.control?.waitForExit();
      return;
    }
    if (this.borrowed || this.nonOwning) { await this.drainEvents(); this.closed = true; return; }
    if (this.root !== this) return this.root.close();
    await this.#closeRoot("close");
    await this.control?.waitForExit();
  }
  static inspect({ mainRoot, executionRoot = mainRoot, storagePolicy = null } = {}) {
    try {
      const main = path.resolve(mainRoot), checkout = path.resolve(executionRoot);
      new RealDirectoryAuthority(main).assertStable(); new RealDirectoryAuthority(checkout).assertStable();
      let directory = storagePolicy?.directory ?? main;
      storagePolicy?.assertStable();
      for (const part of storagePolicy === null ? [".sennel", "process-runtime", digest(checkout)] : [digest(checkout)]) {
        directory = path.join(directory, part);
        try { fs.lstatSync(directory); } catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
        new RealDirectoryAuthority(directory).assertStable();
      }
      const store = new ProcessRuntimeStore({ mainRoot: main, executionRoot: checkout, create: false, storagePolicy });
      return store.readConsistentInventory();
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("registry-failed", `Runtime inspection failed: ${cause.message}`, { cause });
    }
  }
  static readHistoricalInventory({ mainRoot, executionRoot = mainRoot, checkoutIdentity, runId, specId } = {}) {
    try {
      const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false, historical: true });
      if (checkoutIdentity !== undefined && !store.checkout.matches(new ProcessExecutionCheckoutIdentity(checkoutIdentity))) fail("authority-mismatch", "Historical runtime source belongs to another checkout identity");
      const inventory = store.readConsistentInventory(); store.assertCommitted();
      return new ProcessExecutionHistoricalInventory(inventory, { runId, specId });
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("registry-failed", `Historical runtime inspection failed: ${cause.message}`, { cause });
    }
  }
  static inspectRetainedClosedCheckout({ mainRoot, executionRoot, runId, specId } = {}) {
    try {
      for (const value of [runId, specId]) if (typeof value !== "string" || value === "") throw new TypeError("Retained inspection requires exact run/spec identity");
      const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false, retainedClosed: true });
      const registry = store.readConsistentInventory();
      if (registry.slot !== null || registry.executions.some((entry) => entry.status !== "closed")) fail("stop-unconfirmed", "Retained checkout lacks exact closed receipts", { executionId: registry.slot });
      const latest = registry.executions.at(-1);
      if (!latest) fail("record-missing", "Retained checkout has no sealed execution history");
      if (latest.runId !== runId || latest.specId !== specId) fail("binding-mismatch", "Retained closure belongs to another run/spec", { executionId: latest.executionId });
      if (store.ownerLock.inspect() !== null) fail("busy", "Published checkout ownership remains unknown until explicit release");
      return registry;
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("registry-failed", `Retained checkout inspection failed: ${cause.message}`, { cause });
    }
  }
  static assertQuiescent({ mainRoot, executionRoot = mainRoot, runId = null, specId = null } = {}) {
    const inventory = this.inspect({ mainRoot, executionRoot });
    if (inventory === null) return;
    const current = this.current();
    if (current && !current.closed && !current.root.closed && current.mainRoot === path.resolve(mainRoot)
      && current.executionRoot === path.resolve(executionRoot) && inventory.slot === current.executionId) {
      const record = inventory.executions.find((entry) => entry.executionId === current.executionId);
      if (record.ownerEpoch === current.ownerEpoch && record.coordinatorIdentity.ownerToken === current.ownerToken
        && record.coordinatorIdentity.ownerSession === current.ownerSession && (record.accepting || record.recoveryFence !== null)
        && (runId === null || record.runId === runId) && (specId === null || record.specId === specId)) {
        if (record.calls.some((call) => callCompletion(call) === null)) fail("stop-unconfirmed", "Canonical recovery requires receipts for every registered child");
        return;
      }
    }
    if (inventory.slot !== null) fail("busy", "Runtime termination must be proved before canonical recovery", { executionId: inventory.slot });
    const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false });
    if (store.ownerLock.inspect() !== null) fail("busy", "Checkout owner token has not explicitly released exclusion");
  }
  static async withRecoveryEvidence({ mainRoot, executionRoot = mainRoot, binding } = {}, callback) {
    const expected = new ProcessExecutionBinding(binding);
    if (expected.value === null || Object.keys(expected.value).length === 0 || typeof callback !== "function") throw new TypeError("Recovery requires exact binding and synchronous consumer");
    const current = this.current();
    const owned = current && !current.borrowed && !current.closed && !current.root.closed
      && current.mainRoot === path.resolve(mainRoot) && current.executionRoot === path.resolve(executionRoot) ? current.root : null;
    if (owned === null) {
      if (this.inspect({ mainRoot, executionRoot }) === null) fail("admission-failed", "Physical recovery requires an existing runtime inventory");
      let store;
      try { store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false }); store.readInventory(); }
      catch (cause) {
        if (cause instanceof ProcessExecutionControlFailure) throw cause;
        fail("admission-failed", "Physical recovery requires an existing validated runtime inventory", { cause });
      }
      const { control } = await CoordinatorChildControl.launch({ mainRoot: store.checkout.mainRoot,
        executionRoot: store.checkout.executionRoot, runId: null, specId: null, binding: expected.toJSON(), mode: "recovery" }, process.env);
      let evidence;
      try {
        const readCurrent = () => {
          const lock = store.ownerLock.inspect();
          if (lock === null || lock.owner.ownerToken !== control.grant.ownerToken || lock.owner.ownerSession !== control.grant.ownerSession) fail("ownership-changed", "Read-only recovery exclusion changed");
          const inventory = store.readInventory();
          if (inventory.slot !== null || inventory.executions.some((record) => record.calls.some((call) => callCompletion(call) === null))) fail("stop-unconfirmed", "Recovery inventory has unfinished registered-child evidence");
          return inventory;
        };
        const inventory = readCurrent();
        evidence = new ProcessExecutionRecoveryEvidence({ checkoutIdentity: store.checkout, binding: expected,
          inventory, revocations: inventory.executions.map((execution) => ({ executionId: execution.executionId,
            ownerEpoch: execution.ownerEpoch, authorityState: "closed" })), readCurrent, authority: recoveryEvidenceAuthority });
        const result = callback(evidence);
        if (result?.then !== undefined) throw new TypeError("Recovery evidence consumer must be synchronous");
        return result;
      } finally {
        evidence?.invalidate();
        const { managedRequest } = await import("./managed-process-protocol.js");
        const response = await managedRequest(control.grant, "release-recovery", { grant: control.grant, data: {} });
        this.prototype.decodeResponse(response);
        await control.waitForExit();
      }
    }
    const runtime = owned;
    // Binding views share this owning root. Serialize the whole evidence
    // lifetime locally; holding Store.exclusive across coordinator RPCs would
    // deadlock their physical admission lock. Each turn still acquires and
    // authenticates a fresh coordinator fence and reads fresh inventory.
    const preceding = runtime.#recoveryTail;
    let release;
    runtime.#recoveryTail = new Promise((resolve) => { release = resolve; });
    await preceding;
    try {
      runtime.#assertOpen();
      let evidence;
      let fence;
      try {
        ({ fence } = await runtime.#request("recovery-begin"));
        const inventory = runtime.inspect();
        const readCurrent = () => {
          const actual = runtime.inspect();
          const root = actual.executions.find((entry) => entry.executionId === runtime.executionId);
          if (root?.recoveryFence !== fence || root.coordinatorIdentity.ownerToken !== runtime.ownerToken || root.coordinatorIdentity.ownerSession !== runtime.ownerSession) fail("recovery-authority-expired", "Recovery exclusion changed");
          return actual;
        };
        evidence = new ProcessExecutionRecoveryEvidence({ checkoutIdentity: runtime.checkoutIdentity, binding: expected,
          inventory, revocations: inventory.executions.map((execution) => ({ executionId: execution.executionId, ownerEpoch: execution.ownerEpoch,
            authorityState: execution.executionId === runtime.executionId ? "exclusive" : "closed" })), readCurrent, authority: recoveryEvidenceAuthority });
        const result = callback(evidence);
        if (result?.then !== undefined) throw new TypeError("Recovery evidence consumer must be synchronous");
        return result;
      } finally {
        evidence?.invalidate();
        if (fence !== undefined) await runtime.#request("recovery-end", { fence });
      }
    } finally {
      // Even a failed begin, consumer, or end must release the local queue.
      // An uncertain durable fence is retained for the next fresh RPC to refuse.
      release();
    }
  }
}
