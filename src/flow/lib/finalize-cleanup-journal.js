import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { PRODUCT } from "../../lib/product.js";
import { TemporaryPaths } from "../../lib/temporary-paths.js";
import { DEFAULT_FLOW_SPEC_DIR, FlowSpecRoot, flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { runGit, GitRefObservation, GitRefProbeError } from "../../lib/git-helpers.js";
import { StepPersistenceFailure, rethrowOriginalStepPersistenceFailure } from "./definition-lifecycle-failure.js";
import { FinalizationExecutionIdentity } from "./finalization-execution-identity.js";
import { DraftStepSettlementReceipt } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { FlowOutboxStore, FlowOutboxRecoveryReceipt, finalizationOutboxIdentity } from "./flow-outbox.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { NonGateTargetBinding } from "./non-gate-transition.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function assertExactObjectKeys(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an invalid schema`);
}

class FinalizeDroppedCommit {
  constructor({ sha, subject = null }) {
    if (!GIT_OBJECT_ID.test(String(sha))) throw new Error("forced finalize dropped commit.sha is invalid");
    if (subject != null && typeof subject !== "string") throw new Error("forced finalize dropped commit.subject is invalid");
    this.sha = sha;
    this.subject = subject;
    Object.freeze(this);
  }

  static fromStored(value) {
    assertExactObjectKeys(value, ["sha", "subject"], "forced finalize dropped commit");
    return new FinalizeDroppedCommit(value);
  }

  toJSON() {
    return { sha: this.sha, subject: this.subject };
  }
}

export class FinalizeTeardownAuthorization {
  constructor({
    route,
    mergeStrategy,
    forceAuthorized,
    auditId,
    baseline,
    diverged,
    droppedCommits,
    droppedCount,
    droppedTruncated,
  }) {
    if (!new Set(["standard", "forced"]).has(route)) throw new Error("finalize authorization.route is invalid");
    if (![null, "pr", "squash"].includes(mergeStrategy)) throw new Error("finalize authorization.mergeStrategy is invalid");
    if (typeof forceAuthorized !== "boolean") throw new Error("finalize authorization.forceAuthorized is invalid");
    if (baseline != null && !GIT_OBJECT_ID.test(String(baseline))) throw new Error("finalize authorization.baseline is invalid");
    if (typeof diverged !== "boolean") throw new Error("finalize authorization.diverged is invalid");
    if (!Array.isArray(droppedCommits)) throw new Error("finalize authorization.droppedCommits is invalid");
    if (!Number.isSafeInteger(droppedCount) || droppedCount < droppedCommits.length) {
      throw new Error("finalize authorization.droppedCount is invalid");
    }
    if (typeof droppedTruncated !== "boolean") throw new Error("finalize authorization.droppedTruncated is invalid");
    if (route === "forced") {
      if (!forceAuthorized || typeof auditId !== "string" || auditId === "") {
        throw new Error("forced finalize authorization is incomplete");
      }
    } else if (forceAuthorized || auditId != null || baseline != null || diverged || droppedCount !== 0 || droppedTruncated || droppedCommits.length > 0) {
      throw new Error("standard finalize authorization contains forced provenance");
    }
    this.route = route;
    this.mergeStrategy = mergeStrategy;
    this.forceAuthorized = forceAuthorized;
    this.auditId = auditId;
    this.baseline = baseline;
    this.diverged = diverged;
    this.droppedCommits = Object.freeze(droppedCommits.map((commit) => (
      commit instanceof FinalizeDroppedCommit ? commit : new FinalizeDroppedCommit(commit)
    )));
    this.droppedCount = droppedCount;
    this.droppedTruncated = droppedTruncated;
    Object.freeze(this);
  }

  static standard(state) {
    return new FinalizeTeardownAuthorization({
      route: "standard",
      mergeStrategy: state.state?.mergeStrategy ?? null,
      forceAuthorized: false,
      auditId: null,
      baseline: null,
      diverged: false,
      droppedCommits: [],
      droppedCount: 0,
      droppedTruncated: false,
    });
  }

  static forced(state, input) {
    return new FinalizeTeardownAuthorization({
      route: "forced",
      mergeStrategy: state.state?.mergeStrategy ?? null,
      forceAuthorized: true,
      auditId: input.auditId,
      baseline: input.baseline ?? null,
      diverged: input.diverged === true,
      droppedCommits: input.droppedCommits ?? [],
      droppedCount: input.droppedCount ?? input.droppedCommits?.length ?? 0,
      droppedTruncated: input.droppedTruncated === true,
    });
  }

  static fromStored(value) {
    assertExactObjectKeys(value, [
      "route",
      "mergeStrategy",
      "forceAuthorized",
      "auditId",
      "baseline",
      "diverged",
      "droppedCommits",
      "droppedCount",
      "droppedTruncated",
    ], "finalize authorization");
    if (!Array.isArray(value.droppedCommits)) throw new Error("finalize authorization.droppedCommits is invalid");
    return new FinalizeTeardownAuthorization({
      ...value,
      droppedCommits: value.droppedCommits.map((commit) => FinalizeDroppedCommit.fromStored(commit)),
    });
  }

  toJSON() {
    return {
      route: this.route,
      mergeStrategy: this.mergeStrategy,
      forceAuthorized: this.forceAuthorized,
      auditId: this.auditId,
      baseline: this.baseline,
      diverged: this.diverged,
      droppedCommits: this.droppedCommits.map((commit) => commit.toJSON()),
      droppedCount: this.droppedCount,
      droppedTruncated: this.droppedTruncated,
    };
  }
}

export class FinalizeRescuedCommits {
  constructor({ commits, intoBranch }) {
    if (!Array.isArray(commits) || typeof intoBranch !== "string" || intoBranch === "") {
      throw new TypeError("Cleanup rescued commits require their exact target branch");
    }
    this.commits = Object.freeze(commits.map((commit) => FinalizeDroppedCommit.fromStored(commit)));
    this.intoBranch = intoBranch;
    Object.freeze(this);
  }
  toJSON() { return { commits: this.commits.map((commit) => commit.toJSON()), intoBranch: this.intoBranch }; }
  static fromStored(value) {
    assertExactObjectKeys(value, ["commits", "intoBranch"], "cleanup rescued commits");
    return new FinalizeRescuedCommits(value);
  }
}

export function pathExistsStrict(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function assertPointerReality(reportRoot, specId) {
  const pointerPath = path.join(reportRoot, PRODUCT.managedPath("last-finalized-spec"));
  let stat;
  try {
    stat = fs.lstatSync(pointerPath);
  } catch (error) {
    throw new Error(`finalize persisted pointer reality is unavailable: ${error.message}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("finalize persisted pointer reality is not one real file");
  }
  if (fs.readFileSync(pointerPath, "utf8").trim() !== specId) {
    throw new Error("finalize persisted pointer reality targets a different spec");
  }
}

