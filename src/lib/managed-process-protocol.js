import net from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";
import { AtomicFile } from "./atomic-file.js";
import { RegularFileLinkCountError } from "./regular-file-snapshot.js";
import { readManagedBinarySnapshot, decodeManagedRecord } from "./managed-process-record.js";
import { ProcessExecutionControlFailure,
  ProcessExecutionCommunicationAttempt, ProcessExecutionCommunicationDiagnostic, executionValueDigest, executionUuid,
} from "./process-execution-values.js";
import { ManagedControlPolicy } from "./managed-control-policy.js";
import { managedMonotonicNow } from "./managed-stop-operation.js";

export class ManagedProcessMessage {
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
    managedRecordLock(file, waitPolicy, deadline, lockAuthority).runExclusive(() => {
      const store = new AtomicFile(file, { faultInjector, maxBytes: maximum });
      const content = Buffer.from(bytes);
      const transition = new AtomicFile(`${file}.transition`);
      if (transition.read() !== null) throw new Error("Managed record has an incomplete durable write");
      transition.write(JSON.stringify({ executionId: identity.executionId, callId: identity.callId }));
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
    this.requestFile = new AtomicFile(path.join(endpoint.requests, message.requestId + ".json"), { maxBytes: 32 * 1024 * 1024 });
    this.responseFile = new AtomicFile(path.join(endpoint.responses, message.requestId + ".json"), { maxBytes: 32 * 1024 * 1024 });
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
  async wait({ timeoutMs, abortSignal, onWait, readSettlement }) {
    if (this.readRequest() === null) this.requestFile.write(this.bytes);
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

function createManagedTransportRequest() {
  // Progress belongs to this one immutable operation, across its existing slots.
  // Healthy TCP never needs to construct or inspect an unused mailbox authority.
  let mailbox = null;
  return async (call, message, options) => {
    if (call.transport === "mailbox" || call.endpoint?.port === null) {
      mailbox ??= new ManagedMailboxExchange(call, message);
      return mailbox.wait(options);
    }
    try { return await managedSocketRequest(call, message, mailbox === null ? options : { ...options, readSettlement() {
      const settled = options.readSettlement();
      return settled !== null ? settled : mailbox.readPublishedResponse();
    } }); }
    catch (cause) {
      if (cause.code !== "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE" || !call.endpoint?.mailbox) throw cause;
      // Same immutable request, same response slot; transport failure never grants another spawn.
      const remaining = options.timeoutMs - Math.max(0, managedMonotonicNow() - options.startedAt);
      if (remaining <= 0) throw mailbox === null ? cause : mailbox.unavailable(cause.message, cause);
      mailbox ??= new ManagedMailboxExchange(call, message);
      return mailbox.wait({ ...options, timeoutMs: remaining });
    }
  };
}

function managedSocketRequest(call, message, { timeoutMs, abortSignal, onWait, readSettlement }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(typeof call.endpoint === "object" ? { host: call.endpoint.host, port: call.endpoint.port } : call.endpoint);
    let text = "";
    let done = false;
    let timer;
    let poll;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      abortSignal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(managedControlFailure("PROCESS_EXECUTION_COMMUNICATION_ABORTED", "Managed communication was aborted"));
    timer = setTimeout(() => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher did not respond")), Math.max(1, timeoutMs));
    poll = setInterval(() => {
      try {
        onWait();
        const settled = readSettlement();
        if (settled !== null) finish(null, settled);
      } catch (error) { finish(error); }
    }, 20);
    abortSignal?.addEventListener("abort", aborted, { once: true });
    if (abortSignal?.aborted) aborted();
    socket.on("error", (cause) => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator connection failed", cause)));
    socket.on("end", () => { if (!done) finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator disconnected before its response")); });
    socket.on("close", () => { if (!done) finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed coordinator disconnected before its response")); });
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (bytes) => {
      text += bytes;
      if (text.length > 32 * 1024 * 1024) return finish(managedControlFailure("PROCESS_EXECUTION_OUTPUT_LIMIT", "Managed response exceeds its bound"));
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(text.slice(0, newline));
        if (!ManagedProcessMessage.from(response).respondsTo(message)) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed response does not match its request");
        if (response.payload.error) throw ProcessExecutionControlFailure.fromStored(response.payload.error);
        finish(null, response.payload);
      } catch (error) {
        finish(error instanceof ProcessExecutionControlFailure ? error
          : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed coordinator returned an invalid response", error));
      }
    });
  });
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
