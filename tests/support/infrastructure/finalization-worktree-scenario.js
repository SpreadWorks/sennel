import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FinalizationPhaseScenario } from "../finalization-phase-scenario.js";
import { PrepareArtifactScenario } from "../prepare-artifact-scenario.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import SetAutoCommand from "../../../src/flow/lib/set-auto.js";
import { AtomicJsonFile } from "../../../src/lib/atomic-json-file.js";
import { FinalizeFlowStateOwner } from "../../../src/flow/lib/finalize-flow-state-owner.js";
import { WorktreeFlowBindingStore } from "../../../src/lib/worktree-flow-binding.js";
import { CurrentTaskSourceSnapshot } from "../../../src/flow/lib/task-mutation-lineage.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";

export const finalizationCleanupJournalPhases = Object.freeze([
  "prepared", "worktree-removed", "branch-deleted", "validated", "pointer-written", "completed",
]);

/** Keep the actual Prepare-created main/worktree pair. Never clone linked Git
 * metadata or rewrite canonical execution state to manufacture this boundary. */
export class FinalizationWorktreeScenario extends FinalizationPhaseScenario {
  static async prepare(t, options = {}) {
    const prepared = PrepareArtifactScenario.create(t, { mode: "worktree",
      request: "Preserve report evidence and exact managed worktree ownership through finalization." });
    fs.appendFileSync(path.join(prepared.root, ".gitignore"), "!/.sennel/output/\n");
    fs.mkdirSync(path.join(prepared.root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(prepared.root, "docs", "overview.md"), "Tracked documentation before finalization.\n");
    prepared.git(["add", ".gitignore", "docs/overview.md"]);
    prepared.git(["commit", "-m", "Seed tracked finalization inputs"]);
    // The real worktree pre-sync fetches origin. Its entire Git peer is an
    // owned local directory, so production fetch/rebase need no network fake.
    const origin = path.join(prepared.root, ".tmp", "origin.git");
    prepared.git(["init", "--bare", origin]);
    prepared.git(["remote", "add", "origin", origin]);
    prepared.git(["push", "origin", "main"]);
    await prepared.initialize();
    const ready = await prepared.prepare();
    assert.equal(ready.result, "ok", JSON.stringify(ready));
    prepared.reload();
    const scenario = this.create(t, { ...options, prepared, autoApprove: false });
    assert.notEqual(scenario.root, prepared.root);
    assert.equal(scenario.state().execution.mode, "worktree");
    assert.equal(scenario.manager.usesWorktreeFlowBinding(), true);
    scenario.binding = new WorktreeFlowBindingStore({ worktreePath: scenario.worktreePath }).load();
    scenario.binding.assertFlowState(scenario.manager.loadReadOnly(scenario.specId));
    await scenario.advanceTo("approval");
    const awaiting = await scenario.dispatch(8);
    assert.equal(awaiting.dispatch?.boundary, "approval_required", JSON.stringify(awaiting));
    scenario.reload();
    await scenario.approve();
    scenario.reload();
    const auto = await new SetAutoCommand().execute({ ...scenario.context(), value: "on" });
    assert.equal(auto.autoApprove, true, JSON.stringify(auto));
    await scenario.advanceTo("finalize-commit");
    scenario.reload();
    return scenario;
  }

  constructor(options) {
    super(options);
    assert.ok(options.prepared instanceof PrepareArtifactScenario,
      "worktree scenarios require the actual Prepare producer");
    this.mainRoot = options.prepared.root;
    this.worktreePath = options.prepared.executionRoot;
  }

  reload({ versionStoreFaultInjector = null } = {}) {
    this.manager = new FlowManager({ root: this.root, mainRoot: this.mainRoot,
      inWorktree: this.root !== this.mainRoot, specId: this.specId, versionStoreFaultInjector });
    return this;
  }

  context() {
    return { root: this.root, mainRoot: this.mainRoot,
      executionRoot: fs.existsSync(this.worktreePath) ? this.worktreePath : this.mainRoot,
      specId: this.specId, flowManager: this.manager,
      flowState: this.manager.loadReadOnly(this.specId), config: this.options.config };
  }

  /** Explicitly acquire the existing production authority after real merge.
   * The test selects a checkout; the owner API selects its canonical writer. */
  acquireMainAuthority() {
    const owner = FinalizeFlowStateOwner.forMainRepository({
      sourceFlowManager: this.manager, mainRepoPath: this.mainRoot, specId: this.specId,
    });
    this.root = owner.authorityRoot;
    this.manager = owner.flowManager;
    assert.equal(this.manager.executionRoot(), this.mainRoot);
    return owner;
  }

  journalPath() { return this.manager.specLocation(this.specId).artifact("finalize.cleanup.journal"); }
  journal() { return new AtomicJsonFile(this.journalPath()).read(null); }
}

/** Read-only diagnosis of the actual source acquisition before and after Gate.
 * The producer/prerequisite contract records authority, content and lineage;
 * the real source reader remains the sole implementation. */
export class FinalizationWorktreeSourceObserver {
  #mock;
  constructor(t) {
    this.captures = [];
    const captures = this.captures;
    const capture = CurrentTaskSourceSnapshot.capture;
    this.#mock = t.mock.method(CurrentTaskSourceSnapshot, "capture", function (input) {
      const value = capture.call(this, input);
      captures.push({ root: input.root, source: value.toJSON(), acquisition: new Error().stack });
      return value;
    });
    t.after(() => this.restore());
  }
  restore() { this.#mock?.mock.restore(); this.#mock = null; }
}

