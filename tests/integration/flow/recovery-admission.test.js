import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

/** Real producer transitions followed by a missing catalog-entry boundary input. */
class RecoveryAdmissionScenario {
  constructor(t, operation) {
    this.root = createTmpDir("recovery-admission-");
    t.after(() => removeTmpDir(this.root));
    this.specId = "001-recovery-admission";
    this.manager = makeFlowManager(this.root);
    const fixture = new CanonicalFlowFixture({
      flowManager: this.manager, specId: this.specId,
    }).create().activate("test-review").settle("test-review");
    if (operation === "recover") {
      this.manager.rewindTo("scenario-validity", { specId: this.specId });
      fixture.settleBefore("test-review");
    }
    const state = this.manager.canonicalState(this.specId);
    assert.equal(state.current, null);
    const target = state.definition.pathFor(state.root, "test-review");
    assert.equal(state.recoveryTarget(target).assertLegal().operation, operation);
    this.directory = this.manager._store.runtime.location(this.specId).directory;
  }

  removeProducerCatalogEntry() {
    // Model missing persisted evidence at the storage boundary, not an invented
    // lifecycle. The producer was completed through the normal fixture API.
    const catalogPath = path.join(this.directory, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const removed = catalog.artifacts.filter((entry) => entry.logicalKey === "scenario.validity");
    assert.equal(removed.length, 1);
    fs.unlinkSync(path.join(this.directory, removed[0].relativePath));
    catalog.artifacts = catalog.artifacts.filter((entry) => entry.logicalKey !== "scenario.validity");
    // Keep the catalog envelope valid so the consumer admission, rather than
    // the catalog checksum validator, must reject the missing producer.
    fs.writeFileSync(catalogPath, `${JSON.stringify(new FlowArtifactCatalog(catalog).toJSON(), null, 2)}\n`);
    this.manager = makeFlowManager(this.root);
  }

  snapshot() {
    const entries = [];
    const visit = (directory) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name);
        if (fs.statSync(file).isDirectory()) visit(file);
        else entries.push([path.relative(this.directory, file), fs.readFileSync(file).toString("base64")]);
      }
    };
    visit(this.directory);
    return entries;
  }
}

for (const operation of ["recover", "rewind"]) {
  test(`${operation} refuses a missing producer without publishing an Attempt or baseline`, (t) => {
    const scenario = new RecoveryAdmissionScenario(t, operation);
    scenario.removeProducerCatalogEntry();
    const before = scenario.snapshot();
    assert.throws(
      () => scenario.manager.rewindTo("test-review", { specId: scenario.specId }),
      (error) => error.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY"
        && error.producerNodeId === "scenario-validity"
        && error.consumerNodeId === "test-review",
    );
    assert.deepEqual(scenario.snapshot(), before);
    const reloaded = makeFlowManager(scenario.root).canonicalState(scenario.specId);
    assert.equal(reloaded.current, null);
  });
}
