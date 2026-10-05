/**
 * src/lib/process.js
 *
 * Unified command execution helpers.
 * All functions return result objects — they never throw.
 */

import { spawnSync, execFile } from "child_process";

function buildProcessOptions(opts) {
  return {
    cwd: opts.cwd,
    encoding: opts.encoding || "utf8",
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    ...(opts.env && { env: opts.env }),
  };
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
 * @returns {{ ok: boolean, status: number, stdout: string|Buffer, stderr: string|Buffer, signal: string|null, killed: boolean, errorCode: string|null }}
 */
export function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, buildProcessOptions(opts));
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
 * @returns {Promise<{ ok: boolean, status: number, stdout: string, stderr: string, signal: string|null, killed: boolean, errorCode?: string|null }>}
 */
export function runCmdAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      buildProcessOptions(opts),
      (err, stdout, stderr) => {
        let result;
        if (err) {
          result = {
            ok: false,
            status: typeof err.code === "number" ? err.code : 1,
            stdout: String(stdout || ""),
            stderr: String(stderr || err.message || ""),
            signal: err.signal ?? null,
            killed: err.killed ?? false,
            errorCode: typeof err.code === "string" ? err.code : null,
          };
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
