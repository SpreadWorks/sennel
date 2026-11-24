import assert from "node:assert/strict";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { WorkerArtifactRepositoryEntry } from "../../../src/flow/lib/source-working-file.js";
import fs from "node:fs";
import { it } from "node:test";
import { FreshFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { FlowExecutionObservationFact, FlowExecutionObservationBinding, captureExecutionObservations } from "../../../src/lib/flow-execution-observation.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { CurrentFlowVersionStore } from "../../../src/flow/lib/current-flow-state.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { FlowArtifactCatalog, FlowArtifactCatalogStore } from "../../../src/lib/flow-version.js";
import { CurrentFlowOutboxAttemptHistory } from "../../../src/flow/lib/flow-outbox-attempt-history.js";
import { FlowOutboxStore, FlowOutboxIdentity } from "../../../src/flow/lib/flow-outbox.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import path from "node:path";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { FlowExecutionInputBaseline } from "../../../src/flow/lib/flow-execution-input-baseline.js";
import { SourceWorkerCanonicalObservationAdvance, SourceMutationBaseline, SourceMutationManifest, WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SourceExecutionObservationAppends, SourceExecutionObservationCatalogBaseline } from "../../../src/flow/lib/source-execution-observation-appends.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";

function fixture(t) {
  const root = createTmpDir();
  t.after(() => removeTmpDir(root));
  const manager = makeFlowManager(root);
  const flow = new FreshFlowFixture({ flowManager: manager, specId: "001-observations", runId: "run-observations", execution: { mode: "direct" } })
    .create().registerActive();
  manager.beginNextAction("001-observations");
  return { root, manager, flow };
}

function committedObservationBaseline(root, manager) {
  const location = manager.specLocation("001-observations");
  const result = runGit(["show", `HEAD:${location.relativeCatalogFile}`], { cwd: root });
  assert.equal(result.ok, true, result.stderr);
  return new SourceExecutionObservationCatalogBaseline({ root,
    catalog: FlowArtifactCatalog.fromSerialized(JSON.parse(result.stdout)) });
}

it("projects saved and reloaded observation additions against the actual Git-committed catalog without allowing unregistered peers", (t) => {
  const { root, manager } = fixture(t);
  initGitRepo(root);
  commitAll(root, "Record canonical catalog before source registration");
  const baseline = committedObservationBaseline(root, manager);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  session.append({ id: "after-committed-baseline", kind: "agent-started", entityId: "logical-source", data: {} });
  const reconstructed = makeFlowManager(root);
  const appended = reconstructed.readCanonicalTransitionView({ specId: "001-observations",
    read: (view) => new SourceExecutionObservationAppends(view, baseline) });
  const location = reconstructed.specLocation("001-observations");
  const sourcePath = `${location.relativeDirectory}/artifacts/execution-observations/sources/${session.sourceId}.json`;
  const factPath = `${location.relativeDirectory}/artifacts/execution-observations/facts/after-committed-baseline.json`;
  assert.deepEqual(appended.appended.map((entry) => entry.relativePath).sort(), [sourcePath, factPath].sort());
  assert.equal(appended.retainedCatalog().hash, baseline.catalog.hash);
  assert.equal(appended.preservesCatalogHash(baseline.catalog.hash), true);
  assert.equal(appended.allowsFilePath(sourcePath), true);
  assert.equal(appended.allowsFilePath(factPath), true);
  assert.equal(appended.allowsFilePath(path.posix.dirname(factPath)), false,
    "a directory must not borrow an exact-file observation exemption");
  const peer = `${location.relativeDirectory}/artifacts/execution-observations/facts/unregistered-peer.json`;
  fs.writeFileSync(path.join(root, peer), "{}\n");
  assert.equal(appended.allowsFilePath(peer), false,
    "an unregistered neighboring file remains an independent dirty change");
});

it("retains existing observation descriptors when a committed catalog baseline receives a new fact", (t) => {
  const { root, manager } = fixture(t);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  session.append({ id: "committed-fact", kind: "agent-started", entityId: "logical-source", data: {} });
  initGitRepo(root);
  commitAll(root, "Record existing canonical observations");
  const baseline = committedObservationBaseline(root, manager);
  session.append({ id: "new-fact", kind: "agent-response-ready", entityId: "logical-source", data: {} });
  const location = manager.specLocation("001-observations");
  const capture = () => makeFlowManager(root).readCanonicalTransitionView({ specId: "001-observations",
    read: (view) => new SourceExecutionObservationAppends(view, baseline) });
  assert.equal(capture().preservesCatalogHash(baseline.catalog.hash), true);
  const raw = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  const retained = raw.artifacts.find((entry) => entry.logicalKey === "execution.observation"
    && entry.relativePath.endsWith("/committed-fact.json"));
  retained.mediaType = "text/plain";
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(FlowArtifactCatalog.regenerate(raw.artifacts).toJSON(), null, 2)}\n`);
  const changed = capture();
  assert.equal(changed.preservesCatalogHash(baseline.catalog.hash), false,
    "a valid new fact cannot hide replacement metadata on a committed observation");
  assert.equal(changed.allowsFilePath(`${location.relativeDirectory}/${retained.relativePath}`), false);
});

it("records immutable observations with the starting Attempt and reads them after reconstructing the manager", async (t) => {
  const { root, manager, flow } = fixture(t);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  const start = session.append({ id: "logical-start", kind: "agent-started", entityId: "logical-1", recordedAt: "2026-10-16T00:00:00Z", data: { responseMode: "return-to-caller" } });
  manager.addNote("Unrelated canonical progress", { specId: "001-observations" });
  flow.flow.settle(session.binding.nodeId);
  manager.beginNextAction("001-observations");
  assert.notEqual(manager.canonicalState("001-observations").attempt?.id, session.binding.attemptId);
  const ending = session.append({ id: "logical-end", kind: "agent-response-ready", entityId: "logical-1", recordedAt: "2026-10-16T00:00:01Z", data: { usage: null } });
  const restored = await makeFlowManager(root).readExecutionObservations({ specId: "001-observations" });
  assert.equal(restored.manifests.length, 1);
  assert.equal(restored.manifests[0].boundary.confirmationOrder < manager.canonicalState("001-observations").confirmationOrder, true);
  assert.equal(restored.facts.length, 2);
  assert.deepEqual(restored.facts.find((fact) => fact.id === start.id).toJSON(), start.toJSON());
  assert.deepEqual(restored.facts.find((fact) => fact.id === ending.id).binding.toJSON(), session.binding.toJSON());
  assert.equal(restored.manifests[0].runtimeSourceId, null);
  assert.equal(restored.manifests[0].producerCoverage.find((entry) => entry.producer === "direct-spawn").status, "outside-managed-scope");
  assert.equal(makeFlowManager(root).prepareExecutionObservationSession({ specId: "001-observations" }).sourceId, session.sourceId);
  const acceptanceInputs = new CanonicalAcceptanceArtifactStore({ flowManager: manager, state: manager.loadReadOnly("001-observations") }).executionInputDescriptors();
  assert.doesNotThrow(() => acceptanceInputs.map((descriptor) => new FlowExecutionInputBaseline({ descriptor })));
  assert.equal(acceptanceInputs.some((descriptor) => descriptor.logicalKey === "spec.record"), true);
  await assert.rejects(async () => {
    await captureExecutionObservations({ catalog: manager.artifactCatalog("001-observations"),
      readArtifact: (descriptor) => descriptor.readBytes(manager.canonicalVersionLocation(1, { specId: "001-observations" })),
      expectedBinding: { ...session.binding.toJSON(), flowVersionId: "foreign-version" } });
  }, /selected Version/);
});

it("allows append-only execution observations while preserving the Source worker canonical mutation boundary", (t) => {
  const { manager } = fixture(t);
  const before = SourceWorkerCanonicalObservationAdvance.capture({ flowManager: manager, specId: "001-observations" });
  const canonicalLocation = manager.canonicalVersionLocation(1, { specId: "001-observations" });
  const resumed = SourceWorkerCanonicalObservationAdvance.fromCheckpoint(before.checkpointJSON(), { canonicalLocation });
  const restored = SourceWorkerCanonicalObservationAdvance.fromStored(before.storedJSON(), { canonicalLocation });
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  session.append({ id: "source-worker-observation", kind: "agent-started", entityId: "logical-source", data: {} });
  assert.doesNotThrow(() => before.assertAllowed({ flowManager: manager, specId: "001-observations", canonicalSnapshot: before.canonicalSnapshot }));
  for (const observation of [resumed, restored]) assert.doesNotThrow(() => observation.assertAllowed({
    flowManager: manager, specId: "001-observations", canonicalSnapshot: observation.canonicalSnapshot }));
});

it("keeps present digest mismatches and filesystem omissions invalid after canonical append authentication", (t) => {
  const { manager } = fixture(t);
  const before = SourceWorkerCanonicalObservationAdvance.capture({ flowManager: manager, specId: "001-observations" });
  const baseline = new SourceMutationBaseline({ attempt: manager.canonicalState("001-observations").attempt,
    snapshot: before.canonicalSnapshot });
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  session.append({ id: "snapshot-presence-guard", kind: "agent-started", entityId: "logical-source", data: {} });
  const appends = manager.readCanonicalTransitionView({ specId: "001-observations",
    read: (view) => new SourceExecutionObservationAppends(view, before.canonicalSnapshot) });
  const location = manager.specLocation("001-observations");
  const factFile = location.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("execution.observation", { observationId: "snapshot-presence-guard" }).relativePath);
  const bytes = fs.readFileSync(factFile);
  const capture = () => SourceMutationManifest.capture({ baseline, executionObservations: appends });
  assert.equal(baseline.snapshot.mode, "filesystem");
  const factPath = path.relative(baseline.snapshot.root, factFile).split(path.sep).join("/");
  const captured = capture();
  assert.equal(captured.paths().includes(factPath), false, "authenticated observations are not source mutations");
  assert.equal(captured.assertBinding(baseline, { executionObservations: appends }), captured);
  assert.throws(() => captured.assertBinding(baseline), (error) => error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_BINDING_INVALID",
    "stored observations gain no implicit execution append exemption");
  assert.equal(appends.matches(baseline.snapshot, captured.observations), true);
  assert.equal(appends.matches(baseline.snapshot, baseline.snapshot.entries), false,
    "a current inventory cannot omit a selected authenticated append");
  assert.equal(appends.matchesRetainedEntries(baseline.snapshot, baseline.snapshot.entries), true,
    "earlier observations may predate an immutable authenticated append");
  const excluded = WorkerArtifactRepositoryMutationSnapshot.capture({ ...baseline.snapshot, ignoredDirectories: [factPath] });
  assert.equal(appends.matches(excluded), false, "a new exclusion cannot silently rebind the authenticated append selector");
  const factParent = path.posix.dirname(factPath);
  const parentBefore = captured.observations.find((entry) => entry.path === factParent);
  assert.equal(parentBefore.kind, "directory");
  const replacementParent = captured.observations.find((entry) => entry.path === factPath);
  const forgedParent = captured.observations.map((entry) => entry.path === factParent
    ? new WorkerArtifactRepositoryEntry({ path: factParent, workingPath: factParent, working: replacementParent.working, git: replacementParent.git }) : entry);
  assert.equal(appends.matchesRetainedEntries(baseline.snapshot, forgedParent), false,
    "an approved append path cannot conceal a regular ancestor after-image");

  try {
    fs.appendFileSync(factFile, "\n");
    const altered = SourceMutationManifest.capture({ baseline });
    assert.equal(appends.matchesRetainedEntries(baseline.snapshot, altered.observations), false, "present retained append bytes must still match");
    assert.throws(capture, /Execution observation appends differ from their cataloged bytes/,
      "a recorded digest mismatch cannot borrow canonical authentication");
    assert.throws(() => manager.readCanonicalTransitionView({ specId: "001-observations",
      read: (view) => new SourceExecutionObservationAppends(view, before.canonicalSnapshot) }), /catalog|content|artifact/i);
    fs.unlinkSync(factFile);
    assert.throws(capture, /Execution observation appends differ from their cataloged bytes/,
      "a filesystem snapshot omission is physical missing evidence");
    assert.throws(() => manager.readCanonicalTransitionView({ specId: "001-observations",
      read: (view) => new SourceExecutionObservationAppends(view, before.canonicalSnapshot) }), /missing|exist|ENOENT|artifact/i);
  } finally {
    fs.writeFileSync(factFile, bytes);
  }
});

it("refuses observation tampering and protected artifact changes beside a valid observation append", async (t) => {
  const replaceGeneration = file => new AtomicFile(file).write(fs.readFileSync(file));
  const cases = [
    ["existing observation bytes", (_location, factFile) => fs.appendFileSync(factFile, "\n")],
    ["existing observation generation", (_location, factFile) => replaceGeneration(factFile)],
    ["protected semantic artifact generation", (location) => replaceGeneration(location.specFile)],
    ["existing catalog authority metadata", (location) => {
      const value = JSON.parse(fs.readFileSync(location.catalogFile));
      const descriptor = value.artifacts.find((entry) => entry.logicalKey === "spec.record");
      descriptor.mediaType = "text/plain";
      const catalog = FlowArtifactCatalog.regenerate(value.artifacts);
      fs.writeFileSync(location.catalogFile, `${JSON.stringify(catalog.toJSON(), null, 2)}\n`);
    }],
    ["uncataloged execution fact", (location) => fs.writeFileSync(location.resolve("artifacts/execution-observations/facts/unregistered.json"), "{}\n")],
  ];
  for (const [name, corrupt] of cases) await t.test(name, (t) => {
    const { manager } = fixture(t);
    const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
    session.append({ id: "existing-source-fact", kind: "agent-started", entityId: "logical-source", data: {} });
    const before = SourceWorkerCanonicalObservationAdvance.capture({ flowManager: manager, specId: "001-observations" });
    session.append({ id: "new-source-fact", kind: "agent-response-ready", entityId: "logical-source", data: {} });
    const location = manager.canonicalVersionLocation(1, { specId: "001-observations" });
    const factFile = location.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("execution.observation", { observationId: "existing-source-fact" }).relativePath);
    corrupt(location, factFile);
    assert.throws(() => before.assertAllowed({ flowManager: manager, specId: "001-observations", canonicalSnapshot: before.canonicalSnapshot }),
      /catalog|artifact|Version mutation|canonical|content/i);
  });
});

it("registers immutable retained sources for separate checkout namespaces without replacing the first boundary", async (t) => {
  const { root, manager } = fixture(t);
  const otherCheckout = path.join(root, "other-checkout");
  fs.mkdirSync(otherCheckout);
  const sourceIds = [];
  for (const executionRoot of [root, otherCheckout]) {
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot, runId: "run-observations", specId: "001-observations" });
    try {
      runtime.enter(() => {
        const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
        sourceIds.push(session.sourceId);
        session.append({ kind: "agent-started", entityId: `logical-${sourceIds.length}`, data: {} });
      });
    } finally { await runtime.close(); }
  }
  assert.notEqual(sourceIds[0], sourceIds[1]);
  const restored = await makeFlowManager(root).readExecutionObservations({ specId: "001-observations" });
  assert.equal(restored.manifests.length, 2);
  assert.equal(new Set(restored.manifests.map((source) => source.checkoutNamespace)).size, 2);
  assert.equal(restored.facts.every((fact) => sourceIds.includes(fact.sourceId)), true);
});

it("rejects conflicting fact replacement and rolls back a failed catalog publication", async (t) => {
  const { root, manager } = fixture(t);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  const original = session.append({ id: "durable-beginning", kind: "agent-started", entityId: "logical-1", data: {} });
  assert.throws(() => session.append({ id: original.id, kind: "agent-failed", entityId: original.entityId, data: {} }), /immutable/);
  const location = manager.canonicalVersionLocation(1, { specId: "001-observations" });
  const before = fs.readFileSync(location.catalogFile);
  const store = new CurrentFlowVersionStore({ location, definition: buildCurrentFlowDefinition() }).executionObservationStore({ catalogStore: new FlowArtifactCatalogStore({ location,
    faultInjector: ({ phase }) => { if (phase === "before-json-rename") throw new Error("observation save failed"); } }) });
  const ending = new FlowExecutionObservationFact({ id: "failed-ending", sourceId: session.sourceId, kind: "agent-response-ready",
    entityId: original.entityId, recordedAt: "2026-10-16T00:00:01Z", binding: session.binding, data: { receiptId: "original-receipt" } });
  assert.throws(() => store.append(ending), /observation save failed/);
  assert.deepEqual(fs.readFileSync(location.catalogFile), before);
  const restored = await makeFlowManager(root).readExecutionObservations({ specId: "001-observations" });
  assert.equal(restored.facts.length, 1);
  assert.equal(restored.facts[0].kind, "agent-started");
});

it("fails closed on missing referenced observations and rejects a stale starting binding", async (t) => {
  const { root, manager } = fixture(t);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  assert.throws(() => manager.prepareExecutionObservationSession({ specId: "001-observations",
    binding: new FlowExecutionObservationBinding({ ...session.binding.toJSON(), attemptId: "foreign-attempt" }) }), /starting binding/);
  session.append({ id: "record-to-remove", kind: "agent-started", entityId: "logical-1", data: {} });
  const location = manager.canonicalVersionLocation(1, { specId: "001-observations" });
  fs.unlinkSync(location.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("execution.observation", { observationId: "record-to-remove" }).relativePath));
  await assert.rejects(async () => makeFlowManager(root).readExecutionObservations({ specId: "001-observations" }), /missing|exist|ENOENT|artifact/i);
});

it("retains fixed Outbox and metric bindings through durable status readback", async (t) => {
  const { root, manager } = fixture(t);
  const session = manager.prepareExecutionObservationSession({ specId: "001-observations" });
  const identity = new FlowOutboxIdentity({ runId: session.binding.runId, taskId: null, stepId: session.binding.nodeId, operation: "observed-operation" });
  const pending = new FlowOutboxStore(manager, { specId: session.binding.specId }).begin(identity);
  assert.equal(pending.executionBinding instanceof FlowExecutionObservationBinding, true);
  assert.equal(pending.executionBinding.attemptId, session.binding.attemptId);
  assert.equal(typeof pending.executionBinding.outboxAttemptId, "string");
  manager.accumulateAgentMetrics("draft", { specId: session.binding.specId, usage: { input_tokens: null, output_tokens: 2 },
    responseChars: 2, durationMs: 1, executionObservation: { binding: session.binding.toJSON(), logicalInvocationId: "logical-1",
      requestId: "request-1", measurementId: "measurement-1", measurementScope: "final-logical-response" } });
  const reconstructed = makeFlowManager(root);
  const metricActivity = reconstructed.activityLedger(session.binding.specId).findLast((activity) => activity.metric?.executionObservation != null);
  assert.equal(metricActivity.nodeId, session.binding.nodeId);
  assert.equal(metricActivity.metric.tokens.input, null);
  assert.equal(metricActivity.metric.tokens.cacheRead, null);
  assert.equal(metricActivity.metric.executionObservation.measurementId, "measurement-1");
  const completed = new FlowOutboxStore(reconstructed, { specId: session.binding.specId }).complete(identity, { receiptId: "original-receipt" });
  assert.equal(completed.executionBinding.outboxAttemptId, pending.executionBinding.outboxAttemptId);
  const history = CurrentFlowOutboxAttemptHistory.fromActivities(makeFlowManager(root).activityLedger(session.binding.specId));
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].status, "done");
  assert.deepEqual(history.attempts[0].executionBinding.toJSON(), pending.executionBinding.toJSON());
  assert.equal(history.attempts[0].sourceActivityIds.length, 2);
});
