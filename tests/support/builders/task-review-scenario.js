import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TaskLifecycleFixture, makeFlowManager } from "../infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "./tmp-dir.js";
import { SourceMutationBaseline, SourceMutationManifest, SourceWorkerEffect } from "../../../src/flow/lib/worker-artifact-handoff.js";
import SetRetryCommand from "../../../src/flow/lib/set-retry.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";

/** Local canonical fixture; never dispatches a Flow or starts a worker. */
export class TaskReviewScenario {
  constructor(t) {
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
        requirements: [{ id: "R-1", desc: "Preserve bounded Review behavior.", task_ids: [this.taskId] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{ id: this.taskId, title: "Review behavior", goal: "Preserve Review state.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
    }).create();
    this.confirmImplementation("implemented source\n");
  }

  confirmImplementation(content, { claimReview = true } = {}) {
    const baseline = SourceMutationBaseline.capture({ root: this.root, attempt: this.state().attempt });
    fs.writeFileSync(this.sourcePath, content);
    const manifest = SourceMutationManifest.capture({ baseline });
    this.manager.confirmSourceWorkerHandoff({
      specId: this.specId, mutationManifest: manifest, handoffDigest: "c".repeat(64),
      effect: new SourceWorkerEffect({
        version: 1, stepId: "task-impl", completionStatus: "done",
        files: [{ requirementId: "R-1", mutationIds: manifest.mutations.map((entry) => entry.mutationId) }],
        issues: [], overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
      }),
      result: { outcome: "passed", summary: "Implementation fixture", confirmedAt: "2026-09-07T00:00:00.000Z", artifactRefs: [] },
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
}
