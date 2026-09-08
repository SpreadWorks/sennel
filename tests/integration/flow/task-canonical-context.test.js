import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CanonicalTaskContext,
  CanonicalTaskRequirementMap,
  canonicalTaskContextKinds,
} from "../../../src/flow/lib/task-canonical-context.js";
import {
  TaskWorkerContextSnapshot,
  WorkerContextBinding,
} from "../../../src/flow/lib/worker-context-snapshot.js";
import {
  CurrentTaskSourceSnapshot,
  TaskExecutionBudget,
  TaskMutationLineage,
  TaskMutationLineageSet,
  captureCurrentTaskSource,
} from "../../../src/flow/lib/task-mutation-lineage.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
  SourceWorkerEffect,
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactMutationAuthoritySnapshot,
  captureSourceMutationManifestForParent,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { emptySpecStub, validateSpecJsonObject } from "../../../src/lib/spec-json.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalReviewWorkUnit } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { resolveGateTransition } from "../../../src/flow/definition.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import { appendIssueLogFromGateResult } from "../../../src/flow/lib/run-gate.js";
import { FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { CurrentFlowSpecRecord } from "../../../src/flow/lib/current-flow-state.js";
import { ExecuteStepDirective } from "../../../src/flow/lib/next-action-directive.js";
import { TaskLifecycleFixture, confirmCanonicalFixtureStep } from "../../support/infrastructure/flow-setup.js";

const digest = "a".repeat(64);
const spec = {
  tasks: [
    { id: "T-1", title: "First", goal: "First concern" },
    { id: "T-2", title: "Second", goal: "Second concern" },
  ],
  requirements: [
    { id: "R-1", desc: "Shared", task_ids: ["T-1", "T-2"] },
    { id: "R-2", desc: "First only", task_ids: ["T-1"] },
  ],
  overview: { modules: [], data_flow: [], decisions: [] },
};

const taskScopedSpec = {
  tasks: [
    { id: "T-2", title: "Second", goal: "Second concern" },
    { id: "T-4", title: "Fourth", goal: "Fourth concern" },
    { id: "T-6", title: "Sixth", goal: "Sixth concern" },
  ],
  requirements: [
    { id: "R-2", desc: "Second only", task_ids: ["T-2"] },
    { id: "R-4", desc: "Fourth only", task_ids: ["T-4"] },
    { id: "R-4-6", desc: "Shared by Fourth and Sixth", task_ids: ["T-4", "T-6"] },
  ],
  overview: { modules: [], data_flow: [], decisions: [] },
};

function assertTaskCanonicalDrift({ label, mutate }) {
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-canonical-drift-"));
  const executionRoot = path.join(mainRoot, "execution");
  fs.mkdirSync(executionRoot, { recursive: true });
  const manager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true });
  const specId = `task-canonical-drift-${label}`;
  const ctx = () => ({ root: executionRoot, mainRoot, executionRoot, specId, flowManager: manager, flowState: manager.loadReadOnly(specId) });
  let driftedSpec = null;
  const captureView = new Proxy(manager, {
    get(target, property, receiver) {
      if (property !== "readArtifact") return Reflect.get(target, property, receiver);
      return (input) => {
        const artifact = target.readArtifact(input);
        if (driftedSpec !== null && input?.logicalKey === "spec.record") {
          return { ...artifact, bytes: Buffer.from(`${JSON.stringify(driftedSpec, null, 2)}\n`, "utf8") };
        }
        return artifact;
      };
    },
  });
  try {
    new TaskLifecycleFixture({
      flowManager: manager, specId, runId: `run-task-canonical-drift-${label}`,
      request: "Reject publication when canonical Task inputs drift.",
      taskDocuments: [{ id: "T-1", title: "Drift target", goal: "Keep source publication guarded.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-impl",
    }).create();
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-09-04T00:00:00.000Z") });
    const invocation = { id: `dispatch-task-canonical-drift-${label}`, target: { digest: "c".repeat(64) }, action: { digest: "b".repeat(64), nextAction: { step: "task-impl", taskId: "T-1" } } };
    const request = coordinator.createRequest({ ctx: { ...ctx(), flowManager: captureView }, state: manager.loadReadOnly(specId), invocation });
    const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
    fs.writeFileSync(path.join(executionRoot, "drift.js"), "export const drift = true;\n");
    materializeSourceWorkerEffect({ request, responseText: JSON.stringify({
      version: 1, stepId: "task-impl", completionStatus: "done",
      files: [{ requirementId: "R-T-1", paths: ["drift.js"] }], issues: [],
      overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null, noChangeReason: null,
    }) });
    const currentSpec = JSON.parse(manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "T-1-impl" }).bytes.toString("utf8"));
    mutate(currentSpec);
    driftedSpec = currentSpec;
    sealParentMaterializedSourceWorkerEffect({ request, now: () => new Date("2026-09-04T00:00:01.000Z") });
    assert.throws(
      () => coordinator.reconcile({ ctx: ctx(), request, mutationAuthority: authority }),
      (error) => error.code === "FLOW_ARTIFACT_HANDOFF_STALE" && error.classification === "stale",
      label,
    );
    assert.equal(coordinator.rollbackRejectedSourceHandoff({ ctx: ctx(), request, mutationAuthority: authority }), true, label);
    assert.equal(fs.existsSync(path.join(executionRoot, "drift.js")), false, `${label} must roll back the source mutation`);
    assert.deepEqual(manager.taskMutationLineages({ specId, taskId: "T-1" }), [], `${label} must not publish source lineage`);
  } finally {
    fs.rmSync(mainRoot, { recursive: true, force: true });
  }
}

