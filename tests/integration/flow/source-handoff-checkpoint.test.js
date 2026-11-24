import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  WorkerArtifactMutationAuthoritySnapshot,
  SourceWorkerHandoffIdentity,
  SourceHandoffEvent,
  CanonicalSourceHandoffCheckpoint,
  SourceMutationBaseline,
  SourceHandoffSettlement,
  SourceRollbackOperationReceipt,
  SourceMutationManifest,
  SourceWorkerCanonicalObservationAdvance,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { FileIdentity } from "../../../src/lib/file-identity.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { ProcessExecutionEvent } from "../../../src/lib/process-execution-values.js";
import { CommandInvocation, NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { container } from "../../../src/lib/container.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import {
  withSourceHandoffLease,
} from "../../support/builders/source-handoff-scenario.js";
import { ImplPhaseScenario, implementationFinding } from "../../support/impl-phase-scenario.js";
import { configureManagedFixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { exitedChildAtCheckpoint, interruptChildAtCheckpoint } from "../../support/infrastructure/interrupted-child.js";
import { waitForRuntimeHostClosure } from "../../support/infrastructure/runtime-host-closure.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";

const NOW = "2026-09-09T00:00:00.000Z";
const SOURCE_POLICIES = Object.freeze([
  "implement", "impl-triage", "impl-repair",
  "task-impl", "task-repair",
]);

class ManagedImplPolicyScenario extends ImplPhaseScenario {
  initialize() {
    // Match normal setup before the producer captures Git/source authority.
    // Its Test phase must not enumerate runtime evidence as project changes.
    configureManagedFixtureRepository(this.root);
    super.initialize();
  }
}

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
      findingKey: "f1", disposition: "apply", basis: "repair-required",
      rationale: "The cataloged review requires the bounded repair.",
    }] } };
  }
  if (stepId === "impl-repair") {
    return { ...base, repair: { version: 1, findings: [{ findingKey: "f1", paths }], summary: "Applied the bounded repair.", recurrenceResolutions: [] } };
  }
  if (stepId === "task-impl") {
    return { ...base, overview: { modules: ["Task source"], data_flow: [], decisions: [] } };
  }
  if (stepId === "task-repair") {
    return { ...base, repair: { version: 1, findings: [{ findingKey: "task-F1", paths }], summary: "Applied the Task repair.", recurrenceResolutions: [] } };
  }
  return base;
}

class SourceCheckpointScenario {
  constructor(t, stepId, { worktree = false, issue = null, producer = null, retainUntilVerified = false } = {}) {
    if (producer !== null) {
      this.executionRoot = producer.root;
      this.mainRoot = producer.root;
      this.specId = producer.specId;
      this.worktree = false;
      this.reload();
      return;
    }
    this.temporaryRoot = createTmpDir(`source-checkpoint-${stepId}-`);
    t.after(() => {
      if (retainUntilVerified && this.verified !== true) {
        testTemporaryRoot().retainOnUnconfirmedExecution();
        return;
      }
      return removeQuiescentRuntimeFixture({ mainRoot: this.mainRoot, executionRoot: this.executionRoot,
        cleanup: () => removeTmpDir(this.temporaryRoot) });
    });
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
    if (stepId === "task-impl") {
      this.flow.settleBefore("T1-impl");
      this.flow.activateTask("T1", { settlePredecessors: false });
    } else {
      this.flow.activate("implement");
    }
  }

  static async create(t, stepId, options) {
    if (!stepId.startsWith("impl-")) return new SourceCheckpointScenario(t, stepId, options);
    const producer = ManagedImplPolicyScenario.create(t, {
      implReviewResponse: (stage) => ({
        blockingFindings: stage === "impl-review" ? [implementationFinding({ key: "f1" })] : [],
        nonBlockingImprovements: [],
      }),
    });
    await producer.advanceTo(stepId);
    return new SourceCheckpointScenario(t, stepId, { producer });
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
    assert.notEqual((await scenario.filter([])).ok, false);
    scenario.reload();
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

it("publishes and reloads a source checkpoint while its real Git observations remain bound to the Attempt", async (t) => {
  const scenario = new SourceCheckpointScenario(t, "implement");
  const ctx = scenario.context();
  await withFlowProcessRuntime(ctx, () => withSourceHandoffLease({ root: scenario.executionRoot,
    mainRoot: scenario.mainRoot }, () => {
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    const invocation = scenario.invocation("implement");
    const request = coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId), invocation });
    assert.ok(request.sourceHandoffCheckpoint);
    const saved = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId,
      identity: request.sourceHandoffIdentity });
    assert.equal(saved.checkpoint.digest, request.sourceHandoffCheckpoint.digest);
    assert.equal(saved.event.kind, "prepared");
    assert.equal(saved.settlement, null);
    scenario.reload();
    const restored = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId,
      identity: request.sourceHandoffIdentity });
    assert.equal(restored.checkpoint.digest, saved.checkpoint.digest);
    assert.equal(restored.event.digest, saved.event.digest);
    const facts = scenario.manager.activityLedger(scenario.specId).filter((activity) => activity.processEvent);
    assert.ok(facts.length > 0, "real Git observations must be persisted with their source Attempt");
    assert.ok(facts.every((activity) => activity.processEvent.binding.attemptId === request.sourceHandoffIdentity.attempt.id));
  }), { required: true });
});

