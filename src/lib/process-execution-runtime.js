import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtomicFile, fsyncDirectory } from "./atomic-file.js";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { ProcessLock } from "./process-lock.js";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { ManagedStopOperation, managedMonotonicNow } from "./managed-stop-operation.js";
import { ManagedStopOperationStore } from "./managed-stop-store.js";

import {
  ProcessExecutionControlFailure, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionStopReceipt, ProcessExecutionStartPermit,
  executionUuid as uuid, executionValueSnapshot as json,
  executionValueDigest as digest, executionProcessIdentity as identity,
} from "./process-execution-values.js";
export {
  ProcessExecutionControlFailure, ProcessExecutionBinding, ProcessExecutionCheckoutIdentity,
  ProcessExecutionStopReceipt, ProcessExecutionStartPermit,
} from "./process-execution-values.js";

function captureCheckoutAuthorities(main, checkout) {
  main.assertStable(); checkout.assertStable();
  return new ProcessExecutionCheckoutIdentity({ mainRoot: main.directory, executionRoot: checkout.directory,
    mainDevice: main.identity.dev, mainInode: main.identity.ino,
    checkoutDevice: checkout.identity.dev, checkoutInode: checkout.identity.ino });
}

/** Acquire checkout authority outside pure execution values and semantic consumers. */
export function captureProcessExecutionCheckoutIdentity({ mainRoot, executionRoot = mainRoot }) {
  return captureCheckoutAuthorities(new RealDirectoryAuthority(mainRoot), new RealDirectoryAuthority(executionRoot));
}

export const PROCESS_EXECUTION_SCOPE_ENV = "SENNEL_PROCESS_EXECUTION_SCOPE";
const scopes = new AsyncLocalStorage();
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const RUNTIME_RECORD_VERSION = 2;

function fail(reason, message, details) { throw new ProcessExecutionControlFailure(reason, message, details); }
function exact(value, restored) {
  if (!isDeepStrictEqual(value, json(restored))) throw new TypeError("Runtime record has missing or unknown fields");
  return restored;
}
function readJson(file, required = true) {
  const bytes = file.read();
  if (bytes === null) {
    if (required) fail("record-missing", `Required runtime record is missing: ${file.filePath}`);
    return null;
  }
  if (bytes.length > MAX_REGISTRY_BYTES) fail("record-corrupt", "Runtime record exceeds its size limit");
  return JSON.parse(bytes.toString("utf8"));
}

class PhysicalCallRecord {
  constructor({ callId, parentCallId, binding, invocation, capability, endpoint, status,
    launcherIdentity, pgid, members, permit, receipt, outcome, controlFailure, stopOperation }, { executionId } = {}) {
    this.callId = uuid(callId, "callId");
    this.parentCallId = parentCallId === null ? null : uuid(parentCallId, "parentCallId");
    this.binding = new ProcessExecutionBinding(binding);
    this.invocation = json(invocation);
    this.capability = uuid(capability, "call capability");
    if (endpoint !== `\0sennel-${this.callId}`) throw new TypeError("Call endpoint identity is invalid");
    this.endpoint = endpoint;
    if (!["intent", "registered", "running", "stopped"].includes(status)) throw new TypeError("Call status is invalid");
    this.status = status;
    this.launcherIdentity = launcherIdentity === null ? null : identity(launcherIdentity);
    this.pgid = pgid;
    this.members = members.map(identity);
    this.permit = permit === null ? null : new ProcessExecutionStartPermit(permit);
    this.receipt = receipt === null ? null : new ProcessExecutionStopReceipt(receipt);
    this.outcome = json(outcome);
    this.stopOperation = stopOperation === null ? null : ManagedStopOperation.fromStored(stopOperation);
    this.controlFailure = controlFailure === null ? null : ProcessExecutionControlFailure.fromStored(json(controlFailure), { executionId, callId: this.callId });
    if (this.launcherIdentity !== null && (!Number.isSafeInteger(pgid) || pgid < 1 || this.launcherIdentity.pid !== pgid)) {
      throw new TypeError("Launcher must lead its dedicated process group");
    }
    if (this.launcherIdentity === null && (pgid !== null || this.members.length !== 0 || this.permit !== null)) {
      throw new TypeError("Unregistered call has process ownership metadata");
    }
    if ((status === "stopped") !== (this.receipt !== null)) throw new TypeError("Call closure requires a stop receipt");
    if (status === "running" && this.permit === null) throw new TypeError("Running call has no start permit");
  }
  toJSON() { return { callId: this.callId, parentCallId: this.parentCallId, binding: this.binding.toJSON(),
    invocation: this.invocation, capability: this.capability, endpoint: this.endpoint, status: this.status,
    launcherIdentity: this.launcherIdentity, pgid: this.pgid, members: this.members,
    permit: this.permit, receipt: this.receipt, outcome: this.outcome, controlFailure: this.controlFailure, stopOperation: this.stopOperation }; }
}

