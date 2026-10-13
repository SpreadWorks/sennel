import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { runCmd, runCmdAsync } from "../../../src/lib/process.js";
import { LinuxProcessStat } from "../../../src/lib/process-identity.js";

function rootFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-cancellation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function waitForFile(t, file) {
  let watcher;
  let timer;
  t.after(() => { watcher?.close(); clearTimeout(timer); });
  return new Promise((resolve, reject) => {
    const read = () => {
      if (!fs.existsSync(file)) return;
      const contents = fs.readFileSync(file, "utf8");
      if (contents.length === 0) return;
      watcher?.close();
      clearTimeout(timer);
      resolve(contents);
    };
    watcher = fs.watch(path.dirname(file), read);
    timer = setTimeout(() => reject(new Error(`Fixture did not publish ${path.basename(file)}`)), 5_000);
    read();
  });
}

it("synchronous runner delivers stdin, fd3, cwd and task environment to the child", (t) => {
  const root = rootFixture(t);
  const deliveryFile = path.join(root, "delivery");
  fs.writeFileSync(deliveryFile, "parent descriptor data");
  const descriptor = fs.openSync(deliveryFile, "r");
  t.after(() => fs.closeSync(descriptor));
  const input = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const script = [
    "const fs=require('node:fs');",
    "process.stdout.write(JSON.stringify({",
    "cwd:process.cwd(),",
    "taskValue:process.env.SENNEL_TEST_PROCESS_DELIVERY,",
    "stdin:fs.readFileSync(0).toString('hex'),",
    "descriptor:fs.readFileSync(3,'utf8'),",
    "}));",
  ].join("");
  const result = runCmd(process.execPath, ["-e", script], {
    cwd: root,
    env: { ...process.env, SENNEL_TEST_PROCESS_DELIVERY: "scoped-value" },
    input,
    stdio: ["pipe", "pipe", "pipe", descriptor],
  });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: root,
    taskValue: "scoped-value",
    stdin: input.toString("hex"),
    descriptor: "parent descriptor data",
  });
});

it("pre-aborted asynchronous command returns a failed result without dispatch", async (t) => {
  const root = rootFixture(t);
  const marker = path.join(root, "started");
  const controller = new AbortController();
  controller.abort(new Error("run stopped"));
  const result = await runCmdAsync(process.execPath, ["-e",
    "require('node:fs').writeFileSync(process.argv[1], 'started')", marker], { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.errorCode, "ABORT_ERR");
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(marker), false);
});

it("native AbortSignal cancels an awaited command and preserves its result contract", async (t) => {
  const root = rootFixture(t);
  const started = path.join(root, "started");
  const stopped = path.join(root, "stopped");
  const controller = new AbortController();
  let pid = null;
  t.after(() => {
    if (pid === null) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const ready = waitForFile(t, started);
  const stoppedEvidence = waitForFile(t, stopped);
  const execution = runCmdAsync(process.execPath, ["-e", [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => { fs.writeFileSync(process.argv[2], 'SIGTERM'); process.exit(0); });",
    "fs.writeFileSync(process.argv[1], String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join(""), started, stopped], { signal: controller.signal, timeout: 10_000 });
  pid = Number(await ready);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  controller.abort(new Error("run stopped"));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.errorCode, "ABORT_ERR");
  assert.equal(typeof result.stdout, "string");
  assert.equal(typeof result.stderr, "string");
  assert.equal(await stoppedEvidence, "SIGTERM");
});

it("synchronous command setup failures settle as failed results", async () => {
  const result = await runCmdAsync(process.execPath, [], { signal: "invalid signal" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.errorCode, "ERR_INVALID_ARG_TYPE");
});

it("supervised cancellation stops a review subprocess and its descendant before returning", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux process identity readback proves descendant termination");
  const root = rootFixture(t);
  const parentMarker = path.join(root, "parent");
  const childMarker = path.join(root, "child");
  const owned = [];
  t.after(() => {
    for (const pid of owned) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  const controller = new AbortController();
  const ready = waitForFile(t, childMarker);
  const execution = runCmdAsync(process.execPath, ["-e", [
    "const fs=require('node:fs'); const {spawn}=require('node:child_process');",
    "fs.writeFileSync(process.argv[1],String(process.pid));",
    "spawn(process.execPath,['-e',",
    "\"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);\",",
    "process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000);",
  ].join(""), parentMarker, childMarker], { signal: controller.signal, timeout: 10_000 });
  const childPid = Number(await ready);
  const parentPid = Number(fs.readFileSync(parentMarker, "utf8"));
  owned.push(parentPid, childPid);
  controller.abort(new Error("review interrupted"));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "ABORT_ERR");
  assert.equal(result.stopEvidence.confirmed, true);
  for (const pid of owned) {
    try {
      const identity = LinuxProcessStat.parse(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      assert.equal(identity.state, "Z", `owned process ${pid} is still executing`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});

it("a signal-capable command keeps ordinary output and failure status contracts", async () => {
  const controller = new AbortController();
  const success = await runCmdAsync(process.execPath, ["-e", "process.stdout.write('output');process.stderr.write('diagnostic');"], {
    signal: controller.signal,
  });
  assert.deepEqual(success, { ok: true, status: 0, stdout: "output", stderr: "diagnostic", signal: null, killed: false });
  const failure = await runCmdAsync(process.execPath, ["-e", "process.stderr.write('failure');process.exit(42);"], {
    signal: controller.signal,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 42);
  assert.equal(failure.stderr, "failure");
  assert.equal(failure.errorCode, null);
});

it("a supervised output limit terminates the command without unbounded capture", async () => {
  const controller = new AbortController();
  const result = await runCmdAsync(process.execPath, ["-e", "process.stdout.write('oversized output');setInterval(()=>{},1000);"], {
    signal: controller.signal, maxBuffer: 4, timeout: 10_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(result.stdout, "over");
  assert.equal(result.stopEvidence.confirmed, true);
});
