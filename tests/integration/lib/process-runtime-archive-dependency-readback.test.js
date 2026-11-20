import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { sameFileIdentity } from "../../../src/lib/file-identity.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture, terminateFixtureCoordinator } from "../../support/infrastructure/runtime-fixture-cleanup.js";

// Three genuine closed executions select the plural archive boundary. Every
// mutation occurs only after complete production save/close/readback.
test("multiple archived executions freshly validate linked blocks and namespaces after readback", { timeout: 60000 }, async t => {
  const root = createTmpDir("archive-dependency-readback-");
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) if (!runtime.closed) await terminateFixtureCoordinator(runtime);
    removeQuiescentRuntimeFixture({ mainRoot: root });
  });
  const effect = path.join(root, "effect");
  let receipt;
  const costFile = path.join(root, "coordinator-read-cost.json");
  const preload = `import fs from 'node:fs';import path from 'node:path';
    if(path.basename(process.argv[1] ?? '') === 'execution-coordinator.js') {
      const lstat = fs.lstatSync, open = fs.openSync;
      let rootObservations = 0, requestBlockOpens = 0;
      fs.lstatSync = function(file,...args) {
        if(String(file) === ${JSON.stringify(root)}) rootObservations++;
        return lstat.call(this,file,...args);
      };
      fs.openSync = function(file,...args) {
        if(String(file).includes(path.sep+'blocks'+path.sep) && String(file).endsWith('.json')) requestBlockOpens++;
        return open.call(this,file,...args);
      };
      process.once('beforeExit',()=>fs.writeFileSync(${JSON.stringify(costFile)},
        JSON.stringify({pid:process.pid,rootObservations,requestBlockOpens}),{flag:'wx'}));
    }`;
  const nodeOptionsKey = Object.keys(process.env).find(key => key.toUpperCase() === "NODE_OPTIONS") ?? "NODE_OPTIONS";
  const observedEnvironment = { ...process.env,
    [nodeOptionsKey]: `${process.env[nodeOptionsKey] ?? ""} --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`.trim() };
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: ordinal === 2 ? observedEnvironment : {} });
    runtimes.push(runtime);
    if (ordinal === 0) {
      const result = await executeManagedProcess(process.execPath, ["-e",
        `require('node:fs').appendFileSync(${JSON.stringify(effect)},'once');process.stdout.write('saved')`],
      { runtime, timeoutMs: 10000 });
      assert.equal(result.stdout, "saved");
      receipt = result.processExecutionStopReceipt.toJSON();
    }
    if (ordinal === 2) {
      const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('last')"], { runtime, timeoutMs: 10000 });
      assert.equal(result.stdout, "last");
    }
    await runtime.close();
    assert.equal(runtime.control.child.exitCode, 0);
    assert.equal(runtime.control.child.signalCode, null);
  }
  const runtime = runtimes.at(-1);
  const expected = runtime.store.readInventory();
  assert.equal(expected.executions.length, 3);
  const cost = JSON.parse(fs.readFileSync(costFile, "utf8"));
  assert.equal(cost.pid, runtime.control.child.pid);
  assert.ok(cost.rootObservations > 0);
  assert.ok(cost.requestBlockOpens > 0);
  t.diagnostic(JSON.stringify({ ...cost, costEvidenceOnly: true }));
  assert.ok(expected.executions.every(execution => execution.status === "closed"));
  assert.deepEqual(expected.executions[0].calls.map(call => call.receipt), [receipt]);
  const paths = runtime.store.requestStorage.referencedBlockPaths(new Set([runtimes[0].executionId]));
  assert.ok(paths.length > 0, "the first archive owns actual persisted original requests");
  const block = path.join(runtime.store.authority.directory, ...paths[0].split("/"));
  const original = fs.readFileSync(block);
  const registry = fs.readFileSync(runtime.store.file.filePath);
  const backup = path.join(root, "original-block");
  const extra = path.join(path.dirname(block), `${crypto.randomUUID()}.json`);
  const assertExact = () => {
    assert.deepEqual(runtime.store.readInventory(), expected);
    assert.deepEqual(ProcessExecutionRuntime.inspect({ mainRoot: root }), expected);
    assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), registry);
    assert.equal(fs.readFileSync(effect, "utf8"), "once");
  };
  assertExact();
  // A same-byte new generation is valid, but still requires fresh decoding.
  fs.renameSync(block, backup);
  try {
    fs.writeFileSync(block, original, { flag: "wx" });
    assert.equal(sameFileIdentity(fs.lstatSync(block, { bigint: true }), fs.lstatSync(backup, { bigint: true })), false);
    assertExact();
  } finally {
    if (fs.existsSync(block)) fs.unlinkSync(block);
    fs.renameSync(backup, block);
  }
  for (const mutation of ["corrupt-block", "missing-block", "unexpected-block"]) {
    assertExact();
    const identity = fs.lstatSync(block, { bigint: true });
    try {
      if (mutation === "corrupt-block") {
        const envelope = JSON.parse(original);
        envelope.payload.unexpectedDependencyField = true;
        envelope.digest = crypto.createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
        fs.writeFileSync(block, JSON.stringify(envelope));
        assert.equal(sameFileIdentity(identity, fs.lstatSync(block, { bigint: true })), true);
      } else if (mutation === "missing-block") fs.renameSync(block, backup);
      else fs.writeFileSync(extra, original, { flag: "wx" });
      const code = mutation === "missing-block" ? "PROCESS_EXECUTION_RECORD_MISSING"
        : mutation === "unexpected-block" ? "PROCESS_EXECUTION_RECORD_CORRUPT" : "PROCESS_EXECUTION_REGISTRY_FAILED";
      assert.throws(() => runtime.store.readInventory(), { code });
      assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code });
      assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), registry);
      assert.equal(fs.readFileSync(effect, "utf8"), "once");
    } finally {
      if (mutation === "corrupt-block") fs.writeFileSync(block, original);
      else if (mutation === "missing-block") fs.renameSync(backup, block);
      else fs.unlinkSync(extra);
    }
    assertExact();
  }
  assert.equal(runtime.store.ownerLock.inspect(), null);
  assert.equal(fs.existsSync(runtime.store.transition.filePath), false);
});
