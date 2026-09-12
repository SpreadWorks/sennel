import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  SourceWorkerHandoffIdentity,
  SourceHandoffEvent,
  SourceHandoffSettlement,
  SourceMutationManifest,
  SourceWorkerCanonicalObservationAdvance,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { container } from "../../../src/lib/container.js";
import {
  CanonicalFlowFixture,
  canonicalImplReviewArtifact,
} from "../../support/infrastructure/flow-setup.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  completeCanonicalSourceHandoff,
  withSourceHandoffLease,
} from "../../support/builders/source-handoff-scenario.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { BroadModeLedgerEntry } from "../../../src/flow/lib/task-scope.js";

const NOW = "2026-09-09T00:00:00.000Z";
const SOURCE_POLICIES = Object.freeze([
  "implement", "impl-triage", "impl-repair",
  "task-impl", "task-triage", "task-repair",
]);

function moduleUrlFor(relativePath) {
  return pathToFileURL(path.join(process.cwd(), relativePath)).href;
}

function specRecord() {
  return {
    goal: "Exercise durable source handoff recovery.",
    background: "A parent process may stop after the worker seals its result.",
    scope: { in: ["source handoff"], out: [] },
    constraints: [], design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "R1", desc: "Persist source handoff authority.", task_ids: ["T1"] }],
    acceptance_criteria: ["A fresh manager can settle the sealed result."],
    clarifications: [], alternatives_considered: [], open_questions: [],
  };
}

function taskDocument() {
  return {
    id: "T1", title: "Persist source authority", goal: "Recover one Task source worker.",
    parent: null, origin: "plan", added_round: 0, status: "pending",
  };
}

function sourceEffect(stepId, paths = []) {
  const base = {
    version: 1, stepId, completionStatus: "done", issues: [], overview: null,
    triage: null, repair: null, noChangeReason: null,
  };
  if (stepId === "impl-triage") {
    return { ...base, triage: { version: 1, dispositions: [{
      findingKey: "F1", disposition: "apply", basis: "repair-required",
      rationale: "The cataloged review requires the bounded repair.",
    }] } };
  }
  if (stepId === "impl-repair") {
    return { ...base, repair: { version: 1, findings: [{ findingKey: "F1", paths }], summary: "Applied the bounded repair.", recurrenceResolutions: [] } };
  }
  if (stepId === "task-impl") {
    return { ...base, overview: { modules: ["Task source"], data_flow: [], decisions: [] } };
  }
  if (stepId === "task-triage") {
    return { ...base, triage: { version: 1, dispositions: [{
      findingKey: "task-F1", disposition: "apply", basis: "repair-required",
      rationale: "The canonical Task review requires repair.",
    }] } };
  }
  if (stepId === "task-repair") {
    return { ...base, repair: { version: 1, findings: [{ findingKey: "task-F1", paths }], summary: "Applied the Task repair.", recurrenceResolutions: [] } };
  }
  return base;
}

class SourceCheckpointScenario {
  constructor(t, stepId, { worktree = false, issue = null } = {}) {
    this.temporaryRoot = createTmpDir(`source-checkpoint-${stepId}-`);
    t.after(() => removeTmpDir(this.temporaryRoot));
    this.executionRoot = worktree ? path.join(this.temporaryRoot, "execution") : this.temporaryRoot;
    this.mainRoot = worktree ? path.join(this.temporaryRoot, "main") : this.temporaryRoot;
    fs.mkdirSync(this.executionRoot, { recursive: true });
    fs.mkdirSync(this.mainRoot, { recursive: true });
    fs.writeFileSync(path.join(this.executionRoot, "product.js"), "export const value = 1;\n");
    initGitRepo(this.executionRoot);
    commitAll(this.executionRoot, "source checkpoint baseline");
    this.specId = `source-checkpoint-${stepId}-${worktree ? "worktree" : "direct"}`;
    this.worktree = worktree;
    this.reload();
    this.flow = new CanonicalFlowFixture({
      flowManager: this.manager, specId: this.specId, runId: `run-${this.specId}`,
      request: "Recover the source worker from canonical state.",
      issue,
      execution: worktree
        ? { mode: "worktree", baseBranch: "main", featureBranch: `feature/${this.specId}` }
        : { mode: "direct", baseBranch: "main", featureBranch: null },
      specRecord: specRecord(),
    }).create().addTask(taskDocument()).registerActive();
    this.prepare(stepId);
  }

  reload() {
    this.manager = new FlowManager({
      root: this.executionRoot, mainRoot: this.mainRoot,
      inWorktree: this.worktree, specId: this.specId,
    });
    return this;
  }

  context() {
    return {
      root: this.executionRoot, executionRoot: this.executionRoot, mainRoot: this.mainRoot,
      specId: this.specId, flowManager: this.manager, config: {},
    };
  }

  invocation(stepId) {
    const state = this.manager.canonicalState(this.specId);
    return {
      id: `dispatch-${stepId}-${state.attempt.id}`,
      target: { digest: crypto.createHash("sha256").update(`${stepId}:target`).digest("hex") },
      action: {
        digest: crypto.createHash("sha256").update(`${stepId}:action:${state.attempt.id}`).digest("hex"),
        nextAction: { step: stepId, ...(stepId.startsWith("task-") ? { taskId: "T1" } : {}) },
      },
    };
  }

  prepare(stepId) {
    if (stepId.startsWith("task-")) {
      this.flow.settleBefore("T1-impl");
      this.flow.activateTask("T1", { settlePredecessors: false });
      if (stepId !== "task-impl") this.completeTaskImplementation();
      if (stepId === "task-triage" || stepId === "task-repair") this.publishTaskReview();
      if (stepId === "task-repair") this.completeSourceAttempt("task-triage", [], sourceEffect("task-triage"));
      return;
    }
    this.flow.activate("implement");
    if (stepId === "implement") return;
    this.completeImplementation();
    this.flow.settleBefore("impl-review").activate("impl-review", { settlePredecessors: false });
    this.publishImplementationReview();
    this.flow.activate("impl-triage", { settlePredecessors: false });
    if (stepId === "impl-repair") this.completeSourceAttempt("impl-triage", [], sourceEffect("impl-triage"));
  }

