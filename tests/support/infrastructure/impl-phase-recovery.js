import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskReviewScenario } from "../builders/task-review-scenario.js";
import { ImplPhaseScenario, implementationFinding } from "../impl-phase-scenario.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { container } from "../../../src/lib/container.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { ImplPhasePublicationObserver } from "./impl-phase-publication-observer.js";

/** Phase-scoped source recovery: canonical implementation, Review and host
 * filter are real producers. Only the external source edit/Review process is fake. */
export class ImplPhaseRecoveryScenario extends TaskReviewScenario {
  constructor(t, options = {}) {
    super(t, options);
    this.publicationObserver = new ImplPhasePublicationObserver(t);
    this.calls ??= { sourceWorkers: 0, reviewProcesses: 0, evaluators: 0 };
    container.reset();
    container.register("root", this.root);
    t.after(() => container.reset());
  }

  confirmImplementation(content, options) {
    const result = super.confirmImplementation(content, options);
    this.calls ??= { sourceWorkers: 0, reviewProcesses: 0, evaluators: 0 };
    this.calls.sourceWorkers += 1;
    return result;
  }

  finding(overrides = {}) {
    return { ...implementationFinding(), file: "README.md", requirementId: "R-1", ...overrides };
  }

  async prepareRepair(findings = [this.finding()]) {
    const result = await this.publishReview(findings, { edit: () => { this.calls.reviewProcesses += 1; } });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    this.reload();
    assert.equal(this.state().current?.at(-1), `${this.taskId}-triage`);
    assert.equal((await this.filter([])).ok, true);
    this.reload();
    assert.equal(this.state().current?.at(-1), `${this.taskId}-repair`);
    return this;
  }

  repairEffect(work) {
    const review = work.request.inputs.find((input) => input.name === "task-review.json").document;
    const recurrence = work.request.inputs.find((input) => input.name === "task-review-recurrence.json").document;
    const findings = [...review.blockingFindings, ...review.nonBlockingImprovements];
    return { version: 1, stepId: "task-repair", completionStatus: "done", issues: [], overview: null, triage: null,
      repair: { version: 1, findings: findings.map(({ findingKey }) => ({ findingKey, paths: ["README.md"] })),
        summary: "Corrected the selected canonical findings.",
        recurrenceResolutions: recurrence.entries.map(({ findingKey, fingerprint }) => ({ findingKey, fingerprint,
          priorRepairInsufficiency: "The previous correction omitted this branch.",
          repairStrategy: "Add the required branch while preserving preceding corrections." })) }, noChangeReason: null };
  }

  sealRepair(t) {
    const work = this.stageHandoff("repair");
    t.after(() => work.release());
    this.runSourceWorker(() => fs.appendFileSync(this.sourcePath, "corrected canonical behavior\n"));
    this.sealHandoff(work, this.repairEffect(work));
    return work;
  }

  runSourceWorker(mutate) {
    this.calls.sourceWorkers += 1;
    return mutate();
  }

  reloadWithFault(versionStoreFaultInjector) {
    this.manager = new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false,
      specId: this.specId, versionStoreFaultInjector });
    return this;
  }

  authority(request) {
    return this.manager.readSourceHandoffAuthority({ specId: this.specId, identity: request.sourceHandoffIdentity });
  }

  recovery() { return new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: this.context() }); }

  snapshot() {
    return JSON.stringify({ canonical: JSON.parse(super.snapshot()),
      lineages: this.manager.taskMutationLineages({ specId: this.specId, taskId: this.taskId }).map((entry) => entry.toJSON()),
      calls: this.calls });
  }

  assertResults(nodes) { ImplPhaseScenario.prototype.assertResults.call(this, nodes); }
  assertClaims(nodes) { ImplPhaseScenario.prototype.assertClaims.call(this, nodes); }

  async unpostedReview(findings = []) {
    const worker = fileURLToPath(new URL("../impl-phase-review-worker.js", import.meta.url));
    const command = this.review((_command, _args, options) => {
      this.calls.reviewProcesses += 1;
      const child = spawnSync(process.execPath, [worker], { ...options, encoding: "utf8",
        env: { ...options.env, SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify({
          blockingFindings: findings, nonBlockingImprovements: [],
        }) } });
      assert.equal(child.status, 0, child.stderr);
      return { ...child, ok: true };
    });
    return command.execute(this.context());
  }

  counts() {
    const activities = this.manager.activityLedger(this.specId);
    const catalog = this.manager.artifactCatalog(this.specId).artifacts;
    return { calls: { ...this.calls },
      activities: activities.length,
      // Metrics are Activity-owned. Replay must not duplicate their timing or
      // usage, even when a provider's value is unavailable rather than zero.
      metrics: activities.map((entry) => ({ id: entry.id, timing: entry.timing, usage: entry.usage })),
      lineages: this.manager.taskMutationLineages({ specId: this.specId, taskId: this.taskId }).map((entry) => entry.toJSON()),
      publications: catalog.map((entry) => ({ logicalKey: entry.logicalKey, hash: entry.hash, activityId: entry.activityId })),
      tasks: this.manager.loadReadOnly(this.specId).tasks.map((task) => ({ id: task.id, status: task.status,
        steps: task.steps.map((step) => ({ id: step.id, status: step.status })) })),
    };
  }
}
