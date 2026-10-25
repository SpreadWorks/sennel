import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { runGitAsync } from "../../../src/lib/git-helpers.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { configureManagedFixtureRepository, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class AdmittedAcceptanceSourceScenario {
  constructor(t) {
    this.root = fixtureRepository("admitted-acceptance-source-");
    configureManagedFixtureRepository(this.root);
    this.manager = makeFlowManager(this.root);
    this.fixture = new CanonicalFlowFixture({ flowManager: this.manager,
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" } }).create().activate("branch");
    this.specId = this.fixture.specId;
    this.runtime = null;
    t.after(() => removeQuiescentRuntimeFixture({ mainRoot: this.root }));
  }
  async acquire({ warm }) {
    const ctx = { root: this.root, mainRoot: this.root, executionRoot: this.root,
      specId: this.specId, flowManager: this.manager, flowState: this.manager.loadReadOnly(this.specId) };
    return withFlowProcessRuntime(ctx, async () => {
      this.runtime = ProcessExecutionRuntime.current();
      this.initialCatalog = this.manager.artifactCatalog(this.specId);
      if (warm) {
        const result = await runGitAsync(["--version"], { cwd: this.root });
        assert.equal(result.ok, true, result.stderr);
        assert.match(result.stdout, /^git version /);
      }
      this.acquisitionCatalog = this.manager.artifactCatalog(this.specId);
      const store = new CanonicalAcceptanceArtifactStore({ flowManager: this.manager,
        state: this.manager.loadReadOnly(this.specId) });
      return store.buildContext({ executionRoot: this.root });
    }, { commandId: "acceptance-review" });
  }
  async assertPersistedAdmission(t, warm) {
    const restarted = new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false });
    const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: this.root }).inventory;
    const execution = inventory.executions.find((entry) => entry.executionId === this.runtime.executionId);
    assert.equal(inventory.slot, null);
    assert.equal(execution.status, "closed");
    assert.ok(execution.calls.length >= (warm ? 4 : 3));
    assert.ok(execution.calls.every((call) => call.receipt?.observation.code === 0));
    const canonical = restarted.activityLedger(this.specId)
      .filter((activity) => activity.processEvent?.executionId === execution.executionId).map((activity) => activity.processEvent);
    assert.deepEqual(canonical, execution.events);
    assert.equal(canonical.filter((event) => event.type === "result-finalized").length, execution.calls.length);
    assert.deepEqual(execution.eventAcknowledgements.map((entry) => entry.eventId), canonical.map((event) => event.eventId));
    const observations = await restarted.readExecutionObservations({ specId: this.specId });
    const sourceId = executionValueDigest(this.runtime.checkoutIdentity.toJSON());
    assert.equal(observations.manifests.filter((entry) => entry.runtimeSourceId === sourceId).length, 1);
    const beforeSources = this.initialCatalog.artifacts.filter((entry) => entry.logicalKey === "execution.source.manifest");
    const acquiredSources = this.acquisitionCatalog.artifacts.filter((entry) => entry.logicalKey === "execution.source.manifest");
    assert.equal(beforeSources.length, 0);
    assert.equal(acquiredSources.length, warm ? 1 : 0);
    const catalog = restarted.artifactCatalog(this.specId);
    const prior = new Map(this.acquisitionCatalog.artifacts.map((entry) => [entry.relativePath, entry]));
    const added = catalog.artifacts.filter((entry) => !prior.has(entry.relativePath));
    const changed = catalog.artifacts.filter((entry) => prior.has(entry.relativePath)
      && JSON.stringify(prior.get(entry.relativePath).toJSON()) !== JSON.stringify(entry.toJSON()));
    t.diagnostic(JSON.stringify({ event: "production-admission-readback", warm,
      sourceCountBefore: beforeSources.length, sourceCountAtAcquisition: acquiredSources.length,
      sourceCountAfter: observations.manifests.length, calls: execution.calls.length,
      receipts: execution.calls.filter((call) => call.receipt !== null).length,
      canonicalEvents: canonical.length, addedLogicalKeys: added.map((entry) => entry.logicalKey),
      changedLogicalKeys: changed.map((entry) => entry.logicalKey) }));
    return catalog;
  }
}

for (const warm of [false, true]) {
  test(`acceptance evidence survives ${warm ? "warm" : "first-call"} production Git observation admission`, { timeout: 30000 }, async (t) => {
    const scenario = new AdmittedAcceptanceSourceScenario(t);
    let context, catalog;
    try { context = await scenario.acquire({ warm }); }
    finally { catalog = await scenario.assertPersistedAdmission(t, warm); }
    assert.equal(context.sourceCatalogHash, catalog.hash);
    assert.equal(context.evidence.diff, "");
    assert.ok(context.mechanicalBlockers.some((entry) => entry.kind === "missing_artifact"));
  });
}
