import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionBinding, captureProcessExecutionCheckoutIdentity, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("runtime-archive-", { parent: path.resolve(".tmp/c2f6/archive-fixtures") });
  const owned = [];
  t.after(async () => {
    try { for (const runtime of owned) if (!runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  const options = { mainRoot: root, executionRoot: root, runId: "archive-run", specId: "archive-spec" };
  const acquire = async (extra = {}) => { const runtime = await ProcessExecutionRuntime.acquire({ ...options, ...extra }); owned.push(runtime); return runtime; };
  const key = crypto.createHash("sha256").update(JSON.stringify(root)).digest("hex");
  const directory = path.join(root, ".sennel", "process-runtime", key);
  return { root, options, acquire, directory };
}

test("closed runtime executions leave bounded active metadata and archived receipts survive a fresh coordinator", async (t) => {
  const { root, acquire, directory } = fixture(t);
  const protectedFile = path.join(root, "protected-state.json"); fs.writeFileSync(protectedFile, '{"budget":0,"attempt":1}');
  const expected = fs.readFileSync(protectedFile);
  const callBinding = new ProcessExecutionBinding({ runId: "archive-run", specId: "archive-spec", attemptId: "exact-attempt" });
  let firstReceipt;
  for (let index = 0; index < 3; index++) {
    const runtime = await acquire({ binding: { runId: "archive-run", specId: "archive-spec", metadata: "x".repeat(6 * 1024 * 1024) } });
    if (index === 0) {
      const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('archived-output')"], {
        timeoutMs: 60000, graceMs: 100, maxBuffer: 1024, processExecutionBinding: callBinding,
      }));
      assert.equal(result.stdout, "archived-output"); firstReceipt = result.processExecutionStopReceipt.toJSON();
    }
    await runtime.close();
    const activeBytes = fs.readFileSync(path.join(directory, "registry.json"));
    assert.ok(activeBytes.length < 2048);
    assert.deepEqual(JSON.parse(activeBytes).payload.executions, []);
    assert.equal(fs.readdirSync(path.join(directory, "archives")).length, index + 1);
  }
  const next = await acquire();
  assert.equal(next.ownerEpoch, 4);
  assert.equal(next.inspect().executions.length, 4);
  assert.deepEqual(next.stopReceipts(callBinding).map((receipt) => receipt.toJSON()), [firstReceipt]);
  assert.deepEqual(fs.readFileSync(protectedFile), expected);
  await next.close();
});

test("pre-publication capacity refusal keeps the visible registry complete and the same owner usable", async (t) => {
  const { acquire, directory } = fixture(t); const runtime = await acquire();
  const file = path.join(directory, "registry.json"), before = fs.readFileSync(file);
  await assert.rejects(runtime.reserveCall({ invocation: { content: "x".repeat(17 * 1024 * 1024) } }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_CAPACITY");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(directory, "transition.json")), false);
  const call = await runtime.reserveCall();
  await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await runtime.close();
});

test("archive deletion cannot erase a completed epoch or grant a new checkout execution", async (t) => {
  const { acquire, directory, options } = fixture(t); const runtime = await acquire(); await runtime.close();
  fs.unlinkSync(path.join(directory, "archives", `${runtime.executionId}.json`));
  await assert.rejects(ProcessExecutionRuntime.acquire(options),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_MISSING");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "registry.json"))).payload.ownerEpoch, 1);
});

test("repository identity comparison shares main authority and keeps full checkout matching separate", (t) => {
  const { root } = fixture(t); const other = path.join(root, "other"); fs.mkdirSync(other);
  const main = captureProcessExecutionCheckoutIdentity({ mainRoot: root });
  const checkout = captureProcessExecutionCheckoutIdentity({ mainRoot: root, executionRoot: other });
  assert.equal(main.matchesRepository(checkout), true);
  assert.equal(main.matches(checkout), false);
});
