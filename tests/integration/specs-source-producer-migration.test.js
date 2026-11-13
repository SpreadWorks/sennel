import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { materializeFrozenRuntimeSource, materializeFrozenProducerSupportSource, runFrozenRuntimeDriver } from "../support/infrastructure/frozen-runtime-source.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { ProcessRuntimeRecordMigration } from "../../src/lib/process-runtime-record-migration.js";
import { ProcessRuntimeRecordMigrationStorage } from "../../src/lib/process-execution-runtime.js";
import { SpecsMigrationRevisionSix, inspectFlowMigrationRequirements } from "../../src/lib/specs-migration.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { SourceWorkerHandoffIdentity } from "../../src/flow/lib/worker-artifact-handoff.js";
import { TaskStepIdentity } from "../../src/flow/lib/task-step-identity.js";
import { dispatchContainer, dispatchFlowCommand } from "../support/infrastructure/flow-dispatch-scenario.js";

for (const pending of [false, true]) test(pending
  ? "a genuine previous sealed pending Source refuses migration without changing its producer evidence"
  : "a genuine previous managed Source exit migrates without changing its event lineage and drives the current next action", async t => {
  const base = createTmpDir("previous-source-migration-");
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
      factsPath: path.join(base, "facts.json"), logPath, driverName: "previous-source-producer.mjs",
      driverArgs: [pending ? "sealed-pending" : "settled"] });
  } catch (cause) {
    console.error("Previous Source producer log:", fs.readFileSync(logPath, "utf8"));
    throw cause;
  }
  assert.equal(facts.producerExit.code, 0);
  assert.equal(facts.producerExit.signal, null);
  assert.equal(facts.originalOwnerReleased, true);
  assert.equal(facts.catalogVerified, true);
  assert.equal(facts.sourceRuntimeRecordVersion, 9);
  assert.equal(facts.sourcePackageRevision, source.sourcePackageRevision);
  assert.equal(facts.producerMode, pending ? "sealed-pending" : "settled");
  console.log("Genuine previous Source graph:", JSON.stringify({ sourcePackageRevision: facts.sourcePackageRevision,
    originalOwnerReleased: facts.originalOwnerReleased, originalReceiptDigest: facts.originalReceiptDigest,
    sourceEventDigests: facts.sourceEventDigests, nextStep: facts.nextStep }));
  const logger = { errors: [], log() {}, error(value) { this.errors.push(String(value)); } };
  assert.equal(new ProcessRuntimeRecordMigration({ mainRoot: root, logger }).run().complete, true, logger.errors.join("\n"));
  const flowPath = path.join(root, ...facts.locationRelativeDirectory.split("/"), "flow.json");
  const originalFlowBytes = fs.readFileSync(flowPath);
  const before = new StoredFlowPersistenceSnapshot(root);
  const preview = new SpecsMigrationRevisionSix(root, { specId: facts.specId, dryRun: true, logger }).run();
  before.assertUnchanged();
  if (pending) {
    // The original runtime contract forbids adopting unfinished output under
    // another package revision. A sealed worker result is not a final Step receipt.
    assert.equal(preview.complete, false);
    assert.match(logger.errors.join("\n"), /UNSAFE_SOURCE_FORMAT: Previous Source receipt requires its complete settled producer graph/);
    const previewErrorCount = logger.errors.length;
    assert.equal(new SpecsMigrationRevisionSix(root, { specId: facts.specId, logger }).run().complete, false);
    assert.match(logger.errors.slice(previewErrorCount).join("\n"), /UNSAFE_SOURCE_FORMAT: Previous Source receipt requires its complete settled producer graph/);
    before.assertUnchanged();
    assert.deepEqual(fs.readFileSync(flowPath), originalFlowBytes);
    for (const original of facts.sourceArtifacts) {
      const bytes = fs.readFileSync(path.join(path.dirname(flowPath), ...original.relativePath.split("/")));
      assert.equal(bytes.length, original.size);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), original.hash);
    }
    const assessment = inspectFlowMigrationRequirements({ root, specId: facts.specId });
    assert.equal(assessment.classification, "unsupported");
    assert.equal(assessment.code, "UNSAFE_SOURCE_FORMAT");
    before.assertUnchanged();
    assert.equal(fs.readFileSync(path.join(root, "product.js"), "utf8"), "export const value = 2;\n");
    console.log("Previous pending Source refused with unchanged Flow and producer artifacts");
    complete = true;
    return;
  }
  assert.equal(preview.complete, true, logger.errors.join("\n"));
  assert.equal(new SpecsMigrationRevisionSix(root, { specId: facts.specId, logger }).run().complete, true, logger.errors.join("\n"));
  assert.deepEqual(fs.readFileSync(flowPath), originalFlowBytes);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: facts.specId });
  const location = manager.specLocation(facts.specId), catalog = manager.artifactCatalog(facts.specId);
  for (const original of facts.sourceArtifacts) {
    const descriptor = catalog.resolve(original.relativePath);
    assert.equal(descriptor.hash, original.hash);
    assert.equal(descriptor.size, original.size);
  }
  const identity = new SourceWorkerHandoffIdentity(facts.sourceIdentity);
  const readBefore = new StoredFlowPersistenceSnapshot(root);
  const authority = manager.readSourceHandoffAuthority({ specId: facts.specId, identity });
  assert.equal(authority.settlement.kind, "accepted");
  assert.equal(authority.settlement.digest, facts.settlementDigest);
  assert.deepEqual(authority.events.map(event => event.digest), facts.sourceEventDigests);
  const stopped = authority.events.find(event => event.kind === "worker-exited").processStopEvidence;
  assert.equal(stopped.receipt.schemaVersion, 4);
  assert.equal(stopped.receipt.evidenceDigest, facts.originalReceiptDigest);
  const state = manager.canonicalState(facts.specId);
  assert.equal(state.nextAction()?.nodeId, facts.nextStep);
  readBefore.assertUnchanged();
  const actionBefore = new StoredFlowPersistenceSnapshot(root);
  const result = await dispatchFlowCommand({ container: dispatchContainer({ root, flowManager: manager, agent: {} }),
    group: "get", name: "next-action", argv: ["--expect-run-id", facts.runId] });
  assert.equal(result.envelope.ok, true, result.stdout);
  const nextNode = state.nextAction()?.nodeId;
  const publicStep = TaskStepIdentity.fromStateNode(state, nextNode)?.definitionId ?? nextNode;
  assert.equal(result.envelope.data.step, publicStep);
  assert.equal(typeof result.envelope.data.binding, "string");
  actionBefore.assertUnchanged();
  assert.equal(fs.readFileSync(path.join(root, "product.js"), "utf8"), "export const value = 2;\n");
  console.log("Previous Source receipt, exact event lineage and current registered next-action passed");
  complete = true;
});
