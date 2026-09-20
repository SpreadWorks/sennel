import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftStepErrorResult,
} from "../../../src/flow/engine/step-result.js";
import { settleDraftStepResult } from "../../../src/flow/definition.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function createRoot() {
  const root = createTmpDir("draft-step-result-settlement-");
  roots.push(root);
  return root;
}

function settlementBinding(manager, specId, stepId) {
  const state = manager.canonicalState(specId);
  return {
    runId: state.runId,
    specId,
    stepId,
    attempt: state.attempt,
  };
}

function persistedBytes(location, artifactFile) {
  return {
    state: fs.readFileSync(location.flowStateFile),
    activities: fs.readFileSync(location.activitiesFile),
    catalog: fs.readFileSync(location.catalogFile),
    artifact: fs.existsSync(artifactFile) ? fs.readFileSync(artifactFile) : null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTmpDir(root);
});

describe("Draft Step Result settlement", () => {
  it("rolls back Result, receipt, Activity, artifact, and target when publication is interrupted", () => {
    const root = createRoot();
    const specId = "001-draft-result-atomicity";
    let interrupt = false;
    let catalogFile = null;
    const manager = new FlowManager({
      root,
      mainRoot: root,
      inWorktree: false,
      versionStoreFaultInjector: ({ phase, filePath }) => {
        if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
          throw new Error("injected Draft settlement interruption");
        }
      },
    });
    const fixture = new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-result-atomicity",
      request: "Persist one atomic Draft Result settlement.",
      targetStep: "draft-questions-repair",
    }).create();
    const location = fixture.location();
    catalogFile = location.catalogFile;
    const artifactFile = location.artifact("draft.questions.repair");
    const before = persistedBytes(location, artifactFile);
    const result = new DraftQuestionsRepairChangedResult();
    const binding = settlementBinding(manager, specId, result.stepId);
    const artifactWrites = [{
      logicalKey: "draft.questions.repair",
      mediaType: "application/json",
      bytes: Buffer.from('{"changed":true}\n', "utf8"),
    }];

    interrupt = true;
    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement: settleDraftStepResult(result.stepId, result),
      artifactWrites,
    }), /injected Draft settlement interruption/);

    assert.deepEqual(persistedBytes(location, artifactFile), before);
    assert.equal(manager.canonicalState(specId).current.at(-1), "draft-questions-repair");
  });

  it("replays an identical settlement without duplication and rejects a changed Result", () => {
    const root = createRoot();
    const specId = "001-draft-result-replay";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-result-replay",
      request: "Replay one durable Draft Result settlement.",
      targetStep: "draft-questions-repair",
    }).create();
    const result = new DraftQuestionsRepairChangedResult();
    const binding = settlementBinding(manager, specId, result.stepId);
    const settlement = settleDraftStepResult(result.stepId, result);

    const changedMapping = new DraftQuestionsRepairUnchangedResult();
    const beforeMismatch = manager.canonicalState(specId).toJSON();
    const activitiesBeforeMismatch = manager.activityLedger(specId).length;
    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement: settleDraftStepResult(changedMapping.stepId, changedMapping),
    }), /exact Result binding/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeMismatch);
    assert.equal(manager.activityLedger(specId).length, activitiesBeforeMismatch);

    const first = manager.settleDraftStepResult({ binding, stepResult: result, settlement });
    const activityCount = manager.activityLedger(specId).length;
    const replay = manager.settleDraftStepResult({ binding, stepResult: result, settlement });

    assert.equal(replay.receipt.id, first.receipt.id);
    assert.equal(manager.activityLedger(specId).length, activityCount);
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
    const activity = manager.activityLedger(specId).at(-1);
    assert.deepEqual(activity.result.stepResult, result.toJSON());
    assert.equal(activity.result.draftSettlementReceipt.id, first.receipt.id);

    const changed = new DraftQuestionsRepairUnchangedResult();
    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: changed,
      settlement: settleDraftStepResult(changed.stepId, changed),
    }), /already has a different Result, Settlement, or Publication/);
    assert.equal(manager.activityLedger(specId).length, activityCount);
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
  });

  it("rejects an explicitly stale Attempt binding before any settlement effect", () => {
    const root = createRoot();
    const specId = "001-draft-result-stale-binding";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-result-stale-binding",
      request: "Reject a stale Draft settlement binding.",
      targetStep: "draft-questions-repair",
    }).create();
    const result = new DraftQuestionsRepairChangedResult();
    const current = settlementBinding(manager, specId, result.stepId);
    const stale = {
      ...current,
      attempt: { id: `${current.attempt.id}-stale`, sequence: current.attempt.sequence },
    };
    const before = manager.canonicalState(specId).toJSON();
    const activities = manager.activityLedger(specId).length;

    assert.throws(() => manager.settleDraftStepResult({
      binding: stale,
      stepResult: result,
      settlement: settleDraftStepResult(result.stepId, result),
    }), /binding is stale/);

    assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
    assert.equal(manager.activityLedger(specId).length, activities);
  });

  it("replays the exact artifact publication and rejects changed artifact bytes", () => {
    const root = createRoot();
    const specId = "001-draft-publication-replay";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-publication-replay",
      request: "Bind Draft settlement replay to its published artifact bytes.",
      targetStep: "draft-questions-repair",
    }).create();
    const result = new DraftQuestionsRepairChangedResult();
    const binding = settlementBinding(manager, specId, result.stepId);
    const settlement = settleDraftStepResult(result.stepId, result);
    const artifact = () => ({
      logicalKey: "draft.questions.repair",
      mediaType: "application/json",
      bytes: Buffer.from('{"changed":true}\n', "utf8"),
    });

    const first = manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement,
      artifactWrites: [artifact()],
    });
    const activityCount = manager.activityLedger(specId).length;
    const replay = manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement,
      artifactWrites: [artifact()],
    });
    assert.equal(replay.receipt.id, first.receipt.id);
    assert.equal(manager.activityLedger(specId).length, activityCount);

    const beforeConflict = manager.canonicalState(specId).toJSON();
    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement,
      artifactWrites: [{
        logicalKey: "draft.questions.repair",
        mediaType: "application/json",
        bytes: Buffer.from('{"changed":false}\n', "utf8"),
      }],
    }), CurrentFlowStateConflictError);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeConflict);
    assert.equal(manager.activityLedger(specId).length, activityCount);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false });
    assert.equal(reloaded.activityLedger(specId).at(-1).result.draftSettlementReceipt.id, first.receipt.id);
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
  });

  it("includes the complete Error payload and persisted lifecycle result in replay identity", () => {
    const root = createRoot();
    const specId = "001-draft-error-replay";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-error-replay",
      request: "Distinguish Draft Error Result payloads during replay.",
      targetStep: "draft-questions-repair",
    }).create();
    const binding = settlementBinding(manager, specId, "draft-questions-repair");
    const error = Object.assign(new Error("provider unavailable"), {
      code: "PROVIDER_UNAVAILABLE",
      data: { retryAfter: 5 },
    });
    const result = new DraftStepErrorResult("draft-questions-repair", error);
    const settlement = settleDraftStepResult(result.stepId, result);

    const lifecycleResult = {
      outcome: "failed",
      summary: "provider unavailable",
      confirmedAt: "2026-01-02T03:04:05.000Z",
      artifactRefs: [],
    };
    const first = manager.settleDraftStepResult({
      binding,
      stepResult: result,
      settlement,
      lifecycleResult,
    });
    const activityCount = manager.activityLedger(specId).length;
    const identical = new DraftStepErrorResult("draft-questions-repair", error);
    const replay = manager.settleDraftStepResult({
      binding,
      stepResult: identical,
      settlement: settleDraftStepResult(identical.stepId, identical),
      lifecycleResult,
    });
    assert.equal(replay.receipt.id, first.receipt.id);
    assert.equal(manager.activityLedger(specId).length, activityCount);

    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: identical,
      settlement: settleDraftStepResult(identical.stepId, identical),
      lifecycleResult: { ...lifecycleResult, summary: "provider unavailable after retry" },
    }), CurrentFlowStateConflictError);
    assert.equal(manager.activityLedger(specId).length, activityCount);

    const changed = new DraftStepErrorResult(
      "draft-questions-repair",
      Object.assign(new Error("provider unavailable"), {
        code: "PROVIDER_UNAVAILABLE",
        data: { retryAfter: 30 },
      }),
    );
    assert.throws(() => manager.settleDraftStepResult({
      binding,
      stepResult: changed,
      settlement: settleDraftStepResult(changed.stepId, changed),
    }), /already has a different Result, Settlement, or Publication/);
    assert.equal(manager.activityLedger(specId).length, activityCount);
  });
});