/** Delegates every write unchanged, then optionally loses one response after
 * the real durable journal checkpoint. This models readback, not an OS crash. */
export class FinalizationWorktreeDurabilityObserver {
  #mocks = [];
  #unsubscribe;
  constructor(t, scenario, { interruptAfter = null } = {}) {
    assert.ok(interruptAfter === null || finalizationCleanupJournalPhases.includes(interruptAfter));
    this.phases = [];
    this.writersAfterRemoval = [];
    this.typedSavesAfterRemoval = new Set();
    this.interruption = new Error(`Lost cleanup journal response after ${interruptAfter}`);
    this.interrupted = false;
    const journalPath = scenario.journalPath();
    const originalWrite = AtomicJsonFile.prototype.write;
    const observer = this;
    this.#unsubscribe = scenario.publicationObserver.subscribe((observation) => {
      if (observation.stepId === "finalize-cleanup" && !fs.existsSync(scenario.worktreePath)) {
        this.typedSavesAfterRemoval.add(observation);
      }
    });
    this.#mocks.push(t.mock.method(AtomicJsonFile.prototype, "write", function (value) {
      const result = originalWrite.call(this, value);
      if (this.filePath !== journalPath) return result;
      const actual = new AtomicJsonFile(journalPath).read(null);
      assert.deepEqual(actual, value, "observe the actual saved journal bytes after the real write");
      observer.phases.push(actual);
      if (!observer.interrupted && actual.phase === interruptAfter) {
        observer.interrupted = true;
        throw observer.interruption;
      }
      return result;
    }));
    for (const operation of ["updateStepStatus", "completeOutbox", "finalizeFlow", "removeActiveFlow", "clearFlowState"]) {
      const original = FlowManager.prototype[operation];
      this.#mocks.push(t.mock.method(FlowManager.prototype, operation, function (...args) {
        if (!fs.existsSync(scenario.worktreePath)) {
          observer.writersAfterRemoval.push({ operation, authorityRoot: this.executionRoot() });
        }
        return original.apply(this, args);
      }));
    }
    t.after(() => this.restore());
  }

  restore() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const wrapped of this.#mocks.splice(0).reverse()) wrapped.mock.restore();
  }

  assertMainWriters(scenario) {
    scenario.reload();
    for (const writer of this.writersAfterRemoval) assert.equal(writer.authorityRoot, scenario.mainRoot,
      `${writer.operation} after worktree removal must use the real main authority`);
    assert.equal(fs.existsSync(scenario.worktreePath), false, "a completion writer must not recreate the removed worktree");
    assert.equal(path.dirname(scenario.journalPath()).startsWith(scenario.mainRoot + path.sep), true);
    const saved = scenario.manager.readCurrentStepSettlement({
      specId: scenario.specId, stepId: "finalize-cleanup", completed: true,
    });
    assert.ok(saved?.result instanceof StepResult,
      "FINALIZATION_WORKTREE_TYPED_SAVE_MISSING: cleanup requires its real terminal typed Result, not only a legacy main writer");
    assert.equal(saved.result.kind, "finalize-cleanup-completed");
    const activity = scenario.manager.activityLedger(scenario.specId).find((entry) =>
      entry.result?.draftSettlementReceipt?.id === saved.receipt.id);
    assert.ok(activity, "cleanup typed save must own its actual canonical Activity");
    const captured = [...this.typedSavesAfterRemoval].filter((observation) => observation.matches(activity, saved.result));
    assert.ok(captured.length > 0,
      "FINALIZATION_WORKTREE_TYPED_SAVE_OWNER_MISSING: terminal cleanup must save through its actual typed Store path after physical worktree removal");
    for (const observation of captured) assert.equal(observation.authorityRoot, scenario.mainRoot);
    const authenticated = scenario.publicationObserver.authenticate(scenario.manager,
      activity, saved.result, saved.settlement, { acceptObservation: (observation) => this.typedSavesAfterRemoval.has(observation) });
    assert.equal(authenticated.authorityRoot, scenario.mainRoot,
      "the original after-removal typed save must authenticate from a fresh main manager");
    assert.equal(authenticated.receipt.id, saved.receipt.id);
  }
}