class RootExecutionRecord {
  constructor({ executionId, ownerEpoch, coordinatorIdentity, runId, specId, binding,
    accepting, status, calls, closure }) {
    this.executionId = uuid(executionId, "executionId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Execution owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.coordinatorIdentity = identity(coordinatorIdentity);
    for (const value of [runId, specId]) if (value !== null && (typeof value !== "string" || value === "")) throw new TypeError("Runtime run/spec identity is invalid");
    this.runId = runId; this.specId = specId;
    this.binding = new ProcessExecutionBinding(binding);
    if (typeof accepting !== "boolean" || !["active", "stopping", "closed"].includes(status)) throw new TypeError("Execution registration state is invalid");
    this.accepting = accepting; this.status = status;
    this.calls = calls.map((call) => new PhysicalCallRecord(call, { executionId: this.executionId }));
    if (new Set(this.calls.map((call) => call.callId)).size !== this.calls.length) throw new TypeError("Duplicate physical call identity");
    this.closure = json(closure);
    if (status !== "active" && accepting) throw new TypeError("Stopping execution accepts new calls");
    if (status === "closed") {
      if (closure === null || this.calls.some((call) => call.receipt === null)) throw new TypeError("Closed execution lacks termination receipts");
      if (typeof closure.recovery !== "boolean" || !isDeepStrictEqual(closure, {
        executionId: this.executionId, ownerEpoch: this.ownerEpoch,
        receiptDigests: this.calls.map((call) => digest(call.receipt)), recovery: closure.recovery,
      })) throw new TypeError("Root closure disagrees with its exact physical call receipts");
    } else if (closure !== null) throw new TypeError("Unfinished execution has a closure receipt");
    for (const call of this.calls) {
      if (call.parentCallId !== null && !this.calls.some((parent) => parent.callId === call.parentCallId)) throw new TypeError("Nested call lineage is missing");
      const ancestors = new Set([call.callId]);
      let parentId = call.parentCallId;
      while (parentId !== null) {
        if (ancestors.has(parentId)) throw new TypeError("Nested call lineage is cyclic");
        ancestors.add(parentId);
        const parent = this.calls.find((entry) => entry.callId === parentId);
        if (!parent) throw new TypeError("Nested call lineage is missing");
        parentId = parent.parentCallId;
      }
      if (call.controlFailure !== null && (call.controlFailure.executionId !== this.executionId
        || call.controlFailure.callId !== call.callId)) throw new TypeError("Physical control failure belongs to another execution or call");
      if (call.permit && (call.permit.executionId !== this.executionId || call.permit.callId !== call.callId
        || call.permit.ownerEpoch !== this.ownerEpoch || call.permit.ownerToken !== this.coordinatorIdentity.ownerToken
        || call.permit.capability !== call.capability || call.permit.bindingDigest !== call.binding.digest)) throw new TypeError("Call start permit binding is invalid");
      if (call.receipt && (call.receipt.executionId !== this.executionId || call.receipt.callId !== call.callId
        || call.receipt.ownerEpoch !== this.ownerEpoch || !call.receipt.binding.matches(call.binding) || !isDeepStrictEqual(call.receipt.invocation, call.invocation)
        || !isDeepStrictEqual(json(call.receipt.launcherIdentity), json(call.launcherIdentity))
        || call.receipt.pgid !== call.pgid || !isDeepStrictEqual(json(call.receipt.members), json(call.members))
        || call.receipt.outcomeDigest !== digest(call.outcome))) throw new TypeError("Call stop receipt binding is invalid");
    }
    for (const call of this.calls) {
      const primaryCallId = call.controlFailure?.primaryCause.callId;
      if (primaryCallId == null) continue;
      let source = this.calls.find((entry) => entry.callId === primaryCallId);
      while (source && source.callId !== call.callId) source = this.calls.find((entry) => entry.callId === source.parentCallId);
      if (!source) throw new TypeError("Primary control failure is outside its physical call lineage");
    }
  }
  toJSON() { return { executionId: this.executionId, ownerEpoch: this.ownerEpoch, coordinatorIdentity: this.coordinatorIdentity,
    runId: this.runId, specId: this.specId, binding: this.binding.toJSON(), accepting: this.accepting,
    status: this.status, calls: this.calls, closure: this.closure }; }
}

class RuntimeRegistry {
  constructor({ version, checkout, ownerEpoch, slot, executions }) {
    if (version !== RUNTIME_RECORD_VERSION) throw new TypeError("Runtime registry version is unsupported");
    this.version = version;
    this.checkout = new ProcessExecutionCheckoutIdentity(checkout);
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) throw new TypeError("Runtime owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.slot = slot === null ? null : uuid(slot, "checkout slot");
    this.executions = executions.map((execution) => new RootExecutionRecord(execution));
    if (this.executions.some((execution) => execution.ownerEpoch > ownerEpoch)
      || new Set(this.executions.map((execution) => execution.ownerEpoch)).size !== this.executions.length) throw new TypeError("Runtime execution owner epochs disagree");
    if (new Set(this.executions.map((execution) => execution.executionId)).size !== this.executions.length) throw new TypeError("Duplicate root execution identity");
    for (const execution of this.executions) for (const call of execution.calls) {
      if (call.receipt && !call.receipt.checkoutIdentity.matches(this.checkout)) throw new TypeError("Process receipt belongs to another checkout authority");
    }
    const unfinished = this.executions.filter((execution) => execution.status !== "closed");
    if (unfinished.length > 1 || (this.slot === null ? unfinished.length !== 0 : unfinished.length !== 1 || unfinished[0].executionId !== this.slot)) {
      throw new TypeError("Checkout slot disagrees with unfinished execution inventory");
    }
  }
  toJSON() { return { version: this.version, checkout: this.checkout, ownerEpoch: this.ownerEpoch,
    slot: this.slot, executions: this.executions }; }
}

class ClosedProcessExecutionArchive {
  constructor({ version, checkout, execution }) {
    if (version !== RUNTIME_RECORD_VERSION) throw new TypeError("Process execution archive version is unsupported");
    this.version = version;
    this.checkout = new ProcessExecutionCheckoutIdentity(checkout);
    this.execution = new RootExecutionRecord(execution);
    if (this.execution.status !== "closed" || this.execution.calls.some((call) => !call.receipt.checkoutIdentity.matches(this.checkout))) {
      throw new TypeError("Process archive requires a closed execution and exact checkout receipts");
    }
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, checkout: this.checkout, execution: this.execution }; }
}

function encodeRuntimeRecord(record) {
  const content = JSON.stringify({ payload: json(record), digest: digest(record) });
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime metadata exceeds the durable record size limit before publication");
  return content;
}

