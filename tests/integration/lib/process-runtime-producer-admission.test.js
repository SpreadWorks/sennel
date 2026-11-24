import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { ProcessExecutionRuntime, ProcessExecutionCallAdmission, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";

class ProducerAdmissionFixture {
  constructor(t) {
    this.root = createTmpDir("process-runtime-producer-admission-");
    this.effect = path.join(this.root, "must-not-execute");
    this.runtime = null;
    t.after(async () => {
      try { if (this.runtime !== null && !this.runtime.closed) await this.runtime.close(); }
      finally { removeQuiescentRuntimeFixture({ mainRoot: this.root }); }
    });
  }

  async acquire() {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, executionRoot: this.root });
  }

  async invoke(admission) {
    let failure = null;
    try {
      await this.runtime.enter(() => this.runtime.withBinding({ commandId: "producer-admission" },
        () => runManagedCmdAsync(process.execPath, ["-e",
          `require('node:fs').writeFileSync(${JSON.stringify(this.effect)}, 'unexpected effect')`],
        { cwd: this.root, timeout: 20000 }), { callAdmission: admission }));
    } catch (error) { failure = error; }
    finally { await this.runtime.close(); }
    assert.equal(fs.existsSync(this.effect), false);
    assert.equal(this.runtime.closed, true);
    const inventory = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    assert.equal(inventory.slot, null);
    const execution = inventory.executions.find((entry) => entry.executionId === this.runtime.executionId);
    assert.ok(execution);
    assert.equal(execution.status, "closed");
    assert.deepEqual(execution.calls, []);
    return failure;
  }
}

test("a typed producer admission refusal reaches the result-style caller as the exact original error", async (t) => {
  const fixture = new ProducerAdmissionFixture(t);
  await fixture.acquire();
  const refusal = new ProcessExecutionControlFailure("observation-save-failed",
    "Injected producer evidence publication refusal.", { executionId: fixture.runtime.executionId });
  let invoked = 0;
  const admission = new ProcessExecutionCallAdmission({ admit() { invoked += 1; throw refusal; } });
  const failure = await fixture.invoke(admission);
  assert.equal(invoked, 1);
  assert.equal(failure, refusal);
  assert.equal(failure.code, "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
  assert.equal(failure.executionId, fixture.runtime.executionId);
  assert.equal(failure.callId, null);
  assert.equal(Object.hasOwn(failure, "processExecutionStopReceipt"), false);
});

test("an asynchronous producer contract violation remains an exceptional admission refusal without reserving work", async (t) => {
  const fixture = new ProducerAdmissionFixture(t);
  await fixture.acquire();
  let invoked = 0;
  const admission = new ProcessExecutionCallAdmission({ admit() { invoked += 1; return Promise.resolve(); } });
  const failure = await fixture.invoke(admission);
  assert.equal(invoked, 1);
  assert.ok(failure instanceof ProcessExecutionControlFailure);
  assert.equal(failure.code, "PROCESS_EXECUTION_ADMISSION_FAILED");
  assert.equal(failure.executionId, fixture.runtime.executionId);
  assert.equal(failure.callId, null);
  assert.ok(failure.cause instanceof TypeError);
  assert.equal(failure.cause.message, "Process call admission must complete synchronously");
  assert.equal(Object.hasOwn(failure, "processExecutionStopReceipt"), false);
});