export function finalizeAuditId(kind, state, details = {}) {
  return `finalize-cleanup-${crypto
    .createHash("sha256")
    .update(JSON.stringify({
      kind,
      runId: state.runId,
      specId: state.specId,
      issue: state.issue ?? null,
      ...details,
    }))
    .digest("hex")}`;
}

const SHARED_FINALIZE_CLEANUP_PHASES = Object.freeze([
  "prepared",
  "worktree-removed",
  "branch-deleted",
  "validated",
  "pointer-written",
  "completed",
]);

export class SharedFinalizeCleanupJournal {
  constructor({ file, value }) {
    this.file = file;
    this.value = value;
  }

  static open(state, { readOnly = false } = {}) {
    const location = flowStateSpecLocation(state);
    if (location === null) throw new Error("finalize cleanup spec location is unavailable");
    const journalPath = location.artifact("finalize.cleanup.journal");
    // The journal is a transient Version artifact.  A fresh Version root owns
    // `.runtime`, but not every producer-specific child directory; establish
    // this typed artifact's parent before opening its atomic authority.
    if (readOnly && !pathExistsStrict(path.dirname(journalPath))) {
      return new SharedFinalizeCleanupJournal({ file: null, value: null });
    }
    if (!readOnly) fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o755 });
    const file = new AtomicJsonFile(journalPath);
    const stored = file.read(null);
    if (stored) {
      assertExactObjectKeys(stored, [
        "version",
        "runId",
        "specId",
        "featureBranch",
        "baseBranch",
        "worktreePath",
        "featureSha",
        "baseSha",
        "executionOrigin",
        "executionReceiptId",
        "rescued",
        "authorization",
        "phase",
        "updatedAt",
      ], "shared finalize cleanup journal");
      if (
        stored.version !== 1
        || stored.runId !== state.runId
        || stored.specId !== state.specId
        || stored.featureBranch !== state.featureBranch
        || stored.baseBranch !== state.baseBranch
        || !SHARED_FINALIZE_CLEANUP_PHASES.includes(stored.phase)
        || !GIT_OBJECT_ID.test(String(stored.featureSha))
        || !GIT_OBJECT_ID.test(String(stored.baseSha))
      ) {
        throw new Error("shared finalize cleanup journal does not match the active flow");
      }
      const origin = FinalizationExecutionIdentity.fromJSON(stored.executionOrigin);
      if (origin.stepId !== "finalize-cleanup" || origin.identity.runId !== state.runId
        || origin.identity.specId !== state.specId || origin.claim === null
        || !/^[a-f0-9]{64}$/.test(stored.executionReceiptId)
        || (state.execution.mode === "direct"
          ? origin.expectedFeatureSha !== null || origin.expectedBaseSha !== stored.featureSha
          : origin.expectedFeatureSha !== stored.featureSha)) {
        throw new Error("shared finalize cleanup journal execution origin is invalid");
      }
      if (stored.rescued !== null && FinalizeRescuedCommits.fromStored(stored.rescued).intoBranch !== state.baseBranch) {
        throw new Error("Cleanup rescued commits target another base branch");
      }
      const authorization = FinalizeTeardownAuthorization.fromStored(stored.authorization);
      if (authorization.mergeStrategy !== FinalizeTeardownAuthorization.standard(state).mergeStrategy
        || authorization.route === "forced" && authorization.auditId !== finalizeAuditId("forced-orphan-drop", state, {
          baseline: authorization.baseline,
          featureBranch: state.featureBranch,
          droppedCommits: authorization.droppedCommits.map((commit) => commit.sha),
        })) {
        throw new Error("shared finalize cleanup journal authorization does not match its source audit");
      }
    }
    return new SharedFinalizeCleanupJournal({ file, value: stored });
  }

  begin({ state, worktreePath, featureSha, baseSha, authorization, execution, executionReceiptId, rescued = null }) {
    if (this.value) return this;
    if (!(execution instanceof FinalizationExecutionIdentity) || !/^[a-f0-9]{64}$/.test(executionReceiptId)) {
      throw new StepAdmissionRefusal("Cleanup journal requires its acquired original Execution receipt");
    }
    this.value = {
      version: 1,
      runId: state.runId,
      specId: state.specId,
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
      worktreePath: worktreePath || null,
      featureSha,
      baseSha,
      executionOrigin: execution.toJSON(),
      executionReceiptId,
      rescued: rescued?.toJSON() ?? null,
      authorization: authorization.toJSON(),
      phase: "prepared",
      updatedAt: new Date().toISOString(),
    };
    this.#write();
    return this;
  }

  atLeast(phase) {
    return SHARED_FINALIZE_CLEANUP_PHASES.indexOf(this.value.phase)
      >= SHARED_FINALIZE_CLEANUP_PHASES.indexOf(phase);
  }

  advance(phase) {
    if (this.atLeast(phase)) return;
    const current = SHARED_FINALIZE_CLEANUP_PHASES.indexOf(this.value.phase);
    const next = SHARED_FINALIZE_CLEANUP_PHASES.indexOf(phase);
    if (next !== current + 1) throw new Error(`invalid shared finalize cleanup transition: ${this.value.phase} -> ${phase}`);
    this.value = { ...this.value, phase, updatedAt: new Date().toISOString() };
    this.#write();
  }

  #write() {
    try { this.file.write(this.value); }
    catch (error) { rethrowOriginalStepPersistenceFailure(new StepPersistenceFailure(error)); }
  }
}

