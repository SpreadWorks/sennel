import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { getPorcelainV2Status, runGit } from "../../lib/git-helpers.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { FlowHandoffAuthorityLease } from "../../lib/flow-handoff-authority-lease.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../lib/flow-target-guard.js";
import { FlowWorkspace } from "../../lib/flow-workspace.js";
import { WorktreeFlowIdentity } from "../../lib/worktree-flow-binding.js";
import { FlowCommand } from "./base-command.js";
import { PRODUCT } from "../../lib/product.js";
import { FlowDispatchLease } from "./run-dispatch.js";
import { FlowDispatchSession, FlowDispatchTarget } from "./dispatch-invocation.js";
import { ReviewExecutionLease } from "./review-execution-lease.js";
import { FlowCommandExecutionLease } from "./flow-command-execution-lease.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "./flow-repository-runtime-artifacts.js";
import { AbortHistoryRecord, AbortHistoryStore } from "./abort-history.js";
import {
  deleteFeatureBranchForCleanup,
  removeWorktreeForCleanup,
} from "./run-finalize-cleanup.js";

const ABORT_PHASES = Object.freeze([
  "prepared",
  "worktree-removed",
  "branch-deleted",
  "active-cleared",
  "spec-removed",
]);
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class FlowAbortJournal {
  static pathFor(root, specId) {
    return path.join(root, PRODUCT.managedPath("recovery", "flow-abort", `${specId}.json`));
  }

  constructor({ root, state, worktreePath, featureSha, reason, specLocation }) {
    const directory = path.join(root, PRODUCT.managedPath("recovery", "flow-abort"));
    fs.mkdirSync(directory, { recursive: true });
    this.file = new AtomicJsonFile(FlowAbortJournal.pathFor(root, state.specId));
    this.value = this.file.read(null) || {
      version: 2,
      runId: state.runId,
      specId: state.specId,
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
      worktreePath: worktreePath || null,
      featureSha,
      phase: "prepared",
      updatedAt: new Date().toISOString(),
      requestedRecord: new AbortHistoryRecord({ schemaVersion: 1, event: "abort-requested",
        operationId: crypto.randomUUID(), runId: state.runId, specId: state.specId,
        recordedAt: new Date().toISOString(), reason,
        flowId: state.flowId, flowVersionId: state.flowVersionId,
        flowVersion: specLocation.version.value, issue: state.issue, request: state.request,
        step: state.attempt?.nodeId ?? null, execution: state.execution.toJSON(),
        versionLocation: specLocation.relativeDirectory }).toJSON(),
    };
    if (
      this.value.version !== 2
      || this.value.runId !== state.runId
      || this.value.specId !== state.specId
      || this.value.featureBranch !== state.featureBranch
      || this.value.baseBranch !== state.baseBranch
      || !ABORT_PHASES.includes(this.value.phase)
      || (
        state.featureBranch === null
          ? this.value.featureSha !== null
          : !GIT_OBJECT_ID.test(String(this.value.featureSha))
      )
    ) {
      throw new Error("flow abort journal does not match the selected flow");
    }
    const requested = new AbortHistoryRecord(this.value.requestedRecord);
    if (requested.runId !== state.runId || requested.specId !== state.specId || requested.reason !== reason) {
      throw new Error("flow abort history does not match the selected flow and reason");
    }
    this.file.write(this.value);
  }

  atLeast(phase) {
    return ABORT_PHASES.indexOf(this.value.phase) >= ABORT_PHASES.indexOf(phase);
  }

  advance(phase) {
    if (this.atLeast(phase)) return;
    if (ABORT_PHASES.indexOf(phase) !== ABORT_PHASES.indexOf(this.value.phase) + 1) {
      throw new Error(`invalid flow abort transition: ${this.value.phase} -> ${phase}`);
    }
    this.value = { ...this.value, phase, updatedAt: new Date().toISOString() };
    this.file.write(this.value);
  }

  complete(removed) {
    if (!this.value.completedRecord) {
      this.value = { ...this.value, completedRecord: {
        ...this.value.requestedRecord, event: "abort-completed",
        recordedAt: new Date().toISOString(), removed,
      } };
      this.file.write(this.value);
    }
    return new AbortHistoryRecord(this.value.completedRecord);
  }
}

