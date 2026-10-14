import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionOwnershipReservation, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess, verifyManagedProcessStopped } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const mainRoot = createTmpDir("runtime-handoff-", { parent: path.resolve(".tmp/c2f6/runtime-handoff-fixtures") });
  const checkout = path.join(mainRoot, "original-checkout"); fs.mkdirSync(checkout);
  const owned = [], reservations = [];
  t.after(async () => {
    try {
      for (const entry of owned) if (!entry.runtime.closed && !entry.unproven) await entry.runtime.close();
      for (const reservation of reservations) reservation.release();
    } finally { removeTmpDir(mainRoot); }
  });
  const options = { mainRoot, executionRoot: checkout, runId: "handoff-run", specId: "handoff-spec" };
  return { mainRoot, checkout, options, reservations,
    async acquire(extra = {}) { const runtime = await ProcessExecutionRuntime.acquire({ ...options, ...extra }); owned.push({ runtime, unproven: false }); return runtime; },
    markUnproven(runtime) { owned.find((entry) => entry.runtime === runtime).unproven = true; } };
}
async function provider(runtime, text, cwd) {
  return runtime.enter(() => executeManagedProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`],
    { cwd, timeoutMs: 30000, graceMs: 100, maxBuffer: 1024 }));
}
function busy(error) { return error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY"; }

test("a sealed original checkout retains its live reservation while the main checkout runs a new proven provider", async (t) => {
  const value = fixture(t), original = await value.acquire();
  const result = await provider(original, "original-provider", value.checkout);
  const before = original.inspect().executions[0];
  const reservation = await original.withBinding({ runId: value.options.runId, specId: value.options.specId },
    () => ProcessExecutionRuntime.current().sealForCheckoutHandoff());
  value.reservations.push(reservation);
  assert.ok(reservation instanceof ProcessExecutionOwnershipReservation); assert.equal(original.closed, true);
  assert.equal(reservation.executionId, original.executionId); assert.equal(reservation.released, false);
  const sealed = original.inspect(); assert.equal(sealed.slot, null); assert.equal(sealed.executions[0].status, "closed");
  assert.equal(sealed.executions[0].calls[0].receipt.callId, result.processExecutionStopReceipt.callId);
  assert.equal(sealed.executions[0].calls[0].receipt.stopEvidence.status, "confirmed");
  assert.equal(verifyManagedProcessStopped(before.calls[0]), true);
  await assert.rejects(original.reserveCall(), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
  await original.close(); assert.equal(reservation.released, false);
  await assert.rejects(ProcessExecutionRuntime.acquire(value.options), busy);
  const main = await value.acquire({ executionRoot: value.mainRoot });
  const mainResult = await provider(main, "main-provider", value.mainRoot);
  assert.equal(mainResult.stdout, "main-provider");
  assert.equal(mainResult.processExecutionStopReceipt.checkoutIdentity.executionRoot, value.mainRoot);
  await assert.rejects(ProcessExecutionRuntime.acquire(value.options), busy);
  await main.close(); reservation.release(); assert.equal(reservation.released, true);
  const next = await value.acquire(); assert.equal(next.ownerEpoch, original.ownerEpoch + 1); await next.close();
});

test("main-authority reservation release remains valid after the proven original checkout directory is deleted", async (t) => {
  const value = fixture(t), original = await value.acquire(); await provider(original, "before-delete", value.checkout);
  const reservation = await original.sealForCheckoutHandoff(); value.reservations.push(reservation);
  const lockPath = original.store.ownerLock.lockPath;
  assert.equal(lockPath.startsWith(path.join(value.mainRoot, ".sennel", "process-runtime") + path.sep), true);
  const main = await value.acquire({ executionRoot: value.mainRoot });
  fs.rmSync(value.checkout, { recursive: true }); assert.equal(fs.existsSync(value.checkout), false);
  assert.equal(fs.existsSync(lockPath), true);
  const completed = await provider(main, "after-delete", value.mainRoot); assert.equal(completed.stdout, "after-delete");
  await main.close(); reservation.release(); reservation.release();
  assert.equal(reservation.released, true); assert.equal(fs.existsSync(lockPath), false);
});

test("an unproven launch intent cannot authorize a handoff reservation or a new main execution", async (t) => {
  const value = fixture(t), original = await value.acquire(); await provider(original, "before-uncertain-intent", value.checkout);
  await original.reserveCall(); value.markUnproven(original);
  let mainAuthorized = false;
  await assert.rejects((async () => {
    const reservation = await original.sealForCheckoutHandoff(); value.reservations.push(reservation);
    mainAuthorized = true; await value.acquire({ executionRoot: value.mainRoot });
  })(), { code: "PROCESS_EXECUTION_STOP_UNCONFIRMED" });
  assert.equal(mainAuthorized, false); assert.equal(value.reservations.length, 0); assert.equal(original.closed, false);
  const saved = original.inspect(); assert.equal(saved.slot, original.executionId);
  assert.equal(saved.executions[0].status, "stopping"); assert.equal(saved.executions[0].calls[1].receipt, null);
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: value.mainRoot }), null);
  await assert.rejects(original.reserveCall(), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
});
