/**
 * Canonical agent timeout value.
 *
 * Configuration is expressed in seconds for human-facing readability. Convert
 * to milliseconds only when calling Node.js process and timer APIs.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_AGENT_TIMEOUT_SECONDS = 1_800;
export const TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS = 7_200;
// An outer process that hosts an Agent must stay alive through the Agent's
// SIGTERM/SIGKILL cleanup sequence.  This includes two default grace windows
// plus scheduling/polling slack before the parent may apply its own timeout.
export const DEFAULT_AGENT_PROCESS_TREE_GRACE_MS = 100;
export const OUTER_AGENT_PROCESS_TREE_TIMEOUT_ALLOWANCE_MS = 1_000;

export class AgentTimeout {
  constructor(seconds = DEFAULT_AGENT_TIMEOUT_SECONDS) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError("agent timeout must be a positive number of seconds");
    }
    this.seconds = value;
    Object.freeze(this);
  }

  static fromConfig(agentConfig = {}) {
    return new AgentTimeout(agentConfig?.timeout ?? DEFAULT_AGENT_TIMEOUT_SECONDS);
  }

  toMilliseconds() {
    return this.seconds * 1000;
  }

  toOuterProcessMilliseconds() {
    return this.toMilliseconds() + OUTER_AGENT_PROCESS_TREE_TIMEOUT_ALLOWANCE_MS;
  }
}

/**
 * The threshold which caused a specialized worker timeout.
 *
 * Ordinary Agent timeouts deliberately have no diagnostic: their historical
 * error and JSON contract reports only the configured timeout.  Repair-worker
 * monitors use this value so an inactivity stop is never misreported as the
 * separate maximum-lifetime deadline that owns the process supervisor.
 */
export class AgentTimeoutDiagnostic {
  constructor({ reason, timeoutMs } = {}) {
    if (!new Set(["inactivity", "maximum_lifetime"]).has(reason)) {
      throw new TypeError("agent timeout diagnostic reason is invalid");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("agent timeout diagnostic threshold must be positive");
    }
    this.reason = reason;
    this.timeoutMs = timeoutMs;
    Object.freeze(this);
  }
}

/** Monotonic milliseconds used for worker liveness decisions. */
export class MonotonicMilliseconds {
  constructor(now = () => Number(process.hrtime.bigint() / 1_000_000n)) {
    if (typeof now !== "function") throw new TypeError("monotonic clock must be a function");
    this.now = now;
    Object.freeze(this);
  }

  read() {
    const value = Number(this.now());
    if (!Number.isFinite(value) || value < 0) throw new Error("monotonic clock returned an invalid value");
    return value;
  }
}

class HandoffTreeSnapshot {
  constructor(entries) {
    if (!(entries instanceof Map)) throw new TypeError("handoff tree snapshot requires entries");
    this.entries = entries;
    Object.freeze(this);
  }

  static capture(root) {
    const entries = new Map();
    const visit = (directory, relative = "") => {
      let names;
      try { names = fs.readdirSync(directory); } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const name of names.sort()) {
        const absolute = path.join(directory, name);
        const child = relative === "" ? name : `${relative}/${name}`;
        const stat = fs.lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
        if (stat === undefined) continue;
        entries.set(child, `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
        if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute, child);
      }
    };
    visit(root);
    return new HandoffTreeSnapshot(entries);
  }

  differsFrom(other) {
    if (!(other instanceof HandoffTreeSnapshot) || this.entries.size !== other.entries.size) return true;
    for (const [entry, fingerprint] of this.entries) {
      if (other.entries.get(entry) !== fingerprint) return true;
    }
    return false;
  }
}

/**
 * Per-worker liveness monitor for a selected test-review repair handoff.
 * Output and changes below exactly one handoff directory are activity; worker
 * process existence and canonical artifact changes are intentionally absent.
 */
export class TestReviewRepairWorkerMonitor {
  constructor({
    handoffDirectory,
    inactivityTimeoutMs,
    maximumLifetimeMs = TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS * 1000,
    clock = new MonotonicMilliseconds(),
    pollIntervalMs = Math.min(1_000, Math.max(1, Math.floor(inactivityTimeoutMs / 10))),
    schedule = setTimeout,
    cancel = clearTimeout,
    snapshot = HandoffTreeSnapshot.capture,
  } = {}) {
    if (!path.isAbsolute(handoffDirectory || "")) throw new TypeError("repair worker handoff directory must be absolute");
    if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) throw new TypeError("repair worker inactivity timeout must be positive");
    if (!Number.isFinite(maximumLifetimeMs) || maximumLifetimeMs <= 0) throw new TypeError("repair worker maximum lifetime must be positive");
    if (!(clock instanceof MonotonicMilliseconds)) throw new TypeError("repair worker monitor requires a monotonic clock");
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs >= inactivityTimeoutMs) {
      throw new TypeError("repair worker poll interval must be positive and below inactivity timeout");
    }
    if (typeof schedule !== "function" || typeof cancel !== "function" || typeof snapshot !== "function") {
      throw new TypeError("repair worker monitor requires timer and snapshot functions");
    }
    this.handoffDirectory = path.resolve(handoffDirectory);
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.maximumLifetimeMs = maximumLifetimeMs;
    this.clock = clock;
    this.pollIntervalMs = pollIntervalMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.snapshot = snapshot;
    this.startedAt = null;
    this.lastActivityAt = null;
    this.previousSnapshot = null;
    this.timer = null;
    this.timeout = null;
    this.stopped = false;
  }

  start(onTimeout) {
    if (this.startedAt !== null) throw new Error("repair worker monitor has already started");
    if (typeof onTimeout !== "function") throw new TypeError("repair worker monitor requires a timeout callback");
    const now = this.clock.read();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.previousSnapshot = this.snapshot(this.handoffDirectory);
    this.timeout = onTimeout;
    this.#schedule();
  }

  observeOutput() { this.#recordActivity(); }

  observeSubmission() { this.#recordActivity(); }

  timeoutDiagnosticFor(reason) {
    return new AgentTimeoutDiagnostic({
      reason,
      timeoutMs: reason === "inactivity" ? this.inactivityTimeoutMs : this.maximumLifetimeMs,
    });
  }

  poll() {
    if (this.stopped || this.startedAt === null) return null;
    const current = this.snapshot(this.handoffDirectory);
    if (current.differsFrom(this.previousSnapshot)) this.#recordActivity();
    this.previousSnapshot = current;
    return this.#check();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  #recordActivity() {
    if (this.stopped || this.startedAt === null) return;
    this.lastActivityAt = this.clock.read();
  }

  #schedule() {
    if (this.stopped) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      const reason = this.poll();
      if (reason === null) this.#schedule();
    }, this.pollIntervalMs);
  }

  #check() {
    const now = this.clock.read();
    const reason = now - this.startedAt >= this.maximumLifetimeMs
      ? "maximum_lifetime"
      : now - this.lastActivityAt >= this.inactivityTimeoutMs
        ? "inactivity"
        : null;
    if (reason !== null) {
      this.stop();
      this.timeout(this.timeoutDiagnosticFor(reason));
    }
    return reason;
  }
}