export function validateTeardown({
  worktreePath,
  mainRepoPath,
  featureBranch,
  specId,
  checkBranch = true,
  runGit: runGitFn = runGit,
}) {
  const reasons = [];
  let probeFailed = false;

  if (mainRepoPath) {
    const wtListRes = runGitFn(["-C", mainRepoPath, "worktree", "list", "--porcelain"]);
    if (!wtListRes.ok) {
      probeFailed = true;
      reasons.push(`Git worktree validation probe failed: ${wtListRes.stderr || wtListRes.stdout || "unknown"}`);
    } else if (worktreePath) {
      const absPath = path.resolve(worktreePath);
      if (wtListRes.stdout.split("\n").some((line) => line === `worktree ${absPath}`)) {
        reasons.push(`Worktree registration remains for ${absPath}`);
      }
    }

    if (worktreePath && pathExistsStrict(worktreePath)) {
      reasons.push(`Physical worktree directory remains: ${worktreePath}`);
    }

    if (checkBranch) {
      try {
        const feature = GitRefObservation.resolve({ root: mainRepoPath,
          ref: `refs/heads/${featureBranch}`, runGit: runGitFn });
        if (feature.present) reasons.push(`Feature branch remains: ${featureBranch}`);
      } catch (error) {
        if (!(error instanceof GitRefProbeError)) throw error;
        probeFailed = true;
        reasons.push(`Git branch validation probe failed: ${error.message}`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons, probeFailed };
}

/** Read-only acquired authority for resuming the existing teardown journal. */
export class FinalizeCleanupEffectPreparation {
  constructor({ owner, journal, receiptId, origin, identity }) {
    this.owner = owner;
    this.journal = journal;
    this.receiptId = receiptId;
    this.origin = origin;
    this.identity = identity;
    this.resumed = true;
    Object.freeze(this);
  }

  static acquire(ctx, { failed = false } = {}) {
    const owner = FinalizeFlowStateOwner.forMainContext(ctx);
    const state = owner.loadReadOnly();
    const journal = SharedFinalizeCleanupJournal.open(state, { readOnly: true });
    if (journal.value === null) return null;
    const saved = owner.flowManager.readCurrentStepSettlement({ specId: state.specId, stepId: "finalize-cleanup" });
    if (failed && saved?.settlement.kind !== "failure") {
      throw new StepAdmissionRefusal("Cleanup journal recovery requires its current canonical Step receipt");
    }
    const origin = FinalizationExecutionIdentity.fromJSON(journal.value.executionOrigin);
    const source = owner.flowManager.canonicalState(state.specId);
    const identity = new NonGateTargetBinding({ runId: source.runId, specId: source.specId,
      stepId: "finalize-cleanup", attempt: source.attempt });
    const preparation = new FinalizeCleanupEffectPreparation({ owner, journal, receiptId: saved?.receipt.id ?? null, origin, identity });
    preparation.assertCurrent(ctx);
    return preparation;
  }

  executionForBinding(binding) {
    const identity = new NonGateTargetBinding({ runId: binding.runId, specId: binding.specId,
      stepId: binding.stepId, attempt: binding.attempt });
    if (!isDeepStrictEqual(identity.toJSON(), this.identity.toJSON())) {
      throw new StepAdmissionRefusal("Cleanup journal execution belongs to another acquired source Attempt");
    }
    return new FinalizationExecutionIdentity({ ...this.origin.toJSON(), identity,
      journal: this.journal.value,
      mainAuthority: { mainRoot: this.owner.mainRepoPath, authorityRoot: this.owner.authorityRoot } });
  }

  assertCurrent(ctx) {
    const owner = FinalizeFlowStateOwner.forMainContext(ctx);
    const state = owner.loadReadOnly();
    const currentJournal = SharedFinalizeCleanupJournal.open(state, { readOnly: true });
    if (owner.authorityRoot !== owner.mainRepoPath || owner.mainRepoPath !== this.owner.mainRepoPath
      || !isDeepStrictEqual(currentJournal.value, this.journal.value)
      || this.origin.mainAuthority?.mainRoot !== owner.mainRepoPath) {
      throw new StepAdmissionRefusal("Cleanup journal main authority changed after acquisition");
    }
    const entry = new FlowOutboxStore(owner.flowManager, { specId: state.specId }).status(finalizationOutboxIdentity(state, "finalize-cleanup"));
    const saved = owner.flowManager.readCurrentStepSettlement({ specId: state.specId, stepId: "finalize-cleanup" });
    const source = owner.flowManager.canonicalState(state.specId);
    const currentIdentity = new NonGateTargetBinding({ runId: source.runId, specId: source.specId,
      stepId: "finalize-cleanup", attempt: source.attempt });
    if (this.receiptId !== null && saved?.receipt.id !== this.receiptId
      || this.receiptId === null && saved !== null && saved.settlement.kind !== "execution"
      || !isDeepStrictEqual(currentIdentity.toJSON(), this.identity.toJSON()) || entry === null
      || !this.origin.outboxIdentity?.equals(entry.identity)
      || this.origin.claim.attempt !== entry.attempt || this.origin.claim.idempotencyKey !== entry.idempotencyKey) {
      throw new StepAdmissionRefusal("Cleanup journal differs from its canonical outbox claim");
    }
    const expectedWorktree = state.worktree === true ? owner.flowManager.resolveWorktreePaths(state).worktreePath : null;
    if (this.journal.value.worktreePath !== expectedWorktree
      || saved?.settlement.kind === "failure" && (entry.status !== "failed"
        || entry.failure !== saved.result.error.message || entry.latestFailure?.code !== (saved.result.error.code ?? null))
      || saved?.settlement.kind === "execution" && entry.status !== "pending") {
      throw new StepAdmissionRefusal("Cleanup journal source failure or worktree binding changed");
    }
    const ledger = owner.flowManager.activityLedger(state.specId);
    const initial = ledger.find((activity) => activity.result?.draftSettlementReceipt?.id === this.journal.value.executionReceiptId);
    if (initial === undefined || initial.nodeId !== "finalize-cleanup"
      || initial.attemptId !== this.origin.identity.attempt.id || initial.sequence !== this.origin.identity.attempt.sequence) {
      throw new StepAdmissionRefusal("Cleanup journal has no exact original Execution receipt");
    }
    DraftStepSettlementReceipt.assertStored(initial.result.draftSettlementReceipt,
      { result: StepResult.fromStored("finalize-cleanup", initial.result.stepResult) });
    if (!isDeepStrictEqual(initial.result.stepResult.execution, this.origin.toJSON())) {
      throw new StepAdmissionRefusal("Cleanup journal original Execution identity changed");
    }
    if (saved === null && (entry.status !== "pending" || entry.exactRecoveryReceipt === null
      || source.current?.at(-1) !== "finalize-cleanup" || source.attempt.failure !== null
      || isDeepStrictEqual(this.identity.toJSON(), this.origin.identity.toJSON()))) {
      throw new StepAdmissionRefusal("Cleanup missing checkpoint has no pending exact recovered Attempt");
    }
    const execution = saved === null ? this.executionForBinding(currentIdentity)
      : FinalizationExecutionIdentity.fromJSON(saved.receipt.finalization.evidence.execution);
    if (!isDeepStrictEqual(execution.identity.toJSON(), this.identity.toJSON())) {
      throw new StepAdmissionRefusal("Cleanup journal checkpoint belongs to another recovered source Attempt");
    }
    const immutable = (value) => { const json = value.toJSON(); delete json.identity; delete json.journal;
      delete json.mainAuthority; return json; };
    if (!isDeepStrictEqual(immutable(execution), immutable(this.origin))) {
      throw new StepAdmissionRefusal("Cleanup journal source authority changed after its original checkpoint");
    }
    if (!isDeepStrictEqual(execution.identity.toJSON(), this.origin.identity.toJSON())) {
      const recovered = ledger.findLast((activity) => activity.transition?.operation === "reopen_outbox"
        && activity.transition.outbox?.id === entry.idempotencyKey);
      const recoveryReceipt = entry.exactRecoveryReceipt;
      const failure = ledger.findLast((activity) => activity.nodeId === "finalize-cleanup"
        && activity.attemptId === this.origin.identity.attempt.id && activity.sequence === this.origin.identity.attempt.sequence
        && activity.result?.draftSettlementReceipt?.settlementKind === "failure");
      if (recoveryReceipt === null || failure === undefined || recovered === undefined
        || recovered.transition.attempt?.id !== execution.identity.attempt.id
        || recovered.transition.attempt?.sequence !== execution.identity.attempt.sequence
        || !isDeepStrictEqual(FlowOutboxRecoveryReceipt.fromStored(recovered.transition.outbox.exactRecoveryReceipt).toJSON(), recoveryReceipt.toJSON())
        || recoveryReceipt.failure !== failure.result.stepResult.error.message
        || recoveryReceipt.attempt !== this.origin.claim.attempt) {
        throw new StepAdmissionRefusal("Cleanup journal new Attempt has no exact recovery authorization");
      }
      DraftStepSettlementReceipt.assertStored(failure.result.draftSettlementReceipt,
        { result: StepResult.fromStored("finalize-cleanup", failure.result.stepResult) });
    }
    if (this.journal.value.baseSha !== this.origin.expectedBaseSha) {
      const mergeOutcome = new FlowOutboxStore(owner.flowManager, { specId: state.specId })
        .status(finalizationOutboxIdentity(state, "finalize-merge"))?.result;
      const baseline = mergeOutcome?.mergedFromSha;
      const rescueIdentity = autoRescueIdentity({ mainRepoPath: owner.mainRepoPath,
        baseBranch: state.baseBranch, baseline, featureBranch: state.featureBranch,
        specRoot: flowStateSpecLocation(state).relativeRoot, specId: state.specId, runId: state.runId,
        allowedIssueLogId: finalizeAuditId("cherry-pick-conflict", state, { baseline, featureBranch: state.featureBranch }),
        allowFinalizeMetadata: true });
      const rescue = new AutoRescueCleanupStore(rescueIdentity, { readOnly: true }).load();
      if (rescue === null || rescue.phase !== "completed" || rescue.outcome?.ok !== true
        || rescue.expectedBaseSha !== this.origin.expectedBaseSha
        || rescue.expectedUpdatedSha !== this.journal.value.baseSha || this.journal.value.rescued === null
        || pathExistsStrict(rescue.tempWorktreePath)
        || rescue.worktreeAuthority !== null && pathExistsStrict(rescue.worktreeAuthority.gitDirPath)) {
        throw new StepAdmissionRefusal("Cleanup journal base change has no exact completed auto-rescue journal");
      }
    }
    const main = runGit(["-C", owner.mainRepoPath, "rev-parse", `refs/heads/${state.baseBranch}`]);
    const head = runGit(["-C", owner.mainRepoPath, "symbolic-ref", "-q", "HEAD"]);
    const headOid = runGit(["-C", owner.mainRepoPath, "rev-parse", "HEAD"]);
    const featureRef = `refs/heads/${state.featureBranch}`;
    let feature = null;
    if (state.execution.mode !== "direct") {
      try {
        feature = GitRefObservation.resolve({ root: owner.mainRepoPath, ref: featureRef });
      } catch (error) {
        if (!(error instanceof GitRefProbeError)) throw error;
        throw new StepAdmissionRefusal(`Cleanup journal feature ref reality is unavailable: ${error.message}`, error);
      }
    }
    if (!main.ok || main.stdout.trim() !== this.journal.value.baseSha || !head.ok
      || head.stdout.trim() !== `refs/heads/${state.baseBranch}`
      || !headOid.ok || headOid.stdout.trim() !== this.journal.value.baseSha) {
      throw new StepAdmissionRefusal("Cleanup journal base ref authority changed");
    }
    if (state.execution.mode !== "direct" && (this.journal.atLeast("branch-deleted")
      ? !feature.absent : !(feature.absent && this.journal.atLeast("worktree-removed")) && feature.oid !== this.journal.value.featureSha)) {
      throw new StepAdmissionRefusal("Cleanup journal feature ref reality changed");
    }
    if (this.journal.atLeast("worktree-removed")) {
      const reality = validateTeardown({ worktreePath: this.journal.value.worktreePath,
        mainRepoPath: owner.mainRepoPath, featureBranch: state.featureBranch, specId: state.specId,
        // The exact feature ref observation above already validates this checkpoint.
        checkBranch: false });
      if (!reality.ok) throw new StepAdmissionRefusal(`Cleanup journal teardown reality changed: ${reality.reasons.join("; ")}`);
    }
    if (this.journal.atLeast("pointer-written")) assertPointerReality(owner.mainRepoPath, state.specId);
    if (this.journal.value.authorization.route === "forced" && this.journal.atLeast("worktree-removed")) {
      const audit = owner.flowManager.readArtifact({ specId: state.specId, logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" });
      const entries = JSON.parse(audit.bytes).entries.filter((item) => item.issueLogId === this.journal.value.authorization.auditId);
      if (entries.length !== 1 || !entries[0].reason.startsWith("FORCED_ORPHAN_DROP")
        || !isDeepStrictEqual(entries[0].droppedCommits, this.journal.value.authorization.droppedCommits)
        || entries[0].droppedCount !== this.journal.value.authorization.droppedCount
        || entries[0].droppedTruncated !== this.journal.value.authorization.droppedTruncated) {
        throw new StepAdmissionRefusal("Cleanup journal lost its required exact forced audit");
      }
    }
    return this;
  }
}
const AUTO_RESCUE_CLEANUP_VERSION = 6;
const AUTO_RESCUE_CLEANUP_PHASES = new Set([
  "staged",
  "worktree-added",
  "ref-update-prepared",
  "body-failed",
  "abort-failed",
  "base-updated",
  "worktree-materialized",
  "cleanup-failed",
  "completed",
]);

function ensureRealDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory && !fs.existsSync(parent)) ensureRealDirectory(parent);
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`finalize teardown recovery authority must be a real directory: ${directory}`);
  }
}

export class AutoRescueAbortFailure {
  constructor({
    code = "CHERRY_PICK_ABORT_FAILED",
    status,
    stdout,
    stderr,
    signal,
    killed,
  }) {
    if (code !== "CHERRY_PICK_ABORT_FAILED") throw new Error("auto-rescue abort failure.code is invalid");
    if (status !== null && !Number.isInteger(status)) throw new Error("auto-rescue abort failure.status is invalid");
    if (typeof stdout !== "string" || typeof stderr !== "string") {
      throw new Error("auto-rescue abort failure output is invalid");
    }
    if (signal !== null && typeof signal !== "string") throw new Error("auto-rescue abort failure.signal is invalid");
    if (typeof killed !== "boolean") throw new Error("auto-rescue abort failure.killed is invalid");
    this.code = code;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.signal = signal;
    this.killed = killed;
    Object.freeze(this);
  }

  static fromGitResult(result) {
    return new AutoRescueAbortFailure({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      killed: result.killed,
    });
  }

  static fromStored(value) {
    assertExactObjectKeys(
      value,
      ["code", "status", "stdout", "stderr", "signal", "killed"],
      "auto-rescue abort failure",
    );
    return new AutoRescueAbortFailure(value);
  }

  toError() {
    const error = new Error(
      `cherry-pick abort failed: ${this.stderr || this.stdout || `git exited ${this.status}`}`,
    );
    error.code = this.code;
    error.gitResult = this.toJSON();
    return error;
  }

  toJSON() {
    return {
      code: this.code,
      status: this.status,
      stdout: this.stdout,
      stderr: this.stderr,
      signal: this.signal,
      killed: this.killed,
    };
  }
}

export class AutoRescueOutcome {
  constructor({ ok, code = null, conflictFiles = [], abortFailure = null }) {
    if (typeof ok !== "boolean") throw new Error("auto-rescue outcome.ok is invalid");
    if (ok && code !== null) throw new Error("successful auto-rescue outcome cannot have a code");
    if (!ok && !["MAIN_REPO_LOCKED", "CHERRY_PICK_CONFLICT"].includes(code)) {
      throw new Error("failed auto-rescue outcome.code is invalid");
    }
    if (!Array.isArray(conflictFiles) || conflictFiles.some((entry) => typeof entry !== "string")) {
      throw new Error("auto-rescue outcome.conflictFiles is invalid");
    }
    const parsedAbortFailure = abortFailure == null
      ? null
      : abortFailure instanceof AutoRescueAbortFailure
        ? abortFailure
        : AutoRescueAbortFailure.fromStored(abortFailure);
    if (parsedAbortFailure && (ok || code !== "CHERRY_PICK_CONFLICT")) {
      throw new Error("auto-rescue abort failure requires a cherry-pick conflict outcome");
    }
    this.ok = ok;
    this.code = code;
    this.conflictFiles = Object.freeze([...conflictFiles]);
    this.abortFailure = parsedAbortFailure;
    Object.freeze(this);
  }

  static success() {
    return new AutoRescueOutcome({ ok: true });
  }

  static failure(code, conflictFiles = [], abortFailure = null) {
    return new AutoRescueOutcome({ ok: false, code, conflictFiles, abortFailure });
  }

  static fromStored(value) {
    assertExactObjectKeys(value, ["ok", "code", "conflictFiles", "abortFailure"], "auto-rescue outcome");
    return new AutoRescueOutcome(value);
  }

  static fromResult(value) {
    return value.ok
      ? AutoRescueOutcome.success()
      : AutoRescueOutcome.failure(value.code, value.conflictFiles || [], value.abortFailure || null);
  }

  toJSON() {
    return {
      ok: this.ok,
      code: this.code,
      conflictFiles: [...this.conflictFiles],
      abortFailure: this.abortFailure?.toJSON() ?? null,
    };
  }
}

export class AutoRescueWorktreeAuthority {
  constructor({ worktreeDev, worktreeIno, gitDirPath, gitDirDev, gitDirIno, headSha }) {
    for (const [name, value] of Object.entries({ worktreeDev, worktreeIno, gitDirDev, gitDirIno })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`auto-rescue ${name} authority is invalid`);
    }
    if (typeof gitDirPath !== "string" || !path.isAbsolute(gitDirPath)) {
      throw new Error("auto-rescue git directory authority is invalid");
    }
    if (!GIT_OBJECT_ID.test(headSha)) throw new Error("auto-rescue worktree HEAD authority is invalid");
    this.worktreeDev = worktreeDev;
    this.worktreeIno = worktreeIno;
    this.gitDirPath = path.resolve(gitDirPath);
    this.gitDirDev = gitDirDev;
    this.gitDirIno = gitDirIno;
    this.headSha = headSha;
    Object.freeze(this);
  }

  static fromStored(value) {
    assertExactObjectKeys(
      value,
      ["worktreeDev", "worktreeIno", "gitDirPath", "gitDirDev", "gitDirIno", "headSha"],
      "auto-rescue worktree authority",
    );
    return new AutoRescueWorktreeAuthority(value);
  }

  sameGeneration(other) {
    const current = other instanceof AutoRescueWorktreeAuthority
      ? other
      : AutoRescueWorktreeAuthority.fromStored(other);
    return JSON.stringify(this.toJSON()) === JSON.stringify(current.toJSON());
  }

  toJSON() {
    return {
      worktreeDev: this.worktreeDev,
      worktreeIno: this.worktreeIno,
      gitDirPath: this.gitDirPath,
      gitDirDev: this.gitDirDev,
      gitDirIno: this.gitDirIno,
      headSha: this.headSha,
    };
  }
}