  completeImplementation() {
    const sourcePath = path.join(this.executionRoot, "product.js");
    completeCanonicalSourceHandoff({
      root: this.executionRoot, mainRoot: this.mainRoot, manager: this.manager,
      specId: this.specId, stepId: "implement",
      mutate: () => fs.writeFileSync(sourcePath, "export const value = 2;\n"),
      effect: sourceEffect("implement"),
    });
  }

  completeTaskImplementation() {
    completeCanonicalSourceHandoff({
      root: this.executionRoot, mainRoot: this.mainRoot, manager: this.manager,
      specId: this.specId, stepId: "task-impl", taskId: "T1",
      effect: { ...sourceEffect("task-impl"), noChangeReason: "The flow implementation already provides the Task behavior." },
    });
    this.flow.activate("T1-review", { settlePredecessors: false });
  }

  publishImplementationReview() {
    const finding = {
      findingKey: "F1", title: "Repair the implementation", failureMode: "missing_requirement_behavior",
      file: "product.js", requirementId: "R1", guardrailId: null,
      issue: "The implementation needs the bounded repair.", suggestion: "Apply the cataloged repair.",
      disposition: "must-fix", rationale: "R1 requires the repair.",
    };
    const commandResult = { result: "Rejected implementation review." };
    attachCanonicalCommandResultArtifact(commandResult, {
      logicalKey: "impl.review",
      payload: canonicalImplReviewArtifact(this.manager.loadReadOnly(this.specId), { blockingFindings: [finding] }),
    });
    this.manager.updateStepStatus(
      { stepId: "impl-review", requestedStatus: "done" },
      { specId: this.specId, canonicalCommandResult: commandResult },
    );
  }

  publishTaskReview() {
    const commandResult = { result: "Rejected Task review." };
    attachCanonicalCommandResultArtifact(commandResult, {
      logicalKey: "task.review", parameters: { taskId: "T1" },
      payload: {
        version: 1, phase: "impl", generatedAt: NOW, verdict: "REJECTED",
        summary: { blocking: 1, nonBlocking: 0, total: 1 },
        blockingFindings: [{
          findingKey: "task-F1", title: "Repair the Task source", failureMode: "missing_requirement_behavior",
          file: "product.js", requirementId: "R1", issue: "The Task source needs repair.",
          suggestion: "Apply the bounded Task repair.", disposition: "must-fix", rationale: "R1 requires repair.",
        }], nonBlockingImprovements: [], excluded: { missingFile: 0, outOfScope: 0 },
      },
    });
    this.manager.updateStepStatus(
      { stepId: "T1-review", requestedStatus: "done" },
      { specId: this.specId, canonicalCommandResult: commandResult },
    );
    this.flow.activate("T1-triage", { settlePredecessors: false });
  }

  completeSourceAttempt(stepId, paths, effectDocument) {
    completeCanonicalSourceHandoff({
      root: this.executionRoot, mainRoot: this.mainRoot, manager: this.manager,
      specId: this.specId, stepId,
      effect: { ...effectDocument, ...(paths.length === 0 ? {} : { paths }) },
    });
  }

  stageSealed(stepId) {
    return withSourceHandoffLease({ root: this.executionRoot, mainRoot: this.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = this.context();
      const invocation = this.invocation(stepId);
      const request = coordinator.createRequest({ ctx, state: this.manager.loadReadOnly(this.specId), invocation });
      coordinator.startSourceWorker({ ctx, request, invocation });
      const changedPath = new Set(["implement", "impl-repair", "task-impl", "task-repair"]).has(stepId)
        ? `${stepId}.js`
        : null;
      if (changedPath !== null) fs.writeFileSync(path.join(this.executionRoot, changedPath), `// ${stepId}\n`);
      materializeSourceWorkerEffect({
        request,
        responseText: JSON.stringify(sourceEffect(stepId, changedPath === null ? [] : [changedPath])),
      });
      sealParentMaterializedSourceWorkerEffect({ request });
      coordinator.finishSourceWorker({ ctx, request });
      return request;
    });
  }
}

function protocolCounts(manager, specId) {
  const artifacts = manager.artifactCatalog(specId).artifacts;
  return {
    checkpoint: artifacts.filter((entry) => entry.logicalKey === "source.handoff.checkpoint").length,
    settlement: artifacts.filter((entry) => entry.logicalKey === "source.handoff.settlement").length,
    activities: manager.activityLedger(specId).length,
  };
}

function taskFinding() {
  return {
    findingKey: "missing-behavior", title: "Required behavior is missing",
    failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
    issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.",
    disposition: "must-fix", rationale: "The mapped requirement requires this behavior.",
  };
}

function taskStageEffect(stepId) {
  if (stepId === "task-triage") {
    return {
      ...sourceEffect(stepId),
      triage: { version: 1, dispositions: [{
        findingKey: "missing-behavior", disposition: "apply", basis: "repair-required",
        rationale: "The requirement confirms this missing behavior.",
      }] },
    };
  }
  return {
    ...sourceEffect(stepId, ["README.md"]),
    repair: {
      version: 1, findings: [{ findingKey: "missing-behavior", paths: ["README.md"] }],
      summary: "Implemented the mapped behavior.", recurrenceResolutions: [],
    },
  };
}

async function taskReviewPolicyScenario(t, stepId) {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const reviewed = await scenario.publishReview([taskFinding()]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  if (stepId === "task-repair") {
    const triage = scenario.stageHandoff("triage");
    scenario.sealHandoff(triage, taskStageEffect("task-triage"));
    scenario.reload();
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() })?.completed, true);
  }
  const role = stepId.slice("task-".length);
  const work = (() => {
    const staged = scenario.stageHandoff(role);
    if (stepId === "task-repair") fs.appendFileSync(scenario.sourcePath, "recovered repair\n");
    scenario.sealHandoff(staged, taskStageEffect(stepId));
    return staged;
  })();
  return { scenario, request: work.request };
}