/** Hold existing execution leases only while deleting this stopped target. */
class AbortExecutionGuard {
  constructor() { this.owned = []; }

  acquire({ root, state, worktreePath }) {
    try {
      if (FlowCommandExecutionLease.forRun({ mainRoot: root, runId: state.runId }).length > 0
        || ReviewExecutionLease.forRun({ mainRoot: root, runId: state.runId }).length > 0) {
        throw new Error("an execution owner remains for the selected Flow");
      }
      const executionRoot = worktreePath || root;
      if (worktreePath && !fs.existsSync(worktreePath)) {
        // A missing checkout cannot admit new work. Its old leases must still
        // be absent; never recreate a worktree binding against the main root.
        for (const file of [FlowDispatchLease.pathFor(root, state.runId),
          FlowHandoffAuthorityLease.pathFor({ mainRoot: root, executionRoot })]) {
          try { fs.lstatSync(file); }
          catch (error) { if (error.code === "ENOENT") continue; throw error; }
          throw new Error("an execution owner remains for the missing checkout");
        }
        return;
      }
      const binding = FlowTargetBinding.capture({ flowState: state, mainRoot: root,
        authorityRoot: executionRoot, worktreePath });
      const target = new FlowDispatchTarget({ binding,
        expectation: new FlowTargetExpectation({ expectRunId: state.runId, expectSpec: state.specId }) });
      const dispatch = new FlowDispatchLease(new FlowDispatchSession({ target }));
      const handoff = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot });
      const locks = [dispatch.lock, handoff.lock.processLock];
      if (state.attempt !== null) {
        locks.push(new ReviewExecutionLease({ mainRoot: root, runId: state.runId,
          nodeId: state.attempt.nodeId, attemptId: state.attempt.id }).lock);
      }
      for (const lock of locks) {
        lock.acquire({ reclaimStale: false });
        this.owned.push(lock);
      }
    } catch (cause) {
      this.release();
      const error = new Error(`abort requires a stopped Flow: ${cause.message}`, { cause });
      error.code = "ABORT_EXECUTION_BUSY";
      throw error;
    }
  }

  release() {
    const errors = [];
    for (const lock of this.owned.splice(0).reverse()) {
      try { lock.release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "abort execution lock release failed");
  }
}

function branchSha(root, branch) {
  const result = runGit(["-C", root, "rev-parse", `refs/heads/${branch}`]);
  if (!result.ok || !GIT_OBJECT_ID.test(result.stdout.trim())) {
    throw new Error(`flow abort feature branch could not be resolved: ${branch}`);
  }
  return result.stdout.trim();
}

function outsideTargetSpec(filePath, relativeSpecDirectory) {
  return filePath !== relativeSpecDirectory && !filePath.startsWith(`${relativeSpecDirectory}/`);
}