export class AutoRescueCleanupJournal {
  constructor({
    identity,
    phase,
    expectedBaseSha,
    expectedUpdatedSha = null,
    tempWorktreePath,
    worktreeAuthority = null,
    materializeBase,
    outcome,
    updatedAt,
  }) {
    assertExactObjectKeys(
      identity,
      [
        "mainRepoPath",
        "baseBranch",
        "baseline",
        "featureBranch",
        "specRoot",
        "specId",
        "runId",
        "allowedIssueLogId",
        "allowFinalizeMetadata",
      ],
      "auto-rescue cleanup identity",
    );
    if (identity.allowedIssueLogId !== null && (
      typeof identity.allowedIssueLogId !== "string" || identity.allowedIssueLogId === ""
    )) {
      throw new Error("auto-rescue issue-log allowance authority is invalid");
    }
    if (typeof identity.allowFinalizeMetadata !== "boolean") {
      throw new Error("auto-rescue finalize metadata allowance is invalid");
    }
    const specRoot = FlowSpecRoot.from(identity.specRoot).toString();
    if (!AUTO_RESCUE_CLEANUP_PHASES.has(phase)) throw new Error("auto-rescue cleanup phase is invalid");
    if (!GIT_OBJECT_ID.test(expectedBaseSha)) throw new Error("auto-rescue expected base OID is invalid");
    if (expectedUpdatedSha !== null && !GIT_OBJECT_ID.test(expectedUpdatedSha)) {
      throw new Error("auto-rescue expected updated OID is invalid");
    }
    if (typeof materializeBase !== "boolean") throw new Error("auto-rescue materialization authority is invalid");
    const parsedWorktreeAuthority = worktreeAuthority == null
      ? null
      : worktreeAuthority instanceof AutoRescueWorktreeAuthority
        ? worktreeAuthority
        : AutoRescueWorktreeAuthority.fromStored(worktreeAuthority);
    const temporaryPaths = new TemporaryPaths(identity.mainRepoPath);
    const temporaryRoot = autoRescueTemporaryDirectory(identity);
    temporaryPaths.validate(tempWorktreePath);
    const relativeTemp = path.relative(temporaryRoot, path.resolve(tempWorktreePath));
    if (
      relativeTemp === ""
      || relativeTemp.startsWith("..")
      || path.isAbsolute(relativeTemp)
      || path.dirname(path.resolve(tempWorktreePath)) !== temporaryRoot
      || !path.basename(tempWorktreePath).startsWith(PRODUCT.temporaryPrefix("rescue-tmp"))
    ) {
      throw new Error("auto-rescue temporary worktree authority is invalid");
    }
    const parsedOutcome = outcome == null
      ? null
      : outcome instanceof AutoRescueOutcome ? outcome : AutoRescueOutcome.fromStored(outcome);
    if (["staged", "worktree-added"].includes(phase) && parsedOutcome !== null) {
      throw new Error("unfinished auto-rescue cleanup journal cannot have an outcome");
    }
    if (
      !["staged", "body-failed", "cleanup-failed", "completed"].includes(phase)
      && parsedWorktreeAuthority == null
    ) {
      throw new Error("auto-rescue cleanup phase requires worktree generation authority");
    }
    if (phase === "body-failed" && parsedOutcome?.ok !== false) {
      throw new Error("body-failed auto-rescue cleanup journal needs a failed outcome");
    }
    if (phase === "abort-failed" && parsedOutcome?.abortFailure == null) {
      throw new Error("abort-failed auto-rescue cleanup journal needs an abort failure");
    }
    if (["base-updated", "worktree-materialized"].includes(phase) && parsedOutcome?.ok !== true) {
      throw new Error(`${phase} auto-rescue cleanup journal needs a successful outcome`);
    }
    if (phase === "completed" && parsedOutcome == null) {
      throw new Error("completed auto-rescue cleanup journal needs a terminal outcome");
    }
    if (phase === "ref-update-prepared" && (parsedOutcome?.ok !== true || expectedUpdatedSha == null)) {
      throw new Error("ref-update-prepared auto-rescue journal needs the successful expected OID");
    }
    if (typeof updatedAt !== "string" || updatedAt === "") throw new Error("auto-rescue cleanup timestamp is invalid");
    this.identity = Object.freeze({
      ...identity,
      mainRepoPath: path.resolve(identity.mainRepoPath),
      specRoot,
    });
    this.phase = phase;
    this.expectedBaseSha = expectedBaseSha;
    this.expectedUpdatedSha = expectedUpdatedSha;
    this.tempWorktreePath = path.resolve(tempWorktreePath);
    this.worktreeAuthority = parsedWorktreeAuthority;
    this.materializeBase = materializeBase;
    this.outcome = parsedOutcome;
    this.updatedAt = updatedAt;
  }