it("survives a real parent process stop after source sealing and recovers from disk", (t) => {
  const scenario = new SourceCheckpointScenario(t, "implement");
  const moduleUrl = (relativePath) => pathToFileURL(path.join(process.cwd(), relativePath)).href;
  const child = `
    import fs from "node:fs";
    import path from "node:path";
    import { FlowManager } from ${JSON.stringify(moduleUrl("src/lib/flow-manager.js"))};
    import RunDispatchCommand from ${JSON.stringify(moduleUrl("src/flow/lib/run-dispatch.js"))};
    import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(moduleUrl("src/flow/lib/worker-artifact-handoff.js"))};
    import { sourceWorkerEffectJsonSchema } from ${JSON.stringify(moduleUrl("src/flow/lib/source-worker-effect-schema.js"))};
    const root = process.env.FFCA_EXECUTION_ROOT;
    const mainRoot = process.env.FFCA_MAIN_ROOT;
    const specId = process.env.FFCA_SPEC_ID;
    const flowManager = new FlowManager({ root, mainRoot, inWorktree: false, specId });
    const action = {
      taskId: null, step: "implement", action: "implement-source",
      instructions: { key: "plan.implement", content: "Implement the source change." },
      context: { workerArtifactHandoff: { required: true } },
      output_schema: sourceWorkerEffectJsonSchema("implement"), requires_approval: false, maxAttempts: 1,
      directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "implement-source" },
    };
    class CrashBeforeReconcileCoordinator extends WorkerArtifactHandoffCoordinator {
      reconcile() { process.exit(86); }
    }
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return action; } },
      agent: { async call() {
        fs.writeFileSync(path.join(root, "process-worker.js"), "// sealed before parent stop\\n");
        return JSON.stringify({ version: 1, stepId: "implement", completionStatus: "done", issues: [], overview: null, triage: null, repair: null, noChangeReason: null });
      } },
      repositoryFingerprint: () => "stable-process-fixture",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: new CrashBeforeReconcileCoordinator(),
    });
    dispatcher.container = {};
    await dispatcher.execute({
      root, executionRoot: root, mainRoot, specId, flowManager,
      flowState: flowManager.load(specId), expectRunId: flowManager.load(specId).runId, expectSpec: specId,
      _envelopeType: "run", _envelopeKey: "dispatch", config: {},
    });
  `;
  const stopped = spawnSync(process.execPath, ["--input-type=module", "--eval", child], {
    cwd: process.cwd(), encoding: "utf8",
    env: {
      ...process.env,
      FFCA_EXECUTION_ROOT: scenario.executionRoot,
      FFCA_MAIN_ROOT: scenario.mainRoot,
      FFCA_SPEC_ID: scenario.specId,
    },
  });
  assert.equal(stopped.status, 86, stopped.stderr || stopped.stdout);
  scenario.reload();

  const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

  assert.equal(recovered?.completed, true);
  assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("implement").status, "done");
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
});

