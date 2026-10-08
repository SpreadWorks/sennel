import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import {
  SourceHandoffSettlement,
  SourceHandoffEvent,
  WorkerArtifactHandoffCoordinator,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SourceHandoffFailureFacts } from "../../../src/flow/lib/source-handoff-failure.js";
import { sourceStepRegistration } from "../../../src/flow/engine/composition/source-step.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { withSourceHandoffLease } from "../../support/builders/source-handoff-scenario.js";

function preparedSourceHandoff(t) {
  const root = createTmpDir("source-handoff-settlement-admission-");
  t.after(() => removeTmpDir(root));
  fs.writeFileSync(`${root}/product.js`, "export const value = 1;\n");
  initGitRepo(root);
  commitAll(root, "source settlement admission baseline");

  const specId = "source-handoff-settlement-admission";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({
    flowManager: manager,
    specId,
    runId: "run-source-handoff-settlement-admission",
    specRecord: {
      goal: "Reject invalid source settlements before publication.",
      requirements: [{ id: "R1", desc: "Keep source settlement atomic.", task_ids: ["T1"], testable: false }],
    },
  }).create().addTask({
    id: "T1",
    title: "Source settlement fixture",
    goal: "Reach the source settlement boundary.",
    origin: "plan",
    added_round: 0,
    status: "pending",
  }).registerActive().activate("implement");

  const ctx = { root, executionRoot: root, mainRoot: root, specId, flowManager: manager, config: {} };
  const state = manager.loadReadOnly(specId);
  const invocation = {
    id: "source-settlement-admission",
    target: { digest: crypto.createHash("sha256").update("source-settlement-target").digest("hex") },
    action: {
      digest: crypto.createHash("sha256").update("source-settlement-action").digest("hex"),
      nextAction: { step: "implement" },
    },
  };
  const request = withSourceHandoffLease({ root }, () => (
    new WorkerArtifactHandoffCoordinator().createRequest({ ctx, state, invocation })
  ));
  return { manager, specId, request, ctx, invocation };
}

function canonicalSnapshot(manager, specId) {
  return {
    state: manager.canonicalState(specId).toJSON(),
    activities: manager.activityLedger(specId).map((activity) => activity.toJSON?.() ?? activity),
    catalog: manager.artifactCatalog(specId).toJSON(),
  };
}

function preparedSettlement(t, kind, handoffDigest = null) {
  const { manager, specId, request } = preparedSourceHandoff(t);
  const authority = manager.readSourceHandoffAuthority({
    specId,
    identity: request.sourceHandoffIdentity,
  });
  return {
    manager,
    specId,
    request,
    settlement: new SourceHandoffSettlement({
      identity: request.sourceHandoffIdentity,
      checkpointDigest: authority.checkpoint.digest,
      eventDigest: authority.event.digest,
      kind,
      ...(handoffDigest === null ? {} : { handoffDigest }),
    }),
  };
}

function assertAtomicRejection({ manager, specId, reject }) {
  const before = canonicalSnapshot(manager, specId);
  assert.throws(reject, /settlement is incompatible/);
  assert.deepEqual(canonicalSnapshot(manager, specId), before);
}

test("standalone source settlement rejects an incompatible predecessor before publication", (t) => {
  const { manager, specId, settlement } = preparedSettlement(t, "rolled-back");
  assertAtomicRejection({ manager, specId, reject: () => manager.settleSourceHandoff({
    specId,
    settlement,
  }) });
});

test("source acceptance rejects an incompatible predecessor before confirmation", (t) => {
  const { manager, specId, request, ctx, invocation } = preparedSourceHandoff(t);
  withSourceHandoffLease({ root: ctx.root }, () => {
    const coordinator = new WorkerArtifactHandoffCoordinator();
    coordinator.startSourceWorker({ ctx, request, invocation });
    fs.writeFileSync(`${ctx.root}/product.js`, "export const value = 2;\n");
    materializeSourceWorkerEffect({ request, responseText: JSON.stringify({
      version: 1, stepId: "implement", completionStatus: "done", issues: [],
      overview: null, triage: null, repair: null, noChangeReason: null,
    }) });
    sealParentMaterializedSourceWorkerEffect({ request });
    coordinator.finishSourceWorker({ ctx, request });
    const preparation = coordinator.prepareSourceStepHandoff({ ctx, request,
      mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }) });
    let selected;
    const stop = new Error("Capture the real selected save before commit.");
    const capture = t.mock.method(manager, "commitSpecStepResult", (input) => {
      selected = input;
      throw stop;
    });
    try {
      const prepared = sourceStepRegistration("implement").create({ ctx, request,
        preparation, handoffCoordinator: coordinator });
      assert.throws(() => prepared.step.execute(), (error) => error.cause === stop);
    } finally { capture.mock.restore(); }
    assert.equal(selected.stepResult.kind, "implement-applied");
    assert.equal(selected.sourceSelection.result, selected.stepResult);

    const authority = manager.readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity });
    const failed = new SourceHandoffEvent({ identity: request.sourceHandoffIdentity,
      checkpointDigest: authority.checkpoint.digest, sequence: authority.events.length + 1,
      previousDigest: authority.event.digest, kind: "failure", requestDigest: request.requestDigest,
      failureFacts: SourceHandoffFailureFacts.fromError(new Error("The stopped worker was rejected."),
        { request, ownershipProven: true, workerStopped: true }) });
    manager.appendSourceHandoffEvent({ specId, event: failed });
    const settlement = new SourceHandoffSettlement({ identity: request.sourceHandoffIdentity,
      checkpointDigest: authority.checkpoint.digest, eventDigest: failed.digest, kind: "accepted",
      handoffDigest: selected.handoffDigest });
    const sourceBefore = fs.readFileSync(`${ctx.root}/product.js`);
    assertAtomicRejection({ manager, specId, reject: () => manager.commitSpecStepResult({
      ...selected, sourceHandoffSettlement: settlement,
    }) });
    assert.deepEqual(fs.readFileSync(`${ctx.root}/product.js`), sourceBefore);
    assert.equal(manager.readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity }).settlement, null);
  });
});

test("source quarantine rejects an incompatible predecessor before failure recording", (t) => {
  const { manager, specId, request, settlement } = preparedSettlement(t, "quarantined");
  assertAtomicRejection({ manager, specId, reject: () => manager.failCurrentAttemptIfCurrent({
    specId,
    expectedRunId: request.runId,
    expectedAttempt: request.sourceMutationBaseline.attempt,
    sourceHandoffSettlement: settlement,
    failure: {
      category: "source-integrity",
      code: "SOURCE_SETTLEMENT_TEST",
      message: "The source handoff must be quarantined.",
      retryable: false,
      retryKind: null,
    },
  }) });
});
