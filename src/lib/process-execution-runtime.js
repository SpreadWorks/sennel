import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtomicFile } from "./atomic-file.js";
import { RuntimeFileGeneration, RuntimePublicationStage, RuntimePublicationWrite,
  RuntimePublicationMetadataSelection, RuntimePublicationMetadataUpdate, removeRuntimePublicationFile,
} from "./process-execution-publication-metadata.js";
import { CURRENT_PROCESS_EXECUTION_EVIDENCE } from "./process-execution-evidence-codec.js";
import { PreviousProcessExecutionEvidenceCodec, ProcessExecutionEvidenceMigration } from "./process-execution-evidence-migration.js";
import { RuntimeRequestAcceptance, RuntimeRequestReference, RuntimeRequestHeads, RuntimeStandaloneRequestDocument, RuntimeRequestHistorySection, RuntimeRequestCompletionSection, RuntimeRequestBlock, RuntimeRequestHistoryBlock, RuntimeRequestCompletionBlock, RuntimeRequestPhysicalRecord, RuntimeRequestCompletionCarrier, RuntimeRequestContinuationBlock, RuntimeRequestContinuedCompletionBlock, RuntimeRequestContinuationChain, RuntimeRequestBlockEncodingPlan, runtimeRequestBlockIdentity, RUNTIME_REQUEST_BLOCK_SOFT_BYTES } from "./process-execution-request-block.js";
import { ProcessExecutionCapturedInvocation } from "./process-execution-invocation.js";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { ProcessLock, LockOwnerSession } from "./process-lock.js";
import { FileIdentity } from "./file-identity.js";
import { RegularFileSnapshotGroup, visitRegularFileChunks } from "./regular-file-snapshot.js";
import { LogicalRelativePath } from "./portable-path.js";
import { RealDirectoryAuthority, RealDirectoryNameSnapshot, sameFileIdentity } from "./real-directory-authority.js";
import { RepositoryMaintenanceLock } from "./repository-maintenance-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { InvocationControlWorkspace, ReadOnlyInvocationWorkspace, ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { ProcessExecutionControlEndpoint } from "./process-execution-endpoint.js";
import { ManagedStopOperation, managedMonotonicNow } from "./managed-stop-operation.js";
import { ManagedControlPolicy } from "./managed-control-policy.js";
import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "./agent-timeout.js";
import { ManagedStopOperationStore, ManagedStopOperationClaim, withManagedStopOperationClaims } from "./managed-stop-store.js";
import { ManagedOutputSpool, ManagedOutputSnapshot, readManagedOutput } from "./managed-process-output.js";
import { writeManagedRecord, ManagedProcessMessage, ManagedRecordWrite, withManagedRecordWriters, managedRequest, ManagedProcessRequestBatch, ManagedRequestTransportCohort } from "./managed-process-protocol.js";
import { CommandInvocation, CommandLaunchDescriptor } from "./command-invocation.js";
import { currentRuntimeWireDelivery, currentRuntimePackage } from "./runtime-package.js";
import { runManagedControlSync } from "./process-execution-sync.js";
import { combineProcessExecutionFailures, synchronousManagedResult, processExecutionControlFailureFromCause } from "./process-execution-completion.js";
import { ProcessExecutionReservationRevocation, ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";
export { ProcessExecutionReservationRevocation } from "./process-execution-reservation-revocation.js";
import { ProcessExecutionBindingSelection, ProcessExecutionFinalizationCutoff, ProcessExecutionFinalizationBarrier } from "./process-execution-finalization.js";
export { ProcessExecutionBindingSelection, ProcessExecutionFinalizationBarrier } from "./process-execution-finalization.js";
import {
  ProcessExecutionControlFailure, ProcessExecutionControlObservation, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionInvocationDisclosure, ProcessExecutionStopReceipt, ProcessExecutionStartPermit, ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryCall, ProcessExecutionRecoveryEvidenceSummary,
  ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionEvent,
  ProcessExecutionCanonicalAcknowledgement, ProcessExecutionRuntimeOnlyDisposition, ProcessExecutionEventBatchWriter, ProcessExecutionAtomicEventWriter, ProcessExecutionEventGroup, ProcessExecutionValueEncoding,
  executionUuid as uuid, executionValueSnapshot as json, executionValueDigest as digest, executionValueExact as exact, freezeExecutionValue,
  PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED,
} from "./process-execution-values.js";
export {
  ProcessExecutionControlFailure, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionInvocationDisclosure, ProcessExecutionStopReceipt, ProcessExecutionStartPermit, ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryCall,
} from "./process-execution-values.js";

function captureCheckoutAuthorities(main, checkout) {
  main.assertStable(); checkout.assertStable();
  return new ProcessExecutionCheckoutIdentity({ mainRoot: main.directory, executionRoot: checkout.directory,
    mainDevice: main.identity.dev.toString(), mainInode: main.identity.ino.toString(),
    checkoutDevice: checkout.identity.dev.toString(), checkoutInode: checkout.identity.ino.toString() });
}
export function captureProcessExecutionCheckoutIdentity({ mainRoot, executionRoot = mainRoot }) {
  return captureCheckoutAuthorities(new RealDirectoryAuthority(mainRoot), new RealDirectoryAuthority(executionRoot));
}
export const PROCESS_EXECUTION_SCOPE_ENV = "SENNEL_PROCESS_EXECUTION_SCOPE";
const scopes = new AsyncLocalStorage();
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const RUNTIME_RECORD_CAPTURE_WIDTH = 2;
const RUNTIME_RECORD_VERSION = 10;
const recoveryEvidenceAuthority = Symbol("process-runtime-recovery-evidence");
const preparedPublicationAuthority = Symbol("prepared runtime publication");
const recordMigrationCaptureAuthority = Symbol("physical runtime migration capture");
const preparedPublicationPlans = new WeakMap();
const recordMigrationPublicationPlans = new WeakMap();
function fail(reason, message, details) { throw new ProcessExecutionControlFailure(reason, message, details); }
/** A known source version selects preview only after integrity and checkout authority. */
function refusePreviousRuntimeRecord(payload, checkout) {
  if (![8, 9].includes(payload?.version)) return;
  const previous = new PreviousProcessExecutionEvidenceCodec().checkout(payload.checkout);
  if (!previous.matches(checkout)) fail("authority-mismatch", "Previous runtime record belongs to another checkout");
  fail(PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED, "Previous runtime records require explicit readonly migration preview; closure and migration eligibility remain unconfirmed");
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
function decodeRuntimeRequestBlockPayload(bytes, filePath) {
  const envelope = decodeRuntimeJson(bytes, filePath);
  if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Request block checksum differs");
  return envelope.payload;
}
function restoreRuntimeRequestPhysicalRecord(payload, executionId, blockId, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
  const block = RuntimeRequestPhysicalRecord.fromStored(payload, evidenceCodec);
  if (block.executionId !== executionId || block.blockId !== blockId) fail("authority-mismatch", "Request block differs from its exact execution namespace or storage identity");
  return block;
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
const runtimeCallTerminalSources = new WeakMap();

class PhysicalCallRecord {
  constructor(value, { executionId, preparation = null, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE } = {}) {
    const { callId, parentCallId, capability, status, accepting, timeoutMs, graceMs,
      startedAt, startedMonotonic, aborted } = preparation === null ? value : preparation.scalars(value,
      ["callId", "parentCallId", "capability", "status", "accepting", "timeoutMs", "graceMs", "startedAt", "startedMonotonic", "aborted"]);
    this.callId = uuid(callId, "callId");
    this.parentCallId = parentCallId === null ? null : uuid(parentCallId, "parentCallId");
    this.binding = restoreRuntimeField(value, "binding", (field) => ProcessExecutionBinding.from(field), preparation);
    this.invocation = restoreRuntimeField(value, "invocation", (field) => ProcessExecutionCapturedInvocation.capture(field).value, preparation);
    if (this.invocation?.actualCommand !== undefined) {
      CommandInvocation.fromStored(this.invocation.actualCommand);
      CommandLaunchDescriptor.fromStored(this.invocation.launch);
    }
    this.capability = uuid(capability, "call capability");
    if (!["intent", "claimed", "running", "exited", "stopped", "revoked"].includes(status)) throw new TypeError("Call status is invalid");
    this.status = status;
    this.executor = restoreRuntimeField(value, "executor", (field) => field === null ? null : ProcessExecutorIdentity.fromStored(field), preparation);
    this.permit = restoreRuntimeField(value, "permit", (field) => field === null ? null : new ProcessExecutionStartPermit(field), preparation);
    this.observation = restoreRuntimeField(value, "observation", (field) => field === null ? null : ChildExitObservation.fromStored(field), preparation);
    this.output = restoreRuntimeField(value, "output", (field) => field === null ? null : ProcessOutputState.fromStored(field), preparation);
    this.receipt = restoreRuntimeField(value, "receipt", (field) => field === null ? null : evidenceCodec.receipt(field), preparation);
    this.revocation = restoreRuntimeField(value, "revocation", (field) => field === null ? null : evidenceCodec.revocation(field), preparation);
    this.outcome = restoreRuntimeField(value, "outcome", json, preparation);
    // Failure restoration also validates the mutable enclosing call identity.
    this.controlFailure = value.controlFailure === null ? null : evidenceCodec.failure(
      preparation === null ? value.controlFailure : json(value.controlFailure), { executionId, callId: this.callId });
    const failureReference = runtimeCallFailureReferenceOrigin(value);
    if (failureReference?.matchesFailure(this.controlFailure)) runtimeCallFailureReferences.set(this, failureReference);
    this.stopOperation = restoreRuntimeField(value, "stopOperation", (field) => field === null ? null : ManagedStopOperation.fromStored(field), preparation);
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
    const terminal = runtimeCallTerminalSource(value);
    if (terminal?.matchesTerminal(this, true)) runtimeCallTerminalSources.set(this, terminal);
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
  constructor(value, preparation = null) {
    const { requestId, operation, payloadDigest, authorizationDigest } = preparation === null ? value : preparation.scalars(value,
      ["requestId", "operation", "payloadDigest", "authorizationDigest"]);
    Object.assign(this, new RuntimeRequestAcceptance({ requestId, operation, payloadDigest, authorizationDigest }), {
      response: restoreRuntimeField(value, "response", json, preparation) });
  }
  mutableCopy(authority) { return mutableRuntimeRecordShell(this, authority); }
  toJSON() { return { ...this }; }
}


/** One original acceptance with its exact immutable block location. */
class RuntimeRequestHistoryEntry {
  constructor(section, reference) { this.section = section; this.reference = reference; Object.freeze(this); }
}

/** One original completion with its exact block location. */
class RuntimeRequestCompletionEntry {
  constructor(section, reference) {
    this.section = section;
    this.completion = section;
    this.acceptance = section.acceptance;
    this.reference = reference;
    Object.freeze(this);
  }
  completionLink() { return this.reference; }
}

const runtimeReservationInvocations = new WeakMap();
const runtimeRequestFailures = new WeakMap();
const runtimeCallFailureReferences = new WeakMap();
const runtimeFirstCallSettlements = new WeakMap();
const runtimeTerminalMetadataBytes = new WeakMap();

/** Only the first finish branch creates this existing private outcome write. */
class RuntimeFirstCallSettlement {
  constructor(call) {
    if (!(call.receipt instanceof ProcessExecutionStopReceipt)) throw new TypeError("First finish publication requires its typed receipt");
    this.receipt = call.receipt; Object.freeze(this);
  }
  matches(call) { return this.receipt === call.receipt || isDeepStrictEqual(json(this.receipt), json(call.receipt)); }
  static capture(write, call) { runtimeFirstCallSettlements.set(write, new this(call)); return write; }
  static fromEffects(effects) { return effects.map((write) => runtimeFirstCallSettlements.get(write)).find((fact) => fact !== undefined) ?? null; }
}

/** A bounded original failure response remains independently replayable. */
class RuntimeRequestFailureSource {
  #confirmed = null;
  constructor(section) {
    const response = section.response;
    if (!["failure", "delegated-failure"].includes(section.acceptance.operation) || section.history === null
      || response?.ok !== true || Object.keys(response).length !== 2 || !Object.hasOwn(response, "value")) {
      throw new TypeError("Failure source requires its exact successful accepted response");
    }
    this.callId = uuid(response.value?.callId, "failure response call ID");
    this.failure = section.evidenceCodec.failure(response.value, { executionId: section.executionId, callId: this.callId });
    this.value = response.value;
    this.encoding = new ProcessExecutionValueEncoding(this.value);
    Object.freeze(this);
  }
  confirmedValue() {
    if (this.failure.communication?.stopConfirmation !== "unknown") return null;
    return this.#confirmed ??= freezeExecutionValue(this.failure.withStopConfirmation("confirmed").toJSON());
  }
  static fromCompletion(section) {
    if (!["failure", "delegated-failure"].includes(section.acceptance.operation)) return null;
    if (runtimeRequestFailures.has(section)) return runtimeRequestFailures.get(section);
    let source = null;
    try { source = new this(section); } catch { /* Nonmatching old responses remain literal. */ }
    runtimeRequestFailures.set(section, source);
    return source;
  }
}

/** Validated physical reference provenance; it never skips current failure decoding. */
class RuntimeCallFailureReference {
  constructor(inventory, document, call, confirmed = false) {
    const source = RuntimeRequestFailureSource.fromCompletion(document.completion);
    if (source === null || source.callId !== call.callId || source.failure.executionId !== inventory.executionId) {
      fail("record-corrupt", "Call failure lacks its exact accepted response context");
    }
    this.reference = document.completionLink(); this.confirmed = confirmed;
    this.value = confirmed ? source.confirmedValue() : source.value;
    if (this.value === null || confirmed && !inventory.confirmsFailure(document, call)) {
      fail("record-corrupt", "Confirmed failure lacks its original first finish chronology");
    }
    this.encoding = new ProcessExecutionValueEncoding(confirmed ? this.value : source.failure);
    Object.freeze(this);
  }
  matchesFailure(failure) { return failure !== null && this.encoding.matches(new ProcessExecutionValueEncoding(failure)); }
  preserves(document, confirmed) { return this.confirmed === confirmed && this.reference.matches(document.completionLink()); }
}

function runtimeCallFailureReferenceOrigin(value) {
  const origin = value[runtimeRecordOrigin];
  return origin instanceof RuntimePreparedCallFields ? origin.failureReference
    : runtimeCallFailureReferences.get(origin ?? value) ?? null;
}

/** An original successful reservation owns the private invocation, never a later call. */
class RuntimeReservationInvocation {
  constructor(section) {
    const response = section.response;
    if (!ManagedProcessMessage.reservesCall(section.acceptance.operation) || section.history === null
      || response?.ok !== true || Object.keys(response).length !== 2 || !Object.hasOwn(response, "value")) {
      throw new TypeError("Invocation source requires an original successful reservation");
    }
    this.call = freezeExecutionValue(exact(response.value,
      new PhysicalCallRecord(response.value, { executionId: section.executionId })));
    const call = this.call;
    const claimed = section.acceptance.operation === "reserve-and-claim";
    if (call.status !== (claimed ? "claimed" : "intent") || !call.accepting || call.aborted
      || !claimed && [call.executor, call.permit].some((field) => field !== null)
      || [call.observation, call.output, call.receipt, call.revocation, call.outcome, call.controlFailure,
        call.stopOperation, call.startedAt, call.startedMonotonic].some((field) => field !== null)) {
      throw new TypeError("Invocation source differs from its original reservation");
    }
    this.invocation = ProcessExecutionCapturedInvocation.capture(call.invocation);
    this.byteLength = Buffer.byteLength(this.invocation.text());
    Object.freeze(this);
  }
  matchesCall(call) {
    return ["callId", "parentCallId", "capability", "timeoutMs", "graceMs"].every((key) => this.call[key] === call[key])
      && this.call.binding.matches(ProcessExecutionBinding.from(call.binding))
      && (this.call.permit === null || isDeepStrictEqual(json(this.call.permit), json(call.permit))
        && isDeepStrictEqual(json(this.call.executor), json(call.executor)));
  }
  canReference(call, reference) {
    if (!this.matchesCall(call)) return false;
    // Expanded calls retain this exact module-owned snapshot. Other inputs,
    // including previous-revision literals, still require exact JSON encoding.
    if (!this.invocation.matches(call.invocation)) return false;
    return this.byteLength > 4 + Buffer.byteLength(',"invocationRequest":') + Buffer.byteLength(JSON.stringify(reference));
  }
  static fromCompletion(section) {
    if (!ManagedProcessMessage.reservesCall(section.acceptance.operation)) return null;
    if (runtimeReservationInvocations.has(section)) return runtimeReservationInvocations.get(section);
    let source = null;
    // Old logical history may contain an arbitrary opaque successful response.
    // Its ineligibility for this projection never makes a literal call invalid.
    try { source = new this(section); } catch { /* Preserve the literal invocation. */ }
    runtimeReservationInvocations.set(section, source);
    return source;
  }
}

/** Both immutable section chains reconstruct the complete original history. */
class RuntimeRequestInventory {
  #completedById;
  #historyById;
  #blocks;
  #completionOrder;
  #firstSettlements = new Map();
  #firstUnassociatedFinish = null;
  constructor({ executionId, historyHead, completionHead, blocks }) {
    this.executionId = uuid(executionId, "request inventory execution ID");
    this.historyHead = RuntimeRequestReference.fromStored(historyHead);
    this.completionHead = RuntimeRequestReference.fromStored(completionHead);
    this.#blocks = new Map(blocks);
    let sectionCount = 0;
    for (const block of blocks.values()) {
      if (!(block instanceof RuntimeRequestHistoryBlock) && !(block instanceof RuntimeRequestCompletionBlock)
        || block.executionId !== this.executionId) throw new TypeError("Request block has another execution or section kind");
      sectionCount += block.sections.length;
    }
    const reached = new Set();
    const walk = (head, Section) => {
      const seen = new Set(), ordered = [];
      for (let link = head; link !== null;) {
        const key = `${link.blockId}/${link.digest}`;
        const section = blocks.get(link.blockId)?.section(link.digest) ?? null;
        if (section === null) fail("record-missing", "A linked request section is missing");
        if (!(section instanceof Section) || section.digest !== link.digest) fail("record-corrupt", "Request section differs from its exact committed link");
        if (seen.has(section.requestId)) fail("record-corrupt", "Request section chain contains a duplicate or cycle");
        seen.add(section.requestId);
        reached.add(key);
        ordered.push(Section === RuntimeRequestHistorySection ? new RuntimeRequestHistoryEntry(section, link) : new RuntimeRequestCompletionEntry(section, link));
        link = section.previous;
      }
      return ordered.reverse();
    };
    const history = walk(this.historyHead, RuntimeRequestHistorySection);
    const completions = walk(this.completionHead, RuntimeRequestCompletionSection);
    this.#historyById = new Map(history.map((entry) => [entry.section.requestId, entry]));
    this.#completedById = new Map(completions.map((entry) => [entry.section.requestId, entry]));
    for (const { section } of completions) {
      const accepted = this.#historyById.get(section.requestId);
      if (section.history === null ? accepted !== undefined : accepted === undefined
        || !section.history.matches(accepted.reference)
        || !section.acceptance.matches(accepted.section.acceptance)) fail("record-corrupt", "Completed request lost or changed its exact original history membership");
    }
    if (reached.size !== sectionCount) fail("record-corrupt", "A request block contains an unreferenced section");
    this.completions = Object.freeze([...this.#completedById.values()]);
    this.#completionOrder = new Map(this.completions.map((entry, index) => [entry.completion, index]));
    for (const entry of this.completions) {
      if (entry.completion.settlement !== null && !this.#firstSettlements.has(entry.completion.settlement.callId)) {
        this.#firstSettlements.set(entry.completion.settlement.callId, entry);
      } else if (entry.acceptance.operation === "finish" && entry.completion.response.ok === true
        && entry.completion.settlement === null && this.#firstUnassociatedFinish === null) {
        this.#firstUnassociatedFinish = this.#completionOrder.get(entry.completion);
      }
    }
    const preparation = new RuntimeRecordPreparation(runtimeRegistryObservationAuthority);
    this.requests = Object.freeze(history.map(({ section }) => preparation.requestRecord(section,
      this.#completedById.get(section.requestId)?.completion ?? null)));
    Object.freeze(this);
  }
  historyEntry(requestId) { return this.#historyById.get(requestId) ?? null; }
  completionEntry(requestId) { return this.#completedById.get(requestId) ?? null; }
  settlementEntry(callId) { return this.#firstSettlements.get(callId) ?? null; }
  completedRequest(value) {
    const reference = RuntimeRequestReference.fromStored(value);
    const section = this.#blocks.get(reference.blockId)?.section(reference.digest);
    const entry = section instanceof RuntimeRequestCompletionSection ? this.#completedById.get(section.requestId) : undefined;
    if (entry === undefined || !entry.reference.matches(reference)) fail("record-corrupt", "Call fact lacks its exact committed request completion");
    return entry;
  }
  confirmsFailure(document, call) {
    const finish = this.settlementEntry(call.callId);
    const failureOrder = this.#completionOrder.get(document.completion);
    return finish !== null && call.receipt !== null
      && (this.#firstUnassociatedFinish === null || this.#firstUnassociatedFinish >= failureOrder)
      && failureOrder < this.#completionOrder.get(finish.completion)
      && isDeepStrictEqual(json(call.receipt), finish.completion.response.value);
  }
}

/** Reuse requires the exact freshly captured bytes and physical generation. */
class ValidatedRuntimeRequestBlockObservation {
  constructor(snapshot, block) { this.snapshot = snapshot; this.block = block; Object.freeze(this); }
  matches(snapshot) { return snapshot !== null && sameRuntimeRecordSnapshot(this.snapshot, snapshot); }
}

class RuntimeRequestStorageObservation {
  constructor(inventory, blocks) {
    this.inventory = inventory;
    this.blocks = new Map(blocks);
    this.physicalBlocks = new Map();
    for (const block of this.blocks.values()) {
      const records = block instanceof RuntimeRequestContinuedCompletionBlock ? block.physicalRecords : [block];
      for (const record of records) {
        const previous = this.physicalBlocks.get(record.blockId);
        if (previous !== undefined && previous !== record) fail("record-corrupt", "Request blocks share a conflicting physical dependency");
        this.physicalBlocks.set(record.blockId, record);
      }
    }
    Object.freeze(this);
  }
}

/** A logical continuation is reusable only with every exact physical proof. */
class ValidatedRuntimeRequestContinuationObservation {
  constructor(carrier, records, block) {
    this.carrier = carrier;
    this.records = Object.freeze([...records]);
    this.block = block;
    Object.freeze(this);
  }
  matches(carrier, records) {
    return this.carrier === carrier && this.records.length === records.length
      && this.records.every((record, index) => record === records[index]);
  }
}

class PlannedRuntimeRequestExecution {
  constructor(execution, writes, inventory) { this.execution = execution; this.writes = Object.freeze([...writes]); this.inventory = inventory; Object.freeze(this); }
}

/** Pure normal-block path plan; decoded values never authorize the read. */
class RuntimeRequestBlockPlan {
  constructor(blocks) { this.blocks = Object.freeze([...blocks.values()]); Object.freeze(this); }
}

/** Images selected only after this operation's complete fresh group captures. */
class RuntimeCapturedRecords {
  #snapshots;
  #namespaces;
  constructor(snapshots, namespaces = new Map()) {
    this.#snapshots = new Map(snapshots); this.#namespaces = new Map(namespaces); Object.freeze(this);
  }
  entries(relativePath, directory) {
    const captured = this.#namespaces.get(relativePath);
    if (captured === undefined) return undefined;
    if (!(captured instanceof RealDirectoryNameSnapshot) || captured.directory !== directory.directory) {
      throw new TypeError("Captured namespace requires its exact observed directory");
    }
    return captured.names.slice();
  }
  snapshot(relativePath) {
    if (!this.#snapshots.has(relativePath)) fail("record-corrupt", "Captured record escaped its complete physical dependency set");
    return this.#snapshots.get(relativePath);
  }
  view(store) { return new RuntimePublicationView(store, [], new Map(), null, this); }
}

/** Existing request storage packs immutable sections into bounded physical blocks. */
class RuntimeRequestStorage {
  #store;
  #blocks = new Map();
  #continuations = new Map();
  #inventories = new Map();
  #evidenceCodec;
  constructor(store, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) { this.#store = store; this.#evidenceCodec = evidenceCodec; }
  get evidenceCodec() { return this.#evidenceCodec; }
  fork(store) {
    const storage = new RuntimeRequestStorage(store, this.#evidenceCodec);
    // Share only decoder-proof maps, including newly validated staged records.
    // Every view still captures full bytes/generations and rebuilds its inventory.
    storage.#blocks = this.#blocks;
    storage.#continuations = this.#continuations;
    return storage;
  }
  retainFor(store, previous) {
    const storage = this.fork(store);
    storage.#inventories = new Map([...previous.#inventories, ...this.#inventories]);
    return storage;
  }
  readBlock(executionId, blockId) {
    const physical = this.readPhysicalRecord(executionId, blockId);
    if (physical instanceof RuntimeRequestBlock) return physical;
    if (!(physical instanceof RuntimeRequestCompletionCarrier)) fail("record-corrupt", "Request head selected a continuation piece instead of a logical block");
    const chain = new RuntimeRequestContinuationChain(physical, { maximumBytes: MAX_REGISTRY_BYTES, evidenceCodec: this.#evidenceCodec });
    const records = [];
    while (chain.nextReference !== null) {
      const record = this.readPhysicalRecord(executionId, chain.nextReference.blockId);
      chain.append(record);
      records.push(record);
    }
    const key = `requests/${executionId}/blocks/${blockId}.json`;
    const previous = this.#continuations.get(key);
    // Loading the complete chain above is mandatory even on semantic cache hits.
    if (previous?.matches(physical, records)) return previous.block;
    const block = chain.restore();
    this.#continuations.set(key, new ValidatedRuntimeRequestContinuationObservation(physical, records, block));
    return block;
  }
  readPhysicalRecord(executionId, blockId) {
    const file = this.#store.requestBlockFile(executionId, blockId, { create: false });
    const snapshot = file?.readSnapshot() ?? null;
    if (snapshot === null) fail("record-missing", "A linked request block is missing");
    return this.#restorePhysicalRecord(file, snapshot, executionId, blockId);
  }
  #restorePhysicalRecord(file, snapshot, executionId, blockId) {
    const previous = this.#blocks.get(file.filePath);
    if (previous?.matches(snapshot)) return previous.block;
    const block = restoreRuntimeRequestPhysicalRecord(decodeRuntimeRequestBlockPayload(snapshot.bytes, file.filePath), executionId, blockId, this.#evidenceCodec);
    this.#blocks.set(file.filePath, new ValidatedRuntimeRequestBlockObservation(snapshot, block));
    return block;
  }
  #readLinkedBlocks(executionId, historyHead, completionHead, resolve, planning = false) {
    const blocks = new Map();
    for (const [head, Block] of [[historyHead, RuntimeRequestHistoryBlock], [completionHead, RuntimeRequestCompletionBlock]]) {
      const visited = new Set();
      for (let link = RuntimeRequestReference.fromStored(head); link !== null;) {
        const block = blocks.get(link.blockId) ?? resolve(link.blockId);
        if (block === null) return null;
        blocks.set(link.blockId, block);
        if (!(block instanceof Block)) {
          if (planning) return null;
          fail("record-corrupt", "Request chain selected the wrong section block kind");
        }
        const section = block.section(link.digest);
        if (section === null) {
          if (planning) return null;
          fail("record-missing", "Linked request section is absent from its exact block");
        }
        if (visited.has(section.requestId)) {
          if (planning) return null;
          fail("record-corrupt", "Request section chain contains a cycle");
        }
        visited.add(section.requestId);
        link = section.previous;
      }
    }
    return blocks;
  }
  #normalBlockPlan(executionId, historyHead, completionHead) {
    // Inspect existing decoded values only: no file/directory accessor here.
    const cached = new Map();
    for (const { block } of this.#blocks.values()) {
      if (!(block instanceof RuntimeRequestBlock) || block instanceof RuntimeRequestContinuedCompletionBlock
        || block.executionId !== executionId) continue;
      const previous = cached.get(block.blockId);
      if (previous !== undefined && previous !== block) return null;
      cached.set(block.blockId, block);
    }
    const blocks = this.#readLinkedBlocks(executionId, historyHead, completionHead,
      (blockId) => cached.get(blockId) ?? null, true);
    return blocks === null ? null : new RuntimeRequestBlockPlan(blocks);
  }
  #captureNormalBlocks(executionId, plan) {
    const snapshots = new Map();
    // Only the current two-file group adds fresh duplicate payloads; changed graph data, scratch and GC/RSS are separate.
    // Per-file native limits are unchanged; previous sizes never cap new reads.
    for (let offset = 0; offset < plan.blocks.length; offset += RUNTIME_RECORD_CAPTURE_WIDTH) {
      const blocks = plan.blocks.slice(offset, offset + RUNTIME_RECORD_CAPTURE_WIDTH);
      const files = blocks.map((block) => this.#store.requestBlockFile(executionId, block.blockId, { create: false }));
      if (files.some((file) => file === null)) fail("record-missing", "A linked request block is missing");
      const group = AtomicFile.readSnapshots(files);
      for (let index = 0; index < blocks.length; index += 1) {
        const file = files[index];
        const snapshot = group.get(file.filePath);
        if (snapshot === null) fail("record-missing", "A linked request block is missing");
        this.#restorePhysicalRecord(file, snapshot, executionId, blocks[index].blockId);
        // A hit keeps the existing immutable image only AFTER exact fresh byte
        // comparison; a changed record installs its actual new image/decoder.
        // This does not claim equal permission hints or timestamps.
        snapshots.set(`requests/${executionId}/blocks/${blocks[index].blockId}.json`,
          this.#blocks.get(file.filePath).snapshot);
      }
    }
    return new RuntimeCapturedRecords(snapshots);
  }
  readInventory(executionId, historyHead, completionHead) {
    // Existing prepared/captured views already own their physical observation.
    if (this.#store instanceof ProcessRuntimeStore) {
      const plan = this.#normalBlockPlan(executionId, historyHead, completionHead);
      if (plan !== null) {
        const captured = this.#captureNormalBlocks(executionId, plan);
        const storage = this.fork(captured.view(this.#store));
        const inventory = storage.readInventory(executionId, historyHead, completionHead);
        this.#inventories.set(executionId, storage.#inventories.get(executionId));
        return inventory;
      }
    }
    const blocks = this.#readLinkedBlocks(executionId, historyHead, completionHead,
      (blockId) => this.readBlock(executionId, blockId));
    const inventory = new RuntimeRequestInventory({ executionId, historyHead, completionHead, blocks });
    const observation = new RuntimeRequestStorageObservation(inventory, blocks);
    this.assertBlockInventory(executionId, observation.physicalBlocks);
    this.#inventories.set(executionId, observation);
    return inventory;
  }
  publicationSnapshots(executionIds = null) {
    return new Map(this.referencedBlockPaths(executionIds).map((relativePath) => {
      const file = this.#store.publicationFile(relativePath, { create: false });
      const observation = file === null ? null : this.#blocks.get(file.filePath);
      if (observation == null) fail("record-missing", "Request preparation lacks its validated physical observation");
      return [relativePath, observation.snapshot];
    }));
  }
  referencedBlockPaths(executionIds = null) {
    return [...this.#inventories].filter(([executionId]) => executionIds === null || executionIds.has(executionId))
      .flatMap(([executionId, retained]) => [...retained.physicalBlocks.keys()]
      .map((blockId) => `requests/${executionId}/blocks/${blockId}.json`));
  }
  completionEntry(executionId, requestId) { return this.#inventories.get(executionId)?.inventory.completionEntry(requestId) ?? null; }
  expandExecution(value) {
    const heads = RuntimeRequestHeads.fromExecution(value);
    const { requestHistoryHead, requestCompletionHead, ...execution } = value;
    if (Object.hasOwn(execution, "requests")) throw new TypeError("Revision 9 stores original request history by immutable section blocks");
    const inventory = this.readInventory(execution.executionId, heads.history, heads.completion);
    const preparation = new RuntimeRecordPreparation(runtimeRegistryObservationAuthority);
    return { ...execution, requests: inventory.requests.map((request) => preparation.requestValue(request)) };
  }
  unchanged(executionId) { return this.captureUnchangedExecutions([executionId]) !== null; }
  captureUnchangedExecutions(executionIds, additionalSnapshots = new Map(), expectedHeads = null) {
    const retained = new Map();
    const snapshots = new Map(additionalSnapshots);
    let same = true;
    for (const executionId of executionIds) {
      const observation = this.#inventories.get(executionId);
      if (observation === undefined) return null;
      if (expectedHeads !== null) {
        const heads = expectedHeads.get(executionId);
        for (const [expected, current] of [[heads.history, observation.inventory.historyHead],
          [heads.completion, observation.inventory.completionHead]]) {
          if (expected === null ? current !== null : !expected.matches(current)) return null;
        }
      }
      retained.set(executionId, observation.physicalBlocks);
      for (const [blockId, block] of observation.physicalBlocks) {
        const file = this.#store.requestBlockFile(executionId, blockId, { create: false });
        if (file === null) fail("record-missing", "A linked request block is missing");
        const observed = this.#blocks.get(file.filePath);
        if (observed?.block !== block) same = false;
        snapshots.set(file, observed?.snapshot ?? null);
      }
    }
    // Compare every byte and generation afresh before reusing these images.
    // The returned data serves only this synchronous read; it grants no effect
    // and does not make a later preparation/publication check unnecessary.
    const sameSnapshots = AtomicFile.snapshotsMatch(snapshots);
    const namespaces = this.assertBlockInventories(retained);
    if (!same || !sameSnapshots) return null;
    return new RuntimeCapturedRecords(new Map([...snapshots].map(([file, snapshot]) => [
      path.relative(this.#store.authority.directory, file.filePath).split(path.sep).join("/"), snapshot,
    ])), namespaces);
  }
  assertBlockInventory(executionId, blocks) {
    const directory = this.#store.requestBlockDirectory(executionId, { create: false });
    if (directory !== null) this.#assertBlockNames(directory.entries(), blocks);
  }
  #assertBlockNames(names, blocks) {
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name) || !blocks.has(name.slice(0, -5))) fail("record-corrupt", "A request block is outside its complete committed section inventory");
    }
  }
  assertBlockInventories(inventories) {
    const directories = new Map();
    for (const [executionId, blocks] of inventories) {
      const directory = this.#store.requestBlockDirectory(executionId, { create: false });
      if (directory !== null) directories.set(directory, blocks);
    }
    const observed = RealDirectoryAuthority.observeNames(directories.keys());
    for (const [index, blocks] of [...directories.values()].entries()) this.#assertBlockNames(observed[index].names, blocks);
    return new Map(observed.map(names => [path.relative(this.#store.authority.directory, names.directory).split(path.sep).join("/"), names]));
  }
  planExecution(execution, { requestPublications = new RuntimeRequestPublications(), importing = false } = {}) {
    const retained = importing ? undefined : this.#inventories.get(execution.executionId);
    const previousRequests = retained?.inventory.requests ?? [];
    const blocks = new Map(retained?.blocks ?? []), writes = new Map();
    let historyHead = retained?.inventory.historyHead ?? null;
    let completionHead = retained?.inventory.completionHead ?? null;
    const append = (section, Block, head) => {
      let block = head === null ? null : blocks.get(head.blockId);
      if (block !== null && block !== undefined) {
        const appended = block.append(section);
        block = appended.encodedByteLength() <= RUNTIME_REQUEST_BLOCK_SOFT_BYTES ? appended : null;
      }
      if (block === null || block === undefined) {
        const kind = Block === RuntimeRequestHistoryBlock ? "history" : "completion";
        block = new Block({ version: 9, executionId: execution.executionId,
          blockId: runtimeRequestBlockIdentity(section, kind), kind, sections: [section] });
      }
      // Soft packing does not constrain a single logical completion. Its exact
      // existing wire is kept unless that individual physical record overflows.
      if (!(block instanceof RuntimeRequestCompletionBlock) || block.sections.length !== 1) encodeRuntimeRecord(block);
      const plan = RuntimeRequestBlockEncodingPlan.create(block, { maximumBytes: MAX_REGISTRY_BYTES });
      block = plan.logicalBlock;
      blocks.set(block.blockId, block); writes.set(block.blockId, plan);
      return section.reference(block.blockId);
    };
    if (execution.requests.length < previousRequests.length) fail("record-corrupt", "Publication cannot drop original request history");
    const historyEntries = new Map();
    for (let index = 0; index < execution.requests.length; index++) {
      const request = execution.requests[index], previous = previousRequests[index];
      if (previous !== undefined && previous.requestId !== request.requestId) fail("record-corrupt", "Publication changed original request insertion order");
      const acceptance = new RuntimeRequestAcceptance({ requestId: request.requestId, operation: request.operation,
        payloadDigest: request.payloadDigest, authorizationDigest: request.authorizationDigest });
      let accepted = retained?.inventory.historyEntry(request.requestId) ?? null;
      if (accepted !== null && !accepted.section.acceptance.matches(acceptance)) fail("request-mismatch", "Publication changed an original acceptance identity");
      if (accepted === null) {
        if (!importing) {
          const standaloneFile = this.#store.requestFile(execution.executionId, request.requestId, { create: false });
          const standalone = standaloneFile === null ? null : readRuntimeRequest(standaloneFile, execution.executionId, request.requestId);
          if (standalone !== null && (standalone.operation !== request.operation || standalone.payloadDigest !== request.payloadDigest
            || standalone.authorizationDigest !== request.authorizationDigest || standalone.response !== null
            && !isDeepStrictEqual(json(standalone.response), json(request.response)))) fail("request-mismatch", "Request history differs from its original standalone acceptance");
        }
        const section = new RuntimeRequestHistorySection({ version: 9, executionId: execution.executionId, acceptance: json(acceptance), previous: json(historyHead) });
        historyHead = append(section, RuntimeRequestHistoryBlock, historyHead);
        accepted = new RuntimeRequestHistoryEntry(section, historyHead);
      }
      historyEntries.set(request.requestId, accepted);
      const completed = retained?.inventory.completionEntry(request.requestId) ?? null;
      if (completed !== null) {
        // Both sides are JSON values captured by their existing nominal request
        // records. Compare that complete data without another encode/parse pair.
        if (!isDeepStrictEqual(completed.completion.response, request.response)) fail("request-mismatch", "Publication changed an original completed response");
      } else if (request.response !== null) {
        encodeRuntimeRecord(request);
        const settledRequest = requestPublications.settlementFor(execution.executionId, request.requestId);
        const observedRequest = requestPublications.observationFor(execution.executionId, request.requestId);
        const settled = settledRequest !== null
          ? { callId: settledRequest.callId, outcome: settledRequest.outcome }
          : importing && request.operation === "finish" && request.response.ok === true ? importedCallSettlement(execution, request.response.value) : null;
        const section = new RuntimeRequestCompletionSection({ version: 9, executionId: execution.executionId, acceptance: json(acceptance),
          history: json(accepted.reference), previous: json(completionHead), response: request.response,
          observation: observedRequest?.executionId === execution.executionId && observedRequest.requestId === request.requestId
            ? { callId: observedRequest.callId, observation: observedRequest.observation } : null, settlement: settled });
        completionHead = append(section, RuntimeRequestCompletionBlock, completionHead);
      }
    }
    for (const completedRequest of requestPublications.completedRequests(execution.executionId)) {
      const request = completedRequest.request;
      if (historyEntries.has(request.requestId) || request.response === null) throw new TypeError("Standalone completion cannot change history membership");
      const section = new RuntimeRequestCompletionSection({ version: 9, executionId: execution.executionId,
        acceptance: json(new RuntimeRequestAcceptance({ requestId: request.requestId, operation: request.operation,
          payloadDigest: request.payloadDigest, authorizationDigest: request.authorizationDigest })),
        history: null, previous: json(completionHead), response: request.response, observation: null, settlement: null });
      completionHead = append(section, RuntimeRequestCompletionBlock, completionHead);
    }
    const inventory = new RuntimeRequestInventory({ executionId: execution.executionId, historyHead: json(historyHead), completionHead: json(completionHead), blocks });
    if (!isDeepStrictEqual(inventory.requests, execution.requests)) fail("record-corrupt", "Prepared block history differs from complete original logical requests");
    const observation = new RuntimeRequestStorageObservation(inventory, blocks);
    const physicalWrites = new Map();
    for (const plan of writes.values()) for (const record of plan.physicalRecords) {
      const previous = physicalWrites.get(record.blockId);
      if (previous !== undefined && previous.encodedRecord() !== record.encodedRecord()) fail("record-corrupt", "Request plans have conflicting physical storage identities");
      physicalWrites.set(record.blockId, record);
    }
    const { requests, ...physical } = execution.toJSON();
    return new PlannedRuntimeRequestExecution({ ...physical, ...new RuntimeRequestHeads({ history: historyHead, completion: completionHead }).toJSON() }, physicalWrites.values(), observation.inventory);
  }
  expandCall(executionId, value) {
    const { exitObservation, terminalRequest, revocationRequest, invocationRequest, failureRequest, failureConfirmed, ...call } = value;
    const inventory = this.#inventories.get(executionId)?.inventory;
    let observed = null;
    let receipt = null;
    let invocation = null;
    let failureReference = null;
    let terminal = null;
    if (failureConfirmed !== undefined && (failureRequest === undefined || failureConfirmed !== true)) {
      fail("record-corrupt", "Failure confirmation requires its exact failure reference");
    }
    if (invocationRequest !== undefined) {
      const document = inventory.completedRequest(invocationRequest);
      const source = RuntimeReservationInvocation.fromCompletion(document.completion);
      if (call.invocation !== null || source === null || !source.matchesCall(call)) {
        fail("record-corrupt", "Call invocation lacks its exact original reservation context");
      }
      call.invocation = document.completion.response.value.invocation;
      invocation = source.invocation;
    }
    if ([exitObservation, terminalRequest, revocationRequest].filter((entry) => entry !== undefined).length > 1) fail("record-corrupt", "Call has conflicting fact references");
    if (exitObservation !== undefined) {
      const document = inventory.completedRequest(exitObservation);
      if (call.observation !== null || document.acceptance.operation !== "observe" || document.completion.response.ok !== true
        || document.completion.observation?.callId !== call.callId) fail("record-corrupt", "Call observation lacks its exact accepted request fact");
      observed = document.completion.observation.observation;
      call.observation = json(observed);
    }
    if (terminalRequest !== undefined) {
      const document = inventory.completedRequest(terminalRequest);
      if ([call.observation, call.output, call.receipt, call.outcome].some((field) => field !== null)
        || document.completion.settlement?.callId !== call.callId) fail("record-corrupt", "Terminal call differs from its exact accepted finish fact");
      const original = document.completion.response.value;
      receipt = document.completion.settlementReceipt;
      terminal = document.completion;
      Object.assign(call, { observation: original.observation, output: original.output,
        receipt: original, outcome: document.completion.settlement.outcome });
    }
    if (revocationRequest !== undefined) {
      const document = inventory.completedRequest(revocationRequest);
      if (call.revocation !== null || document.acceptance.operation !== "revoke-reservation" || document.completion.response.ok !== true
        || document.completion.response.value?.callId !== call.callId) fail("record-corrupt", "Revocation differs from its exact accepted response");
      call.revocation = json(document.completion.response.value);
    }
    if (failureRequest !== undefined) {
      if (call.controlFailure !== null) fail("record-corrupt", "Failure reference conflicts with its literal value");
      failureReference = new RuntimeCallFailureReference(inventory, inventory.completedRequest(failureRequest), call, failureConfirmed === true);
      call.controlFailure = failureReference.value;
    }
    return new RuntimeRecordPreparation(runtimeRegistryObservationAuthority).callValue(call, { observed, receipt, invocation, failureReference, terminal });
  }
  publish(blocks) {
    for (const block of blocks) {
      const file = this.#store.requestBlockFile(block.executionId, block.blockId);
      const previous = this.#blocks.get(file.filePath);
      if (previous !== undefined && !previous.matches(file.readSnapshot())) fail("authority-mismatch", "Request block changed its exact generation before append");
      const guard = file.commitGuard;
      file.commitGuard = (event) => {
        guard(event);
        if (previous !== undefined && !previous.matches(file.readSnapshot())) fail("authority-mismatch", "Request block changed its exact generation before publication");
      };
      file.write(encodeRuntimeRecord(block), { exclusive: previous === undefined });
    }
  }
}

/** Namespace-bound bytes only; this value carries no physical generation or authority. */
export class ProcessExecutionRuntimeRequestBlockData {
  #payload;
  constructor(relativePath, bytes) {
    const match = typeof relativePath === "string" ? /^requests\/([^/]+)\/blocks\/([^/]+)\.json$/.exec(relativePath) : null;
    if (match === null) throw new TypeError("Request block data requires its exact relative storage path");
    this.relativePath = relativePath;
    this.executionId = uuid(match[1], "request data execution ID");
    this.blockId = uuid(match[2], "request data block ID");
    this.#payload = decodeRuntimeRequestBlockPayload(Buffer.from(bytes), relativePath);
    Object.freeze(this);
  }
  decode(evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) { return restoreRuntimeRequestPhysicalRecord(this.#payload, this.executionId, this.blockId, evidenceCodec); }
}

/** The normal chain decoder over supplied data, without filesystem observations. */
class RuntimeRequestDataStorage extends RuntimeRequestStorage {
  #blocksByExecution = new Map();
  #readExecutions = new Set();
  constructor(values, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    super(null, evidenceCodec);
    for (const value of values) {
      if (!(value instanceof ProcessExecutionRuntimeRequestBlockData)) throw new TypeError("Logical inventory requires typed namespace-bound request block data");
      let blocks = this.#blocksByExecution.get(value.executionId);
      if (blocks === undefined) { blocks = new Map(); this.#blocksByExecution.set(value.executionId, blocks); }
      if (blocks.has(value.blockId)) fail("record-corrupt", "Request data contains a duplicate block namespace");
      blocks.set(value.blockId, value.decode(evidenceCodec));
    }
  }
  readPhysicalRecord(executionId, blockId) {
    const block = this.#blocksByExecution.get(executionId)?.get(blockId);
    if (block === undefined) fail("record-missing", "A linked request block is missing");
    return block;
  }
  assertBlockInventory(executionId, blocks) {
    const provided = this.#blocksByExecution.get(executionId) ?? new Map();
    if (provided.size !== blocks.size || [...provided].some(([blockId, block]) => blocks.get(blockId) !== block)) fail("record-corrupt", "A request block is outside its complete committed section inventory");
    this.#readExecutions.add(executionId);
  }
  assertComplete() {
    if ([...this.#blocksByExecution.keys()].some((executionId) => !this.#readExecutions.has(executionId))) fail("record-corrupt", "Request data contains an execution outside the logical inventory");
  }
}

function importedCallSettlement(execution, receipt) {
  const call = execution.calls.find((entry) => entry.callId === receipt?.callId);
  return call !== undefined && call.receipt !== null && isDeepStrictEqual(json(call.receipt), receipt) ? { callId: call.callId, outcome: call.outcome } : null;
}

// Only complete nominal registry freezes performed here prove event-value
// immutability. Shallow freezes, mutable shells and physical input literals do
// not establish this provenance and always take the complete derivation path.
const immutableRuntimeCallRecords = new WeakSet();
const immutableRuntimeRequestRecords = new WeakSet();
const validatedRuntimeCallReceipts = new WeakSet();
/** Call-local facts can repeat only on this module's complete frozen record.
 * Root identity, lineage, current descendants and event closure stay outside
 * this proof and are checked against every newly assembled global inventory.
 */
function assertRuntimeCallReceipt(call) {
  const immutable = immutableRuntimeCallRecords.has(call);
  if (immutable && validatedRuntimeCallReceipts.has(call)) return;
  const receipt = call.receipt;
  if (!receipt.binding.matches(call.binding)
    || !new ProcessExecutionInvocationDisclosure({ invocation: receipt.invocation, invocationDigest: receipt.invocationDigest }).matchesPrivate(call.invocation)
    || !isDeepStrictEqual(json(receipt.observation), json(call.observation))
    || !isDeepStrictEqual(json(receipt.output), json(call.output))
    || !receipt.executor.matches(call.executor)
    || !isDeepStrictEqual(json(receipt.stopOperation), json(call.stopOperation))
    || receipt.outcomeDigest !== digest(call.outcome)) throw new TypeError("Stop receipt disagrees with durable call facts");
  if (immutable) validatedRuntimeCallReceipts.add(call);
}
const runtimeCallEventPayloads = new WeakMap();
// Captured JSON and restored nominal values retain their exact serializer order
// independently. Neither cache accepts a replaced receipt/output/outcome field.
const rawRuntimeTerminalEventPayloads = new WeakMap();
const typedRuntimeTerminalEventPayloads = new WeakMap();
function freezeRuntimeRegistry(registry) {
  freezeExecutionValue(registry);
  for (const execution of registry.executions) {
    for (const call of execution.calls) immutableRuntimeCallRecords.add(call);
    for (const request of execution.requests) immutableRuntimeRequestRecords.add(request);
  }
  return registry;
}

/** Event producers and the lossless stored projection share the same payload. */
class RuntimeCallEventPayload {
  constructor(value) {
    this.value = freezeExecutionValue(json(value));
    this.encoding = new ProcessExecutionValueEncoding(this.value);
    Object.freeze(this);
  }
  toJSON() { return this.value; }
  static require(call, type, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    const payload = this.fromCall(call, type, evidenceCodec);
    if (payload === null) throw new TypeError("Runtime event requires its exact current call fact");
    return payload.toJSON();
  }
  static fromCall(call, type, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    const immutable = immutableRuntimeCallRecords.has(call);
    const retained = immutable ? runtimeCallEventPayloads.get(call) : undefined;
    if (retained?.has(type)) return retained.get(type);
    const source = type === "result-finalized" ? runtimeCallTerminalSource(call) : null;
    const typed = source !== call[runtimeRecordOrigin];
    const terminal = source?.matchesTerminal(call, typed) ? source.terminal : null;
    const terminalPayloads = typed ? typedRuntimeTerminalEventPayloads : rawRuntimeTerminalEventPayloads;
    if (terminal !== null && terminalPayloads.has(terminal)) return terminalPayloads.get(terminal);
    let value;
  switch (type) {
    case "reserved": value = ProcessExecutionInvocationDisclosure.capture(preparedRuntimeFieldValue(call, "invocation")).toJSON(); break;
    case "started": value = { startedAt: call.startedAt }; break;
    case "spawn-failed":
    case "exited": value = json(call.observation); break;
    case "stop-requested":
      if (call.stopOperation === null) return null;
      value = { reason: call.stopOperation.reason, graceMs: call.stopOperation.graceMs }; break;
    case "stop-unconfirmed":
      if (call.stopOperation === null) return null;
      value = { reason: call.stopOperation.reason }; break;
    case "result-finalized": {
      if (callCompletion(call) === null) return null;
      const revoked = call.revocation !== null;
      const receipt = preparedRuntimeFieldValue(call, "receipt");
      const fact = revoked
        ? call.revocation instanceof ProcessExecutionReservationRevocation ? call.revocation : evidenceCodec.revocation(call.revocation)
        : receipt instanceof ProcessExecutionStopReceipt ? receipt : evidenceCodec.receipt(call.receipt);
      const closure = ProcessExecutionCallClosure.fromFact(fact).toJSON();
      value = revoked ? { ...closure, completion: "revoked-before-launch" }
        : { ...closure, output: call.output ?? null, outcome: call.outcome ?? null };
      break;
    }
    default: throw new TypeError("Unknown runtime call event type");
  }
    const payload = new this(value);
    if (immutable) {
      const payloads = retained ?? new Map();
      payloads.set(type, payload); runtimeCallEventPayloads.set(call, payloads);
    }
    if (terminal !== null) terminalPayloads.set(terminal, payload);
    return payload;
  }
}
class RuntimeStoredEvent {
  static #encodings = new WeakMap();
  constructor(binding, payload, value) {
    this.binding = binding; this.payload = payload;
    this.value = Object.freeze(value);
    Object.freeze(this);
  }
  static encode(event, call) {
    const payload = RuntimeCallEventPayload.fromCall(call, event.type);
    const previous = this.#encodings.get(event);
    // Both the event and its derived payload own normalized immutable JSON.
    // The existing payload owner rechecks mutable call facts, or proves exact
    // terminal-field provenance, before this exact-context projection can recur.
    if (previous?.binding === call.binding && previous.payload === payload) return previous.value;
    const value = { ...event.toEncodingValue() };
    if (new ProcessExecutionValueEncoding(value.binding).matches(new ProcessExecutionValueEncoding(call.binding))) delete value.binding;
    if (payload !== null && new ProcessExecutionValueEncoding(value.payload).matches(payload.encoding)) delete value.payload;
    const encoding = new this(call.binding, payload, value);
    this.#encodings.set(event, encoding);
    return encoding.value;
  }
  static expand(value, call, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    if (call === undefined) fail("record-corrupt", "Stored event references a missing call");
    return { ...value,
      binding: Object.hasOwn(value, "binding") ? value.binding : json(call.binding),
      payload: Object.hasOwn(value, "payload") ? value.payload : RuntimeCallEventPayload.require(call, value.type, evidenceCodec) };
  }
}

function readRuntimeRequest(file, executionId, requestId) {
  const saved = readJson(file, false);
  return saved === null ? null : RuntimeStandaloneRequestDocument.fromEnvelope(executionId, requestId, saved).requestRecord();
}
function encodeRuntimeRequest(executionId, request) {
  return encodeRuntimeRecord(new RuntimeStandaloneRequestDocument({ executionId, ...request.toJSON() }));
}

class ProcessExecutionFinalizationFence {
  constructor(value, preparation = null) {
    const { fenceId } = preparation === null ? value : preparation.scalars(value, ["fenceId"]);
    this.fenceId = uuid(fenceId, "finalization fence");
    this.selection = restoreRuntimeField(value, "selection", (field) => new ProcessExecutionBindingSelection(field), preparation);
    this.cutoff = restoreRuntimeField(value, "cutoff", (field) => field === null ? null : ProcessExecutionFinalizationCutoff.fromStored(field), preparation);
    this.barrier = restoreRuntimeField(value, "barrier", (field) => field === null ? null : ProcessExecutionFinalizationBarrier.fromStored(field), preparation);
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
  constructor(value, preparation = null, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    const { executionId, ownerEpoch, rootCapability, runId, specId,
      accepting, status, recoveryFence, hostConnected } = preparation === null ? value : preparation.scalars(value,
      ["executionId", "ownerEpoch", "rootCapability", "runId", "specId", "accepting", "status", "recoveryFence", "hostConnected"]);
    this.executionId = uuid(executionId, "executionId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Execution owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.coordinatorIdentity = restoreRuntimeField(value, "coordinatorIdentity", (field) => new LockOwnerSession(field), preparation);
    this.rootCapability = uuid(rootCapability, "root capability");
    // Closed history retains the endpoint's structure without reopening its
    // live filesystem authority. Only live grants/admission require that proof.
    this.endpoint = restoreRuntimeField(value, "endpoint", (field) => new ProcessExecutionControlEndpoint(field).toJSON(), preparation);
    for (const value of [runId, specId]) if (value !== null && (typeof value !== "string" || value === "")) throw new TypeError("Runtime run/spec identity is invalid");
    Object.assign(this, { runId, specId });
    this.binding = restoreRuntimeField(value, "binding", (field) => ProcessExecutionBinding.from(field), preparation);
    if (typeof accepting !== "boolean" || typeof hostConnected !== "boolean" || !["active", "stopping", "closed"].includes(status)) throw new TypeError("Execution admission state is invalid");
    Object.assign(this, { accepting, status, hostConnected });
    const recordPreparation = preparation ?? new RuntimeRecordPreparation(runtimeRegistryObservationAuthority);
    this.calls = restoreRuntimeRecords(value.calls, (call) => recordPreparation.record(call, PhysicalCallRecord, () => new PhysicalCallRecord(call, { executionId,
      preparation: call[runtimeRecordOrigin] === undefined ? preparation : recordPreparation, evidenceCodec })), preparation);
    // Reused child facts belonged to their original enclosing execution. Check
    // the current failure binding before other root invariants can mask it.
    for (const call of this.calls) {
      if (call.controlFailure !== null) evidenceCodec.failure(json(call.controlFailure), { executionId, callId: call.callId });
    }
    this.requests = restoreRuntimeRecords(value.requests, (request) => recordPreparation.record(request, RuntimeRequestRecord, () => new RuntimeRequestRecord(request,
      request[runtimeRecordOrigin] === undefined ? preparation : recordPreparation)), preparation);
    this.events = restoreRuntimeList(value, "events", (field) => ProcessExecutionEvent.fromStored(field), preparation);
    this.eventAcknowledgements = restoreRuntimeList(value, "eventAcknowledgements", (field) => ProcessExecutionCanonicalAcknowledgement.fromStored(field), preparation);
    this.runtimeOnlyDispositions = restoreRuntimeList(value, "runtimeOnlyDispositions", (field) => ProcessExecutionRuntimeOnlyDisposition.fromStored(field), preparation);
    this.recoveryFence = recoveryFence === null ? null : uuid(recoveryFence, "recovery fence");
    this.finalizationFences = restoreRuntimeRecords(value.finalizationFences, (fence) => exact(preparation === null ? fence : json(fence), new ProcessExecutionFinalizationFence(fence, preparation)), preparation);
    this.closure = restoreRuntimeField(value, "closure", json, preparation);
    if (new Set(this.calls.map((call) => call.callId)).size !== this.calls.length
      || new Set(this.requests.map((request) => request.requestId)).size !== this.requests.length
      || new Set(this.events.map((event) => event.eventId)).size !== this.events.length
      || new Set(this.finalizationFences.map((fence) => fence.selection.digest)).size !== this.finalizationFences.length
      || new Set(this.eventAcknowledgements.map((fact) => fact.eventId)).size !== this.eventAcknowledgements.length
      || new Set(this.runtimeOnlyDispositions.map((fact) => fact.eventId)).size !== this.runtimeOnlyDispositions.length) throw new TypeError("Runtime inventory contains duplicate identities");
    const callIndex = new PhysicalCallIndex(this.calls);
    const eventsById = new Map(this.events.map((event) => [event.eventId, event]));
    const acknowledgedEventIds = new Set(this.eventAcknowledgements.map((fact) => fact.eventId));
    if (this.events.some((event, index) => event.sequence !== index + 1 || event.executionId !== executionId
      || !callIndex.has(event.callId))
      || [...this.eventAcknowledgements, ...this.runtimeOnlyDispositions].some((fact) => !fact.matches(eventsById.get(fact.eventId)))
      || this.runtimeOnlyDispositions.some((fact) => acknowledgedEventIds.has(fact.eventId))) throw new TypeError("Runtime event outbox is invalid");
    for (const fence of this.finalizationFences) {
      if (fence.cutoff === null) continue;
      const expected = finalizationInventory(this, fence);
      // Unrelated unbound cleanup can advance the execution-global sequence.
      expected.cutoffSequence = fence.cutoff.cutoffSequence;
      if (fence.cutoff.cutoffSequence > this.events.length
        || this.calls.some((call) => fence.selection.matches(call.binding) && callCompletion(call) === null)
        || !isDeepStrictEqual(expected, fence.cutoff.inventory())
        || fence.barrier !== null && fence.barrier.events.some((event) => !acknowledgedEventIds.has(event.eventId))) throw new TypeError("Finalization cutoff differs from the sealed selected receipts or acknowledged events");
    }
    if ((status !== "active" || recoveryFence !== null || !hostConnected) && accepting) throw new TypeError("Fenced execution accepts new calls");
    if (status === "closed") {
      if (this.closure === null || this.calls.some((call) => callCompletion(call) === null)
        || !isDeepStrictEqual(this.closure, { executionId, ownerEpoch,
          callClosures: this.calls.map((call) => ProcessExecutionCallClosure.fromFact(callCompletion(call)).toJSON()), recovery: this.closure.recovery })
        || typeof this.closure.recovery !== "boolean") throw new TypeError("Closed execution lacks exact termination receipts");
    } else if (this.closure !== null) throw new TypeError("Unfinished execution has a closure receipt");
    for (const call of this.calls) {
      let parentId = call.parentCallId;
      const seen = new Set([call.callId]);
      while (parentId !== null) {
        if (seen.has(parentId)) throw new TypeError("Nested call lineage is cyclic");
        seen.add(parentId);
        const parent = callIndex.get(parentId);
        if (!parent) throw new TypeError("Nested call lineage is missing");
        parentId = parent.parentCallId;
      }
      if (call.permit && !call.permit.matches(new ProcessExecutionStartPermit({ executionId, callId: call.callId,
        ownerEpoch, ownerToken: this.coordinatorIdentity.ownerToken, capability: call.capability,
        bindingDigest: call.binding.digest }))) throw new TypeError("Start permit binding is invalid");
      if (call.revocation) {
        if (call.revocation.executionId !== executionId || call.revocation.callId !== call.callId || call.revocation.ownerEpoch !== ownerEpoch
          || !call.revocation.binding.matches(call.binding) || !new ProcessExecutionInvocationDisclosure({ invocation: call.revocation.invocation, invocationDigest: call.revocation.invocationDigest }).matchesPrivate(call.invocation)
          || !isDeepStrictEqual(json(call.revocation.stopOperation), json(call.stopOperation)) || descendantsOf(this, call, callIndex).length !== 0) throw new TypeError("Revocation disagrees with its unclaimed reservation");
      }
      if (callCompletion(call) !== null) {
        const event = this.events[callCompletion(call).closureRevision - 1];
        const closure = ProcessExecutionCallClosure.fromFact(callCompletion(call));
        if (event?.type !== "result-finalized" || event.callId !== call.callId || event.payload.closureKind !== closure.closureKind
          || event.payload.closureDigest !== closure.closureDigest) throw new TypeError("Call closure differs from its exact durable result event");
      }
      if (call.receipt) {
        assertRuntimeCallReceipt(call);
        const descendantCalls = descendantsOf(this, call, callIndex);
        const descendants = descendantCalls.map((entry) => ProcessExecutionCallClosure.fromFact(callCompletion(entry)).toJSON());
        if (call.receipt.executionId !== executionId || call.receipt.callId !== call.callId || call.receipt.ownerEpoch !== ownerEpoch
          || descendantCalls.some((entry) => callCompletion(entry) === null)
          || !isDeepStrictEqual(json(call.receipt.descendants), descendants)) throw new TypeError("Stop receipt disagrees with durable call facts");
      }
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
  pendingEvents() {
    const published = new Set([...this.eventAcknowledgements, ...this.runtimeOnlyDispositions].map((fact) => fact.eventId));
    return this.events.filter((event) => !published.has(event.eventId));
  }
  hasCanonicalAcknowledgement(eventId) { return this.eventAcknowledgements.some((fact) => fact.eventId === eventId); }
  hasRuntimeOnlyDisposition(eventId) { return this.runtimeOnlyDispositions.some((fact) => fact.eventId === eventId); }
  toJSON() { return { executionId: this.executionId, ownerEpoch: this.ownerEpoch, coordinatorIdentity: this.coordinatorIdentity,
    rootCapability: this.rootCapability, endpoint: this.endpoint, runId: this.runId, specId: this.specId, binding: this.binding.toJSON(),
    accepting: this.accepting, status: this.status, hostConnected: this.hostConnected, calls: this.calls, closure: this.closure,
    requests: this.requests, events: this.events.map((event) => event.toEncodingValue()), eventAcknowledgements: this.eventAcknowledgements, runtimeOnlyDispositions: this.runtimeOnlyDispositions, recoveryFence: this.recoveryFence,
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
  return root.pendingEvents().some((event) => event.binding.value !== null);
}
/** A local view of one call inventory, never retained across registry changes. */
class PhysicalCallIndex {
  #byId = new Map();
  #children = new Map();
  constructor(calls) {
    for (const call of calls) {
      this.#byId.set(call.callId, call);
      if (!this.#children.has(call.parentCallId)) this.#children.set(call.parentCallId, []);
      this.#children.get(call.parentCallId).push(call);
    }
  }
  has(callId) { return this.#byId.has(callId); }
  get(callId) { return this.#byId.get(callId); }
  descendants(call) {
    const result = []; const pending = [call.callId];
    for (let index = 0; index < pending.length; index += 1) {
      for (const child of this.#children.get(pending[index]) ?? []) { result.push(child); pending.push(child.callId); }
    }
    return result;
  }
  descendantMeasures(measure) {
    const remaining = new Map([...this.#byId].map(([id]) => [id, this.#children.get(id)?.length ?? 0]));
    const totals = new Map([...this.#byId].map(([id]) => [id, 0]));
    const ready = [...this.#byId.values()].filter((call) => remaining.get(call.callId) === 0);
    for (let index = 0; index < ready.length; index += 1) {
      const call = ready[index], parent = this.#byId.get(call.parentCallId);
      if (parent === undefined) continue;
      totals.set(parent.callId, totals.get(parent.callId) + measure(call) + totals.get(call.callId));
      remaining.set(parent.callId, remaining.get(parent.callId) - 1);
      if (remaining.get(parent.callId) === 0) ready.push(parent);
    }
    return totals;
  }
}
function descendantsOf(root, call, index = new PhysicalCallIndex(root.calls)) {
  return index.descendants(call);
}

/** The call's control facts; publication comparison grants no execution authority. */
class RuntimeCallControlState {
  constructor(root, call, index = new PhysicalCallIndex(root.calls)) {
    this.executionId = root.executionId;
    this.callId = call.callId;
    this.ownerEpoch = root.ownerEpoch;
    this.rootStatus = root.status;
    this.rootAccepting = root.accepting;
    this.hostConnected = root.hostConnected;
    this.recoveryFence = root.recoveryFence;
    this.status = call.status;
    this.aborted = call.aborted;
    this.stopOperation = call.stopOperation;
    this.exited = call.observation !== null;
    this.completed = callCompletion(call) !== null;
    this.descendantsSettled = descendantsOf(root, call, index).every((entry) => callCompletion(entry) !== null);
    this.controlFailure = call.controlFailure;
    Object.freeze(this);
  }
  get publicationDigest() { return digest(this); }
  reply(now) {
    const stopRemainingMs = this.stopOperation?.remainingMs(now) ?? null;
    const stopSignal = this.stopOperation === null || !this.descendantsSettled || this.exited || this.completed
      ? null : this.stopOperation.signalAt(now);
    return { stopSignal, stopRequested: this.stopOperation !== null, stopRemainingMs,
      timedOut: this.stopOperation?.reason === "timeout", aborted: this.aborted,
      descendantsSettled: this.descendantsSettled, status: this.status, controlFailure: this.controlFailure?.toJSON() ?? null };
  }
}

class RuntimeRegistry {
  constructor(value, preparation = null, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    const { version, ownerEpoch, slot } = preparation === null ? value : preparation.scalars(value, ["version", "ownerEpoch", "slot"]);
    if (version !== RUNTIME_RECORD_VERSION) fail("record-unsupported", "Legacy process ownership evidence cannot authorize registered-child execution; explicit investigation is required");
    this.version = version;
    this.checkout = restoreRuntimeField(value, "checkout", (field) => evidenceCodec.checkout(field), preparation);
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) throw new TypeError("Runtime owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.slot = slot === null ? null : uuid(slot, "checkout slot");
    this.executions = restoreRuntimeRecords(value.executions, (execution) => new RootExecutionRecord(execution, preparation, evidenceCodec), preparation);
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
  constructor({ version, checkout, execution }, evidenceCodec = CURRENT_PROCESS_EXECUTION_EVIDENCE) {
    if (version !== RUNTIME_RECORD_VERSION) fail("record-unsupported", "Legacy process archive cannot authorize registered-child execution");
    this.version = version;
    this.checkout = evidenceCodec.checkout(checkout);
    this.execution = new RootExecutionRecord(execution, null, evidenceCodec);
    if (this.execution.status !== "closed" || hasPendingBoundEvents(this.execution) || this.execution.calls.some((call) => !callCompletion(call).checkoutIdentity.matches(this.checkout))) throw new TypeError("Archive lacks exact closed checkout receipts");
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, checkout: this.checkout, execution: this.execution }; }
}
function sameRuntimeRecordSnapshot(expected, actual) {
  return expected.hasSameFileVersion(actual);
}

const runtimeRegistryObservationAuthority = Symbol("runtime registry observation");
const runtimeRecordOrigin = Symbol("validated runtime record origin");

/** A typed value already checked against this exact immutable input JSON. */
class RuntimePreparedField {
  constructor(input, value) { this.input = input; this.value = value; Object.freeze(this); }
}
function preparedRuntimeField(record, key) {
  const field = record[runtimeRecordOrigin]?.[key];
  return field instanceof RuntimePreparedField && field.input === record[key] ? field : null;
}
function preparedRuntimeFieldValue(record, key) {
  const field = preparedRuntimeField(record, key);
  return field === null ? record[key] : field.value;
}

/** These proofs never replace the raw shell used by the final exact comparison. */
class RuntimePreparedCallFields {
  constructor(call, { observed, receipt, invocation = null, failureReference = null, terminal = null }) {
    const captured = invocation ?? ProcessExecutionCapturedInvocation.capture(call.invocation);
    this.invocation = new RuntimePreparedField(call.invocation, captured.value);
    this.failureReference = failureReference;
    this.terminal = terminal;
    if (receipt !== null) {
      this.receipt = new RuntimePreparedField(call.receipt, receipt);
      this.observation = new RuntimePreparedField(call.observation, receipt.observation);
      this.output = new RuntimePreparedField(call.output, receipt.output);
      this.outcome = new RuntimePreparedField(call.outcome, call.outcome);
    } else if (observed !== null) this.observation = new RuntimePreparedField(call.observation, observed);
    Object.freeze(this);
  }
  matchesTerminal(call, typed) {
    if (this.terminal === null || this.receipt === undefined
      || this.terminal.settlementReceipt !== this.receipt.value
      || this.terminal.settlement?.outcome !== this.outcome?.value
      || this.output?.value !== this.receipt.value.output || call.revocation !== null) return false;
    const field = typed ? "value" : "input";
    return ["receipt", "output", "outcome"].every(name => call[name] === this[name][field]);
  }
}
function runtimeCallTerminalSource(call) {
  const origin = call[runtimeRecordOrigin];
  return origin instanceof RuntimePreparedCallFields ? origin
    : runtimeCallTerminalSources.get(call) ?? runtimeCallTerminalSources.get(origin) ?? null;
}

/** Equality already proved for a live typed publication, without a raw origin. */
class RuntimeSettledCallProjection {
  constructor(call, document, authority) {
    if (authority !== runtimeRegistryObservationAuthority || !immutableRuntimeCallRecords.has(call)) {
      throw new TypeError("Terminal projection requires its validated immutable call");
    }
    this.terminal = document.completion; this.reference = document.completionLink();
    this.receipt = call.receipt; this.output = call.output; this.outcome = call.outcome;
    Object.freeze(this);
  }
  matchesTerminal(call, typed) {
    return typed && call.revocation === null && call.receipt === this.receipt
      && call.output === this.output && call.outcome === this.outcome;
  }
  preserves(document) {
    return this.terminal.executionId === document.completion.executionId
      && this.terminal.acceptance.matches(document.completion.acceptance)
      && this.reference.matches(document.completionLink());
  }
  static canReference(call, document) {
    const completion = document.completion, source = runtimeCallTerminalSource(call);
    const sameSource = source instanceof RuntimeSettledCallProjection ? source.preserves(document) : source?.terminal === completion;
    if (sameSource && source.matchesTerminal(call, true)) return true;
    if (!isDeepStrictEqual(json(call.receipt), completion.response.value)
      || !isDeepStrictEqual(json(call.outcome), completion.settlement.outcome)) return false;
    if (immutableRuntimeCallRecords.has(call)) {
      runtimeCallTerminalSources.set(call, new this(call, document, runtimeRegistryObservationAuthority));
    }
    return true;
  }
}

/** Publication may reuse only facts belonging to the exact frozen source of a shell. */
class RuntimeRecordPreparation {
  static #requestRecords = new WeakMap();
  constructor(authority) {
    if (authority !== runtimeRegistryObservationAuthority) throw new TypeError("Runtime preparation requires observation authority");
  }
  requestRecord(history, completion) {
    const captured = RuntimeRecordPreparation.#requestRecords.get(history);
    if (captured?.input === completion) return captured.value;
    const value = { ...history.acceptance.toJSON(), response: completion?.response ?? null };
    // The complete section has already passed its exact codec and current
    // physical block capture. Reuse only that section's frozen original value.
    Object.defineProperty(value, runtimeRecordOrigin, { value: completion ?? history });
    const record = Object.freeze(new RuntimeRequestRecord(value, this));
    RuntimeRecordPreparation.#requestRecords.set(history, new RuntimePreparedField(completion, record));
    return record;
  }
  requestValue(record) { return mutableRuntimeRecordShell(record, runtimeRegistryObservationAuthority, { plain: true }); }
  callValue(record, facts) {
    Object.defineProperty(record, runtimeRecordOrigin, { value: new RuntimePreparedCallFields(record, facts) });
    return record;
  }
  record(record, Record, restore) {
    const origin = record?.[runtimeRecordOrigin];
    if (origin !== undefined && Object.getPrototypeOf(origin) === Record.prototype && Object.isFrozen(origin)) {
      const keys = Object.keys(origin);
      if (Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key) && record[key] === origin[key])) return origin;
    }
    return restore();
  }
  scalars(record, keys) { return json(Object.fromEntries(keys.map((key) => [key, record[key]]))); }
  field(record, key, restore) {
    const prepared = preparedRuntimeField(record, key);
    if (prepared !== null) return prepared.value;
    const origin = record[runtimeRecordOrigin];
    return origin !== undefined && record[key] === origin[key] ? record[key]
      : restore(record[key] === undefined ? undefined : json(record[key]));
  }
  list(record, key, restore) {
    const origins = new Set(record[runtimeRecordOrigin]?.[key] ?? []);
    return this.records(record[key], (field) => origins.has(field) ? field : restore(json(field)));
  }
  // Whole-record JSON normalization used to turn array holes into explicit nulls.
  records(values, restore) { return Array.from(values.map((field) => field), (field) => restore(field === undefined ? null : field)); }
}
function restoreRuntimeField(record, key, restore, preparation) {
  return preparation === null ? restore(record[key]) : preparation.field(record, key, restore);
}
function restoreRuntimeList(record, key, restore, preparation) {
  return preparation === null ? record[key].map(restore) : preparation.list(record, key, restore);
}
function restoreRuntimeRecords(values, restore, preparation) {
  return preparation === null ? values.map(restore) : preparation.records(values, restore);
}

// Only an existing observation may detach its fully validated, deeply frozen
// graph. Record classes above own every mutable container; nested facts are
// shared immutable values and updates replace them rather than changing them.
function mutableRuntimeRecordShell(record, authority, { plain = false } = {}) {
  if (authority !== runtimeRegistryObservationAuthority || !Object.isFrozen(record)
    || Object.hasOwn(record, runtimeRecordOrigin)
    || ![RuntimeRegistry, RootExecutionRecord, PhysicalCallRecord, RuntimeRequestRecord, ProcessExecutionFinalizationFence]
      .some((Record) => Object.getPrototypeOf(record) === Record.prototype)) {
    throw new TypeError("Mutable runtime records require a validated immutable observation");
  }
  const shell = Object.assign(plain ? {} : Object.create(Object.getPrototypeOf(record)), record);
  Object.defineProperty(shell, runtimeRecordOrigin, { value: record });
  return shell;
}


function planStoredRuntimeExecution(storage, execution, options = {}) {
    const planned = storage.planExecution(execution, options);
    const observations = new Map(), revocations = new Map(), reservations = new Map(), failures = new Map();
    for (const document of planned.inventory.completions) {
      const completion = document.completion;
      const failure = RuntimeRequestFailureSource.fromCompletion(completion);
      if (failure !== null) {
        let sources = failures.get(failure.callId);
        if (sources === undefined) { sources = []; failures.set(failure.callId, sources); }
        sources.push(document);
      }
      const reservation = RuntimeReservationInvocation.fromCompletion(completion);
      if (reservation !== null) {
        let sources = reservations.get(reservation.call.callId);
        if (sources === undefined) { sources = []; reservations.set(reservation.call.callId, sources); }
        sources.push(document);
      }
      if (completion.observation !== null && !observations.has(completion.observation.callId)) observations.set(completion.observation.callId, document);
      if (document.acceptance.operation === "revoke-reservation" && completion.response.ok === true) {
        const callId = completion.response.value?.callId;
        if (!revocations.has(callId)) revocations.set(callId, document);
      }
    }
    planned.execution.calls = execution.calls.map((call) => {
      const physical = call.toJSON();
      if (call.controlFailure !== null) {
        const encoding = new ProcessExecutionValueEncoding(call.controlFailure);
        const prior = runtimeCallFailureReferences.get(call);
        let selected = null;
        for (const confirmed of [false, true]) {
          for (const document of failures.get(call.callId) ?? []) {
            const source = RuntimeRequestFailureSource.fromCompletion(document.completion);
            const value = confirmed ? source.confirmedValue() : source.value;
            const retained = prior?.preserves(document, confirmed) && prior.matchesFailure(call.controlFailure);
            if (value === null || !retained && !encoding.matches(confirmed ? new ProcessExecutionValueEncoding(value) : source.encoding)) continue;
            if (confirmed && (!planned.inventory.confirmsFailure(document, call) || options.importing || !(retained || options.requestPublications?.confirmsFirstSettlement(call)))) continue;
            const reference = new RuntimeCallFailureReference(planned.inventory, document, call, confirmed);
            const fields = { failureRequest: reference.reference, ...(confirmed ? { failureConfirmed: true } : {}) };
            if (Buffer.byteLength(encoding.text()) <= 4 + Buffer.byteLength(JSON.stringify(fields)) - 1) continue;
            selected = fields; break;
          }
          if (selected !== null) break;
        }
        if (selected !== null) Object.assign(physical, { controlFailure: null, ...selected });
      }
      for (const document of reservations.get(call.callId) ?? []) {
        const source = RuntimeReservationInvocation.fromCompletion(document.completion);
        const reference = document.completionLink();
        if (source.canReference(call, reference)) {
          Object.assign(physical, { invocation: null, invocationRequest: reference });
          break;
        }
      }
      const settled = planned.inventory.settlementEntry(call.callId), observed = observations.get(call.callId), revoked = revocations.get(call.callId);
      if (call.receipt !== null && settled !== null
        && RuntimeSettledCallProjection.canReference(call, settled)) {
        Object.assign(physical, { observation: null, output: null, receipt: null, outcome: null, terminalRequest: settled.completionLink() });
      } else if (call.receipt === null && call.observation !== null && observed !== undefined
        && isDeepStrictEqual(json(call.observation), json(observed.completion.observation.observation))) {
        Object.assign(physical, { observation: null, exitObservation: observed.completionLink() });
      } else if (call.revocation !== null && revoked !== undefined && isDeepStrictEqual(json(call.revocation), revoked.completion.response.value)) {
        Object.assign(physical, { revocation: null, revocationRequest: revoked.completionLink() });
      }
      return physical;
    });
    const byId = new Map(execution.calls.map((call) => [call.callId, call]));
    planned.execution.events = execution.events.map((event) => RuntimeStoredEvent.encode(event, byId.get(event.callId)));
    return planned;
}

function expandStoredRuntimeExecution(storage, value) {
  return expandStoredRuntimeExecutionFacts(storage, storage.expandExecution(value));
}

function expandStoredRuntimeExecutionFacts(storage, execution) {
  const calls = execution.calls.map((call) => storage.expandCall(execution.executionId, call));
  const byId = new Map(calls.map((call) => [call.callId, call]));
  return { ...execution, calls, events: execution.events.map((event) => RuntimeStoredEvent.expand(event, byId.get(event.callId), storage.evidenceCodec)) };
}

function assertLogicalRuntimeInventory(registry, archives) {
  const inventory = [...archives, ...registry.executions].sort((left, right) => left.ownerEpoch - right.ownerEpoch);
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
  if (new Set(calls.map((call) => call.callId)).size !== calls.length) fail("record-corrupt", "Runtime inventory contains duplicate physical calls");
  return inventory;
}

/** Logical closure is independent of physical worker ownership or liveness. */
function assertClosedRuntimeCheckout(registry, retainedExecution = null) {
  const executions = retainedExecution === null || registry.executions.includes(retainedExecution)
    ? registry.executions : [...registry.executions, retainedExecution];
  if (registry.slot !== null || executions.some((execution) => execution.status !== "closed"
    || execution.calls.some((call) => callCompletion(call) === null))) {
    fail("stop-unconfirmed", "Retained checkout requires exact complete closed execution facts");
  }
}

/** Bounded encoded data; physical migration ownership stays with the caller. */
export class ProcessExecutionRuntimeConversionTarget {
  #content;
  constructor(relativePath, value) {
    this.relativePath = relativePath;
    this.#content = relativePath === "authority.json" ? JSON.stringify(value) : encodeRuntimeRecord(value);
    this.digest = crypto.createHash("sha256").update(this.#content).digest("hex");
    this.byteLength = Buffer.byteLength(this.#content);
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#content); }
}

class RuntimeLogicalInventoryRecords {
  constructor(registry, archives) {
    if (!(registry instanceof RuntimeRegistry) || !Array.isArray(archives)
      || archives.some((archive) => !(archive instanceof ClosedProcessExecutionArchive))) {
      throw new TypeError("Runtime inventory requires a registry and closed archive records");
    }
    this.registry = registry;
    this.archives = Object.freeze([...archives]);
    Object.freeze(this);
  }
  toJSON() {
    return json({ ...this.registry.toJSON(),
      executions: [...this.archives.map((archive) => archive.execution), ...this.registry.executions]
        .sort((left, right) => left.ownerEpoch - right.ownerEpoch) });
  }
}
const runtimeLogicalInventoryRecords = new WeakMap();

/** Fully validated logical data, without a worker or physical-store capability. */
class RuntimeLogicalInventory {
  constructor(sourceVersion, registry, archives) {
    assertLogicalRuntimeInventory(registry, archives.map((archive) => archive.execution));
    if (archives.some((archive) => !archive.checkout.matches(registry.checkout))) throw new TypeError("Runtime data has a foreign checkout archive");
    const records = new RuntimeLogicalInventoryRecords(registry, archives);
    runtimeLogicalInventoryRecords.set(this, records);
    this.sourceVersion = sourceVersion;
    this.checkout = registry.checkout;
    this.logicalInventory = freezeExecutionValue(records.toJSON());
    Object.freeze(this);
  }
}

/** Explicit predecessor data decoding; ordinary Store reads stay current-only. */
export class ProcessExecutionRuntimeVersion8LogicalInventory extends RuntimeLogicalInventory {
  constructor({ registry, archives = [] }) {
    if (registry.version !== 8 || archives.some((archive) => archive.version !== 8)) throw new TypeError("Runtime data requires exact revision 8 inputs");
    const evidenceCodec = new PreviousProcessExecutionEvidenceCodec();
    const projected = { ...registry, version: RUNTIME_RECORD_VERSION };
    const restored = exact(projected, new RuntimeRegistry(projected, null, evidenceCodec));
    const restoredArchives = archives.map((archive) => {
      const projected = { ...archive, version: RUNTIME_RECORD_VERSION };
      return exact(projected, new ClosedProcessExecutionArchive(projected, evidenceCodec));
    });
    super(8, restored, restoredArchives);
  }
}

function restoreLinkedRuntimeInventory({ registry, archives, blocks }, evidenceCodec) {
    const storage = new RuntimeRequestDataStorage(blocks, evidenceCodec);
    const expanded = { ...registry, version: RUNTIME_RECORD_VERSION,
      executions: registry.executions.map((execution) => expandStoredRuntimeExecution(storage, execution)) };
    const restored = exact(expanded, new RuntimeRegistry(expanded, null, evidenceCodec));
    const restoredArchives = archives.map((archive) => {
      const expandedArchive = { ...archive, version: RUNTIME_RECORD_VERSION, execution: expandStoredRuntimeExecution(storage, archive.execution) };
      return exact(expandedArchive, new ClosedProcessExecutionArchive(expandedArchive, evidenceCodec));
    });
    storage.assertComplete();
    return new RuntimeLogicalInventoryRecords(restored, restoredArchives);
}

/** Previous physical chains use the same complete decoder with explicit leaf codecs. */
export class ProcessExecutionRuntimeVersion9LogicalInventory extends RuntimeLogicalInventory {
  constructor({ registry, archives = [], blocks = [] }) {
    if (registry.version !== 9 || archives.some((archive) => archive.version !== 9)) throw new TypeError("Runtime data requires exact revision 9 inputs");
    const restored = restoreLinkedRuntimeInventory({ registry, archives, blocks }, new PreviousProcessExecutionEvidenceCodec());
    super(9, restored.registry, restored.archives);
  }
}

/** Strict current wire decoding through the normal chains and logical validators. */
export class ProcessExecutionRuntimeVersion10LogicalInventory extends RuntimeLogicalInventory {
  constructor({ registry, archives = [], blocks = [] }) {
    if (registry.version !== 10 || archives.some((archive) => archive.version !== 10)) throw new TypeError("Runtime data requires exact revision 10 inputs");
    const restored = restoreLinkedRuntimeInventory({ registry, archives, blocks }, CURRENT_PROCESS_EXECUTION_EVIDENCE);
    super(10, restored.registry, restored.archives);
  }
}

/** One explicit predecessor conversion, using the normal current planner.
 * Original event publications and closure identities are never regenerated. */
export class ProcessExecutionRuntimeRecordConversion {
  constructor({ registry, archives = [], requests = [], blocks = [] }) {
    const source = registry.version === 8 ? new ProcessExecutionRuntimeVersion8LogicalInventory({ registry, archives })
      : new ProcessExecutionRuntimeVersion9LogicalInventory({ registry, archives, blocks });
    const records = runtimeLogicalInventoryRecords.get(source);
    const evidence = new ProcessExecutionEvidenceMigration();
    for (const execution of source.logicalInventory.executions) for (const call of execution.calls) evidence.addCompletion(call.receipt ?? call.revocation);
    const projectRequest = (request) => ({ ...json(request), response: evidence.response(request.operation, request.response) });
    const projectExecution = (execution) => ({ ...json(execution),
      calls: execution.calls.map((call) => ({ ...json(call),
        receipt: call.receipt === null ? null : evidence.completion(json(call.receipt)).toJSON(),
        revocation: call.revocation === null ? null : evidence.completion(json(call.revocation)).toJSON(),
        controlFailure: call.controlFailure === null ? null : ProcessExecutionEvidenceMigration.failure(json(call.controlFailure)).toJSON() })),
      requests: execution.requests.map(projectRequest) });
    const checkout = ProcessExecutionEvidenceMigration.checkout(json(records.registry.checkout));
    const projectedRegistry = { ...json(records.registry), version: RUNTIME_RECORD_VERSION, checkout: json(checkout),
      executions: records.registry.executions.map(projectExecution) };
    const projectedArchives = records.archives.map((archive) => ({ version: RUNTIME_RECORD_VERSION,
      checkout: json(checkout), execution: projectExecution(archive.execution) }));
    const logicalRegistry = exact(projectedRegistry, new RuntimeRegistry(projectedRegistry));
    const logicalArchives = projectedArchives.map((archive) => exact(archive, new ClosedProcessExecutionArchive(archive)));
    const inventory = new RuntimeLogicalInventory(RUNTIME_RECORD_VERSION, logicalRegistry, logicalArchives);
    const all = [...logicalArchives.map((archive) => archive.execution), ...logicalRegistry.executions];
    const storage = new RuntimeRequestStorage(null);
    const planned = new Map(all.map((execution) => [execution.executionId, planStoredRuntimeExecution(storage, execution, { importing: true })]));
    const targets = new Map();
    for (const [executionId, entry] of planned) for (const block of entry.writes) {
      const relativePath = `requests/${executionId}/blocks/${block.blockId}.json`;
      targets.set(relativePath, new ProcessExecutionRuntimeConversionTarget(relativePath, block));
    }
    const requestPaths = new Set();
    for (const value of requests) {
      const executionId = uuid(value.executionId, "conversion request execution ID");
      const projected = projectRequest(value.request);
      const request = exact(projected, new RuntimeRequestRecord(projected));
      const relativePath = `requests/${executionId}/${request.requestId}.json`;
      if (requestPaths.has(relativePath)) throw new TypeError("Conversion request inventory is duplicated");
      requestPaths.add(relativePath);
      // Read-only recovery owns a standalone request namespace without adding
      // a canonical execution epoch. Preserve that evidence without inventing
      // history membership or execution authority for its namespace.
      const known = all.find((entry) => entry.executionId === executionId)?.requests.find((entry) => entry.requestId === request.requestId);
      // v8 observation sidecars intentionally retained pending acceptance after
      // their completed inline fact. Other completed sidecars must agree exactly.
      if (known !== undefined) {
        if (known.operation !== request.operation || known.payloadDigest !== request.payloadDigest
          || known.authorizationDigest !== request.authorizationDigest
          || request.response !== null && !isDeepStrictEqual(json(request.response), json(known.response))) throw new TypeError("Conversion request differs from its original acceptance or response");
      }
      targets.set(relativePath, new ProcessExecutionRuntimeConversionTarget(relativePath,
        new RuntimeStandaloneRequestDocument({ executionId, ...request.toJSON() })));
    }
    for (const archive of logicalArchives) {
      const relativePath = `archives/${archive.execution.executionId}.json`;
      targets.set(relativePath, new ProcessExecutionRuntimeConversionTarget(relativePath, { ...archive.toJSON(), execution: planned.get(archive.execution.executionId).execution }));
    }
    targets.set("authority.json", new ProcessExecutionRuntimeConversionTarget("authority.json", checkout));
    targets.set("registry.json", new ProcessExecutionRuntimeConversionTarget("registry.json", { ...logicalRegistry.toJSON(), executions: logicalRegistry.executions.map((entry) => planned.get(entry.executionId).execution) }));
    this.targets = Object.freeze([...targets.values()]);
    this.sourceVersion = source.sourceVersion;
    this.sourceLogicalDigest = digest({ ...source.logicalInventory, version: source.sourceVersion });
    this.checkout = logicalRegistry.checkout;
    this.logicalInventory = inventory.logicalInventory;
    this.logicalRegistry = freezeExecutionValue(logicalRegistry);
    Object.freeze(this);
  }
}

/** Revision-eight entry point retained for explicit callers, never ordinary reads. */
export class ProcessExecutionRuntimeVersion8Conversion extends ProcessExecutionRuntimeRecordConversion {
  constructor(value) {
    if (value.registry.version !== 8) throw new TypeError("Revision-eight conversion requires its exact source version");
    super(value);
  }
}


/** Retain a plan's exact file/parent authority, never its physical contents. */
class RuntimePublicationFile {
  #files = new WeakMap();
  constructor(relativePath) { this.relativePath = relativePath; Object.freeze(this); }
  resolve(store) {
    let file = this.#files.get(store);
    if (file === undefined) {
      file = store.publicationFile(this.relativePath, { create: false });
      if (file !== null) this.#files.set(store, file);
    }
    return file;
  }
}

class RuntimePublicationTarget {
  #file;
  constructor(value) {
    this.relativePath = value.relativePath;
    this.#file = new RuntimePublicationFile(this.relativePath);
    if (!["registry.json", "authority.json"].includes(this.relativePath) && !/^calls\/[0-9a-f-]{36}\/outcome\.json(?:\.stop)?(?:\.transition)?$/.test(this.relativePath)
      && !/^archives\/[0-9a-f-]{36}\.json$/.test(this.relativePath)) {
      const match = /^requests\/([^/]+)\/(?:blocks\/)?([^/]+)\.json$/.exec(this.relativePath);
      if (match === null) throw new TypeError("Runtime publication target is outside the existing ledger");
      uuid(match[1], "publication execution ID"); uuid(match[2], "publication request ID");
    }
    this.before = value.before === null ? null : new RuntimeFileGeneration(value.before);
    this.removal = value.removal;
    if (typeof this.removal !== "boolean" || this.removal && (!/^requests\/[^/]+\/blocks\/[^/]+\.json$/.test(this.relativePath)
      || this.before === null || value.publicationStage !== null)) throw new TypeError("Only explicit migration may retire an exact original request block");
    this.sourceStage = new RuntimePublicationStage(value.sourceStage);
    if (this.removal && (this.sourceStage.generation.digest !== this.before.digest
      || this.sourceStage.generation.bytes !== this.before.bytes)) throw new TypeError("Retired request block lacks its exact durable before-image");
    this.publicationStage = value.publicationStage === null ? null : new RuntimePublicationStage(value.publicationStage);
    if (this.publicationStage !== null && (this.publicationStage.generation.digest !== this.sourceStage.generation.digest
      || this.publicationStage.generation.bytes !== this.sourceStage.generation.bytes)) throw new TypeError("Recovery publication stage changed the prepared data");
    exact(value, this);
  }
  file(store) {
    const file = this.#file.resolve(store);
    if (file === null) fail("record-missing", "Prepared runtime publication parent is missing");
    return file;
  }
  stageFile(store, stage = this.sourceStage) {
    const file = this.file(store);
    return new AtomicFile(path.join(file.directory, stage.name), { directoryAuthority: file.directoryAuthority, maxBytes: file.maxBytes });
  }
  isPublished(store, registryTarget = null) {
    const snapshot = this.file(store).readSnapshot();
    const registrySnapshot = this.needsRegistrySnapshot(snapshot) && registryTarget !== null
      ? registryTarget.file(store).readSnapshot() : null;
    return this.isPublishedSnapshot(snapshot, registryTarget, registrySnapshot);
  }
  needsRegistrySnapshot(snapshot) { return this.relativePath.endsWith(".transition") && snapshot === null; }
  isPublishedSnapshot(snapshot, registryTarget = null, registrySnapshot = null) {
    if (this.removal) {
      if (snapshot === null) return true;
      if (this.before.matches(snapshot)) return false;
      fail("authority-mismatch", "Retired request block changed its original generation");
    }
    if (this.needsRegistrySnapshot(snapshot) && registryTarget !== null
      && registryTarget.isPublishedSnapshot(registrySnapshot)) return true;
    if ((this.publicationStage ?? this.sourceStage).generation.matches(snapshot)) return true;
    if (this.before === null ? snapshot === null : this.before.matches(snapshot)) return false;
    fail("authority-mismatch", "Prepared publication target changed its exact generation");
  }
  toJSON() { return { relativePath: this.relativePath, before: this.before, removal: this.removal, sourceStage: this.sourceStage, publicationStage: this.publicationStage }; }
}

/** Preserved normal-reader input, bound to the exact preparation generation. */
class RuntimePublicationSource {
  #file;
  constructor(value) {
    this.relativePath = new LogicalRelativePath(value.relativePath, "runtime publication source").toString();
    this.#file = new RuntimePublicationFile(this.relativePath);
    this.validatePath();
    this.generation = new RuntimeFileGeneration(value.generation);
    exact(value, this); Object.freeze(this);
  }
  validatePath() {
    const match = /^(?:archives\/([^/]+)\.json|requests\/([^/]+)\/(?:blocks\/)?([^/]+)\.json)$/.exec(this.relativePath);
    if (this.relativePath !== "authority.json" && match === null) throw new TypeError("Prepared source is outside the canonical reader inventory");
    for (const id of match?.slice(1).filter(Boolean) ?? []) uuid(id, "prepared source identity");
  }
  directoryAuthority(store) {
    const directory = store.publicationDirectory(path.posix.dirname(this.relativePath));
    if (directory === null) fail("authority-mismatch", "Preserved runtime input parent is missing");
    return directory;
  }
  capture(store) {
    const snapshot = this.#file.resolve(store)?.readSnapshot() ?? null;
    return this.assertCaptured(snapshot);
  }
  assertCaptured(snapshot) {
    if (!this.generation.matches(snapshot)) fail("authority-mismatch", "Preserved runtime input changed its exact preparation generation");
    return snapshot;
  }
  static captureAll(sources, store, additionalFiles = []) {
    const files = sources.map((source) => source.#file.resolve(store));
    if (files.some((file) => file === null)) fail("authority-mismatch", "Preserved runtime input changed its exact preparation generation");
    const complete = new Map([...files, ...additionalFiles].map(file => [file.filePath, file]));
    const snapshots = AtomicFile.readSnapshots(complete.values());
    const captured = new Map(sources.map((source, index) => [source.relativePath,
      source.assertCaptured(snapshots.get(files[index].filePath))]));
    return new RuntimePublicationCapturedFiles(captured, snapshots);
  }
  toJSON() { return { relativePath: this.relativePath, generation: this.generation }; }
}

/** Sources, targets and stages captured by the same complete fresh forest. */
class RuntimePublicationCapturedFiles {
  #sources;
  #snapshots;
  constructor(sources, snapshots) {
    if (!(sources instanceof Map) || !(snapshots instanceof RegularFileSnapshotGroup)) throw new TypeError("Publication capture requires sources and a regular file snapshot group");
    this.#sources = new Map(sources);
    this.#snapshots = snapshots;
    Object.freeze(this);
  }
  sources() { return new Map(this.#sources); }
  snapshots() { return this.#snapshots; }
}

/** Exact existing ancestry within the selected runtime; no path grants ownership. */
class RuntimePublicationDirectoryGeneration {
  #authorities = new WeakMap();
  constructor(value) {
    this.relativePath = value.relativePath;
    new LogicalRelativePath(this.relativePath, "runtime publication directory");
    const parts = this.relativePath.split("/");
    if (!["archives", "calls", "requests"].includes(parts[0]) || parts[0] === "archives" && parts.length !== 1
      || parts[0] === "requests" && (parts.length > 3 || parts.length === 3 && parts[2] !== "blocks")) {
      throw new TypeError("Prepared directory is outside runtime storage");
    }
    if (parts.length > 1) uuid(parts[1], "prepared directory identity");
    this.identity = FileIdentity.fromStored(value.identity);
    this.entries = value.entries === null ? null : Object.freeze([...value.entries]);
    if (this.entries !== null && (new Set(this.entries).size !== this.entries.length
      || this.entries.some((name) => typeof name !== "string" || path.posix.basename(name) !== name)
      || !isDeepStrictEqual([...this.entries].sort(), this.entries))) throw new TypeError("Prepared directory inventory is invalid");
    exact(value, this); Object.freeze(this);
  }
  assertMatches(store) {
    const directory = this.#authority(store);
    directory.assertStable();
    this.#assertIdentity(directory);
    return directory;
  }
  #authority(store) {
    let directory = this.#authorities.get(store);
    if (directory === undefined) directory = store.publicationDirectory(this.relativePath);
    if (directory === null) fail("authority-mismatch", "Prepared runtime directory is missing");
    this.#authorities.set(store, directory);
    return directory;
  }
  #assertIdentity(directory) {
    if (!sameFileIdentity(this.identity, directory.identity)) fail("authority-mismatch", "Prepared runtime directory changed its exact generation");
  }
  static #assertIdentities(generations, directories) {
    for (const [index, generation] of generations.entries()) generation.#assertIdentity(directories[index]);
  }
  static beginAllMatches(store, generations, { includeStore = false } = {}) {
    const directories = generations.map((generation) => generation.#authority(store));
    const physical = includeStore ? store.beginStableObservation({ additionalAuthorities: directories })
      : RealDirectoryAuthority.beginObservation(directories);
    try {
      this.#assertIdentities(generations, directories);
      return new RuntimePublicationDirectoryObservation(runtimeRegistryObservationAuthority, store, generations, directories, physical);
    } catch (cause) { physical.discard(); throw cause; }
  }
  static assertAllMatches(store, generations, { includeStore = false, observation = null } = {}) {
    if (observation !== null) {
      if (!(observation instanceof RuntimePublicationDirectoryObservation)) throw new TypeError("Expected this publication's directory read interval");
      observation.assertMatches(store, generations);
      const directories = generations.map((generation) => generation.#authority(store));
      this.#assertIdentities(generations, directories);
      return directories;
    }
    const captured = this.beginAllMatches(store, generations, { includeStore });
    try { return captured.complete(); } finally { captured.discard(); }
  }
  toJSON() { return { relativePath: this.relativePath, identity: this.identity, entries: this.entries }; }
}

/** One fixed read interval; no completed observation authorizes an effect. */
class RuntimePublicationDirectoryObservation {
  #store;
  #generations;
  #directories;
  #physical;
  #active = true;
  constructor(authority, store, generations, directories, physical) {
    if (authority !== runtimeRegistryObservationAuthority) throw new TypeError("Publication directory observations require their complete owner");
    this.#store = store; this.#generations = generations;
    this.#directories = Object.freeze([...directories]); this.#physical = physical;
    Object.freeze(this);
  }
  assertMatches(store, generations) {
    if (!this.#active || store !== this.#store || generations !== this.#generations) {
      throw new TypeError("Directory read observation belongs to another publication or interval");
    }
  }
  complete() {
    try {
      this.#physical.complete();
      RuntimePublicationDirectoryGeneration.assertAllMatches(this.#store, this.#generations, { observation: this });
      return this.#directories.slice();
    } finally { this.#active = false; }
  }
  discard() { this.#active = false; this.#physical.discard(); }
}

/** The existing transition file holds metadata only, never result payloads. */
class RuntimePreparedPublication {
  static phase = "prepared-publication";
  #registryObservation = null;
  #dataObservation = null;
  constructor(value) {
    if (value.version !== RUNTIME_RECORD_VERSION || value.phase !== new.target.phase) throw new TypeError("Runtime transition is not a prepared result publication");
    this.version = value.version; this.phase = value.phase;
    this.checkout = new ProcessExecutionCheckoutIdentity(value.checkout);
    this.runtimeIdentity = FileIdentity.fromStored(value.runtimeIdentity);
    this.owner = value.owner === null ? null : new LockOwnerSession(value.owner);
    this.ownerIdentity = value.ownerIdentity === null ? null : FileIdentity.fromStored(value.ownerIdentity);
    this.registryBefore = new RuntimeFileGeneration(value.registryBefore);
    this.sources = value.sources.map((source) => this.restoreSource(source));
    this.directories = value.directories.map((directory) => new RuntimePublicationDirectoryGeneration(directory));
    const directoryPaths = new Set(this.directories.map((directory) => directory.relativePath));
    if (directoryPaths.size !== this.directories.length || !directoryPaths.has("calls") || !directoryPaths.has("archives")) throw new TypeError("Prepared runtime directory inventory is incomplete");
    if ((this.owner === null) !== (this.ownerIdentity === null)) throw new TypeError("Prepared owner observation is incomplete");
    this.targets = value.targets.map((target) => new RuntimePublicationTarget(target));
    if (this.targets.length === 0 || this.targets.at(-1).relativePath !== "registry.json"
      || new Set(this.targets.map((target) => target.relativePath)).size !== this.targets.length) throw new TypeError("Prepared publication dependencies are invalid");
    const sourcePaths = new Set(this.sources.map((source) => source.relativePath));
    if (sourcePaths.size !== this.sources.length || !(sourcePaths.has("authority.json")
        || this.permitsAnchorMigration() && this.targets.some((target) => target.relativePath === "authority.json"))
      || !this.permitsAnchorMigration() && this.targets.some((target) => target.relativePath === "authority.json")
      || !this.permitsAnchorMigration() && this.targets.some((target) => target.removal)
      || this.targets.some((target) => sourcePaths.has(target.relativePath))) throw new TypeError("Prepared preserved source inventory is invalid");
    for (const target of [...this.targets, ...this.sources]) {
      for (let parent = path.posix.dirname(target.relativePath); parent !== "."; parent = path.posix.dirname(parent)) {
        if (!directoryPaths.has(parent)) throw new TypeError("Prepared target lacks its exact directory ancestry");
      }
    }
    if (new.target === RuntimePreparedPublication) exact(value, this);
  }
  restoreSource(value) { return new RuntimePublicationSource(value); }
  permitsAnchorMigration() { return false; }
  withTargets(targets) { return new this.constructor({ ...json(this), targets }); }
  #assertStorageIdentity(store) {
    if (!this.checkout.matches(store.checkout) || !sameFileIdentity(this.runtimeIdentity, store.authority.identity)) fail("authority-mismatch", "Prepared publication belongs to another runtime authority");
  }
  #beginReadObservation(store) {
    this.#assertStorageIdentity(store);
    return RuntimePublicationDirectoryGeneration.beginAllMatches(store, this.directories, { includeStore: true });
  }
  assertStorageAuthority(store, observation = null) {
    this.#assertStorageIdentity(store);
    RuntimePublicationDirectoryGeneration.assertAllMatches(store, this.directories, { includeStore: true, observation });
  }
  assertAuthority(store, observation = null) {
    this.assertStorageAuthority(store, observation);
    const current = store.ownerLock.inspect();
    if (this.owner === null ? current !== null : current === null || !sameFileIdentity(this.ownerIdentity, current.stat)
      || this.owner.ownerToken !== current.owner.ownerToken || this.owner.ownerSession !== current.owner.ownerSession) fail("ownership-changed", "Prepared publication owner observation changed");
  }
  captureSources(store, additionalFiles = []) {
    return RuntimePublicationSource.captureAll(this.sources, store, additionalFiles);
  }
  assertNextTarget(store, index) {
    const targets = this.targets.slice(0, index + 1);
    const files = targets.map((target) => target.file(store));
    const registryTarget = this.targets.at(-1), registryFile = registryTarget.file(store);
    const uniqueFiles = new Map(files.map((file) => [file.filePath, file]));
    let snapshots = AtomicFile.readSnapshots(uniqueFiles.values());
    if (!uniqueFiles.has(registryFile.filePath) && targets.some((target, ordinal) =>
      target.needsRegistrySnapshot(snapshots.get(files[ordinal].filePath)))) {
      // Missing private transitions require the selected registry as another
      // dependency. Recapture the entire image with that dependency included.
      uniqueFiles.set(registryFile.filePath, registryFile);
      snapshots = AtomicFile.readSnapshots(uniqueFiles.values());
    }
    const registrySnapshot = uniqueFiles.has(registryFile.filePath)
      ? snapshots.get(registryFile.filePath) : null;
    const published = targets.map((target, ordinal) => target.isPublishedSnapshot(
      snapshots.get(files[ordinal].filePath), registryTarget, registrySnapshot));
    if (published.slice(0, index).some((value) => !value)) fail("authority-mismatch", "Runtime publication lost an exact prior dependency");
    if (published[index]) fail("authority-mismatch", "Runtime target changed before its exact owned publication");
  }
  isPublished(store, target) { return target.isPublished(store, this.targets.at(-1)); }
  readTarget(store, target) {
    if (target.removal) return null;
    if (this.isPublished(store, target)) return target.file(store).readSnapshot();
    const snapshot = target.stageFile(store).readSnapshot();
    if (!target.sourceStage.generation.matches(snapshot)) fail("authority-mismatch", "Prepared runtime source stage changed its exact generation");
    if (target.publicationStage !== null) {
      const replacement = target.stageFile(store, target.publicationStage).readSnapshot();
      if (replacement !== null && !target.publicationStage.generation.matches(replacement)) fail("authority-mismatch", "Prepared recovery stage was replaced");
    }
    return snapshot;
  }
  assertSelected(store, selection, observation = null) {
    this.assertAuthority(store, observation);
    selection.assertCurrent();
  }
  consumeValidatedRegistry(snapshot, linkedSnapshots) {
    const observation = this.#registryObservation;
    this.#registryObservation = null;
    return observation?.read(snapshot, linkedSnapshots) ?? null;
  }
  assertPhysical(store, { committed = false } = {}) {
    const read = this.#beginReadObservation(store);
    try {
      this.assertAuthority(store, read);
      const observation = this.#capturePhysical(store, { committed });
      this.assertAuthority(store, read);
      read.complete();
      return observation;
    } finally { read.discard(); }
  }
  #capturePhysical(store, { committed = false } = {}) {
    const observation = new RuntimePublicationPhysicalObservation(this, store);
    let unpublished = false;
    for (const target of this.targets) {
      observation.captureTarget(target);
      const published = observation.isPublished(target);
      if (unpublished && published) fail("record-corrupt", "Prepared runtime dependencies were published out of order");
      if (!published) unpublished = true;
      if (committed && !published) fail("durability-uncertain", "Prepared runtime dependency changed before commit cleanup");
      observation.captureStages(target);
    }
    observation.assertNamespaces();
    return observation;
  }
  validateData(store, selection = null, intended = null, archiveObservation = new RuntimeRecordObservation()) {
    // One synchronous, callback-free read interval owns both complete physical
    // images and the pure decode. Keep the original polymorphic selected proof
    // at both ends, including migration's extra source/namespace observations.
    let read = null;
    const assertCurrent = () => selection === null ? this.assertAuthority(store, read) : this.assertSelected(store, selection, read);
    try {
      read = this.#beginReadObservation(store);
      assertCurrent();
      const registry = this.#readData(store, intended, archiveObservation);
      assertCurrent();
      read.complete();
      return registry;
    } catch (cause) {
      this.#registryObservation = null;
      this.#dataObservation = null;
      throw cause;
    } finally { read?.discard(); }
  }
  #readData(store, intended, archiveObservation) {
    const observation = this.#capturePhysical(store);
    const registry = this.validateCapturedData(store, observation, intended, archiveObservation);
    this.#capturePhysical(store);
    return registry;
  }
  validateCapturedData(store, observation, intended, archiveObservation) {
    const view = observation.view();
    const snapshots = view.snapshots;
    const registryTarget = this.targets.at(-1);
    if (!observation.isPublished(registryTarget) && !this.registryBefore.matches(store.file.readSnapshot())) fail("authority-mismatch", "Prepared runtime registry baseline changed");
    const observedData = this.#dataObservation?.read(this, snapshots) ?? null;
    if (observedData !== null) {
      // Reuse only the logical image of these exact captured generations.
      // The caller owns the complete fresh physical checks at both boundaries.
      if (store.checkoutAuthority === null) assertClosedRuntimeCheckout(observedData);
      return observedData;
    }
    const decode = (relativePath) => {
      const envelope = readJson(view.file(relativePath));
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Prepared runtime dependency checksum differs");
      return envelope.payload;
    };
    const storage = store.requestStorage.fork(view);
    if (!isDeepStrictEqual(readJson(view.file("authority.json")), json(this.checkout))) fail("authority-mismatch", "Prepared checkout anchor differs");
    const physical = decode("registry.json");
    const executions = physical.executions.map((execution) => storage.expandExecution(execution));
    // Fresh request expansion verifies every linked block and complete namespace.
    // Reconstruct call/event facts only when that exact validated proof misses.
    const linkedSnapshots = storage.publicationSnapshots();
    const registrySnapshot = snapshots.get("registry.json");
    const observed = this.#registryObservation?.read(registrySnapshot, linkedSnapshots) ?? null;
    if (observed === null) this.#registryObservation = null;
    let registry = observed;
    if (registry === null) {
      const expanded = { ...physical, executions: executions.map((execution) => expandStoredRuntimeExecutionFacts(storage, execution)) };
      registry = intended?.read(expanded) ?? exact(expanded, new RuntimeRegistry(expanded));
    }
    if (!registry.checkout.matches(store.checkout)) fail("authority-mismatch", "Prepared runtime registry belongs to another checkout");
    const archiveNames = view.entries("archives", store.archivesAuthority);
    // Ordinary preserved archives use the same strict reader as inventory
    // observations. Migration's binary predecessor sources retain their staged
    // codec path, and new archive targets retain their complete decode below.
    const preservedSources = new Set(this.sources
      .filter((source) => !(source instanceof RuntimeRecordMigrationPreservedSource))
      .map((source) => source.relativePath));
    const archives = [...archiveNames].map((name) => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) fail("record-corrupt", "Unexpected prepared runtime archive inventory entry");
      if (preservedSources.has(`archives/${name}`)) return store.readPreservedArchive(archiveObservation, name, view, storage);
      const value = decode(`archives/${name}`);
      const expandedArchive = { ...value, execution: expandStoredRuntimeExecution(storage, value.execution) };
      const archive = exact(expandedArchive, new ClosedProcessExecutionArchive(expandedArchive));
      if (!archive.checkout.matches(store.checkout) || name !== `${archive.execution.executionId}.json`) fail("authority-mismatch", "Prepared runtime archive belongs to another checkout or execution");
      return archive.execution;
    });
    const inventory = assertLogicalRuntimeInventory(registry, archives);
    this.assertLogicalInventory(registry, inventory);
    this.assertStandaloneResults(inventory, storage, view);
    const calls = new Map(inventory.flatMap((execution) => execution.calls.map((call) => [call.callId, { execution, call }])));
    for (const name of view.entries("calls", store.callsAuthority)) {
      if (!calls.has(name)) fail("record-missing", "A physical call artifact is outside the prepared runtime inventory");
      observation.assertDirectory(`calls/${name}`);
    }
    for (const target of this.targets) if (target.relativePath.startsWith("calls/")) {
      const { execution, call } = calls.get(target.relativePath.split("/")[1]) ?? {};
      const expected = target.relativePath.endsWith(".transition")
        ? call === undefined ? null : { executionId: execution.executionId, callId: call.callId }
        : target.relativePath.endsWith(".stop")
          ? call?.stopOperation == null ? null : { executionId: execution.executionId, callId: call.callId,
            ownerToken: execution.coordinatorIdentity.ownerToken, capability: call.capability, operation: call.stopOperation.toJSON() }
          : call?.receipt === null || call === undefined ? null : { schemaVersion: 3, scope: "registered-executions", executionId: execution.executionId,
        callId: call.callId, ownerToken: execution.coordinatorIdentity.ownerToken, capability: call.capability, executor: call.executor.toJSON(),
        observation: call.observation.toJSON(), state: "finished", outcome: call.outcome, receipt: call.receipt.toJSON() };
      const captured = snapshots.get(target.relativePath);
      if (captured === null && target.relativePath.endsWith(".transition")) continue;
      if (!isDeepStrictEqual(JSON.parse(captured.bytes.toString("utf8")), json(expected))) fail("record-corrupt", "Prepared private outcome differs from its canonical finish fact");
    }
    if (store.checkoutAuthority === null) assertClosedRuntimeCheckout(registry);
    if (observed === null) this.#registryObservation = ValidatedRuntimeRegistryObservation.fromValidatedRead(registry, registrySnapshot, linkedSnapshots);
    // Migration adds streamed predecessor and namespace proofs; retain its
    // complete polymorphic validation rather than sharing this normal image.
    if (this.constructor === RuntimePreparedPublication) this.#dataObservation = new ValidatedRuntimePublicationData(
      runtimeRegistryObservationAuthority, this, registry, snapshots, storage);
    return registry;
  }
  canRetainReadback(registry) { return this.#dataObservation?.canRetain(this, registry) ?? false; }
  retainReadback(store, registry, snapshots) {
    this.#dataObservation.retain(store, registry, snapshots);
  }
  assertLogicalInventory(_registry, _inventory) {}
  assertStandaloneResults(inventory, storage, view) {
    for (const target of this.targets) {
      const block = /^requests\/([^/]+)\/blocks\/([^/]+)\.json$/.exec(target.relativePath);
      if (block !== null && !inventory.some((execution) => execution.executionId === block[1])) fail("record-corrupt", "Prepared block is outside the complete canonical execution inventory");
      const match = /^requests\/([^/]+)\/([^/]+)\.json$/.exec(target.relativePath);
      if (match === null) continue;
      const request = readRuntimeRequest(view.file(target.relativePath), match[1], match[2]);
      const completed = storage.completionEntry(match[1], match[2]);
      if (request === null || request.response === null || completed === null
        || !completed.acceptance.matches(new RuntimeRequestAcceptance({ requestId: request.requestId, operation: request.operation,
          payloadDigest: request.payloadDigest, authorizationDigest: request.authorizationDigest }))
        || !isDeepStrictEqual(json(request.response), json(completed.completion.response))) {
        fail("record-corrupt", "Prepared standalone result lacks its exact canonical completion");
      }
    }
  }
  toJSON() { return { version: this.version, phase: this.phase, checkout: this.checkout, runtimeIdentity: this.runtimeIdentity,
    owner: this.owner, ownerIdentity: this.ownerIdentity, registryBefore: this.registryBefore, sources: this.sources, directories: this.directories, targets: this.targets }; }
}

/** Migration preserves binary artifacts; normal publication sources stay canonical. */
class RuntimeRecordMigrationPreservedSource extends RuntimePublicationSource {
  validatePath() {
    if (this.relativePath === "transition.json") throw new TypeError("A migration cannot preserve its own transition as source data");
  }
  capture(store) {
    if (this.relativePath === "authority.json") return super.capture(store);
    const filePath = path.join(store.authority.directory, ...this.relativePath.split("/"));
    const actual = visitRegularFileChunks(filePath, { label: "runtime migration preserved source", maxBytes: Number.MAX_SAFE_INTEGER - 1,
      requireSingleLink: true, directoryAuthority: this.directoryAuthority(store), expectedIdentity: this.generation.identity, visit() {} });
    if (!this.generation.matches(actual)) fail("authority-mismatch", "Runtime migration preserved artifact changed its exact generation");
    return actual;
  }
}

/** Same physical publisher, with the complete validated current projection as its meaning. */
class RuntimePreparedRecordMigration extends RuntimePreparedPublication {
  static phase = "prepared-record-migration";
  permitsAnchorMigration() { return true; }
  // Predecessor artifacts can exceed the canonical in-memory file bound.
  // Keep their existing complete streaming capture and generation checks.
  captureSources(store, additionalFiles = []) {
    const sources = new Map(this.sources.map((source) => [source.relativePath, source.capture(store)]));
    return new RuntimePublicationCapturedFiles(sources, AtomicFile.readSnapshots(additionalFiles));
  }
  constructor(value) {
    super(value);
    if (!/^[a-f0-9]{64}$/.test(value.logicalDigest) || !Array.isArray(value.standaloneRequests) || !Array.isArray(value.createdParents)
      || !Array.isArray(value.namespaceAbsences)) {
      throw new TypeError("Runtime migration target proof is incomplete");
    }
    this.logicalDigest = value.logicalDigest;
    this.namespaceAbsences = Object.freeze(value.namespaceAbsences.map((entry) => new RuntimeRecordMigrationAbsenceProof(entry)));
    this.standaloneRequests = Object.freeze(value.standaloneRequests.map((entry) => {
      const restored = { relativePath: new LogicalRelativePath(entry.relativePath, "migrated standalone request").toString(), digest: entry.digest };
      const match = /^requests\/([^/]+)\/([^/]+)\.json$/.exec(restored.relativePath);
      if (match === null || !/^[a-f0-9]{64}$/.test(restored.digest)) throw new TypeError("Migrated standalone proof is invalid");
      uuid(match[1], "migrated request execution"); uuid(match[2], "migrated request ID"); exact(entry, restored);
      return Object.freeze(restored);
    }));
    this.createdParents = Object.freeze(value.createdParents.map((entry) => {
      const restored = { relativePath: new LogicalRelativePath(entry.relativePath, "migration-created parent").toString(),
        identity: FileIdentity.fromStored(entry.identity), ancestorRelativePath: entry.ancestorRelativePath,
        ancestorIdentity: FileIdentity.fromStored(entry.ancestorIdentity) };
      if (restored.ancestorRelativePath !== ".") {
        new LogicalRelativePath(restored.ancestorRelativePath, "migration original ancestor");
        if (!restored.relativePath.startsWith(`${restored.ancestorRelativePath}/`)) throw new TypeError("Migration original ancestor does not contain its created parent");
      }
      exact(entry, restored); return Object.freeze(restored);
    }));
    if (new Set(this.standaloneRequests.map((entry) => entry.relativePath)).size !== this.standaloneRequests.length
      || new Set(this.createdParents.map((entry) => entry.relativePath)).size !== this.createdParents.length
      || this.owner !== null || this.ownerIdentity !== null) throw new TypeError("Runtime migration cannot carry a worker owner or duplicate source proof");
    for (const parent of this.createdParents) {
      const directory = this.directories.find((entry) => entry.relativePath === parent.relativePath);
      if (directory === undefined || !sameFileIdentity(parent.identity, directory.identity)) throw new TypeError("Migration-created parent lacks its exact selected generation");
    }
    exact(value, this);
  }
  restoreSource(value) { return new RuntimeRecordMigrationPreservedSource(value); }
  assertAuthority(store) {
    this.assertStorageAuthority(store); store.assertRecordMigrationQuiescent(); store.assertRecordMigrationContext();
    for (const absence of this.namespaceAbsences) absence.assertCurrent(store);
  }
  assertSelected(store, selection) {
    // Explicit migration preserves a complete offline source/namespace proof
    // at every selected effect, not only when the final registry is published.
    super.assertSelected(store, selection); this.assertPhysical(store); selection.assertCurrent();
  }
  assertLogicalInventory(registry, inventory) {
    const logical = { ...registry.toJSON(), executions: [...inventory].sort((left, right) => left.ownerEpoch - right.ownerEpoch) };
    if (digest(logical) !== this.logicalDigest) fail("record-corrupt", "Migration changed the exact original logical inventory or JSON reply order");
  }
  assertStandaloneResults(inventory, _storage, view) {
    const expected = new Map(this.standaloneRequests.map((entry) => [entry.relativePath, entry.digest]));
    for (const target of this.targets) {
      const block = /^requests\/([^/]+)\/blocks\/([^/]+)\.json$/.exec(target.relativePath);
      if (block !== null && !inventory.some((execution) => execution.executionId === block[1])) fail("record-corrupt", "Migrated block lies outside the complete canonical execution inventory");
      const match = /^requests\/([^/]+)\/([^/]+)\.json$/.exec(target.relativePath);
      if (match === null) continue;
      const request = readRuntimeRequest(view.file(target.relativePath), match[1], match[2]);
      if (request === null || digest(request.toJSON()) !== expected.get(target.relativePath)) fail("record-corrupt", "Migration changed an original standalone response, null or JSON ordering");
      expected.delete(target.relativePath);
    }
    if (expected.size !== 0) fail("record-missing", "Migration omitted an original standalone request");
  }
  toJSON() { return { ...super.toJSON(), logicalDigest: this.logicalDigest,
    standaloneRequests: this.standaloneRequests, createdParents: this.createdParents, namespaceAbsences: this.namespaceAbsences }; }
}

/** The adapter owns writer semantics; the common publisher owns exact physical selection. */
class RuntimeRecordMigrationContext {
  constructor(encodeMetadata, assertWriter) {
    if (typeof assertWriter !== "function" || encodeMetadata !== null && typeof encodeMetadata !== "function") throw new TypeError("Migration publication requires its owning writer guard and metadata encoder");
    this.encodeMetadata = encodeMetadata; this.assertWriter = assertWriter; Object.freeze(this);
  }
  encoding(prepared) {
    if (this.encodeMetadata === null) throw new TypeError("Readonly migration inspection cannot publish metadata");
    this.assertWriter();
    const encoding = this.encodeMetadata(prepared);
    if (!(encoding instanceof ProcessExecutionValueEncoding)
      || !new ProcessExecutionValueEncoding(JSON.parse(encoding.text()).publication).matches(new ProcessExecutionValueEncoding(prepared))) {
      fail("record-corrupt", "Migration metadata failed to select its complete exact physical publication");
    }
    return encoding;
  }
}

/** Root transport still owns all pages; this view binds its exact inner physical plan. */
class RuntimeRecordMigrationSelectedPublication {
  #root;
  #prepared;
  constructor(root, prepared) {
    if (!(root instanceof RuntimePublicationMetadataSelection) || !(prepared instanceof RuntimePreparedRecordMigration)) throw new TypeError("Migration selection requires original typed metadata and publication");
    this.#root = root; this.#prepared = prepared; this.assertCurrent(); Object.freeze(this);
  }
  get snapshot() { return this.#root.snapshot; }
  get metadata() { return this.#root.value; }
  rootSelection() { return this.#root; }
  assertCurrent() {
    this.#root.assertCurrent();
    if (!new ProcessExecutionValueEncoding(this.#root.value.publication).matches(new ProcessExecutionValueEncoding(this.#prepared))) {
      fail("authority-mismatch", "Selected migration metadata changed its exact physical plan");
    }
  }
  clear({ clearGuard }) { return this.#root.clear({ clearGuard: () => { this.assertCurrent(); clearGuard(); } }); }
}

/** Readonly inspected migration data; no worker grant or publication authority. */
export class ProcessExecutionRuntimeRecordMigrationPrepared {
  constructor(authority, { store, prepared, selection }) {
    if (authority !== recordMigrationCaptureAuthority) throw new TypeError("Migration plans require the actual selected Store observation");
    recordMigrationPublicationPlans.set(this, { store, prepared, selection });
    this.checkoutIdentity = prepared.checkout; this.digest = selection.snapshot.digest;
    this.targets = Object.freeze(prepared.targets.map((target) => freezeExecutionValue(json(target))));
    Object.freeze(this);
  }
  get metadata() { return recordMigrationPublicationPlans.get(this).selection.metadata; }
}

function runtimePublicationMetadataRoot(selection) {
  return selection instanceof RuntimeRecordMigrationSelectedPublication ? selection.rootSelection() : selection;
}

/** A complete physical image owned by one callback-free validation only.
 * It carries actual snapshots/stream receipts and exact namespace observations,
 * never a cached authority verdict or permission to publish from captured data.
 */
class RuntimePublicationPhysicalObservation {
  #prepared;
  #store;
  #snapshots;
  #sources = new Map();
  #targets = new Map();
  #registrySnapshots = new Map();
  #stages = new Map();
  #directories = new Map();
  #namespaces = new Map();
  constructor(prepared, store) {
    this.#prepared = prepared; this.#store = store;
    const files = new Map();
    for (const target of prepared.targets) {
      const file = target.file(store);
      files.set(file.filePath, file);
      for (const stage of [target.sourceStage, target.publicationStage].filter(Boolean)) {
        const file = target.stageFile(store, stage);
        files.set(file.filePath, file);
      }
    }
    // One callback-free image includes every target, its owned stages and the
    // registry dependency. Each file keeps its full fresh capture; the common
    // snapshot group checks shared ancestry before and after the whole image.
    const captured = prepared.captureSources(store, files.values());
    this.#sources = captured.sources();
    this.#snapshots = captured.snapshots();
    Object.freeze(this);
  }
  captureTarget(target) {
    const snapshot = this.#snapshots.get(target.file(this.#store).filePath);
    this.#targets.set(target, snapshot);
    // An absent managed transition uses the registry captured in this same
    // complete image, rather than a separately observed dependency.
    if (target.needsRegistrySnapshot(snapshot)) this.#registrySnapshots.set(target,
      this.#snapshots.get(this.#prepared.targets.at(-1).file(this.#store).filePath));
  }
  isPublished(target) {
    return target.isPublishedSnapshot(this.#targets.get(target), this.#prepared.targets.at(-1),
      this.#registrySnapshots.get(target) ?? null);
  }
  captureStages(target) {
    const stages = new Map();
    for (const stage of [target.sourceStage, target.publicationStage].filter(Boolean)) {
      const actual = this.#snapshots.get(target.stageFile(this.#store, stage).filePath);
      if (actual !== null && !stage.generation.matches(actual)) fail("authority-mismatch", "A journal-owned runtime stage changed its exact generation");
      stages.set(stage, actual);
    }
    this.#stages.set(target, stages);
  }
  #targetSnapshot(target) {
    if (target.removal) return null;
    if (this.isPublished(target)) return this.#targets.get(target);
    const source = this.#stages.get(target).get(target.sourceStage);
    if (!target.sourceStage.generation.matches(source)) fail("authority-mismatch", "Prepared runtime source stage changed its exact generation");
    return source;
  }
  assertNamespaces() {
    const view = new RuntimePublicationView(this.#store, this.#prepared.targets, new Map());
    const selected = this.#prepared.directories.filter(directory => directory.entries !== null);
    const directories = RuntimePublicationDirectoryGeneration.assertAllMatches(this.#store, selected);
    const snapshots = RealDirectoryAuthority.observeNames(directories);
    for (const [index, directory] of selected.entries()) {
      const entries = view.entries(directory.relativePath, directories[index], snapshots[index]).sort();
      if (!isDeepStrictEqual(entries, directory.entries)) fail("authority-mismatch", "Prepared canonical namespace inventory changed");
      this.#namespaces.set(directory.relativePath, Object.freeze(entries));
    }
    for (const directory of this.#prepared.directories) this.#directories.set(directory.relativePath, directory);
  }
  assertDirectory(relativePath) {
    if (!this.#directories.has(relativePath)) fail("authority-mismatch", "Prepared runtime directory lacks its exact captured ancestry");
  }
  entries(relativePath) { return this.#namespaces.get(relativePath)?.slice(); }
  snapshots() {
    return new Map([...this.#sources, ...this.#prepared.targets.map((target) => [target.relativePath, this.#targetSnapshot(target)])]);
  }
  view() { return new RuntimePublicationView(this.#store, this.#prepared.targets, this.snapshots(), this); }
}

/** Captured bytes are reusable only within this one synchronous validation. */
class RuntimePublicationReadFile {
  constructor(file, snapshot) { this.file = file; this.snapshot = snapshot; this.filePath = file.filePath; }
  readSnapshot() { return this.snapshot === undefined ? this.file.readSnapshot() : this.snapshot; }
  read() { return this.readSnapshot()?.bytes ?? null; }
}

/** The normal request reader consumes exact staged bytes through its same API.
 * Only already generation-validated owned stage names are excluded. */
class RuntimePublicationView {
  constructor(store, targets, snapshots, observation = null, capture = null) {
    if (observation !== null && !(observation instanceof RuntimePublicationPhysicalObservation)) throw new TypeError("Publication view requires its exact physical observation");
    if (capture !== null && !(capture instanceof RuntimeCapturedRecords)) throw new TypeError("Record view requires its closed captured images");
    this.store = store; this.targets = targets; this.snapshots = snapshots; this.observation = observation;
    this.capture = capture;
  }
  publicationFile(relativePath) { return this.file(relativePath); }
  file(relativePath) {
    // Membership is checked BEFORE a Native accessor can read through a miss.
    const snapshot = this.capture === null ? this.snapshots.get(relativePath) : this.capture.snapshot(relativePath);
    const file = this.store.publicationFile(relativePath, { create: false });
    return file === null ? null : new RuntimePublicationReadFile(file, snapshot);
  }
  entries(relativePath, directory, names = null) {
    if (names !== null && (!(names instanceof RealDirectoryNameSnapshot) || names.directory !== directory.directory)) {
      throw new TypeError("Publication namespace requires its exact observed directory names");
    }
    const captured = this.observation?.entries(relativePath) ?? this.capture?.entries(relativePath, directory);
    if (captured !== undefined) return captured;
    const targets = this.targets.filter((target) => path.posix.dirname(target.relativePath) === relativePath);
    const owned = new Set(targets.flatMap((target) => [target.sourceStage.name, target.publicationStage?.name]).filter(Boolean));
    const projected = new Set((names?.names ?? directory?.entries() ?? []).filter((name) => !owned.has(name)));
    for (const target of targets) {
      const name = path.posix.basename(target.relativePath);
      if (target.removal) projected.delete(name); else projected.add(name);
    }
    return [...projected];
  }
  requestBlockFile(executionId, blockId) { return this.file(`requests/${executionId}/blocks/${blockId}.json`); }
  requestBlockDirectory(executionId) {
    const relativePath = `requests/${executionId}/blocks`;
    const directory = this.store.requestBlockDirectory(executionId, { create: false });
    return directory === null ? null : new RuntimePublicationDirectory(this.entries(relativePath, directory));
  }
}
class RuntimePublicationDirectory {
  constructor(names) { this.names = Object.freeze(names); Object.freeze(this); }
  entries() { return this.names; }
}

/** Exact read-only selection; it grants only completion of its prepared data. */
export class ProcessExecutionPreparedPublication {
  constructor(authority, { prepared, selection, options }) {
    if (authority !== preparedPublicationAuthority) throw new TypeError("Prepared publication plans must be inspected by the runtime");
    preparedPublicationPlans.set(this, { prepared, selection, options });
    this.checkoutIdentity = prepared.checkout;
    this.digest = selection.snapshot.digest;
    this.targets = Object.freeze(prepared.targets.map((target) => freezeExecutionValue(json(target))));
    Object.freeze(this);
  }
  toJSON() { return { checkoutIdentity: this.checkoutIdentity, digest: this.digest, targets: this.targets }; }
}

export class ProcessExecutionPublicationRecovery {
  constructor({ checkoutIdentity, ownerConfirmed }) {
    this.status = "data-recovered";
    this.checkoutIdentity = checkoutIdentity;
    this.workerOwnership = ownerConfirmed ? "unowned" : "unconfirmed";
    Object.freeze(this);
  }
  toJSON() { return { status: this.status, checkoutIdentity: this.checkoutIdentity, workerOwnership: this.workerOwnership }; }
}


/** Remaining encoded bytes only; it creates no future process or publication facts. */
class RuntimeTerminalCapacity {
  static uuidBytes = 38; // Canonical UUID JSON string, including quotes.
  static digestBytes = 66;
  static referenceBytes = 107; // RuntimeRequestReference's exact [UUID,SHA256] tuple.
  // IEEE754 shortest decimal has <=17 significant digits; signed fixed notation
  // near1e-6 is the longest JSON number spelling (at most25 bytes).
  static finiteNumberBytes = 25;
  static safeIntegerBytes = 16;
  static isoDateBytes = 29; // ISO date including quotes and a signed six-digit year.
  #registry;
  #planned;
  #encodedBytes;
  #internalFailureBytes = null;
  constructor(registry, planned, encodedBytes) {
    this.#registry = registry; this.#planned = planned; this.#encodedBytes = encodedBytes;
  }
  #value(value) { return Buffer.byteLength(JSON.stringify(value)); }
  #immutableValue(value) {
    // Only nominal, immutable checkout/binding/disclosure values reach here.
    // The cache belongs to that exact validated value, never a mutable call.
    if (!runtimeTerminalMetadataBytes.has(value)) runtimeTerminalMetadataBytes.set(value, this.#value(value));
    return runtimeTerminalMetadataBytes.get(value);
  }
  #fields(value, names) { return new Map(names.filter((key) => Object.hasOwn(value, key)).map((key) => [key, this.#value(value[key])])); }
  #entries(fields) {
    // Every replaced parent also has immutable fields. One comma per entry
    // makes differences exact even when an optional field is added or removed.
    return [...fields].reduce((bytes, [key, value]) => bytes + this.#value(key) + 2 + value, 0);
  }
  #object(fields) { return fields.size === 0 ? 2 : 1 + this.#entries(fields); }
  #array(sizes) { return 2 + Math.max(0, sizes.length - 1) + sizes.reduce((sum, size) => sum + size, 0); }
  #grow(fields, key, bytes) { fields.set(key, Math.max(fields.get(key) ?? 0, bytes)); }
  #closure(call) {
    return this.#object(new Map([["callId", this.#value(call.callId)],
      ["closureKind", this.#value("reservation-revoked")], ["closureDigest", RuntimeTerminalCapacity.digestBytes]]));
  }
  #event(call, type) {
    const uuid = RuntimeTerminalCapacity.uuidBytes;
    // Newly generated events reuse the exact immutable call binding and fact;
    // RuntimeStoredEvent therefore omits both binding and payload.
    return this.#object(new Map([["eventId", uuid], ["executionId", uuid], ["callId", uuid],
      ["parentCallId", this.#value(call.parentCallId)], ["rootCallId", uuid],
      ["sequence", RuntimeTerminalCapacity.safeIntegerBytes], ["type", this.#value(type)],
      ["occurredAt", RuntimeTerminalCapacity.isoDateBytes]]));
  }
  #remainingEvents(call, recorded) {
    if (callCompletion(call) !== null) return [];
    const types = [];
    if (call.observation === null) {
      if (!recorded.has("started")) types.push("started");
      // Exit and failed spawn are alternatives: charge the longer enum spelling.
      if (!recorded.has("exited") && !recorded.has("spawn-failed")) types.push("spawn-failed");
    }
    if (call.stopOperation === null && !recorded.has("stop-requested")) types.push("stop-requested");
    if (!recorded.has("stop-unconfirmed")) types.push("stop-unconfirmed");
    if (!recorded.has("result-finalized")) types.push("result-finalized");
    return types.map((type) => this.#event(call, type));
  }
  #failureVariants(fields, root, call, physical) {
    if (call.controlFailure === null) {
      const referenced = new Map(fields);
      referenced.set("controlFailure", 4); referenced.set("failureRequest", RuntimeTerminalCapacity.referenceBytes); referenced.set("failureConfirmed", 4);
      const internal = new Map(fields);
      // Only this internal first failure has no original request completion.
      // Its sole variable strings are the actual canonical UUID contexts.
      this.#internalFailureBytes ??= this.#value(runtimeStopUnconfirmedFailure(root.executionId, call.callId));
      internal.set("controlFailure", this.#internalFailureBytes);
      return [referenced, internal];
    }
    const confirmed = new Map(fields);
    if (call.controlFailure.communication?.stopConfirmation === "unknown") {
      // Current communication wire uses false -> true, which shrinks by one
      // UTF-8 byte while retaining every original failure and attempt field.
      if (physical.failureRequest === undefined) confirmed.set("controlFailure", fields.get("controlFailure") - 1);
      else confirmed.set("failureConfirmed", 4);
    }
    return [confirmed];
  }
  #callDebt(root, call, physical) {
    const names = ["status", "accepting", "aborted", "executor", "permit", "startedAt", "startedMonotonic", "stopOperation",
      "exitObservation", "terminalRequest", "revocationRequest", "observation", "output", "receipt", "outcome", "revocation",
      "controlFailure", "failureRequest", "failureConfirmed"];
    const before = this.#fields(physical, names), fields = new Map(before), uuid = RuntimeTerminalCapacity.uuidBytes;
    if (callCompletion(call) === null) {
      this.#grow(fields, "status", this.#value("stopped")); this.#grow(fields, "accepting", 5); this.#grow(fields, "aborted", 5);
      this.#grow(fields, "executor", this.#object(new Map([["executorId", uuid], ["executorSession", uuid], ["launchClaim", uuid]])));
      this.#grow(fields, "permit", this.#object(new Map([["executionId", uuid], ["callId", uuid], ["ownerEpoch", this.#value(root.ownerEpoch)],
        ["ownerToken", uuid], ["capability", uuid], ["bindingDigest", RuntimeTerminalCapacity.digestBytes]])));
      this.#grow(fields, "startedAt", RuntimeTerminalCapacity.isoDateBytes);
      this.#grow(fields, "startedMonotonic", RuntimeTerminalCapacity.finiteNumberBytes);
      this.#grow(fields, "stopOperation", this.#object(new Map([["requestId", uuid], ["reason", 82],
        ["graceMs", RuntimeTerminalCapacity.finiteNumberBytes], ["startedAt", RuntimeTerminalCapacity.finiteNumberBytes],
        ["deadline", RuntimeTerminalCapacity.finiteNumberBytes], ["clockSessionId", uuid]])));
      // These references are mutually exclusive. The longer field name bounds
      // every terminal branch; large result values remain in its completion.
      for (const key of ["exitObservation", "terminalRequest", "revocationRequest"]) fields.delete(key);
      fields.set("revocationRequest", RuntimeTerminalCapacity.referenceBytes);
      for (const key of ["observation", "output", "receipt", "outcome", "revocation"]) fields.set(key, 4);
    }
    const maximum = Math.max(this.#entries(before), ...this.#failureVariants(fields, root, call, physical).map((variant) => this.#entries(variant)));
    return maximum - this.#entries(before);
  }
  #cutoffFields(root, fence, calls, eventCount) {
    const event = this.#object(new Map([["eventId", RuntimeTerminalCapacity.uuidBytes],
      ["sequence", RuntimeTerminalCapacity.safeIntegerBytes], ["eventDigest", RuntimeTerminalCapacity.digestBytes]]));
    return new Map([["schemaVersion", 1], ["executionId", this.#value(root.executionId)], ["ownerEpoch", this.#value(root.ownerEpoch)],
      ["fenceId", this.#value(fence.fenceId)], ["selection", this.#value(fence.selection)],
      ["cutoffSequence", RuntimeTerminalCapacity.safeIntegerBytes], ["callClosures", this.#array(calls.map((call) => this.#closure(call)))],
      ["events", eventCount === 0 ? 2 : 2 + eventCount * event + eventCount - 1], ["evidenceDigest", RuntimeTerminalCapacity.digestBytes]]);
  }
  #fenceDebt(root, fence, futureEvents) {
    if (fence.barrier !== null) return 0;
    let fields, debt = 0;
    if (fence.cutoff === null) {
      const selected = root.calls.filter((call) => fence.selection.matches(call.binding));
      const count = root.events.filter((event) => fence.selection.matches(event.binding)).length
        + selected.reduce((sum, call) => sum + futureEvents.get(call.callId).length, 0);
      fields = this.#cutoffFields(root, fence, selected, count);
      debt += this.#object(fields) - 4;
    } else fields = this.#cutoffFields(root, fence, fence.cutoff.callClosures, fence.cutoff.events.length);
    fields.set("acknowledgementDigest", RuntimeTerminalCapacity.digestBytes);
    return debt + this.#object(fields) - 4;
  }
  #assertPrivateSinks(root, planned) {
    const uuid = RuntimeTerminalCapacity.uuidBytes, number = RuntimeTerminalCapacity.finiteNumberBytes;
    const integer = RuntimeTerminalCapacity.safeIntegerBytes, hash = RuntimeTerminalCapacity.digestBytes;
    const executor = this.#object(new Map([["executorId", uuid], ["executorSession", uuid], ["launchClaim", uuid]]));
    const output = this.#object(new Map([["stdoutBytes", integer], ["stderrBytes", integer],
      ["completion", this.#value("incomplete")], ["cutoffAt", RuntimeTerminalCapacity.isoDateBytes]]));
    const stop = this.#object(new Map([["requestId", uuid], ["reason", 82], ["graceMs", number],
      ["startedAt", number], ["deadline", number], ["clockSessionId", uuid]]));
    const descendants = new PhysicalCallIndex(root.calls).descendantMeasures((call) => this.#closure(call) + 1);
    for (const [index, call] of root.calls.entries()) {
      if (callCompletion(call) !== null) continue;
      const physical = planned.execution.calls[index];
      const source = physical.invocationRequest === undefined ? null
        : RuntimeReservationInvocation.fromCompletion(planned.inventory.completedRequest(physical.invocationRequest).completion);
      const disclosure = source === null ? ProcessExecutionInvocationDisclosure.capture(call.invocation) : source.invocation.disclosure;
      // Signal and outcome are variable inputs, not guessed finite maxima.
      // The actual full ManagedRecordWrite still enforces its original16MiB
      // bound before effects. Reserve all schema-bounded framing plus the exact
      // known observation, while never imposing a new signal or outcome cap.
      const observation = call.observation === null
        ? this.#object(new Map([["executor", executor], ["kind", this.#value("spawn-failed")], ["code", integer],
          ["signal", 4], ["errorCode", 128 * 6 + 2], ["observedAt", RuntimeTerminalCapacity.isoDateBytes]]))
        : this.#value(call.observation);
      const descendantBytes = descendants.get(call.callId);
      const receipt = this.#object(new Map([["schemaVersion", 1], ["scope", this.#value("registered-executions")],
        ["executionId", uuid], ["callId", uuid], ["ownerEpoch", this.#value(root.ownerEpoch)],
        ["checkoutIdentity", this.#immutableValue(this.#registry.checkout)], ["binding", this.#immutableValue(call.binding)],
        ["invocation", disclosure.invocation === null ? 4 : this.#immutableValue(disclosure.invocation)], ["invocationDigest", hash],
        ["executor", executor], ["observation", observation], ["output", output], ["closureRevision", integer],
        ["descendants", descendantBytes === 0 ? 2 : descendantBytes + 1], ["stopOperation", stop], ["outcomeDigest", hash]]));
      const bytes = this.#object(new Map([["schemaVersion", 1], ["scope", this.#value("registered-executions")],
        ["executionId", uuid], ["callId", uuid], ["ownerToken", uuid], ["capability", uuid], ["executor", executor],
        ["observation", observation], ["state", this.#value("finished")], ["outcome", this.#value(call.outcome)], ["receipt", receipt]]));
      if (bytes > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime admission would consume immutable metadata required by the bounded private finish record");
    }
  }
  #executionDebt(root, physical) {
    const recorded = new Map(root.calls.map((call) => [call.callId, new Set()]));
    for (const event of root.events) recorded.get(event.callId).add(event.type);
    const futureEvents = new Map(root.calls.map((call) => [call.callId, this.#remainingEvents(call, recorded.get(call.callId))]));
    const remaining = [...futureEvents.values()].flat();
    let debt = root.calls.reduce((sum, call, index) => sum + this.#callDebt(root, call, physical.calls[index]), 0);
    debt += remaining.reduce((sum, bytes) => sum + bytes + 1, 0);
    const handled = new Set([...root.eventAcknowledgements, ...root.runtimeOnlyDispositions].map((fact) => fact.eventId));
    const unpublished = root.events.filter((event) => !handled.has(event.eventId)).length + remaining.length;
    const acknowledgement = this.#object(new Map([["eventId", RuntimeTerminalCapacity.uuidBytes], ["eventDigest", RuntimeTerminalCapacity.digestBytes]]));
    debt += unpublished * (acknowledgement + 1);
    if (root.closure === null) debt += this.#object(new Map([["executionId", this.#value(root.executionId)], ["ownerEpoch", this.#value(root.ownerEpoch)],
      ["callClosures", this.#array(root.calls.map((call) => this.#closure(call)))], ["recovery", 5]])) - 4;
    const before = this.#fields(physical, ["accepting", "hostConnected", "status", "recoveryFence", "requestHistoryHead", "requestCompletionHead"]);
    const fields = new Map(before);
    this.#grow(fields, "accepting", 5); this.#grow(fields, "hostConnected", 5);
    this.#grow(fields, "status", this.#value("stopping")); this.#grow(fields, "recoveryFence", RuntimeTerminalCapacity.uuidBytes);
    this.#grow(fields, "requestHistoryHead", RuntimeTerminalCapacity.referenceBytes);
    this.#grow(fields, "requestCompletionHead", RuntimeTerminalCapacity.referenceBytes);
    debt += this.#entries(fields) - this.#entries(before);
    debt += root.finalizationFences.reduce((sum, fence) => sum + this.#fenceDebt(root, fence, futureEvents), 0);
    return debt;
  }
  assertFits() {
    for (const [index, root] of this.#registry.executions.entries()) this.#assertPrivateSinks(root, this.#planned[index]);
    const debt = this.#registry.executions.reduce((sum, root, index) => sum + this.#executionDebt(root, this.#planned[index].execution), 0);
    if (this.#encodedBytes + debt > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime admission would consume metadata required for exact terminal publication");
  }
}

function runtimeStopUnconfirmedFailure(executionId, callId) {
  return new ProcessExecutionControlFailure("stop-unconfirmed", "Registered child has no exact exit receipt at the coordinator stop cutoff", { executionId, callId });
}

/** Normalize and encode privately before any durable transition begins. */
class PreparedRuntimeRegistryPublication {
  #registry;
  #source;
  #requestPublications;
  #content;
  #requests;
  #store;
  #baseline;
  constructor(registry, store, options = {}) {
    this.#source = registry;
    this.#requestPublications = options.requestPublications ?? new RuntimeRequestPublications();
    this.#baseline = options.previous?.nextBaseline(registry, store, this.#requestPublications)
      ?? store.publicationBaseline(registry, this.#requestPublications);
    this.#registry = freezeRuntimeRegistry(new RuntimeRegistry(registry, new RuntimeRecordPreparation(runtimeRegistryObservationAuthority)));
    this.#store = store;
    const planned = this.#registry.executions.map((execution) => store.planExecution(execution, options));
    this.#requests = planned.flatMap((entry) => entry.writes);
    this.#content = encodeRuntimeRecord({ ...this.#registry.toJSON(), executions: planned.map((entry) => entry.execution) });
    new RuntimeTerminalCapacity(this.#registry, planned, Buffer.byteLength(this.#content)).assertFits();
    // Every dependency must fit its existing encoder limit before publication.
    for (const document of this.#requests) encodeRuntimeRecord(document);
    Object.freeze(this);
  }
  get registry() { return this.#registry; }
  get requestPublications() { return this.#requestPublications; }
  nextBaseline(registry, store, requestPublications) {
    const previous = this.#requestPublications.acceptedObservations();
    const current = requestPublications.acceptedObservations();
    if (registry !== this.#source || store !== this.#store || previous.length !== current.length
      || previous.some((observation, index) => observation !== current[index])) return null;
    // Successive cohort preparations change memory only. The final publisher
    // freshly checks every captured physical generation before any write.
    return this.#baseline;
  }
  forSave(registry, store, requestPublications) {
    if (store !== this.#store || requestPublications !== this.#requestPublications) return null;
    // Keep save's complete logical validation, including mutations introduced
    // by an observer. Only an exactly equal validated graph reuses its plan.
    const validated = freezeRuntimeRegistry(new RuntimeRegistry(registry,
      new RuntimeRecordPreparation(runtimeRegistryObservationAuthority)));
    return new RuntimePublicationExpectedRegistry(this.#registry).matches(validated, { exactEncoding: true }) ? this : null;
  }
  publish({ archiveObservation, effects = [], extraWrites = [] } = {}) {
    const requests = this.#requests.map((block) => new RuntimePublicationWrite(
      `requests/${block.executionId}/blocks/${block.blockId}.json`, encodeRuntimeRecord(block)));
    return this.#store.publishPrepared([...effects.map((write) => new RuntimePublicationWrite(
      path.relative(this.#store.authority.directory, write.transitionFile.filePath).split(path.sep).join("/"), write.transitionBytes)),
    ...effects.map((write) => new RuntimePublicationWrite(
      path.relative(this.#store.authority.directory, write.file).split(path.sep).join("/"), write.bytes)),
    ...requests, ...extraWrites, new RuntimePublicationWrite("registry.json", this.#content)], this.#registry, { archiveObservation, effects, baseline: this.#baseline });
  }
}

/** A detached typed next state, captured before publication has any effects.
 * Exact expanded readback can reuse its semantics without reconstructing the
 * same immutable values. This never supplies a physical observation. */
class RuntimePublicationExpectedRegistry {
  static #encodings = new WeakMap();
  static #recordEncodings = new WeakMap();
  #registry;
  #encoding;
  static #recordEncoding(record) {
    if (!immutableRuntimeCallRecords.has(record) && !immutableRuntimeRequestRecords.has(record)) {
      return new ProcessExecutionValueEncoding(record);
    }
    let captured = this.#recordEncodings.get(record);
    if (captured === undefined) {
      captured = new ProcessExecutionValueEncoding(record);
      this.#recordEncodings.set(record, captured);
    }
    return captured;
  }
  static #encode(registry) {
    const executions = ProcessExecutionValueEncoding.array(registry.executions.map((execution) =>
      ProcessExecutionValueEncoding.object(Object.entries(execution.toJSON()).map(([name, value]) => [name,
        name === "calls" || name === "requests"
          ? ProcessExecutionValueEncoding.array(value.map((record) => this.#recordEncoding(record)))
          : new ProcessExecutionValueEncoding(value),
      ]))));
    return ProcessExecutionValueEncoding.object(Object.entries(registry.toJSON()).map(([name, value]) => [name,
      name === "executions" ? executions : new ProcessExecutionValueEncoding(value),
    ]));
  }
  constructor(registry) {
    if (!(registry instanceof RuntimeRegistry)) throw new TypeError("Publication meaning requires a validated runtime registry");
    this.#registry = freezeRuntimeRegistry(registry);
    // Only this owner's complete frozen nominal graph enters the map. The
    // encoding carries no physical observation and cannot replace fresh IO.
    this.#encoding = RuntimePublicationExpectedRegistry.#encodings.get(this.#registry)
      ?? RuntimePublicationExpectedRegistry.#encode(this.#registry);
    RuntimePublicationExpectedRegistry.#encodings.set(this.#registry, this.#encoding);
    Object.freeze(this);
  }
  read(expanded) {
    return this.#encoding.matchesJSON(expanded) ? this.#registry : null;
  }
  matches(registry, { exactEncoding = false } = {}) {
    if (registry === this.#registry) return true;
    const encoding = RuntimePublicationExpectedRegistry.#encodings.get(registry)
      ?? RuntimePublicationExpectedRegistry.#encode(registry);
    return exactEncoding ? encoding.matches(this.#encoding) : encoding.hasSameValue(this.#encoding);
  }
}


class ValidatedRuntimeRegistryObservation {
  #registry;
  #snapshot;
  #linkedSnapshots;
  constructor(authority, registry, snapshot, linkedSnapshots = null) {
    if (authority !== runtimeRegistryObservationAuthority) throw new TypeError("Registry observations require their validated source");
    this.#registry = registry;
    this.#snapshot = snapshot;
    this.#linkedSnapshots = linkedSnapshots === null ? null : new Map(linkedSnapshots);
    Object.freeze(this);
  }
  static fromValidatedRead(registry, snapshot, linkedSnapshots = null) {
    return new ValidatedRuntimeRegistryObservation(runtimeRegistryObservationAuthority, freezeRuntimeRegistry(registry), snapshot, linkedSnapshots);
  }
  read(snapshot, linkedSnapshots = null) {
    if (snapshot === null || !sameRuntimeRecordSnapshot(this.#snapshot, snapshot)) return null;
    if (this.#linkedSnapshots !== null && (linkedSnapshots === null || linkedSnapshots.size !== this.#linkedSnapshots.size
      || [...this.#linkedSnapshots].some(([relativePath, previous]) => {
        const current = linkedSnapshots.get(relativePath);
        return current === undefined || (previous === null ? current !== null : !sameRuntimeRecordSnapshot(previous, current));
      }))) return null;
    return this.#registry;
  }
  mutableCopy() { return this.#registry.mutableCopy(runtimeRegistryObservationAuthority); }
  owns(registry) { return registry === this.#registry || registry[runtimeRecordOrigin] === this.#registry; }
  assertMatches(registry) {
    if (registry !== this.#registry && !new RuntimePublicationExpectedRegistry(this.#registry).matches(registry)) {
      fail("record-corrupt", "Runtime durable readback differs from the committed inventory");
    }
  }
}

/** Data-only reuse within one publication; physical checks are never retained. */
class ValidatedRuntimePublicationData {
  #meaning;
  #observation;
  #storage;
  constructor(authority, prepared, registry, snapshots, storage) {
    if (authority !== runtimeRegistryObservationAuthority) throw new TypeError("Publication data requires its complete validated readback");
    this.#meaning = new ProcessExecutionValueEncoding(prepared);
    this.#observation = new ValidatedRuntimeRegistryObservation(authority, freezeRuntimeRegistry(registry),
      snapshots.get("registry.json"), snapshots);
    this.#storage = storage;
    Object.freeze(this);
  }
  read(prepared, snapshots) {
    if (!this.#meaning.matches(new ProcessExecutionValueEncoding(prepared))) return null;
    return this.#observation.read(snapshots.get("registry.json"), snapshots);
  }
  canRetain(prepared, registry) {
    return this.#meaning.matches(new ProcessExecutionValueEncoding(prepared)) && this.#observation.owns(registry);
  }
  retain(store, registry, snapshots) {
    if (!this.#observation.owns(registry)) throw new TypeError("Publication readback requires its exact validated registry");
    store.retainPublicationRead(registry, snapshots, this.#storage);
  }
}

/** Strict archive decoding bound to one captured physical file. */
class ValidatedRuntimeArchiveObservation {
  #snapshot;
  #archive;
  constructor(snapshot, filePath, checkout, name, storage) {
    const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, filePath);
    if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime archive checksum is invalid");
    refusePreviousRuntimeRecord(envelope.payload, checkout);
    const expanded = { ...envelope.payload, execution: expandStoredRuntimeExecution(storage, envelope.payload.execution) };
    const archive = exact(expanded, new ClosedProcessExecutionArchive(expanded));
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
  matchesSnapshot(snapshot, checkout, name) {
    return this.#matchesCheckout(checkout, name) && sameRuntimeRecordSnapshot(this.#snapshot, snapshot);
  }
  matches(snapshot, checkout, name, store) {
    return this.matchesSnapshot(snapshot, checkout, name)
      && store.unchangedExecution(this.#archive.execution.executionId);
  }
  get archive() { return this.#archive; }
  get snapshot() { return this.#snapshot; }
}

/** Strong decoding reuse for one inventory observation or exclusive RPC. */
class RuntimeRecordObservation {
  #observations = new Map();
  publicationSnapshots() {
    return new Map([...this.#observations].map(([filePath, observation]) => [`archives/${path.basename(filePath)}`, observation.snapshot]));
  }

  readUnchangedArchives(files, checkout, retainedObservations, store, baseline) {
    if (baseline === null) return null;
    const snapshots = new Map(files.map(file => [file,
      baseline.snapshots.get(`archives/${path.basename(file.filePath)}`)]));
    if ([...snapshots.values()].some(snapshot => snapshot === undefined)) return null;
    const executionIds = files.map(file => path.basename(file.filePath, ".json"));
    // A failed earlier read may have observed another valid request head. Such
    // a plan miss must use the normal reader rather than reject restored data.
    const heads = new Map(files.map((file, index) => [executionIds[index], RuntimeRequestHeads.fromExecution(
      decodeRuntimeJson(snapshots.get(file).bytes, file.filePath).payload.execution)]));
    const captured = store.requestStorage.captureUnchangedExecutions(executionIds, snapshots, heads);
    if (captured === null) return null;
    const view = captured.view(store), storage = store.requestStorage.fork(view);
    return files.map(file => this.readPrepared(view.file(`archives/${path.basename(file.filePath)}`),
      checkout, path.basename(file.filePath), retainedObservations, storage));
  }
  read(file, checkout, name, retainedObservations, store) {
    // Every observation still captures and validates the actual physical file.
    return this.readCaptured(file, file.readSnapshot(), checkout, name, retainedObservations, store);
  }
  readCaptured(file, snapshot, checkout, name, retainedObservations, store) {
    const previous = this.#observations.get(file.filePath) ?? retainedObservations.get(file.filePath);
    if (snapshot !== null && previous?.matches(snapshot, checkout, name, store)) {
      this.#observations.set(file.filePath, previous);
      return previous.archive;
    }
    return this.#restore(file, snapshot, checkout, name, retainedObservations, store.requestStorage);
  }
  readPrepared(file, checkout, name, retainedObservations, storage) {
    // Both callers own a complete captured archive/block graph and its exact
    // namespaces. Prepared publication also recaptures that complete graph
    // after decoding; no per-archive Native reread belongs inside this interval.
    // The immutable decoder survives RPC boundaries; its complete physical graph is still fresh.
    const snapshot = file.readSnapshot();
    const previous = this.#observations.get(file.filePath) ?? retainedObservations.get(file.filePath);
    if (snapshot !== null && previous?.matchesSnapshot(snapshot, checkout, name)) {
      this.#observations.set(file.filePath, previous);
      return previous.archive;
    }
    return this.#restore(file, snapshot, checkout, name, retainedObservations, storage);
  }
  #restore(file, snapshot, checkout, name, retainedObservations, storage) {
    this.#observations.delete(file.filePath);
    retainedObservations.delete(file.filePath);
    const observation = new ValidatedRuntimeArchiveObservation(snapshot, file.filePath, checkout, name, storage);
    this.#observations.set(file.filePath, observation);
    retainedObservations.set(file.filePath, observation);
    return observation.archive;
  }
}
function encodeRuntimeRecord(record) {
  if (record instanceof RuntimeRequestBlock || record instanceof RuntimeRequestCompletionCarrier
    || record instanceof RuntimeRequestContinuationBlock || record instanceof RuntimeStandaloneRequestDocument) {
    if (record.encodedByteLength() > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime metadata exceeds the durable size limit before publication");
    return record.encodedRecord();
  }
  const payload = new ProcessExecutionValueEncoding(record);
  const content = `{"payload":${payload.text()},"digest":"${payload.digest}"}`;
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime metadata exceeds the durable size limit before publication");
  return content;
}

/** One request's immutable publication inputs; not execution authority. */
class RuntimeRequestPublication {
  constructor({ observedRequest = null, settledRequest = null, completedRequest = null, acceptedRequest = null } = {}) {
    this.observedRequest = observedRequest; this.settledRequest = settledRequest;
    this.completedRequest = completedRequest; this.acceptedRequest = acceptedRequest;
    Object.freeze(this);
  }
}

/** Lossless inputs for the existing request-block planner and physical baseline. */
class RuntimeRequestPublications {
  #entries;
  constructor(entries = []) {
    if (entries.some((entry) => !(entry instanceof RuntimeRequestPublication))) throw new TypeError("Request publications require nominal per-request facts");
    this.#entries = Object.freeze([...entries]); Object.freeze(this);
  }
  static single(options) { return new this([new RuntimeRequestPublication(options)]); }
  concat(other) {
    if (!(other instanceof RuntimeRequestPublications)) throw new TypeError("Expected request publication facts");
    return new RuntimeRequestPublications([...this.#entries, ...other.#entries]);
  }
  observationFor(executionId, requestId) {
    return this.#entries.find(({ observedRequest: fact }) => fact?.executionId === executionId && fact.requestId === requestId)?.observedRequest ?? null;
  }
  settlementFor(executionId, requestId) {
    return this.#entries.find(({ settledRequest: fact }) => fact?.executionId === executionId && fact.requestId === requestId)?.settledRequest ?? null;
  }
  confirmsFirstSettlement(call) {
    return this.#entries.some(({ settledRequest: fact }) => fact?.firstFinish instanceof RuntimeFirstCallSettlement && fact.firstFinish.matches(call));
  }
  acceptedObservations() { return this.#entries.map((entry) => entry.acceptedRequest).filter((fact) => fact !== null); }
  completedRequests(executionId = null) {
    return this.#entries.map((entry) => entry.completedRequest).filter((fact) => fact !== null && (executionId === null || fact.executionId === executionId));
  }
}

class RuntimeAcceptedRequestObservation {
  constructor(executionId, requestId, snapshot) {
    this.relativePath = `requests/${uuid(executionId, "accepted execution ID")}/${uuid(requestId, "accepted request ID")}.json`;
    this.snapshot = snapshot;
    Object.freeze(this);
  }
  matches(executionId, requestId) { return this.relativePath === `requests/${executionId}/${requestId}.json`; }
}

/** One completed private request, bound to its original pending generation. */
class RuntimeStandaloneRequestResultPublication {
  #content;
  constructor(ledger, executionId, request, acceptance) {
    if (!(ledger instanceof AtomicFile) || !(request instanceof RuntimeRequestRecord)
      || !(acceptance instanceof RuntimeAcceptedRequestObservation) || request.response === null
      || !acceptance.matches(executionId, request.requestId)) throw new TypeError("Standalone result requires its exact pending request");
    this.ledger = ledger; this.acceptance = acceptance; this.executionId = executionId;
    this.#content = encodeRuntimeRequest(executionId, request);
    Object.freeze(this);
  }
  publish() {
    const assertAccepted = () => {
      if (!sameRuntimeRecordSnapshot(this.acceptance.snapshot, this.ledger.readSnapshot())) {
        fail("authority-mismatch", "Pending output request changed its accepted generation", { executionId: this.executionId });
      }
    };
    assertAccepted();
    const guard = this.ledger.commitGuard;
    this.ledger.commitGuard = (event) => { guard(event); assertAccepted(); };
    try { return this.ledger.write(this.#content); }
    catch (cause) { throw processExecutionControlFailureFromCause(cause) ?? cause; }
    finally { this.ledger.commitGuard = guard; }
  }
}

class RuntimePublicationBaseline {
  constructor(observation, snapshots) { this.observation = observation; this.snapshots = snapshots; Object.freeze(this); }
  targetGeneration(relativePath, captured) {
    const observed = this.snapshots.get(relativePath);
    if (observed !== undefined && (captured === null || !sameRuntimeRecordSnapshot(observed, captured))) {
      fail("authority-mismatch", "Prepared runtime target changed from its exact validated source");
    }
    const canonical = /^(?:archives\/[^/]+\.json|requests\/[^/]+\/blocks\/[^/]+\.json)$/.test(relativePath);
    if (observed === undefined && canonical && captured !== null) {
      fail("authority-mismatch", "A new canonical runtime target appeared after the validated source inventory");
    }
    return RuntimeFileGeneration.capture(observed ?? captured);
  }
  assertCurrent(store) {
    const files = new Map([...this.snapshots].map(([relativePath, snapshot]) => {
      const file = store.publicationFile(relativePath, { create: false });
      if (file === null || snapshot === null) fail("authority-mismatch", "Runtime preparation lost the exact validated source generation");
      return [file, snapshot];
    }));
    if (!AtomicFile.snapshotsMatch(files)) fail("authority-mismatch", "Runtime preparation lost the exact validated source generation");
  }
  publicationFile(store, relativePath) { return store.publicationFile(relativePath); }
  sources(targets) {
    const paths = new Set(targets.map((target) => target.relativePath));
    return [...this.snapshots].filter(([relativePath]) => !paths.has(relativePath))
      .map(([relativePath, snapshot]) => new RuntimePublicationSource({ relativePath, generation: json(RuntimeFileGeneration.capture(snapshot)) }));
  }
  parents(store, owned, sources) {
    return [store.callsAuthority, store.archivesAuthority, ...owned.map(({ file }) => file.directoryAuthority),
      ...sources.map((source) => source.directoryAuthority(store)),
      ...store.observeCallDirectories(store.callsAuthority.entries())];
  }
  directoryEntries(relativePath, view, authority) {
    return ["calls", "archives"].includes(relativePath) || relativePath.endsWith("/blocks") ? view.entries(relativePath, authority).sort() : null;
  }
  prepare(value) { return new RuntimePreparedPublication(value); }
  discardCreatedParents() {}
}

/** Original absence is consumed only by genuine exclusive child creation. */
class RuntimeRecordMigrationBaseline extends RuntimePublicationBaseline {
  #capture;
  #created = new Map();
  constructor(capture) {
    super(null, new Map(capture.sourceObservations().map((source) => [source.relativePath, source.snapshot])));
    this.#capture = capture;
  }
  assertCurrent() { this.#capture.assertCurrent(); }
  targetGeneration(relativePath, captured) {
    const observed = this.snapshots.get(relativePath);
    if (observed !== undefined) {
      if (captured === null || !sameRuntimeRecordSnapshot(observed, captured)) fail("authority-mismatch", "Migration target changed its original full generation");
      return RuntimeFileGeneration.capture(observed);
    }
    if (captured !== null || !this.#capture.absenceObservations().some((absence) => absence.relativePath === relativePath)) {
      fail("authority-mismatch", "Migration target lacks its original exact absence");
    }
    return null;
  }
  publicationFile(store, relativePath) {
    const segments = relativePath.split("/").slice(0, -1);
    let parent = store.authority;
    for (const segment of segments) {
      const directoryPath = path.join(parent.directory, segment);
      const relative = path.relative(store.authority.directory, directoryPath).split(path.sep).join("/");
      const absence = this.#capture.absenceObservations().find((entry) => entry.relativePath === relative);
      if (absence !== undefined && !this.#created.has(relative)) {
        absence.assertCurrent();
        const created = parent.createExclusiveChild(segment, { creationMode: 0o700 });
        this.#created.set(relative, { authority: created, absence });
        parent = created;
      } else {
        parent = this.#created.get(relative)?.authority ?? parent.descendant(directoryPath);
        parent.assertStable();
      }
    }
    const file = store.publicationFile(relativePath, { create: false });
    if (file === null) fail("record-missing", "Migration-created target parent is missing");
    return file;
  }
  sources(targets) {
    const paths = new Set(targets.map((target) => target.relativePath));
    return this.#capture.sourceObservations().filter((source) => !paths.has(source.relativePath))
      .map((source) => new RuntimeRecordMigrationPreservedSource({ relativePath: source.relativePath, generation: json(source.generation) }));
  }
  parents(store, owned, sources) {
    return [...super.parents(store, owned, sources), ...this.#capture.directoryObservations().map((directory) => directory.assertMatches(store)),
      ...[...this.#created.values()].map((entry) => entry.authority)];
  }
  directoryEntries(relativePath, view, authority) {
    const original = this.#capture.directoryObservations().find((directory) => directory.relativePath === relativePath);
    const expected = new Set(original?.entries ?? []);
    for (const relative of this.#created.keys()) if (path.posix.dirname(relative) === relativePath) expected.add(path.posix.basename(relative));
    for (const target of view.targets) if (path.posix.dirname(target.relativePath) === relativePath) {
      const name = path.posix.basename(target.relativePath);
      if (target.removal) expected.delete(name); else expected.add(name);
    }
    const actual = view.entries(relativePath, authority).sort();
    if (!isDeepStrictEqual(actual, [...expected].sort())) fail("authority-mismatch", "Migration source namespace changed during original staging");
    return actual;
  }
  prepare(value) {
    const standaloneRequests = this.#capture.targets.filter((target) => /^requests\/[^/]+\/[^/]+\.json$/.test(target.relativePath)).map((target) => {
      const [, executionId, requestName] = target.relativePath.split("/");
      const envelope = JSON.parse(target.bytes.toString("utf8"));
      const request = RuntimeStandaloneRequestDocument.fromEnvelope(executionId, requestName.slice(0, -5), envelope).requestRecord();
      return { relativePath: target.relativePath, digest: digest(request.toJSON()) };
    });
    const createdParents = [...this.#created].map(([relativePath, entry]) => ({ relativePath, identity: entry.authority.identity.toJSON(),
      ancestorRelativePath: entry.absence.ancestorRelativePath, ancestorIdentity: entry.absence.ancestorIdentity.toJSON() }));
    const targets = new Set(value.targets.map((target) => target.relativePath));
    const namespaceAbsences = this.#capture.absenceObservations().filter((absence) => !this.#created.has(absence.relativePath) && !targets.has(absence.relativePath)).map((absence) => json(absence));
    return new RuntimePreparedRecordMigration({ ...value, phase: RuntimePreparedRecordMigration.phase, owner: null, ownerIdentity: null,
      logicalDigest: digest(this.#capture.logicalInventory), standaloneRequests, createdParents, namespaceAbsences });
  }
  discardCreatedParents() {
    for (const { authority } of [...this.#created.values()].reverse()) authority.removeEmpty();
  }
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

/** One unchanged source file; binary artifacts use the same full physical reader. */
class RuntimeRecordMigrationSource {
  constructor(relativePath, snapshot, streamed = false) {
    this.relativePath = new LogicalRelativePath(relativePath, "runtime migration source").toString();
    this.snapshot = snapshot;
    this.generation = RuntimeFileGeneration.capture(snapshot);
    this.streamed = streamed;
    Object.freeze(this);
  }
  capture(store) {
    const filePath = path.join(store.authority.directory, ...this.relativePath.split("/"));
    const directoryAuthority = store.authority.descendant(path.dirname(filePath));
    const actual = this.streamed
      ? visitRegularFileChunks(filePath, { label: "runtime migration preserved artifact", maxBytes: Number.MAX_SAFE_INTEGER - 1,
        requireSingleLink: true, directoryAuthority, expectedIdentity: this.generation.identity, visit() {} })
      : new AtomicFile(filePath, { directoryAuthority, maxBytes: MAX_REGISTRY_BYTES }).readSnapshot();
    if (!this.generation.matches(actual)) fail("authority-mismatch", "Runtime migration source changed its exact generation");
    return actual;
  }
  toJSON() { return { relativePath: this.relativePath, generation: this.generation, streamed: this.streamed }; }
}

/** Stored absence never invents a missing authority: its ancestor is actually recaptured. */
class RuntimeRecordMigrationAbsenceProof {
  constructor(value) {
    this.relativePath = new LogicalRelativePath(value.relativePath, "runtime migration absence").toString();
    this.ancestorRelativePath = value.ancestorRelativePath;
    if (this.ancestorRelativePath !== ".") {
      new LogicalRelativePath(this.ancestorRelativePath, "runtime migration absence ancestor");
      if (!this.relativePath.startsWith(`${this.ancestorRelativePath}/`)) throw new TypeError("Migration absence is outside its recorded ancestor");
    }
    this.ancestorIdentity = FileIdentity.fromStored(value.ancestorIdentity);
    exact(value, this); Object.freeze(this);
  }
  assertCurrent(store) {
    const ancestor = this.ancestorRelativePath === "." ? store.authority
      : store.authority.descendant(path.join(store.authority.directory, ...this.ancestorRelativePath.split("/")));
    ancestor.assertStable();
    if (!sameFileIdentity(this.ancestorIdentity, ancestor.identity)) fail("authority-mismatch", "Runtime migration absence ancestor changed its exact generation");
    const filePath = path.join(store.authority.directory, ...this.relativePath.split("/"));
    try { fs.lstatSync(filePath); }
    catch (cause) { if (cause.code === "ENOENT") { ancestor.assertStable(); return; } throw cause; }
    fail("authority-mismatch", "Runtime migration original absence changed");
  }
  toJSON() { return { relativePath: this.relativePath, ancestorRelativePath: this.ancestorRelativePath, ancestorIdentity: this.ancestorIdentity }; }
}

/** One read-only original absence, bound to its actual selected Store. */
class RuntimeRecordMigrationAbsence extends RuntimeRecordMigrationAbsenceProof {
  #store;
  constructor(store, relativePath) {
    const selected = new LogicalRelativePath(relativePath, "runtime migration absence").toString();
    const filePath = path.join(store.authority.directory, ...selected.split("/"));
    const ancestor = store.authority.descendant(path.dirname(filePath), { allowMissing: true });
    super({ relativePath: selected, ancestorRelativePath: path.relative(store.authority.directory, ancestor.directory).split(path.sep).join("/") || ".",
      ancestorIdentity: ancestor.identity.toJSON() });
    this.#store = store; this.assertCurrent();
  }
  assertCurrent() { return super.assertCurrent(this.#store); }
}

/** Data and exact physical observations only; it grants no worker or migration ownership. */
export class ProcessExecutionRuntimeRecordMigrationCapture {
  #store;
  #sources;
  #directories;
  #absences;
  constructor(authority, { store, conversion, logicalRegistry, sources, directories, absences }) {
    if (authority !== recordMigrationCaptureAuthority) throw new TypeError("Migration captures require the actual Store observation");
    this.#store = store; this.#sources = Object.freeze([...sources]); this.#directories = Object.freeze([...directories]); this.#absences = Object.freeze([...absences]);
    this.checkout = store.checkout;
    this.conversion = conversion;
    this.logicalRegistry = freezeExecutionValue(logicalRegistry);
    this.logicalInventory = conversion.logicalInventory;
    const paths = new Set(conversion.targets.map((target) => target.relativePath));
    const removals = this.#sources.filter((source) => /^requests\/[^/]+\/blocks\/[^/]+\.json$/.test(source.relativePath)
      && !paths.has(source.relativePath)).map((source) => new RuntimeRecordMigrationRemoval(source.relativePath, source.snapshot.bytes));
    this.targets = Object.freeze([...conversion.targets.slice(0, -1), ...removals, conversion.targets.at(-1)]);
    this.fingerprint = digest({ checkout: this.checkout, runtimeIdentity: store.authority.identity,
      sources: this.#sources, directories: this.#directories, absences: this.#absences });
    Object.freeze(this);
  }
  assertCurrent() {
    this.#store.assertRecordMigrationQuiescent();
    for (const directory of this.#directories) {
      const actual = directory.assertMatches(this.#store);
      if (!isDeepStrictEqual(actual.entries().sort(), directory.entries)) fail("authority-mismatch", "Runtime migration namespace membership changed");
    }
    for (const source of this.#sources) source.capture(this.#store);
    for (const absence of this.#absences) absence.assertCurrent();
    this.#store.assertRecordMigrationQuiescent();
  }
  assertStore(store) { if (store !== this.#store) throw new TypeError("Migration capture belongs to another Store observation"); }
  sourceObservations() { return this.#sources; }
  directoryObservations() { return this.#directories; }
  absenceObservations() { return this.#absences; }
  toJSON() { return { sourceVersion: this.conversion.sourceVersion, targetVersion: RUNTIME_RECORD_VERSION, checkout: this.checkout,
    fingerprint: this.fingerprint, sourceFiles: this.#sources.length, targetFiles: this.targets.length,
    canonicalExecutions: this.logicalInventory.executions.length }; }
}

/** Only a captured predecessor block may be retired by an offline migration. */
class RuntimeRecordMigrationRemoval extends RuntimePublicationWrite {
  get removal() { return true; }
}

/** The exact owner lock acquired solely for an explicit offline migration. */
class RuntimeRecordMigrationExclusion {
  constructor(store, published) {
    this.store = store;
    this.identity = new FileIdentity(published.stat);
    this.owner = new LockOwnerSession(published.owner);
    Object.freeze(this);
  }
  assertCurrent(published) {
    if (published === null || !sameFileIdentity(this.identity, published.stat)
      || this.owner.ownerToken !== published.owner.ownerToken || this.owner.ownerSession !== published.owner.ownerSession) {
      fail("ownership-changed", "Runtime migration lost its exact exclusion generation");
    }
  }
}

class ProcessRuntimeStore {
  #coalescedRequestAdmission = null;
  #recordMigrationExclusion = null;
  #recordMigrationContext = null;
  #lastRecordMigrationPlan = null;
  // Reuse physical directory authorities, never observations of file contents.
  // Each AtomicFile operation still rechecks the complete retained chain and
  // captures fresh file bytes, digest, link count and exact physical identity.
  #directoryAuthorities = new Map();
  // Data reuse only: every read still revalidates physical authority/inventory.
  #readonlyObservation = null;
  #publicationBaseline = null;
  // Keep immutable decoders for the current archive inventory while this Store
  // is alive. Every request still verifies complete physical bytes and identity.
  #archiveObservations = new Map();
  constructor({ mainRoot, executionRoot, faultInjector = () => {}, create = true, retainedClosed = false, historical = false, storagePolicy = null, migrationSource = false }) {
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
      const envelope = readJson(this.file);
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Retained checkout registry checksum is invalid");
      if ([8, 9].includes(envelope.payload.version)) {
        const previous = exact(anchor, new PreviousProcessExecutionEvidenceCodec().checkout(anchor));
        if (!migrationSource) refusePreviousRuntimeRecord(envelope.payload, previous);
        this.checkout = new ProcessExecutionCheckoutIdentity({ ...anchor, mainDevice: previous.mainDevice, mainInode: previous.mainInode,
          checkoutDevice: previous.checkoutDevice, checkoutInode: previous.checkoutInode });
      } else this.checkout = exact(anchor, new ProcessExecutionCheckoutIdentity(anchor));
      if (this.checkout.executionRoot !== this.retainedExecutionRoot
        || this.checkout.mainRoot !== this.mainAuthority.directory
        || this.checkout.mainDevice !== this.mainAuthority.identity.dev.toString()
        || this.checkout.mainInode !== this.mainAuthority.identity.ino.toString()) {
        fail("authority-mismatch", "Retained checkout anchor disagrees with its original namespace or actual main authority");
      }
    }
    this.transition = new AtomicFile(path.join(this.authority.directory, "transition.json"), { directoryAuthority: this.authority, maxBytes: MAX_REGISTRY_BYTES });
    this.lockAuthority = new RepositoryLockAuthority(this.mainAuthority.directory, { rootAuthority: this.mainAuthority, storagePolicy,
      errorFactory: (_status, message, { cause } = {}) => new ProcessExecutionControlFailure("ownership-unknown", message, { cause }) });
    const location = (fileName) => this.lockAuthority.location({ namespace: "process-runtime", identity: this.checkout.executionRoot,
      fileName, legacyPaths: [path.join(this.authority.directory, fileName)] });
    this.ownerLock = new ProcessLock({ location: location("owner.lock"), authority: json(this.checkout), kind: "checkout-process-runtime" });
    this.admissionOptions = { location: location("admission.lock"), authority: json(this.checkout), kind: "process-runtime-admission" };
    this.admission = new FileLock(this.admissionOptions);
    this.tail = Promise.resolve();
    this.requestStorage = new RuntimeRequestStorage(this);
  }
  #assertStoragePolicy() {
    this.storagePolicy?.assertStable();
    if (this.checkoutAuthority === null && !this.historical) {
      try {
        fs.lstatSync(this.retainedExecutionRoot);
        fail("authority-mismatch", "Retained checkout path reappeared during inspection");
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
  }
  #stableAuthorities(additionalAuthorities) {
    return [this.mainAuthority, ...(this.checkoutAuthority === null ? [] : [this.checkoutAuthority]),
      this.authority, this.callsAuthority, this.archivesAuthority, ...additionalAuthorities];
  }
  // Private nominal value keeps policy access in this Store, without exposing
  // an arbitrary callback or a process-global directory freshness cache.
  static #StableObservation = class RuntimeStoreStableObservation {
    #store;
    #forest;
    constructor(store, forest) { this.#store = store; this.#forest = forest; Object.freeze(this); }
    complete() { this.#store.#assertStoragePolicy(); this.#forest.complete(); }
    discard() { this.#forest.discard(); }
  };
  beginStableObservation({ additionalAuthorities = [] } = {}) {
    this.#assertStoragePolicy();
    return new ProcessRuntimeStore.#StableObservation(this,
      RealDirectoryAuthority.beginObservation(this.#stableAuthorities(additionalAuthorities)));
  }
  assertStable({ additionalAuthorities = [] } = {}) {
    this.#assertStoragePolicy();
    RealDirectoryAuthority.assertAllStable(this.#stableAuthorities(additionalAuthorities));
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
  /** Coalesce only an open tail admission; any intervening exclusive call
   * remains a FIFO barrier. Physical locks, deadlines and result-before-next
   * publication remain exclusively owned by exclusive(), including failures.
   */
  coalesceRequest(request, groupedBody, serialBody) {
    let admission = this.#coalescedRequestAdmission;
    if (admission === null || !admission.append(request, this.tail)) {
      admission = new RuntimeRequestCohortAdmission(request);
      this.#coalescedRequestAdmission = admission;
      const completion = this.exclusive(async (store, archiveObservation) => {
        // Drain a growing ready stream without surrendering this admission's
        // place in the existing FIFO or waiting for an absent peer.
        await admission.close();
        const messages = admission.messages;
        const grouped = messages.length > 1 ? groupedBody(messages, store, archiveObservation) : null;
        if (grouped !== null) return grouped;
        const responses = [];
        for (const [index, message] of messages.entries()) {
          const response = serialBody(message, store, archiveObservation);
          responses.push(response);
          if (index + 1 < messages.length) {
            // Serial fallback has no common publication. This member's full
            // durable readback already completed; publish it before the next
            // independent body can block its consumer or transport response.
            admission.resolveMember(index, response);
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        return responses;
      });
      admission.bindTail(this.tail);
      completion.then((responses) => admission.resolve(responses), (cause) => admission.reject(cause))
        .finally(() => { if (this.#coalescedRequestAdmission === admission) this.#coalescedRequestAdmission = null; });
    }
    return request.response;
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
  read(options = {}) { return this.#readRecords(options)?.registry ?? null; }
  #readRecords({ required = true, archiveObservation = new RuntimeRecordObservation(), immutable = false } = {}) {
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
  #read(archiveObservation = new RuntimeRecordObservation(), publication = null, immutable = false, prepared = null) {
    this.assertStable();
    const anchorSnapshot = this.anchor.readSnapshot();
    const anchor = decodeRuntimeJson(anchorSnapshot?.bytes ?? null, this.anchor.filePath);
    if (!isDeepStrictEqual(anchor, json(this.checkout))) {
      // A known predecessor can select migration preview only after its
      // original anchor, registry checksum and actual checkout all agree.
      if (typeof anchor?.mainDevice === "number") {
        const previous = new PreviousProcessExecutionEvidenceCodec().checkout(anchor);
        if (!previous.matches(this.checkout)) fail("authority-mismatch", "Previous checkout anchor differs from actual authority");
        const envelope = readJson(this.file);
        if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Previous registry checksum is invalid");
        refusePreviousRuntimeRecord(envelope.payload, previous);
      }
      fail("authority-mismatch", "Persisted checkout identity does not match runtime authority");
    }
    const snapshot = this.file.readSnapshot();
    let observed = this.#readonlyObservation?.read(snapshot) ?? null;
    if (observed !== null && observed.executions.some((execution) => !this.unchangedExecution(execution.executionId))) observed = null;
    if (observed === null) this.#readonlyObservation = null;
    let registry = observed;
    if (registry === null) {
      const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, this.file.filePath);
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime registry checksum is invalid");
      refusePreviousRuntimeRecord(envelope.payload, this.checkout);
      if (envelope.payload.version !== RUNTIME_RECORD_VERSION) fail("record-unsupported", "Legacy process registry requires explicit migration");
      const executions = envelope.payload.executions.map((execution) => this.requestStorage.expandExecution(execution));
      // Only the freshly verified complete request scope supplies this one-use
      // semantic proof. Archives and global inventory still validate below.
      registry = prepared?.consumeValidatedRegistry(snapshot, this.requestStorage.publicationSnapshots(
        new Set(envelope.payload.executions.map((execution) => execution.executionId)))) ?? null;
      if (registry === null) {
        const expanded = { ...envelope.payload,
          executions: executions.map((execution) => expandStoredRuntimeExecutionFacts(this.requestStorage, execution)) };
        registry = exact(expanded, new RuntimeRegistry(expanded));
      }
    }
    if (!isDeepStrictEqual(json(registry.checkout), json(this.checkout))) fail("authority-mismatch", "Runtime registry belongs to a different checkout");
    const inventory = this.#assertInventory(registry, archiveObservation);
    // Reuse only an immutable graph of these exact physical bytes. Every
    // request freshly checks archive files and the complete inventory.
    // Publication readback keeps the original exact-identity/full-comparison
    // check before retaining any graph. save() invalidates it on later failure
    // and returns a detached working graph only after the transition completes.
    publication?.assertMatches(registry);
    this.#retainRead(registry === observed ? this.#readonlyObservation
      : ValidatedRuntimeRegistryObservation.fromValidatedRead(registry, snapshot), new Map([
      ["registry.json", snapshot], ["authority.json", anchorSnapshot],
      ...archiveObservation.publicationSnapshots(), ...this.requestStorage.publicationSnapshots(),
    ]));
    if (publication !== null || immutable) return inventory;
    return new RuntimeLogicalInventoryRecords(this.#readonlyObservation.mutableCopy(), inventory.archives);
  }
  #retainRead(observation, snapshots) {
    this.#readonlyObservation = observation;
    this.#publicationBaseline = new RuntimePublicationBaseline(observation, snapshots);
  }
  retainPublicationRead(registry, snapshots, storage) {
    // The complete prepared readback already validated these exact images.
    // Retain decoders against the physical store; subsequent reads still
    // capture every dependency afresh. Calls and private ledgers are never
    // promoted into the next publication's preserved source inventory.
    this.requestStorage = storage.retainFor(this, this.requestStorage);
    this.#retainRead(ValidatedRuntimeRegistryObservation.fromValidatedRead(registry, snapshots.get("registry.json")),
      new Map([
        ...[...snapshots].filter(([name]) => name === "registry.json" || name === "authority.json" || name.startsWith("archives/")),
        ...this.requestStorage.referencedBlockPaths().map((name) => [name, snapshots.get(name)]),
      ]));
  }
  readArchives(archiveObservation = new RuntimeRecordObservation()) {
    return this.#readArchives(archiveObservation).map((archive) => archive.execution);
  }
  #readArchives(archiveObservation) {
    this.archivesAuthority.assertStable();
    const names = fs.readdirSync(this.archivesAuthority.directory);
    const paths = new Set(names.map((name) => path.join(this.archivesAuthority.directory, name)));
    for (const filePath of this.#archiveObservations.keys()) {
      if (!paths.has(filePath)) this.#archiveObservations.delete(filePath);
    }
    // Recheck the complete archived physical graph in one streaming forest.
    // Decoders are reused only after their complete physical images match afresh.
    // Singleton reads retain their ordinary boundary; misses decode normally.
    if (names.length > 1) {
      const files = names.map(name => {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) fail("record-corrupt", "Unexpected runtime archive inventory entry");
        return new AtomicFile(path.join(this.archivesAuthority.directory, name), { directoryAuthority: this.archivesAuthority });
      });
      const unchanged = archiveObservation.readUnchangedArchives(files, this.checkout, this.#archiveObservations, this, this.#publicationBaseline);
      if (unchanged !== null) return unchanged.sort((left, right) => left.execution.ownerEpoch - right.execution.ownerEpoch);
    }
    const archives = [];
    for (let offset = 0; offset < names.length; offset += RUNTIME_RECORD_CAPTURE_WIDTH) {
      const selected = names.slice(offset, offset + RUNTIME_RECORD_CAPTURE_WIDTH);
      const files = selected.map((name) => {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) fail("record-corrupt", "Unexpected runtime archive inventory entry");
        return new AtomicFile(path.join(this.archivesAuthority.directory, name), { directoryAuthority: this.archivesAuthority });
      });
      // A singleton retains the ordinary read boundary. Plural reads share
      // fresh parent observations through the existing complete capture API.
      // At most two fresh duplicate payloads are retained, as for request blocks.
      const snapshots = files.length > 1 ? AtomicFile.readSnapshots(files) : null;
      for (const [index, file] of files.entries()) {
        archives.push(snapshots === null
          ? archiveObservation.read(file, this.checkout, selected[index], this.#archiveObservations, this)
          : archiveObservation.readCaptured(file, snapshots.get(file.filePath), this.checkout, selected[index], this.#archiveObservations, this));
      }
    }
    return archives.sort((left, right) => left.execution.ownerEpoch - right.execution.ownerEpoch);
  }
  readPreservedArchive(archiveObservation, name, view, storage) {
    return archiveObservation.readPrepared(view.file(`archives/${name}`), this.checkout, name,
      this.#archiveObservations, storage).execution;
  }
  readInventory() {
    // This read already validated every archive and its linked records. Carry
    // that exact captured view; a later read still captures every file anew.
    return this.#readRecords({ immutable: true }).toJSON();
  }
  readConsistentInventory() {
    const deadline = managedMonotonicNow() + 1000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let failure;
    do {
      // Undefined means capture did not complete; null records actual absence.
      let before;
      try {
        before = this.file.readSnapshot();
        const result = this.readInventory();
        const after = this.file.readSnapshot();
        if (before !== null && after !== null && before.digest === after.digest
          && before.identity.dev === after.identity.dev && before.identity.ino === after.identity.ino) return result;
        failure = new ProcessExecutionControlFailure("durability-uncertain", "Runtime changed during read-only inventory observation");
      } catch (cause) {
        failure = cause;
        // A reader can retain the old registry while the sole writer publishes
        // its next immutable blocks, including closed stages prepared before
        // journal selection. A checkout-bound admission held by the published
        // owner's session proves an ambiguous writer window, not its liveness
        // or the validity of any block. Reobserve within this existing bound;
        // never accept the failed inventory or acquire/reclaim that exclusion.
        if (cause instanceof ProcessExecutionControlFailure && cause.reason === "record-corrupt") {
          const after = this.file.readSnapshot();
          const admission = this.admission.inspect();
          const owner = admission === null ? null : this.ownerLock.inspect();
          const preparing = owner !== null && admission.owner.ownerSession === owner.owner.ownerSession;
          const unchanged = before === undefined || (before === null ? after === null
            : RuntimeFileGeneration.capture(before).matches(after));
          if (unchanged
            && this.transition.readSnapshot() === null && !preparing) throw cause;
          failure = new ProcessExecutionControlFailure("durability-uncertain", "Runtime changed during read-only inventory observation", { cause });
        } else if (!(cause instanceof ProcessExecutionControlFailure)
          || !["durability-uncertain", "registry-failed", "record-missing"].includes(cause.reason)) throw cause;
      }
      if (managedMonotonicNow() >= deadline) break;
      Atomics.wait(pause, 0, 0, 10);
    } while (true);
    throw failure;
  }
  #assertInventory(registry, archiveObservation) {
    const records = new RuntimeLogicalInventoryRecords(registry, this.#readArchives(archiveObservation));
    const inventory = assertLogicalRuntimeInventory(registry, records.archives.map((archive) => archive.execution));
    const callIds = new Set(inventory.flatMap((execution) => execution.calls.map((call) => call.callId)));
    const names = this.callsAuthority.entries();
    for (const name of names) {
      if (!callIds.has(name)) fail("record-missing", "A physical call artifact is outside the durable runtime inventory");
    }
    this.observeCallDirectories(names);
    return records;
  }
  assertRecordMigrationQuiescent() {
    this.assertStable();
    const published = this.ownerLock.inspect();
    if (this.#recordMigrationExclusion !== null) this.#recordMigrationExclusion.assertCurrent(published);
    else if (published !== null) fail("busy", "Runtime migration requires explicit release of every existing worker owner");
  }
  readRecordMigrationVersion() {
    if (!this.authority.exists()) return null;
    this.assertStable();
    const snapshot = this.file.readSnapshot();
    const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, this.file.filePath);
    if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime migration source checksum is invalid");
    if (![8, 9, RUNTIME_RECORD_VERSION].includes(envelope.payload.version)) fail("record-unsupported", "Runtime migration supports only exact predecessor or current revisions");
    const codec = envelope.payload.version === RUNTIME_RECORD_VERSION ? CURRENT_PROCESS_EXECUTION_EVIDENCE : new PreviousProcessExecutionEvidenceCodec();
    const checkout = exact(envelope.payload.checkout, codec.checkout(envelope.payload.checkout));
    const anchor = codec.checkout(readJson(this.anchor));
    if (!checkout.matches(this.checkout) || !anchor.matches(checkout)) fail("authority-mismatch", "Runtime migration source belongs to another checkout");
    return envelope.payload.version;
  }
  captureRecordMigration() {
    this.assertRecordMigrationQuiescent(); this.assertCommitted();
    const sources = new Map(), directories = new Map();
    const source = (relativePath, snapshot, streamed = false) => {
      if (sources.has(relativePath)) throw new TypeError("Runtime migration captured a duplicate source");
      const captured = new RuntimeRecordMigrationSource(relativePath, snapshot, streamed);
      sources.set(relativePath, captured); return captured;
    };
    const record = (file, relativePath) => {
      const snapshot = file.readSnapshot();
      const envelope = decodeRuntimeJson(snapshot?.bytes ?? null, file.filePath);
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime migration source checksum is invalid");
      source(relativePath, snapshot); return envelope.payload;
    };
    const directory = (authority) => {
      const relativePath = path.relative(this.authority.directory, authority.directory).split(path.sep).join("/");
      const captured = new RuntimePublicationDirectoryGeneration({ relativePath, identity: authority.identity.toJSON(), entries: authority.entries().sort() });
      directories.set(relativePath, captured); return captured;
    };
    const registry = record(this.file, "registry.json");
    if (![8, 9].includes(registry.version)) fail("record-unsupported", "Explicit source capture requires revision8 or9");
    const archives = this.archivesAuthority.entries({ withFileTypes: true }).map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) fail("record-corrupt", "Runtime migration archive entry is invalid");
      const archive = record(new AtomicFile(path.join(this.archivesAuthority.directory, entry.name), { directoryAuthority: this.archivesAuthority,
        maxBytes: MAX_REGISTRY_BYTES }), `archives/${entry.name}`);
      if (entry.name !== `${archive.execution?.executionId}.json`) fail("authority-mismatch", "Runtime migration archive filename differs from its execution");
      return archive;
    });
    directory(this.archivesAuthority);
    const blocks = [];
    const requestsPath = path.join(this.authority.directory, "requests");
    const requestsAuthority = this.authority.descendant(requestsPath, { allowMissing: true });
    if (registry.version === 9 && requestsAuthority.directory === requestsPath) {
      for (const entry of requestsAuthority.entries({ withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail("record-corrupt", "Previous request execution namespace is invalid");
        uuid(entry.name, "previous block execution");
        const leaf = requestsAuthority.descendant(path.join(requestsAuthority.directory, entry.name));
        const blockPath = path.join(leaf.directory, "blocks");
        const blockDirectory = leaf.descendant(blockPath, { allowMissing: true });
        if (blockDirectory.directory !== blockPath) continue;
        directory(blockDirectory);
        for (const item of blockDirectory.entries({ withFileTypes: true })) {
          if (!item.isFile() || item.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(item.name)) fail("record-corrupt", "Previous request block entry is invalid");
          const relativePath = `requests/${entry.name}/blocks/${item.name}`;
          const snapshot = new AtomicFile(path.join(blockPath, item.name), { directoryAuthority: blockDirectory, maxBytes: MAX_REGISTRY_BYTES }).readSnapshot();
          source(relativePath, snapshot);
          blocks.push(new ProcessExecutionRuntimeRequestBlockData(relativePath, snapshot.bytes));
        }
      }
    }
    const logical = registry.version === 8 ? new ProcessExecutionRuntimeVersion8LogicalInventory({ registry, archives })
      : new ProcessExecutionRuntimeVersion9LogicalInventory({ registry, archives, blocks });
    const records = runtimeLogicalInventoryRecords.get(logical);
    if (!logical.checkout.matches(this.checkout)) fail("authority-mismatch", "Runtime migration checkout differs from its actual authority");
    assertClosedRuntimeCheckout(records.registry);
    if (logical.logicalInventory.executions.some((execution) => execution.requests.some((request) => request.response === null))) fail("request-unconfirmed", "Runtime migration cannot complete an unconfirmed canonical request");
    const callIds = new Set(logical.logicalInventory.executions.flatMap((execution) => execution.calls.map((call) => call.callId)));
    const visit = (authority) => {
      directory(authority);
      for (const entry of authority.entries({ withFileTypes: true })) {
        const filePath = path.join(authority.directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) visit(authority.descendant(filePath));
        else if (entry.isFile() && !entry.isSymbolicLink()) source(path.relative(this.authority.directory, filePath).split(path.sep).join("/"),
          visitRegularFileChunks(filePath, { label: "runtime migration preserved artifact", maxBytes: Number.MAX_SAFE_INTEGER - 1,
            requireSingleLink: true, directoryAuthority: authority, visit() {} }), true);
        else fail("record-corrupt", "Runtime migration artifact is not a real file or directory");
      }
    };
    for (const entry of this.callsAuthority.entries({ withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !callIds.has(entry.name)) fail("record-missing", "Runtime migration has a physical call outside the complete logical inventory");
    }
    visit(this.callsAuthority);
    const requests = [];
    if (requestsAuthority.directory === requestsPath) {
      directory(requestsAuthority);
      for (const entry of requestsAuthority.entries({ withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail("record-corrupt", "Runtime migration request execution entry is invalid");
        uuid(entry.name, "migration request execution ID");
        const leaf = requestsAuthority.descendant(path.join(requestsAuthority.directory, entry.name)); directory(leaf);
        const execution = logical.logicalInventory.executions.find((root) => root.executionId === entry.name);
        for (const item of leaf.entries({ withFileTypes: true })) {
          if (registry.version === 9 && item.name === "blocks" && item.isDirectory() && !item.isSymbolicLink()) continue;
          if (!item.isFile() || item.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(item.name)) fail("record-corrupt", "Runtime migration request filename or nesting is invalid");
          const file = new AtomicFile(path.join(leaf.directory, item.name), { directoryAuthority: leaf, maxBytes: MAX_REGISTRY_BYTES });
          let previous;
          if (registry.version === 9) {
            const snapshot = file.readSnapshot();
            source(`requests/${entry.name}/${item.name}`, snapshot);
            previous = RuntimeStandaloneRequestDocument.fromEnvelope(entry.name, item.name.slice(0, -5),
              decodeRuntimeJson(snapshot.bytes, file.filePath)).requestRecord();
          } else previous = record(file, `requests/${entry.name}/${item.name}`);
          const request = exact(json(previous), new RuntimeRequestRecord(previous));
          if (item.name !== `${request.requestId}.json`) fail("authority-mismatch", "Runtime migration request UUID differs from its filename");
          const inline = execution?.requests.find((value) => value.requestId === request.requestId);
          const acceptance = (value) => new RuntimeRequestAcceptance({ requestId: value.requestId, operation: value.operation,
            payloadDigest: value.payloadDigest, authorizationDigest: value.authorizationDigest });
          if (inline !== undefined && (!acceptance(inline).matches(acceptance(request)) || request.response !== null
            && JSON.stringify(inline.response) !== JSON.stringify(request.response))) fail("request-mismatch", "Runtime migration request differs from its original same-execution history");
          if (request.response === null && inline?.response == null) fail("request-unconfirmed", "Runtime migration found an unconfirmed standalone request");
          requests.push({ executionId: entry.name, request: request.toJSON() });
        }
      }
    }
    const anchor = this.anchor.readSnapshot();
    if (!new PreviousProcessExecutionEvidenceCodec().checkout(JSON.parse(anchor.bytes.toString("utf8"))).matches(this.checkout)) fail("authority-mismatch", "Runtime migration checkout anchor changed");
    source("authority.json", anchor);
    const conversion = new ProcessExecutionRuntimeRecordConversion({ registry, archives, requests, blocks });
    const absences = new Map();
    // Preserve the optional namespace even when an empty input creates no
    // request targets: a later standalone sidecar must invalidate this capture.
    if (requestsAuthority.directory !== requestsPath) absences.set("requests", new RuntimeRecordMigrationAbsence(this, "requests"));
    for (const target of conversion.targets) if (!sources.has(target.relativePath)) {
      const parts = target.relativePath.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const relativePath = parts.slice(0, count).join("/");
        if (sources.has(relativePath) || directories.has(relativePath) || absences.has(relativePath)) continue;
        absences.set(relativePath, new RuntimeRecordMigrationAbsence(this, relativePath));
      }
    }
    const captured = new ProcessExecutionRuntimeRecordMigrationCapture(recordMigrationCaptureAuthority, { store: this, conversion,
      logicalRegistry: conversion.logicalRegistry, sources: sources.values(), directories: directories.values(), absences: absences.values() });
    captured.assertCurrent(); return captured;
  }
  assertRecordMigrationContext() { this.#recordMigrationContext?.assertWriter(); }
  recordMigrationContext() {
    if (this.#recordMigrationExclusion === null || this.#recordMigrationContext === null) throw new TypeError("Migration publication requires its actual held exclusion and writer context");
    this.assertRecordMigrationQuiescent(); this.#recordMigrationContext.assertWriter();
    return this.#recordMigrationContext;
  }
  withRecordMigrationContext(encodeMetadata, assertWriter, callback) {
    if (this.#recordMigrationContext !== null || typeof callback !== "function") throw new TypeError("Migration writer context cannot overlap another operation");
    const context = new RuntimeRecordMigrationContext(encodeMetadata, assertWriter);
    context.assertWriter(); this.#recordMigrationContext = context;
    try { return synchronousManagedResult(callback(), "Runtime migration writer operation must be synchronous"); }
    finally { this.#recordMigrationContext = null; }
  }
  inspectRecordMigrationTransition() {
    if (!this.authority.exists()) return null;
    this.assertStable();
    const root = RuntimePublicationMetadataSelection.inspect(this.transition);
    if (root === null) return null;
    if (root.value.phase === RuntimePreparedPublication.phase) {
      const prepared = new RuntimePreparedPublication(root.value);
      prepared.validateData(this, root);
      return new ProcessExecutionPreparedPublication(preparedPublicationAuthority, { prepared, selection: root,
        options: { mainRoot: this.checkout.mainRoot, executionRoot: this.checkout.executionRoot, storagePolicy: this.storagePolicy } });
    }
    if (root.value.publication?.phase !== RuntimePreparedRecordMigration.phase) fail("record-unsupported", "Runtime transition is neither a selected result nor an explicit record migration");
    const prepared = new RuntimePreparedRecordMigration(root.value.publication);
    const selection = new RuntimeRecordMigrationSelectedPublication(root, prepared);
    prepared.validateData(this, selection);
    return new ProcessExecutionRuntimeRecordMigrationPrepared(recordMigrationCaptureAuthority, { store: this, prepared, selection });
  }
  publishRecordMigration(capture) {
    if (!(capture instanceof ProcessExecutionRuntimeRecordMigrationCapture)) throw new TypeError("Migration publication requires its original typed predecessor capture");
    capture.assertStore(this); this.recordMigrationContext(); capture.assertCurrent();
    const writes = capture.targets.map((target) => target instanceof RuntimeRecordMigrationRemoval ? target : new RuntimePublicationWrite(target.relativePath, target.bytes));
    return this.publishPrepared(writes, capture.logicalRegistry, { baseline: new RuntimeRecordMigrationBaseline(capture) });
  }
  recoverRecordMigration(plan) {
    const selected = recordMigrationPublicationPlans.get(plan);
    if (selected?.store !== this) throw new TypeError("Migration recovery requires the exact plan inspected by this Store");
    this.recordMigrationContext(); selected.selection.assertCurrent();
    this.#lastRecordMigrationPlan = plan;
    return this.recoverPrepared(selected);
  }
  assertRecordMigrationPlanCurrent(plan) {
    const selected = recordMigrationPublicationPlans.get(plan);
    if (selected?.store !== this) throw new TypeError("Migration plan belongs to another Store observation");
    selected.selection.assertCurrent();
  }
  lastRecordMigrationPlan() { return this.#lastRecordMigrationPlan; }
  replaceRecordMigrationMetadata(plan) {
    const selected = recordMigrationPublicationPlans.get(plan);
    if (selected?.store !== this) throw new TypeError("Migration metadata replacement requires its exact inspected plan");
    this.recordMigrationContext(); selected.selection.assertCurrent(); selected.prepared.assertPhysical(this);
    const selection = this.publishPreparedMetadata(selected.prepared, selected.selection);
    return new ProcessExecutionRuntimeRecordMigrationPrepared(recordMigrationCaptureAuthority, { store: this, prepared: selected.prepared, selection });
  }
  runRecordMigrationExclusive(callback) {
    if (typeof callback !== "function" || this.#recordMigrationExclusion !== null) throw new TypeError("Runtime migration requires one synchronous exclusion");
    this.assertRecordMigrationQuiescent();
    this.ownerLock.acquire();
    this.#recordMigrationExclusion = new RuntimeRecordMigrationExclusion(this, this.ownerLock.inspect());
    let failure = null;
    try { return this.admission.runExclusive(() => synchronousManagedResult(callback(), "Runtime migration exclusion consumer must be synchronous")); }
    catch (cause) { failure = cause; throw cause; }
    finally {
      this.#recordMigrationExclusion = null;
      try { this.ownerLock.release(); }
      catch (cleanup) { if (failure !== null) throw combineProcessExecutionFailures(failure, cleanup); throw cleanup; }
    }
  }
  archiveClosed() {
    let registry = this.read();
    for (const execution of registry.executions.filter((record) => record.status === "closed" && !hasPendingBoundEvents(record))) {
      const archive = new ClosedProcessExecutionArchive({ version: RUNTIME_RECORD_VERSION, checkout: json(this.checkout), execution: json(execution) });
      const planned = this.planExecution(archive.execution);
      const content = encodeRuntimeRecord({ ...archive.toJSON(), execution: planned.execution });
      const file = new AtomicFile(path.join(this.archivesAuthority.directory, `${execution.executionId}.json`), {
        directoryAuthority: this.archivesAuthority, faultInjector: this.faultInjector, phaseNamespace: "runtime-archive", commitGuard: () => this.assertStable(),
      });
      if (file.read() !== null) fail("record-corrupt", "Closed execution archive already exists before transfer");
      registry.executions = registry.executions.filter((record) => record.executionId !== execution.executionId);
      const prepared = new PreparedRuntimeRegistryPublication(registry, this);
      const saved = prepared.publish({ extraWrites: [new RuntimePublicationWrite(`archives/${execution.executionId}.json`, content)] });
      if (!new ProcessExecutionValueEncoding(saved).hasSameValue(new ProcessExecutionValueEncoding(registry))) fail("record-corrupt", "Runtime archive transfer readback differs");
      registry = saved;
      this.faultInjector({ phase: "after-runtime-archive-readback", filePath: file.filePath });
    }
  }
  save(registry, { archiveObservation = new RuntimeRecordObservation(), requestPublications = new RuntimeRequestPublications(), effects = [], stopClaims = [], preparedRegistry = null } = {}) {
    this.#readonlyObservation = null;
    try {
      const prepared = preparedRegistry?.forSave(registry, this, requestPublications)
        ?? new PreparedRuntimeRegistryPublication(registry, this, { requestPublications });
      const extraWrites = requestPublications.completedRequests().map((completedRequest) => new RuntimePublicationWrite(
        `requests/${completedRequest.executionId}/${completedRequest.request.requestId}.json`,
        encodeRuntimeRequest(completedRequest.executionId, completedRequest.request)));
      const saved = withManagedStopOperationClaims(stopClaims, (stopWrites) => prepared.publish({ archiveObservation,
        effects: [...effects, ...stopWrites], extraWrites }));
      this.faultInjector({ phase: "after-runtime-readback", filePath: this.file.filePath });
      return saved;
    } catch (cause) {
      this.#readonlyObservation = null;
      this.#publicationBaseline = null;
      throw cause;
    }
  }
  publicationBaseline(registry, requestPublications = new RuntimeRequestPublications()) {
    let baseline = this.#publicationBaseline;
    if (baseline === null || !baseline.observation.owns(registry)) fail("authority-mismatch", "Runtime publication requires its exact validated source graph");
    const snapshots = new Map(baseline.snapshots);
    for (const acceptedRequest of requestPublications.acceptedObservations()) {
      if (!(acceptedRequest instanceof RuntimeAcceptedRequestObservation)) throw new TypeError("Prepared acceptance requires its exact owned ledger readback");
      snapshots.set(acceptedRequest.relativePath, acceptedRequest.snapshot);
    }
    // Preparation changes memory only. Physical publication checks these
    // original generations at its selection and commit boundaries.
    return new RuntimePublicationBaseline(baseline.observation, snapshots);
  }
  publicationFile(relativePath, { create = true } = {}) {
    const filePath = path.join(this.authority.directory, ...relativePath.split("/"));
    if (relativePath === "registry.json") return this.file;
    if (relativePath === "authority.json") return this.anchor;
    if (/^requests\//.test(relativePath)) {
      const [, executionId, name, blockName] = relativePath.split("/");
      const target = name === "blocks" ? this.requestBlockFile(executionId, blockName.slice(0, -5), { create })
        : this.requestFile(executionId, name.slice(0, -5), { create });
      return target === null ? null : new AtomicFile(target.filePath, { directoryAuthority: target.directoryAuthority,
        maxBytes: target.maxBytes, faultInjector: this.faultInjector, phaseNamespace: "runtime-dependency", commitGuard: () => this.assertStable() });
    }
    const parent = this.publicationDirectory(path.posix.dirname(relativePath));
    if (parent === null) return null;
    return new AtomicFile(filePath, { directoryAuthority: parent, maxBytes: MAX_REGISTRY_BYTES,
      faultInjector: this.faultInjector, phaseNamespace: "runtime-dependency", commitGuard: () => this.assertStable() });
  }
  publishPrepared(writes, registry, { archiveObservation = new RuntimeRecordObservation(), effects = [], baseline } = {}) {
    return withManagedRecordWriters(effects, () => {
      this.assertCommitted();
      // Normal owned stages are private scratch. The complete selection guard
      // checks their original sources before metadata can become canonical.
      // Offline migration also proves absence before creating target parents.
      if (baseline instanceof RuntimeRecordMigrationBaseline) baseline.assertCurrent(this);
      const intended = new RuntimePublicationExpectedRegistry(registry);
      const registryBefore = RuntimeFileGeneration.capture(baseline.snapshots.get("registry.json"));
      const owner = this.ownerLock.inspect();
      const owned = [];
      let durable = false;
      try {
        const targets = writes.map((write) => {
          const file = baseline.publicationFile(this, write.relativePath);
          const captured = file.readSnapshot();
          const before = baseline.targetGeneration(write.relativePath, captured);
          const stage = file.createStage(write.bytes, { stageName: `.runtime-result-${crypto.randomUUID()}.tmp` });
          owned.push({ file, stage });
          const snapshot = file.inspectStage(stage);
          write.assertBytes(snapshot.bytes);
          return new RuntimePublicationTarget({ relativePath: write.relativePath, before: json(before), removal: write instanceof RuntimeRecordMigrationRemoval,
            sourceStage: { name: path.basename(stage.path), generation: json(RuntimeFileGeneration.capture(snapshot)) }, publicationStage: null });
        });
        const sources = baseline.sources(targets);
        const directories = new Map();
        const parents = baseline.parents(this, owned, sources);
        const parentObservation = RealDirectoryAuthority.beginObservation(parents);
        const view = new RuntimePublicationView(this, targets, new Map());
        for (const leaf of parents) {
          for (let directory = leaf; directory.directory !== this.authority.directory; directory = directory.parentAuthority) {
            const relativePath = path.relative(this.authority.directory, directory.directory).split(path.sep).join("/");
            const previous = directories.get(relativePath);
            if (previous !== undefined) {
              // The complete fresh forest brackets this read-only assembly.
              // Repeated paths must still agree on their captured generation.
              if (!sameFileIdentity(previous.identity, directory.identity)) fail("authority-mismatch", "Runtime preparation observed conflicting directory generations");
              continue;
            }
            const entries = baseline.directoryEntries(relativePath, view, directory);
            directories.set(relativePath, new RuntimePublicationDirectoryGeneration({ relativePath, identity: directory.identity.toJSON(), entries }));
          }
        }
        parentObservation.complete();
        const prepared = baseline.prepare(json({ version: RUNTIME_RECORD_VERSION, phase: "prepared-publication", checkout: this.checkout,
          runtimeIdentity: this.authority.identity, owner: owner === null ? null : new LockOwnerSession(owner.owner), ownerIdentity: owner?.stat ?? null, registryBefore, sources, directories: [...directories.values()], targets }));
        if (!prepared.registryBefore.matches(this.file.readSnapshot()) || targets.some((target) => target.isPublished(this))) fail("authority-mismatch", "Runtime preparation lost its exact baseline");
        let validated;
        const validate = (observation) => {
          validated = observation === null ? prepared.validateData(this, null, intended, archiveObservation)
            : prepared.validateCapturedData(this, observation, intended, archiveObservation);
          if (!intended.matches(validated)) fail("record-corrupt", "Prepared physical graph differs from the complete next logical runtime");
        };
        // Normal publication decodes the initial selection guard's fresh image
        // before metadata staging. Its actual root-rename guard captures the
        // complete graph again before the first canonical effect. Migration
        // keeps its polymorphic validation and extra streamed source proofs.
        const validateDuringSelection = prepared.constructor === RuntimePreparedPublication;
        if (!validateDuringSelection) validate(null);
        const selection = this.publishPreparedMetadata(prepared, null, {
          validateCapturedData: validateDuringSelection ? validate : null,
        });
        durable = true;
        this.faultInjector({ phase: "after-runtime-publication-prepared", filePath: this.transition.filePath });
        for (let index = 0; index < targets.length; index++) {
          // Each effect below rechecks the full selected authority after its
          // AtomicFile fault boundary; this probe performs no publication.
          if (targets[index].isPublished(this)) fail("authority-mismatch", "An unpublished owned runtime stage unexpectedly reached its target");
          if (targets[index].removal) this.retireOwnedRuntimeBlock(prepared, index, selection);
          else this.publishOwnedRuntimeStage(owned[index].file, owned[index].stage, prepared, index, selection);
          this.faultInjector({ phase: "after-runtime-dependency-publication", filePath: owned[index].file.filePath });
        }
        const retained = prepared.canRetainReadback(validated);
        // The prepared image already passed the complete logical validation.
        // Exact source and owned-target generations prove the same image after
        // publication. Private transitions can be retired using their exact
        // selected generations. The root marker's unlink guard checks the full
        // committed image before it can discard the publication authority.
        const committed = retained ? validated : prepared.validateData(this, selection, intended, archiveObservation);
        if (committed !== validated && !intended.matches(committed)) fail("record-corrupt", "Published runtime differs from its exact prepared logical graph");
        for (const target of prepared.targets.filter((target) => target.removal)) this.removePreparedStage(target, target.sourceStage, prepared, selection);
        this.#readonlyObservation = null;
        if (!retained) {
          const snapshot = this.file.readSnapshot();
          const publication = new ValidatedRuntimeRegistryObservation(runtimeRegistryObservationAuthority, committed, snapshot);
          this.#read(archiveObservation, publication, false, prepared);
        }
        if (!targets.every((target) => target.isPublished(this))) fail("durability-uncertain", "Runtime publication lacks an exact visible dependency");
        this.clearManagedTransitions(prepared, selection);
        const captured = this.clearPreparedMarker(prepared, selection);
        if (retained) prepared.retainReadback(this, committed, captured.snapshots());
        return this.#readonlyObservation.mutableCopy();
      } catch (cause) {
        this.#readonlyObservation = null;
        // Once the exact journal may be visible, every owned stage is recovery
        // evidence. No automatic cleanup or operation redispatch is authorized.
        let failure = cause;
        let unselected = false;
        if (!durable) {
          try { unselected = this.transition.readSnapshot() === null; }
          catch (inspection) { failure = combineProcessExecutionFailures(failure, inspection); }
        }
        if (unselected) {
          for (const { stage } of owned) if (stage.active) {
            try { stage.dispose(); } catch (cleanup) { failure = combineProcessExecutionFailures(failure, cleanup); }
          }
          try { baseline.discardCreatedParents(); } catch (cleanup) { failure = combineProcessExecutionFailures(failure, cleanup); }
        }
        throw failure;
      }
    });
  }
  publishPreparedMetadata(prepared, previous = null, { validateCapturedData = null } = {}) {
    const encoding = prepared instanceof RuntimePreparedRecordMigration
      ? this.recordMigrationContext().encoding(prepared) : new ProcessExecutionValueEncoding(prepared);
    const update = new RuntimePublicationMetadataUpdate(this.transition, encoding, runtimePublicationMetadataRoot(previous));
    try {
      const publication = update.publish({ selectGuard: () => {
        const observation = prepared.assertPhysical(this);
        if (previous === null && (!prepared.registryBefore.matches(this.file.readSnapshot())
          || prepared.targets.some((target) => target.isPublished(this)))) fail("authority-mismatch", "Runtime preparation lost its exact baseline");
        const validate = validateCapturedData;
        validateCapturedData = null;
        validate?.(observation);
      } });
      const selection = prepared instanceof RuntimePreparedRecordMigration
        ? new RuntimeRecordMigrationSelectedPublication(publication.selection, prepared) : publication.selection;
      if (prepared instanceof RuntimePreparedRecordMigration) this.#lastRecordMigrationPlan = new ProcessExecutionRuntimeRecordMigrationPrepared(
        recordMigrationCaptureAuthority, { store: this, prepared, selection });
      publication.previousRetirement?.retire({ retirementGuard: () => prepared.assertAuthority(this) });
      return selection;
    } catch (cause) {
      try { update.discardAfterFailure({ cleanupGuard: () => prepared.assertAuthority(this) }); }
      catch (cleanup) { throw combineProcessExecutionFailures(cause, cleanup); }
      throw cause;
    }
  }
  publishOwnedRuntimeStage(file, stage, prepared, index, selection) {
    const original = file.commitGuard;
    file.commitGuard = (event) => {
      original(event);
      prepared.assertSelected(this, selection);
      prepared.assertNextTarget(this, index);
      if (prepared.targets[index].relativePath === "registry.json") prepared.captureSources(this);
    };
    try { return file.publishStage(stage, { retainOnFailure: true }); }
    finally { file.commitGuard = original; }
  }
  retireOwnedRuntimeBlock(prepared, index, selection) {
    const target = prepared.targets[index];
    if (!(prepared instanceof RuntimePreparedRecordMigration) || !target.removal) throw new TypeError("Request retirement requires its selected migration target");
    this.removePreparedFile(target.file(this), target.before, { guard: () => {
      prepared.assertSelected(this, selection);
      for (const prior of prepared.targets.slice(0, index)) if (!prepared.isPublished(this, prior)) fail("authority-mismatch", "Request retirement lost an earlier migration dependency");
    } });
  }
  recoverPrepared({ prepared, selection }) {
    prepared.assertSelected(this, selection);
    const registry = prepared.validateData(this, selection);
    const effects = prepared.targets.filter((target) => target.relativePath.startsWith("calls/") && !target.relativePath.endsWith(".transition")).map((target) => {
      const callId = target.relativePath.split("/")[1];
      const execution = registry.executions.find((entry) => entry.calls.some((call) => call.callId === callId));
      if (execution === undefined) fail("record-corrupt", "Prepared outcome lacks its canonical current execution");
      const context = this.callContext(execution, execution.calls.find((call) => call.callId === callId));
      return new ManagedRecordWrite(target.file(this).filePath, prepared.readTarget(this, target).bytes, context);
    });
    const preparedTransitions = new Map(effects.map((write) => {
      const relative = path.relative(this.authority.directory, write.transitionFile.filePath).split(path.sep).join("/");
      const target = prepared.targets.find((entry) => entry.relativePath === relative);
      if (target === undefined) fail("record-corrupt", "Prepared managed effect lacks its transition dependency");
      return [write.file, target.file(this).readSnapshot()];
    }));
    const stopClaims = effects.filter((write) => write.file.endsWith(".stop")).map((write) => {
      const operation = ManagedStopOperation.fromStored(JSON.parse(write.bytes).operation);
      return new ManagedStopOperationClaim(new ManagedStopOperationStore(write.identity), operation);
    });
    return withManagedStopOperationClaims(stopClaims, () => withManagedRecordWriters(effects, () => {
      let current = prepared;
      let selected = selection;
      for (let index = 0; index < current.targets.length; index++) {
        current.assertSelected(this, selected);
        const target = current.targets[index];
        if (current.isPublished(this, target)) continue;
        if (target.removal) { this.retireOwnedRuntimeBlock(current, index, selected); continue; }
        const bytes = current.readTarget(this, target).bytes;
        if (target.publicationStage !== null) this.removePreparedStage(target, target.publicationStage, current, selected);
        const file = target.file(this);
        const stage = file.createStage(bytes, { stageName: `.runtime-result-${crypto.randomUUID()}.tmp` });
        const stageSnapshot = file.inspectStage(stage);
        const changed = json(current);
        changed.targets[index].publicationStage = { name: path.basename(stage.path), generation: json(RuntimeFileGeneration.capture(stageSnapshot)) };
        const next = current.withTargets(changed.targets);
        try {
          selected = this.publishPreparedMetadata(next, selected);
        } catch (cause) {
          const visible = this.transition.readSnapshot();
          if (visible !== null && sameRuntimeRecordSnapshot(selected.snapshot, visible)) {
            try {
              this.removePreparedStage(next.targets[index], next.targets[index].publicationStage, current, selected);
              stage.dispose();
            } catch (cleanup) { throw combineProcessExecutionFailures(cause, cleanup); }
          }
          throw cause;
        }
        current = next;
        this.faultInjector({ phase: "after-runtime-recovery-stage-prepared", filePath: file.filePath });
        this.publishOwnedRuntimeStage(file, stage, current, index, selected);
      }
      const recovered = current.validateData(this, selected);
      if (!new ProcessExecutionValueEncoding(recovered).hasSameValue(new ProcessExecutionValueEncoding(registry))) fail("record-corrupt", "Recovered runtime differs from its exact prepared graph");
      // Journal-owned archive source stages would otherwise appear as foreign
      // archive entries to ordinary strict readback. All visible generations and
      // the full graph have just been revalidated before this owned cleanup.
      for (const target of current.targets) {
        this.removePreparedStage(target, target.sourceStage, current, selected);
        if (target.publicationStage !== null) this.removePreparedStage(target, target.publicationStage, current, selected);
      }
      this.#readonlyObservation = null;
      const publication = new ValidatedRuntimeRegistryObservation(runtimeRegistryObservationAuthority, registry, this.file.readSnapshot());
      this.#read(new RuntimeRecordObservation(), publication, false, current);
      current.assertAuthority(this);
      if (!current.targets.every((target) => current.isPublished(this, target))) fail("durability-uncertain", "Recovered runtime dependency lacks its exact prepared generation");
      current.assertSelected(this, selected);
      for (const target of current.targets) {
        this.removePreparedStage(target, target.sourceStage, current, selected);
        if (target.publicationStage !== null) this.removePreparedStage(target, target.publicationStage, current, selected);
      }
      this.clearManagedTransitions(current, selected);
      this.clearPreparedMarker(current, selected);
      return new ProcessExecutionPublicationRecovery({ checkoutIdentity: this.checkout, ownerConfirmed: current.owner === null });
    }, { preparedTransitions }), { dataRecovery: true });
  }
  clearPreparedMarker(prepared, selection) {
    let captured;
    let retirement;
    try {
      retirement = selection.clear({ clearGuard: () => { captured = prepared.assertPhysical(this, { committed: true }); } });
    } catch (cause) {
      throw processExecutionControlFailureFromCause(cause) ?? cause;
    }
    if (prepared instanceof RuntimePreparedRecordMigration) this.#lastRecordMigrationPlan = null;
    retirement.retire({ retirementGuard: () => prepared.assertAuthority(this) });
    return captured;
  }
  clearManagedTransitions(prepared, selection) {
    for (const target of prepared.targets) if (target.relativePath.endsWith(".transition")) {
      this.removePreparedFile(target.file(this), (target.publicationStage ?? target.sourceStage).generation,
        { guard: () => prepared.assertSelected(this, selection) });
    }
  }
  removePreparedStage(target, stage, prepared, selection) {
    this.removePreparedFile(target.stageFile(this, stage), stage.generation,
      { guard: () => prepared.assertSelected(this, selection) });
  }
  removePreparedFile(file, generation, options) { return removeRuntimePublicationFile(file, generation, options); }
  expandExecution(value) { return expandStoredRuntimeExecution(this.requestStorage, value); }
  unchangedExecution(executionId) {
    return this.requestStorage.unchanged(executionId);
  }
  planExecution(execution, options = {}) { return planStoredRuntimeExecution(this.requestStorage, execution, options); }
  /** Retain directory identity only; every file operation/forest reads it afresh. */
  publicationDirectory(relativePath, { create = false } = {}) {
    if (relativePath === ".") return this.authority;
    if (relativePath === "calls") return this.callsAuthority;
    if (relativePath === "archives") return this.archivesAuthority;
    let directory = this.#directoryAuthorities.get(relativePath);
    if (directory === undefined) {
      const directoryPath = path.join(this.authority.directory, ...relativePath.split("/"));
      const parent = this.publicationDirectory(path.posix.dirname(relativePath), { create });
      if (parent === null) return null;
      directory = parent.descendant(directoryPath, { create, allowMissing: !create });
      if (directory.directory !== directoryPath) return null;
      this.#directoryAuthorities.set(relativePath, directory);
    }
    return directory;
  }
  requestDirectory(executionId, { create = true } = {}) {
    return this.publicationDirectory(`requests/${uuid(executionId, "request execution ID")}`, { create });
  }
  requestFile(executionId, requestId, { create = true } = {}) {
    const fileName = `${uuid(requestId, "request ID")}.json`;
    const directory = this.requestDirectory(executionId, { create });
    return directory === null ? null : new AtomicFile(path.join(directory.directory, fileName), {
      directoryAuthority: directory, maxBytes: 32 * 1024 * 1024,
    });
  }
  requestBlockDirectory(executionId, { create = true } = {}) {
    const parent = this.requestDirectory(executionId, { create });
    if (parent === null) return null;
    return this.publicationDirectory(`requests/${executionId}/blocks`, { create });
  }
  requestBlockFile(executionId, blockId, { create = true } = {}) {
    const fileName = `${uuid(blockId, "request block ID")}.json`;
    const directory = this.requestBlockDirectory(executionId, { create });
    return directory === null ? null : new AtomicFile(path.join(directory.directory, fileName), {
      directoryAuthority: directory, maxBytes: MAX_REGISTRY_BYTES,
    });
  }
  observeCallDirectories(names) {
    const directories = names.map((name) => this.publicationDirectory(`calls/${uuid(name, "physical call directory")}`));
    if (directories.some((directory) => directory === null)) fail("record-missing", "A physical call directory disappeared");
    RealDirectoryAuthority.assertAllStable([this.callsAuthority, ...directories]);
    return directories;
  }
  callContext(root, call) { return new CoordinatorCallRecordContext(this, root, call); }
  callDirectory(callId) {
    const directory = this.publicationDirectory(`calls/${uuid(callId, "callId")}`, { create: true });
    directory.ensure(); this.callsAuthority.assertStable();
    return directory.directory;
  }
}


/** Explicit physical migration access; it does not create a worker execution. */
export class ProcessRuntimeRecordMigrationStorage {
  #store;
  constructor({ mainRoot, executionRoot = mainRoot, faultInjector = () => {} }) {
    this.#store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false, retainedClosed: true, faultInjector, migrationSource: true });
    this.authority = this.#store.authority; this.checkout = this.#store.checkout; this.transition = this.#store.transition;
    Object.freeze(this);
  }
  get version() { return this.#store.readRecordMigrationVersion(); }
  assertQuiescent() { this.#store.assertRecordMigrationQuiescent(); }
  capture() { return this.#store.captureRecordMigration(); }
  runExclusive(callback) { return this.#store.runRecordMigrationExclusive(() => callback(this)); }
  validateCurrent() { this.assertQuiescent(); return this.#store.readConsistentInventory(); }
  inspectCurrent() { return this.#store.readConsistentInventory(); }
  inspectTransition() { return this.#store.inspectRecordMigrationTransition(); }
  assertPlanCurrent(plan) { this.#store.assertRecordMigrationPlanCurrent(plan); }
  lastSelectedPlan() { return this.#store.lastRecordMigrationPlan(); }
  publish(capture, { encodeMetadata, assertWriter }) {
    return this.#store.withRecordMigrationContext(encodeMetadata, assertWriter, () => this.#store.publishRecordMigration(capture));
  }
  recover(plan, { encodeMetadata, assertWriter }) {
    return this.#store.withRecordMigrationContext(encodeMetadata, assertWriter, () => this.#store.recoverRecordMigration(plan));
  }
  replaceMetadata(plan, { encodeMetadata, assertWriter }) {
    return this.#store.withRecordMigrationContext(encodeMetadata, assertWriter, () => this.#store.replaceRecordMigrationMetadata(plan));
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
    this.#summary = new ProcessExecutionRecoveryEvidenceSummary({ schemaVersion: 4, checkoutIdentity: checkoutIdentity.toJSON(), binding: binding.toJSON(), invocation: this.#invocation.toJSON(),
      inventoryDigest: this.#snapshotDigest, ownerEpoch: inventory.ownerEpoch,
      calls: this.calls.map((call) => call.toJSON()), nonExecution: this.nonExecution?.toJSON() ?? null }).toJSON();
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

/** One unaccepted publication wait, bounded by the original communication policy. */
class CoordinatorPublicationWait extends PendingCoordinatorRequest {
  #listeners = new Set();
  #disposed = false;
  #wakeAt;
  constructor(message) {
    super(message);
    this.executionId = message.executionId;
    this.callId = message.callId;
    this.deadline = managedMonotonicNow() + new ManagedControlPolicy().budgetMs;
    this.#wakeAt = this.deadline;
    this.#armWake();
  }
  #armWake() {
    if (this.#disposed) return;
    const remaining = this.#wakeAt - managedMonotonicNow();
    if (remaining <= 0) { this.wake(); return; }
    this.timer = setTimeout(() => this.#armWake(), Math.max(1, Math.ceil(remaining)));
  }
  wakeAt(deadline) {
    if (deadline >= this.#wakeAt || this.#disposed) return;
    clearTimeout(this.timer); this.#wakeAt = deadline; this.#armWake();
  }
  get expired() { return managedMonotonicNow() >= this.deadline; }
  assertLive() { if (this.expired) throw this.failure(); }
  subscribe(listener) { this.#listeners.add(listener); }
  unsubscribe(listener) { this.#listeners.delete(listener); }
  wake() { for (const listener of this.#listeners) listener(); }
  dispose() { this.#disposed = true; clearTimeout(this.timer); this.#listeners.clear(); }
}

/** An unaccepted authentication awaiting its actual parent's durable start. */
class ParentStartPublication extends CoordinatorPublicationWait {
  failure() { return new ProcessExecutionControlFailure("endpoint-unavailable", "Parent start publication exceeded its communication budget",
    { executionId: this.executionId, callId: this.callId }); }
}

/** A quiet monitor releases admission, then freshly authenticates and reads again. */
class ControlStatePublication extends CoordinatorPublicationWait {
  constructor(message) {
    const publicationDigest = message.payload.data.afterControlObservation;
    if (publicationDigest !== null && (typeof publicationDigest !== "string" || !/^[a-f0-9]{64}$/.test(publicationDigest))) throw new TypeError("Control observation cursor is invalid");
    super(message);
    this.publicationDigest = publicationDigest;
    this.targetCallId = message.payload.data.call?.callId;
    this.ready = this.publicationDigest === null;
    this.refreshAt = managedMonotonicNow() + 1000;
  }
  defer(publicationDigest, nextTransitionAt) {
    if (this.ready || this.publicationDigest !== publicationDigest) return false;
    const refreshAt = Math.min(this.refreshAt, nextTransitionAt);
    if (managedMonotonicNow() >= refreshAt) return false;
    this.wakeAt(refreshAt);
    return true;
  }
  wake() { this.ready = true; super.wake(); }
  failure() { return new ProcessExecutionControlFailure("endpoint-unavailable", "Control observation exceeded its communication budget",
    { executionId: this.executionId, callId: this.callId }); }
}

/** Arrival order belongs to the coordinator, independently of TCP/mailbox. */
class CoordinatorRequestAdmission {
  constructor(message, owner) {
    this.message = message;
    this.owner = owner;
    this.response = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  get cohortKey() { return RuntimeRequestCohort.key(this.message); }
}

/** Membership is sealed before the single existing Store FIFO body runs. */
class RuntimeRequestCohortAdmission {
  #requests;
  #tail = null;
  #open = true;
  constructor(request) { this.#requests = [request]; }
  bindTail(tail) { this.#tail = tail; }
  append(request, tail) {
    const first = this.#requests[0];
    if (!this.#open || this.#requests.length >= ManagedProcessRequestBatch.maximumWidth || this.#tail !== tail
      || first.owner !== request.owner || first.cohortKey !== request.cohortKey) return false;
    this.#requests.push(request); return true;
  }
  async close() {
    let observedWidth;
    do {
      observedWidth = this.#requests.length;
      await new Promise((resolve) => setImmediate(resolve));
    } while (this.#requests.length > observedWidth
      && this.#requests.length < ManagedProcessRequestBatch.maximumWidth);
    this.#open = false;
  }
  get messages() { return this.#requests.map((request) => request.message); }
  resolveMember(index, response) { this.#requests[index].resolve(response); }
  resolve(responses) { this.#requests.forEach((request, index) => request.resolve(responses[index])); }
  reject(cause) { for (const request of this.#requests) request.reject(cause); }
}

/** Shared authentication/replay input for ordinary and grouped requests. */
class CoordinatorRequestContext {
  constructor(message, root, parent, ledger, prior) {
    this.message = message; this.root = root; this.parent = parent; this.ledger = ledger; this.prior = prior;
    this.authorizationDigest = requestAuthorizationDigest(message);
    if (prior !== null && prior !== undefined && (prior.operation !== message.operation
      || prior.payloadDigest !== message.payloadDigest || prior.authorizationDigest !== this.authorizationDigest)) {
      fail("request-mismatch", "A durable request ID was reused with different operation, content or authority");
    }
    Object.freeze(this);
  }
  newRequest() {
    return new RuntimeRequestRecord({ requestId: this.message.requestId, operation: this.message.operation,
      payloadDigest: this.message.payloadDigest, authorizationDigest: this.authorizationDigest, response: null });
  }
}

/** One synchronous transaction under the original Store FIFO. Independent leaf
 * observations retain their standalone pending ledgers and fresh physical
 * checks; finish retains canonical pending history and every private write.
 * No response escapes before common publication and full readback complete.
 */
class RuntimeRequestCohort {
  #requests;
  #checkpoint = null;
  #publications;
  #prepared = null;
  #effects = [];
  #standaloneResults = [];
  static key(message) { return ManagedProcessRequestBatch.cohortKey(message); }
  static usesRequestLedger(operation) { return operation === "observe" || operation === "persist-call-output"; }
  static independent(root, messages) {
    if (ManagedProcessMessage.reservesCall(messages[0].operation)) return true;
    const ids = messages.map((message) => message.payload.data?.call?.callId);
    const outputCapture = messages[0].operation === "persist-call-output";
    if (outputCapture) {
      const streams = new Map();
      for (const message of messages) {
        const callId = message.payload.data?.call?.callId;
        const stream = message.payload.data?.stream;
        let names = streams.get(callId);
        if (names === undefined) { names = new Set(); streams.set(callId, names); }
        if (names.has(stream)) return false;
        names.add(stream);
      }
    } else if (new Set(ids).size !== messages.length) return false;
    if (!outputCapture && !["observe", "finish"].includes(messages[0].operation)) return true;
    return ids.every((id) => {
      const call = root.calls.find((entry) => entry.callId === id);
      // Only already-exited independent producers share the physical transfer
      // boundary. Active producers and repeated streams keep the scalar path.
      return call !== undefined && (!outputCapture || call.observation !== null)
        && descendantsOf(root, call).length === 0;
    });
  }
  constructor(registry, messages, store, { physicalBaseline = null, requestPublications = new RuntimeRequestPublications(), preview = false } = {}) {
    const key = RuntimeRequestCohort.key(messages[0]);
    if (messages.length < 2 || messages.length > ManagedProcessRequestBatch.maximumWidth || key === null
      || messages.some((message) => RuntimeRequestCohort.key(message) !== key)
      || new Set(messages.map((message) => message.requestId)).size !== messages.length) {
      throw new TypeError("Runtime request cohort requires distinct homogeneous independent requests");
    }
    this.registry = registry; this.store = store; this.preview = preview;
    this.physicalBaseline = physicalBaseline; this.usesRequestLedger = RuntimeRequestCohort.usesRequestLedger(messages[0].operation);
    this.#publications = requestPublications;
    this.#requests = new Map(messages.map((message) => [message.requestId, new PendingCoordinatorRequest(message)]));
  }
  owns(message, request) {
    const accepted = this.#requests.get(message.requestId);
    if (accepted === undefined || request == null || request.response !== null) return false;
    accepted.assertMatches(message);
    return request.operation === message.operation && request.payloadDigest === message.payloadDigest
      && request.authorizationDigest === requestAuthorizationDigest(message);
  }
  request(context) { return this.usesRequestLedger ? context.newRequest() : context.prior; }
  beginRequest() {
    if (Object.isFrozen(this.registry)) { this.#checkpoint = this.registry; return; }
    this.#checkpoint = this.#prepared?.registry ?? freezeRuntimeRegistry(new RuntimeRegistry(this.registry,
      new RuntimeRecordPreparation(runtimeRegistryObservationAuthority)));
  }
  restore() {
    if (this.#checkpoint === this.registry) return this.registry;
    Object.assign(this.registry, this.#checkpoint.mutableCopy(runtimeRegistryObservationAuthority));
    return this.registry;
  }
  prepare(registry, options) {
    if (registry !== this.registry || options.stopClaims.length !== 0) throw new TypeError("Request cohort cannot change stop ownership");
    const requestPublications = options.preparedRegistry?.requestPublications
      ?? this.#publications.concat(options.requestPublications);
    // Reuse only a plan for this exact current input. forSave still performs
    // complete logical/global validation; its exact encoding also proves the
    // previously checked wire/capacity plan. Publication owns all fresh IO.
    return options.preparedRegistry?.forSave(registry, this.store, requestPublications)
      ?? new PreparedRuntimeRegistryPublication(registry, this.store, {
        requestPublications, previous: this.#prepared,
      });
  }
  stage(registry, options) {
    this.#prepared = this.prepare(registry, options);
    this.#publications = this.#prepared.requestPublications;
    this.#effects.push(...options.effects);
  }
  publication(archiveObservation) {
    return { archiveObservation, requestPublications: this.#publications, effects: this.#effects,
      preparedRegistry: this.#prepared };
  }
  stageStandaloneResult(context, request) {
    const acceptance = this.#publications.acceptedObservations()
      .find((entry) => entry.matches(context.root.executionId, request.requestId));
    this.#standaloneResults.push(new RuntimeStandaloneRequestResultPublication(
      context.ledger, context.root.executionId, request, acceptance));
  }
  commit(archiveObservation) {
    if (this.#prepared !== null) return this.store.save(this.registry, this.publication(archiveObservation));
    if (this.#standaloneResults.length !== this.#requests.size) throw new TypeError("Output cohort requires every original result before acknowledgement");
    for (const publication of this.#standaloneResults) publication.publish();
    return this.registry;
  }
}

/** Sole mutable registry owner, running in the independently scheduled control child. */
export class ProcessExecutionCoordinator {
  #pendingRequests = new Map();
  // Grouping classification only; every replay still reads and authenticates fresh authority.
  #handledRequestIds = new Set();
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
      try { if (this.store.transition.read() === null) this.store.ownerLock.release(); }
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
  #root(registry, { release = false, store = this.store, archiveObservation } = {}) {
    let root = registry.executions.find((entry) => entry.executionId === this.executionId);
    const archivedRelease = root === undefined && release;
    if (archivedRelease) root = store.readArchives(archiveObservation).find((entry) => entry.executionId === this.executionId);
    if (!root || !store.ownerLock.isOwnerCurrent(root.coordinatorIdentity)) fail("ownership-changed", "Coordinator token/session no longer owns the checkout exclusion");
    if (archivedRelease) this.#assertRetainedClosure(registry, root);
    return root;
  }
  #synchronizeCommittedLifecycle(root) {
    this.closed = root.status === "closed";
    if (!this.closed) { this.handoff = false; return; }
    const operation = [...root.requests].reverse().find((request) => request.response?.ok === true
      && ["close", "seal", "release-root", "release-reservation"].includes(request.operation))?.operation;
    this.handoff = operation === "seal";
  }
  #assertRetainedClosure(registry, root) {
    assertClosedRuntimeCheckout(registry, root);
    if (root.ownerEpoch !== this.grant.ownerEpoch) fail("stop-unconfirmed", "Retained owner release requires its exact complete sealed execution");
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
  #event(root, call, type, payload = RuntimeCallEventPayload.require(call, type)) {
    let ancestor = call;
    while (ancestor.parentCallId !== null) ancestor = root.calls.find((entry) => entry.callId === ancestor.parentCallId);
    root.events.push(new ProcessExecutionEvent({ eventId: crypto.randomUUID(), executionId: root.executionId,
      callId: call.callId, parentCallId: call.parentCallId, rootCallId: ancestor.callId, sequence: root.events.length + 1,
      type, binding: call.binding, occurredAt: new Date().toISOString(), payload }));
  }
  #beginStop(root, call, { reason = "abort", graceMs } = {}, stopClaims) {
    const ordered = [...descendantsOf(root, call).reverse(), call];
    for (const entry of ordered) {
      entry.accepting = false;
      if (callCompletion(entry) !== null) continue;
      const stopStore = new ManagedStopOperationStore(this.store.callContext(root, entry));
      const proposed = entry.stopOperation ?? ManagedStopOperation.begin({ reason, graceMs: graceMs ?? entry.graceMs });
      const claim = stopStore.prepareClaim(proposed);
      stopClaims.push(claim);
      const operation = claim.operation;
      operation.remainingMs(); // The durable first decision must belong to this clock session.
      if (entry.stopOperation !== null) {
        if (!isDeepStrictEqual(entry.stopOperation.toJSON(), operation.toJSON())) fail("authority-mismatch", "Registry stop decision differs from its durable stop authority");
        continue;
      }
      entry.stopOperation = operation;
      if (["abort", "aborted", "host-disconnected"].includes(reason)) entry.aborted = true;
      this.#event(root, entry, "stop-requested");
    }
    return call.stopOperation;
  }
  #refreshTimeout(root, call, prepareStopRoot = null, stopClaims = []) {
    if (callCompletion(call) === null && call.observation === null && call.timeoutMs !== null && call.startedMonotonic !== null
      && managedMonotonicNow() >= call.startedMonotonic + call.timeoutMs) {
      const stopRoot = prepareStopRoot === null ? root : prepareStopRoot();
      const stopCall = stopRoot === root ? call : stopRoot.calls.find((entry) => entry.callId === call.callId);
      this.#beginStop(stopRoot, stopCall, { reason: "timeout" }, stopClaims);
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
  #notifyPublication(root) {
    let callIndex;
    for (const pending of this.#pendingRequests.values()) {
      if (pending instanceof ControlStatePublication) {
        callIndex ??= new PhysicalCallIndex(root.calls);
        const call = callIndex.get(pending.targetCallId);
        if (call === undefined || pending.publicationDigest !== new RuntimeCallControlState(root, call, callIndex).publicationDigest) pending.wake();
        continue;
      }
      if (!(pending instanceof ParentStartPublication)) continue;
      const parent = root.calls.find((call) => call.callId === pending.callId);
      try { if (parent === undefined || this.#admit(root, parent, { waitForStart: true })) pending.wake(); }
      catch { pending.wake(); } // Wakeup conveys no permission; handle rechecks.
    }
  }
  #wakePendingPublications() {
    for (const pending of this.#pendingRequests.values()) if (pending instanceof CoordinatorPublicationWait) pending.wake();
  }
  /** TCP and mailbox share this one durable acceptance and mutation boundary. */
  async handle(message) {
    message = ManagedProcessMessage.from(json(message));
    message.assertPayload();
    const existing = this.#pendingRequests.get(message.requestId);
    if (existing !== undefined) { existing.assertMatches(message); return existing.response; }
    const waitsForParent = message.operation === "authenticate" && message.callId !== message.executionId && !this.recoveryRoot;
    const observesControl = message.operation === "read-control" && Object.hasOwn(message.payload.data ?? {}, "afterControlObservation") && !this.recoveryRoot;
    const pending = waitsForParent ? new ParentStartPublication(message)
      : observesControl ? new ControlStatePublication(message) : new PendingCoordinatorRequest(message);
    this.#pendingRequests.set(message.requestId, pending);
    const response = pending instanceof CoordinatorPublicationWait ? this.#afterPublication(message, pending) : this.#handleOnce(message);
    pending.response = response.then((result) => {
      this.#handledRequestIds.add(message.requestId);
      return result;
    }).finally(() => {
      if (pending instanceof CoordinatorPublicationWait) pending.dispose();
      // Expired publication waits retain their original deadline tombstone.
      // Ordinary responses never survive settlement in this in-flight registry.
      if (!(pending instanceof CoordinatorPublicationWait) || !pending.expired) this.#pendingRequests.delete(message.requestId);
    });
    return pending.response;
  }
  async #afterPublication(message, pending) {
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
  #requestContext(store, registry, archiveObservation, message) {
    const root = this.#root(registry, { release: ["release-root", "release-reservation"].includes(message.operation), store, archiveObservation });
    this.#synchronizeCommittedLifecycle(root);
    if (message.operation === "release-reservation" && (store.checkoutAuthority === null || this.closed && this.handoff)) this.#assertRetainedClosure(registry, root);
    const parent = this.#authenticate(root, message);
    const ledger = store.requestFile(root.executionId, message.requestId);
    const prior = root.requests.find((entry) => entry.requestId === message.requestId) ?? readRuntimeRequest(ledger, root.executionId, message.requestId);
    return new CoordinatorRequestContext(message, root, parent, ledger, prior);
  }
  #assertNewRequest(registry, { root, parent }, message, pending = null) {
    if (!registry.executions.some((execution) => execution.executionId === root.executionId)) {
      fail("registration-closed", "Archived ownership permits only its exact completed release replay");
    }
    // New requests authenticate their target before durable acceptance. Exact
    // completed replays above retain their original request identity and result.
    // Dispatch resolves the same target in its detached working registry.
    const target = ["revoke-reservation", "claim-launch", "observe", "read-control", "begin-stop",
      "persist-call-output", "finish", "failure"].includes(message.operation) ? this.#call(root, message.payload.data?.call, parent) : null;
    if (pending instanceof ControlStatePublication) {
      let nextTransitionAt = null;
      try {
        this.#executor(target, message.payload.data.executor);
        nextTransitionAt = Math.min(this.nextTickAt, target.stopOperation?.nextSignalTransitionAt() ?? Infinity);
      } catch { /* Advisory waiting never replaces the original accepted dispatch refusal below. */ }
      if (nextTransitionAt !== null && pending.defer(new RuntimeCallControlState(root, target).publicationDigest, nextTransitionAt)) return true;
    }
    // A claimed launch is not running authority. Await the actual executor's
    // committed start without recording a permanent refusal or holding a lock.
    if (message.operation === "authenticate" && message.payload.data?.binding !== undefined && parent !== null
      && !new ProcessExecutionBinding(message.payload.data.binding).matches(parent.binding)) fail("binding-mismatch", "Borrowed scope differs from its exact parent binding");
    if (pending instanceof ParentStartPublication && !this.#admit(root, parent, { waitForStart: true })) return true;
    pending?.assertLive();
    return false;
  }
  #acceptLedger(context) {
    const publication = context.ledger.write(encodeRuntimeRequest(context.root.executionId, context.newRequest()), { exclusive: true });
    return new RuntimeAcceptedRequestObservation(context.root.executionId, context.message.requestId, publication.snapshot);
  }
  #applyCohort(messages, store, archiveObservation) {
    const base = store.read({ archiveObservation, immutable: true });
    const usesRequestLedger = RuntimeRequestCohort.usesRequestLedger(messages[0].operation);
    const outputCapture = messages[0].operation === "persist-call-output";
    // Private output IO never changes the registry. Retain its validated frozen
    // source instead of copying all historical calls for planning and rollback.
    const accepted = outputCapture ? base : base.mutableCopy(runtimeRegistryObservationAuthority);
    const planned = outputCapture ? null : base.mutableCopy(runtimeRegistryObservationAuthority);
    let acceptedPreparation;
    if (!RuntimeRequestCohort.independent(this.#root(base), messages)) return null;
    // Preparation is speculative and invokes only the same read/logical
    // admission code. Any refusal returns to the ordinary serial operation;
    // no accepted effect is retried and no provider retry budget is used.
    // Frontloading pending acceptances must not take capacity that an
    // ordinary serial request could have used. Prove both states before any
    // publication; unsupported/refused groups return to the original path.
    try {
      for (const message of messages) {
        const context = this.#requestContext(store, accepted, archiveObservation, message);
        if (context.prior != null) return null;
        this.#assertNewRequest(accepted, context, message);
        if (!usesRequestLedger) {
          context.root.requests.push(context.newRequest());
          this.#root(planned).requests.push(context.newRequest());
        }
      }
      if (!outputCapture) {
        acceptedPreparation = new PreparedRuntimeRegistryPublication(accepted, store);
        const preview = new RuntimeRequestCohort(planned, messages, store, { preview: true, physicalBaseline: base });
        for (const message of messages) {
          preview.beginRequest();
          if (!this.#applyRequest(store, archiveObservation, message, null, preview).payload.ok) return null;
        }
      }
      // Output capture has no speculative IO: each original request is accepted
      // before its existing spool validates and writes its own captured bytes.
    } catch {
      // No durable acceptance or execution effect has occurred. The normal
      // request handler freshly reads authority and owns its failure/result.
      return null;
    }
    let registry, physicalBaseline = null;
    let requestPublications = new RuntimeRequestPublications();
    if (usesRequestLedger) {
      for (const message of messages) {
        const context = this.#requestContext(store, base, archiveObservation, message);
        requestPublications = requestPublications.concat(RuntimeRequestPublications.single({ acceptedRequest: this.#acceptLedger(context) }));
      }
      // A physical read after all owned ledger publications is mandatory.
      physicalBaseline = store.read({ archiveObservation, immutable: true });
      registry = outputCapture ? physicalBaseline : physicalBaseline.mutableCopy(runtimeRegistryObservationAuthority);
    } else {
      // The preview changed a separate graph. Reuse this acceptance's checked
      // plan through save's complete validation and exact-input comparison.
      registry = store.save(accepted, { archiveObservation,
        requestPublications: acceptedPreparation.requestPublications, preparedRegistry: acceptedPreparation });
    }
    const cohort = new RuntimeRequestCohort(registry, messages, store, { physicalBaseline, requestPublications });
    const responses = messages.map((message) => {
      cohort.beginRequest();
      return this.#applyRequest(store, archiveObservation, message, null, cohort);
    });
    // Every ledger is durable and the complete physical source is freshly
    // captured before this group. Revalidate it after the detached observations
    // or independent exited-producer transfers, before any result can escape.
    if (physicalBaseline !== null) this.#assertRequestEffectRegistry(store, archiveObservation, physicalBaseline, messages);
    const committed = cohort.commit(archiveObservation);
    const root = this.#root(committed);
    this.#synchronizeCommittedLifecycle(root); this.#scheduleTick(root); this.#notifyPublication(root);
    return responses;
  }
  async #handleOnce(message, pending = null) {
    const authorizationDigest = requestAuthorizationDigest(message);
    if (this.recoveryRoot) {
      if (!this.store.ownerLock.isOwnerCurrent(this.recoveryRoot.coordinatorIdentity)) fail("ownership-changed", "Recovery owner capability changed");
      this.#authenticate(this.recoveryRoot, message);
      if (message.operation !== "release-recovery") fail("delegation-refused", "Read-only recovery authority grants no execution or registry mutation");
      const file = this.store.requestFile(this.executionId, message.requestId);
      const saved = readRuntimeRequest(file, this.executionId, message.requestId);
      if (saved !== null && (saved.operation !== message.operation || saved.payloadDigest !== message.payloadDigest || saved.authorizationDigest !== authorizationDigest)) fail("request-mismatch", "A durable recovery request ID was reused with different content or authority");
      if (saved?.response === null) fail("request-unconfirmed", "Recovery release has no confirmed durable response");
      const result = saved?.response ?? { ok: true, value: null };
      if (saved === null) file.write(encodeRuntimeRequest(this.executionId, new RuntimeRequestRecord({ requestId: message.requestId,
        operation: message.operation, payloadDigest: message.payloadDigest, authorizationDigest, response: result })), { exclusive: true });
      const response = message.respond(result);
      this.#finishRelease(response); this.closed = true;
      return response;
    }
    if (pending === null && !this.#handledRequestIds.has(message.requestId) && RuntimeRequestCohort.key(message) !== null) {
      const request = new CoordinatorRequestAdmission(message, this);
      return this.store.coalesceRequest(request,
        (messages, store, archiveObservation) => this.#applyCohort(messages, store, archiveObservation),
        (entry, store, archiveObservation) => this.#applyRequest(store, archiveObservation, entry))
        .catch((cause) => { this.#wakePendingPublications(); throw cause; });
    }
    const retainedClosed = message.operation === "release-reservation";
    return this.store.exclusive((store, archiveObservation) => this.#applyRequest(store, archiveObservation, message, pending),
      { deadline: pending?.deadline ?? Infinity, deadlineFailure: pending === null ? undefined : () => pending.failure(), retainedClosed })
      .catch((cause) => { this.#wakePendingPublications(); throw cause; });
  }
  #assertRequestEffectRegistry(store, archiveObservation, expectedRegistry, messages) {
    const freshRegistry = store.read({ archiveObservation, immutable: true });
    const freshRoot = this.#root(freshRegistry);
    for (const message of messages) {
      const freshParent = this.#authenticate(freshRoot, message);
      this.#call(freshRoot, message.payload.data?.call, freshParent);
    }
    if (freshRegistry === expectedRegistry) return;
    if (!new RuntimePublicationExpectedRegistry(expectedRegistry).matches(freshRegistry)) {
      fail("authority-mismatch", messages[0].operation === "persist-call-output"
        ? "Runtime registry changed during output transfer" : "Runtime registry changed during observation",
      { executionId: freshRoot.executionId });
    }
  }
  #applyRequest(store, archiveObservation, message, pending = null, cohort = null) {
    pending?.assertLive();
    const pureRequest = ["authenticate", "events", "runtime-snapshot"].includes(message.operation);
    const readControlRequest = message.operation === "read-control";
    const outputTransferRequest = message.operation === "persist-call-output";
    const observationRequest = message.operation === "observe";
    const eventPublicationRequest = ["ack-events", "dispose-runtime-events"].includes(message.operation);
    const immutableRequest = pureRequest || readControlRequest || outputTransferRequest || observationRequest || eventPublicationRequest;
    let registry = cohort?.registry ?? store.read({ archiveObservation, immutable: immutableRequest });
    const context = this.#requestContext(store, registry, archiveObservation, message);
    const { root, parent, ledger, prior } = context;
    const usesRequestLedger = pureRequest || readControlRequest || outputTransferRequest || observationRequest || eventPublicationRequest;
    if (prior && !cohort?.owns(message, prior)) {
      if (prior.response === null) fail("request-unconfirmed", "Request acceptance survived without confirmed completion; the effect cannot be replayed");
      const response = message.respond(prior.response);
      if (prior.response.ok && ["release-root", "release-reservation"].includes(message.operation)) this.#finishRelease(response, store);
      return response;
    }
    if (this.#assertNewRequest(registry, context, message, pending)) return pending;
    const request = cohort === null ? context.newRequest() : cohort.request(context);
    const requestEffectRegistry = outputTransferRequest || observationRequest ? cohort?.physicalBaseline ?? registry : null;
    // Scalar requests retain both fresh guards. Independent cohorts own one
    // complete physical boundary around all original effects; their replies
    // remain private until its final check and each exact pending readback.
    const assertRequestEffectRegistry = requestEffectRegistry === null
      || cohort !== null ? null : () => {
      this.#assertRequestEffectRegistry(store, archiveObservation, requestEffectRegistry, [message]);
    };
    let workingRegistry = registry;
    let acceptedRequest = null;
    if (usesRequestLedger && cohort === null) {
      acceptedRequest = this.#acceptLedger(context);
    } else if (!usesRequestLedger && cohort === null) {
      root.requests.push(request);
      // Effects use the detached validated acceptance; refusal reloads its durable baseline.
      workingRegistry = store.save(registry, { archiveObservation });
    }
    // Preserve fresh authority and inventory checks around accepted effects.
    // Observation completion remains inline with its facts in the final full save.
    assertRequestEffectRegistry?.();
    if (observationRequest && cohort === null) workingRegistry = registry.mutableCopy(runtimeRegistryObservationAuthority);
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
    const restoreAcceptedRegistry = () => {
      Object.assign(this, state);
      registry = cohort === null ? store.read({ archiveObservation }) : cohort.restore();
      committedRoot = this.#root(registry);
    };
    const effects = [];
    const stopClaims = [];
    try {
      result = { ok: true, value: json(this.#dispatch(working,
        parent === null ? null : working.calls.find((entry) => entry.callId === parent.callId), message.operation, message.payload.data ?? {}, workingRegistry, archiveObservation, prepareWorkingRegistry, effects, stopClaims)) };
      committedRoot = working;
      registry = workingRegistry;
    }
    catch (cause) {
      // Preparation previously happened outside this effect/failure boundary.
      if (registryPreparationFailed) throw cause;
      effects.length = 0;
      stopClaims.length = 0;
      // Acceptance replaced the validated source graph. Refusals use its
      // durable baseline after discarding the staged dispatch mutations.
      if (usesRequestLedger && cohort === null) Object.assign(this, state);
      else restoreAcceptedRegistry();
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
    const optionalAdmission = ManagedProcessMessage.reservesCall(message.operation) || message.operation === "bind"
      || message.operation === "finalization-fence" && committedRoot.finalizationFences.length > root.finalizationFences.length;
    let preparedRegistry = null;
    if (optionalAdmission && result.ok) {
      // These admissions have no observation/settlement/completion sidecar.
      // Keep their checked plan for the existing, fully revalidated save path
      // instead of planning the same exact wire and capacity twice.
      const preparation = { requestPublications: RuntimeRequestPublications.single({ acceptedRequest }), effects, stopClaims };
      try {
        preparedRegistry = cohort === null ? new PreparedRuntimeRegistryPublication(registry, store, preparation)
          : cohort.prepare(registry, preparation);
      }
      catch (cause) {
        if (!(cause instanceof ProcessExecutionControlFailure) || cause.reason !== "record-capacity") throw cause;
        // Optional admission has only staged memory. Preserve its accepted
        // identity and refusal without consuming prior terminal capacity.
        restoreAcceptedRegistry();
        result = { ok: false, error: cause.toJSON() };
        request.response = result;
        committedRoot.requests.find((entry) => entry.requestId === request.requestId).response = result;
      }
    }
    if (committedRoot.status === "closed" && registry.slot !== null) registry.slot = null;
    const publishesRegistry = !usesRequestLedger || observationRequest || readControlRequest && (committedRoot.events.length !== beforeControlEvents
      || committedRoot.calls.reduce((count, call) => count + Number(call.accepting), 0) !== beforeControlAccepting)
      || eventPublicationRequest && registry.eventPublicationCount() !== beforeEventPublications;
    if (publishesRegistry) {
      const observedRequest = observationRequest && result.ok && message.payload.data.type === "exit"
        ? { executionId: committedRoot.executionId, requestId: request.requestId,
          callId: message.payload.data.call.callId, observation: message.payload.data.observation } : null;
      const settledRequest = message.operation === "finish" && result.ok
        ? { executionId: committedRoot.executionId, requestId: request.requestId,
          callId: message.payload.data.call.callId, outcome: message.payload.data.outcome ?? null,
          firstFinish: RuntimeFirstCallSettlement.fromEffects(effects) } : null;
      const completedRequest = usesRequestLedger && !observationRequest ? { executionId: root.executionId, request } : null;
      const requestPublications = preparedRegistry?.requestPublications
        ?? RuntimeRequestPublications.single({ observedRequest, settledRequest, completedRequest, acceptedRequest });
      const publication = { archiveObservation, requestPublications, effects, stopClaims, preparedRegistry };
      if (cohort === null) store.save(registry, publication);
      else cohort.stage(registry, publication);
    }
    if (usesRequestLedger && !observationRequest && !publishesRegistry) {
      if (cohort === null) ledger.write(encodeRuntimeRequest(root.executionId, request));
      else cohort.stageStandaloneResult(context, request);
    }
    const response = message.respond(result);
    if (cohort === null) {
      this.#synchronizeCommittedLifecycle(committedRoot);
      this.#scheduleTick(committedRoot);
      if (result.ok && ["release-root", "release-reservation"].includes(message.operation)) this.#finishRelease(response, store);
      this.#notifyPublication(committedRoot);
    }
    return response;
  }
  #claimLaunch(root, call, executor) {
    if (call.status !== "intent" || call.executor !== null || call.stopOperation !== null || !call.accepting) fail("start-refused", "A reserved call permits one launch claim only");
    call.executor = ProcessExecutorIdentity.fromStored(executor);
    call.permit = new ProcessExecutionStartPermit({ executionId: root.executionId, callId: call.callId,
      ownerEpoch: root.ownerEpoch, ownerToken: root.coordinatorIdentity.ownerToken, capability: call.capability, bindingDigest: call.binding.digest });
    call.status = "claimed";
    return call.permit;
  }
  #dispatch(root, parent, operation, data, registry, archiveObservation, prepareControlRegistry = null, effects = [], stopClaims = []) {
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
      case "reserve":
      case "reserve-and-claim": {
        this.#admit(root, parent);
        const binding = new ProcessExecutionBinding(data.binding);
        if (parent !== null && !binding.matches(parent.binding)) fail("delegation-refused", "Nested call cannot replace its delegated binding");
        if ([...this.store.readArchives(archiveObservation), ...registry.executions].some((execution) => execution.finalizationFences.some((fence) => fence.selection.matches(binding)))) fail("registration-closed", "Finalized binding admission is permanently fenced");
        const call = new PhysicalCallRecord({ callId: crypto.randomUUID(), parentCallId: parent?.callId ?? null,
          binding: binding.toJSON(), invocation: data.invocation ?? null, capability: crypto.randomUUID(), status: "intent",
          executor: null, permit: null, observation: null, output: null, receipt: null, revocation: null, outcome: null, controlFailure: null,
          stopOperation: null, accepting: true, timeoutMs: data.timeoutMs ?? null, graceMs: data.graceMs, startedAt: null, startedMonotonic: null, aborted: false });
        root.calls.push(call);
        this.#event(root, call, "reserved");
        if (operation === "reserve-and-claim") this.#claimLaunch(root, call, data.executor);
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
        call.revocation = new ProcessExecutionReservationRevocation({ schemaVersion: 3, scope: "unlaunched-reservation",
          executionId: root.executionId, callId: call.callId, ownerEpoch: root.ownerEpoch, checkoutIdentity: this.store.checkout,
          binding: call.binding, ...ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON(), closureRevision: root.events.length + 1, reason, stopOperation: call.stopOperation });
        call.status = "revoked"; call.accepting = false;
        this.#event(root, call, "result-finalized");
        return call.revocation;
      }
      case "claim-launch": {
        this.#admit(root, parent);
        const call = this.#call(root, data.call, parent);
        return this.#claimLaunch(root, call, data.executor);
      }
      case "observe": {
        const call = this.#call(root, data.call, parent);
        if (data.type === "started") {
          this.#executor(call, data.executor);
          if (call.status !== "claimed") fail("observation-mismatch", "Start observation requires its claimed launch");
          if (typeof data.startedAt !== "string" || new Date(data.startedAt).toISOString() !== data.startedAt) throw new TypeError("Started observation requires ISO time");
          call.status = "running"; call.startedAt = data.startedAt; call.startedMonotonic = managedMonotonicNow();
          this.#event(root, call, "started");
        } else if (data.type === "exit") {
          const observation = ChildExitObservation.fromStored(data.observation);
          this.#executor(call, observation.executor);
          if (call.observation !== null && !isDeepStrictEqual(json(call.observation), json(observation))) fail("observation-mismatch", "A recorded child exit cannot be replaced");
          if (call.observation === null) {
            if (!["claimed", "running"].includes(call.status)) fail("observation-mismatch", "Child exit requires its launch claim");
            call.observation = observation; call.status = "exited"; call.accepting = false;
            this.#event(root, call, observation.kind === "spawn-failed" ? "spawn-failed" : "exited");
            for (const descendant of descendantsOf(root, call).filter((entry) => entry.parentCallId === call.callId)) this.#beginStop(root, descendant, { reason: "parent-exit" }, stopClaims);
          }
        } else throw new TypeError("Unknown child observation type");
        return { status: call.status };
      }
      case "read-control": {
        let call = this.#call(root, data.call, parent);
        this.#executor(call, data.executor);
        const refreshedRoot = this.#refreshTimeout(root, call, prepareControlRegistry, stopClaims);
        if (refreshedRoot !== root) {
          root = refreshedRoot;
          call = root.calls.find((entry) => entry.callId === call.callId);
        }
        const state = new RuntimeCallControlState(root, call);
        const control = state.reply(managedMonotonicNow());
        return Object.hasOwn(data, "afterControlObservation")
          ? new ProcessExecutionControlObservation({ executionId: root.executionId, callId: call.callId,
            control, publicationDigest: state.publicationDigest }) : control;
      }
      case "begin-stop": {
        const call = this.#call(root, data.call, parent);
        return this.#beginStop(root, call, data, stopClaims);
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
        call.receipt = new ProcessExecutionStopReceipt({ schemaVersion: 4, scope: "registered-executions", executionId: root.executionId, callId: call.callId,
          ownerEpoch: root.ownerEpoch, checkoutIdentity: this.store.checkout, binding: call.binding, ...ProcessExecutionInvocationDisclosure.capture(call.invocation).toJSON(),
          executor: call.executor, observation, output, closureRevision: root.events.length + 1,
          descendants: descendants.map((entry) => ProcessExecutionCallClosure.fromFact(callCompletion(entry)).toJSON()),
          stopOperation: call.stopOperation, outcomeDigest: digest(call.outcome) });
        effects.push(RuntimeFirstCallSettlement.capture(new ManagedRecordWrite(context.outcomePath, Buffer.from(JSON.stringify({ schemaVersion: 3, scope: "registered-executions", executionId: root.executionId,
          callId: call.callId, ownerToken: context.ownerToken, capability: call.capability, executor: call.executor.toJSON(),
          observation: observation.toJSON(), state: "finished", outcome: call.outcome, receipt: call.receipt.toJSON() })), context), call));
        call.status = "stopped"; call.accepting = false;
        this.#event(root, call, "result-finalized");
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
      case "events": return registry.executions.flatMap((execution) => execution.pendingEvents());
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
        for (const call of root.calls.filter((entry) => entry.parentCallId === null)) this.#beginStop(root, call, { reason: "root-close" }, stopClaims);
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
        return null;
      case "release-reservation":
        if (parent !== null || !this.handoff || root.status !== "closed") fail("reservation-release-failed", "No sealed root reservation belongs to this grant");
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
      const stopClaims = [];
      for (const call of root.calls) this.#refreshTimeout(root, call, null, stopClaims);
      for (const call of root.calls.filter((entry) => callCompletion(entry) === null && entry.stopOperation !== null)) {
        if (call.stopOperation.remainingMs() > 0 || root.events.some((event) => event.callId === call.callId && event.type === "stop-unconfirmed")) continue;
        call.accepting = false;
        call.controlFailure ??= runtimeStopUnconfirmedFailure(root.executionId, call.callId);
        this.#event(root, call, "stop-unconfirmed");
      }
      if (digest(registry) !== before) this.store.save(registry, { stopClaims });
      this.#scheduleTick(root);
      this.#notifyPublication(root);
    }).catch((cause) => { this.#wakePendingPublications(); throw cause; });
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
      const stopClaims = [];
      for (const call of root.calls.filter((entry) => entry.parentCallId === null)) this.#beginStop(root, call, { reason: "host-disconnected" }, stopClaims);
      store.save(registry, { stopClaims });
      this.#scheduleTick(root);
      // Host loss alone is no exit observation. Any incomplete call retains exclusion.

    }, { retainedClosed });
    } finally { this.#wakePendingPublications(); }
  }
}

/** Actual control-child handle retained by the root client until closure. */
class CoordinatorChildControl {
  static async launch(configuration, environment, { workspace = null, execution = null, storagePolicy = null, temporaryParent } = {}) {
    const control = new CoordinatorChildControl();
    control.diagnostics = [];
    control.workspace = workspace; control.workspaceExecution = execution;
    // Mailbox replies outlive coordinator exit: a lost terminating TCP reply
    // must still replay from this separately owned control scratch. Keep its
    // authority in the root endpoint; do not clean it on exit or impose a TTL.
    // This is retained protocol evidence, not a pending workspace execution.
    // Retained control directories therefore grow until explicitly cleaned.
    control.endpointWorkspace = ReadOnlyInvocationWorkspace.create({ temporaryParent });
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


const claimedLaunchAuthority = Symbol("authenticated claimed launch");

/** One authenticated atomic reservation; only its executor may consume it once. */
export class ProcessExecutionClaimedLaunch {
  #consumed = false;
  constructor(runtime, record, executor, authority) {
    if (authority !== claimedLaunchAuthority) throw new TypeError("Claimed launch requires its authenticated reservation");
    const claimed = new PhysicalCallRecord(record, { executionId: runtime.executionId });
    if (claimed.status !== "claimed" || !claimed.executor.matches(executor)) fail("response-invalid", "Claimed reservation differs from its requested executor");
    this.call = new ProcessExecutionCall(runtime, record);
    this.executor = executor;
    this.permit = this.call.acceptStartPermit(executor, claimed.permit);
    Object.freeze(this);
  }
  consume(runtime, call, executor) {
    if (this.#consumed || call !== this.call || call.runtime !== runtime || !this.executor.matches(executor)) {
      fail("start-refused", "Claimed reservation permits one launch by its original executor only");
    }
    this.#consumed = true;
    return call.acceptStartPermit(executor, this.permit);
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
  acceptStartPermit(executor, value) {
    const permit = value instanceof ProcessExecutionStartPermit ? value : new ProcessExecutionStartPermit(value);
    if (!permit.matches(new ProcessExecutionStartPermit({ executionId: this.executionId, callId: this.callId,
      ownerEpoch: this.ownerEpoch, ownerToken: this.ownerToken, capability: this.capability, bindingDigest: this.binding.digest }))) {
      fail("response-invalid", "Start permit belongs to another registered call");
    }
    this.executor = executor instanceof ProcessExecutorIdentity ? executor : ProcessExecutorIdentity.fromStored(executor);
    return permit;
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

/** One invocation of a supplied writer, preserving its declared publication boundary. */
class ProcessEventWriterInvocation {
  constructor(writer, events) { this.writer = writer; this.group = new ProcessExecutionEventGroup(events); }
  write() {
    if (this.writer instanceof ProcessExecutionAtomicEventWriter) return this.writer.writeGroup(this.group);
    const result = ProcessEventPublicationBatch.write(this.writer, this.group.events[0]);
    return result?.then === undefined ? [result] : result.then((publication) => [publication]);
  }
  static *select(pending, writer, writers, selection) {
    let selected = null, events = [];
    for (const stored of pending) {
      const event = ProcessExecutionEvent.fromStored(stored);
      if (selection !== null && !selection.matches(event.binding)) continue;
      const next = writer ?? writers.get(event.binding.digest);
      if (next === undefined) continue;
      if (events.length > 0 && (selected !== next || !(next instanceof ProcessExecutionAtomicEventWriter)
        || events[0].executionId !== event.executionId || !events[0].binding.matches(event.binding))) {
        yield new ProcessEventWriterInvocation(selected, events);
        events = [];
      }
      selected = next; events.push(event);
      if (!(next instanceof ProcessExecutionAtomicEventWriter)) {
        yield new ProcessEventWriterInvocation(selected, events); events = [];
      }
    }
    if (events.length > 0) yield new ProcessEventWriterInvocation(selected, events);
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
/** One authenticated hydration boundary for asynchronous and blocking clients. */
class RemoteRuntimeAuthentication {
  constructor(grant, binding) {
    try { this.grant = new ProcessExecutionGrant(grant).toJSON(); }
    catch (cause) { fail("delegation-refused", "Coordinator grant is malformed or unsupported", { cause }); }
    this.binding = binding ?? this.grant.scopeBinding;
    Object.freeze(this);
  }
  data() {
    return this.binding === undefined || this.binding === null
      ? {} : { binding: json(new ProcessExecutionBinding(this.binding)) };
  }
  restore(Runtime, response, { callAdmission = null, eventWriter = null, faultInjector = null, requestTransport = null } = {}) {
    const result = Runtime.prototype.decodeResponse(response);
    const grant = this.grant;
    const store = new ProcessRuntimeStore({ mainRoot: grant.mainRoot, executionRoot: grant.executionRoot, create: false,
      storagePolicy: grant.storage === null ? null : ReadOnlyProcessRuntimeStorage.fromGrant(grant.storage) });
    if (!store.checkout.matches(new ProcessExecutionCheckoutIdentity(result.checkout))) fail("authority-mismatch", "Coordinator response belongs to another physical checkout");
    const borrowed = grant.callId !== grant.executionId;
    const view = ProcessExecutionClientView.fromStored(result.record);
    return new Runtime(store, view, { grant: result.grant, borrowed,
      binding: borrowed ? view.parentBinding : this.binding, callAdmission, eventWriter, faultInjector, requestTransport, nonOwning: true });
  }
}

export class ProcessExecutionRuntime {
  #requestTransport;
  #recoveryTail = Promise.resolve();
  #ownershipReservation = null;
  #closureInProgress = false;
  constructor(store, record, { grant, borrowed = false, binding = record.binding, root = null,
    callAdmission = null, eventWriter = null, control = null, faultInjector = null, nonOwning = false, requestTransport = null } = {}) {
    if (callAdmission !== null && !(callAdmission instanceof ProcessExecutionCallAdmission)) throw new TypeError("Typed process call admission is required");
    if (eventWriter !== null && !ProcessEventPublicationBatch.accepts(eventWriter)) throw new TypeError("Process event writer requires a function or typed batch writer");
    if (requestTransport !== null && !(requestTransport instanceof ManagedRequestTransportCohort)) throw new TypeError("Runtime transport requires its nominal request cohort");
    this.#requestTransport = requestTransport ?? new ManagedRequestTransportCohort();
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
    environment = process.env, callAdmission = null, eventWriter = null, faultInjector = null, workspace = null, temporaryParent } = {}) {
    if (workspace === null && environment[PROCESS_EXECUTION_SCOPE_ENV]) {
      let grant;
      try { grant = JSON.parse(environment[PROCESS_EXECUTION_SCOPE_ENV]); }
      catch (cause) { fail("delegation-refused", "Borrowed execution grant is not valid JSON", { cause }); }
      if (path.resolve(mainRoot) !== grant.mainRoot || path.resolve(executionRoot) !== grant.executionRoot
        || runId !== grant.runId || specId !== grant.specId) fail("delegation-refused", "Borrowed execution belongs to another checkout, run or specification");
      return this.fromRemoteGrant(grant, { binding, callAdmission, eventWriter, faultInjector });
    }
    if (workspace !== null && !(workspace instanceof InvocationControlWorkspace)) throw new TypeError("Isolated control storage requires a minted invocation workspace");
    const storagePolicy = workspace?.processRuntimeStorage() ?? null;
    const configuration = { mainRoot: fs.realpathSync(path.resolve(mainRoot)), executionRoot: fs.realpathSync(path.resolve(executionRoot)),
      runId, specId, binding: json(new ProcessExecutionBinding(binding)), storage: storagePolicy?.toJSON() ?? null };
    const execution = workspace?.beginExecution() ?? null;
    const { control, record } = await CoordinatorChildControl.launch(configuration, environment, { workspace, execution, storagePolicy, temporaryParent });
    const store = new ProcessRuntimeStore({ mainRoot: configuration.mainRoot, executionRoot: configuration.executionRoot, create: false, storagePolicy });
    return new this(store, record, { grant: control.grant, control, callAdmission, eventWriter, faultInjector });
  }
  static async fromRemoteGrant(grant, { binding, callAdmission = null, eventWriter = null, faultInjector = null, requestTransport = null } = {}) {
    const authentication = new RemoteRuntimeAuthentication(grant, binding);
    const response = await managedRequest(authentication.grant, "authenticate", { grant: authentication.grant, data: authentication.data() });
    return authentication.restore(this, response, { callAdmission, eventWriter, faultInjector, requestTransport });
  }
  static fromRemoteGrantSync(grant, { binding, callAdmission = null, eventWriter = null, faultInjector = null } = {}) {
    const authentication = new RemoteRuntimeAuthentication(grant, binding);
    const response = runManagedControlSync(authentication.grant, "authenticate", authentication.data());
    return authentication.restore(this, response, { callAdmission, eventWriter, faultInjector });
  }
  decodeResponse(response) {
    const payload = response?.payload ?? response;
    if (payload?.ok === false) throw ProcessExecutionControlFailure.fromStored(payload.error);
    if (payload?.ok !== true || !Object.hasOwn(payload, "value")) fail("response-invalid", "Coordinator returned an invalid authenticated response");
    return payload.value;
  }
  async #request(operation, data = {}) {
    const grant = this.remoteGrant();
    try { return this.decodeResponse(await managedRequest(grant, operation, { grant, data: json(data) }, { request: this.#requestTransport?.createRequest() })); }
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
      root: this.root, control: this.control, callAdmission, eventWriter, faultInjector: this.faultInjector, nonOwning: this.nonOwning, requestTransport: this.#requestTransport });
    return scopes.run(scope, callback);
  }
  reserveCall(options = {}) { return this.#reserveCall(options); }
  reserveClaimedCall({ executor, ...options }) {
    return this.#reserveCall(options, ProcessExecutorIdentity.fromStored(json(executor)));
  }
  async #reserveCall({ binding = this.binding, invocation = null, timeoutMs = null, graceMs = DEFAULT_REGISTERED_CHILD_GRACE_MS, ...options } = {}, executor = null) {
    this.#assertOpen();
    const requested = new ProcessExecutionBinding(binding);
    if (this.borrowed && !requested.matches(this.binding)) fail("delegation-refused", "Nested call cannot replace its delegated binding");
    this.callAdmission?.admit({ runtime: this, binding: requested });
    const record = await this.#request(executor === null ? "reserve" : "reserve-and-claim", { binding: requested.toJSON(),
      invocation: json(invocation ?? { ...options, reservedAt: new Date().toISOString() }), timeoutMs, graceMs,
      ...(executor === null ? {} : { executor: executor.toJSON() }) });
    if (this.eventWriter !== null) this.eventWriters.set(requested.digest, this.eventWriter);
    this.faultInjector?.({ phase: "after-runtime-readback", filePath: this.store.file.filePath });
    await this.drainEvents();
    return executor === null ? new ProcessExecutionCall(this, record)
      : new ProcessExecutionClaimedLaunch(this, record, executor, claimedLaunchAuthority);
  }
  async claimLaunch(call, { executor }) {
    this.#assertCall(call);
    const permit = await this.#request("claim-launch", { call: call.controlTarget(), executor: json(executor) });
    const accepted = call.acceptStartPermit(executor, permit);
    await this.drainEvents();
    return accepted;
  }
  authorizeStart(call, details) { return this.claimLaunch(call, details); }
  async observeCall(call, observation) {
    this.#assertCall(call);
    const result = await this.#request("observe", { call: call.controlTarget(), ...json(observation) });
    await this.drainEvents();
    return result;
  }
  #controlRequest(call, executor, options = {}) {
    this.#assertCall(call);
    return this.#request("read-control", { call: call.controlTarget(), executor: json(executor), ...options });
  }
  async readCallControl(call, { executor }) { return this.#controlRequest(call, executor); }
  async observeCallControl(call, { executor, after = null }) {
    if (after !== null && (!(after instanceof ProcessExecutionControlObservation) || !after.matches(this.executionId, call.callId))) throw new TypeError("Control observation belongs to another call");
    const observed = ProcessExecutionControlObservation.fromStored(await this.#controlRequest(call, executor,
      { afterControlObservation: after?.publicationDigest ?? null }));
    if (!observed.matches(this.executionId, call.callId)) fail("response-invalid", "Coordinator control observation belongs to another call");
    return observed;
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
  #eventPublications(invocation, publications) {
    const events = invocation.group.events;
    if (!Array.isArray(publications) || publications.length !== events.length) fail("event-mismatch",
      "Event writer did not return every exact durable publication", { executionId: events[0].executionId, callId: events[0].callId });
    return publications.map((publication, index) => this.#eventPublication(events[index], publication));
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
    for (const invocation of ProcessEventWriterInvocation.select(pending, writer, this.eventWriters, selection)) {
      if (batch.beforeWriter(invocation.writer)) await batch.flush(request);
      let publications;
      try { publications = this.#eventPublications(invocation, await invocation.write()); }
      catch (error) { return batch.failAfterFlush(error, request); }
      for (const publication of publications) {
        if (batch.beforePublication(publication)) await batch.flush(request);
        batch.add(publication);
      }
      if (batch.afterWriter(invocation.writer)) await batch.flush(request);
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
      for (const invocation of ProcessEventWriterInvocation.select(pending, writer, this.eventWriters, selection)) {
        if (batch.beforeWriter(invocation.writer)) batch.flush(request);
        let publications;
        try {
          const result = invocation.write();
          if (result?.then !== undefined) throw new TypeError("Synchronous event drain requires a synchronous canonical writer");
          publications = this.#eventPublications(invocation, result);
        } catch (error) { return batch.failAfterFlush(error, request); }
        for (const publication of publications) {
          if (batch.beforePublication(publication)) batch.flush(request);
          batch.add(publication);
        }
        if (batch.afterWriter(invocation.writer)) batch.flush(request);
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
  inspect() {
    return ProcessExecutionRuntime.#inspect({ mainRoot: this.mainRoot, executionRoot: this.executionRoot,
      storagePolicy: this.store.storagePolicy }, this.store);
  }
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
  #closeClientView(synchronous) {
    if (!this.borrowed && !this.nonOwning) fail("delegation-refused", "Synchronous disposal requires a non-owning client view");
    if (this.closed) return;
    const finish = () => { this.closed = true; };
    if (synchronous) { this.drainEventsSync(); finish(); return; }
    return this.drainEvents().then(finish);
  }
  closeClientViewSync() { return this.#closeClientView(true); }
  async close() {
    if (this.closed) {
      if (this.#ownershipReservation !== null && !this.#ownershipReservation.released) return;
      if (!this.borrowed && !this.nonOwning && this.root === this) await this.control?.waitForExit();
      return;
    }
    if (this.borrowed || this.nonOwning) return this.#closeClientView(false);
    if (this.root !== this) return this.root.close();
    await this.#closeRoot("close");
    await this.control?.waitForExit();
  }
  static inspect({ mainRoot, executionRoot = mainRoot, storagePolicy = null } = {}) {
    return ProcessExecutionRuntime.#inspect({ mainRoot, executionRoot, storagePolicy });
  }
  static #inspect({ mainRoot, executionRoot, storagePolicy }, retainedStore = null) {
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
      // The client's store retains only validated decoders. Its inventory read
      // still captures all physical bytes and authorities on every observation.
      const store = retainedStore ?? new ProcessRuntimeStore({ mainRoot: main, executionRoot: checkout, create: false, storagePolicy });
      return store.readConsistentInventory();
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("registry-failed", `Runtime inspection failed: ${cause.message}`, { cause });
    }
  }
  static inspectPreparedPublication({ mainRoot, executionRoot = mainRoot, storagePolicy = null } = {}) {
    const options = { mainRoot: path.resolve(mainRoot), executionRoot: path.resolve(executionRoot), storagePolicy, retainedClosed: true };
    const runtimePath = path.join(storagePolicy?.directory ?? path.join(options.mainRoot, ".sennel", "process-runtime"), digest(options.executionRoot));
    try { fs.lstatSync(runtimePath); }
    catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
    const store = new ProcessRuntimeStore({ ...options, create: false });
    const selection = RuntimePublicationMetadataSelection.inspect(store.transition);
    if (selection === null) return null;
    const prepared = new RuntimePreparedPublication(selection.value);
    prepared.validateData(store, selection);
    prepared.assertSelected(store, selection);
    return new ProcessExecutionPreparedPublication(preparedPublicationAuthority, { prepared, selection, options });
  }
  static recoverPreparedPublication(plan) {
    const selected = preparedPublicationPlans.get(plan);
    if (selected === undefined) throw new TypeError("Runtime publication recovery requires the exact inspected typed plan");
    const maintenance = new RepositoryMaintenanceLock({ mainRoot: selected.options.mainRoot });
    maintenance.acquire();
    try {
      const store = new ProcessRuntimeStore({ ...selected.options, create: false });
      const admission = new FileLock({ ...store.admissionOptions, waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0 }) });
      try { return admission.runExclusive(() => store.recoverPrepared(selected)); }
      catch (cause) {
        if (cause.lockStatus === "timeout" || cause.lockStatus === "reentrant" || cause.lockStatus === "busy") fail("busy", "Prepared runtime publication remains excluded by its operation owner", { cause });
        throw cause;
      }
    } finally { maintenance.release(); }
  }
  static readHistoricalInventory({ mainRoot, executionRoot = mainRoot, checkoutIdentity, runId, specId, storagePolicy = null } = {}) {
    try {
      const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false, historical: true, storagePolicy });
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
      assertClosedRuntimeCheckout(registry);
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
        synchronousManagedResult(result, "Recovery evidence consumer must be synchronous");
        return result;
      } finally {
        evidence?.invalidate();
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
        synchronousManagedResult(result, "Recovery evidence consumer must be synchronous");
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
