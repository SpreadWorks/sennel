import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { StoredFlowPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowDispatchLease } from "../../../src/flow/lib/flow-dispatch-lease.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionCommunicationDiagnostic } from "../../../src/lib/process-execution-values.js";

class RuntimeFailureFixture {
  constructor(t) {
    this.root = createTmpDir("process-runtime-failure-preservation-");
    t.after(() => removeQuiescentRuntimeFixture({ mainRoot: this.root }));
    setupFlowConfig(this.root);
    this.manager = makeFlowManager(this.root);
    this.specId = "001-runtime-failure";
    this.runId = "runtime-failure-run";
    new FreshFlowFixture({ flowManager: this.manager, specId: this.specId, runId: this.runId,
      execution: { mode: "direct" } }).create().registerActive();
    this.manager.beginNextAction(this.specId);
    this.context = { root: this.root, mainRoot: this.root, executionRoot: this.root,
      specId: this.specId, flowManager: this.manager, flowState: this.manager.loadReadOnly(this.specId),
      expectRunId: this.runId };
    this.canonical = new StoredFlowPersistenceSnapshot(this.manager.specLocation(this.specId).directory);
    this.closedRuntime = null;
    this.closeFailure = null;
    this.closeCount = 0;
    this.lease = null;
    this.releaseCount = 0;
  }

  injectCloseFailure(t) {
    const fixture = this;
    const originalClose = ProcessExecutionRuntime.prototype.close;
    t.mock.method(ProcessExecutionRuntime.prototype, "close", async function () {
      await originalClose.call(this);
      fixture.closedRuntime = this;
      fixture.closeCount += 1;
      // Only the final public close acknowledgement is injected. The runtime
      // has really closed; these diagnostics claim no unobserved child or exit.
      fixture.closeFailure = new ProcessExecutionControlFailure("stop-unconfirmed",
        "Injected runtime close acknowledgement refusal.", {
          executionId: this.executionId,
          primaryCause: { code: "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE",
            message: "Injected close acknowledgement endpoint refusal.", executionId: this.executionId, callId: null },
          communication: new ProcessExecutionCommunicationDiagnostic({ operation: "close", budgetMs: 14000,
            elapsedMs: 0, cutoff: "refused", acceptance: "unknown", stopConfirmation: "confirmed", attempts: [] }),
        });
      throw fixture.closeFailure;
    });
  }

  dispatchLeaseFactory(t, failure) {
    return (session) => {
      const lease = new FlowDispatchLease(session);
      this.lease = lease;
      const originalRelease = lease.release;
      t.mock.method(lease, "release", () => {
        originalRelease.call(lease);
        this.releaseCount += 1;
        throw failure;
      });
      return lease;
    };
  }

  assertClosed(runtime = this.closedRuntime) {
    assert.ok(runtime instanceof ProcessExecutionRuntime);
    assert.equal(runtime.closed, true);
    const inventory = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    assert.equal(inventory.slot, null);
    const saved = inventory.executions.find((execution) => execution.executionId === runtime.executionId);
    assert.ok(saved);
    assert.equal(saved.status, "closed");
    assert.equal(saved.calls.length, 0);
    this.canonical.assertUnchanged();
  }

  assertLeaseReleased() {
    assert.ok(this.lease instanceof FlowDispatchLease);
    assert.equal(this.releaseCount, 1);
    assert.equal(fs.existsSync(this.lease.lock.lockPath), false);
    const successor = new FlowDispatchLease(this.lease.session);
    successor.acquire();
    try { assert.equal(fs.existsSync(successor.lock.lockPath), true); }
    finally { successor.release(); }
    assert.equal(fs.existsSync(successor.lock.lockPath), false);
  }
}

function assertOrderedCauses(aggregate, failures) {
  assert.ok(aggregate instanceof AggregateError);
  assert.equal(aggregate.cause, failures[0]);
  assert.equal(aggregate.errors.length, failures.length);
  failures.forEach((failure, index) => assert.equal(aggregate.errors[index], failure));
}

