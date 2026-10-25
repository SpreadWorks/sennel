import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ManagedResponsePublicationGate } from "../../support/infrastructure/managed-response-publication-gate.js";

// A real authenticated coordinator publishes its exact immutable response with
// AtomicFile. Pause only its existing owned-stage unlink boundary so the actual
// caller observes the legitimate two-link interval deterministically. The reader
// must never accept those bytes; completed single-link publication is required.
test("authenticated mailbox waits for owned exclusive response publication to become single-link before returning its exact acknowledgement", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("managed-publication-overlap-");
  const gate = new ManagedResponsePublicationGate(root);
  let runtime;
  t.after(async () => {
    gate.release();
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    environment: gate.coordinatorEnvironment() });
  const grant = { ...runtime.remoteGrant(), transport: "mailbox" };
  const requestId = randomUUID();
  const responsePath = path.join(grant.endpoint.mailbox.responses, `${requestId}.json`);
  const lstat = fs.lstatSync;
  let observedLinks = null;
  const observer = t.mock.method(fs, "lstatSync", function (file, ...options) {
    const stat = lstat.call(this, file, ...options);
    if (String(file) === responsePath && BigInt(stat.nlink) > 1n && observedLinks === null) {
      observedLinks = Number(stat.nlink);
      gate.release();
    }
    return stat;
  });
  let outcome;
  try {
    outcome = await managedRequest(grant, "authenticate", { grant, data: {} }, { requestId })
      .then((response) => ({ response }), (error) => ({ error }));
  } finally {
    gate.release();
    observer.mock.restore();
  }
  assert.equal(observedLinks, 2);
  assert.equal(gate.observedLinks(), 2);
  if (outcome.error !== undefined) {
    const causes = [];
    for (let cause = outcome.error, depth = 0; cause !== undefined && depth < 6; cause = cause.cause, depth++) {
      causes.push({ name: cause.name, code: cause.code ?? null });
    }
    t.diagnostic(JSON.stringify({ causes, communication: outcome.error.communication }));
  }
  assert.equal(outcome.error?.code ?? null, null, "A still-unconfirmed owned publication must not become a permanent malformed response");
  assert.equal(outcome.response.ok, true);
  assert.equal(outcome.response.value.record.executionId, runtime.executionId);
  assert.equal(fs.statSync(responsePath).nlink, 1);
  const saved = fs.readFileSync(responsePath);
  const replay = await managedRequest(grant, "authenticate", { grant, data: {} }, { requestId });
  assert.deepEqual(replay, outcome.response);
  assert.deepEqual(fs.readFileSync(responsePath), saved);
  assert.equal(runtime.inspect().executions[0].calls.length, 0);
});

// A separately created persistent alias is never evidence of an owned stage.
// The same response stays unusable through the original operation's cutoff;
// removing only this fixture's known alias permits ordinary owned teardown.
test("a permanent foreign response hardlink never yields an acknowledgement and preserves its unsafe cause at the unchanged control cutoff", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("managed-response-hardlink-");
  const alias = path.join(root, "foreign-response-alias");
  let runtime;
  t.after(async () => {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  const grant = { ...runtime.remoteGrant(), transport: "mailbox" };
  const requestId = randomUUID();
  const payload = { grant, data: {} };
  const first = await managedRequest(grant, "authenticate", payload, { requestId });
  assert.equal(first.ok, true);
  const responsePath = path.join(grant.endpoint.mailbox.responses, `${requestId}.json`);
  const saved = fs.readFileSync(responsePath);
  assert.equal(fs.statSync(responsePath).nlink, 1);
  fs.linkSync(responsePath, alias);
  assert.equal(fs.statSync(responsePath).nlink, 2);
  await assert.rejects(managedRequest(grant, "authenticate", payload, { requestId }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
    assert.equal(error.primaryCause.code, "PROCESS_EXECUTION_RESPONSE_INVALID");
    assert.equal(error.communication.budgetMs, 14000);
    assert.equal(error.communication.cutoff, "budget-exhausted");
    assert.equal(error.communication.attempts.length, 3);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.responseDeadlineMs), [2000, 6000, 14000]);
    return true;
  });
  assert.equal(fs.statSync(responsePath).nlink, 2);
  assert.deepEqual(fs.readFileSync(responsePath), saved);
  assert.equal(runtime.inspect().executions[0].calls.length, 0);
  fs.unlinkSync(alias);
  assert.equal(fs.statSync(responsePath).nlink, 1);
});
