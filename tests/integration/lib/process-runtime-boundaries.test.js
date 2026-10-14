import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { LinuxProcessStat, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { readManagedRecord } from "../../../src/lib/managed-process-protocol.js";
import { requestManagedLauncherStop } from "../../../src/lib/managed-process.js";
import { awaitRuntimeBarrier } from "../../support/infrastructure/process-runtime-flow-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const moduleURL = (name) => pathToFileURL(path.resolve(`src/lib/${name}.js`)).href;
const bootstrap = pathToFileURL(path.resolve("src/sennel.js")).href;
const source = new ProcessIdentitySource();

function fixture(t, boundary, { providerCode = null } = {}) {
  const root = createTmpDir(`runtime-${boundary}-`, { parent: path.resolve(".tmp/c2f6/crash-fixtures") });
  const options = { mainRoot: root, executionRoot: root, runId: "crash-run", specId: "crash-spec" };
  const key = crypto.createHash("sha256").update(JSON.stringify(root)).digest("hex");
  const registryFile = path.join(root, ".sennel", "process-runtime", key, "registry.json");
  const barrier = path.join(root, "coordinator-paused"), effect = path.join(root, "provider-effects");
  const protectedFile = path.join(root, "protected-state.json");
  fs.writeFileSync(protectedFile, '{"attempt":1,"generation":1,"semanticBudget":0}');
  const protectedBytes = fs.readFileSync(protectedFile);
  let child;
  const owned = [];
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
      for (const runtime of owned) if (!runtime.closed) await runtime.close();
      if (fs.existsSync(registryFile)) {
        const registry = JSON.parse(fs.readFileSync(registryFile)).payload;
        for (const execution of registry.executions) for (const call of execution.calls) {
          const callDirectory = path.join(path.dirname(registryFile), "calls", call.callId);
          const record = readManagedRecord(path.join(callDirectory, "outcome.json")) || readManagedRecord(path.join(callDirectory, "hello.json"));
          if (record && source.assess(record.launcherIdentity).status === "live") {
            try { await requestManagedLauncherStop({ ...record, directory: callDirectory, outcomePath: path.join(callDirectory, "outcome.json"), helloPath: path.join(callDirectory, "hello.json") }); }
            catch (error) {
              // Only fixture-owned real birth identities may be torn down.
              for (const member of record.members) if (source.assess(member).status === "live") process.kill(member.pid, "SIGKILL");
            }
          }
        }
      }
    } finally { removeTmpDir(root); }
  });
  const actualProviderCode = typeof providerCode === "function" ? providerCode({ root, effect })
    : providerCode ?? `require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'effect\\n'); process.stdout.write('completed');`;
  const script = path.join(root, "coordinator.mjs");
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import {AtomicFile} from ${JSON.stringify(moduleURL("atomic-file"))};
    import {ProcessExecutionRuntime} from ${JSON.stringify(moduleURL("process-execution-runtime"))};
    import {executeManagedProcess} from ${JSON.stringify(moduleURL("managed-process"))};
    const boundary=${JSON.stringify(boundary)};
    function pause(name, event={}) {
      if(name!==boundary)return;
      new AtomicFile(${JSON.stringify(barrier)}).write(JSON.stringify(event));
      process.kill(process.pid,'SIGSTOP');
    }
    const runtime=await ProcessExecutionRuntime.acquire({...${JSON.stringify(options)},faultInjector(event){
      if(event.phase!=='after-runtime-readback')return;
      const root=JSON.parse(fs.readFileSync(event.filePath)).payload.executions.at(-1);
      const call=root?.calls.at(-1);
      if(call?.status==='registered')pause('registered-before-permit',{callId:call.callId});
      if(call?.status==='running')pause('permit-before-ipc',{callId:call.callId});
      if(call?.receipt&&root.status==='active')pause('receipt-before-closure',{callId:call.callId});
    }});
    await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',${JSON.stringify(actualProviderCode)}],{
      cwd:${JSON.stringify(root)},timeoutMs:120000,graceMs:200,maxBuffer:1024,
      onSupervisorEvent(event){pause(event.type,event)},
      onStdout(output){if(output.includes('provider-ready'))pause('known-escape')},
    }));
    await runtime.close();
    throw new Error('Requested crash boundary was not observed');
  `);
  return {
    root, options, registryFile, effect, protectedFile, protectedBytes,
    async start() {
      const reached = awaitRuntimeBarrier(barrier, 90000);
      child = spawn(process.execPath, ["--import", bootstrap, script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
      await Promise.race([reached, once(child, "exit").then(([code, signal]) => { throw new Error(`Coordinator exited before ${boundary}: ${code}/${signal}: ${stderr}`); })]);
      return JSON.parse(fs.readFileSync(barrier));
    },
    async kill() { const exited = once(child, "exit"); child.kill("SIGKILL"); const [, signal] = await exited; assert.equal(signal, "SIGKILL"); },
    effects() { return fs.existsSync(effect) ? fs.readFileSync(effect, "utf8").trim().split("\n").length : 0; },
    assertProtected() { assert.deepEqual(fs.readFileSync(protectedFile), protectedBytes); },
    async acquire(extra = {}) { const runtime = await ProcessExecutionRuntime.acquire({ ...options, ...extra }); owned.push(runtime); return runtime; },
  };
}

// Each barrier lies on the real reserve/spawn/hello/authorize/permit/settle path.
// The coordinator is SIGKILLed after persisted evidence, then recovery reconstructs
// the manager from disk. Intent without a birth record is an explicit refusal;
// authenticated waiting or finished launchers close only after real OS proof.
test("every durable managed-call crash boundary preserves admission and prevents duplicate provider effects", async (t) => {
  for (const [boundary, expectedEffects, recoverable] of [
    ["intent", 0, false], ["launcher-created", 0, false], ["launcher-hello", 0, true],
    ["registered-before-permit", 0, true], ["permit-before-ipc", 0, true],
    ["provider-settled", 1, true], ["receipt-before-closure", 1, true],
  ]) {
    await t.test(boundary, async (t) => {
      const value = fixture(t, boundary); await value.start();
      const before = ProcessExecutionRuntime.inspect(value.options);
      const oldId = before.slot; assert.equal(before.executions[0].calls.length, 1);
      assert.equal(value.effects(), expectedEffects); value.assertProtected();
      await value.kill();
      if (recoverable) {
        const successor = await value.acquire();
        const saved = successor.inspect().executions.find((execution) => execution.executionId === oldId);
        assert.equal(saved.status, "closed");
        assert.equal(saved.calls[0].receipt.stopEvidence.status, "confirmed");
        assert.equal(saved.calls[0].receipt.callId, before.executions[0].calls[0].callId);
        assert.equal(saved.closure.recovery, true);
        assert.equal(successor.ownerEpoch, 2);
        await successor.close();
      } else {
        await assert.rejects(value.acquire(), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_STOP_UNCONFIRMED");
        const saved = ProcessExecutionRuntime.inspect(value.options);
        assert.equal(saved.slot, oldId); assert.equal(saved.ownerEpoch, 1);
        assert.equal(saved.executions[0].calls[0].receipt, null);
      }
      assert.equal(value.effects(), expectedEffects); value.assertProtected();
    });
  }
});

test("reuse, foreign boot, permission denial, and unknown launcher birth refuse recovery without unrelated signals", async (t) => {
  const value = fixture(t, "permit-before-ipc"); await value.start();
  const before = ProcessExecutionRuntime.inspect(value.options);
  const launcher = before.executions[0].calls[0].launcherIdentity;
  await value.kill();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(async () => { if (unrelated.exitCode === null && unrelated.signalCode === null) { const exited = once(unrelated, "exit"); unrelated.kill("SIGKILL"); await exited; } });
  const signals = [];
  const originalKill = process.kill;
  const mock = t.mock.method(process, "kill", function(pid, signal) { signals.push({ pid, signal }); return originalKill.call(process, pid, signal); });
  for (const reason of ["reuse", "boot", "permission", "unknown"]) {
    const identitySource = new ProcessIdentitySource({
      readBootIdentity: () => reason === "boot" ? crypto.randomUUID() : source.readBootIdentity(),
      readProcessStartFingerprint(pid) {
        if (pid !== launcher.pid) return source.readProcessStartFingerprint(pid);
        if (reason === "reuse") return String(Number(launcher.startFingerprint) + 1);
        if (reason === "permission" || reason === "unknown") { const error = new Error(reason); error.code = reason === "permission" ? "EACCES" : "EIO"; throw error; }
        return source.readProcessStartFingerprint(pid);
      },
    });
    await assert.rejects(value.acquire({ processIdentitySource: identitySource }), (error) => error instanceof ProcessExecutionControlFailure);
    const saved = ProcessExecutionRuntime.inspect(value.options);
    assert.equal(saved.slot, before.slot); assert.equal(saved.ownerEpoch, 1);
    assert.equal(saved.executions[0].calls[0].receipt, null);
    assert.equal(value.effects(), 0); value.assertProtected();
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  }
  mock.mock.restore();
  assert.ok(signals.every((entry) => entry.signal === 0));
  assert.ok(signals.every((entry) => entry.pid !== unrelated.pid));
  // Teardown uses authenticated real launcher facts, not injected assessments.
});

test("an explicit foreign run or specification cannot stop a dead owner's waiting launcher, while checkout maintenance can", async (t) => {
  const value = fixture(t, "permit-before-ipc"); await value.start();
  const before = ProcessExecutionRuntime.inspect(value.options);
  const launcher = before.executions[0].calls[0].launcherIdentity;
  const registryBytes = fs.readFileSync(value.registryFile);
  await value.kill();
  const signals = [], originalKill = process.kill;
  const mock = t.mock.method(process, "kill", function(pid, signal) { signals.push({ pid, signal }); return originalKill.call(process, pid, signal); });
  for (const incoming of [{ runId: "foreign-run" }, { specId: "foreign-spec" }]) {
    await assert.rejects(value.acquire(incoming), (error) => error instanceof ProcessExecutionControlFailure
      && error.code === "PROCESS_EXECUTION_BINDING_MISMATCH" && error.executionId === before.slot);
    assert.deepEqual(fs.readFileSync(value.registryFile), registryBytes);
    assert.equal(source.assess(launcher).status, "live");
    assert.equal(value.effects(), 0); value.assertProtected();
  }
  mock.mock.restore();
  assert.ok(signals.every((entry) => entry.signal === 0));
  assert.ok(signals.every((entry) => entry.pid !== launcher.pid && entry.pid !== -launcher.pid));
  const maintenance = await value.acquire({ runId: null, specId: null });
  const stopped = maintenance.inspect().executions.find((execution) => execution.executionId === before.slot);
  assert.equal(stopped.status, "closed"); assert.equal(stopped.closure.recovery, true);
  assert.equal(stopped.calls[0].receipt.stopEvidence.status, "confirmed");
  assert.equal(maintenance.ownerEpoch, 2);
  assert.equal(source.assess(launcher).status, "stale");
  assert.equal(value.effects(), 0); value.assertProtected();
  await maintenance.close();
});

// The shell is first observed by the production launcher in its own group;
// after a persisted release it execs setsid without forking, preserving birth.
test("a real known member escaping its registered group blocks orphan admission and receives no manager stop signal", async (t) => {
  assert.equal(fs.existsSync("/usr/bin/setsid"), true, "Linux process escape fixture requires the system setsid utility");
  let spawned, release, escaped;
  const value = fixture(t, "known-escape", { providerCode({ root }) {
    spawned = path.join(root, "escape-spawned"); release = path.join(root, "escape-release"); escaped = path.join(root, "escape-confirmed");
    const escapedCode = `import(${JSON.stringify(moduleURL("atomic-file"))}).then(({AtomicFile})=>{new AtomicFile(${JSON.stringify(escaped)}).write(String(process.pid));setInterval(()=>{},1000)})`;
    return `
      const fs=require('node:fs'),{spawn}=require('node:child_process');
      const shell=spawn('/bin/sh',['-c','read token; exec "$SET_SID" "$NODE_BINARY" -e "$ESCAPED_SCRIPT"'],{
        stdio:['pipe','ignore','ignore'],env:{...process.env,SET_SID:'/usr/bin/setsid',NODE_BINARY:process.execPath,ESCAPED_SCRIPT:${JSON.stringify(escapedCode)}}});
      fs.writeFileSync(${JSON.stringify(spawned)},String(shell.pid));
      let released=false;
      fs.watch(${JSON.stringify(root)},()=>{if(!released&&fs.existsSync(${JSON.stringify(release)})){released=true;shell.stdin.end('go\\n')}});
      process.stdout.write('provider-ready');
      setInterval(()=>{},1000);
    `;
  } });
  await value.start();
  const saved = ProcessExecutionRuntime.inspect(value.options), call = saved.executions[0].calls[0];
  const shellPid = Number(fs.readFileSync(spawned, "utf8"));
  const outcomePath = path.join(path.dirname(value.registryFile), "calls", call.callId, "outcome.json");
  const awaitRecordedMember = () => new Promise((resolve, reject) => {
    let watcher;
    const check = () => {
      try {
        const record = readManagedRecord(outcomePath);
        const member = record?.members.find((entry) => entry.pid === shellPid);
        if (member) { clearTimeout(timer); watcher?.close(); resolve(member); }
      } catch (error) { clearTimeout(timer); watcher?.close(); reject(error); }
    };
    const timer = setTimeout(() => { watcher?.close(); reject(new Error("production launcher did not record the waiting member")); }, 90000);
    watcher = fs.watch(path.dirname(outcomePath), check); check();
  });
  const member = await awaitRecordedMember();
  const escapedBarrier = awaitRuntimeBarrier(escaped, 90000);
  new AtomicFile(release).write("go");
  await escapedBarrier;
  assert.equal(Number(fs.readFileSync(escaped)), shellPid);
  const stat = LinuxProcessStat.parse(fs.readFileSync(`/proc/${shellPid}/stat`, "utf8"));
  assert.equal(stat.pgrp, shellPid); assert.notEqual(stat.pgrp, call.pgid);
  assert.equal(String(stat.startFingerprint), member.startFingerprint);
  await value.kill();
  const signals = [], originalKill = process.kill;
  const mock = t.mock.method(process, "kill", function(pid, signal) { signals.push({ pid, signal }); return originalKill.call(process, pid, signal); });
  await assert.rejects(value.acquire(), (error) => error instanceof ProcessExecutionControlFailure);
  mock.mock.restore();
  assert.ok(signals.every((entry) => entry.signal === 0));
  assert.ok(signals.every((entry) => entry.pid !== shellPid && entry.pid !== -shellPid));
  const refused = ProcessExecutionRuntime.inspect(value.options);
  assert.equal(refused.slot, saved.slot); assert.equal(refused.ownerEpoch, 1);
  assert.equal(refused.executions[0].calls[0].receipt, null);
  assert.equal(source.assess(member).status, "live"); value.assertProtected();
});
