import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withManagedProcessScopeSync } from "../../../src/lib/managed-process.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { runCmd } from "../../../src/lib/process.js";
import { SynchronousManagedFixture } from "../../support/infrastructure/synchronous-managed-fixture.js";

class ManagedScopeFixture extends SynchronousManagedFixture {
  constructor(t) {
    super(t, "synchronous-managed-");
  }
  write(text) {
    return runCmd(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], process.argv[2]);", path.join(this.root, "effects"), text],
      { cwd: this.root, timeout: 10000 });
  }
  effects() { return fs.readFileSync(path.join(this.root, "effects"), "utf8"); }
}

test("a synchronous writer unit persists distinct child receipts and closes its one owned lifetime", (t) => {
  const fixture = new ManagedScopeFixture(t);
  let view;
  const receipts = withManagedProcessScopeSync({ executionRoot: fixture.root }, (runtime) => {
    view = runtime;
    const results = [fixture.write("first\n"), fixture.write("second\n")];
    assert.equal(results.every((result) => result.ok), true);
    return results.map((result) => result.processExecutionStopReceipt);
  });
  assert.equal(view.closed, true);
  assert.equal(ProcessExecutionRuntime.current(), null);
  assert.equal(fixture.effects(), "first\nsecond\n");
  const stored = ProcessExecutionRuntime.inspect({ mainRoot: fixture.root }).executions;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "closed");
  assert.equal(stored[0].calls.length, 2);
  assert.notEqual(receipts[0].callId, receipts[1].callId);
  assert.deepEqual(stored[0].calls.map((call) => call.receipt), receipts.map((receipt) => receipt.toJSON()));
  fixture.complete = true;
});

test("synchronous writer failure retains its primary cause and persisted completed effects", (t) => {
  const fixture = new ManagedScopeFixture(t);
  const failure = new Error("operation refused after its confirmed child");
  assert.throws(() => withManagedProcessScopeSync({ executionRoot: fixture.root }, () => {
    assert.equal(fixture.write("before refusal\n").ok, true);
    throw failure;
  }), (error) => error === failure);
  const stored = ProcessExecutionRuntime.inspect({ mainRoot: fixture.root }).executions[0];
  assert.equal(stored.status, "closed");
  assert.equal(stored.calls.length, 1);
  assert.equal(stored.calls[0].receipt.observation.code, 0);
  assert.equal(fixture.effects(), "before refusal\n");
  fixture.complete = true;
});

test("a synchronous unit reuses its active owner and leaves the owner's closure to that owner", async (t) => {
  const fixture = new ManagedScopeFixture(t);
  const owner = await ProcessExecutionRuntime.acquire({ mainRoot: fixture.root });
  await owner.enter(() => {
    const result = withManagedProcessScopeSync({ executionRoot: fixture.root }, (runtime) => {
      assert.equal(runtime, owner);
      return fixture.write("owned\n");
    });
    assert.equal(result.ok, true);
    assert.equal(result.processExecutionStopReceipt.executionId, owner.executionId);
    assert.equal(owner.closed, false);
  });
  await owner.close();
  const stored = ProcessExecutionRuntime.inspect({ mainRoot: fixture.root }).executions[0];
  assert.equal(stored.executionId, owner.executionId);
  assert.equal(stored.status, "closed");
  assert.equal(stored.calls.length, 1);
  assert.equal(fixture.effects(), "owned\n");
  fixture.complete = true;
});