  static create(identity, expectedBaseSha, tempWorktreePath, materializeBase) {
    return new AutoRescueCleanupJournal({
      identity,
      phase: "staged",
      expectedBaseSha,
      expectedUpdatedSha: null,
      tempWorktreePath,
      worktreeAuthority: null,
      materializeBase,
      outcome: null,
      updatedAt: new Date().toISOString(),
    });
  }

  static fromStored(expectedIdentity, value) {
    assertExactObjectKeys(
      value,
      [
        "version", "identity", "phase", "expectedBaseSha", "expectedUpdatedSha",
        "tempWorktreePath", "worktreeAuthority", "materializeBase", "outcome", "updatedAt",
      ],
      "auto-rescue cleanup journal",
    );
    if (value.version !== AUTO_RESCUE_CLEANUP_VERSION) throw new Error("auto-rescue cleanup version is invalid");
    const journal = new AutoRescueCleanupJournal(value);
    if (JSON.stringify(journal.identity) !== JSON.stringify(expectedIdentity)) {
      throw new Error("auto-rescue cleanup journal targets a different authority");
    }
    return journal;
  }

  advance(phase, outcome = this.outcome, expectedUpdatedSha = this.expectedUpdatedSha) {
    const advanced = new AutoRescueCleanupJournal({
      identity: this.identity,
      phase,
      expectedBaseSha: this.expectedBaseSha,
      expectedUpdatedSha,
      tempWorktreePath: this.tempWorktreePath,
      worktreeAuthority: this.worktreeAuthority,
      materializeBase: this.materializeBase,
      outcome,
      updatedAt: new Date().toISOString(),
    });
    Object.assign(this, advanced);
  }

