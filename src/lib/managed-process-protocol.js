import net from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { FileLock, FileLockAcquisition, FileLockWaitPolicy } from "./file-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { AtomicFile } from "./atomic-file.js";
import { sameFileIdentity } from "./file-identity.js";
import { RegularFileLinkCountError } from "./regular-file-snapshot.js";
import { readManagedBinarySnapshot, decodeManagedRecord } from "./managed-process-record.js";
import { ProcessExecutionControlFailure,
  ProcessExecutionCommunicationAttempt, ProcessExecutionCommunicationDiagnostic, executionValueDigest, executionUuid,
} from "./process-execution-values.js";
import { ManagedControlPolicy } from "./managed-control-policy.js";
import { managedMonotonicNow } from "./managed-stop-operation.js";

export const MANAGED_PROCESS_MESSAGE_MAX_BYTES = 32 * 1024 * 1024;

/** Bounded UTF-8 lines shared by both sides of the managed TCP protocol.
 * Scan each incoming byte once; retain owned bytes until a complete frame can
 * be decoded. A socket chunk boundary is never a character boundary.
 */
export class ManagedProcessFrameReader {
  #chunks = [];
  #length = 0;
  #maxBytes;
  constructor(maxBytes = MANAGED_PROCESS_MESSAGE_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MANAGED_PROCESS_MESSAGE_MAX_BYTES) {
      throw new RangeError("Managed frame bound is invalid");
    }
    this.#maxBytes = maxBytes;
  }
  *read(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const length = this.#length + end - offset;
      if (length > this.#maxBytes) {
        throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_LIMIT", "Managed frame exceeds its bound");
      }
      const part = bytes.subarray(offset, end);
      if (newline < 0) {
        if (part.length > 0) this.#chunks.push(Buffer.from(part));
        this.#length = length;
        return;
      }
      const frame = this.#chunks.length === 0 ? part
        : Buffer.concat([...this.#chunks, part], length);
      this.#chunks = []; this.#length = 0;
      offset = newline + 1;
      yield frame.toString("utf8");
    }
  }
}

export class ManagedProcessMessage {
  static reservesCall(operation) { return ["reserve", "reserve-and-claim"].includes(operation); }
  constructor(call, operation, payload = {}, { requestId = randomUUID(), payloadDigest = executionValueDigest(payload) } = {}) {
    const acceptance = new ManagedRequestAcceptance({ requestId, payloadDigest });
    this.executionId = call.executionId;
    this.callId = call.callId;
    this.ownerToken = call.ownerToken;
    this.capability = call.capability;
    this.operation = operation;
    this.payload = payload;
    this.requestId = acceptance.requestId;
    this.payloadDigest = acceptance.payloadDigest;
  }
  matches(call) {
    return this.executionId === call.executionId && this.callId === call.callId
      && this.ownerToken === call.ownerToken && this.capability === call.capability;
  }
  static from(value) {
    let acceptance;
    try { acceptance = new ManagedRequestAcceptance(value); }
    catch {
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Managed message lacks its request identity");
    }
    return new ManagedProcessMessage(value, value.operation, value.payload, acceptance);
  }
  respondsTo(request) {
    return this.matches(request) && this.operation === request.operation
      && this.requestId === request.requestId && this.payloadDigest === request.payloadDigest;
  }
  respond(payload) { return new ManagedProcessMessage(this, this.operation, payload, this); }
  assertPayload() {
    if (executionValueDigest(this.payload) !== this.payloadDigest) {
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Managed request content does not match its digest");
    }
  }
}

/** Durable admission identifies the request without retaining its environment. */
export class ManagedRequestAcceptance {
  constructor(message) {
    this.requestId = executionUuid(message?.requestId, "Managed request ID");
    if (typeof message.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(message.payloadDigest)) {
      throw new TypeError("Managed acceptance requires a request identity and content digest");
    }
    this.payloadDigest = message.payloadDigest;
    Object.freeze(this);
  }
  matches(message) { return this.requestId === message.requestId && this.payloadDigest === message.payloadDigest; }
}