export class RunAbortCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true, recoveryTargetResolution: true });
  }

  async execute(ctx) {
    let state = ctx.flowState;
    const specLocation = ctx.specLocation || ctx.flowManager.specLocation(state.specId);
    const repositoryRoot = specLocation.repositoryRoot;
    const { worktreePath } = ctx.flowManager.resolveWorktreePaths(state);
    const ownsFeatureBranch = state.featureBranch !== null && state.featureBranch !== state.baseBranch;
    const operation = new RepositoryFlowOperationLock({ mainRoot: repositoryRoot });
    const operationOwnerToken = operation.acquire();
    const execution = new AbortExecutionGuard();
    try {
      state = ctx.flowManager.resolveFlowRecoveryTarget(new FlowTargetExpectation({
        expectRunId: state.runId, expectSpec: state.specId,
      })).state;
      if (!["active", "parked"].includes(state.lifecycleState)) {
        return Envelope.fail("run", "abort", "ABORT_FINALIZATION_CONFLICT", "Only an unfinished Flow can be aborted.");
      }
      execution.acquire({ root: repositoryRoot, state, worktreePath });
      const rootLocation = new FlowWorkspace({ repositoryRoot, executionRoot: repositoryRoot,
        specRoot: ctx.flowManager.specRoot }).forSpec(state.specId);
      const history = new AbortHistoryStore({ directory: rootLocation.root });
      history.read();
      const journal = new FlowAbortJournal({
        root: repositoryRoot,
        state,
        worktreePath,
        featureSha: fs.existsSync(FlowAbortJournal.pathFor(repositoryRoot, state.specId))
          || state.featureBranch === null
          ? null
          : branchSha(repositoryRoot, state.featureBranch),
        reason: ctx.reason ?? null, specLocation,
      });
      history.append(new AbortHistoryRecord(journal.value.requestedRecord));

      if (!journal.atLeast("worktree-removed")) {
        if (state.worktree && worktreePath && fs.existsSync(worktreePath)) {
          const worktreeManager = ctx.flowManager.forRoot(worktreePath, { specId: state.specId });
          const expectedBinding = worktreeManager.usesWorktreeFlowBinding()
            ? new WorktreeFlowIdentity({
                runId: state.runId,
                issue: state.issue ?? null,
                specId: state.specId,
                worktreePath,
              })
            : null;
          const removed = removeWorktreeForCleanup({
            mainRepoPath: repositoryRoot,
            worktreePath,
            featureBranch: state.featureBranch,
            force: ctx.force === true,
            expectedBinding,
          });
          if (!removed.ok) return removed.env;
        } else if (!state.worktree && ownsFeatureBranch) {
          const runtimeArtifacts = new FlowRepositoryRuntimeArtifactRegistry();
          const unrelatedDirty = getPorcelainV2Status(repositoryRoot).pathSet.toArray()
            .filter((filePath) => outsideTargetSpec(filePath, specLocation.relativeDirectory)
              && !runtimeArtifacts.owns(filePath)
              && filePath !== path.relative(repositoryRoot, history.file).split(path.sep).join("/"));
          if (unrelatedDirty.length > 0) {
            return Envelope.fail(
              "run",
              "abort",
              "ABORT_UNRELATED_DIRTY",
              "Non-worktree abort stopped because unrelated dirty files are present.",
              { dirtyFiles: unrelatedDirty },
            );
          }
          const switched = runGit(["-C", repositoryRoot, "switch", state.baseBranch]);
          if (!switched.ok) {
            return Envelope.fail("run", "abort", "ABORT_BASE_SWITCH_FAILED", switched.stderr || switched.stdout);
          }
        }
        journal.advance("worktree-removed");
      }

      if (!journal.atLeast("branch-deleted")) {
        if (ownsFeatureBranch) {
          const branch = runGit(["-C", repositoryRoot, "rev-parse", "--verify", `refs/heads/${state.featureBranch}`]);
          if (branch.ok) {
            const deleted = deleteFeatureBranchForCleanup({
              mainRepoPath: repositoryRoot,
              featureBranch: state.featureBranch,
              expectedSha: journal.value.featureSha,
            });
            if (!deleted.ok) return deleted.env;
          }
        }
        journal.advance("branch-deleted");
      }

      if (!journal.atLeast("active-cleared")) {
        ctx.flowManager.removeActiveFlow(state.specId, { operationOwnerToken });
        journal.advance("active-cleared");
      }

      if (!journal.atLeast("spec-removed")) {
        fs.rmSync(specLocation.directory, { recursive: true });
        if (fs.readdirSync(rootLocation.directory).length === 0) fs.rmdirSync(rootLocation.directory);
        journal.advance("spec-removed");
      }

      const result = {
        status: "aborted",
        specId: state.specId,
        removed: {
          worktree: state.worktree ? worktreePath : null,
          branch: ownsFeatureBranch ? state.featureBranch : null,
          specDir: specLocation.relativeDirectory,
        },
      };
      history.append(journal.complete(result.removed));
      journal.file.remove();
      return { ...result, log: path.relative(repositoryRoot, history.file).split(path.sep).join("/") };
    } catch (error) {
      return Envelope.fail("run", "abort", error.code || "ABORT_FAILED", error.message);
    } finally {
      try { execution.release(); } finally { operation.release(); }
    }
  }
}

export default RunAbortCommand;
