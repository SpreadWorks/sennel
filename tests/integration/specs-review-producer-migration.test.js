import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { materializeFrozenRuntimeSource, materializeFrozenProducerSupportSource, runFrozenRuntimeDriver } from "../support/infrastructure/frozen-runtime-source.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { ProcessRuntimeRecordMigration } from "../../src/lib/process-runtime-record-migration.js";
import { ProcessRuntimeRecordMigrationStorage } from "../../src/lib/process-execution-runtime.js";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { SpecReviewOperations } from "../../src/flow/lib/spec-review-operations.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../src/flow/lib/worker-artifact-handoff.js";
import { specWorkerStepRegistration } from "../../src/flow/engine/composition/spec.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import { CanonicalFlowVersionReader, QueryRequest, Cursor } from "../../src/flow/query.js";

test("a genuine previous closed Spec Review graph migrates and replays without changing its producer hashes or Flow bytes", async t => {
  const base = createTmpDir("previous-review-migration-");
  const root = path.join(base, "checkout");
  let complete = false;
  t.after(() => {
    if (!complete) { testTemporaryRoot().retainOnUnconfirmedExecution(); return; }
    new ProcessRuntimeRecordMigrationStorage({ mainRoot: root }).assertQuiescent();
    removeTmpDir(base);
  });
  const packageRoot = path.join(base, "original-source");
  const oldFixture = fileURLToPath(new URL("../fixtures/process-runtime-record-v9/", import.meta.url));
  const supportFixture = fileURLToPath(new URL("../fixtures/process-evidence-review-producer-v1/", import.meta.url));
  const source = materializeFrozenRuntimeSource(packageRoot, oldFixture, "producer-package-v9.provenance.json");
  materializeFrozenProducerSupportSource(packageRoot, supportFixture, "producer-support.provenance.json", source.sourcePackageRevision);
  const logPath = path.join(base, "producer.log");
  let facts;
  try {
    facts = await runFrozenRuntimeDriver({ packageRoot, targetRoot: root,
      factsPath: path.join(base, "facts.json"), logPath, driverName: "previous-review-producer.mjs" });
  } catch (cause) {
    console.error("Previous Review producer log:", fs.readFileSync(logPath, "utf8"));
    throw cause;
  }
  assert.equal(facts.producerExit.code, 0);
  assert.equal(facts.producerExit.signal, null);
  assert.equal(facts.originalOwnerReleased, true);
  assert.equal(facts.catalogVerified, true);
  assert.equal(facts.oldTerminalReplayVerdict, "PASS");
  assert.equal(facts.currentStep, "spec-triage");
  assert.equal(facts.receipt.schemaVersion, 3);
  assert.equal(facts.sourcePackageRevision, source.sourcePackageRevision);
  assert.ok(facts.sourceManifestRevisions.every(revision => revision === 1));
  console.log("Genuine previous Review graph:", JSON.stringify({ sourcePackageRevision: facts.sourcePackageRevision,
    sourceRuntimeRecordVersion: facts.sourceRuntimeRecordVersion, sourceManifestRevisions: facts.sourceManifestRevisions,
    originalOwnerReleased: facts.originalOwnerReleased, catalogVerified: facts.catalogVerified,
    oldTerminalReplayVerdict: facts.oldTerminalReplayVerdict, currentStep: facts.currentStep,
    reviewDigest: facts.reviewDigest, originalReceiptDigest: facts.originalReceiptDigest }));
  const logger = { errors: [], log() {}, error(value) { this.errors.push(String(value)); } };
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: root, logger }).run().complete, true, logger.errors.join("\n"));
  const flowPath = path.join(root, ...facts.locationRelativeDirectory.split("/"), "flow.json");
  const originalFlowBytes = fs.readFileSync(flowPath);
  const before = new StoredFlowPersistenceSnapshot(root);
  const preview = new SpecsMigrationRevisionSix(root, { specId: facts.specId, dryRun: true, logger }).run();
  before.assertUnchanged();
  assert.equal(preview.complete, true, logger.errors.join("\n"));
  assert.equal(new SpecsMigrationRevisionSix(root, { specId: facts.specId, logger }).run().complete, true, logger.errors.join("\n"));
  assert.deepEqual(fs.readFileSync(flowPath), originalFlowBytes);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: facts.specId });
  const state = manager.canonicalState(facts.specId);
  const read = manager.readCurrentSpecReview({ specId: facts.specId, consumerNodeId: "spec-triage" });
  assert.equal(read.descriptor.hash, facts.reviewDigest);
  assert.equal(read.review.digest, facts.reviewDigest);
  assert.equal(read.review.processStop.schemaVersion, 4);
  assert.equal(read.review.processStop.evidenceDigest, facts.originalReceiptDigest);
  const replay = await SpecReviewOperations.terminalReplay({ flowManager: manager, state, executionRoot: root });
  assert.equal(replay.artifacts.verdict, "PASS");
  assert.equal(replay.artifacts.reviewDigest, facts.reviewDigest);
  assert.equal(state.nextAction()?.nodeId, "spec-triage");
  console.log("Previous Review migration and exact terminal replay passed");
  const coordinator = new WorkerArtifactHandoffCoordinator();
  for (const stepId of ["spec-triage", "spec-repair"]) {
    manager.beginNextAction(facts.specId);
    const current = manager.loadReadOnly(facts.specId);
    assert.equal(manager.canonicalState(facts.specId).current.at(-1), stepId);
    const ctx = { root, mainRoot: root, executionRoot: root, specId: facts.specId,
      flowManager: manager, flowState: current, config: {} };
    const request = coordinator.createRequest({ ctx, state: current, invocation: {
      id: `previous-review-downstream-${stepId}`, target: { digest: "a".repeat(64) },
      action: { digest: "b".repeat(64), nextAction: { step: stepId } },
    } });
    const reviewInput = request.inputs.find(input => input.name === "review.json");
    const proofInput = request.inputs.find(input => input.name === "review-process-evidence.json");
    assert.ok(proofInput, "a new downstream request must bind the retained receipt proof");
    assert.equal(reviewInput.document.processStop.schemaVersion, 3,
      "the worker receives the original producer serialization and digest");
    if (stepId === "spec-triage") assert.equal(reviewInput.digest, facts.reviewDigest);
    // Fake only the external worker response; preparation, interpretation,
    // publication and settlement use the production Step registration.
    fs.writeFileSync(request.payloadPath("review.delta.json"), JSON.stringify({
      version: 2, stage: stepId, identity: reviewInput.document.identity,
      baseReviewDigest: reviewInput.digest, findings: [], operations: [],
    }));
    sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
    const prepared = await specWorkerStepRegistration(stepId).create({ ctx, request, handoffCoordinator: coordinator });
    const result = await new RunDispatchCommand().runSpecWorkerStep(prepared);
    assert.equal(result.stepResult.kind, stepId === "spec-triage" ? "spec-triage-completed" : "spec-repair-unchanged");
    const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: facts.specId });
    const downstream = restored.readCurrentSpecReview({ specId: facts.specId,
      consumerNodeId: stepId === "spec-triage" ? "spec-repair" : "spec-gate" });
    assert.equal(downstream.review.processStop.evidenceDigest, facts.originalReceiptDigest);
    assert.equal(downstream.review.audit.at(-1).stage, stepId);
    assert.equal(restored.canonicalState(facts.specId).nextAction()?.nodeId,
      stepId === "spec-triage" ? "spec-repair" : "spec-gate");
  }
  console.log("Previous Review consumed and saved by current Triage and Repair");
  const queryBefore = new StoredFlowPersistenceSnapshot(root);
  const reader = new CanonicalFlowVersionReader({ repositoryRoot: root });
  const prefix = await reader.read(facts.specId, 1, new QueryRequest({ resource: "activities",
    condition: { specId: facts.specId }, page: { limit: 100, after: null } }));
  // The frozen fixture's predecessor Draft uses its generic confirmation
  // helper. It does not produce the supported typed Draft lifecycle detail.
  // Unknown semantic fields must still refuse; process migration cannot
  // invent that missing producer meaning. Assert refusal and non-mutation.
  assert.equal(prefix.version.projectionError?.code, "DETAIL_UNAVAILABLE");
  assert.equal(prefix.version.projectionError?.reason, "PRODUCER_NOT_SUPPORTED");
  const unsupported = prefix.version.activities.find(activity => activity.id === prefix.version.projectionError.referenceId);
  assert.ok(["draft-questions-review", "draft-coverage-review"].includes(unsupported?.nodeId));
  queryBefore.assertUnchanged();
  const metadata = await reader.read(facts.specId, 1, new QueryRequest({ resource: "metadata", condition: { specId: facts.specId } }));
  assert.equal(metadata.version.projectionError, null);
  const publication = metadata.version.activities.find(activity => activity.reviewPublication?.stage === "spec-review");
  assert.ok(publication);
  const query = { resource: "activities", condition: { specId: facts.specId }, page: { limit: 100, after: null } };
  query.page.after = new Cursor({ request: new QueryRequest(query), order: publication.confirmationOrder - 1,
    snapshotId: metadata.version.response.snapshot.id }).encode();
  const captured = await reader.read(facts.specId, 1, new QueryRequest(query)).catch(error => {
      const causes = [];
      for (let cause = error; cause && causes.length < 8; cause = cause.cause) {
        causes.push({ name: cause.name, code: cause.code, message: cause.message, stack: cause.stack });
      }
      console.error("Migrated Review query failure:", JSON.stringify(causes));
      throw error;
    });
  assert.equal(captured.version.projectionError, null, JSON.stringify(captured.version.projectionError));
  assert.equal(captured.version.response.ok, true);
  assert.equal(captured.version.response.completeness.details, "complete");
  assert.ok(captured.version.activities.some(activity => activity.reviewPublication?.stage === "spec-triage"));
  assert.ok(captured.version.activities.some(activity => activity.reviewPublication?.stage === "spec-repair"));
  const selectedIds = new Set(captured.version.response.items.map(item => item.activity.id));
  for (const stage of ["spec-review", "spec-triage", "spec-repair"]) {
    const owner = captured.version.activities.find(activity => activity.reviewPublication?.stage === stage);
    assert.ok(selectedIds.has(owner.id), `${stage} must be included in the actual queried suffix`);
  }
  queryBefore.assertUnchanged();
  console.log("Previous Review consumed by registered current Triage and Repair, reloaded and queried");
  complete = true;
});
