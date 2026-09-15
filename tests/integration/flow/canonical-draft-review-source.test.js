import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import {
  createConditionalWorkerSettlementPlan,
  resolvePlanGateRepairWorkerTransition,
} from "../../../src/flow/definition.js";
import { ReviewTargetAuthority } from "../../../src/flow/lib/review-target-authority.js";
import {
  canonicalDraftDocument,
  canonicalFixtureProducerResult,
  FlowAtStepFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SPEC_ID = "canonical-draft-review-source";
const EXECUTION = { mode: "branch", baseBranch: "main", featureBranch: "feature/canonical-draft-review-source" };

function confirmedDraftActivity(manager) {
  return manager.activityLedger(SPEC_ID).findLast((activity) => activity.nodeId === "draft");
}

function managerWith(manager, { descriptor = null, activities = null } = {}) {
  return {
    readArtifact(input) {
      const resolved = manager.readArtifact(input);
      return descriptor === null ? resolved : { ...resolved, descriptor };
    },
    activityLedger(specId) {
      return activities === null ? manager.activityLedger(specId) : activities;
    },
    writeRuntimeArtifact: manager.writeRuntimeArtifact.bind(manager),
  };
}

function completeStep(flowManager, stepId, artifactWrites = []) {
  flowManager.updateStepStatus({ stepId, requestedStatus: "in_progress" }, { specId: SPEC_ID });
  const canonicalCommandResult = canonicalFixtureProducerResult(
    flowManager.loadReadOnly(SPEC_ID),
    stepId,
    { flowManager, specId: SPEC_ID },
  );
  if (canonicalCommandResult === null) {
    flowManager.confirmCurrentAttempt({ specId: SPEC_ID, artifactWrites });
    return;
  }
  assert.deepEqual(artifactWrites, []);
  flowManager.updateStepStatus(
    { stepId, requestedStatus: "done" },
    { specId: SPEC_ID, canonicalCommandResult },
  );
}

describe("canonical draft review source", () => {
  let root;

  afterEach(() => {
    if (root !== undefined) removeTmpDir(root);
    root = undefined;
  });

  function createConfirmedDraft() {
    root = createTmpDir("canonical-draft-review-source-");
    const flowManager = makeFlowManager(root);
    new FlowAtStepFixture({
      flowManager,
      specId: SPEC_ID,
      runId: "run-canonical-draft-review-source",
      request: "exercise canonical draft review source",
      execution: EXECUTION,
      specRecord: { goal: "canonical review source", requirements: [] },
      targetStep: "draft",
    }).create();
    flowManager.confirmCurrentAttempt({
      specId: SPEC_ID,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "atomically confirmed draft" })), "utf8"),
      }],
    });
    return flowManager;
  }

  it("uses the catalog descriptor's same confirmed Activity as V1 producer and finalization proof", () => {
    const flowManager = createConfirmedDraft();
    const state = flowManager.loadReadOnly(SPEC_ID);
    const source = new CanonicalDraftReviewSource({
      flowManager,
      state,
      phase: "draft-questions",
    });
    const descriptor = flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "draft",
      consumerNodeId: "draft-questions-review",
    }).descriptor;
    const producer = confirmedDraftActivity(flowManager);

    assert.equal(descriptor.activityId, producer.id);
    assert.equal(producer.type, "result_confirmed");
    assert.equal(source.sourceNodeId, "draft");
    assert.equal(source.finalizedAt, producer.result.confirmedAt);
    assert.equal(source.revision().digest, descriptor.hash);
    const target = new ReviewTargetAuthority({
      executionRoot: root,
      artifactRoot: root,
      flowState: state,
      flowManager,
    }).captureTargetStateForPhase("draft-questions");
    assert.equal(target.digest, descriptor.hash);
  });

  it("accepts exactly each definition-authorized draft writer for its downstream review", () => {
    const flowManager = createConfirmedDraft();
    completeStep(flowManager, "draft-questions-review");
    completeStep(flowManager, "draft-questions-triage");
    completeStep(flowManager, "draft-questions-repair", [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "question-repaired draft" })), "utf8"),
    }]);

    const questionsSource = new CanonicalDraftReviewSource({
      flowManager,
      state: flowManager.loadReadOnly(SPEC_ID),
      phase: "draft-questions",
    });
    assert.equal(questionsSource.sourceNodeId, "draft-questions-repair");

    completeStep(flowManager, "draft-refine", [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "refined draft" })), "utf8"),
    }]);
    const coverageSource = new CanonicalDraftReviewSource({
      flowManager,
      state: flowManager.loadReadOnly(SPEC_ID),
      phase: "draft-coverage",
    });
    assert.equal(coverageSource.sourceNodeId, "draft-refine");

    const gateRepairState = flowManager.canonicalState(SPEC_ID);
    flowManager.settleConditionalWorker({
      specId: SPEC_ID,
      plan: createConditionalWorkerSettlementPlan({
        disposition: resolvePlanGateRepairWorkerTransition({
          stepId: "draft-gate-repair",
          workerStatus: "pending",
          repair: null,
        }),
        flowState: gateRepairState,
      }),
    });

    completeStep(flowManager, "draft-coverage-review");
    completeStep(flowManager, "draft-coverage-triage");
    completeStep(flowManager, "draft-coverage-repair", [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "coverage-repaired draft" })), "utf8"),
    }]);
    const repairedCoverageSource = new CanonicalDraftReviewSource({
      flowManager,
      state: flowManager.loadReadOnly(SPEC_ID),
      phase: "draft-coverage",
    });
    assert.equal(repairedCoverageSource.sourceNodeId, "draft-coverage-repair");
  });

  it("fails closed when descriptor Activity is missing, disallowed, or not the producer confirmation", () => {
    const flowManager = createConfirmedDraft();
    const state = flowManager.loadReadOnly(SPEC_ID);
    const resolved = flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "draft",
      consumerNodeId: "draft-questions-review",
    });
    const producer = confirmedDraftActivity(flowManager);
    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        descriptor: { ...resolved.descriptor, activityId: "missing-activity" },
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);

    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        descriptor: { ...resolved.descriptor, logicalKey: "spec.record" },
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);

    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        activities: flowManager.activityLedger(SPEC_ID).map((activity) => (
          activity.id === producer.id
            ? {
              ...activity,
              type: "artifacts_published",
              attemptId: null,
              sequence: null,
              result: null,
              transition: {
                ...activity.transition,
                operation: "publish_artifacts",
                status: null,
              },
            }
            : activity
        )),
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);

    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        activities: flowManager.activityLedger(SPEC_ID).map((activity) => (
          activity.id === producer.id
            ? { ...activity, transition: { ...activity.transition, status: "skipped" } }
            : activity
        )),
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);

    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        descriptor: { ...resolved.descriptor, publicationStep: "spec" },
        activities: flowManager.activityLedger(SPEC_ID).map((activity) => (
          activity.id === producer.id
            ? { ...activity, nodeId: "spec", transition: { ...activity.transition, nodeId: "spec" } }
            : activity
        )),
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);

    assert.throws(() => new CanonicalDraftReviewSource({
      flowManager: managerWith(flowManager, {
        activities: flowManager.activityLedger(SPEC_ID).map((activity) => (
          activity.id === producer.id ? { ...activity, result: null } : activity
        )),
      }),
      state,
      phase: "draft-questions",
    }), /no authorized draft-questions producer Activity/);
  });
});
