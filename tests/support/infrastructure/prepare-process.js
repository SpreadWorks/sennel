import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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
    const managerModule = new URL("../../../src/lib/flow-manager.js", import.meta.url).href;
    const commandModule = new URL("../../../src/flow/lib/run-prepare-spec.js", import.meta.url).href;
    const script = [
      'import fs from "node:fs";',
      `import { FlowManager } from ${JSON.stringify(managerModule)};`,
      `import RunPrepareSpecCommand from ${JSON.stringify(commandModule)};`,
      `const input = ${JSON.stringify(this.input)};`,
      "const flowManager = new FlowManager({ root: input.root, mainRoot: input.mainRoot, inWorktree: false });",
      "await new RunPrepareSpecCommand().execute({ ...input, flowManager, worktreePrepareFaultInjector(event) {",
      'if (event.phase !== "after-worktree-add") return;',
      'fs.writeSync(1, JSON.stringify(event));',
      "process.exit(73);",
      "} });",
      'throw new Error("Prepare did not reach after-worktree-add");',
    ].join("\n");
    // spawnSync reaps the terminated owner; its timeout also bounds cleanup if
    // a regression prevents the requested production checkpoint from being reached.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: this.input.root, env: this.environment, encoding: "utf8", timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 73, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
}
