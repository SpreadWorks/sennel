import { spawn } from "node:child_process";
import { once } from "node:events";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

export class InterruptedChildResult {
  constructor(exitCode, stdout, stderr, pid) {
    if (exitCode === 0) throw new Error("checkpoint child completed instead of being interrupted");
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("checkpoint child requires its actual process identity");
    this.interrupted = true;
    this.pid = pid;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    Object.freeze(this);
  }
}

export class ExitedChildResult {
  constructor(exitCode, signal, stdout, stderr, pid) {
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || signal !== null) throw new Error("checkpoint child did not finish normally");
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("checkpoint child requires its actual process identity");
    this.pid = pid;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    Object.freeze(this);
  }
}

export class FailedChildResult extends ExitedChildResult {
  constructor(exitCode, signal, stdout, stderr, pid) {
    if (exitCode === 0) throw new Error("checkpoint child completed instead of failing");
    super(exitCode, signal, stdout, stderr, pid);
  }
  get failed() { return true; }
}

/** The caller owns this child and always waits for its resources to close. */
async function childAtCheckpoint(command, args, { cwd, env, checkpoint, timeout = 30_000 } = {}, interrupt, Result = FailedChildResult) {
  const invocation = new NativeExecutableInvocation({ executable: command, args, cwd, env,
    stdio: ["ignore", "pipe", "pipe"] });
  const child = spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  let timer;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`child did not reach checkpoint within ${timeout}ms: ${stderr}`)), timeout);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes(checkpoint)) resolve();
      });
      child.once("error", reject);
      child.once(interrupt ? "exit" : "close", (code) => {
        if (!interrupt && stdout.includes(checkpoint)) resolve();
        else reject(new Error(`child exited before checkpoint (${code}): ${stderr}`));
      });
    });
    if (interrupt && !child.kill("SIGKILL")) throw new Error("checkpoint child could not be interrupted");
    const [exitCode, signal] = await closed;
    return interrupt ? new InterruptedChildResult(exitCode, stdout, stderr, child.pid)
      : new Result(exitCode, signal, stdout, stderr, child.pid);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

export function interruptChildAtCheckpoint(command, args, options) {
  return childAtCheckpoint(command, args, options, true);
}

export function failedChildAtCheckpoint(command, args, options) {
  return childAtCheckpoint(command, args, options, false);
}

export function exitedChildAtCheckpoint(command, args, options) {
  return childAtCheckpoint(command, args, options, false, ExitedChildResult);
}
