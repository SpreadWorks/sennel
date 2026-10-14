/**
 * src/lib/process.js
 *
 * Unified command execution helpers.
 * Ordinary process failures return result objects. Managed control failures throw.
 */

import { spawnSync, execFile } from "child_process";
import { AgentTimeout, DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";
import { executeSupervisedProcess } from "./process-supervisor.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "./process-execution-runtime.js";

const DEFAULT_PROCESS_MAX_BUFFER = 1024 * 1024;

function buildProcessOptions(opts) {
  return {
    cwd: opts.cwd,
    encoding: opts.encoding || "utf8",
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    ...(opts.env && { env: opts.env }),
    ...(opts.signal && { signal: opts.signal }),
  };
}

function failedProcessResult(err, stdout = "", stderr = "") {
  return {
    ok: false,
    status: typeof err.code === "number" ? err.code : 1,
    stdout: String(stdout || ""),
    stderr: String(stderr || err.message || ""),
    signal: err.signal ?? null,
    killed: err.killed ?? false,
    errorCode: typeof err.code === "string" ? err.code : null,
    ...(err.stopEvidence && { stopEvidence: err.stopEvidence }),
    ...(err.processExecutionStopReceipt && { processExecutionStopReceipt: err.processExecutionStopReceipt }),
  };
}

function processAbortError() {
  const error = new Error("The operation was aborted");
  error.code = "ABORT_ERR";
  return error;
}

function rejectedProcessSignal(signal) {
  if (signal != null && !(signal instanceof AbortSignal)) {
    const error = new TypeError("Process signal must be an AbortSignal");
    error.code = "ERR_INVALID_ARG_TYPE";
    return failedProcessResult(error);
  }
  return signal?.aborted ? failedProcessResult(processAbortError()) : null;
}

async function runSignalCommand(cmd, args, opts) {
  try {
    if (opts.signal?.aborted) return failedProcessResult(processAbortError());
    const timeoutMs = opts.timeout == null || opts.timeout === 0 ? new AgentTimeout().toMilliseconds() : opts.timeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      const error = new RangeError("Process timeout must be non-negative and finite");
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    const completed = await executeSupervisedProcess(cmd, args, {
      cwd: opts.cwd, env: opts.env, stdio: opts.stdio,
      stdinContent: opts.input, abortSignal: opts.signal,
      abortReason: processAbortError,
      maxBuffer: opts.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
      encoding: opts.encoding || "utf8", timeoutMs,
      graceMs: DEFAULT_AGENT_PROCESS_TREE_GRACE_MS, waitForProcessTree: true,
      stopOnStdinError: true,
    });
    const { code, signal, stdout, stderr } = completed;
    if (code === 0 && signal === null) {
      return { ok: true, status: 0, stdout, stderr, signal: null, killed: false };
    }
    const error = new Error(`Command failed: ${cmd}`);
    error.code = code;
    error.signal = signal;
    return failedProcessResult(error, stdout, stderr);
  } catch (error) {
    return failedProcessResult(error, error.stdout, error.stderr);
  }
}

/**
 * Run a command synchronously.
 *
 * Pure command runner: no domain-specific logging is performed here.
 * For git command logging, callers should use `runGit` from `git-helpers.js`.
 *
 * @param {string}   cmd  - Command to execute
 * @param {string[]} args - Argument array
 * @param {Object}   [opts]
 * @param {string}   [opts.cwd]       - Working directory
 * @param {string}   [opts.encoding]  - Encoding (default: "utf8"); use "buffer" to preserve raw bytes
 * @param {number}   [opts.timeout]   - Timeout in ms
 * @param {number}   [opts.maxBuffer] - Max stdout/stderr buffer size in bytes
 * @param {Object}   [opts.env]       - Environment variables
 * @param {Array}    [opts.stdio]     - Standard streams and inherited descriptors
 * @param {string|Buffer} [opts.input] - Data to write to stdin
 * @returns {{ ok: boolean, status: number, stdout: string|Buffer, stderr: string|Buffer, signal: string|null, killed: boolean, errorCode: string|null }}
 */
export function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    ...buildProcessOptions(opts),
    ...(opts.stdio && { stdio: opts.stdio }),
    ...(opts.input !== undefined && { input: opts.input }),
  });
  const preserveBytes = opts.encoding === "buffer";
  const stdout = preserveBytes
    ? (Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.alloc(0))
    : String(res.stdout || "");
  const stderrSource = res.stderr && res.stderr.length > 0 ? res.stderr : res.error?.message || "";
  const stderr = preserveBytes
    ? (Buffer.isBuffer(stderrSource) ? stderrSource : Buffer.from(String(stderrSource), "utf8"))
    : String(stderrSource);
  return {
    ok: res.status === 0 && !res.signal,
    status: res.status ?? 1,
    stdout,
    stderr,
    signal: res.signal ?? null,
    killed: Boolean(res.error && res.error.code === "ETIMEDOUT"),
    errorCode: typeof res.error?.code === "string" ? res.error.code : null,
  };
}

