/**
 * src/lib/process.js
 *
 * Unified command execution helpers.
 * All functions return result objects — they never throw.
 */

import { spawnSync, spawn, execFile } from "child_process";
import { AgentTimeout, DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";

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
  };
}

function processAbortError() {
  const error = new Error("The operation was aborted");
  error.code = "ABORT_ERR";
  return error;
}

class ProcessOutputBuffer {
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
    this.#chunks.push(bytes.subarray(0, remaining));
    this.#bytes += bytes.length;
    return this.#bytes <= this.maximum;
  }

  toString() {
    const bytes = Buffer.concat(this.#chunks);
    return bytes.toString(this.encoding !== "buffer" && Buffer.isEncoding(this.encoding) ? this.encoding : "utf8");
  }
}

async function runSignalCommand(cmd, args, opts) {
  let child;
  let supervisor;
  let abort;
  let stdout;
  let stderr;
  try {
    // Agent depends indirectly on this module through configuration and Git
    // helpers. Load its shared supervisor after module initialization.
    const { ChildProcessSupervisor } = await import("./agent.js");
    if (opts.signal.aborted) return failedProcessResult(processAbortError());
    const encoding = opts.encoding || "utf8";
    stdout = new ProcessOutputBuffer(opts.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER, encoding);
    stderr = new ProcessOutputBuffer(opts.maxBuffer ?? DEFAULT_PROCESS_MAX_BUFFER, encoding);
    const timeoutMs = opts.timeout == null || opts.timeout === 0 ? new AgentTimeout().toMilliseconds() : opts.timeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      const error = new RangeError("Process timeout must be non-negative and finite");
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    supervisor = new ChildProcessSupervisor({
      child,
      timeoutMs,
      graceMs: DEFAULT_AGENT_PROCESS_TREE_GRACE_MS,
      waitForProcessTree: true,
    });
    const collect = (buffer, stream) => (chunk) => {
      if (buffer.append(chunk)) return;
      const error = new Error(`${stream} maxBuffer length exceeded`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      supervisor.abort(error);
    };
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    const completion = supervisor.wait();
    abort = () => supervisor.abort(processAbortError());
    opts.signal.addEventListener("abort", abort, { once: true });
    if (opts.signal.aborted) abort();
    const { code, signal } = await completion;
    const output = stdout.toString();
    const diagnostics = stderr.toString();
    if (code === 0 && signal === null) {
      return { ok: true, status: 0, stdout: output, stderr: diagnostics, signal: null, killed: false };
    }
    const error = new Error(`Command failed: ${cmd}`);
    error.code = code;
    error.signal = signal;
    error.killed = child.killed;
    return failedProcessResult(error, output, diagnostics);
  } catch (error) {
    if (supervisor?.finalAction) {
      error.signal = supervisor.finalAction;
      error.killed = true;
    }
    return failedProcessResult(error, stdout?.toString(), stderr?.toString());
  } finally {
    if (abort) opts.signal.removeEventListener("abort", abort);
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
  if (opts.signal != null && !(opts.signal instanceof AbortSignal)) {
    const error = new TypeError("Process signal must be an AbortSignal");
    error.code = "ERR_INVALID_ARG_TYPE";
    return Promise.resolve(failedProcessResult(error));
  }
  if (opts.signal?.aborted) {
    return Promise.resolve(failedProcessResult(processAbortError()));
  }
  if (opts.signal) return runSignalCommand(cmd, args, opts);
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