function assertTypedCloseDominates(error, fixture, failures) {
  assert.ok(error instanceof ProcessExecutionControlFailure);
  assert.deepEqual(error.toJSON(), fixture.closeFailure.toJSON());
  assert.equal(error.executionId, fixture.closedRuntime.executionId);
  assert.equal(error.callId, null);
  assertOrderedCauses(error.cause, failures);
  assert.equal(JSON.stringify(error.toJSON()).includes(failures[0].message), false,
    "private callback causes must not enter versioned public failure evidence");
}

test("Flow runtime close preserves its typed refusal and the exact callback failure after actual closure", async (t) => {
  const fixture = new RuntimeFailureFixture(t);
  fixture.injectCloseFailure(t);
  const body = Object.assign(new Error("Injected callback domain failure."), { code: "DOMAIN_FAILED" });
  const error = await withFlowProcessRuntime(fixture.context, () => { throw body; },
    { commandId: "failure-preservation" }).then(() => assert.fail("callback and close must refuse"), (failure) => failure);
  fixture.assertClosed();
  assert.equal(fixture.closeCount, 1);
  assertTypedCloseDominates(error, fixture, [body, fixture.closeFailure]);
});

test("Flow runtime close-only refusal retains its exact error identity after actual closure", async (t) => {
  const fixture = new RuntimeFailureFixture(t);
  fixture.injectCloseFailure(t);
  const error = await withFlowProcessRuntime(fixture.context, () => "completed body",
    { commandId: "close-only-preservation" }).then(() => assert.fail("close must refuse"), (failure) => failure);
  fixture.assertClosed();
  assert.equal(fixture.closeCount, 1);
  assert.equal(error, fixture.closeFailure);
});

test("Flow dispatch preserves callback, typed close and lease release failures in occurrence order", async (t) => {
  const fixture = new RuntimeFailureFixture(t);
  fixture.injectCloseFailure(t);
  const body = Object.assign(new Error("Injected dispatch callback failure."), { code: "DISPATCH_FAILED" });
  const release = Object.assign(new Error("Injected dispatch lease release acknowledgement failure."), { code: "LEASE_RELEASE_FAILED" });
  const error = await withFlowProcessRuntime(fixture.context, () => {
    assert.equal(fs.existsSync(fixture.lease.lock.lockPath), true);
    throw body;
  }, { commandId: "dispatch", dispatchLeaseFactory: fixture.dispatchLeaseFactory(t, release) })
    .then(() => assert.fail("callback and cleanup must refuse"), (failure) => failure);
  fixture.assertClosed();
  fixture.assertLeaseReleased();
  assert.equal(fixture.closeCount, 1);
  assertTypedCloseDominates(error, fixture, [body, fixture.closeFailure, release]);
});

test("Flow dispatch retains a nonphysical callback failure when its real lease release also fails", async (t) => {
  const fixture = new RuntimeFailureFixture(t);
  const body = Object.assign(new Error("Injected ordinary dispatch failure."), { code: "DOMAIN_FAILED" });
  const release = Object.assign(new Error("Injected ordinary lease release acknowledgement failure."), { code: "LEASE_RELEASE_FAILED" });
  let runtime = null;
  const error = await withFlowProcessRuntime(fixture.context, () => {
    runtime = ProcessExecutionRuntime.current().root;
    assert.equal(fs.existsSync(fixture.lease.lock.lockPath), true);
    throw body;
  }, { commandId: "dispatch", dispatchLeaseFactory: fixture.dispatchLeaseFactory(t, release) })
    .then(() => assert.fail("callback and lease must refuse"), (failure) => failure);
  fixture.assertClosed(runtime);
  fixture.assertLeaseReleased();
  assertOrderedCauses(error, [body, release]);
});
