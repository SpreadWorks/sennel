import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { LinuxProcessStat, ProcessIdentity, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { readManagedRecord } from "../../../src/lib/managed-process-protocol.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { awaitRuntimeBarrier } from "../../support/infrastructure/process-runtime-flow-scenario.js";

async function fixture(t) {
  const root = createTmpDir("managed-direct-birth-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, runId: "direct-birth", specId: "direct-birth" });
  t.after(async () => {
    try { if (!runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  return { root, runtime };
}

test("an immediately escaping directly owned provider refuses stop proof before its natural exit", async (t) => {
  assert.equal(fs.existsSync("/usr/bin/setsid"), true, "Linux direct escape fixture requires setsid");
  const root = createTmpDir("managed-direct-escape-");
  const ready = path.join(root, "provider-ready.json");
  const ended = path.join(root, "provider-ended");
  const cleanup = path.join(root, "assertions-complete");
  const wrapper = path.join(root, "finite-launcher.mjs");
  let runtime;
  let launcherProcess;
  let launcherExit = Promise.resolve();
  let invocation = null;
  // Only teardown enables this fixture's autonomous anchor exit. The real
  // provider exits after three seconds; no fixture sends a manual signal.
  t.after(async () => {
    fs.writeFileSync(cleanup, "complete");
    try {
      if (invocation !== null) await invocation;
      await awaitRuntimeBarrier(ended, 15000);
      launcherProcess?.ref();
      await launcherExit;
      if (runtime !== undefined && !runtime.closed) {
        const call = runtime.inspect().executions.at(-1).calls[0];
        if (call.controlFailure !== null) {
          await assert.rejects(runtime.close(), ProcessExecutionControlFailure);
        } else await runtime.close();
      }
    } finally { removeTmpDir(root); }
  });
  fs.writeFileSync(wrapper, [
    `import fs from "node:fs";`,
    `import { ManagedLauncher } from ${JSON.stringify(new URL("../../../src/lib/managed-process-launcher.js", import.meta.url).href)};`,
    `let input=""; for await (const bytes of process.stdin) input+=bytes;`,
    `const launcher=new ManagedLauncher(JSON.parse(input));`,
    `let finishing=false;`,
    `const observeTeardown=()=>{`,
    `  if(!finishing&&fs.existsSync(${JSON.stringify(cleanup)})){`,
    `    finishing=true;`,
    `    const finish=()=>{if(!launcher.child||launcher.childClosed)process.exit(0);};`,
    `    setInterval(finish,20);`,
    `    setTimeout(()=>process.exit(1),10000);`,
    `    finish();`,
    `  }`,
    `};`,
    `fs.watch(${JSON.stringify(root)},observeTeardown);`,
    `await launcher.run(); observeTeardown();`,
  ].join("\n"));
  const originalSpawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (args[0]?.endsWith("/managed-process-launcher.js")) {
      const child = originalSpawn(command, [wrapper, ...args.slice(1)], options);
      launcherProcess = child;
      launcherExit = once(child, "close");
      return child;
    }
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, runId: "direct-escape", specId: "direct-escape" });
  const provider = [
    `const fs=require("node:fs");`,
    `fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,stat:fs.readFileSync("/proc/"+process.pid+"/stat","utf8")}));`,
    `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(ended)},"natural exit");process.exit(0);},3000);`,
  ].join("\n");
  const abort = new AbortController();
  invocation = runtime.enter(() => executeManagedProcess("/usr/bin/setsid", [process.execPath, "-e", provider],
    { cwd: root, timeoutMs: 20000, graceMs: 100, maxBuffer: 1024, abortSignal: abort.signal }))
    .then((result) => ({ result }), (error) => ({ error }));
  await awaitRuntimeBarrier(ready, 10000);
  abort.abort(new Error("fixture abort after actual provider startup"));
  const outcome = await invocation;
  const started = JSON.parse(fs.readFileSync(ready, "utf8"));
  const birth = LinuxProcessStat.parse(started.stat);
  const live = LinuxProcessStat.parse(fs.readFileSync(`/proc/${started.pid}/stat`, "utf8"));
  assert.equal(live.startFingerprint, birth.startFingerprint);
  assert.notEqual(live.state, "Z", "the direct escaped provider must still be running at refusal");
  assert.equal(fs.existsSync(ended), false, "stop refusal must precede the provider's natural exit");
  assert.ok(outcome.error instanceof ProcessExecutionControlFailure,
    `escaped direct provider became an ordinary result: ${outcome.error?.name ?? "success"}`);
  assert.equal(outcome.error.code, "PROCESS_EXECUTION_IDENTITY_UNKNOWN");
  const inventory = runtime.inspect();
  const execution = inventory.executions.at(-1);
  const call = execution.calls[0];
  assert.equal(inventory.slot, runtime.executionId);
  assert.equal(call.receipt, null, "anchor termination alone must never become a stop receipt");
  assert.notEqual(live.pgrp, call.pgid);
  const record = readManagedRecord(path.join(runtime.store.callDirectory(call.callId), "outcome.json"));
  const known = record.members.find((member) => member.pid === started.pid);
  assert.ok(known, "native child birth must be durable even before any group enumeration sees it");
  assert.equal(known.startFingerprint, String(birth.startFingerprint));
  assert.equal(new ProcessIdentitySource().assess(new ProcessIdentity(known)).status, "live");
  assert.equal(record.controlFailure.code, "PROCESS_EXECUTION_IDENTITY_UNKNOWN");
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
  assert.equal(runtime.inspect().executions.at(-1).calls[0].receipt, null);
});

test("a normal fast directly owned provider retains its exact birth in the confirmed receipt", async (t) => {
  const { root, runtime } = await fixture(t);
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e",
    'const fs=require("node:fs");process.stdout.write(JSON.stringify({pid:process.pid,stat:fs.readFileSync("/proc/"+process.pid+"/stat","utf8")}));'],
  { cwd: root, timeoutMs: 20000, graceMs: 100, maxBuffer: 1024 }));
  const output = JSON.parse(result.stdout);
  const birth = LinuxProcessStat.parse(output.stat);
  const receipt = result.processExecutionStopReceipt;
  assert.equal(receipt.stopEvidence.confirmed, true);
  const member = receipt.members.find((entry) => entry.pid === output.pid);
  assert.ok(member, "the direct provider is part of the physical stop proof");
  assert.equal(member.startFingerprint, String(birth.startFingerprint));
  assert.equal(new ProcessIdentitySource().assess(member).status, "stale");
  await runtime.close();
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root }).slot, null);
});