  recordWorktreeAuthority(authority) {
    this.worktreeAuthority = authority instanceof AutoRescueWorktreeAuthority
      ? authority
      : AutoRescueWorktreeAuthority.fromStored(authority);
  }

  toJSON() {
    return {
      version: AUTO_RESCUE_CLEANUP_VERSION,
      identity: this.identity,
      phase: this.phase,
      expectedBaseSha: this.expectedBaseSha,
      expectedUpdatedSha: this.expectedUpdatedSha,
      tempWorktreePath: this.tempWorktreePath,
      worktreeAuthority: this.worktreeAuthority?.toJSON() ?? null,
      materializeBase: this.materializeBase,
      outcome: this.outcome?.toJSON() ?? null,
      updatedAt: this.updatedAt,
    };
  }
}

export class AutoRescueCleanupStore {
  constructor(identity, { readOnly = false } = {}) {
    this.identity = identity;
    const token = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    this.directory = path.join(identity.mainRepoPath, ".git", "sennel", "recovery", "auto-rescue");
    if (!readOnly) ensureRealDirectory(this.directory);
    this.path = path.join(this.directory, `${token}.json`);
    this.file = readOnly && !pathExistsStrict(this.directory) ? null : new AtomicJsonFile(this.path);
  }

  load() {
    let stat;
    try {
      stat = fs.lstatSync(this.path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(this.path) !== this.path) {
      throw new Error(`auto-rescue cleanup journal must be one real non-hardlinked file: ${this.path}`);
    }
    return AutoRescueCleanupJournal.fromStored(this.identity, this.file.read(null));
  }

  write(journal) {
    this.file.write(journal.toJSON());
  }

  remove() {
    fs.unlinkSync(this.path);
    const descriptor = fs.openSync(this.directory, "r");
    let primaryError = null;
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            "auto-rescue journal removal and descriptor cleanup both failed",
            { cause: primaryError },
          );
        }
        throw cleanupError;
      }
    }
    if (primaryError) throw primaryError;
  }
}

export function autoRescueIdentity({
  mainRepoPath,
  baseBranch,
  baseline,
  featureBranch,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  specId,
  runId = null,
  allowedIssueLogId = null,
  allowFinalizeMetadata = false,
}) {
  return {
    mainRepoPath: path.resolve(mainRepoPath),
    baseBranch,
    baseline,
    featureBranch,
    specRoot: FlowSpecRoot.from(specRoot).toString(),
    specId,
    runId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  };
}

export function autoRescueTemporaryDirectory(identity) {
  const temporaryPaths = new TemporaryPaths(identity.mainRepoPath);
  return identity.runId === null
    ? temporaryPaths.runtime("auto-rescue")
    : temporaryPaths.flow(identity.specId, identity.runId);
}