describe("durable source handoff checkpoints", () => {
  it("recovers every source policy from a fresh disk-backed manager exactly once", async (t) => {
    for (const stepId of SOURCE_POLICIES) {
      await t.test(stepId, async () => {
        const taskReviewStage = new Set(["task-triage", "task-repair"]).has(stepId);
        const staged = taskReviewStage
          ? await taskReviewPolicyScenario(t, stepId)
          : (() => {
              const scenario = new SourceCheckpointScenario(t, stepId);
              return { scenario, request: scenario.stageSealed(stepId) };
            })();
        const { scenario, request } = staged;
        scenario.reload();
        const recovered = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) })
          .recoverPending({ ctx: scenario.context() });
        assert.equal(recovered?.completed, true, stepId);
        assert.equal(fs.existsSync(request.directory), false, stepId);
        const once = protocolCounts(scenario.manager, scenario.specId);
        const authority = scenario.manager.readSourceHandoffAuthority({
          specId: scenario.specId, identity: request.sourceHandoffIdentity,
        });
        assert.equal(authority.settlement.kind, "accepted", stepId);
        if (stepId === "implement") {
          const conflicting = new SourceHandoffSettlement({
            identity: request.sourceHandoffIdentity,
            checkpointDigest: request.sourceHandoffCheckpoint.digest,
            eventDigest: authority.event.digest,
            kind: "rolled-back",
          });
          assert.throws(
            () => scenario.manager.settleSourceHandoff({ specId: scenario.specId, settlement: conflicting }),
            (error) => error?.code === "CURRENT_FLOW_STATE_CONFLICT",
          );
        }
        assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null, stepId);
        assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), once, stepId);
      });
    }
  });

  it("recovers a worktree source policy from canonical state without a parent manager", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement", { worktree: true });
    scenario.stageSealed("implement");
    scenario.reload();
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() })?.completed, true);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId,
      identity: scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId })[0].identity,
    }).settlement.kind, "accepted");
  });

  it("preserves a linked Issue through source checkpoint publication, reload and recovery", (t) => {
    const scenario = new SourceCheckpointScenario(t, "task-impl", { worktree: true, issue: 73 });
    const request = scenario.stageSealed("task-impl");
    const originalId = request.sourceHandoffIdentity.storageId;
    scenario.reload();
    const [authority] = scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId });
    const identity = authority.checkpoint.identity.toJSON();
    assert.equal(identity.issue, 73);
    assert.equal(identity.flowIdentity.issue, 73);
    assert.equal(authority.checkpoint.identity.storageId, originalId);
    assert.equal(authority.event.kind, "worker-exited");
    assert.equal(authority.settlement, null);
    for (const issue of ["73", 74, null]) {
      assert.throws(() => new SourceWorkerHandoffIdentity({ ...identity, issue }), /does not bind its Flow node/);
    }
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() })?.completed, true);
    scenario.reload();
    const [settled] = scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId });
    assert.equal(settled.checkpoint.identity.storageId, originalId);
    assert.equal(settled.settlement.kind, "accepted");
    assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("T1-impl").status, "done");
    const counts = protocolCounts(scenario.manager, scenario.specId);
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
    assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), counts);
  });

  it("recovers source acceptance across the canonical catalog commit point", async (t) => {
    for (const boundary of ["before-json-rename", "before-json-directory-fsync"]) {
      await t.test(boundary, () => {
        const scenario = new SourceCheckpointScenario(t, "implement");
        const request = scenario.stageSealed("implement");
        const child = `
          import { FlowManager } from ${JSON.stringify(moduleUrlFor("src/lib/flow-manager.js"))};
          import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(moduleUrlFor("src/flow/lib/worker-artifact-handoff.js"))};
          const root = process.env.FFCA_EXECUTION_ROOT;
          const mainRoot = process.env.FFCA_MAIN_ROOT;
          const specId = process.env.FFCA_SPEC_ID;
          const catalogFile = process.env.FFCA_CATALOG_FILE;
          const manager = new FlowManager({
            root, mainRoot, inWorktree: false,
            versionStoreFaultInjector: ({ phase, filePath }) => {
              if (phase === ${JSON.stringify(boundary)} && filePath === catalogFile) process.kill(process.pid, "SIGKILL");
            },
          });
          new WorkerArtifactHandoffCoordinator().recoverPending({
            ctx: { root, executionRoot: root, mainRoot, specId, flowManager: manager },
          });
        `;
        const stopped = spawnSync(process.execPath, ["--input-type=module", "--eval", child], {
          cwd: process.cwd(), encoding: "utf8",
          env: {
            ...process.env,
            FFCA_EXECUTION_ROOT: scenario.executionRoot,
            FFCA_MAIN_ROOT: scenario.mainRoot,
            FFCA_SPEC_ID: scenario.specId,
            FFCA_CATALOG_FILE: scenario.manager.specLocation(scenario.specId).catalogFile,
          },
        });
        assert.equal(stopped.signal, "SIGKILL", stopped.stderr || stopped.stdout);
        scenario.reload();
        const authority = scenario.manager.readSourceHandoffAuthority({
          specId: scenario.specId, identity: request.sourceHandoffIdentity,
        });
        let cleanup = null;
        if (boundary === "before-json-rename") {
          assert.equal(authority.settlement, null);
          assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("implement").status, "in_progress");
          assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() })?.completed, true);
        } else {
          assert.equal(authority.settlement.kind, "accepted");
          assert.equal(scenario.manager.canonicalState(scenario.specId).findNode("implement").status, "done");
          cleanup = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });
          assert.deepEqual(cleanup, { completed: true, replayed: true, cleanedHandoffs: 1 });
        }
        const once = protocolCounts(scenario.manager, scenario.specId);
        assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
        assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), once);
      });
    }
  });

  it("fails closed when the canonical checkpoint bytes are missing or corrupt", async (t) => {
    for (const corruption of ["missing", "corrupt"]) {
      await t.test(corruption, () => {
        const scenario = new SourceCheckpointScenario(t, "implement");
        scenario.stageSealed("implement");
        const location = scenario.manager.specLocation(scenario.specId);
        const stateBytesBefore = fs.readFileSync(location.flowStateFile);
        const descriptor = scenario.manager.artifactCatalog(scenario.specId).artifacts
          .find((entry) => entry.logicalKey === "source.handoff.checkpoint");
        const checkpointPath = scenario.manager.specLocation(scenario.specId).resolve(descriptor.relativePath);
        if (corruption === "missing") fs.unlinkSync(checkpointPath);
        else fs.writeFileSync(checkpointPath, "{corrupt\n");
        scenario.reload();
        assert.throws(
          () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
          (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
        );
        assert.deepEqual(fs.readFileSync(location.flowStateFile), stateBytesBefore);
      });
    }
  });

  it("rejects a source writer racing checkpoint capture and publishes no authority", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const product = path.join(scenario.executionRoot, "product.js");
    const manager = scenario.manager;
    const racingManager = new Proxy(manager, {
      get(target, property) {
        if (property === "publishSourceHandoffCheckpoint") {
          return (input) => {
            fs.appendFileSync(product, "// concurrent writer\n");
            return target.publishSourceHandoffCheckpoint(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = { ...scenario.context(), flowManager: racingManager };
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });

    assert.throws(
      () => coordinator.createRequest({
        ctx, state: manager.loadReadOnly(scenario.specId), invocation: scenario.invocation("implement"),
      }),
      (error) => error?.code === "CURRENT_FLOW_STATE_CONFLICT",
    );
    assert.equal(manager.artifactCatalog(scenario.specId).artifacts.some(
      (entry) => entry.logicalKey === "source.handoff.checkpoint",
    ), false);
    assert.equal(manager.canonicalState(scenario.specId).current.at(-1), "implement");
  });

  it("rejects source drift after checkpoint read-back and before worker start", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      fs.appendFileSync(path.join(scenario.executionRoot, "product.js"), "// raced before spawn\n");

      assert.throws(
        () => coordinator.startSourceWorker({ ctx, request, invocation }),
        (error) => error instanceof WorkerArtifactHandoffError
          && new Set(["FLOW_SOURCE_HANDOFF_MANIFEST_STALE", "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"]).has(error.code),
      );
      assert.equal(scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event.kind, "prepared");
    });
  });

  it("rejects a control note between start-intent and launch", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const ctx = scenario.context();
    const invocation = scenario.invocation("implement");
    let launches = 0;
    let request;
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const append = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
      scenario.manager.appendSourceHandoffEvent = (input) => {
        const appended = append(input);
        if (input.event.kind === "start-intent") {
          scenario.manager.addNote(new BroadModeLedgerEntry({
            step: "implement",
            reason: "This control note changes later task-scope admission.",
            ts: NOW,
          }).toActivityText());
        }
        return appended;
      };
      assert.throws(
        () => {
          coordinator.startSourceWorker({ ctx, request, invocation });
          launches += 1;
        },
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID",
      );
    });
    assert.equal(launches, 0, "worker launch remains after the admission boundary");
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).event.kind, "start-intent");
    const stateBeforeRecovery = scenario.manager.canonicalState(scenario.specId).toJSON();
    scenario.reload();
    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_START_UNCERTAIN",
    );
    assert.deepEqual(scenario.manager.canonicalState(scenario.specId).toJSON(), stateBeforeRecovery);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("allows an appended metric between start-intent and launch", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const ctx = scenario.context();
    const invocation = scenario.invocation("implement");
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const append = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
      scenario.manager.appendSourceHandoffEvent = (input) => {
        const appended = append(input);
        if (input.event.kind === "start-intent") {
          scenario.manager.appendMetric({ phase: "impl", counter: "docsRead", delta: 1 });
        }
        return appended;
      };
      coordinator.startSourceWorker({ ctx, request, invocation });
      assert.equal(scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event.kind, "start-intent");
      assert.equal(scenario.manager.activityLedger(scenario.specId).at(-1).transition.operation, "record_metric");
    });
  });

  it("allows an ordinary note between start-intent and launch", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const ctx = scenario.context();
    const invocation = scenario.invocation("implement");
    const note = "The source worker may continue after this annotation.";
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const append = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
      scenario.manager.appendSourceHandoffEvent = (input) => {
        const appended = append(input);
        if (input.event.kind === "start-intent") scenario.manager.addNote(note);
        return appended;
      };
      coordinator.startSourceWorker({ ctx, request, invocation });
      assert.equal(scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event.kind, "start-intent");
      assert.ok(scenario.manager.load(scenario.specId).notes.some((entry) => entry.text === note));
    });
  });

  it("rejects a retry decision metric between start-intent and launch", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const ctx = scenario.context();
    const invocation = scenario.invocation("implement");
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const append = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
      scenario.manager.appendSourceHandoffEvent = (input) => {
        const appended = append(input);
        if (input.event.kind === "start-intent") {
          scenario.manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { taskId: null });
        }
        return appended;
      };
      assert.throws(
        () => coordinator.startSourceWorker({ ctx, request, invocation }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID",
      );
      assert.equal(scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event.kind, "start-intent");
    });
  });

  it("rejects checkpoint descriptor and producer Activity binding tampering", async (t) => {
    for (const field of ["hash", "activityId"]) {
      await t.test(field, () => {
        const scenario = new SourceCheckpointScenario(t, "implement");
        const request = scenario.stageSealed("implement");
        const location = scenario.manager.specLocation(scenario.specId);
        const stateBefore = fs.readFileSync(location.flowStateFile);
        const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
        const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === "source.handoff.checkpoint");
        descriptor[field] = field === "hash" ? "0".repeat(64) : crypto.randomUUID();
        const tamperedCatalog = new FlowArtifactCatalog({ artifacts: catalog.artifacts });
        fs.writeFileSync(location.catalogFile, `${JSON.stringify(tamperedCatalog.toJSON(), null, 2)}\n`);
        scenario.reload();

        assert.throws(
          () => new WorkerArtifactHandoffCoordinator().recoverPending({
            ctx: {
              root: scenario.executionRoot, executionRoot: scenario.executionRoot,
              mainRoot: scenario.mainRoot, specId: scenario.specId, flowManager: scenario.manager,
            },
          }),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
        );
        assert.deepEqual(fs.readFileSync(location.flowStateFile), stateBefore);
        assert.equal(fs.existsSync(request.directory), true);
      });
    }
  });

  it("rejects a changed canonical Activity prefix without advancing source state", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = scenario.stageSealed("implement");
    const location = scenario.manager.specLocation(scenario.specId);
    const before = fs.readFileSync(location.activitiesFile, "utf8");
    const changed = before.replace(/"confirmationOrder":(\d+)/, (_match, order) => `"confirmationOrder":${Number(order) + 100}`);
    assert.notEqual(changed, before);
    fs.writeFileSync(location.activitiesFile, changed);
    scenario.reload();

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({
        ctx: {
          root: scenario.executionRoot, executionRoot: scenario.executionRoot,
          mainRoot: scenario.mainRoot, specId: scenario.specId, flowManager: scenario.manager,
        },
      }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
    );
    assert.equal(fs.existsSync(request.directory), true);
  });

  it("settles a prepared request as aborted-before-start after a parent restart", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const invocation = scenario.invocation("implement");
    const request = withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => (
      coordinator.createRequest({
        ctx: scenario.context(), state: scenario.manager.loadReadOnly(scenario.specId), invocation,
      })
    ));
    const sourceBefore = fs.readFileSync(path.join(scenario.executionRoot, "product.js"), "utf8");
    scenario.reload();

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

    assert.equal(recovered?.completed, true);
    assert.equal(fs.existsSync(request.directory), false);
    assert.equal(fs.readFileSync(path.join(scenario.executionRoot, "product.js"), "utf8"), sourceBefore);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement.kind, "aborted-before-start");
  });

  it("stops with typed uncertainty after start-intent when worker exit is unknown", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const invocation = scenario.invocation("implement");
    const request = withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const staged = coordinator.createRequest({
        ctx: scenario.context(), state: scenario.manager.loadReadOnly(scenario.specId), invocation,
      });
      coordinator.startSourceWorker({ ctx: scenario.context(), request: staged, invocation });
      return staged;
    });
    const stateBefore = scenario.manager.canonicalState(scenario.specId).toJSON();
    scenario.reload();

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_START_UNCERTAIN",
    );
    assert.deepEqual(scenario.manager.canonicalState(scenario.specId).toJSON(), stateBefore);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
    assert.equal(fs.existsSync(request.directory), true);
  });

  it("keeps temporary source handoff enumeration retryable", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    scenario.manager.sourceHandoffAuthorities = () => {
      throw Object.assign(new Error("temporary catalog read busy"), { code: "EAGAIN" });
    };

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNAVAILABLE"
        && error.retryable === true,
    );
  });

  it("keeps a temporary coherent capture retryable without changing canonical state", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const location = scenario.manager.specLocation(scenario.specId);
    const stateBefore = fs.readFileSync(location.flowStateFile);
    scenario.manager.readCanonicalTransitionView = () => {
      throw Object.assign(new Error("temporary catalog read busy"), { code: "EAGAIN" });
    };

    assert.throws(
      () => SourceWorkerCanonicalObservationAdvance.capture({
        flowManager: scenario.manager, specId: scenario.specId,
      }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNAVAILABLE"
        && error.retryable === true,
    );
    assert.deepEqual(fs.readFileSync(location.flowStateFile), stateBefore);
  });

  it("rejects a start-intent whose request digest does not bind the persisted request", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const prepared = scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event;
      scenario.manager.appendSourceHandoffEvent({
        specId: scenario.specId,
        event: new SourceHandoffEvent({
          identity: request.sourceHandoffIdentity,
          checkpointDigest: request.sourceHandoffCheckpoint.digest,
          sequence: prepared.sequence + 1,
          previousDigest: prepared.digest,
          kind: "start-intent",
          requestDigest: "f".repeat(64),
        }),
      });
      return request;
    });
    scenario.reload();

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
    );
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("rejects skipped and duplicate source event transitions and premature acceptance", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      const prepared = scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event;
      const skipped = new SourceHandoffEvent({
        identity: request.sourceHandoffIdentity,
        checkpointDigest: request.sourceHandoffCheckpoint.digest,
        sequence: prepared.sequence + 1,
        previousDigest: prepared.digest,
        kind: "worker-exited",
        requestDigest: request.requestDigest,
        sourceManifest: SourceMutationManifest.capture({ baseline: request.sourceMutationBaseline }),
        workerStopped: true,
      });
      assert.throws(
        () => scenario.manager.appendSourceHandoffEvent({ specId: scenario.specId, event: skipped }),
        /event transition/,
      );
      coordinator.startSourceWorker({ ctx, request, invocation });
      assert.throws(
        () => coordinator.startSourceWorker({ ctx, request, invocation }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
      );
      const started = scenario.manager.readSourceHandoffAuthority({
        specId: scenario.specId, identity: request.sourceHandoffIdentity,
      }).event;
      const premature = new SourceHandoffSettlement({
        identity: request.sourceHandoffIdentity,
        checkpointDigest: request.sourceHandoffCheckpoint.digest,
        eventDigest: started.digest,
        handoffDigest: "a".repeat(64),
        kind: "accepted",
      });
      assert.throws(
        () => scenario.manager.settleSourceHandoff({ specId: scenario.specId, settlement: premature }),
        /standalone source handoff settlement.*non-acceptance/,
      );
    });
  });

  it("rejects a request binding change without settling or advancing the source Step", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = scenario.stageSealed("implement");
    const document = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
    document.actionDigest = "f".repeat(64);
    fs.writeFileSync(request.requestPath, `${JSON.stringify(document, null, 2)}\n`);
    const nodeBefore = scenario.manager.canonicalState(scenario.specId).current.at(-1);
    scenario.reload();

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
    );
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), nodeBefore);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("rejects every persisted source identity dimension after restart", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = scenario.stageSealed("implement");
    const original = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
    const mutations = [
      ["run", (value) => { value.runId = "foreign-run"; }],
      ["spec", (value) => { value.specId = "foreign-spec"; }],
      ["step", (value) => { value.stepId = "impl-repair"; }],
      ["task", (value) => { value.taskId = "foreign-task"; }],
      ["baseline digest", (value) => { value.sourceMutationBaselineDigest = "0".repeat(64); }],
      ["checkpoint digest", (value) => { value.sourceHandoffCheckpointDigest = "0".repeat(64); }],
      ["invocation", (value) => { value.dispatchInvocationId = "foreign-invocation"; }],
      ["Action", (value) => { value.actionDigest = "1".repeat(64); }],
      ["input", (value) => { value.inputDigest = "2".repeat(64); }],
      ["node", (value) => { value.sourceHandoffIdentity.nodeId = "impl-repair"; }],
      ["policy revision", (value) => { value.sourceHandoffIdentity.policyRevision = "3".repeat(64); }],
      ["canonical generation", (value) => { value.sourceHandoffIdentity.canonicalGeneration = "4".repeat(64); }],
      ["Flow identity", (value) => { value.sourceHandoffIdentity.flowIdentity.runId = "foreign-run"; }],
    ];
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      fs.writeFileSync(request.requestPath, `${JSON.stringify(changed, null, 2)}\n`);
      scenario.reload();
      assert.throws(
        () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED",
        label,
      );
    }
    fs.writeFileSync(request.requestPath, `${JSON.stringify(original, null, 2)}\n`);
    scenario.reload();
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), "implement");
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("rejects source drift after sealing without publishing the worker result", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = scenario.stageSealed("implement");
    fs.appendFileSync(path.join(scenario.executionRoot, "product.js"), "// foreign drift\n");
    const nodeBefore = scenario.manager.canonicalState(scenario.specId).current.at(-1);
    scenario.reload();

    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && new Set(["FLOW_SOURCE_HANDOFF_MANIFEST_STALE", "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED"]).has(error.code),
    );
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), nodeBefore);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("rejects a source writer racing fingerprint validation and acceptance settlement", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const request = scenario.stageSealed("implement");
    const product = path.join(scenario.executionRoot, "product.js");
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const authority = coordinator.sourceMutationAuthority({ ctx: scenario.context(), request });
    const racingManager = new Proxy(scenario.manager, {
      get(target, property) {
        if (property === "confirmSourceWorkerHandoff") {
          return (input) => {
            fs.appendFileSync(product, "// concurrent settlement writer\n");
            return target.confirmSourceWorkerHandoff(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.throws(
      () => coordinator.reconcile({
        ctx: { ...scenario.context(), flowManager: racingManager }, request, mutationAuthority: authority,
      }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED"
        && error.cause?.code === "FLOW_SOURCE_HANDOFF_MANIFEST_STALE",
    );
    assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), "implement");
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement, null);
    assert.match(fs.readFileSync(product, "utf8"), /concurrent settlement writer/);
  });

  it("accepts a post-seal chmod that preserves Git-visible executable authority", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const sourcePath = path.join(scenario.executionRoot, "product.js");
    const request = withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      const staged = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      coordinator.startSourceWorker({ ctx, request: staged, invocation });
      fs.chmodSync(sourcePath, 0o755);
      materializeSourceWorkerEffect({ request: staged, responseText: JSON.stringify(sourceEffect("implement")) });
      sealParentMaterializedSourceWorkerEffect({ request: staged });
      coordinator.finishSourceWorker({ ctx, request: staged });
      return staged;
    });
    fs.chmodSync(sourcePath, 0o700);
    scenario.reload();

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

    assert.equal(recovered?.completed, true);
    assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o700);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement.kind, "accepted");
  });

  it("resumes rollback settlement after restart and preserves every pre-worker source shape", async (t) => {
    const { SourceHandoffFailureFacts } = await import("../../../src/flow/lib/source-handoff-failure.js");
    const { resolveSourceHandoffTransitionPlan } = await import("../../../src/flow/definition.js");
    const scenario = new SourceCheckpointScenario(t, "implement");
    const product = path.join(scenario.executionRoot, "product.js");
    const deleted = path.join(scenario.executionRoot, "deleted.js");
    const executable = path.join(scenario.executionRoot, "script.sh");
    const link = path.join(scenario.executionRoot, "current-link");
    const untracked = path.join(scenario.executionRoot, "notes.txt");
    fs.writeFileSync(deleted, "tracked before deletion\n");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.symlinkSync("product.js", link);
    commitAll(scenario.executionRoot, "rollback source shapes");
    fs.writeFileSync(product, "user dirty content\n");
    fs.unlinkSync(deleted);
    fs.chmodSync(executable, 0o755);
    fs.unlinkSync(link);
    fs.symlinkSync("notes.txt", link);
    fs.writeFileSync(untracked, "user untracked content\n");

    let request;
    let plan;
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      coordinator.startSourceWorker({ ctx, request, invocation });
      fs.writeFileSync(product, "worker replacement\n");
      fs.writeFileSync(deleted, "worker recreated deletion\n");
      fs.chmodSync(executable, 0o700);
      fs.unlinkSync(link);
      fs.symlinkSync("script.sh", link);
      fs.writeFileSync(untracked, "worker changed inherited untracked\n");
      fs.writeFileSync(path.join(scenario.executionRoot, "worker-only.js"), "worker only\n");
      coordinator.finishSourceWorker({ ctx, request });
      const error = new WorkerArtifactHandoffError(
        "invalid", "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", "worker result is rejected", { retryable: false },
      );
      const facts = SourceHandoffFailureFacts.fromError(error, {
        request, ownershipProven: true, workerStopped: true,
      });
      plan = resolveSourceHandoffTransitionPlan({ facts, policy: request.policy });
      coordinator.recordSourceFailure({ ctx, request, plan });
      const settle = scenario.manager.settleSourceHandoff.bind(scenario.manager);
      scenario.manager.settleSourceHandoff = () => { throw new Error("simulated settlement crash"); };
      assert.throws(
        () => coordinator.rollbackRejectedSourceHandoff({
          ctx, request, mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }), plan,
        }),
        (failure) => failure instanceof WorkerArtifactHandoffError
          && failure.code === "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED",
      );
      scenario.manager.settleSourceHandoff = settle;
    });
    assert.equal(fs.readFileSync(product, "utf8"), "user dirty content\n");
    assert.equal(fs.existsSync(deleted), false);
    // Git represents only the executable bit. The worker's 0755 -> 0700
    // chmod is therefore outside source mutation and rollback authority.
    assert.equal(fs.statSync(executable).mode & 0o777, 0o700);
    assert.equal(fs.readlinkSync(link), "notes.txt");
    assert.equal(fs.readFileSync(untracked, "utf8"), "user untracked content\n");
    assert.equal(fs.existsSync(path.join(scenario.executionRoot, "worker-only.js")), false);
    scenario.reload();

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

    assert.equal(recovered?.completed, true);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement.kind, "rolled-back");
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  });

  it("resumes a partial rollback with an empty before-image and refuses a third source state", async (t) => {
    const { SourceHandoffFailureFacts } = await import("../../../src/flow/lib/source-handoff-failure.js");
    const { resolveSourceHandoffTransitionPlan } = await import("../../../src/flow/definition.js");

    const interruptRollback = (scenario, restoreOnePath) => {
      const emptyPath = path.join(scenario.executionRoot, "empty.txt");
      const secondPath = path.join(scenario.executionRoot, "second.txt");
      fs.writeFileSync(emptyPath, "committed nonempty content\n");
      fs.writeFileSync(secondPath, "before second\n");
      commitAll(scenario.executionRoot, "partial rollback baseline");
      fs.writeFileSync(emptyPath, Buffer.alloc(0));
      let request;
      withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
        const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
        const ctx = scenario.context();
        const invocation = scenario.invocation("implement");
        request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
        coordinator.startSourceWorker({ ctx, request, invocation });
        fs.writeFileSync(emptyPath, "worker filled empty file\n");
        fs.writeFileSync(secondPath, "worker second\n");
        coordinator.finishSourceWorker({ ctx, request });
        const failure = new WorkerArtifactHandoffError(
          "invalid", "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", "worker result is rejected", { retryable: false },
        );
        const facts = SourceHandoffFailureFacts.fromError(failure, {
          request, ownershipProven: true, workerStopped: true,
        });
        const plan = resolveSourceHandoffTransitionPlan({ facts, policy: request.policy });
        coordinator.recordSourceFailure({ ctx, request, plan });
        const mutationAuthority = coordinator.sourceMutationAuthority({ ctx, request });
        coordinator.sourceMutationAuthority = () => ({
          rollbackRejectedSourceMutation() {
            restoreOnePath?.({ emptyPath, secondPath });
            throw new Error("simulated crash midway through source restore");
          },
        });
        assert.throws(
          () => coordinator.rollbackRejectedSourceHandoff({ ctx, request, mutationAuthority, plan }),
          /simulated crash midway/,
        );
      });
      return { request, emptyPath, secondPath };
    };

    const resumable = new SourceCheckpointScenario(t, "implement");
    const first = interruptRollback(resumable, ({ emptyPath }) => fs.writeFileSync(emptyPath, Buffer.alloc(0)));
    resumable.reload();
    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: resumable.context() });
    assert.equal(recovered?.completed, true);
    assert.equal(fs.readFileSync(first.emptyPath).length, 0, "the persisted zero-byte before-image survives rehydration");
    assert.equal(fs.readFileSync(first.secondPath, "utf8"), "before second\n");
    assert.equal(resumable.manager.readSourceHandoffAuthority({
      specId: resumable.specId, identity: first.request.sourceHandoffIdentity,
    }).settlement.kind, "rolled-back");
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: resumable.context() }), null);

    const ambiguous = new SourceCheckpointScenario(t, "implement", { worktree: true });
    const second = interruptRollback(ambiguous);
    fs.writeFileSync(second.secondPath, "unattributed third state\n");
    ambiguous.reload();
    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: ambiguous.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED",
    );
    assert.equal(fs.readFileSync(second.emptyPath, "utf8"), "worker filled empty file\n");
    assert.equal(fs.readFileSync(second.secondPath, "utf8"), "unattributed third state\n");
    assert.equal(ambiguous.manager.readSourceHandoffAuthority({
      specId: ambiguous.specId, identity: second.request.sourceHandoffIdentity,
    }).settlement, null);
  });

  it("recovers a durable Task failure event before its terminal preserve transaction", async (t) => {
    const { SourceHandoffFailureFacts } = await import("../../../src/flow/lib/source-handoff-failure.js");
    const { resolveSourceHandoffTransitionPlan } = await import("../../../src/flow/definition.js");
    const scenario = new TaskReviewScenario(t);
    container.reset();
    container.register("root", scenario.root);
    t.after(() => container.reset());
    const reviewed = await scenario.publishReview([taskFinding()]);
    assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
    const sourceBefore = fs.readFileSync(scenario.sourcePath);
    let request;
    {
      const work = scenario.stageHandoff("triage");
      request = work.request;
      try {
        work.coordinator.finishSourceWorker({ ctx: work.ctx, request });
        const failure = new WorkerArtifactHandoffError(
          "invalid", "TASK_TRIAGE_SEMANTIC_FAILURE", "triage response was semantically invalid",
          { retryable: true, data: { failureKind: "semantic" } },
        );
        const facts = SourceHandoffFailureFacts.fromError(failure, {
          request, ownershipProven: true, workerStopped: true,
        });
        const plan = resolveSourceHandoffTransitionPlan({ facts, policy: request.policy });
        assert.equal(plan.disposition, "preserve");
        work.coordinator.recordSourceFailure({ ctx: work.ctx, request, plan });
      } finally {
        work.release();
      }
    }
    scenario.reload();

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

    assert.equal(recovered?.completed, true);
    assert.equal(scenario.state().attempt.failure.category, "semantic");
    assert.deepEqual(fs.readFileSync(scenario.sourcePath), sourceBefore);
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement.kind, "quarantined");
    const activityCount = scenario.manager.activityLedger(scenario.specId).length;
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
    assert.equal(scenario.manager.activityLedger(scenario.specId).length, activityCount);
  });

  it("recovers a durable authority failure before its terminal quarantine transaction", async (t) => {
    const { SourceHandoffFailureFacts } = await import("../../../src/flow/lib/source-handoff-failure.js");
    const { resolveSourceHandoffTransitionPlan } = await import("../../../src/flow/definition.js");
    const scenario = new SourceCheckpointScenario(t, "implement");
    let request;
    withSourceHandoffLease({ root: scenario.executionRoot, mainRoot: scenario.mainRoot }, () => {
      const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
      const ctx = scenario.context();
      const invocation = scenario.invocation("implement");
      request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
      coordinator.startSourceWorker({ ctx, request, invocation });
      coordinator.finishSourceWorker({ ctx, request });
      const failure = new WorkerArtifactHandoffError(
        "invalid", "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION",
        "canonical authority changed before source settlement", { retryable: false },
      );
      const facts = SourceHandoffFailureFacts.fromError(failure, {
        request, ownershipProven: true, workerStopped: true,
      });
      const plan = resolveSourceHandoffTransitionPlan({ facts, policy: request.policy });
      assert.equal(plan.disposition, "quarantine");
      coordinator.recordSourceFailure({ ctx, request, plan });
    });
    scenario.reload();

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() });

    assert.equal(recovered?.completed, true);
    assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.failure.category, "source-integrity");
    assert.equal(scenario.manager.readSourceHandoffAuthority({
      specId: scenario.specId, identity: request.sourceHandoffIdentity,
    }).settlement.kind, "quarantined");
    const once = protocolCounts(scenario.manager, scenario.specId);
    assert.deepEqual(
      new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
      { completed: true, replayed: true, cleanedHandoffs: 1 },
    );
    assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), once);
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }), null);
  });
});
