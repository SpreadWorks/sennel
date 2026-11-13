import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessExecutionRuntime, PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { CanonicalPersistenceSnapshot, StoredFlowPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";

// Capture native temporary storage before test helpers select project scratch:
// a public CLI under a linked worktree intentionally selects that checkout's source.
const publicCliTemporaryRoot = os.tmpdir();

class PublicContextMetricFixture {
  constructor(t) {
    this.root = fs.mkdtempSync(path.join(publicCliTemporaryRoot, "flow-context-metric-cli-"));
    t.after(() => removeQuiescentRuntimeFixture({ mainRoot: this.root }));
    fs.mkdirSync(path.join(this.root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(this.root, ".sennel", "config.json"), JSON.stringify({
      lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    }));
    fs.mkdirSync(path.join(this.root, "docs"));
    this.content = "Read this documentation through the public context command.\n";
    fs.writeFileSync(path.join(this.root, "docs", "context.md"), this.content);
    const manager = makeFlowManager(this.root);
    this.flow = new CanonicalFlowFixture({ flowManager: manager,
      specId: "context-metric", runId: "context-metric-run" }).create().registerActive().activate("draft");
    assert.equal(fs.existsSync(path.join(this.root, ".git")), false);
  }

  manager() { return makeFlowManager(this.root); }

  invoke(args, grant = null) {
    const env = { ...process.env, SENNEL_WORK_ROOT: this.root, SENNEL_SOURCE_ROOT: this.root };
    // An independent user CLI does not inherit the test host's execution grant.
    delete env[PROCESS_EXECUTION_SCOPE_ENV];
    if (grant !== null) env[PROCESS_EXECUTION_SCOPE_ENV] = JSON.stringify(grant);
    try {
      return execFileSync(process.execPath, [fileURLToPath(new URL("../../../src/sennel.js", import.meta.url)), ...args], {
        cwd: this.root, env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ args, status: error.status, signal: error.signal,
        stdout: error.stdout, stderr: error.stderr })}\n`);
      throw error;
    }
  }
}

test("public context file read durably records one metric without advancing its Attempt or budgets", (t) => {
  const fixture = new PublicContextMetricFixture(t);
  const before = fixture.manager().canonicalState(fixture.flow.specId);
  assert.equal(before.current.at(-1), "draft");
  const result = JSON.parse(fixture.invoke(["flow", "get", "context", "docs/context.md"]));
  assert.equal(result.ok, true);
  assert.equal(result.data.content, fixture.content);
  const reloaded = fixture.manager();
  const state = reloaded.loadReadOnly(fixture.flow.specId);
  const metrics = state.metrics.filter(entry => entry.counter === "docsRead");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].phase, "plan");
  const activities = reloaded.activityLedger(fixture.flow.specId)
    .filter(entry => entry.transition.operation === "record_metric" && entry.metric?.counter === "docsRead");
  assert.equal(activities.length, 1);
  assert.equal(activities[0].metric.delta, 1);
  const after = reloaded.canonicalState(fixture.flow.specId);
  assert.deepEqual(after.current, before.current);
  assert.deepEqual(after.attempt, before.attempt);
  assert.deepEqual(after.attempt.consumption, before.attempt.consumption);

  const canonical = new CanonicalPersistenceSnapshot(reloaded, fixture.flow.specId);
  const project = new StoredFlowPersistenceSnapshot(fixture.root);
  for (const args of [["flow", "get", "status"], ["flow", "get", "next-action"], ["flow", "get", "context", "--help"]]) {
    const output = fixture.invoke(args);
    if (args.at(-1) === "--help") assert.match(output, /File mode \(with path\): file content \+ metric increment/);
    else assert.equal(JSON.parse(output).ok, true);
    canonical.assertUnchanged(fixture.manager(), fixture.flow.specId, args.join(" "));
    project.assertUnchanged();
  }
});

test("public context refuses a foreign inherited runtime before recording its metric", async (t) => {
  const fixture = new PublicContextMetricFixture(t);
  const foreign = createTmpDir("flow-context-foreign-runtime-");
  let runtime;
  t.after(async () => {
    await runtime?.close();
    removeQuiescentRuntimeFixture({ mainRoot: foreign });
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: foreign });
  const before = new CanonicalPersistenceSnapshot(fixture.manager(), fixture.flow.specId);
  assert.throws(() => fixture.invoke(["flow", "get", "context", "docs/context.md"], runtime.remoteGrant()), error => {
    assert.equal(error.status, 1);
    const envelope = JSON.parse(error.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.some(entry => entry.code === "PROCESS_EXECUTION_DELEGATION_REFUSED"), true,
      JSON.stringify(envelope));
    return true;
  });
  before.assertUnchanged(fixture.manager(), fixture.flow.specId, "foreign context authority");
  assert.equal(fixture.manager().loadReadOnly(fixture.flow.specId).metrics.filter(entry => entry.counter === "docsRead").length, 0);
});

test("public context accepts its live child grant and leaves process event publication to the parent", async (t) => {
  const fixture = new PublicContextMetricFixture(t);
  const manager = fixture.manager();
  const before = manager.canonicalState(fixture.flow.specId);
  const context = { root: fixture.root, mainRoot: fixture.root, executionRoot: fixture.root,
    specId: fixture.flow.specId, flowManager: manager, flowState: manager.loadReadOnly(fixture.flow.specId) };
  let executionId;
  await withFlowProcessRuntime(context, async () => {
    const runtime = ProcessExecutionRuntime.current();
    executionId = runtime.executionId;
    await runtime.withDeferredEventPublication(async () => {
      const result = await runManagedCmdAsync(process.execPath,
        [fileURLToPath(new URL("../../../src/sennel.js", import.meta.url)), "flow", "get", "context", "docs/context.md"],
        { cwd: fixture.root, timeout: 60000, encoding: "utf8",
          env: { ...process.env, SENNEL_WORK_ROOT: fixture.root, SENNEL_SOURCE_ROOT: fixture.root } });
      assert.equal(result.status, 0, JSON.stringify(result));
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.content, fixture.content);
      const pending = runtime.inspect().executions.find(entry => entry.executionId === executionId);
      assert.ok(pending.events.length > 0);
      assert.deepEqual(pending.eventAcknowledgements, []);
      assert.deepEqual(fixture.manager().activityLedger(fixture.flow.specId)
        .filter(entry => entry.processEvent?.executionId === executionId), []);
    });
  }, { commandId: "context-parent" });
  const reloaded = fixture.manager();
  const metrics = reloaded.loadReadOnly(fixture.flow.specId).metrics.filter(entry => entry.counter === "docsRead");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].phase, "plan");
  const activities = reloaded.activityLedger(fixture.flow.specId);
  const metricActivities = activities.filter(entry => entry.transition.operation === "record_metric"
    && entry.metric?.counter === "docsRead");
  assert.equal(metricActivities.length, 1);
  assert.equal(metricActivities[0].metric.delta, 1);
  const after = reloaded.canonicalState(fixture.flow.specId);
  assert.deepEqual(after.current, before.current);
  assert.deepEqual(after.attempt, before.attempt);
  assert.deepEqual(after.attempt.consumption, before.attempt.consumption);
  const inventory = ProcessExecutionRuntime.inspect({ mainRoot: fixture.root });
  assert.equal(inventory.slot, null);
  const execution = inventory.executions.find(entry => entry.executionId === executionId);
  assert.equal(execution.status, "closed");
  assert.deepEqual(execution.eventAcknowledgements.map(entry => entry.eventId), execution.events.map(entry => entry.eventId));
  assert.deepEqual(activities.filter(entry => entry.processEvent?.executionId === executionId)
    .map(entry => entry.processEvent), execution.events);
  assert.equal(execution.calls.length, 1);
  assert.equal(execution.calls[0].receipt.observation.code, 0);
});
