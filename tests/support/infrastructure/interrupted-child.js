import { spawn } from "node:child_process";
import { once } from "node:events";

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

/** The caller owns this child and always waits for its resources to close. */
export async function interruptChildAtCheckpoint(command, args, { cwd, env, checkpoint, timeout = 30_000 } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
      child.once("exit", (code) => reject(new Error(`child exited before checkpoint (${code}): ${stderr}`)));
    });
    if (!child.kill("SIGKILL")) throw new Error("checkpoint child could not be interrupted");
    const [exitCode] = await closed;
    return new InterruptedChildResult(exitCode, stdout, stderr, child.pid);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}
