import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import {
  SourceHandoffSettlement,
  SourceMutationManifest,
  SourceWorkerEffect,
  WorkerArtifactHandoffCoordinator,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { withSourceHandoffLease } from "../../support/builders/source-handoff-scenario.js";

function sourceEffect() {
  return new SourceWorkerEffect({
    version: 1,
    stepId: "implement",
    completionStatus: "done",
    files: [],
    issues: [],
    overview: null,
    triage: null,
    repair: null,
  });
}

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
      requirements: [{ id: "R1", desc: "Keep source settlement atomic.", task_ids: [] }],
    },
  }).create().registerActive().activate("implement");

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
  return { manager, specId, request };
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
  const { manager, specId, request, settlement } = preparedSettlement(t, "accepted", "a".repeat(64));
  assertAtomicRejection({ manager, specId, reject: () => manager.confirmSourceWorkerHandoff({
    specId,
    effect: sourceEffect(),
    mutationManifest: SourceMutationManifest.capture({ baseline: request.sourceMutationBaseline }),
    handoffDigest: "a".repeat(64),
    sourceHandoffSettlement: settlement,
    result: {
      outcome: "passed",
      summary: "The sealed source worker completed.",
      confirmedAt: "2026-09-09T00:00:00.000Z",
      artifactRefs: [],
    },
  }) });
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
