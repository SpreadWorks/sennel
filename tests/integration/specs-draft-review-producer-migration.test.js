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
import { CanonicalCommandAttemptArtifactHistory } from "../../src/flow/lib/canonical-command-result.js";
import { CanonicalDraftReviewObservation } from "../../src/flow/lib/canonical-review-artifacts.js";
import { draftReviewRouteForRetryPhase } from "../../src/flow/lib/draft-review-routes.js";
import { CanonicalFlowVersionReader, Cursor, QueryRequest } from "../../src/flow/query.js";
import { dispatchContainer, dispatchFlowCommand } from "../support/infrastructure/flow-dispatch-scenario.js";

test("a genuine previous managed Draft Review retains its complete history and publication identity through migration and current query", async t => {
  const base = createTmpDir("previous-draft-review-migration-");
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
      factsPath: path.join(base, "facts.json"), logPath, driverName: "previous-draft-review-producer.mjs" });
  } catch (cause) {
    console.error("Previous Draft Review producer log:", fs.readFileSync(logPath, "utf8"));
    throw cause;
  }
  assert.equal(facts.producerExit.code, 0);
  assert.equal(facts.producerExit.signal, null);
  assert.equal(facts.originalOwnerReleased, true);
  assert.equal(facts.catalogVerified, true);
  assert.equal(facts.currentStep, "draft-refine");
  assert.equal(facts.sourcePackageRevision, source.sourcePackageRevision);
  assert.equal(facts.receipt.schemaVersion, 3);
  console.log("Genuine previous managed Draft Review:", JSON.stringify(facts));
  const logger = { errors: [], log() {}, error(value) { this.errors.push(String(value)); } };
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: root, logger }).run().complete, true, logger.errors.join("\n"));
  const directory = path.join(root, ...facts.locationRelativeDirectory.split("/"));
  const flowBytes = fs.readFileSync(path.join(directory, "flow.json"));
  const historyBytes = fs.readFileSync(path.join(directory, ...facts.historyRelativePath.split("/")));
  const before = new StoredFlowPersistenceSnapshot(root);
  assert.equal(new SpecsMigrationRevisionSix(root, { specId: facts.specId, dryRun: true, logger }).run().complete, true, logger.errors.join("\n"));
  before.assertUnchanged();
  assert.equal(new SpecsMigrationRevisionSix(root, { specId: facts.specId, logger }).run().complete, true, logger.errors.join("\n"));
  assert.deepEqual(fs.readFileSync(path.join(directory, "flow.json")), flowBytes);
  assert.deepEqual(fs.readFileSync(path.join(directory, ...facts.historyRelativePath.split("/"))), historyBytes);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: facts.specId });
  const state = manager.canonicalState(facts.specId);
  const readBefore = new StoredFlowPersistenceSnapshot(root);
  manager.readCanonicalTransitionView({ specId: facts.specId, read(view) {
    const descriptor = view.catalog.resolve(facts.historyRelativePath);
    assert.equal(descriptor.hash, facts.historyHash);
    const snapshot = view.readArtifactSnapshot(descriptor);
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: facts.logicalKey, bytes: snapshot.bytes });
    const record = history.currentRecord;
    assert.equal(record.nodeId, facts.stepId);
    assert.equal(record.payload.processStop.schemaVersion, 3);
    const review = new CanonicalDraftReviewObservation({ payload: record.payload, state,
      route: draftReviewRouteForRetryPhase(facts.phase), processEvidence: snapshot.processEvidence });
    assert.equal(review.processStop.receipt.schemaVersion, 4);
    assert.equal(review.processStop.receipt.evidenceDigest, facts.originalReceiptDigest);
    assert.equal(review.settlementPublication(record).digest, facts.publicationDigest);
    const publication = view.activities.find(entry => entry.id === facts.publicationActivityId);
    assert.equal(publication.result.draftSettlementReceipt.publicationDigest, facts.publicationDigest);
  } });
  assert.equal(state.nextAction()?.nodeId, "draft-refine");
  const next = await dispatchFlowCommand({ container: dispatchContainer({ root, flowManager: manager, agent: {} }),
    group: "get", name: "next-action", argv: ["--expect-run-id", facts.runId] });
  assert.equal(next.envelope.ok, true, next.stdout);
  assert.equal(next.envelope.data.step, "draft-refine");
  const reader = new CanonicalFlowVersionReader({ repositoryRoot: root });
  const metadata = await reader.read(facts.specId, 1, new QueryRequest({ resource: "metadata", condition: { specId: facts.specId } }));
  assert.equal(metadata.version.projectionError, null);
  const publication = metadata.version.activities.find(entry => entry.id === facts.publicationActivityId);
  const query = { resource: "activities", condition: { specId: facts.specId }, page: { limit: 100, after: null } };
  query.page.after = new Cursor({ request: new QueryRequest(query), order: publication.confirmationOrder - 1,
    snapshotId: metadata.version.response.snapshot.id }).encode();
  const captured = await reader.read(facts.specId, 1, new QueryRequest(query));
  assert.equal(captured.version.projectionError, null, JSON.stringify(captured.version.projectionError));
  assert.equal(captured.version.response.completeness.details, "complete");
  const published = captured.version.response.items.find(item => item.activity.id === facts.publicationActivityId);
  const terminal = captured.version.response.items.find(item => item.activity.id === facts.terminalActivityId);
  assert.ok(published);
  assert.ok(terminal);
  assert.equal(published.detailCoverage.evaluations.count, 1);
  assert.deepEqual(terminal.detailRefs, published.detailRefs);
  readBefore.assertUnchanged();
  console.log("Previous Draft Review exact history, publication digest, registered next-action and queried terminal passed");
  complete = true;
});
