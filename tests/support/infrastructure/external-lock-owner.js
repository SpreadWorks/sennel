import { createTmpDir as createTestDirectory } from "../builders/tmp-dir.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

function waitForFile(filePath, completion) {
  if (fs.existsSync(filePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback) => (value) => {
      if (settled) return;
      settled = true;
      watcher.close();
      callback(value);
    };
    const watcher = fs.watch(path.dirname(filePath), (event, name) => {
      if (event === "rename" && String(name) === path.basename(filePath) && fs.existsSync(filePath)) {
        settle(resolve)();
      }
    });
    watcher.once("error", settle(reject));
    completion.then(
      settle(() => reject(new Error(`external process-lock owner exited before becoming ready: ${filePath}`))),
      settle(reject),
    );
    if (fs.existsSync(filePath)) settle(resolve)();
  });
}

/** A real child-process FileLock owner, synchronized through an isolated support root. */
export class ExternalProcessLockOwner {
  static forFileLock({
    directory,
    fileName,
    kind,
    authority,
    waitPolicy = { timeoutMs: 100, intervalMs: 1 },
  }) {
    return new ExternalProcessLockOwner({ directory, fileName, kind, authority, waitPolicy });
  }

  constructor({ directory, fileName, kind, authority, waitPolicy }) {
    this.supportRoot = createTestDirectory("sennel-external-lock-owner-");
    this.readyPath = path.join(this.supportRoot, "ready");
    this.stderr = "";
    this.stdinError = null;
    const invocation = new NativeExecutableInvocation({ executable: process.execPath,
      args: [fileURLToPath(new URL("./external-lock-owner-worker.mjs", import.meta.url)),
        JSON.stringify({ directory, fileName, kind, authority, waitPolicy, readyPath: this.readyPath })],
      stdio: ["pipe", "ignore", "pipe"] });
    this.child = spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdin.on("error", (error) => { this.stdinError ??= error; });
    this.completion = new Promise((resolve, reject) => {
      this.child.once("error", (error) => reject(this.#failure(`could not start: ${error.message}`)));
      this.child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(this.#failure(`exited ${code ?? signal}`));
      });
    });
    // A test may fail before observing readiness; its teardown will await the
    // same promise, while this handler prevents an early child failure from
    // becoming an unhandled rejection.
    this.completion.catch(() => {});
    this.releasePromise = null;
  }

  waitUntilReady() {
    return waitForFile(this.readyPath, this.completion);
  }

  release() {
    if (this.releasePromise === null) this.releasePromise = this.#release();
    return this.releasePromise;
  }

  async #release() {
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end("release\n");
      await this.completion;
      if (this.stdinError !== null) throw this.#failure(`release channel failed: ${this.stdinError.message}`);
    } finally {
      fs.rmSync(this.supportRoot, { recursive: true, force: true });
    }
  }

  #failure(detail) {
    const stderr = this.stderr.trim();
    const stdin = this.stdinError?.message ?? null;
    return new Error(`external process-lock owner ${detail}${stdin ? `\nstdin: ${stdin}` : ""}${stderr ? `\nstderr:\n${stderr}` : ""}`);
  }
}
