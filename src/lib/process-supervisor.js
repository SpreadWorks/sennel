import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LinuxProcessStat } from "./process-identity.js";
import { AgentTimeoutDiagnostic } from "./agent-timeout.js";
import { AgentProcessStopEvidence, AgentTimeoutFailure } from "./agent-failure.js";

export const DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS = 250;
const PROCESS_DEATH_POLL_MS = 10;

export class AgentTimeoutError extends AgentTimeoutFailure {
  constructor({ timeoutMs, graceMs, finalAction, timeoutDiagnostic = null, unterminatedMembers = [], stopEvidence = null }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("graceMs must be a positive number");
    if (!Array.isArray(unterminatedMembers) || !unterminatedMembers.every((member) => member instanceof UnterminatedProcessMember)) {
      throw new Error("unterminatedMembers must be process member diagnostics");
    }
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("timeout diagnostic is invalid");
    }
    const triggeringTimeoutMs = timeoutDiagnostic?.timeoutMs ?? timeoutMs;
    const evidence = stopEvidence == null
      ? AgentProcessStopEvidence.uncertain("process-tree-death-not-observed", unterminatedMembers)
      : AgentProcessStopEvidence.from(stopEvidence);
    super({ message: timeoutDiagnostic === null
      ? `Agent timed out after ${timeoutMs}ms; final action=${finalAction}`
      : `Agent timed out after ${triggeringTimeoutMs}ms; reason=${timeoutDiagnostic.reason}; final action=${finalAction}`,
    stopEvidence: evidence });
    this.name = "AgentTimeoutError";
    this.timeoutMs = triggeringTimeoutMs;
    this.graceMs = graceMs;
    this.finalAction = finalAction;
    if (timeoutDiagnostic !== null) this.timeoutReason = timeoutDiagnostic.reason;
    this.killed = true;
    this.unterminatedMembers = Object.freeze([...unterminatedMembers]);
  }
}

class PosixProcessMemberIdentity {
  constructor(stat) {
    if (!(stat instanceof LinuxProcessStat)) throw new Error("POSIX process member requires Linux process stat");
    this.pid = stat.pid;
    this.startFingerprint = stat.startFingerprint;
    Object.freeze(this);
  }

  matches(stat) {
    return stat instanceof LinuxProcessStat
      && stat.pid === this.pid
      && stat.startFingerprint === this.startFingerprint;
  }
}

class UnterminatedProcessMember {
  constructor(stat) {
    if (!(stat instanceof LinuxProcessStat)) throw new Error("unterminated process member requires Linux process stat");
    if (stat.state === "Z") throw new Error("unterminated process member cannot be a zombie");
    this.pid = stat.pid;
    this.state = stat.state;
    this.pgrp = stat.pgrp;
    this.startFingerprint = stat.startFingerprint;
    Object.freeze(this);
  }

  toJSON() {
    return {
      pid: this.pid,
      state: this.state,
      pgrp: this.pgrp,
      startFingerprint: this.startFingerprint,
    };
  }
}

