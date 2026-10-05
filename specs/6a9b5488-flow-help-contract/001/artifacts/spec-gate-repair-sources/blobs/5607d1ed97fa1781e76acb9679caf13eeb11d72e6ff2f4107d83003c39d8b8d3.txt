import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import { ProcessIdentity } from "./process-identity.js";
import { ProcessLock } from "./process-lock.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 50;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsedSince(startedAt) {
  return Math.max(0, Math.floor(performance.now() - startedAt));
}

export class FileLockWaitPolicy {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (timeoutMs !== Infinity && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
      throw new Error("file lock timeoutMs must be a non-negative safe integer or Infinity");
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("file lock intervalMs must be a positive safe integer");
    }
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    Object.freeze(this);
  }
}

class FileLockTerminalError extends Error {
  constructor(error, status) {
    super(error.message, { cause: error });
    this.name = error.name;
    this.code = error.code;
    this.lockStatus = status;
    this.lockPath = error.lockPath;
    this.owner = error.owner;
    this.retryable = status === "timeout";
  }
}

export class FileLockReentrancyError extends FileLockTerminalError {
  constructor(error) {
    super(error, "reentrant");
  }
}

class FileLockRetry {
  constructor(delayMs) {
    this.delayMs = delayMs;
  }
}

export class FileLockTimeoutError extends FileLockTerminalError {
  constructor(error) {
    super(error, "timeout");
    this.waitedMs = error.waitedMs;
  }
}

export class FileLock {
  constructor({ waitPolicy = new FileLockWaitPolicy(), ...lockOptions } = {}) {
    if (!(waitPolicy instanceof FileLockWaitPolicy)) {
      throw new Error("file lock waitPolicy must be a FileLockWaitPolicy");
    }
    this.processLock = new ProcessLock(lockOptions);
    this.waitPolicy = waitPolicy;
  }

  get directoryAuthority() { return this.processLock.directoryAuthority; }
  get directory() { return this.processLock.directory; }
  get lockPath() { return this.processLock.lockPath; }
  get processIdentity() { return this.processLock.processIdentity; }
  get lockIdentity() { return this.processLock.lockIdentity; }

  acquire() {
    const startedAt = performance.now();
    for (;;) {
      const outcome = this.#acquireAttempt(startedAt);
      if (!(outcome instanceof FileLockRetry)) return outcome;
      sleepSync(outcome.delayMs);
    }
  }

  async acquireAsync() {
    const startedAt = performance.now();
    for (;;) {
      const outcome = this.#acquireAttempt(startedAt);
      if (!(outcome instanceof FileLockRetry)) return outcome;
      await sleep(outcome.delayMs);
    }
  }

  release() {
    return this.processLock.release();
  }

  inspect() {
    return this.processLock.inspect();
  }

  conflict(owner, assessment) {
    return this.processLock.conflict(owner, assessment);
  }

  runExclusive(body) {
    if (typeof body !== "function") throw new TypeError("file lock exclusive body must be a function");
    this.acquire();
    let result;
    let bodyError = null;
    try {
      result = body();
    } catch (error) {
      bodyError = error;
    }
    this.#releaseAfter(bodyError);
    if (bodyError) throw bodyError;
    return result;
  }

  async runExclusiveAsync(body) {
    if (typeof body !== "function") throw new TypeError("file lock exclusive body must be a function");
    await this.acquireAsync();
    let result;
    let bodyError = null;
    try {
      result = await body();
    } catch (error) {
      bodyError = error;
    }
    this.#releaseAfter(bodyError);
    if (bodyError) throw bodyError;
    return result;
  }

  #acquireAttempt(startedAt) {
    try {
      return this.processLock.acquire();
    } catch (error) {
      if (error?.lockStatus !== "live") throw error;
      if (this.#isHeldByCurrentProcess(error)) throw this.#reentrancy(error);
      const waitedMs = elapsedSince(startedAt);
      if (waitedMs >= this.waitPolicy.timeoutMs) throw this.#timeout(error, waitedMs);
      return new FileLockRetry(Math.min(this.waitPolicy.intervalMs, this.waitPolicy.timeoutMs - waitedMs));
    }
  }

  #isHeldByCurrentProcess(conflict) {
    const owner = new ProcessIdentity(conflict.owner?.processIdentity ?? {});
    const requester = this.processLock.processIdentitySource.createOwner(crypto.randomUUID());
    return requester.sameBirth(owner);
  }

  #reentrancy(conflict) {
    const message = `file lock is already held by this process: ${conflict.lockPath}`;
    return new FileLockReentrancyError(this.#terminalError("reentrant", message, conflict));
  }

  #timeout(conflict, waitedMs) {
    const message = `timed out waiting for file lock: ${conflict.lockPath}`;
    return new FileLockTimeoutError(this.#terminalError("timeout", message, conflict, waitedMs));
  }

  #terminalError(status, message, conflict, waitedMs = null) {
    const error = this.processLock.errorFactory(status, message, {
      lockPath: conflict.lockPath,
      cause: conflict,
    });
    error.lockStatus = status;
    error.lockPath = conflict.lockPath;
    error.owner = conflict.owner;
    error.retryable = status === "timeout";
    if (waitedMs !== null) error.waitedMs = waitedMs;
    if (!("cause" in error)) error.cause = conflict;
    return error;
  }

  #releaseAfter(bodyError) {
    try {
      this.release();
    } catch (releaseError) {
      if (bodyError) {
        throw new AggregateError([bodyError, releaseError], "file lock body and release both failed", { cause: bodyError });
      }
      throw releaseError;
    }
  }
}
