import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { runGitToFile, withGitOutputCleanup, isGitObjectId } from "../../../src/lib/git-helpers.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionBinding, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";

class OutputUnitEventWriter extends FlowProcessEventWriter {
  #scenario;
  constructor(manager, scenario) { super(manager); this.#scenario = scenario; }
  writeGroup(group) {
    const scenario = this.#scenario;
    if (scenario.enforceBoundary) {
      assert.equal(scenario.bodyCompleted, true, "publish after the complete output unit has returned");
      assert.equal(fs.existsSync(scenario.output), scenario.outputExistsAtPublication, "publication follows its actual owning scope");
    }
    const acknowledgements = super.writeGroup(group);
    if (scenario.publicationFailure !== null) throw scenario.publicationFailure;
    return acknowledgements;
  }
}

class GitOutputPublicationScenario {
  constructor(t) {
    this.root = createTmpDir("git-output-publication-unit-");
    this.runtime = null;
    this.enforceBoundary = true;
    this.bodyCompleted = false;
    this.bodyFailure = null;
    this.cleanupFailure = null;
    this.cleanupCount = 0;
    this.outputExistsAtPublication = true;
    this.publicationFailure = null;
    t.after(async () => {
      // Release only this observer's injected boundary/failure for teardown.
      // Never fabricate a body result, receipt or canonical publication.
      this.enforceBoundary = false;
      this.publicationFailure = null;
      try { if (this.runtime !== null) await this.runtime.close(); }
      finally { removeQuiescentRuntimeFixture({ mainRoot: this.root }); }
    });
    fs.writeFileSync(path.join(this.root, "tracked.txt"), "tracked bytes\n");
    initGitRepo(this.root);
    commitAll(this.root, "Create output publication fixture");
    setupFlowConfig(this.root);
    this.manager = makeFlowManager(this.root);
    this.specId = "001-output-publication";
    new FreshFlowFixture({ flowManager: this.manager, specId: this.specId,
      runId: "output-publication-run", execution: { mode: "direct" } }).create().registerActive();
    this.manager.beginNextAction(this.specId);
    const state = this.manager.canonicalState(this.specId);
    this.binding = new ProcessExecutionBinding({ runId: state.runId, specId: state.specId,
      flowVersionId: state.flowVersionId, nodeId: state.attempt.nodeId,
      attemptId: state.attempt.id, attemptSequence: state.attempt.sequence });
    this.writer = new OutputUnitEventWriter(this.manager, this);
    this.output = path.join(this.root, ".tmp", "owned-output-unit");
    fs.mkdirSync(this.output, { recursive: true });
    this.results = [];
    this.cleanupAcknowledgements = null;
    this.value = Symbol("complete-output-unit");
  }
  async acquire() {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root,
      binding: this.binding, runId: this.binding.value.runId, specId: this.specId, eventWriter: this.writer });
  }
  inventory() {
    return this.runtime.inspect().executions.find(entry => entry.executionId === this.runtime.executionId);
  }
  canonicalEvents() {
    return makeFlowManager(this.root).activityLedger(this.specId)
      .filter(activity => activity.processEvent?.executionId === this.runtime.executionId);
  }
  run() {
    return this.runtime.enter(() => withGitOutputCleanup(() => {
      const head = path.join(this.output, "head.bin");
      const files = path.join(this.output, "files.bin");
      this.results.push(runGitToFile(["rev-parse", "HEAD"], { cwd: this.root, outputPath: head, log: false }));
      this.results.push(runGitToFile(["ls-files", "-z", "--", "tracked.txt"], { cwd: this.root, outputPath: files, log: false }));
      assert.ok(this.results.every(result => result.ok));
      assert.ok(isGitObjectId(fs.readFileSync(head, "utf8").trim()));
      assert.equal(fs.readFileSync(files, "utf8"), "tracked.txt\0");
      this.bodyCompleted = true;
      if (this.bodyFailure !== null) throw this.bodyFailure;
      return this.value;
    }, () => {
      this.cleanupCount++;
      this.cleanupAcknowledgements = this.inventory().eventAcknowledgements.map(entry => entry.eventId);
      fs.rmSync(this.output, { recursive: true });
      if (this.cleanupFailure !== null) throw this.cleanupFailure;
    }));
  }
  assertPhysicalAndCanonical() {
    const saved = this.inventory();
    assert.equal(saved.calls.length, 2, "publication replay cannot run either physical Git command again");
    assert.equal(saved.events.length, 8);
    for (const result of this.results) {
      assert.ok(result.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
      assert.equal(result.processExecutionStopReceipt.stopEvidence.status, "confirmed");
    }
    assert.deepEqual(saved.eventAcknowledgements.map(entry => entry.eventId), saved.events.map(entry => entry.eventId));
    const actual = this.canonicalEvents();
    assert.deepEqual(actual.map(entry => entry.processEvent), saved.events);
    assert.equal(new Set(actual.map(entry => entry.id)).size, 8);
    assert.equal(fs.readFileSync(path.join(this.root, "tracked.txt"), "utf8"), "tracked bytes\n");
  }
}