/**
 * Run a command asynchronously.
 *
 * @param {string}   cmd  - Command to execute
 * @param {string[]} args - Argument array
 * @param {Object}   [opts]
 * @param {string}   [opts.cwd]       - Working directory
 * @param {string}   [opts.encoding]  - Encoding (default: "utf8")
 * @param {number}   [opts.timeout]   - Timeout in ms
 * @param {number}   [opts.maxBuffer] - Max stdout/stderr buffer size in bytes
 * @param {Object}   [opts.env]       - Environment variables
 * @param {AbortSignal} [opts.signal] - Cancel the asynchronous command
 * @returns {Promise<{ ok: boolean, status: number, stdout: string, stderr: string, signal: string|null, killed: boolean, errorCode?: string|null }>}
 */
export function runCmdAsync(cmd, args, opts = {}) {
  const rejected = rejectedProcessSignal(opts.signal);
  if (rejected) return Promise.resolve(rejected);
  if (ProcessExecutionRuntime.current()) return runManagedCmdAsync(cmd, args, opts);
  if (opts.signal || opts.stdio || opts.input !== undefined) return runSignalCommand(cmd, args, opts);
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        buildProcessOptions(opts),
        (err, stdout, stderr) => {
          let result;
          if (err) {
            result = failedProcessResult(err, stdout, stderr);
          } else {
            result = {
              ok: true,
              status: 0,
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
              signal: null,
              killed: false,
            };
          }
          resolve(result);
        },
      );
    } catch (error) {
      resolve(failedProcessResult(error));
    }
  });
}

/** Asynchronous command boundary for Review and other managed CLI children. */
export async function runManagedCmdAsync(cmd, args, opts = {}) {
  const rejected = rejectedProcessSignal(opts.signal);
  if (rejected) return rejected;
  const { executeManagedProcess, withManagedProcessScope } = await import("./managed-process.js");
  return withManagedProcessScope({ executionRoot: process.cwd() }, async (runtime) => {
    if (!runtime) return runCmdAsync(cmd, args, opts);
    try {
      const completed = await executeManagedProcess(cmd, args, {
        runtime, kind: "command", cwd: opts.cwd, env: opts.env,
        processExecutionBinding: opts.processExecutionBinding,
        onProcessExecutionStop: opts.onProcessExecutionStop,
        stdio: opts.stdio, stdinContent: opts.input, abortSignal: opts.signal,
        timeoutMs: opts.timeout || new AgentTimeout().toMilliseconds(),
        maxBuffer: opts.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER,
      });
      if (completed.code === 0 && !completed.signal && !completed.stdinError) {
        return { ok: true, status: 0, stdout: completed.stdout, stderr: completed.stderr,
          signal: null, killed: false, stopEvidence: completed.stopEvidence,
          processExecutionStopReceipt: completed.processExecutionStopReceipt };
      }
      const error = new Error(`Command failed: ${cmd}`);
      error.code = completed.code;
      error.signal = completed.signal;
      error.stopEvidence = completed.stopEvidence;
      error.processExecutionStopReceipt = completed.processExecutionStopReceipt;
      return failedProcessResult(error, completed.stdout, completed.stderr);
    } catch (error) {
      if (error instanceof ProcessExecutionControlFailure) throw error;
      return failedProcessResult(error, error.stdout, error.stderr);
    }
  });
}

/**
 * Format a runCmd/runCmdAsync result into a human-readable error string.
 * Context prefix is the caller's responsibility (e.g. `"docs build failed: " + formatError(res)`).
 *
 * @param {{ status: number, stderr: string, signal: string|null, killed: boolean }} res
 * @returns {string} e.g. "signal=SIGKILL (killed) | exit=137 | Killed" or "exit=1"
 */
export function formatError(res) {
  const parts = [];
  if (res.signal) {
    parts.push(`signal=${res.signal}${res.killed ? " (killed)" : ""}`);
  }
  parts.push(`exit=${res.status}`);
  if (res.stderr) {
    parts.push(res.stderr);
  }
  return parts.join(" | ");
}

/**
 * Assert that a runCmd/runCmdAsync result is ok. Throws if not.
 *
 * @param {{ ok: boolean, status: number, stderr: string, signal: string|null, killed: boolean }} res
 * @param {string} context - Description of what failed (e.g. "git push")
 * @throws {Error} if res.ok is false
 */
export function assertOk(res, context) {
  if (!res.ok) throw new Error(context + ": " + formatError(res));
}