export function managedControlFailure(code, message, cause) {
  return new ProcessExecutionControlFailure(code, message, { cause });
}

function managedRecordLock(file, waitPolicy, deadline, lockAuthority) {
  if (!(lockAuthority instanceof RepositoryLockAuthority)) throw new TypeError("Managed record locks require explicit repository authority");
  if (Number.isFinite(deadline)) {
    const existing = waitPolicy ?? new FileLockWaitPolicy();
    waitPolicy = new FileLockWaitPolicy({ timeoutMs: Math.min(existing.timeoutMs, Math.floor(Math.max(0, deadline - managedMonotonicNow()))),
      intervalMs: existing.intervalMs });
  }
  return new FileLock({ waitPolicy, location: lockAuthority.location({ namespace: "managed-process-record",
    identity: path.resolve(file), fileName: "record.lock", legacyPaths: [`${path.resolve(file)}.lock`] }), kind: "managed-process-record", authority: { file: path.resolve(file) } });
}

/** The same per-record exclusion is shared by standalone and grouped writers. */
export function withManagedRecordWriters(writes, body, { preparedTransitions = null } = {}) {
  const ordered = [...writes].sort((left, right) => left.file.localeCompare(right.file));
  if (new Set(ordered.map((write) => write.file)).size !== ordered.length) throw new TypeError("Managed publication contains duplicate targets");
  const acquisitions = ordered.map((write) => new FileLockAcquisition(() => {
    if (!(write instanceof ManagedRecordWrite)) throw new TypeError("Managed publication requires typed writes");
    return managedRecordLock(write.file, write.waitPolicy, write.deadline, write.lockAuthority);
  }, () => {
    const current = write.transitionFile.readSnapshot();
    if (preparedTransitions === null) {
      if (current !== null) throw new Error("Managed record has an incomplete durable write");
    } else {
      if (!preparedTransitions.has(write.file)) throw new TypeError("Prepared managed publication lacks its transition observation");
      const expected = preparedTransitions.get(write.file);
      if ((expected === null) !== (current === null) || expected !== null
        && (!sameFileIdentity(expected.identity, current.identity) || expected.digest !== current.digest || !expected.bytes.equals(current.bytes))) throw new Error("Prepared managed transition changed its exact generation");
    }
  }));
  return FileLock.runExclusiveGroup(acquisitions, body);
}