test("a synchronous Git output unit publishes all exact receipts before cleanup and preserves its return value", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  assert.equal(scenario.run(), scenario.value);
  scenario.assertPhysicalAndCanonical();
  assert.deepEqual(scenario.cleanupAcknowledgements, scenario.inventory().events.map(entry => entry.eventId));
  assert.equal(fs.existsSync(scenario.output), false);
});

test("a Git output unit preserves post-save acknowledgement failure and replays exact facts without physical reexecution", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  const failure = new Error("canonical output-unit save completed before acknowledgement delivery failed");
  scenario.publicationFailure = failure;
  assert.throws(() => scenario.run(), error => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
    assert.equal(error.executionId, scenario.runtime.executionId);
    assert.equal(error.callId, null, "a multi-command unit has no invented single-call receipt");
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(scenario.bodyCompleted, true);
  assert.equal(scenario.results.length, 2);
  assert.equal(fs.existsSync(scenario.output), false, "both physical producers and local output reads have settled");
  assert.deepEqual(scenario.cleanupAcknowledgements, []);
  const before = scenario.inventory();
  assert.equal(before.events.length, 8);
  assert.equal(scenario.canonicalEvents().length, 8, "the real canonical save preceded lost acknowledgement");
  scenario.publicationFailure = null;
  assert.equal(fs.existsSync(scenario.output), false, "replay cannot recreate settled output");
  scenario.outputExistsAtPublication = false;
  assert.deepEqual(await scenario.runtime.drainEvents(), before.events.map(event => event.eventId));
  assert.deepEqual(await scenario.runtime.drainEvents(), []);
  scenario.assertPhysicalAndCanonical();
});

test("a live Git output unit preserves its body failure after publishing confirmed commands", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  const failure = new Error("output consumer failed after both real commands completed");
  scenario.bodyFailure = failure;
  assert.throws(() => scenario.run(), error => error === failure);
  scenario.assertPhysicalAndCanonical();
  assert.equal(scenario.cleanupCount, 1);
  assert.equal(fs.existsSync(scenario.output), false);
});

test("a live Git output unit preserves body and post-save publication failures in order and can replay", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  const body = new Error("real output consumer failure");
  const publication = new Error("real canonical save succeeded before delivery failed");
  scenario.bodyFailure = body;
  scenario.publicationFailure = publication;
  assert.throws(() => scenario.run(), error => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
    assert.equal(error.callId, null);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [body, publication]);
    assert.equal(error.cause.cause, body);
    return true;
  });
  assert.equal(scenario.cleanupCount, 1);
  assert.equal(fs.existsSync(scenario.output), false);
  const pending = scenario.inventory();
  assert.deepEqual(pending.eventAcknowledgements, []);
  assert.equal(scenario.canonicalEvents().length, 8);
  scenario.publicationFailure = null;
  assert.equal(fs.existsSync(scenario.output), false, "replay cannot recreate settled output");
  scenario.outputExistsAtPublication = false;
  assert.deepEqual(await scenario.runtime.drainEvents(), pending.events.map(event => event.eventId));
  scenario.assertPhysicalAndCanonical();
});

test("a live Git output unit preserves an original cleanup failure after exact publication", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  const cleanup = new Error("owned cleanup failed after releasing the settled output");
  scenario.cleanupFailure = cleanup;
  assert.throws(() => scenario.run(), error => error === cleanup);
  scenario.assertPhysicalAndCanonical();
  assert.equal(scenario.cleanupCount, 1);
  assert.equal(fs.existsSync(scenario.output), false);
});

