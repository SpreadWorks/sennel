import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TaskLifecycleFixture, makeFlowManager } from "../infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "./tmp-dir.js";
import {
  WorkerArtifactHandoffCoordinator,
  materializeSourceWorkerEffect, sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import SetRetryCommand from "../../../src/flow/lib/set-retry.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { runTaskReviewProtocol, parseImplReviewFindings, formatImplReviewJson } from "../../../src/flow/commands/review.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { completeCanonicalSourceHandoff } from "./source-handoff-scenario.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";

class TaskReviewScenarioAgent {
  constructor(findings, edit) { this.findings = findings; this.edit = edit; }
  providerRetryPolicy() { return { retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }; }
  async call() {
    this.edit?.();
    return JSON.stringify({ blockingFindings: this.findings, nonBlockingImprovements: [] });
  }
}

function taskStageContext({ root, manager, specId }) {
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    specId,
    flowManager: manager,
    flowState: manager.loadReadOnly(specId),
    config: {},
  };
}

/** Create the production worker handoff boundary for one active Task triage or repair. */
export function createTaskStageHandoff({ root, manager, specId, taskId, role }) {
  const nodeId = `${taskId}-${role}`;
  const state = manager.canonicalState(specId);
  if (state.current?.at(-1) !== nodeId) {
    manager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId });
  }
  const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-09-08T00:00:00.000Z") });
  const invocation = {
    id: `dispatch-${manager.canonicalState(specId).attempt.id}`,
    target: { digest: "c".repeat(64) },
    action: { digest: "b".repeat(64), nextAction: { step: `task-${role}`, taskId } },
  };
  const ctx = taskStageContext({ root, manager, specId });
  const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
  lease.acquire();
  let released = false;
  const release = () => {
    if (!released) lease.release();
    released = true;
  };
  try {
    const request = coordinator.createRequest({ ctx, state: manager.loadReadOnly(specId), invocation });
    coordinator.startSourceWorker({ ctx, request, invocation });
    return { coordinator, request, authority: coordinator.sourceMutationAuthority({ ctx, request }), ctx, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Materialize and durably record one stopped Task source worker. */
export function finishTaskStageHandoff(work, effect) {
  materializeSourceWorkerEffect({ request: work.request, responseText: JSON.stringify(effect) });
  sealParentMaterializedSourceWorkerEffect({ request: work.request });
  work.coordinator.finishSourceWorker({ ctx: work.ctx, request: work.request });
  return work;
}

/** Reconcile a stopped Task stage through its canonical parent boundary. */
export function reconcileTaskStageHandoff(work) {
  try {
    return work.coordinator.reconcile({
      ctx: work.ctx, request: work.request,
      mutationAuthority: work.coordinator.sourceMutationAuthority({ ctx: work.ctx, request: work.request }),
    });
  } finally {
    work.release();
  }
}

/** Seal and reconcile one Task stage through its canonical parent boundary. */
export function completeTaskStageHandoff(work, effect) {
  try {
    finishTaskStageHandoff(work, effect);
  } catch (error) {
    work.release();
    throw error;
  }
  return reconcileTaskStageHandoff(work);
}

/** Local canonical fixture; never dispatches a Flow or starts a worker. */
export class TaskReviewScenario {
  constructor(t, { noChange = false, implementationContent = "implemented source\n", additionalRequirements = [] } = {}) {
    this.root = createTmpDir("task-review-scenario-");
    t.after(() => removeTmpDir(this.root));
    this.specId = "001-review-scenario";
    this.taskId = "T-1";
    this.sourcePath = path.join(this.root, "README.md");
    fs.writeFileSync(this.sourcePath, "original source\n");
    initGitRepo(this.root);
    commitAll(this.root, "review scenario source");
    this.reload();
    // Same production setup as canonical-flow-manager-runtime.test.js:
    // Task implementation -> confirmed source handoff -> Task Review.
    new TaskLifecycleFixture({
      flowManager: this.manager, specId: this.specId, runId: "review-scenario",
      taskId: this.taskId, targetStep: "task-impl",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Preserve bounded Review behavior.", task_ids: [this.taskId] }, ...additionalRequirements],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{ id: this.taskId, title: "Review behavior", goal: "Preserve Review state.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
    }).create();
    if (noChange) this.confirmNoChangeImplementation();
    else this.confirmImplementation(implementationContent);
  }

  confirmImplementation(content, { claimReview = true } = {}) {
    completeCanonicalSourceHandoff({
      root: this.root, manager: this.manager, specId: this.specId,
      stepId: "task-impl", taskId: this.taskId,
      mutate: () => fs.writeFileSync(this.sourcePath, content),
      effect: {
        version: 1, stepId: "task-impl", completionStatus: "done",
        issues: [], overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
        noChangeReason: null,
      },
    });
    if (claimReview) {
      this.manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId: this.specId });
    }
    return this;
  }

  confirmNoChangeImplementation({ claimReview = true } = {}) {
    completeCanonicalSourceHandoff({
      root: this.root, manager: this.manager, specId: this.specId,
      stepId: "task-impl", taskId: this.taskId,
      effect: {
        version: 1, stepId: "task-impl", completionStatus: "done",
        issues: [], overview: { modules: [], data_flow: [], decisions: [] },
        triage: null, repair: null,
        noChangeReason: "The requested behavior is already present in the canonical source.",
      },
    });
    if (claimReview) {
      this.manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" }, { specId: this.specId });
    }
    return this;
  }

  reload() { this.manager = makeFlowManager(this.root); return this; }
  state() { return this.manager.canonicalState(this.specId); }
  context() {
    return {
      root: this.root, mainRoot: this.root, executionRoot: this.root,
      specId: this.specId, flowManager: this.manager,
      flowState: this.manager.loadReadOnly(this.specId), config: {},
    };
  }
  snapshot() {
    return JSON.stringify({
      state: this.state().toJSON(),
      activities: this.manager.activityLedger(this.specId),
      catalog: this.manager.artifactCatalog(this.specId).toJSON(),
    });
  }
  fail(kind = "tooling") {
    this.manager.failCurrentAttempt({ specId: this.specId, failure: {
      category: kind, retryKind: kind, retryable: true,
      code: kind === "semantic" ? "REVIEW_REJECTED" : "REVIEW_PROVIDER_UNAVAILABLE",
      message: "Deterministic boundary failure.",
    } });
    return this;
  }
  exhaust() {
    this.fail();
    for (let count = 0; this.state().failureDisposition().operation === "retry"; count += 1) {
      assert.ok(count < 10, "definition must bound tooling retries");
      this.manager.retryCurrentAttempt({ specId: this.specId });
      this.fail();
    }
    return this;
  }
  recover() {
    return new SetRetryCommand().execute({ ...this.context(), action: "reset", kind: "review", phase: "impl", reason: "Changed local fixture evidence.", yes: true });
  }
  changeEvidence(number) {
    fs.writeFileSync(path.join(this.root, "runtime-repair.js"), `export const revision = ${number};\n`);
    return this;
  }
  review(runCommand, options = {}) {
    return new RunReviewCommand({ resolveTreeSha: () => "a".repeat(40), resolveTargetStateDigest: () => "b".repeat(64), runCommand, ...options });
  }

  stageHandoff(role) {
    return createTaskStageHandoff({
      root: this.root,
      manager: this.manager,
      specId: this.specId,
      taskId: this.taskId,
      role,
    });
  }

  sealHandoff(work, effect) {
    try {
      finishTaskStageHandoff(work, effect);
    } finally {
      work.release();
    }
  }

  finishHandoff(work, effect) {
    try {
      return finishTaskStageHandoff(work, effect);
    } catch (error) {
      work.release();
      throw error;
    }
  }

  reconcileHandoff(work) {
    return reconcileTaskStageHandoff(work);
  }

  completeHandoff(work, effect) {
    return completeTaskStageHandoff(work, effect);
  }

  async publishReview(findings = [], { edit = null } = {}) {
    const command = this.review(async (_command, _args, options) => {
      const previous = process.env.SENNEL_REVIEW_OUTPUT_DIR;
      process.env.SENNEL_REVIEW_OUTPUT_DIR = options.env.SENNEL_REVIEW_OUTPUT_DIR;
      try {
        const requirementIds = new Set(["R-1"]);
        const raw = await runTaskReviewProtocol({
          root: this.root,
          executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
          flowManager: this.manager,
          requirementIds,
          recurrenceHistory: [],
          sourcePaths: new Set(["README.md"]),
          agent: new TaskReviewScenarioAgent(findings, edit),
          prompt: "Review the canonical Task",
          systemPrompt: "Return findings only",
        });
        const parsed = parseImplReviewFindings(raw, { requirementIds });
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), formatImplReviewJson({
          ...parsed,
          generatedAt: "2026-09-08T00:00:00.000Z",
          requirementIds,
        }));
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      } finally {
        if (previous === undefined) delete process.env.SENNEL_REVIEW_OUTPUT_DIR;
        else process.env.SENNEL_REVIEW_OUTPUT_DIR = previous;
      }
    });
    const result = await command.execute(this.context());
    if (result.ok !== false) await FLOW_COMMANDS.run.review.post(this.context(), result);
    return result;
  }
}