class ProcessRuntimeStore {
  constructor({ mainRoot, executionRoot, processIdentitySource = new ProcessIdentitySource(), faultInjector = () => {}, create = true, retainedClosed = false }) {
    if (retainedClosed && create) throw new TypeError("Retained checkout inspection cannot create runtime authority");
    this.mainAuthority = new RealDirectoryAuthority(mainRoot);
    this.retainedExecutionRoot = null;
    if (retainedClosed) {
      try { fs.lstatSync(path.resolve(executionRoot)); }
      catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        this.retainedExecutionRoot = path.resolve(executionRoot);
      }
    }
    this.checkoutAuthority = this.retainedExecutionRoot === null ? new RealDirectoryAuthority(executionRoot) : null;
    this.checkout = this.checkoutAuthority === null ? null : captureCheckoutAuthorities(this.mainAuthority, this.checkoutAuthority);
    this.identitySource = processIdentitySource;
    this.faultInjector = faultInjector;
    const state = new RealDirectoryAuthority(path.join(this.mainAuthority.directory, ".sennel"), { create, parentAuthority: this.mainAuthority });
    if (create) state.ensure();
    const prefix = new RealDirectoryAuthority(path.join(state.directory, "process-runtime"), { create, parentAuthority: state });
    if (create) { prefix.ensure(); fs.chmodSync(prefix.directory, 0o700); }
    this.authority = new RealDirectoryAuthority(path.join(prefix.directory, digest(this.checkout?.executionRoot ?? this.retainedExecutionRoot)), { create, parentAuthority: prefix });
    if (create) { this.authority.ensure(); fs.chmodSync(this.authority.directory, 0o700); }
    this.callsAuthority = new RealDirectoryAuthority(path.join(this.authority.directory, "calls"), { create, parentAuthority: this.authority });
    if (create) this.callsAuthority.ensure();
    this.archivesAuthority = new RealDirectoryAuthority(path.join(this.authority.directory, "archives"), { create, parentAuthority: this.authority });
    if (create) this.archivesAuthority.ensure();
    if (create) { fsyncDirectory(state.directory); fsyncDirectory(prefix.directory); fsyncDirectory(this.authority.directory); }
    this.file = new AtomicFile(path.join(this.authority.directory, "registry.json"), { faultInjector, phaseNamespace: "runtime", commitGuard: () => this.assertStable() });
    this.anchor = new AtomicFile(path.join(this.authority.directory, "authority.json"));
    if (this.checkout === null) {
      const anchor = readJson(this.anchor);
      this.checkout = exact(anchor, new ProcessExecutionCheckoutIdentity(anchor));
      if (this.checkout.executionRoot !== this.retainedExecutionRoot
        || this.checkout.mainRoot !== this.mainAuthority.directory
        || this.checkout.mainDevice !== this.mainAuthority.identity.dev
        || this.checkout.mainInode !== this.mainAuthority.identity.ino) {
        fail("authority-mismatch", "Retained checkout anchor disagrees with its original namespace or actual main authority");
      }
    }
    this.transition = new AtomicFile(path.join(this.authority.directory, "transition.json"));
    const lockOptions = { directoryAuthority: this.authority, authority: json(this.checkout), processIdentitySource };
    this.ownerLock = new ProcessLock({ ...lockOptions, kind: "checkout-process-runtime", fileName: "owner.lock" });
    this.admissionOptions = { ...lockOptions, kind: "process-runtime-admission", fileName: "admission.lock" };
    this.admission = new FileLock(this.admissionOptions);
    this.tail = Promise.resolve();
  }
  assertStable() {
    this.mainAuthority.assertStable();
    if (this.checkoutAuthority !== null) this.checkoutAuthority.assertStable();
    else {
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
    fail(cause.durabilityUnknown ? "durability-uncertain" : "registry-failed", `Process runtime registry operation failed: ${cause.message}`, { cause });
  }
  async exclusive(body, { deadline = Infinity } = {}) {
    const previous = this.tail;
    let settle;
    this.tail = new Promise((resolve) => { settle = resolve; });
    let admitted = false;
    let timer;
    try {
      if (Number.isFinite(deadline)) {
        await Promise.race([previous, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new ProcessExecutionControlFailure("stop-unproven", "Runtime admission exceeded the remaining stop deadline")),
            Math.max(0, deadline - managedMonotonicNow()));
        })]);
      } else await previous;
      admitted = true;
      clearTimeout(timer);
      const admission = Number.isFinite(deadline) ? new FileLock({ ...this.admissionOptions,
        waitPolicy: new FileLockWaitPolicy({ timeoutMs: Math.floor(Math.max(0, deadline - managedMonotonicNow())) }) }) : this.admission;
      return await admission.runExclusiveAsync(() => {
        this.assertCommitted();
        return body();
      });
    } catch (cause) {
      this.#rejectRegistryFailure(cause);
    } finally {
      clearTimeout(timer);
      // A timed-out queued operation never runs, but must not let its successor
      // enter before the original holder has left the registry transaction.
      if (admitted) settle(); else previous.then(settle);
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
  read({ required = true } = {}) {
    try {
      this.assertCommitted();
      const snapshot = !required && this.file.read() === null ? null : this.#read();
      this.assertCommitted();
      return snapshot;
    } catch (cause) { this.#rejectRegistryFailure(cause); }
  }
  #read() {
    this.assertStable();
    if (!isDeepStrictEqual(readJson(this.anchor), json(this.checkout))) fail("authority-mismatch", "Persisted checkout identity does not match runtime authority");
    const envelope = readJson(this.file);
    if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime registry checksum is invalid");
    const registry = exact(envelope.payload, new RuntimeRegistry(envelope.payload));
    if (!isDeepStrictEqual(json(registry.checkout), json(this.checkout))) fail("authority-mismatch", "Runtime registry belongs to a different checkout");
    this.#assertInventory(registry);
    return registry;
  }
  readArchives() {
    this.archivesAuthority.assertStable();
    return fs.readdirSync(this.archivesAuthority.directory).map((name) => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) fail("record-corrupt", "Unexpected runtime archive inventory entry");
      const file = new AtomicFile(path.join(this.archivesAuthority.directory, name));
      const envelope = readJson(file);
      if (!envelope || Object.keys(envelope).length !== 2 || envelope.digest !== digest(envelope.payload)) fail("record-corrupt", "Runtime archive checksum is invalid");
      const archive = exact(envelope.payload, new ClosedProcessExecutionArchive(envelope.payload));
      if (!archive.checkout.matches(this.checkout) || name !== `${archive.execution.executionId}.json`) fail("authority-mismatch", "Runtime archive belongs to another checkout or execution");
      return archive.execution;
    }).sort((left, right) => left.ownerEpoch - right.ownerEpoch);
  }
  #assertInventory(registry) {
    const inventory = [...this.readArchives(), ...registry.executions].sort((left, right) => left.ownerEpoch - right.ownerEpoch);
    if (inventory.length !== registry.ownerEpoch || inventory.some((record, index) => record.ownerEpoch !== index + 1)
      || new Set(inventory.map((record) => record.executionId)).size !== inventory.length) fail("record-missing", "Runtime execution epoch inventory is missing or duplicated");
  }
  archiveClosed() {
    const registry = this.read();
    for (const execution of registry.executions.filter((record) => record.status === "closed")) {
      const archive = new ClosedProcessExecutionArchive({ version: RUNTIME_RECORD_VERSION, checkout: json(this.checkout), execution: json(execution) });
      const content = encodeRuntimeRecord(archive);
      const file = new AtomicFile(path.join(this.archivesAuthority.directory, `${execution.executionId}.json`), {
        faultInjector: this.faultInjector, phaseNamespace: "runtime-archive", commitGuard: () => this.assertStable(),
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
  save(registry) {
    const validated = new RuntimeRegistry(json(registry));
    const content = encodeRuntimeRecord(validated);
    this.transition.write(JSON.stringify({ executionId: validated.slot, ownerEpoch: validated.ownerEpoch }));
    this.file.write(content);
    const saved = this.#read();
    if (!isDeepStrictEqual(json(saved), json(validated))) fail("record-corrupt", "Runtime durable readback differs from the committed inventory");
    this.transition.remove();
    this.faultInjector({ phase: "after-runtime-readback", filePath: this.file.filePath });
    return saved;
  }
  callDirectory(callId) {
    const directory = new RealDirectoryAuthority(path.join(this.callsAuthority.directory, uuid(callId, "callId")), { create: true, parentAuthority: this.callsAuthority });
    directory.ensure(); fsyncDirectory(this.callsAuthority.directory);
    return directory.directory;
  }
}

export class ProcessExecutionCall {
  constructor(runtime, record) {
    this.runtime = runtime;
    this.executionId = runtime.executionId;
    this.callId = record.callId;
    this.ownerToken = runtime.ownerToken;
    this.ownerEpoch = runtime.ownerEpoch;
    this.capability = record.capability;
    this.endpoint = record.endpoint;
    this.binding = record.binding;
    this.invocation = record.invocation;
    this.directory = runtime.store.callDirectory(this.callId);
    this.outcomePath = path.join(this.directory, "outcome.json");
    this.helloPath = path.join(this.directory, "hello.json");
  }
  authorizeStart(details) { return this.runtime.authorizeStart(this, details); }
  executionEnvironment() {
    return { [PROCESS_EXECUTION_SCOPE_ENV]: JSON.stringify({ version: 1,
      mainRoot: this.runtime.mainRoot, executionRoot: this.runtime.executionRoot,
      runId: this.runtime.runId, specId: this.runtime.specId, executionId: this.executionId,
      callId: this.callId, ownerEpoch: this.ownerEpoch, ownerToken: this.ownerToken,
      capability: this.capability, bindingDigest: this.binding.digest }) };
  }
}

/** Keep the original checkout unavailable after its physical execution is sealed. */
export class ProcessExecutionOwnershipReservation {
  #ownerLock;
  #released = false;
  constructor({ ownerLock, executionId, ownerEpoch, checkoutIdentity }) {
    if (!(ownerLock instanceof ProcessLock) || ownerLock.processIdentity === null || ownerLock.lockIdentity === null
      || !(checkoutIdentity instanceof ProcessExecutionCheckoutIdentity) || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
      throw new TypeError("Checkout handoff reservation requires its acquired owner lock and sealed execution identity");
    }
    this.#ownerLock = ownerLock;
    this.executionId = uuid(executionId, "reserved executionId");
    this.ownerEpoch = ownerEpoch;
    this.checkoutIdentity = checkoutIdentity;
    Object.freeze(this);
  }
  get released() { return this.#released; }
  release() {
    if (this.#released) return;
    try { this.#ownerLock.release(); this.#released = true; }
    catch (cause) {
      fail("reservation-release-failed", `Original checkout reservation could not be released: ${cause.message}`,
        { cause, executionId: this.executionId });
    }
  }
}

/** Checkout admission and durable physical ownership; no semantic state decisions live here. */
export class ProcessExecutionRuntime {
  constructor(store, record, { borrowed = false, parentCallId = null, binding = record.binding, root = null } = {}) {
    this.store = store;
    this.mainRoot = store.checkout.mainRoot;
    this.executionRoot = store.checkout.executionRoot;
    this.executionId = record.executionId;
    this.ownerEpoch = record.ownerEpoch;
    this.ownerToken = record.coordinatorIdentity.ownerToken;
    this.runId = record.runId; this.specId = record.specId;
    this.binding = new ProcessExecutionBinding(binding);
    this.borrowed = borrowed;
    this.parentCallId = parentCallId;
    this.root = root ?? this;
    this.closed = false;
  }
  static current() { return scopes.getStore() ?? null; }
  static inspect({ mainRoot, executionRoot = mainRoot } = {}) {
    try {
      const main = path.resolve(mainRoot); const checkout = path.resolve(executionRoot);
      let currentDirectory = main;
      new RealDirectoryAuthority(main).assertStable();
      new RealDirectoryAuthority(checkout).assertStable();
      for (const part of [".sennel", "process-runtime", digest(checkout)]) {
        currentDirectory = path.join(currentDirectory, part);
        try { fs.lstatSync(currentDirectory); }
        catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
        new RealDirectoryAuthority(currentDirectory).assertStable();
      }
      const store = new ProcessRuntimeStore({ mainRoot: main, executionRoot: checkout, create: false });
      const registry = store.read();
      return json({ ...registry.toJSON(), executions: [...store.readArchives(), ...registry.executions] });
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("registry-failed", `Runtime inspection failed: ${cause.message}`, { cause });
    }
  }
  /** Read sealed physical ownership after an externally authorized checkout removal. */
  static inspectRetainedClosedCheckout({ mainRoot, executionRoot, runId, specId } = {}) {
    try {
      for (const value of [runId, specId]) {
        if (typeof value !== "string" || value === "") throw new TypeError("Retained checkout inspection requires exact run and spec identity");
      }
      const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false, retainedClosed: true });
      const registry = store.read();
      const executions = [...store.readArchives(), ...registry.executions].sort((left, right) => left.ownerEpoch - right.ownerEpoch);
      if (registry.slot !== null || executions.some((record) => record.status !== "closed")) {
        fail("stop-unconfirmed", "Retained checkout requires a closed inventory and every durable process stop receipt", { executionId: registry.slot });
      }
      const latest = executions.at(-1);
      if (!latest) fail("record-missing", "Retained checkout has no sealed execution history");
      if (latest.runId !== runId || latest.specId !== specId) {
        fail("binding-mismatch", "Retained checkout closure belongs to another run or spec", { executionId: latest.executionId });
      }
      const owner = store.ownerLock.inspect();
      if (owner !== null) {
        const assessment = store.identitySource.assess(owner.owner.processIdentity);
        if (assessment.status === "live") fail("busy", "Original checkout ownership reservation remains live", { executionId: latest.executionId });
        if (assessment.status !== "stale") fail("identity-unknown", "Original checkout owner identity cannot be observed");
      }
      store.assertCommitted();
      return json({ ...registry.toJSON(), executions });
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
        && (runId === null || record.runId === runId) && (specId === null || record.specId === specId)
        && record.accepting && new ProcessIdentitySource().assess(identity(record.coordinatorIdentity)).status === "live") {
        current.#assertAccepting(new RootExecutionRecord(record));
        if (record.calls.some((call) => call.receipt === null)) fail("stop-unconfirmed", "Canonical recovery requires durable termination receipts for every physical call", { executionId: record.executionId });
        return;
      }
    }
    if (inventory.slot !== null) fail("busy", "Runtime termination must be proved before canonical recovery", { executionId: inventory.slot });
    const store = new ProcessRuntimeStore({ mainRoot, executionRoot, create: false });
    const owner = store.ownerLock.inspect();
    if (owner !== null) {
      const assessment = store.identitySource.assess(owner.owner.processIdentity);
      if (assessment.status === "live") fail("busy", "Checkout coordinator admission is in progress");
      if (assessment.status !== "stale") fail("identity-unknown", "Checkout coordinator identity cannot be observed");
    }
  }
  inspect() { return ProcessExecutionRuntime.inspect({ mainRoot: this.mainRoot, executionRoot: this.executionRoot }); }
  stopReceipts(binding = null) {
    const inventory = this.inspect();
    if (inventory === null) fail("record-missing", "Runtime inventory disappeared before stop receipt readback");
    const expected = binding === null ? null : new ProcessExecutionBinding(binding);
    return inventory.executions.filter((execution) => execution.status === "closed")
      .flatMap((execution) => execution.calls.map((call) => new ProcessExecutionStopReceipt(call.receipt)))
      .filter((receipt) => expected === null || receipt.binding.matches(expected));
  }
  static async acquire({ mainRoot, executionRoot = mainRoot, runId = null, specId = null,
    binding = null, environment = process.env, processIdentitySource, faultInjector } = {}) {
    let store;
    try {
      store = new ProcessRuntimeStore({ mainRoot, executionRoot, processIdentitySource, faultInjector, create: !environment[PROCESS_EXECUTION_SCOPE_ENV] });
      if (environment[PROCESS_EXECUTION_SCOPE_ENV]) {
        return await this.#borrow(store, JSON.parse(environment[PROCESS_EXECUTION_SCOPE_ENV]), { runId, specId, binding });
      }
      store.ownerLock.acquire();
    } catch (cause) {
      const failure = cause instanceof ProcessExecutionControlFailure ? cause
        : new ProcessExecutionControlFailure(cause.lockStatus === "live" ? "busy" : "admission-failed", `Checkout process admission failed: ${cause.message}`, { cause });
      if (environment[PROCESS_EXECUTION_SCOPE_ENV]) await this.reportDelegatedControlFailure({ environment, error: failure });
      throw failure;
    }
    let recoveryDeadline = Infinity;
    let recoveryFailureContext = null;
    let preparingRecovery = false;
    const recoveryStartedAt = managedMonotonicNow();
    try {
      // An existing stop also bounds recovery's registry admission, before the
      // orphan can be revalidated and stopped under that admission authority.
      const snapshot = store.read({ required: false });
      if (snapshot !== null) {
        for (const execution of snapshot.executions.filter((entry) => entry.status !== "closed")) {
          this.#assertRecoveryCandidate(store, execution, { runId, specId });
          preparingRecovery = true;
          const runtime = new this(store, execution);
          for (const call of execution.calls.filter((entry) => entry.receipt === null || entry.stopOperation !== null)) {
            let operation = call.stopOperation ?? ManagedStopOperation.begin({ now: recoveryStartedAt });
            recoveryFailureContext = { runtime, call };
            recoveryDeadline = Math.min(recoveryDeadline, operation.deadline);
            operation = runtime.#readStopOperation(execution, call, operation);
            recoveryDeadline = Math.min(recoveryDeadline, operation.deadline);
          }
        }
      }
      await store.exclusive(() => { store.initialize(); store.archiveClosed(); }, { deadline: recoveryDeadline });
      const old = await store.exclusive(() => {
        preparingRecovery = false;
        const registry = store.read();
        for (const execution of registry.executions.filter((entry) => entry.status !== "closed")) {
          this.#assertRecoveryCandidate(store, execution, { runId, specId });
        }
        return registry;
      }, { deadline: recoveryDeadline });
      preparingRecovery = false;
      for (const execution of old.executions.filter((entry) => entry.status !== "closed")) {
        const orphan = new this(store, execution);
        recoveryDeadline = Math.min(recoveryDeadline, await orphan.#stopRoot(true, recoveryStartedAt));
      }
      return await store.exclusive(() => {
        const registry = store.read();
        if (registry.slot !== null) fail("busy", "Checkout runtime slot is occupied");
        const record = new RootExecutionRecord({ executionId: crypto.randomUUID(), ownerEpoch: registry.ownerEpoch + 1,
          coordinatorIdentity: store.ownerLock.processIdentity, runId, specId, binding: json(new ProcessExecutionBinding(binding)),
          accepting: true, status: "active", calls: [], closure: null });
        registry.ownerEpoch = record.ownerEpoch; registry.slot = record.executionId; registry.executions.push(record);
        store.save(registry);
        return new this(store, record);
      }, { deadline: recoveryDeadline });
    } catch (cause) {
      if (preparingRecovery && recoveryFailureContext !== null && (cause.executionId == null || cause.callId == null)) {
        const { runtime, call } = recoveryFailureContext;
        cause = await runtime.#recordStopFailure(call.callId, cause, call.controlFailure, recoveryDeadline);
      }
      try { store.ownerLock.release(); } catch (cleanup) {
        fail("admission-failed", "Runtime admission and owner lock cleanup failed", { cause: new AggregateError([cause, cleanup], "Runtime acquisition failed", { cause }) });
      }
      throw cause;
    }
  }
  static #assertRecoveryCandidate(store, execution, { runId, specId }) {
    const assessment = store.identitySource.assess(execution.coordinatorIdentity);
    if (assessment.status === "live") fail("busy", "Checkout execution coordinator is still alive", { executionId: execution.executionId });
    if (assessment.status !== "stale") fail("identity-unknown", "Checkout execution coordinator cannot be identified", { executionId: execution.executionId });
    if ((runId !== null && execution.runId !== null && runId !== execution.runId)
      || (specId !== null && execution.specId !== null && specId !== execution.specId)) {
      fail("binding-mismatch", "Orphan execution belongs to another run or specification", { executionId: execution.executionId });
    }
  }
  static async #borrow(store, grant, { runId, specId, binding }) {
    return store.exclusive(() => {
      const registry = store.read();
      const { record, parent, processIdentity } = this.#authenticateDelegation(store, registry, grant, { runId, specId, binding });
      if (!parent.members.some((member) => member.sameBirth(processIdentity))) parent.members.push(processIdentity);
      store.save(registry);
      return new this(store, record, { borrowed: true, parentCallId: parent.callId, binding: binding ?? parent.binding });
    });
  }
  static #authenticateDelegation(store, registry, grant, { runId, specId, binding }) {
    const record = registry.executions.find((entry) => entry.executionId === grant.executionId);
    if (grant.version !== 1 || grant.mainRoot !== store.checkout.mainRoot || grant.executionRoot !== store.checkout.executionRoot
      || grant.runId !== runId || grant.specId !== specId || record?.runId !== runId || record?.specId !== specId
      || record?.ownerEpoch !== grant.ownerEpoch || record?.coordinatorIdentity.ownerToken !== grant.ownerToken
      || registry.slot !== grant.executionId || !record?.accepting
      || store.identitySource.assess(record.coordinatorIdentity).status !== "live") fail("delegation-refused", "Nested execution root ownership is invalid");
    const parent = record.calls.find((call) => call.callId === grant.callId);
    const processIdentity = store.identitySource.createOwner(crypto.randomUUID());
    const observation = store.identitySource.observe(processIdentity);
    if (!parent || parent.status !== "running" || parent.capability !== grant.capability || parent.binding.digest !== grant.bindingDigest
      || observation.status !== "live" || observation.terminated || parent.pgid !== observation.stat?.pgrp
      || store.identitySource.assess(parent.launcherIdentity).status !== "live") fail("delegation-refused", "Nested execution is not a member of its authorized physical call");
    if (binding !== null && !new ProcessExecutionBinding(binding).matches(parent.binding)) fail("delegation-refused", "Nested execution contract differs from the delegation");
    return { record, parent, processIdentity };
  }

  static async reportDelegatedControlFailure({ environment = process.env, error } = {}) {
    if (!(error instanceof ProcessExecutionControlFailure)) throw new TypeError("Delegated failure reporting requires a typed control failure");
    let grant, store;
    try {
      grant = JSON.parse(environment[PROCESS_EXECUTION_SCOPE_ENV]);
      store = new ProcessRuntimeStore({ mainRoot: grant.mainRoot, executionRoot: grant.executionRoot, create: false });
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("delegation-refused", "Delegated control failure has no readable original authority", { cause });
    }
    return store.exclusive(() => {
      const registry = store.read();
      const { record, parent } = this.#authenticateDelegation(store, registry, grant, { runId: grant.runId, specId: grant.specId, binding: null });
      this.#saveControlFailure(record, parent, error);
      store.save(registry);
      return parent.controlFailure;
    });
  }
  enter(callback) { this.#assertOpen(); return scopes.run(this, callback); }
  async withBinding(binding, callback) {
    this.#assertOpen();
    const snapshot = new ProcessExecutionBinding(binding);
    if (this.borrowed && !snapshot.matches(this.binding)) fail("delegation-refused", "Nested scope cannot replace its delegated execution contract");
    const freshRunId = snapshot.value?.runId ?? this.runId;
    const freshSpecId = snapshot.value?.specId ?? this.specId;
    await this.store.exclusive(() => {
      const registry = this.store.read(); const owner = this.#record(registry);
      this.#assertAccepting(owner);
      if ((owner.runId !== null && freshRunId !== owner.runId) || (owner.specId !== null && freshSpecId !== owner.specId)) {
        fail("binding-mismatch", "Fresh execution binding belongs to another run or specification");
      }
      owner.runId = freshRunId; owner.specId = freshSpecId;
      this.store.save(registry);
      this.runId = freshRunId; this.specId = freshSpecId;
      this.root.runId = freshRunId; this.root.specId = freshSpecId;
    });
    const record = { executionId: this.executionId, ownerEpoch: this.ownerEpoch,
      coordinatorIdentity: { ownerToken: this.ownerToken }, runId: freshRunId, specId: freshSpecId, binding };
    const scope = new ProcessExecutionRuntime(this.store, record, { borrowed: this.borrowed, parentCallId: this.parentCallId, binding, root: this.root });
    return scopes.run(scope, callback);
  }
  async reserveCall({ binding = this.binding, invocation = null, ...options } = {}) {
    this.#assertOpen();
    const requestedBinding = new ProcessExecutionBinding(binding);
    if (this.borrowed && !requestedBinding.matches(this.binding)) fail("delegation-refused", "Nested physical call cannot replace its delegated execution contract");
    return this.store.exclusive(() => {
      const registry = this.store.read(); const root = this.#record(registry);
      this.#assertAccepting(root);
      const callId = crypto.randomUUID();
      const call = new PhysicalCallRecord({ callId, parentCallId: this.parentCallId,
        binding: json(requestedBinding), invocation: json(invocation ?? options),
        capability: crypto.randomUUID(), endpoint: `\0sennel-${callId}`, status: "intent",
        launcherIdentity: null, pgid: null, members: [], permit: null, receipt: null, outcome: null, controlFailure: null, stopOperation: null });
      root.calls.push(call); this.store.save(registry);
      return new ProcessExecutionCall(this, call);
    });
  }
  async authorizeStart(call, { launcherIdentity, endpoint = call.endpoint, pgid, members = [] }) {
    this.#assertCall(call);
    return this.store.exclusive(() => {
      let registry = this.store.read(); let root = this.#record(registry);
      this.#assertAccepting(root);
      const record = this.#call(root, call);
      if (record.status !== "intent") fail("start-refused", "Physical call already registered", { callId: call.callId });
      this.#registerLauncher(record, { launcherIdentity, endpoint, pgid, members });
      this.store.save(registry);
      // Readback between group registration and permit publication is intentional.
      registry = this.store.read(); root = this.#record(registry);
      this.#assertAccepting(root);
      const registered = this.#call(root, call);
      const permit = new ProcessExecutionStartPermit({ executionId: this.executionId, callId: call.callId,
        ownerEpoch: this.ownerEpoch, ownerToken: this.ownerToken, capability: registered.capability,
        bindingDigest: registered.binding.digest });
      registered.permit = permit; registered.status = "running";
      this.store.save(registry);
      return permit;
    });
  }
  async finishCall(call, { outcome = null, stopEvidence, members = null, notStarted = false } = {}) {
    this.#assertCall(call);
    const transport = await import("./managed-process.js");
    const snapshot = this.#call(this.#record(this.store.read()), call);
    return this.store.exclusive(async () => {
      const registry = this.store.read(); const root = this.#record(registry); const record = this.#call(root, call);
      this.#assertAccepting(root);
      if (record.receipt) { this.#assertSubtreeSettled(root, record); return record.receipt; }
      if (members !== null) this.#mergeMembers(record, members);
      let proof;
      if (notStarted && record.launcherIdentity === null && record.status === "intent") {
        proof = AgentProcessStopEvidence.confirmed();
      } else {
        proof = this.#proof(await transport.verifyManagedProcessStopped(this.#transportRecord(root, record)));
        if (!proof.confirmed || !AgentProcessStopEvidence.from(stopEvidence).confirmed) fail("stop-unconfirmed", "Physical call termination is unconfirmed", { callId: call.callId });
      }
      this.#settle(root, record, { outcome, stopEvidence: proof });
      this.store.save(registry);
      this.#assertSubtreeSettled(root, record);
      return record.receipt;
    }, { deadline: snapshot.stopOperation?.deadline });
  }
  async recordCallControlFailure(call, error) {
    this.#assertCall(call);
    if (!(error instanceof ProcessExecutionControlFailure)) throw new TypeError("Physical failure recording requires a typed control failure");
    const snapshot = this.#call(this.#record(this.store.read()), call);
    return this.store.exclusive(() => {
      const registry = this.store.read(); const root = this.#record(registry);
      this.#assertAccepting(root);
      const record = this.#call(root, call);
      ProcessExecutionRuntime.#saveControlFailure(root, record, error);
      this.store.save(registry);
      return record.controlFailure;
    }, { deadline: snapshot.stopOperation?.deadline });
  }
  async beginCallStop(call, options = {}) {
    this.#assertCall(call);
    const controlFailure = options.controlFailure ?? null;
    if (controlFailure !== null && !(controlFailure instanceof ProcessExecutionControlFailure)) throw new TypeError("Stop preparation requires a typed initial control failure");
    const protocol = await import("./managed-process-protocol.js");
    const rootSnapshot = this.#record(this.store.read());
    const snapshot = this.#call(rootSnapshot, call);
    let operation = snapshot.stopOperation ?? (options instanceof ManagedStopOperation ? options : ManagedStopOperation.begin(options));
    try {
      operation = this.#readStopOperation(rootSnapshot, snapshot, operation);
      return await this.store.exclusive(() => {
        const registry = this.store.read(); const root = this.#record(registry); const record = this.#call(root, call);
        if (controlFailure !== null) ProcessExecutionRuntime.#saveControlFailure(root, record, controlFailure);
        operation = this.#beginStop(root, record, operation);
        this.store.save(registry);
        const outcome = protocol.readManagedRecord(call.outcomePath, { deadline: operation.deadline });
        if (outcome !== null) this.#assertManagedRecord(root, record, outcome);
        return operation;
      }, { deadline: operation.deadline });
    } catch (cause) {
      throw await this.#recordStopFailure(call.callId, cause, snapshot.controlFailure ?? controlFailure, operation.deadline);
    }
  }
  #beginStop(root, call, proposed) {
    const chosen = new ManagedStopOperationStore(this.#transportRecord(root, call)).claim(call.stopOperation ?? proposed);
    if (call.stopOperation !== null && !call.stopOperation.matches(chosen)) fail("request-mismatch", "Shared stop operation differs from the durable physical call stop");
    call.stopOperation = chosen;
    return call.stopOperation;
  }
  #readStopOperation(root, call, proposed) {
    return call.stopOperation ?? new ManagedStopOperationStore(this.#transportRecord(root, call)).read({ deadline: proposed.deadline }) ?? proposed;
  }
  async #recordStopFailure(callId, cause, priorFailure, deadline) {
    let failure = priorFailure ?? (cause instanceof ProcessExecutionControlFailure ? cause
      : new ProcessExecutionControlFailure("control-failed", "Managed stop failed before durable settlement", { cause }));
    failure = failure.withContext({ executionId: this.executionId, callId });
    try {
      return await this.store.exclusive(() => {
        const registry = this.store.read(); const root = this.#record(registry);
        const call = root.calls.find((entry) => entry.callId === callId);
        ProcessExecutionRuntime.#saveControlFailure(root, call, failure);
        this.store.save(registry);
        const saved = call.controlFailure.withContext({ executionId: this.executionId, callId });
        saved.cause = new AggregateError([call.controlFailure, cause], "Recorded process failure and subsequent stop refusal");
        return saved;
      }, { deadline });
    } catch (reportingFailure) {
      failure.cause = new AggregateError([failure.cause, cause, reportingFailure].filter(Boolean), "Managed stop and failure persistence could not complete");
      return failure;
    }
  }
  static #saveControlFailure(root, call, error) {
    if (call.controlFailure === null) call.controlFailure = error.withContext({ executionId: root.executionId, callId: call.callId });
  }
  #assertSubtreeSettled(root, call) {
    const pending = [call]; const subtree = [];
    while (pending.length > 0) {
      const current = pending.shift(); subtree.push(current);
      pending.push(...root.calls.filter((entry) => entry.parentCallId === current.callId));
    }
    const unfinished = subtree.find((entry) => entry.receipt === null);
    if (unfinished) fail("stop-unconfirmed", "Physical call lineage contains a descendant without a durable stop receipt",
      { executionId: root.executionId, callId: unfinished.callId, cause: unfinished.controlFailure ?? subtree.find((entry) => entry.controlFailure !== null)?.controlFailure });
    const failed = subtree.find((entry) => entry.controlFailure !== null);
    if (failed) throw failed.controlFailure;
  }
  async sealForCheckoutHandoff() {
    if (this.borrowed) fail("delegation-refused", "A borrowed execution cannot hand off checkout ownership");
    if (this.root !== this) return this.root.sealForCheckoutHandoff();
    this.#assertOpen();
    try {
      await this.#stopRoot(false);
      this.closed = true;
      return new ProcessExecutionOwnershipReservation({ ownerLock: this.store.ownerLock,
        executionId: this.executionId, ownerEpoch: this.ownerEpoch, checkoutIdentity: this.store.checkout });
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("handoff-seal-failed", `Checkout physical execution could not be sealed: ${cause.message}`,
        { cause, executionId: this.executionId });
    }
  }
  async close() {
    if (this.closed) return;
    if (this.borrowed) { this.closed = true; return; }
    try {
      await this.#stopRoot(false);
      this.store.ownerLock.release();
      this.closed = true;
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) throw cause;
      fail("closure-failed", `Runtime closure failed: ${cause.message}`, { cause, executionId: this.executionId });
    }
  }
  async #stopRoot(recovery, startedAt = managedMonotonicNow()) {
    // This fresh canonical snapshot only bounds admission and retains evidence if
    // admission itself fails. Every decision is revalidated under the store lock.
    const rootSnapshot = this.#record(this.store.read());
    const snapshot = rootSnapshot.calls.filter((call) => call.receipt === null);
    const operations = new Map(snapshot.map((call) => [call.callId, call.stopOperation ?? ManagedStopOperation.begin({ now: startedAt })]));
    let deadline = Math.min(...rootSnapshot.calls.map((call) => call.stopOperation?.deadline ?? Infinity),
      ...[...operations.values()].map((operation) => operation.deadline));
    let inventory;
    let refusedCall = snapshot[0];
    try {
      for (const call of snapshot) {
        refusedCall = call;
        const operation = this.#readStopOperation(rootSnapshot, call, operations.get(call.callId));
        operations.set(call.callId, operation);
        deadline = Math.min(deadline, operation.deadline);
      }
      refusedCall = snapshot.find((call) => operations.get(call.callId).deadline === deadline) ?? refusedCall;
      inventory = await this.store.exclusive(() => {
        const registry = this.store.read(); const root = this.#record(registry);
        root.accepting = false; root.status = "stopping";
        this.store.save(registry);
        return root.calls.filter((call) => call.receipt === null).map((call) => call.callId);
      }, { deadline });
    } catch (cause) {
      const call = refusedCall;
      if (!call) throw cause;
      throw await this.#recordStopFailure(call.callId, cause, call.controlFailure, deadline);
    }
    const transport = inventory.length === 0 ? null : await import("./managed-process.js");
    const protocol = inventory.length === 0 ? null : await import("./managed-process-protocol.js");
    for (const callId of inventory) {
      const priorFailure = snapshot.find((call) => call.callId === callId)?.controlFailure ?? null;
      let operation = operations.get(callId) ?? ManagedStopOperation.begin({ now: startedAt });
      try {
        const record = await this.store.exclusive(() => {
          const registry = this.store.read(); const root = this.#record(registry); const call = root.calls.find((entry) => entry.callId === callId);
          operation = this.#beginStop(root, call, operation);
          deadline = Math.min(deadline, operation.deadline);
          // Preserve the first stop before any contended launcher-record read.
          this.store.save(registry);
          const directory = this.store.callDirectory(callId);
          if (call.launcherIdentity === null) {
            const hello = protocol.readManagedRecord(path.join(directory, "hello.json"), { deadline: operation.deadline });
            if (hello === null) fail("stop-unconfirmed", "Launch intent has no authenticated launcher identity", { executionId: this.executionId, callId });
            if (hello.executionId !== this.executionId || hello.callId !== callId || hello.ownerToken !== this.ownerToken || hello.capability !== call.capability) fail("binding-mismatch", "Launcher greeting does not match the durable launch intent");
            this.#registerLauncher(call, hello, recovery);
          }
          const outcome = protocol.readManagedRecord(path.join(directory, "outcome.json"), { deadline: operation.deadline });
          if (outcome !== null) {
            this.#assertManagedRecord(root, call, outcome);
            if (outcome.members) this.#mergeMembers(call, outcome.members);
          }
          this.store.save(registry);
          return this.#transportRecord(root, call);
        }, { deadline: operation.deadline });
        let response;
        const observed = this.#proof(await transport.verifyManagedProcessStopped(record));
        if (observed.confirmed) {
          response = transport.readManagedSettlement(record, { deadline: operation.deadline });
          if (response === null) fail("stop-unconfirmed", "Stopped launcher has no validated durable settlement", { executionId: this.executionId, callId });
        } else {
          // Only the birth-authenticated live launcher may signal its own group.
          if (this.store.identitySource.assess(record.launcherIdentity).status !== "live") fail("stop-unconfirmed", "Orphan group has no authenticated live launcher", { executionId: this.executionId, callId });
          response = await transport.requestManagedLauncherStop(record, { operation });
        }
        await this.store.exclusive(async () => {
          const registry = this.store.read(); const root = this.#record(registry); const call = root.calls.find((entry) => entry.callId === callId);
          if (response.members) this.#mergeMembers(call, response.members);
          const proof = this.#proof(await transport.verifyManagedProcessStopped(this.#transportRecord(root, call)));
          if (!proof.confirmed || !AgentProcessStopEvidence.from(response.stopEvidence).confirmed) fail("stop-unconfirmed", "Launcher response lacks independent termination proof", { executionId: this.executionId, callId });
          this.#settle(root, call, { outcome: response.outcome, stopEvidence: proof });
          this.store.save(registry);
        }, { deadline: operation.deadline });
      } catch (cause) {
        throw await this.#recordStopFailure(callId, cause, priorFailure, operation.deadline);
      }
    }
    try {
      await this.store.exclusive(() => {
        const registry = this.store.read(); const root = this.#record(registry);
        if (root.calls.some((call) => call.receipt === null)) fail("stop-unconfirmed", "Runtime contains physical calls without durable termination receipts");
        root.status = "closed";
        root.closure = { executionId: root.executionId, ownerEpoch: root.ownerEpoch,
          receiptDigests: root.calls.map((call) => digest(call.receipt)), recovery };
        registry.slot = null;
        this.store.save(registry);
        this.store.archiveClosed();
      }, { deadline });
    } catch (cause) {
      const call = rootSnapshot.calls.find((entry) => entry.controlFailure !== null) ?? rootSnapshot.calls[0];
      if (!call) throw cause;
      throw await this.#recordStopFailure(call.callId, cause, call.controlFailure, deadline);
    }
    return deadline;
  }
  #registerLauncher(record, { launcherIdentity, endpoint, pgid, members = [] }, recovery = false) {
    const launcher = identity(launcherIdentity);
    const assessment = this.store.identitySource.observe(launcher);
    if (endpoint !== record.endpoint || launcher.pid !== pgid || assessment.status === "unknown" || (!recovery && assessment.status !== "live")) fail("launcher-refused", "Launcher birth or dedicated group ownership is invalid");
    if (assessment.status === "live" && (assessment.stat === null || assessment.stat.pgrp !== pgid || (!recovery && assessment.terminated))) fail("launcher-refused", "Launcher is outside its declared executable process group");
    record.launcherIdentity = launcher; record.pgid = pgid; record.status = "registered";
    this.#mergeMembers(record, [launcher, ...members]);
  }
  #proof(stopped) { return stopped ? AgentProcessStopEvidence.confirmed() : AgentProcessStopEvidence.uncertain("managed-group-or-member-still-alive"); }
  #assertManagedRecord(root, call, record) {
    if (record.executionId !== root.executionId || record.callId !== call.callId
      || record.ownerToken !== root.coordinatorIdentity.ownerToken || record.capability !== call.capability
      || record.pgid !== call.pgid || !identity(record.launcherIdentity).sameBirth(call.launcherIdentity)) {
      fail("binding-mismatch", "Durable launcher outcome belongs to another physical call");
    }
  }
  #mergeMembers(record, members) {
    for (const value of members) {
      const member = identity(value);
      if (!record.members.some((existing) => existing.sameBirth(member))) record.members.push(member);
    }
  }
  #settle(root, call, { outcome, stopEvidence }) {
    call.outcome = json(outcome); call.status = "stopped";
    call.receipt = new ProcessExecutionStopReceipt({ executionId: root.executionId, callId: call.callId,
      ownerEpoch: root.ownerEpoch, checkoutIdentity: this.store.checkout, binding: call.binding, invocation: call.invocation, launcherIdentity: call.launcherIdentity,
      pgid: call.pgid, members: call.members, stopEvidence, outcomeDigest: digest(call.outcome) });
    if (call.controlFailure?.communication !== null && call.controlFailure?.communication !== undefined) {
      call.controlFailure = call.controlFailure.withStopConfirmation("confirmed");
    }
  }
  #transportRecord(root, call) {
    const directory = this.store.callDirectory(call.callId);
    return { executionId: root.executionId, callId: call.callId, ownerToken: root.coordinatorIdentity.ownerToken,
      ownerEpoch: root.ownerEpoch, capability: call.capability, endpoint: call.endpoint,
      launcherIdentity: call.launcherIdentity, pgid: call.pgid, members: call.members,
      stopOperation: call.stopOperation,
      directory, helloPath: path.join(directory, "hello.json"), outcomePath: path.join(directory, "outcome.json") };
  }
  #record(registry) {
    const root = registry.executions.find((entry) => entry.executionId === this.executionId);
    if (!root || registry.slot !== this.executionId || root.ownerEpoch !== this.ownerEpoch || root.coordinatorIdentity.ownerToken !== this.ownerToken) fail("ownership-changed", "Runtime owner epoch or checkout slot changed", { executionId: this.executionId });
    return root;
  }
  #call(root, call) {
    const found = root.calls.find((entry) => entry.callId === call.callId);
    if (!found || !found.binding.matches(call.binding) || found.capability !== call.capability) fail("binding-mismatch", "Physical call binding changed");
    return found;
  }
  #assertAccepting(root) {
    if (!root.accepting || root.status !== "active") fail("registration-closed", "Root execution no longer accepts physical calls or start permits");
    if (this.borrowed) {
      if (this.store.identitySource.assess(root.coordinatorIdentity).status !== "live") fail("delegation-refused", "Nested execution coordinator is no longer alive");
      const parent = root.calls.find((call) => call.callId === this.parentCallId);
      const requester = this.store.identitySource.createOwner(crypto.randomUUID());
      const observation = this.store.identitySource.observe(requester);
      if (!parent || parent.status !== "running" || observation.status !== "live" || observation.terminated || parent.pgid !== observation.stat?.pgrp
        || this.store.identitySource.assess(parent.launcherIdentity).status !== "live") fail("delegation-refused", "Nested scope lost its registered parent group");
    }
  }
  #assertOpen() { if (this.closed || this.root.closed) fail("registration-closed", "Runtime scope is closed"); }
  #assertCall(call) {
    this.#assertOpen();
    if (!(call instanceof ProcessExecutionCall) || call.executionId !== this.executionId || call.ownerEpoch !== this.ownerEpoch || call.ownerToken !== this.ownerToken) fail("binding-mismatch", "Physical call belongs to another runtime scope");
  }
}
