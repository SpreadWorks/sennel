import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  CurrentFlowState,
  FlowActivity,
} from "../../../src/flow/lib/current-flow-state.js";
import {
  CanonicalFlowFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function root() {
  const value = createTmpDir("finalized-flow-contract-");
  roots.push(value);
  return value;
}

function freshStateBeforeCreation(state) {
  return new CurrentFlowState({
    ...state.toJSON(),
    confirmationOrder: 0,
  }, { definition: state.definition });
}

afterEach(() => {
  for (const directory of roots.splice(0)) removeTmpDir(directory);
});

describe("finalized canonical Flow contract", () => {
  it("journals typed flow_created as the durable first Activity", () => {
    const repository = root();
    const manager = makeFlowManager(repository);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId: "001-created-activity",
      runId: "created-activity-run",
    });
    const beforeCreate = Date.now();
    fixture.create();
    const afterCreate = Date.now();
    const location = manager.specLocation(fixture.specId);
    const ledger = manager.activityLedger(fixture.specId);

    assert.equal(ledger.length, 1);
    const [created] = ledger;
    assert.equal(created.type, "flow_created");
    assert.equal(created.confirmationOrder, 1);
    assert.equal(created.transition.operation, "create_flow");
    const state = manager.canonicalState(fixture.specId);
    assert.equal(created.nodeId, state.root.id);
    assert.equal(created.nodeKey, state.root.key);
    assert.equal(created.attemptId, null);
    assert.equal(created.sequence, null);
    assert.equal(created.result, null);
    assert.equal(created.failure, null);
    assert.equal(created.metric, null);
    assert.equal(created.note, null);
    assert.equal(state.confirmationOrder, 1);
    assert.equal(created.timing.durationMs, 0);
    assert.equal(created.timing.startedAt, created.timing.finishedAt);
    assert.ok(Date.parse(created.timing.startedAt) >= beforeCreate);
    assert.ok(Date.parse(created.timing.finishedAt) <= afterCreate);
    const activitiesBytes = fs.readFileSync(location.activitiesFile);

    const reloadedManager = new FlowManager({
      root: repository,
      mainRoot: repository,
      inWorktree: false,
      specId: fixture.specId,
    });
    const reloaded = reloadedManager.activityLedger(fixture.specId);
    assert.deepEqual(reloaded, ledger);
    assert.deepEqual(fs.readFileSync(reloadedManager.specLocation(fixture.specId).activitiesFile), activitiesBytes);
  });

  it("rejects malformed or misplaced flow_created Activities at typed boundaries", () => {
    const repository = root();
    const manager = makeFlowManager(repository);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId: "001-created-activity-negative",
      runId: "created-activity-negative-run",
    }).create();
    const persisted = manager.canonicalState(fixture.specId);
    const fresh = freshStateBeforeCreation(persisted);
    const created = FlowActivity.flowCreated(fresh, "2026-08-15T00:00:00.000Z");
    const value = created.toJSON();

    assert.throws(() => new FlowActivity({ ...value, confirmationOrder: 2 }));
    assert.throws(() => new FlowActivity({ ...value, timing: null }));
    assert.throws(() => new FlowActivity({
      ...value,
      timing: { startedAt: value.timing.startedAt, finishedAt: value.timing.finishedAt, durationMs: 1 },
    }));
    assert.throws(() => new FlowActivity({ ...value, attemptId: "forbidden-attempt", sequence: 1 }));
    assert.throws(() => new FlowActivity({
      ...value,
      result: { outcome: "passed", summary: "forbidden creation result", confirmedAt: value.timing.finishedAt, artifactRefs: [] },
    }));
    assert.throws(() => new FlowActivity({
      ...value,
      references: { evaluations: [], findings: [], repairs: [], artifacts: [{ id: "forbidden-reference", label: null }] },
    }));

    const draft = fresh.findNode("draft");
    assert.throws(() => new FlowActivity({
      ...value,
      id: `flow-created-${"d".repeat(64)}`,
      nodeId: draft.id,
      nodeKey: draft.key,
      transition: { ...value.transition, nodeId: draft.id },
    }), /target only the Flow root id/);

    const wrongIdentity = new FlowActivity({ ...value, id: `flow-created-${"e".repeat(64)}` });
    assert.throws(() => wrongIdentity.transition.apply(fresh, wrongIdentity), /derived from the Flow identity/);
    assert.throws(() => created.transition.apply(persisted, created), /first fresh Flow Activity/);
  });

});