export class ChildProcessSupervisor {
  constructor({
    child,
    timeoutMs,
    graceMs,
    exitDrainMs = DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS,
    platform = process.platform,
    runTaskkill,
    onEvent,
    waitForProcessTree = false,
    timeoutDiagnostic = null,
  }) {
    if (!child || typeof child.on !== "function") throw new Error("child must be a ChildProcess");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("graceMs must be a positive number");
    if (!Number.isFinite(exitDrainMs) || exitDrainMs <= 0) throw new Error("exitDrainMs must be a positive number");
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;
    this.exitDrainMs = exitDrainMs;
    this.platform = platform;
    this.runTaskkill = runTaskkill || runWindowsTaskkill;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.waitForProcessTree = waitForProcessTree === true;
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("supervisor timeout diagnostic is invalid");
    }
    this.deadlineTimeoutDiagnostic = timeoutDiagnostic;
    this.deadlineTimer = null;
    this.graceTimer = null;
    this.treeDeathPollTimer = null;
    this.finalDeadlineTimer = null;
    this.exitDrainTimer = null;
    this.originalPosixMembers = null;
    this.timeoutOwned = false;
    this.directChildClosed = false;
    this.treeDeadObserved = false;
    this.treeMembersUnavailable = false;
    this.finalDeadlineReached = false;
    this.settled = false;
    this.finalAction = null;
    this.timeoutDiagnostic = null;
    this._onClose = this._handleClose.bind(this);
    this._onExit = this._handleExit.bind(this);
    this._onError = this._handleError.bind(this);
  }

  wait() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.child.once("close", this._onClose);
      this.child.once("exit", this._onExit);
      this.child.once("error", this._onError);
      this._emit({ type: "spawn", pid: this.child.pid ?? null, detached: this.platform !== "win32" });
      this.deadlineTimer = setTimeout(() => this._handleTimeout(this.deadlineTimeoutDiagnostic), this.timeoutMs);
    });
  }

  _handleClose(code, signal) {
    if (this.settled) return;
    this.directChildClosed = true;
    this._emit({ type: "close", code, signal });
    if (!this.timeoutOwned) {
      if (this.waitForProcessTree && this.platform !== "win32") {
        this._waitForSuccessfulPosixTreeDeath(code, signal);
        return;
      }
      this._settleClose(code, signal);
      return;
    }
    this._trySettleTimedOutChild();
  }

  _handleExit(code, signal) {
    if (this.settled) return;
    this.directChildClosed = true;
    this._emit({ type: "exit", code, signal });
    if (this.timeoutOwned) {
      this._trySettleTimedOutChild();
      return;
    }
    if (this.waitForProcessTree) {
      if (this.platform !== "win32") {
        this._waitForSuccessfulPosixTreeDeath(code, signal);
      }
      // On Windows, `close` is the only built-in signal that inherited
      // provider handles are no longer keeping the process tree active.
      return;
    }
    // A descendant can inherit stdout/stderr and prevent ChildProcess's
    // `close` event after the direct provider process has exited. Give the
    // streams a brief chance to drain, then resolve from the direct exit so a
    // completed provider cannot strand the flow dispatcher indefinitely.
    this.exitDrainTimer = setTimeout(() => {
      if (!this.settled && this.directChildClosed && !this.timeoutOwned) {
        this._settleClose(code, signal);
      }
    }, this.exitDrainMs);
  }

  _handleError(error) {
    if (this.settled) return;
    this._emit({ type: "error", code: error?.code || null });
    if (!this.timeoutOwned) this._settleError(error);
  }

  timeout(timeoutDiagnostic) {
    if (!(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) {
      throw new Error("supervisor timeout requires an agent timeout diagnostic");
    }
    this._handleTimeout(timeoutDiagnostic);
  }

  abort(reason) {
    if (this.settled || this.timeoutOwned) return;
    this.abortReason = reason instanceof Error ? reason : new Error(String(reason ?? "Agent execution aborted"));
    this._handleTimeout();
  }

  _handleTimeout(timeoutDiagnostic = null) {
    if (this.settled || this.timeoutOwned) return;
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) throw new Error("timeout diagnostic is invalid");
    this.timeoutOwned = true;
    this.timeoutDiagnostic = timeoutDiagnostic;
    if (this.treeDeathPollTimer) clearTimeout(this.treeDeathPollTimer);
    this.treeDeathPollTimer = null;
    this._emit({ type: this.abortReason ? "abort" : "timeout", ...(timeoutDiagnostic === null ? {} : { reason: timeoutDiagnostic.reason }) });
    if (this.platform === "win32") {
      this._signalDirectChild("SIGTERM");
    } else {
      this._captureOriginalPosixMembers();
      this._signalProcessGroup("SIGTERM");
    }
    this.graceTimer = setTimeout(() => this._handleGraceExpiry(), this.graceMs);
  }

  _handleGraceExpiry() {
    if (this.settled || !this.timeoutOwned) return;
    this._emit({ type: "grace-expiry" });
    if (this.platform === "win32") {
      this._beginFinalDeathDeadline();
      this._forceWindowsTree();
      return;
    }
    this.finalAction = "SIGKILL";
    this._signalProcessGroup("SIGKILL");
    this._waitForPosixTreeDeath();
  }

  _signalDirectChild(signal) {
    this.finalAction = signal;
    try { this.child.kill(signal); } catch (_) {}
    this._emit({ type: "signal", signal, target: "direct-child" });
  }

  _signalProcessGroup(signal) {
    this.finalAction = signal;
    try { process.kill(-this.child.pid, signal); } catch (_) {}
    this._emit({ type: "signal", signal, target: "process-group" });
  }

  async _forceWindowsTree() {
    const args = ["/PID", String(this.child.pid), "/T", "/F"];
    try {
      const result = await this.runTaskkill(args);
      if (this.settled) return;
      this.finalAction = "taskkill /T /F";
      this.treeDeadObserved = result?.completed === true;
      this._emit({ type: "taskkill", completed: this.treeDeadObserved });
      if (this.treeDeadObserved) this._emit({ type: "tree-dead", probe: "taskkill-complete" });
      this._trySettleTimedOutChild();
    } catch (error) {
      if (!this.settled) {
        this.treeMembersUnavailable = true;
        this._emit({ type: "taskkill-error", code: error?.code || "UNKNOWN" });
        this._settleTimeout();
      }
    }
  }

  _trySettleTimedOutChild() {
    if (!this.timeoutOwned || !this.directChildClosed || this.settled) return;
    if (this.platform === "win32") {
      if (this.treeDeadObserved) this._settleTimeout();
      return;
    }
    if (this._isPosixTreeDead()) {
      this._markPosixTreeDead();
      this._settleTimeout();
    }
  }

  _isPosixTreeDead() {
    if (!this.child.pid) {
      this.treeMembersUnavailable = true;
      this._emit({ type: "tree-members-unavailable", code: "MISSING_CHILD_PID" });
      return false;
    }
    try {
      process.kill(-this.child.pid, 0);
      return processGroupHasNoLiveMembers(
        this.child.pid,
        this.originalPosixMembers,
        this._reportTreeMembersUnavailable.bind(this),
      );
    } catch (error) {
      if (error?.code !== "ESRCH") {
        this._reportTreeMembersUnavailable(error);
      }
      return error?.code === "ESRCH";
    }
  }

  _captureOriginalPosixMembers() {
    const members = readLinuxProcessGroupMembers(this.child.pid, this._reportTreeMembersUnavailable.bind(this));
    this.originalPosixMembers = members == null
      ? null
      : new Map(members.map((stat) => [stat.pid, new PosixProcessMemberIdentity(stat)]));
  }

  _collectOriginalUnterminatedPosixMembers() {
    if (!(this.originalPosixMembers instanceof Map)) return [];
    const members = readLinuxProcessGroupMembers(
      this.child.pid,
      this._reportTreeMembersUnavailable.bind(this),
      this.originalPosixMembers,
    );
    if (members == null) return [];
    return members
      .filter((member) => this.originalPosixMembers.get(member.pid)?.matches(member) && member.state !== "Z")
      .map((member) => new UnterminatedProcessMember(member));
  }

  _reportTreeMembersUnavailable(error) {
    this.treeMembersUnavailable = true;
    this._emit({ type: "tree-members-unavailable", code: error?.code || "UNKNOWN" });
  }

  _markPosixTreeDead() {
    if (this.treeDeadObserved) return;
    this.treeDeadObserved = true;
    this._emit({ type: "tree-dead", probe: "ESRCH" });
  }

  _waitForPosixTreeDeath() {
    this._beginFinalDeathDeadline();
    const poll = () => {
      if (this.settled) return;
      if (this._isPosixTreeDead()) {
        this._markPosixTreeDead();
        this._trySettleTimedOutChild();
        return;
      }
      this.treeDeathPollTimer = setTimeout(poll, PROCESS_DEATH_POLL_MS);
    };
    poll();
  }

  _beginFinalDeathDeadline() {
    if (this.finalDeadlineTimer !== null) return;
    this.finalDeadlineTimer = setTimeout(() => {
      if (!this.settled) {
        this.finalDeadlineReached = true;
        this._settleTimeout();
      }
    }, this.graceMs);
  }

  _waitForSuccessfulPosixTreeDeath(code, signal) {
    if (this.settled || this.timeoutOwned || this.treeDeathPollTimer) return;
    const poll = () => {
      this.treeDeathPollTimer = null;
      if (this.settled || this.timeoutOwned) return;
      if (this._isPosixTreeDead()) {
        this._markPosixTreeDead();
        this._settleClose(code, signal);
        return;
      }
      this.treeDeathPollTimer = setTimeout(poll, PROCESS_DEATH_POLL_MS);
    };
    poll();
  }

  _settleClose(code, signal) {
    this._cleanup();
    this._emit({ type: "settled", outcome: "close" });
    this.resolve({
      code,
      signal,
      processTreeQuiescence: this.waitForProcessTree
        && this.platform !== "win32"
        && this.treeDeadObserved
        ? "confirmed"
        : "unavailable",
    });
  }

  _settleError(error) {
    this._cleanup();
    this._emit({ type: "settled", outcome: "error" });
    this.reject(error);
  }

  _settleTimeout() {
    const unterminatedMembers = this._collectOriginalUnterminatedPosixMembers();
    const stopEvidence = this.treeDeadObserved
      ? AgentProcessStopEvidence.confirmed()
      : AgentProcessStopEvidence.uncertain(
          unterminatedMembers.length > 0
            ? "unterminated-process-members"
            : this.treeMembersUnavailable
              ? "process-tree-members-unavailable"
              : this.finalDeadlineReached
                ? "process-tree-death-deadline-reached"
                : "process-tree-death-not-observed",
          unterminatedMembers,
        );
    this._cleanup();
    this._emit({ type: "settled", outcome: this.abortReason ? "aborted" : "timeout" });
    if (this.abortReason) {
      this.abortReason.stopEvidence = stopEvidence;
      this.reject(this.abortReason);
      return;
    }
    this.reject(new AgentTimeoutError({
      timeoutMs: this.timeoutMs,
      graceMs: this.graceMs,
      finalAction: this.finalAction || "SIGTERM",
      timeoutDiagnostic: this.timeoutDiagnostic,
      unterminatedMembers,
      stopEvidence,
    }));
  }

  _cleanup() {
    if (this.settled) return;
    this.settled = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.treeDeathPollTimer) clearTimeout(this.treeDeathPollTimer);
    if (this.finalDeadlineTimer) clearTimeout(this.finalDeadlineTimer);
    if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
    this.deadlineTimer = null;
    this.graceTimer = null;
    this.treeDeathPollTimer = null;
    this.finalDeadlineTimer = null;
    this.exitDrainTimer = null;
    this.child.removeListener("close", this._onClose);
    this.child.removeListener("exit", this._onExit);
    this.child.removeListener("error", this._onError);
    this._emit({
      type: "cleanup",
      closeListeners: this.child.listenerCount("close"),
      errorListeners: this.child.listenerCount("error"),
      activeTimers: this._activeTimerCount(),
    });
  }

  _activeTimerCount() {
    return [this.deadlineTimer, this.graceTimer, this.treeDeathPollTimer, this.finalDeadlineTimer, this.exitDrainTimer]
      .filter((timer) => timer !== null)
      .length;
  }

  _emit(event) {
    try { this.onEvent?.(event); } catch (_) {}
  }
}

