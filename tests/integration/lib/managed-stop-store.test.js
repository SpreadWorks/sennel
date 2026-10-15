import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { ManagedStopOperation, managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { requestManagedLauncherStop } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

for (const stage of ["authority", "operation-read", "outcome-read"]) {
  test(`stop operation bounds ${stage} contention by its remaining deadline`, async (t) => {
    const root = createTmpDir("managed-stop-lock-");
    let runtime, owner;
    t.after(async () => {
      try {
        if (owner && owner.exitCode === null && owner.signalCode === null) {
          const exited = once(owner, "exit"); owner.send("release"); await exited;
        }
        if (runtime && !runtime.closed) await runtime.close();
      } finally { removeTmpDir(root); }
    });
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    const call = await runtime.reserveCall();
    const file = stage === "outcome-read" ? call.outcomePath : `${call.outcomePath}.stop`;
    const suffix = stage === "authority" ? ".authority.lock" : ".lock";
    const lockKind = stage === "authority" ? "managed-stop-operation" : "managed-process-record";
    const lockAuthority = stage === "authority" ? { executionId: call.executionId, callId: call.callId } : { file: path.resolve(file) };
    const lockURL = JSON.stringify(new URL("../../../src/lib/file-lock.js", import.meta.url).href);
    const authorityURL = JSON.stringify(new URL("../../../src/lib/real-directory-authority.js", import.meta.url).href);
    owner = spawn(process.execPath, ["--input-type=module", "-e", `
      import {FileLock} from ${lockURL};
      import {RealDirectoryAuthority} from ${authorityURL};
      const lock=new FileLock({directoryAuthority:new RealDirectoryAuthority(${JSON.stringify(path.dirname(file))}),
        fileName:${JSON.stringify(path.basename(file) + suffix)},kind:${JSON.stringify(lockKind)},authority:${JSON.stringify(lockAuthority)}});
      lock.acquire();process.send('locked');
      process.on('message',()=>{lock.release();process.disconnect()});
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let diagnostic = ""; owner.stderr.on("data", (bytes) => { diagnostic += bytes; });
    const [ready] = await once(owner, "message"); assert.equal(ready, "locked", diagnostic);
    const operation = ManagedStopOperation.begin({ graceMs: 100, now: managedMonotonicNow() - 2100 });
    const before = operation.toJSON(), started = managedMonotonicNow();
    if (stage === "outcome-read") {
      await assert.rejects(requestManagedLauncherStop(call, { operation }), { code: "PROCESS_EXECUTION_RECORD_UNREADABLE" });
    } else {
      assert.throws(() => new ManagedStopOperationStore(call).claim(operation), { code: "PROCESS_EXECUTION_STOP_UNPROVEN" });
    }
    assert.ok(managedMonotonicNow() - started < 1000, "contention cannot consume the independent five-second default lock budget");
    assert.deepEqual(operation.toJSON(), before);
    assert.equal(fs.existsSync(file), false, "a failed authority claim cannot publish a stop operation");
    const exited = once(owner, "exit"); owner.send("release"); await exited;
    await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
    await runtime.close();
  });
}
