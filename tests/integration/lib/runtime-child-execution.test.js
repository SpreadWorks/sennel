import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RuntimeChildExecution, currentRuntimePackage, readRuntimeResource } from "../../../src/lib/runtime-package.js";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { runCmd } from "../../../src/lib/process.js";

test("successive runtime children preserve parent resources, target environment and stdin and close each delivery", (t) => {
  const root = createTestDirectory("runtime-child-execution-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.mjs");
  const runtimeUrl = new URL("../../../src/lib/runtime-package.js", import.meta.url).href;
  const resource = new URL("../../../src/presets/base/preset.json", import.meta.url).href;
  fs.writeFileSync(probe, `
    import fs from 'node:fs';
    import { currentRuntimePackage, readRuntimeResource } from ${JSON.stringify(runtimeUrl)};
    console.log(JSON.stringify({ revision: currentRuntimePackage().revision,
      resource: readRuntimeResource(new URL(${JSON.stringify(resource)})),
      cwd: process.cwd(), target: process.env.RUNTIME_CHILD_TARGET,
      nodeOptions: process.env.NODE_OPTIONS, stdin: fs.readFileSync(0, 'utf8') }));
  `);
  const environment = { ...process.env, NODE_OPTIONS: "--no-warnings", RUNTIME_CHILD_TARGET: "live-project" };
  const originalOptions = process.env.NODE_OPTIONS;
  for (let index = 0; index < 2; index++) {
    let file;
    const result = RuntimeChildExecution.runSync(probe, [], { cwd: root, env: environment }, (command, args, options) => {
      file = JSON.parse(Buffer.from(options.env.NODE_OPTIONS.split("#").at(-1), "base64url")).file;
      assert.equal(options.stdio.length, 3);
      return runCmd(command, args, options);
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { revision: currentRuntimePackage().revision,
      resource: readRuntimeResource(new URL(resource)), cwd: root, target: "live-project",
      nodeOptions: "--no-warnings", stdin: "" });
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(environment.NODE_OPTIONS, "--no-warnings");
  assert.equal(process.env.NODE_OPTIONS, originalOptions);
});

test("runtime delivery retains unknown runner failures and closes only a bound actual launch failure", async (t) => {
  const root = createTestDirectory("runtime-child-launch-failure-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "runner failed before confirmed child exit");
  let file;
  let original;
  assert.throws(() => RuntimeChildExecution.runSync("unused.mjs", [], { cwd: root }, (_command, _args, options) => {
    file = JSON.parse(Buffer.from(options.env.NODE_OPTIONS.split("#").at(-1), "base64url")).file;
    original = fs.readFileSync(file);
      assert.equal(options.stdio.length, 3);
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(fs.readFileSync(file), original);
  await assert.rejects(RuntimeChildExecution.runAsync("unused.mjs", [], { cwd: root }, (_command, args, options, delivery) => {
    file = JSON.parse(Buffer.from(options.env.NODE_OPTIONS.split("#").at(-1), "base64url")).file;
    const child = delivery.spawnNode(args[0], args.slice(1), { ...options, cwd: path.join(root, "missing-directory") });
    return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  }), { code: "ENOENT" });
  assert.equal(fs.existsSync(file), false);
  const result = RuntimeChildExecution.runSync(path.join(root, "missing-entrypoint.mjs"), [], { cwd: root });
  assert.equal(result.ok, false);
  const unrelated = new RuntimeChildExecution({ root });
  const unrelatedFile = JSON.parse(Buffer.from(unrelated.environment.NODE_OPTIONS.split("#").at(-1), "base64url")).file;
  const unrelatedBytes = fs.readFileSync(unrelatedFile);
  assert.throws(() => unrelated.closeAfterExecution(result.processExecutionStopReceipt), /RUNTIME_DELIVERY_COMPLETION_MISMATCH/);
  assert.throws(() => unrelated.closeAfterExecution(), /RUNTIME_DELIVERY_COMPLETION_UNKNOWN/);
  assert.equal(unrelated.close(), false);
  assert.deepEqual(fs.readFileSync(unrelatedFile), unrelatedBytes);
});


test("worker first boot uses the fixed runtime while the parent event loop is blocked and acknowledges closed delivery", async (t) => {
  const root = createTestDirectory("runtime worker 日本語 ");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "worker probe 日本語.mjs");
  const runtimeUrl = new URL("../../../src/lib/runtime-package.js", import.meta.url).href;
  fs.writeFileSync(probe, `
    import { workerData } from 'node:worker_threads';
    import { currentRuntimePackage } from ${JSON.stringify(runtimeUrl)};
    const signal = new Int32Array(workerData.signal);
    Atomics.store(signal, 0, currentRuntimePackage().revision === workerData.revision ? 1 : 2);
    Atomics.notify(signal, 0);
  `);
  const delivery = new RuntimeChildExecution({ root });
  t.after(() => delivery.close());
  assert.equal(delivery.consumeAcknowledgement(), false);
  const signal = new SharedArrayBuffer(4);
  const options = delivery.workerOptions({ workerData: { signal, revision: currentRuntimePackage().revision } });
  assert.equal(options.execArgv.length, 1);
  assert.equal(options.env.NODE_OPTIONS, (process.env.NODE_OPTIONS || "").trim());
  const configuration = JSON.parse(Buffer.from(options.execArgv[0].split("#").at(-1), "base64url"));
  assert.equal(delivery.close(), false);
  assert.equal(fs.existsSync(configuration.file), true);
  const worker = new Worker(probe, options);
  const exited = new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  const state = new Int32Array(signal);
  assert.notEqual(Atomics.wait(state, 0, 0, 20000), "timed-out");
  assert.equal(Atomics.load(state, 0), 1);
  assert.equal(delivery.consumeAcknowledgement(), true);
  assert.equal(delivery.consumeAcknowledgement(), true);
  assert.throws(() => delivery.workerOptions(), /closed/);
  assert.equal(await exited, 0);
});

test("missing delivery and mismatched expected revision refuse entrypoint evaluation", async (t) => {
  const root = createTestDirectory("runtime-refusal-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const failure of ["missing", "revision"]) {
    const delivery = new RuntimeChildExecution({ root });
    const options = delivery.options({ encoding: "utf8" });
    const [prefix, encoded] = options.env.NODE_OPTIONS.split("#");
    const configuration = JSON.parse(Buffer.from(encoded, "base64url"));
    if (failure === "missing") fs.renameSync(configuration.file, `${configuration.file}.retained`);
    else {
      configuration.revision = "0".repeat(64);
      options.env = { ...options.env, NODE_OPTIONS: `${prefix}#${Buffer.from(JSON.stringify(configuration)).toString("base64url")}` };
    }
    if (failure === "missing") {
      const child = delivery.spawnNode("--input-type=module", ["-e", 'console.log("entrypoint ran")'], options);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0);
      assert.equal(stdout, "");
      assert.match(stderr, /ENOENT/);
      fs.renameSync(`${configuration.file}.retained`, configuration.file);
      assert.equal(delivery.closeAfterExecution(), true);
    } else {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'console.log("entrypoint ran")'], options);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /RUNTIME_REVISION_MISMATCH/);
      assert.equal(delivery.close(), false);
      assert.throws(() => delivery.closeAfterExecution(), /RUNTIME_DELIVERY_COMPLETION_UNKNOWN/);
      assert.equal(fs.existsSync(configuration.file), true);
    }
  }
});