test("a live Git output unit preserves body failure before cleanup failure", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  const body = new Error("consumer body failed");
  const cleanup = new Error("cleanup also failed");
  scenario.bodyFailure = body;
  scenario.cleanupFailure = cleanup;
  assert.throws(() => scenario.run(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [body, cleanup]);
    assert.equal(error.cause, body);
    return true;
  });
  scenario.assertPhysicalAndCanonical();
  assert.equal(scenario.cleanupCount, 1);
});

test("a nested Git output unit retains the enclosing runtime publication owner", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  await scenario.acquire();
  // The enclosing scope intentionally publishes after the inner settled
  // output has been consumed and released. No early drain may bypass it.
  scenario.outputExistsAtPublication = false;
  assert.equal(scenario.runtime.withDeferredEventPublicationSync(() => {
    assert.equal(scenario.run(), scenario.value);
    assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
    assert.deepEqual(scenario.canonicalEvents(), []);
    assert.deepEqual(scenario.cleanupAcknowledgements, []);
    assert.equal(scenario.cleanupCount, 1);
    assert.equal(fs.existsSync(scenario.output), false);
    return scenario.value;
  }), scenario.value);
  scenario.assertPhysicalAndCanonical();
});


function includesOriginalCause(failure, original) {
  const pending = [failure];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === original) return true;
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

test("Git output publication loss remains a typed control failure with genuine durable completion and replay", { timeout: 120000 }, async t => {
  const scenario = new GitOutputPublicationScenario(t);
  // This checks ordinary public control semantics, not an observer-imposed
  // publication-unit boundary. Both old and new product run the same one Git.
  scenario.enforceBoundary = false;
  await scenario.acquire();
  const original = new Error("canonical save completed before actual acknowledgement delivery failed");
  scenario.publicationFailure = original;
  let cleanupCount = 0;
  let actualFailure;
  assert.throws(() => scenario.runtime.enter(() => withGitOutputCleanup(() => {
    return runGitToFile(["rev-parse", "HEAD"], { cwd: scenario.root,
      outputPath: path.join(scenario.output, "head.bin"), log: false });
  }, () => {
    cleanupCount++;
    fs.rmSync(scenario.output, { recursive: true });
  })), error => {
    actualFailure = error;
    assert.ok(error instanceof ProcessExecutionControlFailure,
      "canonical publication failure must retain process-control classification");
    assert.equal(error.code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
    assert.equal(error.executionId, scenario.runtime.executionId);
    assert.equal(includesOriginalCause(error, original), true);
    return true;
  });
  assert.equal(cleanupCount, 1);
  assert.equal(fs.existsSync(scenario.output), false);
  const pending = scenario.inventory();
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.events.length, 4);
  assert.deepEqual(pending.eventAcknowledgements, []);
  const call = pending.calls[0];
  const receipt = new ProcessExecutionStopReceipt(call.receipt);
  assert.equal(receipt.stopEvidence.status, "confirmed");
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.callId, call.callId);
  if (actualFailure.callId !== null) {
    assert.equal(actualFailure.callId, call.callId);
    assert.ok(actualFailure.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
    assert.deepEqual(actualFailure.processExecutionStopReceipt.toJSON(), call.receipt);
  }
  assert.deepEqual(scenario.canonicalEvents().map(entry => entry.processEvent), pending.events);
  scenario.publicationFailure = null;
  assert.deepEqual(await scenario.runtime.drainEvents(), pending.events.map(event => event.eventId));
  assert.deepEqual(await scenario.runtime.drainEvents(), []);
  const resumed = scenario.inventory();
  assert.equal(resumed.calls.length, 1, "replay cannot physically invoke Git again");
  assert.deepEqual(resumed.eventAcknowledgements.map(entry => entry.eventId), pending.events.map(event => event.eventId));
  const canonical = scenario.canonicalEvents();
  assert.equal(canonical.length, 4);
  assert.equal(new Set(canonical.map(entry => entry.id)).size, 4);
  assert.equal(fs.readFileSync(path.join(scenario.root, "tracked.txt"), "utf8"), "tracked bytes\n");
});