export function readLinuxProcessGroupMembers(groupId, reportUnavailable, originalMembers = null) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch (error) {
    reportUnavailable(error);
    return null;
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const member = LinuxProcessStat.parse(fs.readFileSync(path.join("/proc", entry, "stat"), "utf8"));
      if (member.pgrp === groupId) members.push(member);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      reportUnavailable(error);
      if (!(originalMembers instanceof Map) || originalMembers.has(Number(entry))) return null;
    }
  }
  return members;
}

function processGroupHasNoLiveMembers(groupId, originalMembers, reportUnavailable) {
  const members = readLinuxProcessGroupMembers(groupId, reportUnavailable, originalMembers);
  if (members == null) return false;
  return members.length > 0 && members.every((member) => {
    const original = originalMembers?.get(member.pid);
    return member.state === "Z" || (original && !original.matches(member));
  });
}

function runWindowsTaskkill(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("taskkill", args, { windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ completed: true });
      else reject(new Error(`taskkill failed with exit=${code}`));
    });
  });
}


export class ProcessOutputBuffer {
  #chunks = [];
  #bytes = 0;

  constructor(maximum, encoding) {
    if (typeof maximum !== "number" || maximum < 0 || Number.isNaN(maximum)) {
      throw new TypeError("Process maximum buffer must be a non-negative number");
    }
    this.maximum = maximum;
    this.encoding = encoding;
  }

  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, this.maximum - this.#bytes);
    if (remaining > 0) this.#chunks.push(bytes.subarray(0, remaining));
    this.#bytes += bytes.length;
    return this.#bytes <= this.maximum;
  }

  toBuffer() { return Buffer.concat(this.#chunks); }

  toString() {
    const bytes = this.toBuffer();
    return bytes.toString(this.encoding !== "buffer" && Buffer.isEncoding(this.encoding) ? this.encoding : "utf8");
  }
}

/** Shared live-child transport; recovered groups use the authenticated launcher. */
export async function executeSupervisedProcess(command, args, options) {
  const platform = options.platform || process.platform;
  const child = (options.spawn || spawn)(command, args, {
    stdio: options.stdio || [options.stdinContent != null ? "pipe" : "ignore", "pipe", "pipe"],
    cwd: options.cwd, env: options.env, detached: platform !== "win32",
  });
  options.onSpawn?.(child);
  const stdout = new ProcessOutputBuffer(options.maxBuffer ?? Infinity, options.encoding || "utf8");
  const stderr = new ProcessOutputBuffer(options.maxBuffer ?? Infinity, options.encoding || "utf8");
  let stdinError = null;
  const supervisor = new ChildProcessSupervisor({ ...options, child, platform });
  const collect = (buffer, stream, callback) => (chunk) => {
    if (!buffer.append(chunk)) {
      const error = new Error(`${stream} maxBuffer length exceeded`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      supervisor.abort(error);
    }
    options.activityMonitor?.observeOutput();
    callback?.(String(chunk));
  };
  child.stdout?.on("data", collect(stdout, "stdout", options.onStdout));
  child.stderr?.on("data", collect(stderr, "stderr", options.onStderr));
  if (options.stdinContent != null) {
    child.stdin.on("error", (error) => { stdinError = error; if (options.stopOnStdinError) supervisor.abort(error); });
    child.stdin.end(options.stdinContent);
  }
  const completion = supervisor.wait();
  const abort = () => supervisor.abort(options.abortReason ? options.abortReason() : options.abortSignal.reason);
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  if (options.abortSignal?.aborted) abort();
  options.activityMonitor?.start((diagnostic) => supervisor.timeout(diagnostic));
  try {
    return { ...await completion, stdout: stdout.toString(), stderr: stderr.toString(), stdinError };
  } catch (error) {
    error.stdout = stdout.toString();
    error.stderr = stderr.toString();
    Object.defineProperty(error, "child", { value: child, configurable: true });
    if (supervisor.finalAction) { error.signal = supervisor.finalAction; error.killed = true; }
    throw error;
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
    options.activityMonitor?.stop();
  }
}
