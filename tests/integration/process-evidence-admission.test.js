import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowArtifactCatalog } from "../../src/lib/flow-version.js";
import { FlowExecutionContract, FlowExecutionContractRefusal } from "../../src/flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../../src/flow/lib/canonical-prompt-execution.js";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";

const options = { skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false };

class MigratedProcessEvidenceScenario {
  constructor(t, directory) {
    this.root = createTmpDir("process-evidence-admission-");
    this.completed = false;
    t.after(() => {
      if (this.completed) removeTmpDir(this.root);
      else testTemporaryRoot().retainOnUnconfirmedExecution();
    });
    const seed = new CanonicalProcessEvidenceFixture(directory);
    const provenance = seed.provenance;
    seed.materialize(this.root);
    writeJson(this.root, ".sennel/config.json", { flow: { specDir: "specs" } });
    this.specId = provenance.specId;
    this.contract = FlowExecutionContract.fromJSON(provenance.executionContract);
    const output = { errors: [], log() {}, error(message) { this.errors.push(message); } };
    assert.equal(new SpecsMigrationRevisionSix(this.root, { specId: this.specId, logger: output }).run().complete,
      true, output.errors.join("\n"));
    this.manager = new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false, specId: this.specId });
    this.location = this.manager.specLocation(this.specId);
  }
  historicalRead() {
    return this.manager.readCanonicalTransitionView({ specId: this.specId, read: view =>
      readStoredPromptExecutionEpisodeFromView(view, this.contract, null, { currentAttempt: false }) });
  }
}

test("historical no-launch readback does not authorize its retained checkout as the current execution checkout", options, t => {
  const value = new MigratedProcessEvidenceScenario(t, new URL("../fixtures/process-evidence-consumed-v1/", import.meta.url));
  assert.equal(value.historicalRead().budget.providerCallCount, 1);
  const before = new StoredFlowPersistenceSnapshot(value.root);
  assert.throws(() => value.manager.readStoredPromptExecutionEpisode({ executionContract: value.contract, currentAttempt: false }),
    error => error instanceof FlowExecutionContractRefusal && error.message.includes("checkout identity"));
  before.assertUnchanged();
  value.completed = true;
});

test("an actual stopped child still requires a cataloged immutable physical source during historical readback", options, t => {
  const value = new MigratedProcessEvidenceScenario(t, new URL("../fixtures/process-evidence-physical-v1/", import.meta.url));
  assert.equal(value.historicalRead().budget.providerCallCount, 0);
  const catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(value.location.catalogFile)));
  const sources = catalog.artifacts.filter(entry => entry.logicalKey === "execution.source.manifest");
  assert.ok(sources.length > 0);
  // Deliberately missing source boundary. Removing its owned fixture file too
  // keeps the catalog namespace complete, so the historical source check is
  // exercised rather than the earlier orphaned-file rejection.
  const missingSource = new FlowArtifactCatalog({ artifacts: catalog.artifacts.filter(entry => entry.logicalKey !== "execution.source.manifest") });
  fs.writeFileSync(value.location.catalogFile, `${JSON.stringify(missingSource.toJSON(), null, 2)}\n`);
  for (const source of sources) fs.unlinkSync(value.location.resolve(source.relativePath));
  const before = new StoredFlowPersistenceSnapshot(value.root);
  assert.throws(() => value.historicalRead(), error => error instanceof FlowExecutionContractRefusal
    && error.message.includes("no registered immutable source"));
  before.assertUnchanged();
  value.completed = true;
});
