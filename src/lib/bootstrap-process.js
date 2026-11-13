import { spawnSync } from "node:child_process";
import { GitRepositoryPolicy } from "./git-repository-environment.js";

/** Fixed read-only probes needed before normal runtime/root admission exists. */
export function runBootstrapGitProbe(probe, { cwd = process.cwd(), repositoryRoot = null,
  discoveryCeiling = null } = {}) {
  if (!["repository-root", "common-directory"].includes(probe)) throw new TypeError("Unknown bootstrap Git probe");
  const args = probe === "repository-root" ? ["rev-parse", "--show-toplevel"] : ["rev-parse", "--git-common-dir"];
  const gitPolicy = new GitRepositoryPolicy({
    // Discovery honors only the caller-selected project and explicit ceiling.
    // The common-directory probe already receives its selected boundary as cwd.
    repositoryRoot: probe === "common-directory" ? cwd : repositoryRoot,
    discoveryCeiling,
    readOnly: true,
    isolateConfiguration: true,
  });
  const invocation = gitPolicy.invocation(args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const result = spawnSync(invocation.executable, invocation.args, {
    ...invocation.processOptions(),
    shell: false,
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal !== null && result.signal !== undefined) {
    const error = new Error("Read-only Git bootstrap could not complete before runtime admission", { cause: result.error });
    error.code = "PROCESS_EXECUTION_BOOTSTRAP_FAILED";
    throw error;
  }
  return { ok: result.status === 0 && !result.error, status: result.status ?? 1,
    stdout: String(result.stdout ?? ""), stderr: String(result.stderr || result.error?.message || ""),
    signal: result.signal ?? null, killed: false, errorCode: result.error?.code ?? null };
}