function taskContextSnapshot() {
  const context = new CanonicalTaskContext({
    state: { runId: "run-4", specId: "spec-4", currentTaskId: "T-4" },
    spec: taskScopedSpec,
    sourceFingerprint: digest,
  });
  return new TaskWorkerContextSnapshot({
    binding: new WorkerContextBinding({
      runId: "run-4",
      specId: "spec-4",
      issue: null,
      dispatchInvocationId: "dispatch-4",
      actionDigest: "b".repeat(64),
      targetDigest: "c".repeat(64),
    }),
    context,
  });
}

describe("canonical Task context", () => {
  it("uses requirement task_ids as the sole Task mapping authority", () => {
    const map = new CanonicalTaskRequirementMap(spec);
    assert.deepEqual(map.forTask("T-1").map((requirement) => requirement.id), ["R-1", "R-2"]);
    assert.deepEqual(map.forTask("T-2").map((requirement) => requirement.id), ["R-1"]);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      requirements: [{ id: "R", desc: "missing mapping" }],
    }), /task_ids must be a non-empty array/);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      requirements: [{ id: "R", desc: "duplicate mapping", task_ids: ["T-1", "T-1"] }],
    }), /task_ids must not duplicate/);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      requirements: [{ id: " ", desc: "empty identity", task_ids: ["T-1", "T-2"] }],
    }), /requirement\[0\]\.id is required/);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      requirements: [
        { id: "R-1", desc: "first identity", task_ids: ["T-1"] },
        { id: "R-1", desc: "duplicate identity", task_ids: ["T-2"] },
      ],
    }), /Requirement ids must be unique: R-1/);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      tasks: [spec.tasks[0], { ...spec.tasks[1], id: "T-1" }],
    }), /Task ids must be unique/);
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...spec,
      requirements: [{ id: "R", desc: "broken", task_ids: ["T-3"] }],
    }), /unknown Task/);
    const splitSpec = {
      ...spec,
      tasks: [...spec.tasks, { id: "T-3", title: "Split", goal: "Split concern" }],
    };
    assert.throws(() => new CanonicalTaskRequirementMap(splitSpec), /no mapped Requirements: T-3/);
    const mappedSplit = new CanonicalTaskRequirementMap({
      ...splitSpec,
      requirements: [{ ...spec.requirements[0], task_ids: ["T-1", "T-2", "T-3"] }, spec.requirements[1]],
    });
    assert.deepEqual(mappedSplit.forTask("T-3").map((requirement) => requirement.id), ["R-1"]);
  });

  it("keeps pre-Task scaffolding valid while rejecting incomplete canonical mappings", () => {
    assert.doesNotThrow(() => validateSpecJsonObject(emptySpecStub()));
    assert.throws(() => validateSpecJsonObject({
      ...emptySpecStub(),
      requirements: [{ id: "R-1", desc: "Cannot point at an unknown Task.", task_ids: ["T-ghost"] }],
    }), /unknown Task/);
    assert.throws(() => validateSpecJsonObject({
      ...emptySpecStub(),
      tasks: [{ id: "T-1", title: "Mapped", goal: "Mapped", origin: "plan", added_round: 0, status: "pending" }],
      requirements: [{ id: "", desc: "Empty identities are invalid.", task_ids: ["T-1"] }],
    }), /requirements\[0\]\.id: minLength 1/);
    const missingTasks = emptySpecStub();
    delete missingTasks.tasks;
    assert.throws(() => validateSpecJsonObject(missingTasks), /tasks: required field is missing/);
    assert.throws(() => validateSpecJsonObject({
      ...emptySpecStub(),
      tasks: [{
        id: "T-1", title: "Mapped", goal: "A mapped Task", origin: "plan", added_round: 0, status: "pending",
      }],
      requirements: [{ id: "R-1", desc: "A mapping is mandatory." }],
    }), /task_ids: required field is missing/);
    assert.throws(() => new CurrentFlowSpecRecord(emptySpecStub(), { specId: "mapping-boundary" }).withTask({
      id: "T-1", title: "Unmapped", goal: "Must not persist.",
    }), /Task admission has no mapped Requirement: T-1/);
    assert.throws(() => validateSpecJsonObject({
      ...emptySpecStub(),
      tasks: [{
        id: "T-1", title: "Unmapped", goal: "A Task cannot be orphaned", origin: "plan", added_round: 0, status: "pending",
      }],
      requirements: [],
    }), /no mapped Requirements: T-1/);
  });

  it("projects one deterministic Task context for descriptors, artifacts, prompts, and action identity", () => {
    const context = new CanonicalTaskContext({
      state: { runId: "run-1", specId: "spec-1", currentTaskId: "T-1" },
      spec,
      sourceFingerprint: digest,
    });
    assert.deepEqual(canonicalTaskContextKinds("task-impl"), ["task_spec", "requirements", "overview"]);
    assert.deepEqual(canonicalTaskContextKinds("task-review"), ["task_spec", "requirements", "source"]);
    assert.throws(() => canonicalTaskContextKinds("task-unknown"), /does not support Step/);
    const projection = context.projectWorkerContext({ stepId: "task-impl" }).toJSON();
    assert.deepEqual(projection.kinds, canonicalTaskContextKinds("task-impl"));
    assert.deepEqual(projection.task, context.readOnlyInput());
    const action = {
      taskId: "T-1",
      step: "task-impl",
      action: "run-impl",
      context: projection,
      directive: new ExecuteStepDirective({ action: "run-impl" }).toJSON(),
    };
    const session = new FlowDispatchSession({
      id: "task-context-projection",
      target: new FlowDispatchTarget({ expectation: new FlowTargetExpectation({ expectRunId: "run-1" }) }),
    });
    const bound = session.captureAction(action, "repository-fingerprint");
    const stale = session.captureAction({
      ...action,
      context: { ...projection, task: { ...projection.task, fingerprint: "b".repeat(64) } },
    }, "repository-fingerprint");
    assert.notEqual(bound.digest, stale.digest, "the worker Action identity must bind the projected canonical Task context");
    assert.deepEqual(context.taskIds, ["T-1", "T-2"], "Task order follows tasks[] and does not require dependency metadata");
    assert.deepEqual(context.readOnlyInput().requirements.map((requirement) => requirement.id), ["R-1", "R-2"]);
    assert.throws(() => new CanonicalTaskContext({
      state: { runId: "run-1", specId: "spec-1", currentTaskId: "T-3" }, spec, sourceFingerprint: digest,
    }), /absent from spec/);
  });

  it("round-trips a task-scoped worker snapshot without widening it to the full canonical Spec", () => {
    const snapshot = taskContextSnapshot();
    const stored = snapshot.toJSON();
    const restored = TaskWorkerContextSnapshot.fromStored(stored);

    assert.deepEqual(restored.toJSON(), stored);
    assert.deepEqual(restored.context.taskIds, ["T-2", "T-4", "T-6"]);
    assert.deepEqual(
      restored.context.requirements.map((requirement) => requirement.id),
      ["R-4", "R-4-6"],
    );
    assert.deepEqual(
      restored.context.requirements.flatMap((requirement) => requirement.task_ids),
      ["T-4", "T-4", "T-6"],
    );
    assert.doesNotThrow(() => new CanonicalTaskRequirementMap(taskScopedSpec));
    assert.throws(() => new CanonicalTaskRequirementMap({
      ...taskScopedSpec,
      requirements: taskScopedSpec.requirements.slice(1),
    }), /no mapped Requirements: T-2/);
  });

  it("rebuilds Task publication context with the captured source fingerprint", () => {
    const source = Buffer.from(JSON.stringify(taskScopedSpec));
    const flowManager = {
      readArtifact() {
        return { bytes: source };
      },
    };
    const state = { runId: "run-4", specId: "spec-4", issue: null };
    const snapshot = TaskWorkerContextSnapshot.materialize({
      state,
      invocation: {
        id: "dispatch-4",
        action: { digest: "b".repeat(64), nextAction: { taskId: "T-4" } },
        target: { digest: "c".repeat(64) },
      },
      flowManager,
      sourceFingerprint: digest,
    });

    // The worker may legitimately update a file already in this Task's
    // lineage. The parent validates that filesystem mutation from its source
    // baseline; publication context keeps the pre-worker source binding.
    const rebuilt = snapshot.rebuildCapturedContext({ state, flowManager });

    assert.equal(rebuilt.context.sourceFingerprint, digest);
    assert.equal(rebuilt.digest, snapshot.digest);
  });

  it("rejects Task canonical drift before source handoff publication", () => {
    assertTaskCanonicalDrift({
      label: "task",
      mutate(document) { document.tasks[0].title = "Changed Task identity after worker capture"; },
    });
  });

  it("rejects mapped Requirement canonical drift before source handoff publication", () => {
    assertTaskCanonicalDrift({
      label: "requirement",
      mutate(document) { document.requirements[0].desc = "Changed requirement content after worker capture."; },
    });
  });

  it("rejects overview canonical drift before source handoff publication", () => {
    assertTaskCanonicalDrift({
      label: "overview",
      mutate(document) { document.overview.modules.push("Changed overview content after worker capture."); },
    });
  });

  it("rejects malformed task-scoped snapshot identities before accepting its digest", () => {
    const snapshot = taskContextSnapshot().toJSON();
    const invalidCases = [
      ["duplicate Task lineage", (value) => { value.context.lineage.taskIds = ["T-2", "T-4", "T-4"]; }, /taskIds must not duplicate/],
      ["missing current Task lineage", (value) => { value.context.lineage.taskIds = ["T-2", "T-6"]; }, /must include current Task/],
      ["mismatched current Task document", (value) => { value.context.task.id = "T-2"; }, /task.id must match current Task/],
      ["foreign Requirement", (value) => { value.context.requirements[0].task_ids = ["T-2"]; }, /does not map current Task/],
      ["unknown Requirement Task", (value) => { value.context.requirements[0].task_ids = ["T-4", "T-unknown"]; }, /references unknown Task/],
      ["duplicate Requirement identity", (value) => { value.context.requirements[1].id = "R-4"; }, /Requirement ids must be unique/],
      ["invalid context fingerprint", (value) => { value.context.fingerprint = "d".repeat(64); }, /fingerprint is invalid/],
      ["invalid snapshot digest", (value) => { value.digest = "e".repeat(64); }, /snapshot digest is invalid/],
    ];

    for (const [label, mutate, expected] of invalidCases) {
      const invalid = structuredClone(snapshot);
      mutate(invalid);
      assert.throws(() => TaskWorkerContextSnapshot.fromStored(invalid), expected, label);
    }
  });

  it("accepts a sealed task implementation handoff with Task-only Requirements", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-handoff-"));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const specId = "task-scoped-handoff";
    const { tasks, ...taskSpecRecord } = taskScopedSpec;
    try {
      new TaskLifecycleFixture({
        flowManager: manager,
        specId,
        runId: "run-task-scoped-handoff",
        request: "Accept a sealed Task implementation handoff.",
        specRecord: taskSpecRecord,
        taskDocuments: tasks,
        taskId: "T-4",
        targetStep: "task-impl",
      }).create();
      const state = manager.loadReadOnly(specId);
      const invocation = {
        id: "dispatch-task-scoped-handoff",
        target: { digest: "c".repeat(64) },
        action: {
          digest: "b".repeat(64),
          nextAction: { step: "task-impl", taskId: "T-4" },
        },
      };
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager };
      const coordinator = new WorkerArtifactHandoffCoordinator({
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      });
      const request = coordinator.createRequest({ ctx, state, invocation });
      const mutationAuthority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      assert.deepEqual(
        request.contextSnapshot.context.requirements.map((requirement) => requirement.id),
        ["R-4", "R-4-6"],
      );
      captureSourceMutationManifestForParent({ request });
      fs.writeFileSync(request.payloadPath("effects.json"), JSON.stringify({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: [],
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: "The Task already satisfies its source implementation requirement.",
      }));
      sealParentMaterializedSourceWorkerEffect({ request, now: () => new Date("2026-09-03T00:00:01.000Z") });

      assert.throws(
        () => coordinator.recoverPending({ ctx }),
        (error) => error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
        "recovery parses the Task snapshot and reaches the source-handoff recovery rule",
      );

      const result = coordinator.reconcile({ ctx, request, mutationAuthority });
      assert.equal(result.completed, true);
      assert.equal(fs.existsSync(request.directory), false, "parent acceptance atomically consumes the sealed handoff");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a second Task implementation handoff that updates an existing lineage file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-lineage-handoff-"));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const specId = "task-lineage-handoff";
    const ctx = () => ({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
    });
    try {
      new TaskLifecycleFixture({
        flowManager: manager,
        specId,
        runId: "run-task-lineage-handoff",
        request: "Repair one Task through a second implementation attempt.",
        taskDocuments: [{
          id: "T-1", title: "Lineage repair", goal: "Change the same source file twice.",
          parent: null, origin: "plan", added_round: 0, status: "pending",
        }],
        taskId: "T-1",
        targetStep: "task-impl",
      }).create();

      const firstBaseline = SourceMutationBaseline.capture({
        root,
        attempt: manager.canonicalState(specId).attempt,
      });
      fs.writeFileSync(path.join(root, "shared.js"), "export const revision = 1;\n");
      const firstManifest = SourceMutationManifest.capture({ baseline: firstBaseline });
      manager.confirmSourceWorkerHandoff({
        specId,
        mutationManifest: firstManifest,
        handoffDigest: "d".repeat(64),
        effect: new SourceWorkerEffect({
          version: 1,
          stepId: "task-impl",
          completionStatus: "done",
          files: [{ requirementId: "R-T-1", mutationIds: firstManifest.mutations.map((entry) => entry.mutationId) }],
          issues: [],
          overview: { modules: [], data_flow: [], decisions: [] },
          triage: null,
          repair: null,
        }),
        result: {
          outcome: "passed",
          summary: "First Task implementation established the source lineage.",
          confirmedAt: "2026-09-03T00:00:00.000Z",
          artifactRefs: [],
        },
      });
      manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId });
      confirmCanonicalFixtureStep(manager, specId, "T-1-review");
      confirmCanonicalFixtureStep(manager, specId, "T-1-triage", "skipped");
      confirmCanonicalFixtureStep(manager, specId, "T-1-repair", "skipped");
      manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "in_progress" }, { specId });

      const observation = {
        kind: "violation",
        failureMode: "guardrail-violation",
        requirementRef: "R-T-1",
        where: { file: "shared.js", locator: "revision" },
        observed: "A repair round is required before accepting the second implementation.",
        severity: "blocking",
        refs: ["R-T-1"],
      };
      for (let evaluation = 1; evaluation <= 5; evaluation += 1) {
        const commandResult = new CanonicalGatePromotion({
          state: manager.canonicalState(specId),
          phase: "task-impl",
          nodeId: "T-1-gate",
          activeTaskId: "T-1",
        }).promote({
          result: "fail",
          artifacts: {
            failureKind: "ai_semantic_fail",
            failureCode: "TASK_GATE_REJECTED",
            sourceFingerprint: captureCurrentTaskSource({
              root,
              flowManager: manager,
              state: manager.loadReadOnly(specId),
              taskId: "T-1",
            }).fingerprint,
            nextAction: { diagnosis: { observations: [observation] } },
          },
        });
        manager.failCurrentAttempt({
          specId,
          failure: {
            category: "semantic",
            code: "TASK_GATE_REJECTED",
            message: "Fixture gate rejection requests a bounded Task repair.",
            retryable: evaluation < 5,
            retryKind: evaluation < 5 ? "semantic" : null,
          },
          commandResult,
        });
        let decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.loadReadOnly(specId),
          phase: "task-impl",
        }));
        if (decision.plan.retryMetric !== null) {
          manager.recordTaskGateSettlementMetric({ specId, decision });
        }
        decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.loadReadOnly(specId),
          phase: "task-impl",
        }));
        appendIssueLogFromGateResult({
          ...ctx(),
          phase: "task-impl",
          gateTransitionDecision: decision,
          gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
        }, commandResult);
        decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.loadReadOnly(specId),
          phase: "task-impl",
        }));
        if (evaluation < 5) {
          manager.retryGateTransition({ specId, decision });
          continue;
        }
        assert.equal(decision.disposition.operation, "repair");
      }
      const repaired = new RunRepairPlanGateCommand().execute(ctx());
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-impl");

      const coordinator = new WorkerArtifactHandoffCoordinator({
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      });
      const invocation = {
        id: "dispatch-task-lineage-round-two",
        target: { digest: "c".repeat(64) },
        action: {
          digest: "b".repeat(64),
          nextAction: { step: "task-impl", taskId: "T-1" },
        },
      };
      const request = coordinator.createRequest({ ctx: ctx(), state: manager.loadReadOnly(specId), invocation });
      const mutationAuthority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      const capturedFingerprint = request.contextSnapshot.context.sourceFingerprint;
      assert.equal(capturedFingerprint, captureCurrentTaskSource({
        root,
        flowManager: manager,
        state: manager.loadReadOnly(specId),
        taskId: "T-1",
      }).fingerprint);

      // This is precisely the path that formerly recaptured the changed
      // lineage source in assertCurrent and rejected it as stale.
      fs.writeFileSync(path.join(root, "shared.js"), "export const revision = 2;\n");
      assert.notEqual(capturedFingerprint, captureCurrentTaskSource({
        root,
        flowManager: manager,
        state: manager.loadReadOnly(specId),
        taskId: "T-1",
      }).fingerprint, "the legacy post-worker source recapture would have invalidated the Task snapshot");
      materializeSourceWorkerEffect({ request, responseText: JSON.stringify({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: [{ requirementId: "R-T-1", paths: ["shared.js"] }],
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: null,
      }) });
      sealParentMaterializedSourceWorkerEffect({ request, now: () => new Date("2026-09-03T00:00:01.000Z") });

      const result = coordinator.reconcile({ ctx: ctx(), request, mutationAuthority });
      assert.equal(result.completed, true);
      assert.equal(fs.existsSync(request.directory), false, "parent acceptance consumes the sealed second handoff");
      assert.equal(manager.canonicalState(specId).current, null);
      manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId });
      confirmCanonicalFixtureStep(manager, specId, "T-1-review");
      confirmCanonicalFixtureStep(manager, specId, "T-1-triage", "skipped");
      confirmCanonicalFixtureStep(manager, specId, "T-1-repair", "skipped");
      manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "in_progress" }, { specId });
      const pass = new CanonicalGatePromotion({
        state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
      }).promote({ result: "pass", artifacts: { sourceFingerprint: captureCurrentTaskSource({
        root, flowManager: manager, state: manager.loadReadOnly(specId), taskId: "T-1",
      }).fingerprint } });
      manager.publishCurrentAttemptResult({ specId, commandResult: pass });
      let gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "task-impl",
      }));
      manager.recordTaskGateSettlementMetric({ specId, decision: gateDecision });
      gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "task-impl",
      }));
      appendIssueLogFromGateResult({
        ...ctx(), phase: "task-impl", gateTransitionDecision: gateDecision,
      }, pass);
      gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "task-impl",
      }));
      manager.confirmCurrentAttempt({ specId, status: "done", gateTransitionDecision: gateDecision });
      assert.equal(manager.canonicalState(specId).findNode("T-1").status, "done");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists only parent-bound quality risks with the mandatory Task Review recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-quality-risk-"));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const specId = "task-quality-risk";
    try {
      new TaskLifecycleFixture({
        flowManager: manager, specId, runId: "run-task-quality-risk", request: "Persist a bounded quality risk.",
        taskDocuments: [{ id: "T-1", title: "Quality", goal: "Exercise parent-owned quality persistence.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
        taskId: "T-1", targetStep: "task-impl",
      }).create();
      const baseline = SourceMutationBaseline.capture({ root, attempt: manager.canonicalState(specId).attempt });
      fs.writeFileSync(path.join(root, "quality.js"), "export const quality = true;\n");
      const manifest = SourceMutationManifest.capture({ baseline });
      manager.confirmSourceWorkerHandoff({
        specId, mutationManifest: manifest, handoffDigest: "9".repeat(64),
        effect: new SourceWorkerEffect({
          version: 1, stepId: "task-impl", completionStatus: "done",
          files: [{ requirementId: "R-T-1", mutationIds: manifest.mutations.map((entry) => entry.mutationId) }],
          issues: [{ classification: "quality", reason: "The implementation needs a later quality review for its boundary behavior.", remainingRisk: "The changed behavior remains subject to the mandatory Task Review checkpoint." }],
          overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
        }),
        result: { outcome: "passed", summary: "Persisted a parent-bound source quality risk.", confirmedAt: "2026-09-03T00:00:00.000Z", artifactRefs: [] },
      });
      const issueLog = JSON.parse(manager.readArtifact({ specId, logicalKey: "issue.log", consumerNodeId: "T-1-review" }).bytes.toString("utf8"));
      assert.deepEqual(issueLog.entries.map((entry) => ({
        classification: entry.classification, sourceStep: entry.origin.sourceStep, recoveryStep: entry.recoveryStep, risk: entry.remainingRisk,
      })), [{
        classification: "quality", sourceStep: "task-impl", recoveryStep: "T-1-review",
        risk: "The changed behavior remains subject to the mandatory Task Review checkpoint.",
      }]);
      assert.match(issueLog.entries[0].evidence.ref, /^worker-handoff:9{64}#effects\.json$/);
      assert.throws(() => new SourceWorkerEffect({
        version: 1, stepId: "task-impl", completionStatus: "done", files: [],
        issues: [{ classification: "integrity", reason: "A worker must not persist an integrity failure as an advisory quality issue.", remainingRisk: "Integrity failures must remain terminal before any source completion is published." }],
        overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
      }), /classification must be quality/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects only current content declared by current-Task manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-source-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/one.js"), "export const one = 1;\n");
    fs.writeFileSync(path.join(root, "src/two.js"), "export const two = 2;\n");
    const attempt = { id: "attempt-1", nodeId: "T-1-impl", sequence: 1 };
    const manifest = new SourceMutationManifest({
      attempt,
      baselineDigest: digest,
      mutations: [{ mutationId: "b".repeat(64), path: "src/one.js", changeKind: "content", beforeDigest: digest, afterDigest: "c".repeat(64) }],
    });
    const lineage = new TaskMutationLineage({
      runId: "run-1", specId: "spec-1", taskId: "T-1", role: "implementation", attempt,
      budget: new TaskExecutionBudget({ round: 1, reviewAttemptSequenceAtStart: 0, gateAttemptSequenceAtStart: 0 }),
      sourceFingerprint: manifest.digest, manifest: manifest.toJSON(),
    });
    const lineageSet = new TaskMutationLineageSet({ runId: "run-1", specId: "spec-1", taskId: "T-1", lineages: [lineage] });
    const selection = CurrentTaskSourceSnapshot.capture({ root, lineageSet });
    assert.deepEqual(selection.entries.map((file) => file.path), ["src/one.js"]);
    assert.doesNotMatch(JSON.stringify(selection.toJSON()), /src\/two\.js/);
    const taskBAttempt = { id: "attempt-b", nodeId: "T-2-impl", sequence: 1 };
    const taskBManifest = new SourceMutationManifest({ attempt: taskBAttempt, baselineDigest: digest, mutations: [] });
    const taskBLineage = new TaskMutationLineage({
      runId: "run-1", specId: "spec-1", taskId: "T-2", role: "implementation", attempt: taskBAttempt,
      budget: new TaskExecutionBudget({ round: 1, reviewAttemptSequenceAtStart: 0, gateAttemptSequenceAtStart: 0 }),
      sourceFingerprint: taskBManifest.digest, manifest: taskBManifest.toJSON(), noChangeReason: "Task B is already satisfied.",
    });
    const taskBSource = CurrentTaskSourceSnapshot.capture({
      root,
      lineageSet: new TaskMutationLineageSet({ runId: "run-1", specId: "spec-1", taskId: "T-2", lineages: [taskBLineage] }),
    });
    assert.deepEqual(taskBSource.entries, [], "Task B must not inherit Task A's dirty path");
    assert.throws(() => new TaskMutationLineageSet({
      runId: "run-1", specId: "spec-1", taskId: "T-2", lineages: [lineage],
    }), /another Task/);
  });

  it("keeps Task A dirty while Task B executes against only its own current source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-task-context-flow-"));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const specId = "001-task-source-isolation";
    const context = () => ({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
    });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-source-isolation",
      request: "Keep current Task source isolated.",
      taskDocuments: [
        { id: "T-A", title: "First", goal: "Leave Task A source dirty", parent: null, origin: "plan", added_round: 0, status: "pending" },
        { id: "T-B", title: "Second", goal: "Read only Task B source", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-A",
      targetStep: "task-impl",
    }).create();

    const confirmTaskMutation = (taskId, requirementId, writes) => {
      const baseline = SourceMutationBaseline.capture({ root, attempt: manager.canonicalState(specId).attempt });
      for (const [relativePath, content] of writes) {
        fs.writeFileSync(path.join(root, relativePath), content);
      }
      const manifest = SourceMutationManifest.capture({ baseline });
      manager.confirmSourceWorkerHandoff({
        specId,
        mutationManifest: manifest,
        handoffDigest: "f".repeat(64),
        effect: new SourceWorkerEffect({
          version: 1,
          stepId: "task-impl",
          completionStatus: "done",
          files: [{ requirementId, mutationIds: manifest.mutations.map((entry) => entry.mutationId) }],
          issues: [],
          overview: { modules: [], data_flow: [], decisions: [] },
          triage: null,
          repair: null,
        }),
        result: {
          outcome: "passed",
          summary: `Fixture ${taskId} source mutation completed.`,
          confirmedAt: "2026-09-03T00:00:00.000Z",
          artifactRefs: [],
        },
      });
    };

    confirmTaskMutation("T-A", "R-T-A", [
      ["task-a.js", "export const taskAOnly = true;\n"],
      ["shared.js", "export const taskA = true;\n"],
    ]);
    manager.updateStepStatus({ stepId: "T-A-review", requestedStatus: "in_progress" }, { specId });
    confirmCanonicalFixtureStep(manager, specId, "T-A-review");
    confirmCanonicalFixtureStep(manager, specId, "T-A-triage", "skipped");
    confirmCanonicalFixtureStep(manager, specId, "T-A-repair", "skipped");
    manager.updateStepStatus({ stepId: "T-A-gate", requestedStatus: "in_progress" }, { specId });
    const taskAGate = new CanonicalGatePromotion({
      state: manager.canonicalState(specId),
      phase: "task-impl",
      nodeId: "T-A-gate",
      activeTaskId: "T-A",
    }).promote({
      result: "pass",
      artifacts: {
        sourceFingerprint: captureCurrentTaskSource({ root, flowManager: manager, state: manager.loadReadOnly(specId), taskId: "T-A" }).fingerprint,
      },
    });
    manager.publishCurrentAttemptResult({ specId, commandResult: taskAGate });
    let taskAGateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      phase: "task-impl",
    }));
    manager.recordTaskGateSettlementMetric({ specId, decision: taskAGateDecision });
    taskAGateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      phase: "task-impl",
    }));
    appendIssueLogFromGateResult({
      ...context(),
      phase: "task-impl",
      gateTransitionDecision: taskAGateDecision,
    }, taskAGate);
    taskAGateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      phase: "task-impl",
    }));
    manager.confirmCurrentAttempt({ specId, status: "done", gateTransitionDecision: taskAGateDecision });

    const taskBAction = await new GetNextActionCommand().execute(context());
    assert.equal(taskBAction.taskId, "T-B");
    assert.equal(taskBAction.step, "task-impl");
    assert.deepEqual(taskBAction.context.task.requirements.map((requirement) => requirement.id), ["R-T-B"]);
    assert.doesNotMatch(JSON.stringify(taskBAction.context.task), /taskAOnly/);
    manager.startTask("T-B", { specId });
    const activeTaskBAction = await new GetNextActionCommand().execute(context());
    assert.equal(activeTaskBAction.context.task.lineage.taskId, "T-B");

    confirmTaskMutation("T-B", "R-T-B", [[
      "shared.js",
      "export const taskA = true;\nexport const taskB = true;\n",
    ]]);
    manager.updateStepStatus({ stepId: "T-B-review", requestedStatus: "in_progress" }, { specId });
    const taskBReviewAction = await new GetNextActionCommand().execute(context());
    assert.equal(taskBReviewAction.step, "task-review");
    assert.deepEqual(taskBReviewAction.context.kinds, canonicalTaskContextKinds("task-review"));
    assert.deepEqual(taskBReviewAction.context.source.entries.map((entry) => entry.path), ["shared.js"]);
    assert.match(taskBReviewAction.context.source.entries[0].content, /taskA = true/);
    assert.match(taskBReviewAction.context.source.entries[0].content, /taskB = true/);
    assert.doesNotMatch(JSON.stringify(taskBReviewAction.context.source), /task-a\.js/);
    const taskBSource = captureCurrentTaskSource({
      root,
      flowManager: manager,
      state: manager.loadReadOnly(specId),
      taskId: "T-B",
    });
    assert.deepEqual(taskBSource.entries.map((entry) => entry.path), ["shared.js"]);
    assert.match(taskBSource.entries[0].content, /taskA = true/);
    assert.match(taskBSource.entries[0].content, /taskB = true/);
    assert.doesNotMatch(JSON.stringify(taskBSource.toJSON()), /task-a\.js/);
    assert.equal(fs.existsSync(path.join(root, "task-a.js")), true, "Task A dirty source remains in the repository");

    const reviewWorkUnit = new CanonicalReviewWorkUnit({
      flowManager: manager,
      state: manager.loadReadOnly(specId),
      phase: "impl",
      taskId: "T-B",
      executionRoot: root,
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });
    reviewWorkUnit.prepare();
    reviewWorkUnit.materializeTaskSpec();
    const taskReviewInputs = reviewWorkUnit.materializeTaskContextAndSource();
    assert.strictEqual(reviewWorkUnit.taskWorkerProjection.context, reviewWorkUnit.taskContext);
    assert.strictEqual(reviewWorkUnit.taskWorkerProjection.source, reviewWorkUnit.taskSource);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(taskReviewInputs.context.sourcePath, "utf8")),
      taskBReviewAction.context.task,
      "the Review materialized Task context is the action-bound context projection",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(taskReviewInputs.source.sourcePath, "utf8")),
      taskBReviewAction.context.source,
      "the Review prompt source is the same Task-only source projection",
    );
  });

  it("requires an explicit no-change field in the sealed source effect", () => {
    assert.throws(() => SourceWorkerEffect.fromDocument({
      version: 1, stepId: "task-impl", completionStatus: "done", files: [], issues: [],
      overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
    }, "task-impl"), /invalid schema/);
    const effect = SourceWorkerEffect.fromDocument({
      version: 1, stepId: "task-impl", completionStatus: "done", files: [], issues: [],
      overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
      noChangeReason: "The requested behavior is already present.",
    }, "task-impl");
    assert.equal(effect.noChangeReason.text, "The requested behavior is already present.");
  });

});