/** Validated bytes prepared without making any visible record changes. */
export class ManagedRecordWrite {
  #bytes;
  constructor(file, bytes, identity, { faultInjector, waitPolicy, deadline, lockAuthority = identity.recordLocks, maximum = 16 * 1024 * 1024 } = {}) {
    if (!path.isAbsolute(file) || !(lockAuthority instanceof RepositoryLockAuthority)
      || !Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Managed record write requires a bounded file and repository authority");
    this.file = path.resolve(file); this.identity = identity; this.maximum = maximum;
    this.faultInjector = faultInjector; this.waitPolicy = waitPolicy; this.deadline = deadline; this.lockAuthority = lockAuthority;
    this.#bytes = Buffer.from(bytes);
    if (this.#bytes.length > maximum) throw new TypeError("Managed record write exceeds its byte bound");
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#bytes); }
  get transitionFile() { return new AtomicFile(`${this.file}.transition`); }
  get transitionBytes() { return Buffer.from(JSON.stringify({ executionId: this.identity.executionId, callId: this.identity.callId })); }
  publish() { return writeManagedBinary(this.file, this.#bytes, this.identity, this); }
}

export function readManagedBinary(file, { maximum = 16 * 1024 * 1024, waitPolicy, deadline, lockAuthority } = {}) {
  try {
    return managedRecordLock(file, waitPolicy, deadline, lockAuthority).runExclusive(() => readManagedBinarySnapshot(file, { maximum }));
  } catch (cause) {
    if (cause instanceof ProcessExecutionControlFailure) throw cause;
    throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed process record cannot be read: ${file}`, cause);
  }
}

export function readManagedRecord(file, options = {}) {
  return decodeManagedRecord(readManagedBinary(file, options), file);
}

export function writeManagedBinary(file, bytes, identity, { faultInjector, waitPolicy, deadline, lockAuthority = identity.recordLocks, maximum = 16 * 1024 * 1024 } = {}) {
  try {
    const prepared = new ManagedRecordWrite(path.resolve(file), bytes, identity, { faultInjector, waitPolicy, deadline, lockAuthority, maximum });
    withManagedRecordWriters([prepared], () => {
      const store = new AtomicFile(file, { faultInjector, maxBytes: maximum });
      const content = prepared.bytes;
      const transition = prepared.transitionFile;
      transition.write(prepared.transitionBytes);
      store.write(content);
      if (!store.read()?.equals(content)) throw new Error("Record readback differs");
      transition.remove();
    });
  } catch (cause) {
    throw managedControlFailure("PROCESS_EXECUTION_RECORD_SAVE_FAILED", `Managed process record cannot be saved: ${file}`, cause);
  }
}

export function writeManagedRecord(file, value, options = {}) {
  writeManagedBinary(file, Buffer.from(JSON.stringify(value)), value, options);
}

class ManagedMailboxExchange {
  #bytes = null;
  #publicationFailure = null;
  constructor(call, message) {
    const endpoint = call.endpoint?.mailbox;
    if (!endpoint || typeof endpoint.requests !== "string" || typeof endpoint.responses !== "string") {
      throw managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Authenticated mailbox endpoint is unavailable");
    }
    this.message = message;
    this.requestFile = new AtomicFile(path.join(endpoint.requests, message.requestId + ".json"), { maxBytes: MANAGED_PROCESS_MESSAGE_MAX_BYTES });
    this.responseFile = new AtomicFile(path.join(endpoint.responses, message.requestId + ".json"), { maxBytes: MANAGED_PROCESS_MESSAGE_MAX_BYTES });
  }
  get bytes() { return this.#bytes ??= Buffer.from(JSON.stringify(this.message)); }
  readRequest() {
    const existing = this.requestFile.read();
    if (existing !== null && !existing.equals(this.bytes)) {
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Mailbox request identity has different bytes");
    }
    return existing;
  }
  readPublishedResponse() {
    // TCP settlement may observe a previous fallback, but cannot publish one.
    if (this.readRequest() === null) return null;
    let responseBytes = null;
    try { responseBytes = this.responseFile.read(); }
    catch (cause) {
      if (!(cause instanceof RegularFileLinkCountError)) throw cause;
      // Exclusive publication is unusable until its stage link is removed.
      // A foreign persistent link is equally unreadable; neither authorizes bytes.
      this.#publicationFailure ??= managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed mailbox response remained hard linked", cause);
    }
    if (responseBytes !== null) {
      let response;
      try { response = ManagedProcessMessage.from(JSON.parse(responseBytes)); }
      catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Mailbox response is malformed", cause); }
      if (!response.respondsTo(this.message)) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Mailbox response belongs to another request");
      if (response.payload.error) throw ProcessExecutionControlFailure.fromStored(response.payload.error);
      return response.payload;
    }
    return null;
  }
  unavailable(message, cause) {
    return managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", message, this.#publicationFailure ?? cause);
  }
  publishRequest() {
    if (this.readRequest() === null) this.requestFile.write(this.bytes);
  }
  async wait({ timeoutMs, abortSignal, onWait, readSettlement }) {
    this.publishRequest();
    const until = managedMonotonicNow() + timeoutMs;
    while (managedMonotonicNow() < until) {
      if (abortSignal?.aborted) throw managedControlFailure("PROCESS_EXECUTION_COMMUNICATION_ABORTED", "Managed mailbox request was aborted");
      onWait();
      const settled = readSettlement();
      if (settled !== null) return settled;
      const response = this.readPublishedResponse();
      if (response !== null) return response;
      await delay(Math.min(10, Math.max(1, until - managedMonotonicNow())));
    }
    throw this.unavailable("Managed mailbox did not respond within its response slot");
  }
}

function createManagedTransportRequest({ socketRequest = managedSocketRequest } = {}) {
  // Progress belongs to this one immutable operation, across its existing slots.
  // Healthy TCP never needs to construct or inspect an unused mailbox authority.
  let mailbox = null;
  return async (call, message, options) => {
    if (call.transport === "mailbox" || call.endpoint?.port === null) {
      mailbox ??= new ManagedMailboxExchange(call, message);
      return mailbox.wait(options);
    }
    // A previous TCP slot may have expired without any time left to publish
    // fallback. This new authorized slot can publish the exact same request;
    // the operation owner already checked its unchanged total deadline.
    mailbox?.publishRequest();
    try { return await socketRequest(call, message, mailbox === null ? options : { ...options, readSettlement() {
      const settled = options.readSettlement();
      return settled !== null ? settled : mailbox.readPublishedResponse();
    } }); }
    catch (cause) {
      if (cause.code !== "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE" || !call.endpoint?.mailbox) throw cause;
      // Same immutable request, same response slot; transport failure never grants another spawn.
      mailbox ??= new ManagedMailboxExchange(call, message);
      const remaining = options.timeoutMs - Math.max(0, managedMonotonicNow() - options.startedAt);
      if (remaining <= 0) throw mailbox.unavailable(cause.message, cause);
      return mailbox.wait({ ...options, timeoutMs: remaining });
    }
  };
}

/** A bounded wire carrier; each member retains its original request identity. */
export class ManagedProcessRequestBatch {
  static get maximumWidth() { return 8; }
  static cohortKey(message) {
    if (ManagedProcessMessage.reservesCall(message.operation) || ["claim-launch", "finish"].includes(message.operation)) return message.operation;
    return message.operation === "observe" && ["started", "exit"].includes(message.payload.data?.type)
      ? `observe-${message.payload.data.type}` : null;
  }
  #bytes;
  constructor(messages) {
    if (!Array.isArray(messages) || messages.length < 2 || messages.length > ManagedProcessRequestBatch.maximumWidth
      || messages.some((message) => !(message instanceof ManagedProcessMessage))) {
      throw new TypeError("Managed request batch requires bounded nominal messages");
    }
    const first = messages[0], key = ManagedProcessRequestBatch.cohortKey(first);
    if (key === null || new Set(messages.map((message) => message.requestId)).size !== messages.length
      || messages.some((message) => !message.matches(first) || ManagedProcessRequestBatch.cohortKey(message) !== key)) {
      throw new TypeError("Managed request batch requires distinct homogeneous requests from one authenticated client");
    }
    this.#bytes = Buffer.from(JSON.stringify({ messages }) + "\n");
    if (this.#bytes.length > MANAGED_PROCESS_MESSAGE_MAX_BYTES) throw new RangeError("Managed request batch exceeds the original message bound");
    Object.freeze(this);
  }
  static fromEnvelope(value) {
    if (!Array.isArray(value?.messages)) throw new TypeError("Managed request batch requires its complete message array");
    return new this(value.messages.map((message) => ManagedProcessMessage.from(message)));
  }
  get messages() {
    return JSON.parse(this.#bytes.toString("utf8")).messages.map((message) => ManagedProcessMessage.from(message));
  }
  wireBytes() { return Buffer.from(this.#bytes); }
}

/** One response slot, including time spent waiting for the next dispatch turn. */
class ManagedSocketRequestMember {
  constructor(call, message, options) {
    this.call = call; this.message = message; this.options = options;
    this.done = false; this.onSettled = null;
    this.response = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.aborted = () => this.finish(managedControlFailure("PROCESS_EXECUTION_COMMUNICATION_ABORTED", "Managed communication was aborted"));
    this.timer = setTimeout(() => this.finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher did not respond")), Math.max(1, options.timeoutMs));
    this.poll = setInterval(() => {
      if (this.done) return;
      try {
        options.onWait();
        const settled = options.readSettlement();
        if (settled !== null) this.finish(null, settled);
      } catch (cause) { this.finish(cause); }
    }, 20);
    options.abortSignal?.addEventListener("abort", this.aborted, { once: true });
    if (options.abortSignal?.aborted) this.aborted();
  }
  finish(error, value) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer); clearInterval(this.poll);
    this.options.abortSignal?.removeEventListener("abort", this.aborted);
    if (error) this.reject(error); else this.resolve(value);
    this.onSettled?.();
  }
  receive(value) {
    if (this.done) return;
    try {
      const response = ManagedProcessMessage.from(value);
      if (!response.respondsTo(this.message)) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed response does not match its request");
      if (response.payload.error) throw ProcessExecutionControlFailure.fromStored(response.payload.error);
      this.finish(null, response.payload);
    } catch (cause) {
      this.finish(cause instanceof ProcessExecutionControlFailure ? cause
        : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed coordinator returned an invalid response", cause));
    }
  }
}

/** Scalar and grouped TCP use the same parser, watcher, deadline and cleanup. */
class ManagedSocketExchange {
  static send(members) {
    const active = members.filter((member) => !member.done);
    if (active.length === 0) return;
    try { new this(active); }
    catch (cause) { for (const member of active) member.finish(cause); }
  }
  constructor(members) {
    this.members = new Map(members.map((member) => [member.message.requestId, member]));
    this.frames = new ManagedProcessFrameReader();
    const endpoint = members[0].call.endpoint;
    this.socket = net.createConnection(typeof endpoint === "object" ? { host: endpoint.host, port: endpoint.port } : endpoint);
    for (const member of members) member.onSettled = () => {
      if (members.every((entry) => entry.done)) this.socket.destroy();
    };
    this.socket.on("error", (cause) => this.fail(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator connection failed", cause)));
    this.socket.on("end", () => this.fail(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator disconnected before its response")));
    this.socket.on("close", () => this.fail(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator disconnected before its response")));
    this.socket.on("connect", () => {
      try {
        const pending = members.filter((member) => !member.done);
        if (pending.length === 0) { this.socket.destroy(); return; }
        const messages = pending.map((member) => member.message);
        const bytes = messages.length === 1 ? Buffer.from(JSON.stringify(messages[0]) + "\n")
          : new ManagedProcessRequestBatch(messages).wireBytes();
        this.socket.write(bytes);
      } catch (cause) { this.fail(cause); }
    });
    this.socket.on("data", (bytes) => this.receive(bytes));
  }
  fail(cause) {
    for (const member of this.members.values()) member.finish(cause);
    this.socket.destroy();
  }
  receive(bytes) {
    // Keep the original per-response byte bound even when several frames share
    // one TCP chunk. Completed/expired identities remain known for late replies.
    try {
      for (const frame of this.frames.read(bytes)) {
        const response = JSON.parse(frame);
        const member = this.members.get(response.requestId);
        if (member === undefined) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed response does not match its request");
        member.receive(response);
        if ([...this.members.values()].every((member) => member.done)) return;
      }
    } catch (cause) {
      this.fail(cause instanceof ProcessExecutionControlFailure ? cause
        : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed coordinator returned an invalid response", cause));
    }
  }
}

function managedSocketRequest(call, message, options) {
  const member = new ManagedSocketRequestMember(call, message, options);
  ManagedSocketExchange.send([member]);
  return member.response;
}

/** Collect only already-ready homogeneous messages, without waiting for peers.
 * Each logical operation gets its own original mailbox/retransmission state.
 * Native lifecycle ordering, aborts and individual response slots stay intact.
 */
export class ManagedRequestTransportCohort {
  #pending = [];
  #scheduled = false;
  createRequest() {
    return createManagedTransportRequest({ socketRequest: (call, message, options) => this.#request(call, message, options) });
  }
  #request(call, message, options) {
    if (ManagedProcessRequestBatch.cohortKey(message) === null) return managedSocketRequest(call, message, options);
    const member = new ManagedSocketRequestMember(call, message, options);
    this.#pending.push(member);
    if (!this.#scheduled) {
      this.#scheduled = true;
      setImmediate(() => this.#flush());
    }
    return member.response;
  }
  #flush() {
    const pending = this.#pending.filter((member) => !member.done);
    this.#pending = []; this.#scheduled = false;
    let members = [];
    const flush = () => { ManagedSocketExchange.send(members); members = []; };
    for (const member of pending) {
      if (members.length > 0) {
        const first = members[0];
        let fits = member.message.matches(first.message)
          && JSON.stringify(member.call.endpoint) === JSON.stringify(first.call.endpoint)
          && ManagedProcessRequestBatch.cohortKey(member.message) === ManagedProcessRequestBatch.cohortKey(first.message)
          && !members.some((entry) => entry.message.requestId === member.message.requestId)
          && members.length < ManagedProcessRequestBatch.maximumWidth;
        if (fits) {
          try { new ManagedProcessRequestBatch([...members, member].map((entry) => entry.message)); }
          catch (cause) {
            if (!(cause instanceof RangeError)) { member.finish(cause); continue; }
            fits = false;
          }
        }
        if (!fits) flush();
      }
      members.push(member);
    }
    flush();
  }
}


/** One communication operation, including retransmission of its exact request. */
export async function managedRequest(call, operation, payload = {}, {
  deadline = Infinity, abortSignal = null, readSettlement = () => null, onWait = () => {},
  readAcceptance = () => "unknown",
  policy = new ManagedControlPolicy(), now = managedMonotonicNow, wait = delay, request = createManagedTransportRequest(),
  requestId = randomUUID(),
} = {}) {
  if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new TypeError("Invalid managed communication operation");
  // Snapshot once: external mutation cannot turn a retry into a different start.
  const message = new ManagedProcessMessage(call, operation, JSON.parse(JSON.stringify(payload)), { requestId });
  // Routing authenticates the client grant; failure provenance belongs to the
  // immutable physical target when this operation addresses one. It grants no
  // execution authority and never changes the message identity or digest.
  const failureContext = { executionId: message.executionId,
    callId: message.payload?.data?.call?.callId === undefined ? message.callId
      : executionUuid(message.payload.data.call.callId, "Managed physical failure call ID") };
  const startedAt = now();
  const operationDeadline = Math.min(startedAt + policy.budgetMs, deadline);
  const attempts = [];
  let firstFailure = null;
  const elapsed = () => Math.max(0, now() - startedAt);
  const failure = (cause, cutoff, inspectionDeadline = operationDeadline) => {
    if (!(cause instanceof ProcessExecutionControlFailure)) cause = managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed control boundary returned invalid state", cause);
    if (attempts.length === 0 && !["PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "PROCESS_EXECUTION_COMMUNICATION_ABORTED"].includes(cause.code)) {
      return cause.withContext({ executionId: cause.executionId ?? failureContext.executionId, callId: cause.callId ?? failureContext.callId });
    }
    let acceptance = "unknown";
    try { acceptance = cause.code === "PROCESS_EXECUTION_REQUEST_MISMATCH" ? "rejected" : readAcceptance(message, inspectionDeadline); }
    catch (acceptanceError) {
      if (["PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "PROCESS_EXECUTION_COMMUNICATION_ABORTED"].includes(cause.code)) {
        cause = acceptanceError instanceof ProcessExecutionControlFailure ? acceptanceError
          : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed acceptance observation is invalid", acceptanceError);
      } else {
        cause.cause = new AggregateError([cause.cause, acceptanceError].filter(Boolean), "Verified refusal and subsequent acceptance observation failure");
      }
      cutoff = "refused";
    }
    const primary = cause.diagnostic !== null || cause.code !== "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE" ? cause : firstFailure ?? cause;
    return new ProcessExecutionControlFailure(cause.code, cause.message, { cause, executionId: cause.executionId ?? failureContext.executionId, callId: cause.callId ?? failureContext.callId,
      primaryCause: primary.primaryCause ?? { code: primary.code, message: primary.message, executionId: failureContext.executionId, callId: failureContext.callId },
      communication: new ProcessExecutionCommunicationDiagnostic({ operation, budgetMs: policy.budgetMs,
        elapsedMs: elapsed(), cutoff, acceptance,
        stopConfirmation: "unknown", attempts }) });
  };
  const cutoff = () => abortSignal?.aborted ? "aborted" : now() >= operationDeadline
    ? (deadline <= startedAt + policy.budgetMs ? "operation-deadline" : "budget-exhausted") : null;
  const check = (inspectionDeadline = operationDeadline) => {
    onWait(inspectionDeadline);
    return readSettlement(inspectionDeadline);
  };
  for (let ordinal = 1; ordinal <= policy.attemptCount; ordinal++) {
    let settled;
    try { settled = check(); }
    catch (cause) { throw failure(cause, "refused"); }
    if (settled !== null) return settled;
    const interrupted = cutoff();
    if (interrupted !== null) throw failure(firstFailure ?? managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed communication ended before a response"), interrupted);
    const attemptStarted = now();
    const responseDeadline = Math.min(startedAt + policy.responseDeadlineMs(ordinal), operationDeadline);
    try {
      const response = await request(call, message, { timeoutMs: responseDeadline - now(), startedAt: managedMonotonicNow(), abortSignal,
        onWait: () => onWait(responseDeadline), readSettlement: () => readSettlement(responseDeadline) });
      if (cutoff() !== null) throw managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed response arrived after its operation ended");
      return response;
    } catch (error) {
      const cause = error instanceof ProcessExecutionControlFailure ? error
        : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed communication failed its response contract", error);
      const transient = cause.code === "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE";
      const verifiedFailure = !transient && cause.code !== "PROCESS_EXECUTION_COMMUNICATION_ABORTED";
      const stopped = cutoff();
      attempts.push(new ProcessExecutionCommunicationAttempt({ ordinal,
        responseDeadlineMs: Math.min(policy.responseDeadlineMs(ordinal), deadline - startedAt),
        elapsedMs: Math.max(0, now() - attemptStarted), outcome: verifiedFailure ? "refused" : stopped === "aborted" ? "aborted"
          : stopped === "operation-deadline" ? "deadline" : !transient ? "refused"
            : now() >= responseDeadline ? "timeout" : "disconnected" }));
      firstFailure ??= cause;
      try { settled = check(responseDeadline); }
      catch (settlementError) { throw failure(verifiedFailure ? cause : settlementError, "refused", responseDeadline); }
      if (verifiedFailure) throw failure(cause, "refused", responseDeadline);
      if (settled !== null) return settled;
      // A full response timeout already consumed its slot. Early disconnects
      // wait only the remainder, with the same output and settlement checks.
      while (now() < responseDeadline && cutoff() === null) {
        try { await wait(Math.min(20, responseDeadline - now()), undefined, { signal: abortSignal ?? undefined }); }
        catch (waitError) { if (!abortSignal?.aborted) throw waitError; }
        try { settled = check(responseDeadline); }
        catch (settlementError) { throw failure(settlementError, "refused", responseDeadline); }
        if (settled !== null) return settled;
      }
      const finalCutoff = cutoff();
      if (finalCutoff !== null || ordinal === policy.attemptCount) {
        throw failure(firstFailure, finalCutoff ?? "budget-exhausted", responseDeadline);
      }
    }
  }
}