it("recovers a committed source checkpoint after its canonical process acknowledgement is lost", async (t) => {
  const scenario = new SourceCheckpointScenario(t, "implement");
  const ctx = scenario.context();
  const sourceBefore = fs.readFileSync(path.join(scenario.executionRoot, "product.js"));
  const interruption = new Error("source checkpoint process event saved before acknowledgement");
  let identity, checkpointDigest, savedBytes, failedEvent, executionId;
  await withFlowProcessRuntime(ctx, async () => {
    const runtime = ProcessExecutionRuntime.current();
    executionId = runtime.executionId;
    const writer = new FlowProcessEventWriter(scenario.manager);
    const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) });
    await assert.rejects(runtime.withBinding(runtime.binding, () => withSourceHandoffLease({
      root: scenario.executionRoot, mainRoot: scenario.mainRoot,
    }, () => coordinator.createRequest({ ctx, state: scenario.manager.loadReadOnly(scenario.specId),
      invocation: scenario.invocation("implement") })), {
      eventWriter: (event) => {
        const acknowledgement = writer.write(event);
        if (failedEvent === undefined) {
          failedEvent = event;
          throw interruption;
        }
        return acknowledgement;
      },
    }), (error) => error === interruption);
    scenario.reload();
    const authorities = scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId });
    assert.equal(authorities.length, 1, "the checkpoint committed before publication reported failure");
    const authority = authorities[0];
    identity = authority.identity;
    checkpointDigest = authority.checkpoint.digest;
    assert.equal(authority.event.kind, "prepared");
    assert.equal(authority.settlement, null);
    const descriptors = authority.descriptors.filter((entry) => ["source.handoff.checkpoint", "execution.contract"].includes(entry.logicalKey));
    assert.ok(descriptors.some((entry) => entry.logicalKey === "execution.contract"));
    const location = scenario.manager.specLocation(scenario.specId);
    savedBytes = new Map(descriptors.map((entry) => [location.resolve(entry.relativePath), fs.readFileSync(location.resolve(entry.relativePath))]));
    const pending = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
    assert.ok(pending.events.length > 0);
    assert.ok(pending.calls.every((call) => {
      const invocation = CommandInvocation.fromStored(call.invocation.actualCommand);
      return call.receipt !== null && invocation instanceof NativeExecutableInvocation
        && ["git", "git.exe"].includes(path.basename(invocation.executable).toLowerCase())
        && call.invocation.kind === "command" && call.invocation.providerAttemptId === null;
    }),
      "preparation completed only registered Git calls and launched no provider");
    assert.deepEqual(pending.eventAcknowledgements, []);
    assert.deepEqual(pending.runtimeOnlyDispositions, []);
    const first = scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.processEvent?.executionId === executionId);
    assert.equal(first.length, 1);
    assert.equal(first[0].processEvent.eventId, failedEvent.eventId);
    assert.equal(ProcessExecutionEvent.fromStored(first[0].processEvent).digest, failedEvent.digest);
    const restoredWriter = new FlowProcessEventWriter(scenario.manager);
    runtime.drainEventsSync((event) => restoredWriter.write(event));
    const published = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
    assert.deepEqual(published.events, pending.events);
    assert.deepEqual(published.calls, pending.calls, "event replay cannot reserve or execute a duplicate call");
    assert.deepEqual(published.eventAcknowledgements, pending.events.map((stored) => {
      const event = ProcessExecutionEvent.fromStored(stored);
      return { eventId: event.eventId, eventDigest: event.digest };
    }));
    const facts = scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.processEvent?.executionId === executionId);
    assert.deepEqual(facts.map((entry) => entry.processEvent), pending.events);
    assert.equal(new Set(facts.map((entry) => entry.id)).size, pending.events.length);
    for (const [file, bytes] of savedBytes) assert.deepEqual(fs.readFileSync(file), bytes,
      "event replay preserves checkpoint identity and execution contract budget bytes");
    assert.deepEqual(runtime.drainEventsSync((event) => restoredWriter.write(event)), []);
  }, { required: true });
  const closed = ProcessExecutionRuntime.inspect({ mainRoot: scenario.mainRoot, executionRoot: scenario.executionRoot })
    .executions.find((entry) => entry.executionId === executionId);
  assert.equal(closed.status, "closed");
  scenario.reload();
  const recovery = new WorkerArtifactHandoffCoordinator();
  assert.equal(recovery.recoverPending({ ctx: scenario.context() })?.completed, true);
  const recovered = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId, identity });
  assert.equal(recovered.checkpoint.digest, checkpointDigest);
  assert.equal(recovered.settlement.kind, "aborted-before-start");
  const once = protocolCounts(scenario.manager, scenario.specId);
  assert.equal(once.checkpoint, 1);
  assert.equal(once.settlement, 1);
  assert.equal(recovery.recoverPending({ ctx: scenario.context() }), null);
  assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), once);
  assert.deepEqual(fs.readFileSync(path.join(scenario.executionRoot, "product.js")), sourceBefore);
  for (const [file, bytes] of savedBytes) assert.deepEqual(fs.readFileSync(file), bytes);
});

