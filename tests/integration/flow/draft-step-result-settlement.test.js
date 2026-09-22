import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  DraftQuestionsReviewExecutionRequiredResult,
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftRefineWorkerRequiredResult,
  StepErrorResult,
} from "../../../src/flow/engine/step-result.js";
import {
  DraftReviewExecutionClaim,
  DraftReviewExecutionTargetIdentity,
  DraftStepExecutionState,
  DraftWorkerExecutionClaim,
  settleDraftStepResult,
} from "../../../src/flow/definition.js";
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
  it("checkpoints, claims, publishes, and terminates one execution generation without consuming the Attempt", () => {
    const root = createRoot();
    const specId = "001-draft-execution-generation";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-execution-generation",
      request: "Persist one exact Draft worker execution generation.",
      targetStep: "draft-refine",
    }).create();
    const binding = settlementBinding(manager, specId, "draft-refine");
    const beforeAttempt = manager.canonicalState(specId).attempt.toJSON();
    const required = new DraftRefineWorkerRequiredResult();
    const settlement = settleDraftStepResult(required.stepId, required);
    const initial = manager.draftStepExecutionState({ binding });
    assert.equal(initial instanceof DraftStepExecutionState, true);
    assert.equal(initial.nextGeneration, 0);
    const executionBinding = initial.workerBinding({
      inputDigest: "a".repeat(64),
      inputRevision: "b".repeat(64),
    });

    const checkpoint = manager.checkpointDraftStepExecution({
      binding, stepResult: required, settlement, executionBinding,
    });
    const checkpointActivities = manager.activityLedger(specId).length;
    const checkpointReplay = manager.checkpointDraftStepExecution({
      binding, stepResult: required, settlement, executionBinding,
    });
    assert.equal(checkpointReplay.receipt.id, checkpoint.receipt.id);
    assert.equal(manager.activityLedger(specId).length, checkpointActivities);
    assert.equal(checkpoint.receipt.executionLifecycle.phase, "checkpoint");
    assert.equal(manager.canonicalState(specId).findNode("draft-refine").result, null);

    const claim = new DraftWorkerExecutionClaim({
      dispatchInvocationId: "dispatch-draft-refine-1",
      generatedAt: "2026-09-20T01:02:03.000Z",
      actionDigest: "c".repeat(64),
      requestDigest: "d".repeat(64),
    });
    const claimed = manager.claimDraftStepExecution({
      binding, stepResult: required, settlement, executionBinding, executionClaim: claim,
    });
    assert.equal(claimed.receipt.executionLifecycle.phase, "claimed");
    assert.deepEqual(manager.canonicalState(specId).attempt.toJSON(), beforeAttempt);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const restored = reloaded.draftStepExecutionState({ binding });
    assert.equal(restored.lifecycle.executionGeneration, 0);
    assert.deepEqual(restored.lifecycle.claim.toJSON(), claim.toJSON());
    assert.deepEqual(restored.flowBinding, {
      runId: binding.runId,
      specId,
      stepId: "draft-refine",
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });

    const beforeConflict = reloaded.canonicalState(specId).toJSON();
    const activitiesBeforeConflict = reloaded.activityLedger(specId).length;
    assert.throws(() => reloaded.claimDraftStepExecution({
      binding,
      stepResult: required,
      settlement,
      executionBinding,
      executionClaim: new DraftWorkerExecutionClaim({
        ...claim.toJSON(),
        requestDigest: "e".repeat(64),
      }),
    }), CurrentFlowStateConflictError);
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), beforeConflict);
    assert.equal(reloaded.activityLedger(specId).length, activitiesBeforeConflict);

    const publicationLifecycle = {
      outcome: "incomplete",
      summary: "Preparing the next execution generation.",
      confirmedAt: "2026-09-20T01:03:00.000Z",
      artifactRefs: [],
    };
    const publication = reloaded.settleDraftStepResult({
      binding,
      stepResult: required,
      settlement,
      lifecycleResult: publicationLifecycle,
    });
    assert.equal(publication.receipt.executionLifecycle.phase, "publication");
    assert.equal(reloaded.canonicalState(specId).findNode("draft-refine").result, null);
    const publicationActivities = reloaded.activityLedger(specId).length;
    const publicationReplay = reloaded.settleDraftStepResult({
      binding,
      stepResult: required,
      settlement,
      lifecycleResult: publicationLifecycle,
    });
    assert.equal(publicationReplay.receipt.id, publication.receipt.id);
    assert.equal(reloaded.activityLedger(specId).length, publicationActivities);

    const error = new StepErrorResult("draft-refine", new Error("worker result is terminally invalid"));
    const errorLifecycle = {
      outcome: "failed",
      summary: "worker result is terminally invalid",
      confirmedAt: "2026-09-20T01:04:00.000Z",
      artifactRefs: [],
    };
    const terminal = reloaded.settleDraftStepResult({
      binding,
      stepResult: error,
      settlement: settleDraftStepResult(error.stepId, error),
      lifecycleResult: errorLifecycle,
    });
    assert.equal(terminal.receipt.executionLifecycle.phase, "terminal");
    assert.equal(
      reloaded.activityLedger(specId).at(-1).result.stepResult.kind,
      "draft-refine-error",
    );
    assert.equal(terminal.state.attempt.id, binding.attempt.id);
    assert.deepEqual(terminal.state.attempt.consumption.toJSON(), beforeAttempt.consumption);
    const terminalReplay = reloaded.settleDraftStepResult({
      binding,
      stepResult: error,
      settlement: settleDraftStepResult(error.stepId, error),
      lifecycleResult: errorLifecycle,
    });
    assert.equal(terminalReplay.receipt.id, terminal.receipt.id);

    const terminalState = terminal.state.toJSON();
    const terminalActivities = reloaded.activityLedger(specId).length;
    assert.throws(() => reloaded.checkpointDraftStepExecution({
      binding,
      stepResult: required,
      settlement,
      executionBinding: new DraftStepExecutionState({ binding }).workerBinding({
        inputDigest: "f".repeat(64), inputRevision: "0".repeat(64),
      }),
    }), CurrentFlowStateConflictError);
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), terminalState);
    assert.equal(reloaded.activityLedger(specId).length, terminalActivities);
  });

  it("advances a published generation and rejects an old changed checkpoint", () => {
    const root = createRoot();
    const specId = "001-draft-execution-next-generation";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-execution-next-generation",
      request: "Advance one retained Draft Attempt generation.",
      targetStep: "draft-refine",
    }).create();
    const binding = settlementBinding(manager, specId, "draft-refine");
    const required = new DraftRefineWorkerRequiredResult();
    const settlement = settleDraftStepResult(required.stepId, required);
    const generation0 = manager.draftStepExecutionState({ binding }).workerBinding({
      inputDigest: "1".repeat(64), inputRevision: "2".repeat(64),
    });
    manager.checkpointDraftStepExecution({ binding, stepResult: required, settlement, executionBinding: generation0 });
    const generation0Claim = new DraftWorkerExecutionClaim({
      dispatchInvocationId: "dispatch-generation-0",
      generatedAt: "2026-09-20T02:00:00.000Z",
      actionDigest: "3".repeat(64),
      requestDigest: "4".repeat(64),
    });
    manager.claimDraftStepExecution({
      binding,
      stepResult: required,
      settlement,
      executionBinding: generation0,
      executionClaim: generation0Claim,
    });
    manager.settleDraftStepResult({
      binding,
      stepResult: required,
      settlement,
      lifecycleResult: {
        outcome: "incomplete", summary: "The published worker result requires another execution.",
        confirmedAt: "2026-09-20T02:01:00.000Z", artifactRefs: [],
      },
    });

    const restart = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const executionState = restart.draftStepExecutionState({ binding });
    assert.equal(executionState.lifecycle.phase, "publication");
    assert.equal(executionState.nextGeneration, 1);
    const generation1 = executionState.workerBinding({
      inputDigest: "5".repeat(64), inputRevision: "6".repeat(64),
    });
    const checkpoint = restart.checkpointDraftStepExecution({
      binding, stepResult: required, settlement, executionBinding: generation1,
    });
    assert.equal(checkpoint.receipt.executionLifecycle.executionGeneration, 1);
    assert.deepEqual(restart.canonicalState(specId).attempt.toJSON(), binding.attempt.toJSON());

    assert.throws(() => restart.checkpointDraftStepExecution({
      binding, stepResult: required, settlement, executionBinding: generation0,
    }), /replay is stale/);
    assert.throws(() => restart.claimDraftStepExecution({
      binding,
      stepResult: required,
      settlement,
      executionBinding: generation0,
      executionClaim: generation0Claim,
    }), /replay is stale/);

    const stateBeforeOld = restart.canonicalState(specId).toJSON();
    const activitiesBeforeOld = restart.activityLedger(specId).length;
    assert.throws(() => restart.checkpointDraftStepExecution({
      binding,
      stepResult: required,
      settlement,
      executionBinding: new DraftStepExecutionState({ binding }).workerBinding({
        inputDigest: "7".repeat(64), inputRevision: "8".repeat(64),
      }),
    }), /generation is not monotonic/);
    assert.deepEqual(restart.canonicalState(specId).toJSON(), stateBeforeOld);
    assert.equal(restart.activityLedger(specId).length, activitiesBeforeOld);
  });

  it("rejects a Step-mismatched execution binding and cannot restart a failed Attempt", () => {
    const root = createRoot();
    const specId = "001-draft-execution-invariants";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-execution-invariants",
      request: "Reject mismatched and terminal Draft execution authority.",
      targetStep: "draft-refine",
    }).create();
    const binding = settlementBinding(manager, specId, "draft-refine");
    const required = new DraftRefineWorkerRequiredResult();
    const executionSettlement = settleDraftStepResult(required.stepId, required);
    const reviewBinding = manager.draftStepExecutionState({ binding }).reviewBinding({
      manifestDigest: "1".repeat(64),
      inputDigest: "2".repeat(64),
      target: new DraftReviewExecutionTargetIdentity({
        treeSha: "3".repeat(40), targetStateDigest: "4".repeat(64),
      }),
    });
    assert.throws(() => manager.checkpointDraftStepExecution({
      binding,
      stepResult: required,
      settlement: executionSettlement,
      executionBinding: reviewBinding,
    }), /binding does not match its Step Result/);

    const error = new StepErrorResult("draft-refine", new Error("terminal before execution"));
    manager.settleDraftStepResult({
      binding,
      stepResult: error,
      settlement: settleDraftStepResult(error.stepId, error),
    });
    const before = manager.canonicalState(specId).toJSON();
    const activityCount = manager.activityLedger(specId).length;
    assert.throws(() => manager.checkpointDraftStepExecution({
      binding,
      stepResult: required,
      settlement: executionSettlement,
      executionBinding: new DraftStepExecutionState({ binding }).workerBinding({
        inputDigest: "5".repeat(64), inputRevision: "6".repeat(64),
      }),
    }), /cannot continue a failed Attempt/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
    assert.equal(manager.activityLedger(specId).length, activityCount);
  });

  it("persists the complete ReviewWorkUnitManifest execution identity", () => {
    const root = createRoot();
    const specId = "001-draft-review-execution-binding";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-execution-binding",
      request: "Bind review execution to its canonical manifest.",
      targetStep: "draft-questions-review",
    }).create();
    const binding = settlementBinding(manager, specId, "draft-questions-review");
    const result = new DraftQuestionsReviewExecutionRequiredResult();
    const settlement = settleDraftStepResult(result.stepId, result);
    const executionBinding = manager.draftStepExecutionState({ binding }).reviewBinding({
      manifestDigest: "9".repeat(64),
      inputDigest: "a".repeat(64),
      target: new DraftReviewExecutionTargetIdentity({
        treeSha: "b".repeat(40), targetStateDigest: "c".repeat(64),
      }),
    });
    manager.checkpointDraftStepExecution({ binding, stepResult: result, settlement, executionBinding });
    manager.claimDraftStepExecution({
      binding,
      stepResult: result,
      settlement,
      executionBinding,
      executionClaim: new DraftReviewExecutionClaim(),
    });

    const restored = new FlowManager({ root, mainRoot: root, inWorktree: false })
      .draftStepExecutionState({ binding });
    assert.deepEqual(restored.lifecycle.binding.toJSON(), executionBinding.toJSON());
    assert.deepEqual(restored.lifecycle.claim.toJSON(), { kind: "review" });
    assert.match(restored.receiptId, /^[a-f0-9]{64}$/);
  });

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
    const result = new StepErrorResult("draft-questions-repair", error);
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
    const identical = new StepErrorResult("draft-questions-repair", error);
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

    const changed = new StepErrorResult(
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
