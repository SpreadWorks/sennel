import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

/** A real Prepare process that exits at a published checkpoint without unwinding. */
export class PrepareProcess {
  constructor({ input, environment }) {
    assert.equal(typeof input.root, "string");
    assert.equal(typeof input.runId, "string");
    assert.equal(input.worktree, true);
    this.input = input;
    this.environment = environment;
  }

  interruptAfterWorktreeAdd() {
    const bootstrap = new URL("../../../src/sennel.js", import.meta.url).href;
    const worker = fileURLToPath(new URL("./prepare-process-worker.mjs", import.meta.url));
    const invocation = new NativeExecutableInvocation({ executable: process.execPath,
      args: ["--import", bootstrap, worker, JSON.stringify(this.input)], cwd: this.input.root,
      env: this.environment, stdio: ["ignore", "pipe", "pipe"] });
    // spawnSync reaps the terminated owner; its timeout also bounds cleanup if
    // a regression prevents the requested production checkpoint from being reached.
    const result = spawnSync(invocation.executable, invocation.args, { ...invocation.processOptions(),
      shell: false, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 73, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
}