it("preserves sealed Source evidence and refuses an abandoned handoff token after a real parent stop", async (t) => {
  const scenario = new SourceCheckpointScenario(t, "implement", { retainUntilVerified: true });
  const moduleUrl = (relativePath) => pathToFileURL(path.join(process.cwd(), relativePath)).href;
  const child = `
    import fs from "node:fs";
    import path from "node:path";
    import { FlowManager } from ${JSON.stringify(moduleUrl("src/lib/flow-manager.js"))};
    import RunDispatchCommand from ${JSON.stringify(moduleUrl("src/flow/lib/run-dispatch.js"))};
    import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(moduleUrl("src/flow/lib/worker-artifact-handoff.js"))};
    import { sourceWorkerEffectJsonSchema } from ${JSON.stringify(moduleUrl("src/flow/lib/source-worker-effect-schema.js"))};
    import { withScenarioProviderAdmission } from ${JSON.stringify(moduleUrl("tests/support/infrastructure/flow-dispatch-scenario.js"))};
    import { ProcessExecutionRuntime } from ${JSON.stringify(moduleUrl("src/lib/process-execution-runtime.js"))};
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
      reconcile() {
        const runtime = ProcessExecutionRuntime.current();
        process.once("message", () => process.exit(86));
        process.send({ executionId: runtime.executionId, ownerLock: runtime.store.ownerLock.lockPath });
        return new Promise(() => {});
      }
    }
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return action; } },
      agent: withScenarioProviderAdmission({ async call() {
        fs.writeFileSync(path.join(root, "process-worker.js"), "// sealed before parent stop\\n");
        return JSON.stringify({ version: 1, stepId: "implement", completionStatus: "done", issues: [], overview: null, triage: null, repair: null, noChangeReason: null });
      } }),
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
  const host = spawn(process.execPath, ["--import", SENNEL_BOOTSTRAP, "--input-type=module", "--eval", child], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      FFCA_EXECUTION_ROOT: scenario.executionRoot,
      FFCA_MAIN_ROOT: scenario.mainRoot,
      FFCA_SPEC_ID: scenario.specId,
    },
  });
  let stderr = "";
  host.stderr.on("data", chunk => { stderr += chunk; });
  const terminal = once(host, "exit");
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) { host.kill(); await terminal; }
  });
  const published = await Promise.race([
    once(host, "message").then(([message]) => message),
    terminal.then(() => assert.fail(`Parent exited before source sealing: ${stderr}`)),
  ]);
  scenario.reload();

  const runtimeRoots = { mainRoot: scenario.mainRoot, executionRoot: scenario.executionRoot };
  const live = ProcessExecutionRuntime.inspect(runtimeRoots);
  const occupied = published.executionId;
  assert.equal(live.slot, occupied);
  const active = live.executions.find(execution => execution.executionId === occupied);
  assert.equal(active.status, "active");
  assert.ok(active.calls.length > 0, "source preparation must retain real registered Git calls");
  assert.ok(active.calls.every(call => call.receipt !== null));
  const beforeAdmission = scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON();
  const location = scenario.manager.specLocation(scenario.specId);
  const authorities = scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId });
  assert.equal(authorities.length, 1);
  assert.equal(authorities[0].settlement, null);
  const savedBytes = new Map(authorities[0].descriptors.map(entry => {
    const file = location.resolve(entry.relativePath);
    return [file, fs.readFileSync(file)];
  }));
  const workerFile = path.join(scenario.executionRoot, "process-worker.js");
  const sourceBytes = fs.readFileSync(workerFile);
  const handoffLock = FlowHandoffAuthorityLease.pathFor(runtimeRoots);
  const lockBytes = fs.readFileSync(handoffLock);
  const lockIdentity = FileIdentity.capture(fs.lstatSync(handoffLock, { bigint: true }));
  assert.throws(() => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
  assert.deepEqual(scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON(), beforeAdmission,
    "an active coordinator must refuse canonical recovery");
  const closure = waitForRuntimeHostClosure({ ...runtimeRoots,
    executionId: occupied, ownerLock: published.ownerLock });
  host.send("stop-after-sealing");
  const [[exitCode], released] = await Promise.all([terminal, closure]);
  assert.equal(exitCode, 86, stderr);
  const stopped = released.executions.find(execution => execution.executionId === occupied);
  assert.equal(stopped.status, "closed");
  assert.equal(stopped.closure.recovery, true);
  assert.deepEqual(stopped.calls, active.calls, "host loss cannot invent or repeat a child call");
  assert.deepEqual(scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON(), beforeAdmission,
    "receipt-confirmed runtime closure must not settle the source Step");
  const state = scenario.manager.loadReadOnly(scenario.specId);
  const ctx = { ...scenario.context(), flowState: state, expectRunId: state.runId,
    expectSpec: scenario.specId, expectNoIssue: true };
  // Runtime closure proves its own coordinator release. The separately minted
  // handoff token has no release receipt; process exit cannot grant reclamation.
  let recoveryExecutionId;
  await assert.rejects(withFlowProcessRuntime(ctx,
    () => {
      recoveryExecutionId = ProcessExecutionRuntime.current().executionId;
      return new WorkerArtifactHandoffCoordinator().recoverPending({ ctx });
    },
    { commandId: "dispatch", required: true }), { code: "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT" });
  const closed = ProcessExecutionRuntime.inspect(runtimeRoots);
  assert.equal(closed.slot, null);
  assert.equal(closed.executions.find((execution) => execution.executionId === occupied).status, "closed");

  assert.deepEqual(fs.readFileSync(handoffLock), lockBytes);
  assert.equal(lockIdentity.equals(FileIdentity.capture(fs.lstatSync(handoffLock, { bigint: true }))), true);
  assert.deepEqual(fs.readFileSync(workerFile), sourceBytes);
  for (const [file, bytes] of savedBytes) assert.deepEqual(fs.readFileSync(file), bytes);
  scenario.reload();
  assert.deepEqual(scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON(), beforeAdmission);
  assert.equal(scenario.manager.sourceHandoffAuthorities({ specId: scenario.specId })[0].settlement, null);
  assert.notEqual(scenario.manager.canonicalState(scenario.specId).findNode("implement").status, "done");
  const recoveryExecution = closed.executions.find(execution => execution.executionId === recoveryExecutionId);
  assert.ok(recoveryExecution);
  assert.equal(recoveryExecution.status, "closed");
  assert.equal(recoveryExecution.calls.length, 0, "refusal cannot restart a provider or repeat a Git call");
  scenario.verified = true;
});

describe("durable source handoff checkpoints", () => {
  for (const boundary of ["materializing", "sealing"]) {
    it(`preserves the exact control failure while ${boundary} a parent Source effect`, (t) => {
      const scenario = new SourceCheckpointScenario(t, "implement", { retainUntilVerified: true });
      withSourceHandoffLease({ root: scenario.executionRoot }, () => {
        const coordinator = new WorkerArtifactHandoffCoordinator();
        const invocation = scenario.invocation("implement");
        const request = coordinator.createRequest({
          ctx: scenario.context(), state: scenario.manager.loadReadOnly(scenario.specId), invocation,
        });
        coordinator.startSourceWorker({ ctx: scenario.context(), request, invocation });
        coordinator.finishSourceWorker({ ctx: scenario.context(), request });
        const responseText = JSON.stringify(sourceEffect("implement"));
        if (boundary === "sealing") materializeSourceWorkerEffect({ request, responseText });
        const before = scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON();
        const counts = protocolCounts(scenario.manager, scenario.specId);
        const sourcePath = path.join(scenario.executionRoot, "product.js");
        const bytes = fs.readFileSync(sourcePath);
        const identity = FileIdentity.capture(fs.lstatSync(sourcePath, { bigint: true }));
        const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "Parent Source observation completion is unknown");
        const execution = t.mock.method(GitCommandExecution, "runTogether", () => { throw failure; });
        try {
          assert.throws(() => boundary === "materializing"
            ? materializeSourceWorkerEffect({ request, responseText })
            : sealParentMaterializedSourceWorkerEffect({ request }), (error) => error === failure);
          assert.equal(execution.mock.callCount(), 1);
        } finally {
          execution.mock.restore();
        }
        assert.equal(fs.existsSync(request.submissionPath), false);
        assert.deepEqual(fs.readFileSync(sourcePath), bytes);
        assert.equal(identity.equals(FileIdentity.capture(fs.lstatSync(sourcePath, { bigint: true }))), true);
        scenario.reload();
        assert.deepEqual(scenario.manager.readCanonicalTransitionSnapshot(scenario.specId).toJSON(), before);
        assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), counts);
        const authority = scenario.manager.readSourceHandoffAuthority({
          specId: scenario.specId, identity: request.sourceHandoffIdentity,
        });
        assert.equal(authority.event.kind, "worker-exited");
        assert.equal(authority.settlement, null);
        scenario.verified = true;
      });
    });
  }

  it("preserves the exact control failure while capturing Source checkpoint authority", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const invocation = scenario.invocation("implement");
    const request = withSourceHandoffLease({ root: scenario.executionRoot }, () => coordinator.createRequest({
      ctx: scenario.context(), state: scenario.manager.loadReadOnly(scenario.specId), invocation,
    }));
    const before = protocolCounts(scenario.manager, scenario.specId);
    const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "Checkpoint mailbox completion is unknown");
    const execution = t.mock.method(GitCommandExecution, "runTogether", () => { throw failure; });
    assert.throws(() => WorkerArtifactMutationAuthoritySnapshot.capture(request), (error) => error === failure);
    assert.equal(execution.mock.callCount(), 1);
    assert.deepEqual(protocolCounts(scenario.manager, scenario.specId), before);
    assert.equal(fs.readFileSync(path.join(scenario.executionRoot, "product.js"), "utf8"), "export const value = 1;\n");
  });

  it("recovers every source policy from a fresh disk-backed manager exactly once", async (t) => {
    for (const stepId of SOURCE_POLICIES) {
      await t.test(stepId, async (subtest) => {
        const taskReviewStage = stepId === "task-repair";
        const staged = taskReviewStage
          ? await taskReviewPolicyScenario(subtest, stepId)
          : await (async () => {
              const scenario = await SourceCheckpointScenario.create(subtest, stepId);
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

  it("recovers source acceptance across the canonical catalog commit point after a released-owner publication failure", async (t) => {
    for (const boundary of ["before-json-rename", "before-json-readback"]) {
      await t.test(boundary, async () => {
        const scenario = new SourceCheckpointScenario(t, "implement");
        const request = scenario.stageSealed("implement");
        const checkpoint = `catalog-interruption-${crypto.randomUUID()}`;
        const ready = `source-recovery-ready-${crypto.randomUUID()}`;
        const child = `
          import { FlowManager } from ${JSON.stringify(moduleUrlFor("src/lib/flow-manager.js"))};
          import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(moduleUrlFor("src/flow/lib/worker-artifact-handoff.js"))};
          import fs from "node:fs";
          let sourcePublication = false;
          const root = process.env.FFCA_EXECUTION_ROOT;
          const mainRoot = process.env.FFCA_MAIN_ROOT;
          const specId = process.env.FFCA_SPEC_ID;
          const catalogFile = process.env.FFCA_CATALOG_FILE;
          const manager = new FlowManager({
            root, mainRoot, inWorktree: false,
            versionStoreFaultInjector: ({ phase, filePath }) => {
              if (sourcePublication && phase === ${JSON.stringify(boundary)} && filePath === catalogFile) {
                fs.writeSync(1, process.env.FFCA_CHECKPOINT);
                throw Object.assign(new Error(process.env.FFCA_CHECKPOINT), { code: "EIO" });
              }
            },
          });
          const commit = manager.commitSpecStepResult;
          manager.commitSpecStepResult = function (...args) {
            sourcePublication = args[0].sourceHandoffSettlement?.kind === "accepted";
            try { return Reflect.apply(commit, this, args); }
            finally { sourcePublication = false; }
          };
          fs.writeSync(1, process.env.FFCA_READY + String.fromCharCode(10));
          const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({
            ctx: { root, executionRoot: root, mainRoot, specId, flowManager: manager },
          });
          fs.writeSync(1, String.fromCharCode(10) + "recovered:" + JSON.stringify(recovered));
        `;
        const exited = await exitedChildAtCheckpoint(process.execPath, ["--import", SENNEL_BOOTSTRAP, "--input-type=module", "--eval", child], {
          cwd: process.cwd(), checkpoint: ready,
          env: {
            ...process.env,
            FFCA_EXECUTION_ROOT: scenario.executionRoot,
            FFCA_MAIN_ROOT: scenario.mainRoot,
            FFCA_SPEC_ID: scenario.specId,
            FFCA_CATALOG_FILE: scenario.manager.specLocation(scenario.specId).catalogFile,
            FFCA_CHECKPOINT: checkpoint,
            FFCA_READY: ready,
          },
        });
        assert.ok(exited.stdout.includes(checkpoint), "the actual catalog fault boundary must be reached");
        assert.equal(exited.exitCode, boundary === "before-json-rename" ? 1 : 0, exited.stderr || exited.stdout);
        assert.equal(exited.signal, null);
        if (boundary === "before-json-readback") {
          assert.deepEqual(JSON.parse(exited.stdout.split("\nrecovered:")[1]),
            { completed: true, replayed: true, cleanedHandoffs: 1 });
        }
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
          assert.equal(cleanup, null, "the exact committed receipt lets the original child finish cleanup");
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

  it("rejects a same-byte source generation replaced before checkpoint publication without changing canonical state", (t) => {
    const scenario = new SourceCheckpointScenario(t, "implement");
    const product = path.join(scenario.executionRoot, "product.js");
    const location = scenario.manager.specLocation(scenario.specId);
    let captured = null;
    const canonicalBytes = () => ({ flow: fs.readFileSync(location.flowStateFile).toString("base64"),
      catalog: fs.readFileSync(location.catalogFile).toString("base64"), activities: JSON.stringify(scenario.manager.activityLedger(scenario.specId)) });
    const racingManager = new Proxy(scenario.manager, {
      get(target, property) {
        if (property === "publishSourceHandoffCheckpoint") return (input) => {
          captured = canonicalBytes();
          const replacement = path.join(scenario.executionRoot, "replacement-generation.js");
          fs.writeFileSync(replacement, fs.readFileSync(product)); fs.renameSync(replacement, product);
          return target.publishSourceHandoffCheckpoint(input);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.throws(() => new WorkerArtifactHandoffCoordinator({ now: () => new Date(NOW) }).createRequest({
      ctx: { ...scenario.context(), flowManager: racingManager }, state: scenario.manager.loadReadOnly(scenario.specId), invocation: scenario.invocation("implement"),
    }), (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE");
    assert.notEqual(captured, null);
    assert.deepEqual(canonicalBytes(), captured);
    assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts.some((entry) => entry.logicalKey === "source.handoff.checkpoint"), false);
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

  it("rejects a non-metric canonical writer between start-intent and launch", (t) => {
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
          scenario.manager.addNote("canonical writer racing source worker launch");
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
        if (property === "commitSpecStepResult") {
          return (input) => {
            if (input.stepResult.kind === "implement-applied") {
              fs.appendFileSync(product, "// concurrent settlement writer\n");
            }
            return target.commitSpecStepResult(input);
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
    execFileSync("git", ["config", "core.symlinks", "false"], { cwd: scenario.executionRoot });
    fs.writeFileSync(link, "product.js");
    const linkOid = execFileSync("git", ["hash-object", "-w", "current-link"], { cwd: scenario.executionRoot, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", "120000", linkOid, "current-link"], { cwd: scenario.executionRoot });
    commitAll(scenario.executionRoot, "rollback source shapes");
    fs.writeFileSync(product, "user dirty content\n");
    fs.unlinkSync(deleted);
    fs.chmodSync(executable, 0o755);
    fs.unlinkSync(link);
    fs.writeFileSync(link, "notes.txt");
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
      fs.writeFileSync(link, "script.sh");
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
    assert.equal(fs.readFileSync(link, "utf8"), "notes.txt");
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
    try {
    const { SourceHandoffFailureFacts } = await import("../../../src/flow/lib/source-handoff-failure.js");
    const { resolveSourceHandoffTransitionPlan } = await import("../../../src/flow/definition.js");

    const interruptRollback = (scenario) => {
      const emptyPath = path.join(scenario.executionRoot, "empty.txt");
      const secondPath = path.join(scenario.executionRoot, "second.txt");
      const unchangedPath = path.join(scenario.executionRoot, "unchanged.txt");
      fs.writeFileSync(unchangedPath, "same worker bytes\n");
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
        const storedCheckpoint = request.sourceHandoffCheckpoint.toJSON();
        const checkpointOptions = { root: scenario.executionRoot, canonicalLocation: scenario.manager.specLocation(scenario.specId) };
        assert.throws(() => CanonicalSourceHandoffCheckpoint.fromStored({ ...storedCheckpoint, digest: null }, checkpointOptions), /digest is required/);
        assert.throws(() => CanonicalSourceHandoffCheckpoint.fromStored({ ...storedCheckpoint, producer: null }, checkpointOptions), /noncanonical fields/);
        assert.throws(() => CanonicalSourceHandoffCheckpoint.fromStored({ ...storedCheckpoint,
          identity: { ...storedCheckpoint.identity, extra: true } }, checkpointOptions), /noncanonical fields/);
        assert.throws(() => SourceMutationBaseline.fromStored({ ...storedCheckpoint.baseline,
          attempt: { ...storedCheckpoint.baseline.attempt, extra: true } }, { root: scenario.executionRoot }), /noncanonical fields/);
        const prepared = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId, identity: request.sourceHandoffIdentity }).event.toJSON();
        assert.throws(() => SourceHandoffEvent.fromStored({ ...prepared, digest: null }), /digest is required/);
        assert.throws(() => SourceHandoffEvent.fromStored({ ...prepared, identity: { ...prepared.identity, extra: true } }), /noncanonical fields/);
        coordinator.startSourceWorker({ ctx, request, invocation });
        fs.writeFileSync(emptyPath, "worker filled empty file\n");
        fs.writeFileSync(secondPath, "worker second\n");
        const rewritten = path.join(scenario.executionRoot, "rewritten.txt");
        fs.writeFileSync(rewritten, "same worker bytes\n"); fs.renameSync(rewritten, unchangedPath);
        const executionEnvironment = request.executionEnvironment();
        assert.equal(executionEnvironment.GIT_OPTIONAL_LOCKS, "0");
        const indexPath = path.resolve(scenario.executionRoot, execFileSync("git", ["rev-parse", "--git-path", "index"],
          { cwd: scenario.executionRoot, encoding: "utf8" }).trim());
        const indexBytes = fs.readFileSync(indexPath); const indexGeneration = fs.lstatSync(indexPath, { bigint: true }).ino;
        execFileSync("git", ["status", "--porcelain=v2"], { cwd: scenario.executionRoot,
          env: { ...process.env, ...executionEnvironment }, encoding: "utf8" });
        assert.deepEqual(fs.readFileSync(indexPath), indexBytes, "ordinary inherited worker status preserves the exact user index");
        assert.equal(fs.lstatSync(indexPath, { bigint: true }).ino, indexGeneration);

        const appendStopped = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
        let rejectedWrongBaseline = false;
        scenario.manager.appendSourceHandoffEvent = (input) => {
          if (input.event.kind === "worker-exited") {
            const before = JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
              activities: scenario.manager.activityLedger(scenario.specId) });
            const sourceManifest = new SourceMutationManifest({ attempt: input.event.sourceManifest.attempt,
              baselineDigest: "0".repeat(64), mutations: input.event.sourceManifest.mutations, observations: input.event.sourceManifest.observations });
            const event = new SourceHandoffEvent({ ...input.event.unsignedJSON(), sourceManifest });
            assert.throws(() => appendStopped({ ...input, event }), (error) => error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_BINDING_INVALID");
            assert.equal(JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
              activities: scenario.manager.activityLedger(scenario.specId) }), before);
            rejectedWrongBaseline = true;
          }
          return appendStopped(input);
        };
        try { coordinator.finishSourceWorker({ ctx, request }); }
        finally { scenario.manager.appendSourceHandoffEvent = appendStopped; }
        assert.equal(rejectedWrongBaseline, true);
        const stopped = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId, identity: request.sourceHandoffIdentity }).event.sourceManifest;
        assert.equal(stopped.paths().includes("unchanged.txt"), false);
        assert.equal(stopped.observations.find((entry) => entry.path === "unchanged.txt").working.generation
          .equals(request.sourceMutationBaseline.snapshot.entries.find((entry) => entry.path === "unchanged.txt").working.generation), false);
        const failure = new WorkerArtifactHandoffError(
          "invalid", "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", "worker result is rejected", { retryable: false },
        );
        const facts = SourceHandoffFailureFacts.fromError(failure, {
          request, ownershipProven: true, workerStopped: true,
        });
        const plan = resolveSourceHandoffTransitionPlan({ facts, policy: request.policy });
        coordinator.recordSourceFailure({ ctx, request, plan });
        const mutationAuthority = coordinator.sourceMutationAuthority({ ctx, request });
        const append = scenario.manager.appendSourceHandoffEvent.bind(scenario.manager);
        let validatedMalformedProgress = false;
        scenario.manager.appendSourceHandoffEvent = (input) => {
          const event = input.event;
          if (event.kind === "rollback-progress" && event.rollbackOperation.phase === "prepared" && !validatedMalformedProgress) {
            validatedMalformedProgress = true;
            const before = JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
              activities: scenario.manager.activityLedger(scenario.specId) });
            const changedBefore = event.rollbackOperation.before.toJSON();
            changedBefore.generation = { dev: "99999", ino: "99999" };
            const candidates = [
              new SourceHandoffEvent({ ...event.unsignedJSON(), rollbackOperation: event.rollbackOperation.published() }),
              new SourceHandoffEvent({ ...event.unsignedJSON(), rollbackPlanDigest: "0".repeat(64) }),
              new SourceHandoffEvent({ ...event.unsignedJSON(), rollbackOperation: new SourceRollbackOperationReceipt({
                ...event.rollbackOperation.unsignedJSON(), path: "unowned-source.txt", workingPath: "unowned-source.txt" }) }),
              new SourceHandoffEvent({ ...event.unsignedJSON(), rollbackOperation: new SourceRollbackOperationReceipt({
                ...event.rollbackOperation.unsignedJSON(), before: changedBefore }) }),
              new SourceHandoffEvent({ ...event.unsignedJSON(), rollbackOperation: new SourceRollbackOperationReceipt({
                ...event.rollbackOperation.unsignedJSON(), workingPath: event.rollbackOperation.path.toUpperCase() }) }),
            ];
            for (const candidate of candidates) {
              assert.throws(() => append({ ...input, event: candidate }), /source rollback progress is invalid/);
              assert.equal(JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
                activities: scenario.manager.activityLedger(scenario.specId) }), before);
            }
          }
          return append(input);
        };
        const rename = fs.renameSync;
        fs.renameSync = (source, target) => {
          if (target === secondPath) throw new Error("simulated crash midway through source restore");
          return rename(source, target);
        };
        try {
          assert.throws(
            () => coordinator.rollbackRejectedSourceHandoff({ ctx, request, mutationAuthority, plan }),
            /simulated crash midway/,
          );
        } finally { fs.renameSync = rename; scenario.manager.appendSourceHandoffEvent = append; }
        assert.equal(validatedMalformedProgress, true);
        const authority = scenario.manager.readSourceHandoffAuthority({ specId: scenario.specId, identity: request.sourceHandoffIdentity });
        assert.equal(authority.event.kind, "rollback-progress");
        assert.equal(authority.event.rollbackOperation.phase, "prepared");
        assert.equal(authority.events.some((event) => event.rollbackOperation?.path === "empty.txt"
          && event.rollbackOperation.phase === "published"), true);
        const beforeSettlement = JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
          activities: scenario.manager.activityLedger(scenario.specId) });
        const premature = new SourceHandoffSettlement({ identity: request.sourceHandoffIdentity,
          checkpointDigest: request.sourceHandoffCheckpoint.digest, eventDigest: authority.event.digest, kind: "rolled-back" });
        assert.throws(() => scenario.manager.settleSourceHandoff({ specId: scenario.specId,
          settlement: premature, expectedAttempt: request.sourceMutationBaseline.attempt }), /source rollback progress is invalid/);
        assert.equal(JSON.stringify({ catalog: scenario.manager.artifactCatalog(scenario.specId).hash,
          activities: scenario.manager.activityLedger(scenario.specId) }), beforeSettlement);
      });
      return { request, emptyPath, secondPath, unchangedPath, unchangedGeneration: fs.lstatSync(unchangedPath, { bigint: true }).ino };
    };

    const resumable = new SourceCheckpointScenario(t, "implement");
    const first = interruptRollback(resumable);
    resumable.reload();
    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: resumable.context() });
    assert.equal(recovered?.completed, true);
    assert.equal(fs.readFileSync(first.emptyPath).length, 0, "the persisted zero-byte before-image survives rehydration");
    assert.equal(fs.readFileSync(first.secondPath, "utf8"), "before second\n");
    assert.equal(fs.lstatSync(first.unchangedPath, { bigint: true }).ino, first.unchangedGeneration, "same-byte worker rewrite needs no rollback publication");
    const settled = resumable.manager.readSourceHandoffAuthority({
      specId: resumable.specId, identity: first.request.sourceHandoffIdentity,
    }).settlement;
    assert.equal(settled.kind, "rolled-back");
    assert.throws(() => SourceHandoffSettlement.fromStored({ ...settled.toJSON(), digest: null }), /digest is required/);
    assert.throws(() => SourceHandoffSettlement.fromStored({ ...settled.toJSON(), identity: { ...settled.identity.toJSON(), extra: true } }), /noncanonical fields/);
    assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: resumable.context() }), null);

    const ambiguous = new SourceCheckpointScenario(t, "implement", { worktree: true });
    const second = interruptRollback(ambiguous);
    const stoppedUnchanged = path.join(ambiguous.executionRoot, ".tmp", "stopped-unchanged.txt");
    fs.renameSync(second.unchangedPath, stoppedUnchanged);
    fs.writeFileSync(second.unchangedPath, "same worker bytes\n");
    ambiguous.reload();
    assert.throws(() => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: ambiguous.context() }),
      (error) => error.code === "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED");
    assert.equal(fs.readFileSync(second.secondPath, "utf8"), "worker second\n");
    fs.unlinkSync(second.unchangedPath); fs.renameSync(stoppedUnchanged, second.unchangedPath);
    const foreign = path.join(ambiguous.executionRoot, "foreign-generation.txt");
    fs.writeFileSync(foreign, Buffer.alloc(0));
    fs.renameSync(foreign, second.emptyPath);
    ambiguous.reload();
    assert.throws(
      () => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: ambiguous.context() }),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED",
    );
    assert.equal(fs.readFileSync(second.emptyPath).length, 0, "foreign replacement keeps the same bytes but is not owned");
    assert.equal(fs.readFileSync(second.secondPath, "utf8"), "worker second\n");
    assert.equal(ambiguous.manager.readSourceHandoffAuthority({
      specId: ambiguous.specId, identity: second.request.sourceHandoffIdentity,
    }).settlement, null);
    } catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(cause); throw cause; }
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
    assert.notEqual((await scenario.filter([])).ok, false);
    scenario.reload();
    const sourceBefore = fs.readFileSync(scenario.sourcePath);
    let request;
    {
      const work = scenario.stageHandoff("repair");
      request = work.request;
      try {
        work.coordinator.finishSourceWorker({ ctx: work.ctx, request });
        const failure = new WorkerArtifactHandoffError(
          "invalid", "TASK_REPAIR_SEMANTIC_FAILURE", "repair response was semantically invalid",
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
