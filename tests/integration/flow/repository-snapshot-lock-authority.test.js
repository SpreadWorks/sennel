import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { WorkerArtifactRepositoryMutationSnapshot, SourceWorkerCanonicalObservationAdvance } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionEvent } from "../../../src/lib/process-execution-values.js";
import { runGit } from "../../../src/lib/git-command-execution.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

test("Version snapshot retains repository authority after locks move outside the Version", (t) => {
  const root = createTmpDir("version-snapshot-authority-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "Repository snapshot authority\n");
  commitAll(root, "Create snapshot authority fixture");
  const location = new FlowVersionLocation({ repositoryRoot: root, authorityScope: "canonical",
    specId: "snapshot-authority", version: 1 });
  fs.mkdirSync(location.directory, { recursive: true });
  fs.writeFileSync(path.join(location.directory, "observation.json"), "{}\n");
  const locks = [location.runtimeLock("runtime.lock.artifact-catalog"),
    location.runtimeLock("runtime.lock.current-flow-state")];
  const before = fs.readdirSync(location.directory);
  const captured = WorkerArtifactRepositoryMutationSnapshot.capture({ root: location.directory,
    authorities: ["canonical"], runtimeLocks: locks });
  assert.equal(captured.mode, "filesystem");
  assert.deepEqual(captured.runtimeLocks, locks);
  assert.deepEqual(fs.readdirSync(location.directory), before,
    "observational Git probes must not create a runtime inside canonical Version content");
  assert.equal(WorkerArtifactRepositoryMutationSnapshot.capture(captured).digest, captured.digest);
  assert.deepEqual(fs.readdirSync(location.directory), before);
  assert.equal(fs.readFileSync(path.join(location.directory, "observation.json"), "utf8"), "{}\n");
});

function canonicalGitScenario(t) {
  const root = createTmpDir("canonical-snapshot-process-events-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".tmp/\n.sennel/\nspecs/\n");
  fs.writeFileSync(path.join(root, "README.md"), "Canonical Git observation\n");
  commitAll(root, "Create canonical Git observation fixture");
  const manager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({ flowManager: manager }).create().activate("branch");
  const ctx = { root, mainRoot: root, executionRoot: root, flowManager: manager,
    specId: fixture.specId, flowState: manager.loadReadOnly(fixture.specId) };
  return { root, manager, fixture, ctx };
}

function assertPublishedGitFacts({ root, fixture }, runtime, minimumCalls) {
  const ledger = makeFlowManager(root).activityLedger(fixture.specId);
  const facts = ledger.filter((entry) => entry.processEvent?.executionId === runtime.executionId);
  const calls = new Map();
  for (const activity of facts) {
    const event = activity.processEvent;
    if (!calls.has(event.callId)) calls.set(event.callId, []);
    calls.get(event.callId).push(event);
  }
  assert.ok(calls.size >= minimumCalls);
  assert.equal(new Set(facts.map((entry) => entry.id)).size, facts.length);
  for (const events of calls.values()) {
    assert.deepEqual(events.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
    assert.ok(events.every((event) => event.binding.runId === fixture.runId
      && event.binding.specId === fixture.specId));
  }
  const persisted = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
  assert.ok(persisted);
  const identities = (events) => events.map((stored) => {
    const event = ProcessExecutionEvent.fromStored(stored);
    return { eventId: event.eventId, eventDigest: event.digest };
  });
  assert.deepEqual(identities(facts.map((entry) => entry.processEvent)), identities(persisted.events),
    "fresh canonical Activities account for the entire durable runtime event inventory");
  assert.deepEqual(persisted.eventAcknowledgements, identities(persisted.events),
    "every canonical acknowledgement binds the exact persisted event digest");
  assert.deepEqual(persisted.runtimeOnlyDispositions, [], "bound observations cannot be discarded as runtime-only");
  assert.deepEqual(runtime.drainEventsSync(), [], "every durable event was acknowledged after canonical publication");
  assert.deepEqual(makeFlowManager(root).activityLedger(fixture.specId), ledger,
    "acknowledged replay cannot append a duplicate Activity");
}

function assertPendingGitFacts(runtime, previousEventIds) {
  const persisted = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
  const events = persisted.events.filter((event) => !previousEventIds.has(event.eventId));
  assert.deepEqual(events.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
  assert.equal(new Set(events.map((event) => event.callId)).size, 1);
  assert.ok(events.every((event) => !persisted.eventAcknowledgements.some((ack) => ack.eventId === event.eventId)),
    "events stay durable and unacknowledged while their canonical catalog lock is held");
  assert.deepEqual(persisted.runtimeOnlyDispositions, []);
}

test("canonical snapshot Git publishes exact process facts after its catalog read unlocks", async (t) => {
  const scenario = canonicalGitScenario(t);
  await withFlowProcessRuntime(scenario.ctx, () => {
    const runtime = ProcessExecutionRuntime.current();
    const observation = SourceWorkerCanonicalObservationAdvance.capture({
      flowManager: scenario.manager, specId: scenario.fixture.specId,
    });
    assert.ok(observation instanceof SourceWorkerCanonicalObservationAdvance);
    const previousEventIds = new Set(runtime.inspect().executions
      .find((entry) => entry.executionId === runtime.executionId).events.map((event) => event.eventId));
    scenario.manager.readCanonicalTransitionView({ specId: scenario.fixture.specId,
      read: (view) => {
        observation.assertTransitionView(view);
        assertPendingGitFacts(runtime, previousEventIds);
      } });
    assertPublishedGitFacts(scenario, runtime, 2);
  }, { required: true });
});

test("a rejected canonical reader preserves its error and publishes completed Git facts after unlock", async (t) => {
  const scenario = canonicalGitScenario(t);
  await withFlowProcessRuntime(scenario.ctx, () => {
    const runtime = ProcessExecutionRuntime.current();
    const rejection = new Error("canonical reader rejects after observing Git");
    const previousEventIds = new Set(runtime.inspect().executions
      .find((entry) => entry.executionId === runtime.executionId).events.map((event) => event.eventId));
    assert.throws(() => scenario.manager.readCanonicalTransitionView({ specId: scenario.fixture.specId,
      read: () => {
        const result = runGit(["status", "--porcelain=v2", "-z"], { cwd: scenario.root });
        assert.equal(result.status, 0);
        assertPendingGitFacts(runtime, previousEventIds);
        throw rejection;
      } }), (error) => error === rejection || error.cause === rejection);
    assertPublishedGitFacts(scenario, runtime, 1);
  }, { required: true });
});
