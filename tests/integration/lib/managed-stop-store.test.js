import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { ManagedStopOperation, managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { RepositoryLockAuthority } from "../../../src/lib/repository-control-lock.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t, { cleanup = true } = {}) {
  const root = createTmpDir("managed-stop-lock-");
  if (cleanup) t.after(() => removeTmpDir(root));
  const call = { executionId: randomUUID(), callId: randomUUID(), ownerToken: randomUUID(), capability: randomUUID(),
    outcomePath: path.join(root, "outcome.json"), recordLocks: new RepositoryLockAuthority(root) };
  return { root, call, store: new ManagedStopOperationStore(call) };
}

for (const stage of ["authority", "operation-read"]) {
  test(`stop operation bounds ${stage} contention by its remaining deadline`, async (t) => {
    const { root, call, store } = fixture(t, { cleanup: false });
    const lockURL = JSON.stringify(new URL("../../../src/lib/file-lock.js", import.meta.url).href);
    const authorityURL = JSON.stringify(new URL("../../../src/lib/repository-control-lock.js", import.meta.url).href);
    const authority = stage === "authority" ? { executionId: call.executionId, callId: call.callId } : { file: store.file };
    const owner = spawn(process.execPath, ["--input-type=module", "-e", `
      import {FileLock} from ${lockURL};
      import {RepositoryLockAuthority} from ${authorityURL};
      const root=new RepositoryLockAuthority(${JSON.stringify(root)});
      const location=root.location({namespace:${JSON.stringify(stage === "authority" ? "managed-stop-operation" : "managed-process-record")},
        identity:${JSON.stringify(store.file)},fileName:${JSON.stringify(stage === "authority" ? "authority.lock" : "record.lock")}});
      const lock=new FileLock({location,kind:${JSON.stringify(stage === "authority" ? "managed-stop-operation" : "managed-process-record")},
        authority:${JSON.stringify(authority)}});
      lock.acquire();process.send('locked');
      process.on('message',()=>{lock.release();process.disconnect()});
    `], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let diagnostic = ""; owner.stderr.on("data", (bytes) => { diagnostic += bytes; });
    t.after(async () => {
      try {
        if (owner.exitCode === null && owner.signalCode === null) {
          const exited = once(owner, "exit"); owner.send("release"); await exited;
        }
      } finally { removeTmpDir(root); }
    });
    const [ready] = await once(owner, "message"); assert.equal(ready, "locked", diagnostic);
    // A caller may clip the finite stop budget; it cannot extend that budget.
    const initial = ManagedStopOperation.begin({ graceMs: 100 });
    const operation = new ManagedStopOperation({ ...initial.toJSON(), deadline: initial.startedAt + 100 });
    const before = operation.toJSON(), started = managedMonotonicNow();
    assert.throws(() => store.claim(operation), { code: "PROCESS_EXECUTION_STOP_UNPROVEN" });
    assert.ok(managedMonotonicNow() - started < 1000, "contention cannot consume the independent five-second default lock budget");
    assert.deepEqual(operation.toJSON(), before);
    assert.equal(fs.existsSync(store.file), false, "a failed authority claim cannot publish a stop operation");
    assert.equal(fs.existsSync(`${store.file}.lock`), false, "record locks stay in the common repository namespace");
    assert.equal(fs.existsSync(`${store.file}.authority.lock`), false);
    const exited = once(owner, "exit"); owner.send("release"); await exited;
  });
}

test("the first durable stop operation survives reload without a renewed deadline or reason", (t) => {
  const { root, call, store } = fixture(t);
  const first = ManagedStopOperation.begin({ reason: "abort", graceMs: 100 });
  assert.deepEqual(store.claim(first).toJSON(), first.toJSON());
  const saved = fs.readFileSync(store.file);
  const reload = new ManagedStopOperationStore(call);
  assert.deepEqual(reload.read().toJSON(), first.toJSON());
  const later = ManagedStopOperation.begin({ reason: "timeout", graceMs: 5000 });
  assert.deepEqual(reload.claim(later).toJSON(), first.toJSON());
  assert.deepEqual(fs.readFileSync(store.file), saved);
  assert.ok(reload.location.path.startsWith(path.join(root, ".tmp", "runtime", "repository-control")));
});

test("a persisted operation from another clock session is preserved and cannot renew admission", (t) => {
  const { store } = fixture(t);
  const foreign = ManagedStopOperation.begin({ clockSessionId: randomUUID(), reason: "abort", graceMs: 100 });
  // A foreign clock's valid saved fact can be read, but cannot grant a new stop.
  fs.writeFileSync(store.file, JSON.stringify({ executionId: store.call.executionId, callId: store.call.callId,
    ownerToken: store.call.ownerToken, capability: store.call.capability, operation: foreign.toJSON() }));
  const saved = fs.readFileSync(store.file);
  assert.deepEqual(store.read().toJSON(), foreign.toJSON());
  assert.throws(() => store.claim({ reason: "recovery", graceMs: 100 }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_RECORD_UNREADABLE");
    assert.equal(error.cause.code, "PROCESS_EXECUTION_CLOCK_SESSION_UNKNOWN");
    return true;
  });
  assert.deepEqual(fs.readFileSync(store.file), saved);
});
