import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";
import {
  CanonicalFlowArtifactWrite,
  CurrentFlowState,
  FlowActivity,
} from "../../../src/flow/lib/current-flow-state.js";
import {
  CanonicalFlowFixture,
  confirmCanonicalFixtureStep,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function root() {
  const value = createTmpDir("finalized-flow-contract-");
  roots.push(value);
  return value;
}

function leaves(nodes, values = []) {
  for (const node of nodes) {
    if (!node.children || node.children.length === 0) values.push(node);
    else leaves(node.children, values);
  }
  return values;
}

function scenarioValidityArtifact(location) {
  const payload = {
    version: "1",
    command: "node --test artifacts/tests/scenario.test.js",
    process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
    result: "pass",
    raw_output_path: location.relativeArtifact("scenario.validity.raw-log"),
    summary: [],
  };
  return {
    logicalKey: "scenario.validity",
    mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
      new FlowArtifactAttemptRecord({
        attempt: 1,
        payload: {
          nodeId: "scenario-validity",
          outcome: "completed",
          result: { result: "ok" },
          artifact: { logicalKey: "scenario.validity", payload },
        },
      }),
    ]).toJSON(), null, 2)}\n`, "utf8"),
  };
}

function confirmFixtureStep(manager, specId, stepId) {
  return confirmCanonicalFixtureStep(manager, specId, stepId);
}

function finalizedFixture() {
  const repository = root();
  const manager = makeFlowManager(repository);
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "001-finalized-contract",
    runId: "finalized-contract-run",
  }).create();
  const ordered = leaves(manager.load(fixture.specId).steps);
  const scenarioIndex = ordered.findIndex((step) => step.id === "scenario-validity");
  assert.ok(scenarioIndex >= 0, "the canonical definition must include scenario-validity");
  for (const step of ordered.slice(0, scenarioIndex)) {
    confirmFixtureStep(manager, fixture.specId, step.id);
  }
  manager.updateStepStatus({ stepId: "scenario-validity", requestedStatus: "in_progress" }, { specId: fixture.specId });
  manager.publishArtifacts({
    specId: fixture.specId,
    nodeId: "scenario-validity",
    artifactWrites: [scenarioValidityArtifact(manager.specLocation(fixture.specId))],
  });
  confirmFixtureStep(manager, fixture.specId, "scenario-validity");
  for (const step of leaves(manager.load(fixture.specId).steps)) {
    if (step.status === "pending") {
      confirmFixtureStep(manager, fixture.specId, step.id);
    }
  }
  manager.finalizeFlow(fixture.specId);
  return { repository, manager, fixture };
}

function persistedSnapshot(manager, specId) {
  const location = manager.specLocation(specId);
  const flow = fs.readFileSync(location.flowStateFile);
  const activities = fs.readFileSync(location.activitiesFile);
  const catalog = fs.readFileSync(location.catalogFile);
  const permanentArtifacts = manager.artifactCatalog(specId).toJSON().artifacts
    .filter((artifact) => artifact.retention === "permanent")
    .map(({ logicalKey, relativePath, hash, activityId }) => ({ logicalKey, relativePath, hash, activityId }));
  return {
    flow,
    activities,
    catalog,
    catalogHash: crypto.createHash("sha256").update(catalog).digest("hex"),
    permanentArtifacts,
  };
}

function assertUnchanged(actual, expected, operation) {
  assert.deepEqual(actual.flow, expected.flow, `${operation} must not rewrite flow.json`);
  assert.deepEqual(actual.activities, expected.activities, `${operation} must not append an Activity`);
  assert.deepEqual(actual.catalog, expected.catalog, `${operation} must not rewrite the catalog`);
  assert.equal(actual.catalogHash, expected.catalogHash, `${operation} must retain the catalog hash`);
  assert.deepEqual(actual.permanentArtifacts, expected.permanentArtifacts, `${operation} must retain permanent artifacts`);
}

function postFinalizationNonblockingActivity(manager, specId) {
  const state = manager.canonicalState(specId);
  const producer = state.findNode("scenario-validity");
  return new FlowActivity({
    id: "post-finalization-nonblocking-record",
    nodeId: producer.id,
    nodeKey: producer.key,
    attemptId: null,
    sequence: null,
    confirmationOrder: state.confirmationOrder + 1,
    type: "nonblocking_recorded",
    transition: {
      operation: "record_nonblocking",
      nodeId: producer.id,
      task: null,
      attempt: null,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: {
        kind: "observation",
        sourceStep: "scenario-validity",
        sourceAttempt: 1,
        evidenceRef: "steps/scenario-validity/result.json",
        evidenceDigest: "c".repeat(64),
        definitionDigest: "d".repeat(64),
        resultKind: "unavailable",
        action: null,
        rationale: null,
        remainingRisk: null,
      },
      finalizeSteps: null,
    },
    result: null,
    timing: null,
    failure: null,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
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

  it("rejects every new durable Activity after finalization without changing canonical persistence", () => {
    const { manager, fixture } = finalizedFixture();
    const receipt = {
      version: 1,
      runId: fixture.runId,
      actionDigest: "a".repeat(64),
      approvalToken: "b".repeat(64),
      approvedAt: "2026-08-15T00:00:00.000Z",
    };
    const upgrade = {
      version: 1,
      command: "sennel upgrade",
      dryRun: false,
      exitCode: 0,
      result: "success-no-change",
      summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
      failureReason: null,
      checkedPaths: [],
    };
    const mutations = [
      ["metric", () => manager.appendMetric({ phase: "finalize", counter: "postFinalization", delta: 1 }, { specId: fixture.specId })],
      ["note", () => manager.addNote("A finalized Flow cannot receive a new observation.", { specId: fixture.specId })],
      ["upgrade artifact", () => manager.publishUpgradeResult({
        specId: fixture.specId,
        artifact: { logicalKey: "upgrade.result", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(upgrade)}\n`, "utf8") },
      })],
      ["plugin artifact", () => manager.publishPluginArtifacts({
        specId: fixture.specId,
        artifactWrites: [new CanonicalFlowArtifactWrite({
          logicalKey: "plugin.lifecycle.artifact",
          parameters: { pluginArtifactPath: "finalized-contract.json" },
          mediaType: "application/json",
          bytes: "{\"version\":1}\n",
        })],
      })],
      ["dispatch approval", () => manager.recordDispatchApproval({ specId: fixture.specId, receipt })],
      ["nonblocking policy", () => manager._store.runtime.activateNonblockingPolicy({
        specId: fixture.specId,
        activityId: "post-finalization-nonblocking-activation",
        policy: { autoApprove: false, nonblocking: {
          enabled: true,
          activatedAt: "2026-08-15T00:00:00.000Z",
          activatedStep: "scenario-validity",
          reason: "This must not create a post-finalization policy Activity.",
        } },
        nonblocking: {
          kind: "observation", sourceStep: "scenario-validity", sourceAttempt: 1,
          evidenceRef: "steps/scenario-validity/result.json", evidenceDigest: "a".repeat(64),
          definitionDigest: "b".repeat(64),
          resultKind: "unavailable", action: null, rationale: null, remainingRisk: null,
        },
      })],
      ["direct policy Activity", () => manager.setAutoApprove(true, { specId: fixture.specId })],
      ["direct nonblocking Activity", () => manager.applyActivity(
        postFinalizationNonblockingActivity(manager, fixture.specId),
        { specId: fixture.specId },
      )],
    ];

    for (const [operation, mutate] of mutations) {
      const before = persistedSnapshot(manager, fixture.specId);
      assert.throws(
        mutate,
        /finalized Flow rejects subsequent Activities/,
        `${operation} must be rejected by the finalized Store boundary`,
      );
      assertUnchanged(persistedSnapshot(manager, fixture.specId), before, operation);
    }
  });

  it("allows only the exact finalized Activity replay as a no-op", () => {
    const { manager, fixture } = finalizedFixture();
    const finalized = manager.activityLedger(fixture.specId).at(-1);
    assert.equal(finalized.type, "flow_finalized");
    const before = persistedSnapshot(manager, fixture.specId);

    assert.doesNotThrow(() => manager.applyActivity(finalized, { specId: fixture.specId }));
    assertUnchanged(persistedSnapshot(manager, fixture.specId), before, "exact finalize Activity replay");
  });
});
